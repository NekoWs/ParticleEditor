// PS 式渐变条：canvas 绘制带透明棋盘格的渐变色条与色标。
// 交互：点击色条空白处添加色标（颜色取该处插值）、拖动色标移动、双击色标删除；
// 选中色标高亮，颜色由宿主（预设窗口）用取色器编辑。状态变更/选中通过回调上报。

import { cssVar } from '../core/theme.js';

const STOP_HALF_W = 7;   // 色标命中/绘制半宽（CSS px）
const MIN_GAP = 0.002;   // 相邻色标最小间距（防止完全重叠后无法选中）

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function normalize(stops) {
  const raw = Array.isArray(stops) ? stops : [];
  const out = raw
    .filter((s) => s && Number.isFinite(Number(s.pos)))
    .map((s) => ({
      pos: clamp01(Number(s.pos)),
      color: [0, 1, 2, 3].map((i) => clamp01(Number((s.color || [])[i]))),
    }));
  out.sort((a, b) => a.pos - b.pos);
  if (out.length < 2) {
    out.length = 0;
    out.push({ pos: 0, color: [1, 1, 1, 1] }, { pos: 1, color: [1, 1, 1, 1] });
  }
  return out;
}

function snapshot(state) { return state.map((s) => ({ pos: s.pos, color: s.color.slice() })); }

// 位置 t（0..1）处的插值颜色
function sampleAt(state, t) {
  if (t <= state[0].pos) return state[0].color.slice();
  for (let i = 0; i < state.length - 1; i++) {
    const a = state[i], b = state[i + 1];
    if (t < b.pos) {
      const s = Math.max(0, Math.min(1, (t - a.pos) / Math.max(1e-4, b.pos - a.pos)));
      return [0, 1, 2, 3].map((k) => a.color[k] + (b.color[k] - a.color[k]) * s);
    }
  }
  return state[state.length - 1].color.slice();
}

export function createGradientBar({ stops, onChange, onSelect }) {
  const host = document.createElement('div');
  host.className = 'gbar';
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let state = normalize(stops);
  let sel = 0;
  let drag = null; // { idx, moved }
  let accent = '#5b9dff';

  const api = {
    host,
    getStops() { return snapshot(state); },
    setStops(next) {
      state = normalize(next);
      if (sel >= state.length) sel = state.length - 1;
      redraw();
      fireChange();
    },
    selectedIndex() { return sel; },
    setSelectedColor(rgba) {
      const s = state[sel];
      if (!s) return;
      s.color = [0, 1, 2, 3].map((i) => clamp01(Number(rgba[i])));
      redraw();
      fireChange();
    },
    removeSelected() {
      if (state.length <= 2) return;
      state.splice(sel, 1);
      sel = Math.max(0, Math.min(sel, state.length - 1));
      redraw();
      fireSelect();
      fireChange();
    },
  };
  host.__gbar = api;

  function fireChange() {
    if (typeof onChange === 'function') onChange(snapshot(state));
  }
  function fireSelect() { if (typeof onSelect === 'function') onSelect(sel); }

  function redraw() {
    const w = Math.max(2, Math.round(canvas.clientWidth));
    const h = Math.max(2, Math.round(canvas.clientHeight));
    if (canvas.width !== w || canvas.height !== h) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const dpr = canvas.width / w;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    host.dataset.stopCount = String(state.length);
    host.dataset.stops = JSON.stringify(state.map((s) => [s.pos, ...s.color]));

    // 圆角裁剪
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 7);
    ctx.clip();

    // 透明棋盘格
    const cs = 6;
    for (let y = 0; y < h; y += cs) {
      for (let x = 0; x < w; x += cs) {
        ctx.fillStyle = ((x / cs + y / cs) & 1) ? '#8d95a3' : '#5d6470';
        ctx.fillRect(x, y, cs, cs);
      }
    }

    // 渐变（逐列采样，色标可任意数量）
    for (let x = 0; x < w; x++) {
      const c = sampleAt(state, x / Math.max(1, w - 1));
      ctx.fillStyle = 'rgba(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' +
        Math.round(c[2] * 255) + ',' + c[3] + ')';
      ctx.fillRect(x, 0, 1, h);
    }
    ctx.restore();

    // 色标
    try { accent = cssVar('--accent', '#5b9dff').trim() || '#5b9dff'; } catch (e) { /* 保持默认 */ }
    state.forEach((s, i) => {
      const x = Math.round(s.pos * (w - 1));
      const markW = STOP_HALF_W * 2;
      const markH = h - 4;
      ctx.fillStyle = 'rgba(' + Math.round(s.color[0] * 255) + ',' + Math.round(s.color[1] * 255) + ',' +
        Math.round(s.color[2] * 255) + ',' + s.color[3] + ')';
      ctx.beginPath();
      ctx.roundRect(x - STOP_HALF_W, 2, markW, markH, 4);
      ctx.fill();
      if (i === sel) {
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2.5;
        ctx.shadowColor = accent;
        ctx.shadowBlur = 5;
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.lineWidth = 1.6;
        ctx.shadowBlur = 0;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    });
  }

  function hitStop(x, y) {
    if (y < -3 || y > canvas.clientHeight + 3) return -1;
    const w = Math.max(1, canvas.clientWidth);
    for (let i = state.length - 1; i >= 0; i--) {
      const sx = state[i].pos * (w - 1);
      if (Math.abs(x - sx) <= STOP_HALF_W + 2) return i;
    }
    return -1;
  }

  host.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const idx = hitStop(x, y);
    if (idx >= 0) {
      sel = idx;
      fireSelect();
      redraw();
      drag = { idx, moved: false };
    } else if (y >= -3 && y <= rect.height + 3 && ev.detail <= 1) {
      // 点击空白处：添加色标（颜色取该处插值），随后可直接拖动
      const t = clamp01(x / Math.max(1, rect.width - 1));
      state.push({ pos: t, color: sampleAt(state, t) });
      state.sort((a, b) => a.pos - b.pos);
      sel = state.findIndex((s) => s.pos === t);
      fireSelect();
      redraw();
      fireChange();
      drag = { idx: sel, moved: false };
    } else {
      return;
    }
    try { host.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
  });

  host.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    ev.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const t = clamp01((ev.clientX - rect.left) / Math.max(1, rect.width - 1));
    let lo = 0, hi = 1;
    if (drag.idx > 0) lo = state[drag.idx - 1].pos + MIN_GAP;
    if (drag.idx < state.length - 1) hi = state[drag.idx + 1].pos - MIN_GAP;
    if (hi < lo) { lo = 0; hi = 1; }
    const np = Math.max(lo, Math.min(hi, t));
    if (Math.abs(np - state[drag.idx].pos) > 0.0005) drag.moved = true;
    state[drag.idx].pos = np;
    redraw();
    fireChange();
  });

  const endDrag = () => {
    if (!drag) return;
    drag = null;
    redraw();
    fireChange();
  };
  host.addEventListener('pointerup', endDrag);
  host.addEventListener('pointercancel', endDrag);

  host.addEventListener('dblclick', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const idx = hitStop(ev.clientX - rect.left, ev.clientY - rect.top);
    if (idx < 0 || state.length <= 2) return;
    ev.preventDefault();
    state.splice(idx, 1);
    sel = Math.max(0, Math.min(sel, state.length - 1));
    redraw();
    fireSelect();
    fireChange();
  });

  const obs = new ResizeObserver(redraw);
  obs.observe(host);
  host.__gbarObs = obs;

  redraw();
  return api;
}