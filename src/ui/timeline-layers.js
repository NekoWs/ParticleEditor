/* =========================================================================
 * 底部时间轴 · lane 画布（与左侧 HTML 标签轨共用 tlTreeFlatRows）
 *
 * - 行模型完全来自 timeline-tree.js 的 tlTreeFlatRows()；
 * - 顶层对象行（组/粒子/函数对象）保留 st/life 拖拽条；
 * - 属性/分量/变量行绘制关键帧菱形（隐藏 0t 默认关键帧）；
 * - 播放头与刻度横跨整块画布，与上方 #timeline 标尺共享
 *   timelineViewStart / TL_PX_PER_TICK；
 * - 垂直滚动由 #tl-tree 的 scrollTop 驱动（tlLayerState.scroll）。
 * ======================================================================= */

import { t } from '../core/i18n.js';
import { addLongPress, hasTouch } from '../core/device.js';
import { state, propComps, compPr, getParticle } from '../core/constants.js';
import { TL_PX_PER_TICK, timelineViewStart, setTimelineViewStart, setTLPxPerTick, drawTimeline, scrubAutoPan, tlNiceStep, commitFunctionRebuild } from './panels.js';
import { rebuildPoints, maxTick, invalidateMaxTickCache } from '../core/animation.js';
import { findTrackByPr } from '../core/animation-eval.js';
import { baseValueFor, removeKeyframe } from '../core/edit.js';
import { saveWorkspaceState } from './blocks-ui.js';
import { resize, applyTimeChange } from '../main.js';
import { pushUndo } from '../state/undo.js';
import { refreshTimelineTree, tlTreeFlatRows, TL_TREE_ROW_H } from './timeline-tree.js';
import { openKeyframeEditor, openVarKeyframeEditor, removeVarKeyframe, showContextMenu, drawDiamond } from './tree.js';

export const tlLayerState = { scroll: 0, drag: null, hit: [], selectedKf: null };
const TL_KF_HIT_PX = 6;
let laneKfHits = [];

// 分量关键帧菱形配色（与旧的 .comp-timeline 视觉一致）
const LANE_KF_COLORS = {
  x: '#ffcc55', y: '#5b9dff', z: '#6bd489',
  r: '#ff7b6b', g: '#6bd489', b: '#5b9dff', a: '#e57fae',
};

export function particleLifeEnd(p) {
  const life = typeof p.life === 'number' ? p.life : -1;
  const s = p.st || 0;
  return life < 0 ? Infinity : s + life;
}

/** 函数对象所有变量关键帧的最大 tick（约束对象时长的下限）。 */
export function fxVarMaxTick(fx) {
  let max = 0;
  for (const v of Object.values(fx.vars || {})) {
    for (const k of (v.kf || [])) if (k[0] > max) max = k[0];
  }
  return max;
}

/** 顶层对象行的可见性跨度 [start, end]；end 可为 Infinity（无限寿命）。 */
export function rowSpan(r) {
  if (r.kind === 'group') {
    let lo = Infinity, hi = -Infinity, anyInf = false;
    for (const id of r.members) {
      const p = getParticle(id);
      if (!p) continue;
      const e = particleLifeEnd(p), s = p.st || 0;
      lo = Math.min(lo, s);
      if (e === Infinity) anyInf = true; else hi = Math.max(hi, e);
    }
    if (lo === Infinity) { lo = 0; }
    return [lo, anyInf ? Infinity : Math.max(hi, lo)];
  }
  if (r.kind === 'fx') {
    const fx = r.fx;
    let extent = Math.max(fx.duration || 0, fxVarMaxTick(fx));
    return [fx.st || 0, (fx.st || 0) + extent];
  }
  const s = r.p.st || 0, e = particleLifeEnd(r.p);
  return [s, e];
}

function barRowFor(row) {
  if (row.kind === 'group') return { kind: 'group', name: row.name, members: row.members };
  if (row.kind === 'particle') return { kind: 'particle', p: row.p };
  return { kind: 'fx', fx: row.fx };
}



