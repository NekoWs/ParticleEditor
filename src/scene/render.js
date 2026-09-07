// 渲染缓冲组装：把 animation-eval.js 求出的分量值写进 THREE BufferAttribute，
// 并在 rebuildPoints 里统筹索引重建、UV 计算、gizmo/面板/树刷新。

import {PARTICLE_SIZE_FACTOR, state, functionIndexCache} from '../core/constants.js';
import { points, selectedPoints, previewPoints, pointsPick, makeParticleQuadGeometry, texAtlasMap, camera, cameraWidgetMap, buildCameraWidget, removeCameraWidget } from './scene.js';
import { cameraPoseAt } from '../core/cameras.js';
import { resolveUV, refreshUVPanel } from '../ui/texture-editor.js';
import { updateGizmo } from '../interaction/gizmo.js';
import { drawTimeline, updatePropPanel } from '../ui/panels.js';
import { evalUVInto, hasUvExpressions, evaledAutoFrames, evaledEffMaxFrame } from '../core/uv-eval.js';

import { buildParticleIndex, buildTrackIndex, buildGroupIndex, buildOpDeltaCache, buildGroupXforms, buildFxSclTrackCache, currentVisual, velOffsetAt, trackValueAt, trackIntegral, trVersion, groupMemberIndexCache, groupXformCache, fxOpDeltaCache, fxSclTrackCache, invalidateMaxTickCache, maxTick, fxParticleVisible, particleValueAt, spinVectorAt, rotVectorAt } from '../core/animation-eval.js';
import { evaluateFxFrame } from '../core/generators.js';
import * as THREE from "three";
// —— 渲染 ——

// 把拾取用点集的 position attribute 指向渲染实例的同一份 Float32Array，
// 让 Raycaster 的 Points 阈值拾取与 instanced quad 渲染完全同源（零拷贝）。
function syncPickGeometry(n, positionsArray) {
  const geo = pointsPick.geometry;
  const attr = geo.getAttribute('position');
  if (!attr || attr.array !== positionsArray) {
    geo.setAttribute('position', new THREE.BufferAttribute(positionsArray, 3));
  }
  geo.setDrawRange(0, n);
  geo.boundingSphere = null; // 位置已更新，下次拾取时重新计算包围球
}

// 复用几何体与实例缓冲：仅粒子数量变化时重建，否则只更新数组内容（避免每帧 new/dispose 造成 GC 卡顿）。
// sizes 为每粒子 2 分量（sx, sy，billboard 四边形的世界尺寸）。
export function setPointsGeometry(pts, positions, colors, sizes) {
  const n = positions.length / 3;
  const geo = pts.geometry;
  const posAttr = geo && geo.getAttribute('aPosition');
  if (!geo || !posAttr || posAttr.array.length !== positions.length) {
    const newGeo = makeParticleQuadGeometry();
    newGeo.setAttribute('aPosition', new THREE.InstancedBufferAttribute(positions, 3));
    newGeo.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 4));
    newGeo.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizes, 2));
    const old = pts.geometry;
    pts.geometry = newGeo;
    if (old) old.dispose();
  } else {
    posAttr.array.set(positions);
    geo.getAttribute('aColor').array.set(colors);
    geo.getAttribute('aSize').array.set(sizes);
  }
  pts.count = n;
  pts.geometry.getAttribute('aPosition').needsUpdate = true;
  pts.geometry.getAttribute('aColor').needsUpdate = true;
  pts.geometry.getAttribute('aSize').needsUpdate = true;
}

