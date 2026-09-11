// PS 式渐变条：下方色条（canvas，透明处棋盘格），上方外置色标——方形色块 + 指向
// 精确位置的三角箭头；中间色同样样式。交互：点击色条空白添加色标（颜色取该处插值）、
// 拖动色块移动、双击删除；右键色标弹出菜单（编辑颜色 / 删除色标，剩 2 个时删除禁用）。
// 选中色标高亮，颜色由宿主（预设窗口）用取色器编辑。状态变更/选中通过回调上报。

import { t } from '../core/i18n.js';
import { cssVar } from '../core/theme.js';

const STOP_HALF_W = 9;    // 色标命中/拖动半宽（CSS px）
const BAR_PAD = 10;      // 色条左右内边距：端点色块不被截断

// 硬钳制：非数值分量回退为默认（1 视为不透明），避免 NaN 写进 rgba 导致色条漏出棋盘格。
function clamp01(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}

function normalize(stops) {
  const raw = Array.isArray(stops) ? stops : [];
  const out = raw
    .filter((s) => s && Number.isFinite(Number(s.pos)))
    .map((s) => ({
      pos: clamp01(Number(s.pos)),
      color: [0, 1, 2, 3].map((i) => clamp01((s.color || [])[i])),
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

const cssRgba = (c) => 'rgba(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' +
  Math.round(c[2] * 255) + ',' + c[3] + ')';

export function createGradientBar({ stops, onChange, onSelect, onEditColor }) {
  const host = document.createElement('div');
  host.className = 'gbar';
  const canvas = document.createElement('canvas');
  canvas.className = 'gbar-canvas';
  host.appendChild(canvas);
  const layer = document.createElement('div');
  layer.className = 'gbar-stops';
  host.appendChild(layer);
  const ctx = canvas.getContext('2d');

  let state = normalize(stops);
  let sel = 0;
  let drag = null; // { idx, moved }
  let menuEl = null;

  const api = {
    host,
    getStops() { return snapshot(state); },
    setStops(next) {
      state = normalize(next);
      if (sel >= state.length) sel = state.length - 1;
      renderAll();
      fireChange();
    },
    selectedIndex() { return sel; },
    setSelectedColor(rgba) {
      const s = state[sel];
      if (!s) return;
      s.color = [0, 1, 2, 3].map((i) => clamp01(rgba[i]));
      renderAll();
      fireChange();
    },
    setColorAt(i, rgba) {
      const s = state[i];
      if (!s) return;
      s.color = [0, 1, 2, 3].map((i) => clamp01(rgba[i]));
      renderAll();
      fireChange();
    },
    removeSelected() {
      if (state.length <= 2) return;
      state.splice(sel, 1);
      sel = Math.max(0, Math.min(sel, state.length - 1));
      renderAll();
      fireSelect();
      fireChange();
    },
    removeAt(i) {
      if (state.length <= 2 || i < 0 || i >= state.length) return;
      state.splice(i, 1);
      sel = Math.max(0, Math.min(sel, state.length - 1));
      renderAll();
      fireSelect();
      fireChange();
    },
  };
  host.__gbar = api;

  function fireChange() {
    if (typeof onChange === 'function') onChange(snapshot(state));
  }
  function fireSelect() { if (typeof onSelect === 'function') onSelect(sel); }

  // —— 色条绘制 ——
  // 色条左右各留 BAR_PAD 给端点色标，渐变区 [BAR_PAD, w-BAR_PAD]，span = w-2*BAR_PAD
  const spanOf = (w) => Math.max(7, w - BAR_PAD * 2);
  function drawBar() {
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
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 6);
    ctx.clip();
    // 透明棋盘格
    const cs = 6;
    for (let y = 0; y < h; y += cs) {
      for (let x = 0; x < w; x += cs) {
        ctx.fillStyle = ((x / cs + y / cs) & 1) ? '#8d95a3' : '#5d6470';
        ctx.fillRect(x, y, cs, cs);
      }
    }
    // 渐变：画布原生线性插值（含透明度），颜色区与指示层坐标一致
    const span = spanOf(w);
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    for (const s of state) {
      grad.addColorStop(Math.max(0, Math.min(1, (BAR_PAD + s.pos * (span - 1)) / w)), cssRgba(s.color));
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  // —— 外置色标（方形色块 + 三角箭头） ——
  function renderIndicators() {
    layer.textContent = '';
    let accent = '#5b9dff';
    try { accent = cssVar('--accent', '#5b9dff').trim() || accent; } catch (e) { /* 用默认 */ }
    state.forEach((s, i) => {
      const el = document.createElement('div');
      el.className = 'gbar-stop' + (i === sel ? ' sel' : '');
      // 指示层左缘 = 色条渐变区起点（BAR_PAD），像素映射保证箭头精确指到色标位置
      el.style.left = (s.pos * (spanOf(canvas.clientWidth) - 1)) + 'px';
      const chip = document.createElement('div');
      chip.className = 'gbar-stop-chip';
      chip.style.background = cssRgba(s.color);
      if (i === sel) chip.style.boxShadow = '0 0 0 2px ' + accent;
      const arrow = document.createElement('div');
      arrow.className = 'gbar-stop-arrow';
      arrow.style.borderTopColor = cssRgba([s.color[0], s.color[1], s.color[2], 1]);
      el.appendChild(chip);
      el.appendChild(arrow);
      layer.appendChild(el);
    });
  }

  function renderAll() {
    drawBar();
    renderIndicators();
    host.dataset.stopCount = String(state.length);
    host.dataset.stops = JSON.stringify(state.map((s) => [s.pos, ...s.color]));
  }

  // —— 命中/拖动/点击 ——
  function posFromX(clientX) {
    const r = canvas.getBoundingClientRect();
    const span = spanOf(r.width);
    return clamp01((clientX - r.left - BAR_PAD) / Math.max(1, span - 1));
  }
  function hitStop(clientX, clientY) {
    const barRect = canvas.getBoundingClientRect();
    for (let i = state.length - 1; i >= 0; i--) {
      const el = layer.children[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      // 命中色块或箭头附近（箭头向下伸入色条上方）
      if (clientX >= r.left - STOP_HALF_W && clientX <= r.right + STOP_HALF_W &&
        clientY >= r.top - 4 && clientY <= barRect.top + 6) return i;
    }
    return -1;
  }

  host.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const idx = hitStop(ev.clientX, ev.clientY);
    if (idx >= 0) {
      ev.preventDefault();
      sel = idx;
      fireSelect();
      renderAll();
      drag = { idx };
      // 捕获在 host 上：拖动期间指示层会重建 DOM，捕获到子元素会随重建丢失，
      // 导致在区域外松开后 drag 残留（再次悬停就像按着鼠标拖动）。
      try { host.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
      return;
    }
    // 点击色条空白处添加色标（颜色取该处插值），随后可直接拖动
    const barRect = canvas.getBoundingClientRect();
    if (ev.clientY >= barRect.top - 2 && ev.clientY <= barRect.bottom + 2 && ev.detail <= 1) {
      ev.preventDefault();
      const t = posFromX(ev.clientX);
      const added = { pos: t, color: sampleAt(state, t) };
      state.push(added);
      state.sort((a, b) => a.pos - b.pos);
      sel = state.indexOf(added);
      fireSelect();
      renderAll();
      fireChange();
      drag = { idx: sel };
      try { host.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
    }
  });

  host.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    ev.preventDefault();
    const t = posFromX(ev.clientX);
    const np = clamp01(t);
    const moved = state[drag.idx];
    if (!moved) return;
    if (Math.abs(np - moved.pos) > 0.0005) {
      moved.pos = np;
      // 允许越过相邻色标：按位置重排，拖动的色标跟随指针换位（PS 行为）
      state.sort((a, b) => a.pos - b.pos);
      drag.idx = state.indexOf(moved);
      sel = drag.idx;
    }
    renderAll();
    fireChange();
  });

  const endDrag = () => {
    if (!drag) return;
    drag = null;
    renderAll();
    fireChange();
  };
  host.addEventListener('pointerup', endDrag);
  host.addEventListener('pointercancel', endDrag);
  host.addEventListener('lostpointercapture', endDrag);

  host.addEventListener('dblclick', (ev) => {
    const idx = hitStop(ev.clientX, ev.clientY);
    if (idx < 0 || state.length <= 2) return;
    ev.preventDefault();
    state.splice(idx, 1);
    sel = Math.max(0, Math.min(sel, state.length - 1));
    renderAll();
    fireSelect();
    fireChange();
  });

  // —— 右键菜单：编辑颜色 / 删除色标 ——
  function closeMenu() {
    if (menuEl) { menuEl.remove(); menuEl = null; }
    document.removeEventListener('pointerdown', onOutMenu, true);
    window.removeEventListener('keydown', onKeyMenu, true);
  }
  function onOutMenu(ev) {
    if (menuEl && ev.target && menuEl.contains(ev.target)) return;
    closeMenu();
  }
  function onKeyMenu(ev) {
    if (ev.key === 'Escape') { ev.stopPropagation(); closeMenu(); }
  }
  host.addEventListener('contextmenu', (ev) => {
    const idx = hitStop(ev.clientX, ev.clientY);
    if (idx < 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'gbar-menu';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'gbar-menu-item';
    edit.textContent = t('preset.gbar.editColor');
    edit.addEventListener('click', () => {
      closeMenu();
      sel = idx;
      fireSelect();
      renderAll();
      if (typeof onEditColor === 'function') onEditColor(idx, ev.clientX, ev.clientY);
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'gbar-menu-item';
    del.textContent = t('preset.gbar.delete');
    del.disabled = state.length <= 2;
    del.addEventListener('click', () => {
      closeMenu();
      api.removeAt(idx);
    });
    menu.appendChild(edit);
    menu.appendChild(del);
    document.body.appendChild(menu);
    const mr = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(ev.clientX, window.innerWidth - mr.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(ev.clientY, window.innerHeight - mr.height - 8)) + 'px';
    menuEl = menu;
    document.addEventListener('pointerdown', onOutMenu, true);
    window.addEventListener('keydown', onKeyMenu, true);
  });

  const obs = new ResizeObserver(renderAll);
  obs.observe(host);
  host.__gbarObs = obs;

  renderAll();
  return api;
}