// 0t 默认关键帧（轨道创建时写入的基线 kf0）不画菱形
function isDefaultKf(tr, id, prop, comp, kf) {
  if (kf[0] !== 0) return false;
  const baseline = tr.m === 'op' ? 0 : baseValueFor(id, prop, comp);
  return Math.abs(kf[1] - baseline) < 1e-6;
}

function drawKfsForTrack(ctx, tr, id, prop, comp, w, cy, color, X) {
  for (const kf of tr.kf) {
    if (isDefaultKf(tr, id, prop, comp, kf)) continue;
    const x = X(kf[0]);
    if (x < -6 || x > w + 6) continue;
    const pr = compPr(prop, comp);
    const sel = tlLayerState.selectedKf && tlLayerState.selectedKf.kind === 'track' &&
      tlLayerState.selectedKf.id === id && tlLayerState.selectedKf.pr === pr && tlLayerState.selectedKf.tick === kf[0];
    drawDiamond(ctx, x, cy, 4, sel ? '#5b9dff' : color);
    laneKfHits.push({ kind: 'track', x, y: cy, id, pr, tick: kf[0], kf, tr });
  }
}

function drawPropLane(ctx, row, y, w, rowH, X) {
  const cy = y + rowH / 2;
  if (row.prop === 'fov') {
    // FOV 标量行：无分量，直接画 fov 轨道菱形
    const tr = findTrackByPr('fov', row.id);
    if (tr) drawKfsForTrack(ctx, tr, row.id, 'fov', '', w, cy, '#ffcc55', X);
    return;
  }
  for (const comp of propComps(row.id, row.prop)) {
    const tr = findTrackByPr(compPr(row.prop, comp), row.id);
    if (!tr) continue;
    drawKfsForTrack(ctx, tr, row.id, row.prop, comp, w, cy, LANE_KF_COLORS[comp] || '#ffcc55', X);
  }
}

function drawCompLane(ctx, row, y, w, rowH, X) {
  const tr = findTrackByPr(compPr(row.prop, row.comp), row.id);
  if (!tr) return;
  drawKfsForTrack(ctx, tr, row.id, row.prop, row.comp, w, y + rowH / 2, LANE_KF_COLORS[row.comp] || '#ffcc55', X);
}

function drawVarLane(ctx, row, y, w, rowH, X) {
  const v = row.fx.vars && row.fx.vars[row.name];
  const kfs = v && v.kf ? v.kf : [];
  const cy = y + rowH / 2;
  for (const kf of kfs) {
    const x = X(kf[0]);
    if (x < -6 || x > w + 6) continue;
    const sel = tlLayerState.selectedKf && tlLayerState.selectedKf.kind === 'var' &&
      tlLayerState.selectedKf.fxId === row.fx.id && tlLayerState.selectedKf.name === row.name && tlLayerState.selectedKf.tick === kf[0];
    drawDiamond(ctx, x, cy, 4, sel ? '#5b9dff' : '#ffcc55');
    laneKfHits.push({ kind: 'var', x, y: cy, fxId: row.fx.id, name: row.name, tick: kf[0], kf, v, fx: row.fx });
  }
}