// 主粒子缓冲的直写路径：返回几何体 instance attribute 的底层 Float32Array，调用方直接写入，
// 避免「先写中间数组再 array.set 复制一遍」的双份拷贝（20w 粒子每帧省约 1.8M 次 float 写）。
export function ensurePointsGeometry(pts, n) {
  const geo = pts.geometry;
  const posAttr = geo && geo.getAttribute('aPosition');
  if (!geo || !posAttr || posAttr.array.length !== n * 3) {
    const newGeo = makeParticleQuadGeometry();
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 4);
    const sizes = new Float32Array(n * 2);
    newGeo.setAttribute('aPosition', new THREE.InstancedBufferAttribute(positions, 3));
    newGeo.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 4));
    newGeo.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizes, 2));
    const old = pts.geometry;
    pts.geometry = newGeo;
    if (old) old.dispose();
    if (pts === points) syncPickGeometry(n, positions);
    pts.count = n;
    return { positions, colors, sizes };
  }
  pts.count = n;
  const pos = geo.getAttribute('aPosition');
  const col = geo.getAttribute('aColor');
  const size = geo.getAttribute('aSize');
  pos.needsUpdate = true;
  col.needsUpdate = true;
  size.needsUpdate = true;
  return { positions: pos.array, colors: col.array, sizes: size.array };
}

export let rpPos = null, rpCol = null, rpSize = null, rpSelPos = null, rpSelCol = null, rpSelSize = null;
export let rpUV = null, rpUVScale = null, rpUVAnim = null, rpUVTex = null, rpUVMode = null;
// 动画贴图粒子缓存的「已求值 UV 字段」，给 updateAnimatedUV 在空闲墙钟推进时复用（避免逐帧重算表达式）。
export let rpAnimStart = null, rpAnimStep = null, rpAnimFps = null, rpAnimMax = null;
// 粒子 UV 求值的复用输出（fill 模式下强制全图采样）
export const UVOUT = { mode: 0, au0: 0, av0: 0, au1: 0, av1: 0, sx: 0, sy: 0, sw: 16, sh: 16, stepx: 16, stepy: 0, fps: 1, maxFrame: 1, tw: 16, th: 16 };
// 逐粒子 UV 字段求值的复用输出（表达式结果或数值回退）。
export const UV_EVAL = { uvStart: [0, 0], uvSize: [0, 0], uvStep: [0, 0], fps: 1, maxFrame: 1 };

// 用「已求值字段」计算单个粒子的 uv 渲染参数（写入复用 out），无贴图时 mode=0。
// uv 为 resolveUV 结果，tex 为 texAtlasMap 条目，evaled 为 evalUVInto 的输出。
export function computeParticleUVFrom(uv, tex, evaled, out) {
  out.au0 = tex.u0; out.av0 = tex.v0; out.au1 = tex.u1; out.av1 = tex.v1;
  out.tw = tex.w; out.th = tex.h;
  if (uv.mode === 'fill') {
    out.sx = 0; out.sy = 0; out.sw = tex.w; out.sh = tex.h;
    out.mode = 2;
  } else if (uv.mode === 'animated') {
    const maxF = evaledEffMaxFrame(evaled, evaledAutoFrames(evaled, tex.w, tex.h));
    const off = animatedUVOffsetAt(evaled.uvStart, evaled.uvStep, evaled.fps, maxF, uv.loop, tex.w, tex.h);
    out.sx = off[0]; out.sy = off[1];
    // uvSize 为 0 时使用贴图大小（铺满整张贴图）
    out.sw = evaled.uvSize[0] || tex.w; out.sh = evaled.uvSize[1] || tex.h;
    out.stepx = 0; out.stepy = 0;   // 帧已计入偏移，shader 不再动画
    out.fps = evaled.fps;
    out.maxFrame = maxF;
    out.mode = 1;                    // 按静态矩形采样（偏移已含帧）
  } else {
    out.sx = evaled.uvStart[0]; out.sy = evaled.uvStart[1];
    // uvSize 为 0 时使用贴图大小（铺满整张贴图）
    out.sw = evaled.uvSize[0] || tex.w; out.sh = evaled.uvSize[1] || tex.h;
    out.mode = 1;
  }
  return uv;
}

