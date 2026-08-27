/* =========================================================================
 * 渲染缓冲组装
 * 职责：把 animation-eval.js 求出的分量值写进 THREE BufferAttribute，并在 rebuildPoints
 *       中统筹索引重建、UV 计算、gizmo/面板/树刷新。
 * ======================================================================= */

import {PARTICLE_SIZE_FACTOR, state, functionIndexCache, effMaxFrame, autoFramesFor} from './constants.js';
import { getCompiledFn, getConstVarVals, resolveVarVals } from './generators.js';
import { points, selectedPoints, previewPoints, texAtlasMap } from './scene.js';
import { resolveUV, refreshUVPanel } from './texture-editor.js';
import { updateGizmo } from './gizmo.js';
import { drawTimeline, updatePropPanel } from './panels.js';
import { refreshTreeSelection, refreshCompTimelines } from './tree.js';
import { buildParticleIndex, buildTrackIndex, buildGroupIndex, buildOpDeltaCache, buildGroupXforms, buildFxSclTrackCache, currentVisual, velOffsetAt, rotVectorAt, trackValueAt, trackIntegral, trVersion, groupMemberIndexCache, groupXformCache, opTracksCache, fxSclTrackCache, fxOpDeltaCache } from './animation-eval.js';
import * as THREE from "three";
/* =========================================================================
 * 渲染
 * ======================================================================= */

// 复用几何体与缓冲：仅顶点数量变化时重建，否则只更新数组内容（避免每帧 new/dispose 造成 GC 卡顿）
// sizes 为每粒子 2 分量（sx, sy，非均匀 billboard 尺寸）
export function setPointsGeometry(pts, positions, colors, sizes) {
  let geo = pts.geometry;
  const posAttr = geo && geo.getAttribute('position');
  if (!geo || !posAttr || posAttr.array.length !== positions.length) {
    geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions.length), 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(colors.length), 4));
    geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(sizes.length), 2));
    const old = pts.geometry;
    pts.geometry = geo;
    if (old) old.dispose();
  }
  geo.getAttribute('position').array.set(positions);
  geo.getAttribute('aColor').array.set(colors);
  geo.getAttribute('aSize').array.set(sizes);
  geo.getAttribute('position').needsUpdate = true;
  geo.getAttribute('aColor').needsUpdate = true;
  geo.getAttribute('aSize').needsUpdate = true;
  geo.setDrawRange(0, positions.length / 3);
}

export let rpPos = null, rpCol = null, rpSize = null, rpSelPos = null, rpSelCol = null, rpSelSize = null;
export let rpUV = null, rpUVScale = null, rpUVAnim = null, rpUVTex = null, rpUVMode = null;
// 派生粒子求值的复用输出对象（主循环顺序执行、立即读走，单线程安全，避免每粒子分配）
export const FX_OUT = { pos: [0, 0, 0], color: [0, 0, 0, 0], vel: [0, 0, 0], scale: 1, glow: false, light: 0 };
// 粒子 UV 求值的复用输出（fill 模式下强制全图采样）
export const UVOUT = { mode: 0, au0: 0, av0: 0, au1: 0, av1: 0, sx: 0, sy: 0, sw: 16, sh: 16, stepx: 16, stepy: 0, fps: 1, maxFrame: 1, tw: 16, th: 16 };

// 计算单个粒子的 uv 渲染参数（写入复用 out），无贴图时 mode=0。
// 返回生效的 uv 对象（无贴图时返回 null），供调用方直接复用，避免重复 resolveUV。
export function computeParticleUV(p, out) {
  out.mode = 0;
  const uv = resolveUV(p).uv;
  if (!uv || !uv.texture) return null;
  const tex = texAtlasMap[uv.texture];
  if (!tex) return null;
  out.au0 = tex.u0; out.av0 = tex.v0; out.au1 = tex.u1; out.av1 = tex.v1;
  out.tw = tex.w; out.th = tex.h;
  if (uv.mode === 'fill') {
    out.sx = 0; out.sy = 0; out.sw = tex.w; out.sh = tex.h;
    out.mode = 2;
  } else if (uv.mode === 'animated') {
    const off = animatedUVOffsetAt(uv, tex.w, tex.h);
    out.sx = off[0]; out.sy = off[1];
    // uvSize 为 0 时使用贴图大小（铺满整张贴图）
    out.sw = uv.uvSize[0] || tex.w; out.sh = uv.uvSize[1] || tex.h;
    out.stepx = 0; out.stepy = 0;   // 帧已计入偏移，shader 不再动画
    out.fps = uv.fps;
    out.maxFrame = effMaxFrame(uv, autoFramesFor(uv, tex.w, tex.h));
    out.mode = 1;                    // 按静态矩形采样（偏移已含帧）
  } else {
    out.sx = uv.uvStart[0]; out.sy = uv.uvStart[1];
    // uvSize 为 0 时使用贴图大小（铺满整张贴图）
    out.sw = uv.uvSize[0] || tex.w; out.sh = uv.uvSize[1] || tex.h;
    out.mode = 1;
  }
  return uv;
}