function drawBarLane(ctx, row, y, w, rowH, X) {
  const r = barRowFor(row);
  const [s, e] = rowSpan(r);
  const bx = X(s);
  const inf = e === Infinity;
  const bw = inf ? Math.max(4, w - bx) : Math.max(4, X(e) - X(s));
  const bh = rowH - 6;

  ctx.fillStyle = row.kind === 'group' ? '#c9a24b' : row.kind === 'fx' ? '#7e6bc9' : '#4b7ec9';
  ctx.fillRect(bx, y + 3, bw, bh);

  if (inf) {
    const grad = ctx.createLinearGradient(w - 60, 0, w, 0);
    grad.addColorStop(0, 'rgba(24,27,34,0)');
    grad.addColorStop(1, '#181b22');
    ctx.fillStyle = grad;
    ctx.fillRect(Math.max(bx, w - 60), y + 3, w - Math.max(bx, w - 60), bh);
    if (bw > 26) {
      ctx.fillStyle = '#aab3c5';
      ctx.font = '10px sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText('∞', Math.min(w - 14, bx + bw - 12), y + rowH / 2);
    }
  } else {
    ctx.fillStyle = '#dfe6f2';
    ctx.fillRect(X(e) - 1.5, y + 2, 3, rowH - 4);   // 寿命终点手柄
  }
  ctx.fillStyle = '#e8ecf5';
  ctx.fillRect(bx - 1.5, y + 2, 3, rowH - 4);       // 起点(入场)手柄
  if (state.time < s) {
    ctx.fillStyle = 'rgba(24,27,34,0.55)';
    ctx.fillRect(bx, y + 3, Math.max(0, w - bx), bh);
  }

  tlLayerState.hit.push({ y, rowH, r, s, e, inf, bx, bw });
}

function drawLaneRow(ctx, row, y, w, rowH, X) {
  // 行分隔线（HTML 侧行高一致，这里画一条淡线增强对齐感）
  ctx.strokeStyle = '#232833';
  ctx.beginPath();
  ctx.moveTo(0, y + rowH - 0.5);
  ctx.lineTo(w, y + rowH - 0.5);
  ctx.stroke();

  if (row.kind === 'group' || row.kind === 'particle' || row.kind === 'fx') {
    drawBarLane(ctx, row, y, w, rowH, X);
  } else if (row.kind === 'prop') {
    drawPropLane(ctx, row, y, w, rowH, X);
  } else if (row.kind === 'comp') {
    drawCompLane(ctx, row, y, w, rowH, X);
  } else if (row.kind === 'var') {
    drawVarLane(ctx, row, y, w, rowH, X);
  }
}

export function drawTimelineLayers() {
  const canvas = document.getElementById('tl-layers-canvas');
  if (typeof refreshTimelineTree === 'function') refreshTimelineTree();
  if (!canvas) return;

  // 与 HTML 标签轨共享滚动偏移
  const tree = document.getElementById('tl-tree');
  if (tree) tlLayerState.scroll = tree.scrollTop || 0;

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#181b22';
  ctx.fillRect(0, 0, w, h);

  const pxPerTick = TL_PX_PER_TICK;
  const X = t => (t - timelineViewStart) * pxPerTick;
  const viewEnd = timelineViewStart + w / pxPerTick;

  // 与上方标尺同一缩放：主/次刻度随 TL_PX_PER_TICK 自适应（数字只在上方标尺显示）
  const major = tlNiceStep(pxPerTick, 40);
  const minor = major / 5;
  const start = Math.max(0, Math.floor(timelineViewStart / minor) * minor);
  const count = Math.ceil((viewEnd - start) / minor) + 1;
  ctx.strokeStyle = '#262b34';
  for (let i = 0; i < count; i++) {
    const t = start + i * minor;
    if (t < 0 || t > viewEnd + minor) continue;
    ctx.beginPath(); ctx.moveTo(X(t), 0); ctx.lineTo(X(t), h); ctx.stroke();
  }

  const rowH = TL_TREE_ROW_H;
  const rows = tlTreeFlatRows();
  tlLayerState.hit = [];
  laneKfHits = [];
  let y = -tlLayerState.scroll;
  for (const row of rows) {
    if (y + rowH < 0) { y += rowH; continue; }
    if (y > h) break;
    drawLaneRow(ctx, row, y, w, rowH, X);
    y += rowH;
  }

  // 播放头（贯穿全部 lane）
  const phx = X(state.time);
  ctx.strokeStyle = 'rgba(255,204,85,0.5)';
  ctx.beginPath();
  ctx.moveTo(phx, 0);
  ctx.lineTo(phx, h);
  ctx.stroke();
}