// 动画贴图 UV 帧的时间驱动源（秒）。播放或拖动时间轴时，帧由当前时间轴刻度决定（所有粒子同步到
// 时间轴，方便预览整体动画流程）；暂停空闲时退回墙钟循环播放，方便单独预览贴图动画。
// state.time 是「刻度」单位（20 刻度 = 1 秒），所以除以 20 换算成秒。
export function uvDriveSeconds() {
  if (state.playing || state.scrubbing) return state.time / 20;
  return performance.now() / 1000;
}

/**
 * 动画贴图当前帧的行主 flipbook 偏移 [sx, sy]（帧号按 uvDriveSeconds 的 float64 确定性计算，
 * 与贴图预览 currentUVFrame、游戏端 currentUvStart 完全同源）。
 * start/step/fps/maxFrame 使用已求值字段（表达式或数值回退）。
 */
export function animatedUVOffsetAt(start, step, fps, maxFrame, loop, texW, texH) {
  const raw = Math.floor(uvDriveSeconds() * (fps || 1));
  const frame = loop ? ((raw % maxFrame) + maxFrame) % maxFrame : Math.min(raw, maxFrame - 1);
  const stepx = step[0] || 0, stepy = step[1] || 0;
  const cols = (stepx > 0 && start[0] < texW) ? Math.floor((texW - 1 - start[0]) / stepx) + 1 : 1;
  return [start[0] + stepx * (frame % cols), start[1] + stepy * Math.floor(frame / cols)];
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
  const n = state.particles.length;
  if (!rpAnimStart || rpAnimStart.length !== n * 2) return;
  let changed = false;
  for (let i = 0; i < n; i++) {
    const p = state.particles[i];
    const uv = resolveUV(p).uv;
    if (!uv || uv.mode !== 'animated' || !uv.texture) continue;
    const tex = texAtlasMap[uv.texture];
    if (!tex) continue;
    const off = animatedUVOffsetAt(
      [rpAnimStart[i * 2], rpAnimStart[i * 2 + 1]],
      [rpAnimStep[i * 2], rpAnimStep[i * 2 + 1]],
      rpAnimFps[i],
      rpAnimMax[i],
      uv.loop,
      tex.w,
      tex.h,
    );
    arr[i * 4] = off[0];
    arr[i * 4 + 1] = off[1];
    changed = true;
  }
  if (changed) attr.needsUpdate = true;
}

// 设置 UV 相关 instance attribute（在几何体重建后调用）
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
      attr = new THREE.InstancedBufferAttribute(new Float32Array(arr.length), itemSize);
      geo.setAttribute(name, attr);
    }
    attr.array.set(arr);
    attr.needsUpdate = true;
  }
}

function rebuildIndexes() {
  invalidateMaxTickCache();
  buildParticleIndex();
  buildTrackIndex();
  buildGroupIndex();
  buildFxSclTrackCache();
}

// 完整求值回退：位置（含速度位移）+ 颜色 + 缩放，写进返回值数组。
function readVisualFallback(p, T) {
  const v = currentVisual(p);
  const off = velOffsetAt(p, T);
  return [v.pos[0] + off[0], v.pos[1] + off[1], v.pos[2] + off[2],
          v.color[0], v.color[1], v.color[2], v.color[3],
          v.scale[0], v.scale[1]];
}

// 派生粒子读取存储值（脚本已在 tick/process 中直接写入 p.pos/p.color/p.scale），
// 并叠加函数对象整体变换；不再逐粒子执行脚本，也不叠加速度积分（运动由脚本显式控制）。
function readDerivedVisual(p, T) {
  const v = currentVisual(p);
  return [v.pos[0], v.pos[1], v.pos[2],
          v.color[0], v.color[1], v.color[2], v.color[3],
          v.scale[0], v.scale[1]];
}