/**
 * 动画贴图 UV 帧的时间驱动源（秒）。
 * 播放或拖动时间轴时，帧应由当前时间轴刻度决定（所有粒子同步到时间轴，供预览整体动画流程）；
 * 暂停空闲时，则退回墙钟循环播放，供单独预览贴图动画。
 * state.time 为「刻度」单位（20 刻度 = 1 秒），故除以 20 换算成秒。
 */
export function uvDriveSeconds() {
  if (state.playing || state.scrubbing) return state.time / 20;
  return performance.now() / 1000;
}

/**
 * 动画贴图当前帧的行主 flipbook 偏移 [sx, sy]（帧号按 uvDriveSeconds 的 float64 确定性计算，
 * 与贴图预览 currentUVFrame、游戏端 currentUvStart 完全同源）。
 */
export function animatedUVOffsetAt(uv, texW, texH) {
  const maxF = effMaxFrame(uv, autoFramesFor(uv, texW, texH));
  const raw = Math.floor(uvDriveSeconds() * (uv.fps || 1));
  const frame = uv.loop ? ((raw % maxF) + maxF) % maxF : Math.min(raw, maxF - 1);
  const stepx = uv.uvStep[0] || 0, stepy = uv.uvStep[1] || 0;
  const cols = (stepx > 0 && uv.uvStart[0] < texW) ? Math.floor((texW - 1 - uv.uvStart[0]) / stepx) + 1 : 1;
  return [uv.uvStart[0] + stepx * (frame % cols), uv.uvStart[1] + stepy * Math.floor(frame / cols)];
}

/** 是否存在动画贴图粒子（决定是否需要每帧轻量推进 UV 帧）。 */
export let hasAnimatedTex = false;

/** 每帧只推进动画贴图粒子的 sx/sy（轻量，不重建位置/颜色/整段缓冲区）。 */
export function updateAnimatedUV() {
  if (!hasAnimatedTex) return;
  if (typeof resolveUV !== 'function') return;
  const attr = points.geometry.getAttribute('aUVScale');
  if (!attr) return;
  const arr = attr.array;
  let changed = false;
  for (let i = 0; i < state.particles.length; i++) {
    const p = state.particles[i];
    const uv = resolveUV(p).uv;
    if (!uv || uv.mode !== 'animated' || !uv.texture) continue;
    const tex = texAtlasMap[uv.texture];
    if (!tex) continue;
    const off = animatedUVOffsetAt(uv, tex.w, tex.h);
    arr[i * 4] = off[0];
    arr[i * 4 + 1] = off[1];
    changed = true;
  }
  if (changed) attr.needsUpdate = true;
}

// 设置 UV 相关 attribute（在 geometry 重建后调用）
export function setPointUVAttributes(geo, uvs) {
  const defs = [
    ['aUV', uvs.uv, 4],
    ['aUVScale', uvs.uvScale, 4],
    ['aUVAnim', uvs.uvAnim, 4],
    ['aUVTex', uvs.uvTex, 2],
    ['aUVMode', uvs.uvMode, 1],
  ];
  for (const [name, arr, itemSize] of defs) {
    let attr = geo.getAttribute(name);
    if (!attr || attr.array.length !== arr.length) {
      attr = new THREE.BufferAttribute(new Float32Array(arr.length), itemSize);
      geo.setAttribute(name, attr);
    }
    attr.array.set(arr);
    attr.needsUpdate = true;
  }
}