/** 顶层对象条的命中检测：返回 {hit, zone}；zone ∈ 'start'|'life'|'body'。 */
export function tlLayerHitAt(clientX, clientY) {
  const canvas = document.getElementById('tl-layers-canvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const lx = clientX - rect.left;
  const ly = clientY - rect.top;   // 命中坐标与绘制坐标同为画布视觉坐标（不再加 scroll）
  for (const hsp of tlLayerState.hit) {
    if (ly < hsp.y || ly >= hsp.y + hsp.rowH) continue;
    if (lx < hsp.bx - 5 || lx > hsp.bx + hsp.bw + 5) continue;
    let zone = 'body';
    if (lx <= hsp.bx + 4) zone = 'start';
    else if (!hsp.inf && lx >= hsp.bx + hsp.bw - 4) zone = 'life';
    return { hit: hsp, zone };
  }
  return null;
}

export function setRowStart(r, v) {
  if (r.kind === 'particle' || r.kind === 'member') r.p.st = v;
  else if (r.kind === 'fx') r.fx.st = v;
}

export function setParticleLife(p, v) {
  p.life = Math.max(1, v);   // 拖拽调整的最小寿命 1 tick
}

export function shiftGroup(r, delta) {
  if (!delta) return;
  for (const id of r.members) {
    const p = getParticle(id);
    if (p) p.st = Math.max(0, (p.st || 0) + delta);
  }
}

export function timelineXToTickL(clientX) {
  const canvas = document.getElementById('tl-layers-canvas');
  const rect = canvas.getBoundingClientRect();
  return timelineViewStart + (clientX - rect.left) / TL_PX_PER_TICK;
}

function hitKeyframeAt(clientX, clientY) {
  const canvas = document.getElementById('tl-layers-canvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const lx = clientX - rect.left;
  const ly = clientY - rect.top;   // 命中坐标与绘制坐标同为画布视觉坐标（不再加 scroll）
  for (const h of laneKfHits) {
    if (Math.abs(lx - h.x) <= TL_KF_HIT_PX && Math.abs(ly - h.y) <= TL_KF_HIT_PX) return h;
  }
  return null;
}

/** 轻刷新：st/life 改动后同步时长显示、标尺、lane 区与预览。 */
export function refreshAllPanelsLight() {
  // 先失效 maxTick 缓存：st/life/duration 改动会改变时间轴总长，必须在读取前失效，
  // 否则 #tl-max 与循环播放边界仍取到上一次的缓存值（rebuildPoints 内部的失效发生在读值之后）。
  invalidateMaxTickCache();
  const maxEl = document.getElementById('tl-max');
  if (maxEl) maxEl.textContent = maxTick();
  if (typeof drawTimeline === 'function') drawTimeline();
  drawTimelineLayers();
  rebuildPoints(false);
}

export function tlInitLayerEvents() {
  const canvas = document.getElementById('tl-layers-canvas');
  if (!canvas) return;

  // 触屏手势（移动端优化）：
  // - 单指在空白处拖动 = 平移时间轴视图（与 #timeline 中键拖动一致，不再 scrub）；
  // - 双指捏合 = 以两指中点为锚点缩放每 tick 像素，双指中点移动同步平移。
  // 关键帧/寿命条拖拽与鼠标左键 scrub 行为保持不变。
  const touchGest = { pointers: new Map(), mode: null, panStart: null, pinch: null };

  const beginTouchPinch = () => {
    const pts = [...touchGest.pointers.values()];
    if (pts.length < 2) return;
    const a = pts[0], b = pts[1];
    const midX = (a.x + b.x) / 2 - canvas.getBoundingClientRect().left;
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    touchGest.mode = 'pinch';
    touchGest.panStart = null;
    touchGest.pinch = {
      startDist: dist,
      startPx: TL_PX_PER_TICK,
      // 捏合锚点：手势开始时两指中点正对的 tick，缩放过程中保持该 tick 跟随中点
      anchorTick: timelineViewStart + midX / TL_PX_PER_TICK,
    };
  };

  const updateTouchPinch = () => {
    const pinch = touchGest.pinch;
    const pts = [...touchGest.pointers.values()];
    if (!pinch || pts.length < 2) return;
    const a = pts[0], b = pts[1];
    const midX = (a.x + b.x) / 2 - canvas.getBoundingClientRect().left;
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const newPx = Math.max(0.25, Math.min(128, pinch.startPx * dist / pinch.startDist));
    setTLPxPerTick(newPx);
    // 中点移动会自然带动平移：锚点 tick 始终落在当前中点处
    setTimelineViewStart(Math.max(0, pinch.anchorTick - midX / newPx));
    drawTimeline();
    drawTimelineLayers();
  };

  // HTML 标签轨滚动 → 同步 lane 画布
  const tree = document.getElementById('tl-tree');
  if (tree) {
    tree.addEventListener('scroll', () => {
      tlLayerState.scroll = tree.scrollTop || 0;
      drawTimelineLayers();
    });
  }

  canvas.addEventListener('pointerdown', ev => {
    // 触屏手势登记：任何触屏按下都先记录，第二根手指落下即切换为捏合缩放。
    if (ev.pointerType === 'touch') {
      touchGest.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (touchGest.pointers.size >= 2) {
        // 结束当前单指拖拽（关键帧/寿命条/平移），进入双指缩放
        tlLayerState.drag = null;
        state.scrubbing = false;
        touchGest.mode = null;
        touchGest.panStart = null;
        try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
        beginTouchPinch();
        drawTimeline();
        drawTimelineLayers();
        return;
      }
    }
    if (ev.button !== 0) return;
    // 拖动时间轴时，之前聚焦的输入框应取消焦点而非保持/重新聚焦
    if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) {
      document.activeElement.blur();
    }
    const kfHit = hitKeyframeAt(ev.clientX, ev.clientY);
    if (kfHit) {
      // 点击即选中；拖动时才 pushUndo（见 pointermove）
      if (kfHit.kind === 'var') {
        tlLayerState.selectedKf = { kind: 'var', fxId: kfHit.fxId, name: kfHit.name, tick: kfHit.tick };
        canvas.setPointerCapture(ev.pointerId);
        tlLayerState.drag = { kind: 'varkf', ...kfHit, startX: ev.clientX, undoPushed: false };
      } else {
        tlLayerState.selectedKf = { kind: 'track', id: kfHit.id, pr: kfHit.pr, tick: kfHit.tick };
        canvas.setPointerCapture(ev.pointerId);
        tlLayerState.drag = { kind: 'kf', ...kfHit, startX: ev.clientX, undoPushed: false };
      }
      drawTimelineLayers();
      return;
    }
    tlLayerState.selectedKf = null;
    const res = tlLayerHitAt(ev.clientX, ev.clientY);
    if (!res) {
      if (ev.pointerType === 'touch') {
        // 空白处触屏单指拖动：平移时间轴视图（与 #timeline 中键拖动一致）
        canvas.setPointerCapture(ev.pointerId);
        touchGest.mode = 'pan';
        touchGest.panStart = { x: ev.clientX, y: ev.clientY, viewStart: timelineViewStart };
        return;
      }
      // 空白区域鼠标拖动：scrub 播放头（无关键帧/对象时也能拖动标尺）
      canvas.setPointerCapture(ev.pointerId);
      state.scrubbing = true;
      state.time = Math.max(0, timelineXToTickL(ev.clientX));
      applyTimeChange();
      tlLayerState.drag = { kind: 'scrub' };
      drawTimeline();
      drawTimelineLayers();
      return;
    }
    const { hit, zone } = res;
    pushUndo();
    canvas.setPointerCapture(ev.pointerId);
    const ptrTick = Math.round(timelineXToTickL(ev.clientX));
    if (hit.r.kind === 'group') {
      if (zone === 'life') {
        // 组寿命终点手柄：整体拉长/缩短成员寿命
        tlLayerState.drag = { kind: 'grouplife', r: hit.r, lastTick: ptrTick };
      } else {
        tlLayerState.drag = { kind: 'shift', r: hit.r, lastTick: ptrTick };
      }
      return;
    }
    // 点击瞬间不跳位：记录「指针-当前值」抓取偏移，拖动后按偏移平移
    if (zone === 'life') {
      if (hit.r.kind === 'fx') {
        const fx = hit.r.fx;
        const [s, e] = rowSpan(hit.r);
        tlLayerState.drag = { kind: 'fxdur', fx, grabOff: ptrTick - Math.max(1, e - s) };
      } else {
        const p = hit.r.p;
        const end = particleLifeEnd(p);
        const curLife = end === Infinity ? -1 : Math.max(1, end - (p.st || 0));
        tlLayerState.drag = { kind: 'life', p, grabOff: ptrTick - curLife };
      }
    } else {
      const cur = hit.r.kind === 'fx' ? (hit.r.fx.st || 0) : (hit.r.p.st || 0);
      tlLayerState.drag = { kind: 'start', r: hit.r, grabOff: ptrTick - cur };
    }
    drawTimelineLayers();
  });

  canvas.addEventListener('pointermove', ev => {
    // 触屏手势优先：捏合缩放 / 单指平移接管，不进入关键帧/寿命条/scrub 逻辑。
    if (ev.pointerType === 'touch' && touchGest.pointers.has(ev.pointerId)) {
      touchGest.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (touchGest.mode === 'pinch') { updateTouchPinch(); return; }
      if (touchGest.mode === 'pan') {
        const dx = ev.clientX - touchGest.panStart.x;
        setTimelineViewStart(Math.max(0, touchGest.panStart.viewStart - dx / TL_PX_PER_TICK));
        drawTimeline();
        drawTimelineLayers();
        return;
      }
    }
    const d = tlLayerState.drag;
    if (!d) {
      // 光标：默认 default；关键帧上 pointer；粒子寿命条主体上 grab；两端手柄 ew-resize
      const kf = hitKeyframeAt(ev.clientX, ev.clientY);
      if (kf) { canvas.style.cursor = 'pointer'; return; }
      const res = tlLayerHitAt(ev.clientX, ev.clientY);
      if (!res) { canvas.style.cursor = 'default'; return; }
      if (res.zone !== 'body') { canvas.style.cursor = 'ew-resize'; return; }
      const kind = res.hit.r.kind;
      canvas.style.cursor = (kind === 'particle' || kind === 'member') ? 'grab' : 'default';
      return;
    }
    if (d.kind === 'kf') {
      const t = Math.max(0, Math.round(timelineXToTickL(ev.clientX)));
      if (t !== d.kf[0]) {
        if (!d.undoPushed) { pushUndo(); d.undoPushed = true; }
        d.kf[0] = t;
        if (d.tr) d.tr.kf.sort((a, b) => a[0] - b[0]);
        tlLayerState.selectedKf = { kind: 'track', id: d.id, pr: d.pr, tick: t };
        refreshAllPanelsLight();
      }
      return;
    }
    if (d.kind === 'varkf') {
      const t = Math.max(0, Math.round(timelineXToTickL(ev.clientX)));
      if (t !== d.kf[0]) {
        if (!d.undoPushed) { pushUndo(); d.undoPushed = true; }
        d.kf[0] = t;
        if (d.v) d.v.kf.sort((a, b) => a[0] - b[0]);
        tlLayerState.selectedKf = { kind: 'var', fxId: d.fxId, name: d.name, tick: t };
        commitFunctionRebuild(d.fx);
        refreshAllPanelsLight();
      }
      return;
    }
    if (d.kind === 'scrub') {
      const rect = canvas.getBoundingClientRect();
      const r = scrubAutoPan(d, ev.clientX, rect, timelineViewStart, state.time, TL_PX_PER_TICK, 0, 0);
      setTimelineViewStart(r.viewStart);
      state.time = r.time;
      applyTimeChange();
      drawTimeline();
      drawTimelineLayers();
      return;
    }
    const ptrTick = timelineXToTickL(ev.clientX);
    if (d.kind === 'start') {
      setRowStart(d.r, Math.max(0, Math.round(ptrTick - d.grabOff)));
    } else if (d.kind === 'life') {
      setParticleLife(d.p, Math.max(1, Math.round(ptrTick - d.grabOff)));
    } else if (d.kind === 'fxdur') {
      const minDur = Math.max(1, fxVarMaxTick(d.fx));
      d.fx.duration = Math.max(minDur, Math.round(ptrTick - d.grabOff));
      const durEl = document.getElementById('fx-duration');
      if (durEl && document.activeElement !== durEl) durEl.value = d.fx.duration;
      // duration 改变会 (1) 失效脚本/life 求值缓存 (2) 重建派生轨道采样范围；
      // 否则缩短时长后 state.tracks 残留 tick > duration 的旧派生关键帧，maxTick() 仍取旧长度，
      // 编辑器预览会「设置 50 却播放到 100」。与 varkf 分支一致地重建。
      commitFunctionRebuild(d.fx);
    } else if (d.kind === 'grouplife') {
      const t = Math.round(ptrTick);
      const delta = t - d.lastTick;
      if (delta) {
        for (const id of d.r.members) {
          const p = getParticle(id);
          if (p && p.life != null && p.life >= 0) {
            setParticleLife(p, Math.max(1, p.life + delta));
          }
        }
        d.lastTick += delta;
      }
    } else {
      const t = Math.round(ptrTick);
      const delta = t - d.lastTick;
      if (delta) { shiftGroup(d.r, delta); d.lastTick += delta; }
    }
    refreshAllPanelsLight();
  });

  const endDrag = () => { tlLayerState.drag = null; state.scrubbing = false; };

  const endTouchPointer = (ev) => {
    if (ev.pointerType !== 'touch' || !touchGest.pointers.has(ev.pointerId)) return;
    touchGest.pointers.delete(ev.pointerId);
    if (touchGest.mode === 'pinch') {
      if (touchGest.pointers.size < 2) {
        touchGest.pinch = null;
        if (touchGest.pointers.size === 1) {
          // 双指缩放中抬起一指：剩余那指继续平移，手势体验连续
          const [last] = [...touchGest.pointers.values()];
          touchGest.mode = 'pan';
          touchGest.panStart = { x: last.x, y: last.y, viewStart: timelineViewStart };
        } else {
          touchGest.mode = null;
          touchGest.panStart = null;
        }
      }
    } else if (touchGest.mode === 'pan') {
      if (touchGest.pointers.size === 0) {
        touchGest.mode = null;
        touchGest.panStart = null;
      }
    }
  };
  canvas.addEventListener('pointerup', (ev) => { endTouchPointer(ev); endDrag(); });
  canvas.addEventListener('pointercancel', (ev) => { endTouchPointer(ev); endDrag(); });

  const handleLaneDblClick = (ev) => {
    const res = tlLayerHitAt(ev.clientX, ev.clientY);
    if (!res || res.hit.r.kind === 'group' || res.hit.r.kind === 'fx') return;
    if (res.zone !== 'life' && !(res.hit.inf && res.zone === 'body')) return;
    const p = res.hit.r.p;
    pushUndo();
    if (particleLifeEnd(p) === Infinity) {
      setParticleLife(p, Math.max(1, Math.round(timelineXToTickL(ev.clientX)) - (p.st || 0)));
    } else {
      p.life = -1; // 无限
    }
    refreshAllPanelsLight();
  };
  canvas.addEventListener('dblclick', handleLaneDblClick);

  const openLaneContextMenu = (clientX, clientY) => {
    const kfHit = hitKeyframeAt(clientX, clientY);
    if (!kfHit) return;
    if (kfHit.kind === 'var') {
      tlLayerState.selectedKf = { kind: 'var', fxId: kfHit.fxId, name: kfHit.name, tick: kfHit.tick };
      drawTimelineLayers();
      showContextMenu(clientX, clientY, [
        {
          label: t('tree.edit'),
          action: () => openVarKeyframeEditor(canvas, kfHit.fx, kfHit.name, kfHit.tick, clientX, clientY),
        },
        {
          label: t('common.delete'),
          danger: true,
          action: () => {
            removeVarKeyframe(kfHit.fx, kfHit.name, kfHit.tick);
            tlLayerState.selectedKf = null;
            refreshAllPanelsLight();
          },
        },
      ]);
      return;
    }
    tlLayerState.selectedKf = { kind: 'track', id: kfHit.id, pr: kfHit.pr, tick: kfHit.tick };
    drawTimelineLayers();
    showContextMenu(clientX, clientY, [
      {
        label: t('tree.edit'),
        action: () => openKeyframeEditor(canvas, kfHit.id, kfHit.pr, kfHit.tick, clientX, clientY),
      },
      {
        label: t('common.delete'),
        danger: true,
        action: () => {
          removeKeyframe(kfHit.id, kfHit.pr, kfHit.tick);
          tlLayerState.selectedKf = null;
          refreshAllPanelsLight();
        },
      },
    ]);
  };

  let lastLongPressAt = 0;
  // 右键关键帧菱形 → 「编辑 / 删除」菜单（桌面）
  canvas.addEventListener('contextmenu', ev => {
    ev.preventDefault();
    // 触屏长按已经弹出菜单时，忽略随后可能派发的 contextmenu，避免重复。
    if (Date.now() - lastLongPressAt < 900) return;
    openLaneContextMenu(ev.clientX, ev.clientY);
  });

  if (hasTouch()) {
    // 触屏长按关键帧菱形 = 右键菜单
    addLongPress(canvas, (ev) => {
      if (hitKeyframeAt(ev.clientX, ev.clientY)) {
        lastLongPressAt = Date.now();
        openLaneContextMenu(ev.clientX, ev.clientY);
      }
    }, { delay: 480, tolerance: 12 });

    // 触屏双击寿命终点手柄 = 无限 ⇄ 有限
    let lastTap = null;
    canvas.addEventListener('pointerup', (ev) => {
      if (ev.pointerType !== 'touch') return;
      const now = Date.now();
      if (lastTap && now - lastTap.t <= 360 && Math.hypot(ev.clientX - lastTap.x, ev.clientY - lastTap.y) <= 14) {
        lastTap = null;
        handleLaneDblClick(ev);
      } else {
        lastTap = { t: now, x: ev.clientX, y: ev.clientY };
      }
    });
  }

  // canvas 滚轮 → 滚动左侧 HTML 标签轨（其 scroll 事件会驱动本画布重绘）
  canvas.addEventListener('wheel', ev => {
    ev.preventDefault();
    if (!tree) return;
    const delta = ev.deltaY > 0 ? TL_TREE_ROW_H * 2 : -TL_TREE_ROW_H * 2;
    tree.scrollTop = Math.max(0, tree.scrollTop + delta);
  }, { passive: false });

  // 时间轴模块整体高度拖拽（模块顶边）：clientY 差分驱动，方向=向上拖增高。
  const moduleGrip = document.getElementById('tl-module-resize');
  if (moduleGrip) {
    let resizing = false, lastY = 0;
    moduleGrip.addEventListener('pointerdown', (e) => {
      resizing = true;
      lastY = e.clientY;
      moduleGrip.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    moduleGrip.addEventListener('pointermove', (e) => {
      if (!resizing) return;
      const dy = e.clientY - lastY;
      lastY = e.clientY;
      const cur = parseFloat(getComputedStyle(document.body).getPropertyValue('--tl-h')) || 360;
      const nh = Math.min(window.innerHeight * 0.75, Math.max(160, cur - dy));
      document.body.style.setProperty('--tl-h', nh + 'px');
      resize();               // .layout 1fr 行随之收缩，会影响 3D 视口
      drawTimelineLayers();
    });
    const stopResize = () => {
      if (!resizing) return;
      resizing = false;
      resize();
      if (typeof saveWorkspaceState === 'function') saveWorkspaceState();
    };
    moduleGrip.addEventListener('pointerup', stopResize);
    moduleGrip.addEventListener('pointercancel', stopResize);
  }
}