function writePointBuffers(full, deltaMs) {
  buildOpDeltaCache(state.time);
  buildGroupXforms(state.time);
  const n = state.particles.length;
  if (!rpUV || rpUV.length !== n * 4) rpUV = new Float32Array(n * 4);
  if (!rpUVScale || rpUVScale.length !== n * 4) rpUVScale = new Float32Array(n * 4);
  if (!rpUVAnim || rpUVAnim.length !== n * 4) rpUVAnim = new Float32Array(n * 4);
  if (!rpUVTex || rpUVTex.length !== n * 2) rpUVTex = new Float32Array(n * 2);
  if (!rpUVMode || rpUVMode.length !== n) rpUVMode = new Float32Array(n);
  if (!rpAnimStart || rpAnimStart.length !== n * 2) rpAnimStart = new Float32Array(n * 2);
  if (!rpAnimStep || rpAnimStep.length !== n * 2) rpAnimStep = new Float32Array(n * 2);
  if (!rpAnimFps || rpAnimFps.length !== n) rpAnimFps = new Float32Array(n);
  if (!rpAnimMax || rpAnimMax.length !== n) rpAnimMax = new Float32Array(n);
  const mainGeo = ensurePointsGeometry(points, n);
  const positions = mainGeo.positions, colors = mainGeo.colors, sizes = mainGeo.sizes;
  rpPos = positions; rpCol = colors; rpSize = sizes;
  const T = state.time;
  const hasAnyTexture = Object.keys(texAtlasMap).length > 0;
  const memberIdx = groupMemberIndexCache;
  const hasGroups = memberIdx.size > 0;
  const xforms = groupXformCache;
  const SZF = PARTICLE_SIZE_FACTOR;
  hasAnimatedTex = false; // 主循环顺带统计动画贴图粒子，避免额外整表扫描
  // 先推进每个函数对象的 tick/process（脚本直接写粒子存储值）。
  for (const fx of state.functions) {
    evaluateFxFrame(fx, T, deltaMs || 0);
  }
  // UV 表达式求值复用的 this 上下文（仅对含表达式的粒子填写，避免每粒子分配）。
  const uvCtxOut = { pos: [0, 0, 0], color: [1, 1, 1, 1], vel: [0, 0, 0], scale: 1, glow: false, light: 0, life: -1 };
  const uvCtx = { i: 0, n, t: T, dt: 0, duration: maxTick(), life: -1, uv_x: 0, uv_y: 0, vars: {}, out: uvCtxOut };
  for (let i = 0; i < n; i++) {
    const p = state.particles[i];
    let px, py, pz, cr, cg, cb, ca, ssx, ssy;
    let gate = p;
    let plife = -1;
    if (p.fx) {
      gate = (functionIndexCache.get(p.fx) || p);
      [px, py, pz, cr, cg, cb, ca, ssx, ssy] = readDerivedVisual(p, T);
      plife = typeof p.life === 'number' ? p.life : -1;
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
          // 单组快路径：set 覆盖 → 组整体缩放 → 组旋转 → op 增量 → vel 积分
          if (xf.hasSet) {
            px = xf.setTr[0] ? trackValueAt(xf.setTr[0], T, p.pos[0]) : p.pos[0];
            py = xf.setTr[1] ? trackValueAt(xf.setTr[1], T, p.pos[1]) : p.pos[1];
            pz = xf.setTr[2] ? trackValueAt(xf.setTr[2], T, p.pos[2]) : p.pos[2];
            cr = xf.setTr[3] ? trackValueAt(xf.setTr[3], T, p.color[0]) : p.color[0];
            cg = xf.setTr[4] ? trackValueAt(xf.setTr[4], T, p.color[1]) : p.color[1];
            cb = xf.setTr[5] ? trackValueAt(xf.setTr[5], T, p.color[2]) : p.color[2];
            ca = xf.setTr[6] ? trackValueAt(xf.setTr[6], T, p.color[3]) : p.color[3];
            ssx = p.scale[0]; ssy = p.scale[1];
          } else {
            px = p.pos[0]; py = p.pos[1]; pz = p.pos[2];
            cr = p.color[0]; cg = p.color[1]; cb = p.color[2]; ca = p.color[3];
            ssx = p.scale[0]; ssy = p.scale[1];
          }
          if (xf.hasScale) {
            const pivot = xf.pivot || [0, 0, 0];
            const sc = xf.scale;
            px = pivot[0] + (px - pivot[0]) * sc[0];
            py = pivot[1] + (py - pivot[1]) * sc[1];
            pz = pivot[2] + (pz - pivot[2]) * sc[2];
          }
          if (xf.hasSpin) {
            const m = xf.spinMat;
            const pivot = xf.pivot || [0, 0, 0];
            const rx = px - pivot[0], ry = py - pivot[1], rz = pz - pivot[2];
            px = pivot[0] + m[0] * rx + m[1] * ry + m[2] * rz;
            py = pivot[1] + m[3] * rx + m[4] * ry + m[5] * rz;
            pz = pivot[2] + m[6] * rx + m[7] * ry + m[8] * rz;
          }
          if (xf.hasRot) {
            const m = xf.orbitMat;
            const pivot = xf.orbitCenter || [0, 0, 0];
            const rx = px - pivot[0], ry = py - pivot[1], rz = pz - pivot[2];
            px = pivot[0] + m[0] * rx + m[1] * ry + m[2] * rz;
            py = pivot[1] + m[3] * rx + m[4] * ry + m[5] * rz;
            pz = pivot[2] + m[6] * rx + m[7] * ry + m[8] * rz;
          }
          if (xf.hasOp) {
            px += xf.op[0]; py += xf.op[1]; pz += xf.op[2];
            cr += xf.op[3]; cg += xf.op[4]; cb += xf.op[5]; ca += xf.op[6];
            // scl op 已并入 xf.scale（位置级缩放），不再叠加粒子大小
          }
          if (xf.hasVel) {
            px += xf.velTr[0] ? trackIntegral(xf.velTr[0], T) : p.vel[0] * T;
            py += xf.velTr[1] ? trackIntegral(xf.velTr[1], T) : p.vel[1] * T;
            pz += xf.velTr[2] ? trackIntegral(xf.velTr[2], T) : p.vel[2] * T;
          } else {
            px += p.vel[0] * T; py += p.vel[1] * T; pz += p.vel[2] * T;
          }
        } else {
          [px, py, pz, cr, cg, cb, ca, ssx, ssy] = readVisualFallback(p, T);
        }
      } else if (!tr && !inGroup) {
        const vel = p.vel;
        px = p.pos[0] + vel[0] * T; py = p.pos[1] + vel[1] * T; pz = p.pos[2] + vel[2] * T;
        cr = p.color[0]; cg = p.color[1]; cb = p.color[2]; ca = p.color[3];
        ssx = p.scale[0]; ssy = p.scale[1];
      } else {
        // 自身轨道 + 组：走完整求值
        [px, py, pz, cr, cg, cb, ca, ssx, ssy] = readVisualFallback(p, T);
      }
    }
    // 入场/寿命门控：t < st 隐藏；有限 life 到期后隐藏；函数对象粒子在对象时长结束后隐藏。
    // fade 预设在出场窗口内做 alpha 渐显
    const gst = gate.st || 0;
    let vis;
    if (p.fx) {
      vis = fxParticleVisible(gate, T, plife) ? 1 : 0;
    } else {
      plife = typeof gate.life === 'number' ? gate.life : -1;
      vis = T >= gst ? 1 : 0;
      if (vis > 0 && plife >= 0 && T - gst >= plife) vis = 0;
    }
    if (vis > 0 && gate.ent && gate.ent.p === 'fade') {
      const fd = gate.ent.d || 5;
      if (T - gst < fd) vis *= Math.max(0, (T - gst) / fd);
    }
    ca *= vis;
    positions[i * 3] = px; positions[i * 3 + 1] = py; positions[i * 3 + 2] = pz;
    colors[i * 4] = cr; colors[i * 4 + 1] = cg; colors[i * 4 + 2] = cb; colors[i * 4 + 3] = ca;
    let texScaleX = 1, texScaleY = 1;
    if (hasAnyTexture) {
      UVOUT.mode = 0;
      const uv = resolveUV(p).uv;
      const tex = (uv && uv.texture) ? texAtlasMap[uv.texture] : null;
      if (uv && tex) {
        if (hasUvExpressions(uv)) {
          uvCtx.i = (p.fx && p._fxIdx != null) ? p._fxIdx : i;
          uvCtx.n = n;
          uvCtx.t = T;
          uvCtx.life = plife;
          uvCtx.uv_x = 0; uvCtx.uv_y = 0;
          uvCtxOut.pos[0] = px; uvCtxOut.pos[1] = py; uvCtxOut.pos[2] = pz;
          uvCtxOut.color[0] = cr; uvCtxOut.color[1] = cg; uvCtxOut.color[2] = cb; uvCtxOut.color[3] = ca;
          const vel = particleValueAt(p, 'vel', T);
          uvCtxOut.vel[0] = vel[0]; uvCtxOut.vel[1] = vel[1]; uvCtxOut.vel[2] = vel[2];
          uvCtxOut.scale = ssx;
          uvCtxOut.glow = !!p.glow;
          uvCtxOut.light = p.lightLevel || 0;
          uvCtxOut.life = plife;
          evalUVInto(uv, uvCtx, UV_EVAL);
        } else {
          evalUVInto(uv, null, UV_EVAL);
        }
        computeParticleUVFrom(uv, tex, UV_EVAL, UVOUT);
        if (uv.mode === 'animated') {
          hasAnimatedTex = true;
          const i4 = i * 4, i2 = i * 2;
          rpAnimStart[i2] = UV_EVAL.uvStart[0];
          rpAnimStart[i2 + 1] = UV_EVAL.uvStart[1];
          rpAnimStep[i2] = UV_EVAL.uvStep[0];
          rpAnimStep[i2 + 1] = UV_EVAL.uvStep[1];
          rpAnimFps[i] = UV_EVAL.fps;
          rpAnimMax[i] = UVOUT.maxFrame;
        }
        // 贴图大小缩放：使用用户设置的 texSize（控制粒子显示大小），基准 16px
        const texW = uv.texSize ? (uv.texSize[0] || 16) : 16;
        const texH = uv.texSize ? (uv.texSize[1] || 16) : 16;
        texScaleX = Math.max(1, texW) / 16;
        texScaleY = Math.max(1, texH) / 16;
      }
      const i4 = i * 4, i2 = i * 2;
      rpUV[i4] = UVOUT.au0; rpUV[i4 + 1] = UVOUT.av0; rpUV[i4 + 2] = UVOUT.au1; rpUV[i4 + 3] = UVOUT.av1;
      rpUVScale[i4] = UVOUT.sx; rpUVScale[i4 + 1] = UVOUT.sy; rpUVScale[i4 + 2] = UVOUT.sw; rpUVScale[i4 + 3] = UVOUT.sh;
      rpUVAnim[i4] = UVOUT.stepx; rpUVAnim[i4 + 1] = UVOUT.stepy; rpUVAnim[i4 + 2] = UVOUT.fps; rpUVAnim[i4 + 3] = UVOUT.maxFrame;
      rpUVTex[i2] = UVOUT.tw; rpUVTex[i2 + 1] = UVOUT.th;
      rpUVMode[i] = UVOUT.mode;
    }
    let sx = ssx * SZF * texScaleX, sy = ssy * SZF * texScaleY;
    if (vis === 0) {
      sizes[i * 2] = 0; sizes[i * 2 + 1] = 0;   // 尺寸归零 → 无片段光栅化，预览层完全隐藏
    } else {
      sizes[i * 2] = sx > 0.02 ? sx : 0.02;
      sizes[i * 2 + 1] = sy > 0.02 ? sy : 0.02;
    }
  }
  // 位置缓冲已原地更新：让拾取点集下次拾取时重算包围球（Raycaster 依赖它做射线粗筛）。
  if (pointsPick.geometry) pointsPick.geometry.boundingSphere = null;
  const uvAttr = points.geometry.getAttribute('aUV');
  if (hasAnyTexture || !uvAttr || uvAttr.array.length !== n * 4) {
    setPointUVAttributes(points.geometry, { uv: rpUV, uvScale: rpUVScale, uvAnim: rpUVAnim, uvTex: rpUVTex, uvMode: rpUVMode });
  }

  const sel = state.selected.size > 0 ? state.particles.filter(p => state.selected.has(p.id)) : [];
  if (!rpSelPos || rpSelPos.length !== sel.length * 3) rpSelPos = new Float32Array(sel.length * 3);
  if (!rpSelCol || rpSelCol.length !== sel.length * 4) rpSelCol = new Float32Array(sel.length * 4);
  if (!rpSelSize || rpSelSize.length !== sel.length * 2) rpSelSize = new Float32Array(sel.length * 2);
  const spos = rpSelPos, ssiz = rpSelSize;
  for (let i = 0; i < sel.length; i++) {
    const v = currentVisual(sel[i]);
    const off = velOffsetAt(sel[i], state.time);
    spos[i * 3] = v.pos[0] + off[0]; spos[i * 3 + 1] = v.pos[1] + off[1]; spos[i * 3 + 2] = v.pos[2] + off[2];
    // 与主循环一致：使用用户设置的 texSize 计算粒子尺寸
    const suv = resolveUV(sel[i]).uv;
    const texW = (suv && suv.texSize) ? (suv.texSize[0] || 16) : 16;
    const texH = (suv && suv.texSize) ? (suv.texSize[1] || 16) : 16;
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
    if (typeof refreshUVPanel === 'function' && document.getElementById('pane-texture') && document.getElementById('pane-texture').classList.contains('active')) refreshUVPanel();
  }
}