export function rebuildPoints(full) {
  buildParticleIndex();
  buildTrackIndex();
  buildGroupIndex();
  buildOpDeltaCache(state.time);
  buildGroupXforms(state.time);
  buildFxSclTrackCache();
  // 预编译所有函数对象（code 变化时惰性重编译），主循环直接取 fx._compiledFn/_constVarVals
  for (let fi = 0; fi < state.functions.length; fi++) { getCompiledFn(state.functions[fi]); getConstVarVals(state.functions[fi]); }
  const n = state.particles.length;
  if (!rpPos || rpPos.length !== n * 3) rpPos = new Float32Array(n * 3);
  if (!rpCol || rpCol.length !== n * 4) rpCol = new Float32Array(n * 4);
  if (!rpSize || rpSize.length !== n * 2) rpSize = new Float32Array(n * 2);
  if (!rpUV || rpUV.length !== n * 4) rpUV = new Float32Array(n * 4);
  if (!rpUVScale || rpUVScale.length !== n * 4) rpUVScale = new Float32Array(n * 4);
  if (!rpUVAnim || rpUVAnim.length !== n * 4) rpUVAnim = new Float32Array(n * 4);
  if (!rpUVTex || rpUVTex.length !== n * 2) rpUVTex = new Float32Array(n * 2);
  if (!rpUVMode || rpUVMode.length !== n) rpUVMode = new Float32Array(n);
  const positions = rpPos, colors = rpCol, sizes = rpSize;
  const T = state.time;
  const memberIdx = groupMemberIndexCache;
  const hasGroups = memberIdx.size > 0;
  const xforms = groupXformCache;
  const SZF = PARTICLE_SIZE_FACTOR;
  hasAnimatedTex = false; // 主循环顺带统计动画贴图粒子，避免额外整表扫描
  // 函数对象"干净"标志：无组、无 op 轨道、无函数 scl 轨道、无函数 rot 轨道 → 派生粒子走最简快速路径
  const hasFxRotTracks = state.tracks.some(tr => tr.pr.startsWith('rot.') && tr.ids.some(id => id.startsWith('f:')));
  const fxClean = !hasGroups && opTracksCache.length === 0 && (fxSclTrackCache ? fxSclTrackCache.size === 0 : true) && !hasFxRotTracks;
  for (let i = 0; i < n; i++) {
    const p = state.particles[i];
    let px, py, pz, cr, cg, cb, ca, ssx, ssy;
    if (p.fx) {
      const fx = functionIndexCache.get(p.fx);
      const fn = fx._compiledFn;
      if (fn && fxClean) {
        // 最简快速路径：直接调用原生编译函数写进复用输出对象
        const vals = fx._constVarVals || resolveVarVals(fx, p._fxIdx, fx.count, T);
        const r = fn(p._fxIdx, fx.count, T, fx.center[0], fx.center[1], fx.center[2], ...vals, FX_OUT);
        const vel = p.vel;
        px = r.pos[0] + vel[0] * T; py = r.pos[1] + vel[1] * T; pz = r.pos[2] + vel[2] * T;
        cr = r.color[0]; cg = r.color[1]; cb = r.color[2]; ca = r.color[3];
        ssx = r.scale; ssy = r.scale;
      } else {
        const gs = hasGroups ? memberIdx.get(p.id) : undefined;
        const hasFxOp = fxOpDeltaCache && fxOpDeltaCache.has(p.fx);
        const hasFxRot = rotVectorAt('f:' + p.fx, T).some(v => v !== 0);
        const sclTrs = (fxSclTrackCache && fxSclTrackCache.get(p.fx)) || null;
        if (fn && !gs && !hasFxOp && !hasFxRot) {
          const vals = fx._constVarVals || resolveVarVals(fx, p._fxIdx, fx.count, T);
          const r = fn(p._fxIdx, fx.count, T, fx.center[0], fx.center[1], fx.center[2], ...vals, FX_OUT);
          const vel = p.vel;
          px = r.pos[0] + vel[0] * T; py = r.pos[1] + vel[1] * T; pz = r.pos[2] + vel[2] * T;
          cr = r.color[0]; cg = r.color[1]; cb = r.color[2]; ca = r.color[3];
          ssx = (sclTrs && sclTrs[0]) ? trackValueAt(sclTrs[0], T, r.scale) : r.scale;
          ssy = (sclTrs && sclTrs[1]) ? trackValueAt(sclTrs[1], T, r.scale) : r.scale;
        } else {
          const v = currentVisual(p);
          const off = velOffsetAt(p, T);
          px = v.pos[0] + off[0]; py = v.pos[1] + off[1]; pz = v.pos[2] + off[2];
          cr = v.color[0]; cg = v.color[1]; cb = v.color[2]; ca = v.color[3];
          ssx = v.scale[0]; ssy = v.scale[1];
        }
      }
    } else {
      const inGroup = hasGroups && memberIdx.has(p.id);
      const tr = (p._trVersion === trVersion) ? p._tr : null;
      if (tr && !inGroup) {
        // 自身 set 轨道快路径（无组无 fx）
        px = tr[0] ? trackValueAt(tr[0], T, p.pos[0]) : p.pos[0];
        py = tr[1] ? trackValueAt(tr[1], T, p.pos[1]) : p.pos[1];
        pz = tr[2] ? trackValueAt(tr[2], T, p.pos[2]) : p.pos[2];
        cr = tr[3] ? trackValueAt(tr[3], T, p.color[0]) : p.color[0];
        cg = tr[4] ? trackValueAt(tr[4], T, p.color[1]) : p.color[1];
        cb = tr[5] ? trackValueAt(tr[5], T, p.color[2]) : p.color[2];
        ca = tr[6] ? trackValueAt(tr[6], T, p.color[3]) : p.color[3];
        ssx = tr[7] ? trackValueAt(tr[7], T, p.scale[0]) : p.scale[0];
        ssy = tr[8] ? trackValueAt(tr[8], T, p.scale[1]) : p.scale[1];
        px += tr[10] ? trackIntegral(tr[10], T) : p.vel[0] * T;
        py += tr[11] ? trackIntegral(tr[11], T) : p.vel[1] * T;
        pz += tr[12] ? trackIntegral(tr[12], T) : p.vel[2] * T;
      } else if (!tr && inGroup) {
        const gs = memberIdx.get(p.id);
        let xf = null;
        if (gs.size === 1) xf = xforms.get(gs.values().next().value);
        if (xf) {
          // 单组快路径：set 覆盖 → 组旋转 → op 增量 → vel 积分
          if (xf.hasSet) {
            px = xf.setTr[0] ? trackValueAt(xf.setTr[0], T, p.pos[0]) : p.pos[0];
            py = xf.setTr[1] ? trackValueAt(xf.setTr[1], T, p.pos[1]) : p.pos[1];
            pz = xf.setTr[2] ? trackValueAt(xf.setTr[2], T, p.pos[2]) : p.pos[2];
            cr = xf.setTr[3] ? trackValueAt(xf.setTr[3], T, p.color[0]) : p.color[0];
            cg = xf.setTr[4] ? trackValueAt(xf.setTr[4], T, p.color[1]) : p.color[1];
            cb = xf.setTr[5] ? trackValueAt(xf.setTr[5], T, p.color[2]) : p.color[2];
            ca = xf.setTr[6] ? trackValueAt(xf.setTr[6], T, p.color[3]) : p.color[3];
            ssx = xf.setTr[7] ? trackValueAt(xf.setTr[7], T, p.scale[0]) : p.scale[0];
            ssy = xf.setTr[8] ? trackValueAt(xf.setTr[8], T, p.scale[1]) : p.scale[1];
          } else {
            px = p.pos[0]; py = p.pos[1]; pz = p.pos[2];
            cr = p.color[0]; cg = p.color[1]; cb = p.color[2]; ca = p.color[3];
            ssx = p.scale[0]; ssy = p.scale[1];
          }
          if (xf.rotMat) {
            const m = xf.rotMat;
            const pivot = xf.pivot || [0, 0, 0];
            const rx = px - pivot[0], ry = py - pivot[1], rz = pz - pivot[2];
            px = pivot[0] + m[0] * rx + m[1] * ry + m[2] * rz;
            py = pivot[1] + m[3] * rx + m[4] * ry + m[5] * rz;
            pz = pivot[2] + m[6] * rx + m[7] * ry + m[8] * rz;
          }
          if (xf.hasOp) {
            px += xf.op[0]; py += xf.op[1]; pz += xf.op[2];
            cr += xf.op[3]; cg += xf.op[4]; cb += xf.op[5]; ca += xf.op[6];
            ssx += xf.op[7]; ssy += xf.op[8];
          }
          if (xf.hasVel) {
            px += xf.velTr[0] ? trackIntegral(xf.velTr[0], T) : p.vel[0] * T;
            py += xf.velTr[1] ? trackIntegral(xf.velTr[1], T) : p.vel[1] * T;
            pz += xf.velTr[2] ? trackIntegral(xf.velTr[2], T) : p.vel[2] * T;
          } else {
            px += p.vel[0] * T; py += p.vel[1] * T; pz += p.vel[2] * T;
          }
        } else {
          const v = currentVisual(p);
          const off = velOffsetAt(p, T);
          px = v.pos[0] + off[0]; py = v.pos[1] + off[1]; pz = v.pos[2] + off[2];
          cr = v.color[0]; cg = v.color[1]; cb = v.color[2]; ca = v.color[3];
          ssx = v.scale[0]; ssy = v.scale[1];
        }
      } else if (!tr && !inGroup) {
        const vel = p.vel;
        px = p.pos[0] + vel[0] * T; py = p.pos[1] + vel[1] * T; pz = p.pos[2] + vel[2] * T;
        cr = p.color[0]; cg = p.color[1]; cb = p.color[2]; ca = p.color[3];
        ssx = p.scale[0]; ssy = p.scale[1];
      } else {
        // 自身轨道 + 组：走完整求值
        const v = currentVisual(p);
        const off = velOffsetAt(p, T);
        px = v.pos[0] + off[0]; py = v.pos[1] + off[1]; pz = v.pos[2] + off[2];
        cr = v.color[0]; cg = v.color[1]; cb = v.color[2]; ca = v.color[3];
        ssx = v.scale[0]; ssy = v.scale[1];
      }
    }
    // 入场/寿命门控：t < st 隐藏；有限 life 到期后隐藏。fade 预设在出场窗口内做 alpha 渐显
    const gate = p.fx ? (functionIndexCache.get(p.fx) || {}) : p;
    const gst = gate.st || 0;
    let vis = T >= gst ? 1 : 0;
    const glife = typeof gate.life === 'number' ? gate.life : -1;
    if (vis > 0 && glife >= 0 && T - gst >= glife) vis = 0;
    if (vis > 0 && gate.ent && gate.ent.p === 'fade') {
      const fd = gate.ent.d || 5;
      if (T - gst < fd) vis *= Math.max(0, (T - gst) / fd);
    }
    ca *= vis;
    positions[i * 3] = px; positions[i * 3 + 1] = py; positions[i * 3 + 2] = pz;
    colors[i * 4] = cr; colors[i * 4 + 1] = cg; colors[i * 4 + 2] = cb; colors[i * 4 + 3] = ca;
    const uvForSize = computeParticleUV(p, UVOUT);
    if (uvForSize && uvForSize.mode === 'animated') hasAnimatedTex = true;
    // 贴图大小缩放：使用用户设置的 texSize（控制粒子显示大小），基准 16px
    const texW = uvForSize ? (uvForSize.texSize[0] || 16) : 16;
    const texH = uvForSize ? (uvForSize.texSize[1] || 16) : 16;
    const texScaleX = Math.max(1, texW) / 16;
    const texScaleY = Math.max(1, texH) / 16;
    let sx = ssx * SZF * texScaleX, sy = ssy * SZF * texScaleY;
    if (vis === 0) {
      sizes[i * 2] = 0; sizes[i * 2 + 1] = 0;   // 尺寸归零 → 无片段光栅化，预览层完全隐藏
    } else {
      sizes[i * 2] = sx > 0.02 ? sx : 0.02;
      sizes[i * 2 + 1] = sy > 0.02 ? sy : 0.02;
    }
    const i4 = i * 4, i2 = i * 2;
    rpUV[i4] = UVOUT.au0; rpUV[i4 + 1] = UVOUT.av0; rpUV[i4 + 2] = UVOUT.au1; rpUV[i4 + 3] = UVOUT.av1;
    rpUVScale[i4] = UVOUT.sx; rpUVScale[i4 + 1] = UVOUT.sy; rpUVScale[i4 + 2] = UVOUT.sw; rpUVScale[i4 + 3] = UVOUT.sh;
    rpUVAnim[i4] = UVOUT.stepx; rpUVAnim[i4 + 1] = UVOUT.stepy; rpUVAnim[i4 + 2] = UVOUT.fps; rpUVAnim[i4 + 3] = UVOUT.maxFrame;
    rpUVTex[i2] = UVOUT.tw; rpUVTex[i2 + 1] = UVOUT.th;
    rpUVMode[i] = UVOUT.mode;
  }
  setPointsGeometry(points, positions, colors, sizes);
  setPointUVAttributes(points.geometry, { uv: rpUV, uvScale: rpUVScale, uvAnim: rpUVAnim, uvTex: rpUVTex, uvMode: rpUVMode });

  const sel = state.particles.filter(p => state.selected.has(p.id));
  if (!rpSelPos || rpSelPos.length !== sel.length * 3) rpSelPos = new Float32Array(sel.length * 3);
  if (!rpSelCol || rpSelCol.length !== sel.length * 4) rpSelCol = new Float32Array(sel.length * 4);
  if (!rpSelSize || rpSelSize.length !== sel.length * 2) rpSelSize = new Float32Array(sel.length * 2);
  const spos = rpSelPos, ssiz = rpSelSize;
  for (let i = 0; i < sel.length; i++) {
    const v = currentVisual(sel[i]);
    const off = velOffsetAt(sel[i], state.time);
    spos[i * 3] = v.pos[0] + off[0]; spos[i * 3 + 1] = v.pos[1] + off[1]; spos[i * 3 + 2] = v.pos[2] + off[2];
    // 与主循环一致：使用用户设置的 texSize 计算粒子尺寸
    const uvForSize = computeParticleUV(sel[i], UVOUT);
    const texW = uvForSize ? (uvForSize.texSize[0] || 16) : 16;
    const texH = uvForSize ? (uvForSize.texSize[1] || 16) : 16;
    const texScaleX = Math.max(1, texW) / 16;
    const texScaleY = Math.max(1, texH) / 16;
    const sx = v.scale[0] * PARTICLE_SIZE_FACTOR * texScaleX, sy = v.scale[1] * PARTICLE_SIZE_FACTOR * texScaleY;
    ssiz[i * 2] = Math.max(0.02, sx);
    ssiz[i * 2 + 1] = Math.max(0.02, sy);
  }
  setPointsGeometry(selectedPoints, spos, rpSelCol, ssiz);

  updateGizmo();
  drawTimeline();
  if (full !== false) {
    updatePropPanel();
    refreshTreeSelection();
    if (typeof refreshCompTimelines === 'function') refreshCompTimelines();
    if (typeof refreshUVPanel === 'function' && document.getElementById('pane-texture') && document.getElementById('pane-texture').classList.contains('active')) refreshUVPanel();
  }
}

export function setPreview(positions) {
  const n = positions.length;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 4), siz = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = positions[i][0]; pos[i * 3 + 1] = positions[i][1]; pos[i * 3 + 2] = positions[i][2];
    col[i * 4] = 1; col[i * 4 + 1] = 1; col[i * 4 + 2] = 1; col[i * 4 + 3] = 0.6;
    siz[i * 2] = 1 * PARTICLE_SIZE_FACTOR; siz[i * 2 + 1] = 1 * PARTICLE_SIZE_FACTOR;
  }
  setPointsGeometry(previewPoints, pos, col, siz);
  // 预览点复用 pointsMaterial（shader 声明了 UV attributes）：补齐全 0 的 UV 数据，
  // 避免 attribute 缺失时被 shader 读到垃圾值而随机采样贴图（表现为透明/花屏）
  setPointUVAttributes(previewPoints.geometry, {
    uv: new Float32Array(n * 4), uvScale: new Float32Array(n * 4), uvAnim: new Float32Array(n * 4),
    uvTex: new Float32Array(n * 2), uvMode: new Float32Array(n),
  });
}

export function clearPreview() { setPointsGeometry(previewPoints, new Float32Array(0), new Float32Array(0), new Float32Array(0)); }
