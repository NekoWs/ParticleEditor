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

import { state, TRACK_COMPS, compPr, getFunction } from '../core/constants.js';
import { TL_PX_PER_TICK, timelineViewStart, drawTimeline } from './panels.js';
import { rebuildPoints, maxTick } from '../core/animation.js';
import { findTrackByPr } from '../core/animation-eval.js';
import { varKfValue } from '../core/easing.js';
import { baseValueFor } from '../core/edit.js';
import { saveWorkspaceState } from './blocks-ui.js';
import { resize } from '../main.js';
import { pushUndo } from '../state/undo.js';
import { refreshTimelineTree, tlTreeFlatRows, TL_TREE_ROW_H } from './timeline-tree.js';
import { openKeyframeEditor } from './tree.js';

export const tlLayerState = { scroll: 0, drag: null, hit: [] };
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

/** 顶层对象行的可见性跨度 [start, end]；end 可为 Infinity（无限寿命）。 */
export function rowSpan(r) {
  if (r.kind === 'group') {
    let lo = Infinity, hi = -Infinity, anyInf = false;
    for (const id of r.members) {
      const p = state.particles.find(q => q.id === id);
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
    let extent = fx.duration || 0;
    for (const v of Object.values(fx.vars)) for (const k of (v.kf || [])) if (k[0] > extent) extent = k[0];
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

function drawDiamond(ctx, x, cy, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, cy - 4);
  ctx.lineTo(x + 4, cy);
  ctx.lineTo(x, cy + 4);
  ctx.lineTo(x - 4, cy);
  ctx.closePath();
  ctx.fill();
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
    drawDiamond(ctx, x, cy, color);
    laneKfHits.push({ x, y: cy, id, pr: compPr(prop, comp), tick: kf[0], kf, tr });
  }
}

function drawPropLane(ctx, row, y, w, rowH, X) {
  const cy = y + rowH / 2;
  for (const comp of TRACK_COMPS[row.prop] || []) {
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
    drawDiamond(ctx, x, cy, '#ffcc55');
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

  // 每 5 tick 一条竖刻度线（与上方标尺同一视口；数字只在上方标尺显示）
  ctx.strokeStyle = '#262b34';
  for (let t = Math.max(0, Math.floor(timelineViewStart / 5) * 5); t <= viewEnd; t += 5) {
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

export function X_of(t) { return (t - timelineViewStart) * TL_PX_PER_TICK; }

/** 顶层对象条的命中检测：返回 {hit, zone}；zone ∈ 'start'|'life'|'body'。 */
export function tlLayerHitAt(clientX, clientY) {
  const canvas = document.getElementById('tl-layers-canvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const lx = clientX - rect.left;
  const ly = clientY - rect.top + tlLayerState.scroll;
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
    const p = state.particles.find(q => q.id === id);
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
  const ly = clientY - rect.top + tlLayerState.scroll;
  for (const h of laneKfHits) {
    if (Math.abs(lx - h.x) <= TL_KF_HIT_PX && Math.abs(ly - h.y) <= TL_KF_HIT_PX) return h;
  }
  return null;
}

/** 轻刷新：st/life 改动后同步时长显示、标尺、lane 区与预览。 */
export function refreshAllPanelsLight() {
  const maxEl = document.getElementById('tl-max');
  if (maxEl) maxEl.textContent = maxTick();
  if (typeof drawTimeline === 'function') drawTimeline();
  drawTimelineLayers();
  rebuildPoints(false);
}

export function tlInitLayerEvents() {
  const canvas = document.getElementById('tl-layers-canvas');
  if (!canvas) return;

  // HTML 标签轨滚动 → 同步 lane 画布
  const tree = document.getElementById('tl-tree');
  if (tree) {
    tree.addEventListener('scroll', () => {
      tlLayerState.scroll = tree.scrollTop || 0;
      drawTimelineLayers();
    });
  }

  canvas.addEventListener('pointerdown', ev => {
    const kfHit = hitKeyframeAt(ev.clientX, ev.clientY);
    if (kfHit) {
      pushUndo();
      canvas.setPointerCapture(ev.pointerId);
      tlLayerState.drag = { kind: 'kf', ...kfHit, startX: ev.clientX };
      return;
    }
    const res = tlLayerHitAt(ev.clientX, ev.clientY);
    if (!res) return;
    const { hit, zone } = res;
    pushUndo();
    canvas.setPointerCapture(ev.pointerId);
    const ptrTick = Math.round(timelineXToTickL(ev.clientX));
    if (hit.r.kind === 'group') {
      tlLayerState.drag = { kind: 'shift', r: hit.r, lastTick: ptrTick };
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
  });

  canvas.addEventListener('pointermove', ev => {
    const d = tlLayerState.drag;
    if (!d) {
      // 悬停光标反馈
      const res = tlLayerHitAt(ev.clientX, ev.clientY);
      canvas.style.cursor = res && res.zone !== 'body' ? 'ew-resize' : 'grab';
      return;
    }
    if (d.kind === 'kf') {
      const t = Math.max(0, Math.round(timelineXToTickL(ev.clientX)));
      if (t !== d.kf[0]) {
        d.kf[0] = t;
        if (d.tr) d.tr.kf.sort((a, b) => a[0] - b[0]);
        refreshAllPanelsLight();
      }
      return;
    }
    const ptrTick = timelineXToTickL(ev.clientX);
    if (d.kind === 'start') {
      setRowStart(d.r, Math.max(0, Math.round(ptrTick - d.grabOff)));
    } else if (d.kind === 'life') {
      setParticleLife(d.p, Math.max(1, Math.round(ptrTick - d.grabOff)));
    } else if (d.kind === 'fxdur') {
      d.fx.duration = Math.max(1, Math.round(ptrTick - d.grabOff));
    } else {
      const t = Math.round(ptrTick);
      const delta = t - d.lastTick;
      if (delta) { shiftGroup(d.r, delta); d.lastTick += delta; }
    }
    refreshAllPanelsLight();
  });

  const endDrag = () => { tlLayerState.drag = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // 双击寿命终点手柄：无限 ⇄ 有限（取双击处 tick 与 st 的距离）
  canvas.addEventListener('dblclick', ev => {
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
  });

  // 右键关键帧菱形 → 打开关键帧编辑器
  canvas.addEventListener('contextmenu', ev => {
    const kfHit = hitKeyframeAt(ev.clientX, ev.clientY);
    if (!kfHit) return;
    ev.preventDefault();
    openKeyframeEditor(canvas, kfHit.id, kfHit.pr, kfHit.tick);
  });

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