// 结构变化后的完整刷新：重建索引并写缓冲。deltaMs 为本次 process 的毫秒增量（scrub/seek 传 0）。
export function rebuildPoints(full, deltaMs) {
  rebuildIndexes();
  writePointBuffers(full, deltaMs || 0);
}

// 播放/拖动时间轴专用：结构未变、仅 time 变化，跳过索引重建以降低帧耗时。
export function rebuildPointsTime(full, deltaMs) {
  writePointBuffers(full, deltaMs || 0);
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

// —— 摄像机可视化更新（每帧） ——
// 同步 widget 增删：新建摄像机建 widget，删除的销毁 widget，所以新建/删除/导入/清空都不用
// 各自显式重建，主循环每帧自动对齐；再按 cameraPoseAt(id, T) 写入姿态并随 fov 更新视锥张角。
// 当前激活的摄像机橙色高亮，其余青色。
const CAM_WIDGET_FRUSTUM_LEN = 2;   // 视锥从机身前端向前延伸的世界单位
const CAM_WIDGET_NEAR_Z = -0.2;     // 机身前端（视锥近端）z
const CAM_WIDGET_NEAR_HW = 0.12;    // 视锥近端半宽
const CAM_WIDGET_NEAR_HH = 0.08;    // 视锥近端半高
const CAM_DEG2RAD = Math.PI / 180;

// widget 朝向计算的复用临时量（避免每帧分配）。
// Group 不是相机：Object3D.lookAt 对非相机对象把「+Z 指向目标」，而 widget 几何体
// （机身前端 + 视锥）沿局部 -Z 延伸，直接调用会让指示方向完全相反。因此这里改用
// 相机分支的矩阵构造 Matrix4.lookAt(eye=pos, target)：+Z = normalize(pos - target)，
// 即局部 -Z 指向目标，与 PerspectiveCamera.lookAt 完全一致。
const _camLookM = new THREE.Matrix4();
const _camRollQ = new THREE.Quaternion();
const _camEye = new THREE.Vector3();
const _camTgt = new THREE.Vector3();
const _camUp = new THREE.Vector3(0, 1, 0);
const _camZAxis = new THREE.Vector3(0, 0, 1);

function setFrustumVertices(w, fovDeg, aspect) {
  const L = CAM_WIDGET_FRUSTUM_LEN;
  const fh = L * Math.tan(Math.max(1, Math.min(179, fovDeg)) * CAM_DEG2RAD * 0.5);
  const fw = fh * Math.max(aspect || 1, 0.1);
  const nearZ = CAM_WIDGET_NEAR_Z;
  const farZ = nearZ - L;
  const nw = CAM_WIDGET_NEAR_HW, nh = CAM_WIDGET_NEAR_HH;
  // 8 线段（4 侧棱 + 远端取景框），每线段 2 顶点
  const arr = w.frustumGeo.getAttribute('position').array;
  arr.set([
    -nw,  nh, nearZ,  -fw,  fh, farZ,   // 侧棱 n0->f0
     nw,  nh, nearZ,   fw,  fh, farZ,   // 侧棱 n1->f1
     nw, -nh, nearZ,   fw, -fh, farZ,   // 侧棱 n2->f2
    -nw, -nh, nearZ,  -fw, -fh, farZ,   // 侧棱 n3->f3
    -fw,  fh, farZ,    fw,  fh, farZ,   // 远端框 f0->f1
     fw,  fh, farZ,    fw, -fh, farZ,   // 远端框 f1->f2
     fw, -fh, farZ,   -fw, -fh, farZ,   // 远端框 f2->f3
    -fw, -fh, farZ,   -fw,  fh, farZ,   // 远端框 f3->f0
  ]);
  w.frustumGeo.getAttribute('position').needsUpdate = true;
}

export function updateCameraWidgets(T) {
  // 同步增删
  const seen = new Set();
  for (const cam of state.cameras) {
    seen.add(cam.id);
    let w = cameraWidgetMap[cam.id];
    if (!w) {
      w = buildCameraWidget();
      cameraWidgetMap[cam.id] = w;
    }
    const pose = cameraPoseAt(cam.id, T);
    if (pose) {
      w.group.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
      // 让 widget 局部 -Z 指向目标（与相机朝向一致），见 _camLookM 声明处注释。
      _camEye.set(pose.pos[0], pose.pos[1], pose.pos[2]);
      _camTgt.set(pose.target[0], pose.target[1], pose.target[2]);
      _camLookM.lookAt(_camEye, _camTgt, _camUp);
      w.group.quaternion.setFromRotationMatrix(_camLookM);
      // roll：与 applyPose 相同——绕局部 Z 轴翻滚（右乘，lookAt 只决定 pitch/yaw）
      if (pose.roll) {
        _camRollQ.setFromAxisAngle(_camZAxis, pose.roll * CAM_DEG2RAD);
        w.group.quaternion.multiply(_camRollQ);
      }
      setFrustumVertices(w, pose.fov, camera.aspect);
    }
    // 切换到某摄像机（activeCamera）时完全隐藏该摄像机的 widget，避免视角中出现橙色方框
    w.group.visible = state.activeCamera !== cam.id;
  }
  for (const id in cameraWidgetMap) {
    if (!seen.has(id)) {
      removeCameraWidget(cameraWidgetMap[id]);
      delete cameraWidgetMap[id];
    }
  }
}
