/* =========================================================================
 * 缓动函数编辑器
 * ======================================================================= */


import { t } from '../core/i18n.js';
import { EASINGS, EASING_NONE } from '../core/constants.js';
import { easeVal, cubicBezierX, cubicBezierY } from '../core/easing.js';
import { refreshFunctionPanel } from './panels.js';
import { customSelect } from './select.js';
export function easingToBezier(easing) {
  if (easing === EASING_NONE) return null; // 无缓动不是贝塞尔，编辑器以阶跃曲线展示
  if (Array.isArray(easing)) return easing.slice(0, 4);
  const p = EASINGS[easing] || EASINGS[0];
  return [p[1], p[2], p[3], p[4]];
}

export function easingCurveSVG(easing) {
  const w = 28, h = 16;
  const ys = [];
  for (let i = 0; i <= 24; i++) ys.push(easeVal(i / 24, easing));
  let lo = Math.min(0, ...ys), hi = Math.max(1, ...ys);
  if (hi - lo < 1e-6) { lo -= 0.5; hi += 0.5; }
  let d = '';
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const x = t * w, yy = h - 1 - (ys[i] - lo) / (hi - lo) * (h - 2);
    d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + yy.toFixed(1);
  }
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${d}" fill="none" stroke="#5b9dff" stroke-width="1.6"/></svg>`;
}

export function makeEasingBtn(easing, applyFn) {
  const btn = document.createElement('button');
  btn.className = 'ease-btn';
  btn.innerHTML = easingCurveSVG(easing);
  btn.title = t('easing.editTitle');
  btn.onclick = (e) => { e.stopPropagation(); openEasingEditor(easing, applyFn, btn); };
  return btn;
}

export let easingEditor = null;

export function openEasingEditor(easing, applyFn, anchor) {
  closeEasingEditor();
  // 立即清掉仍在播放收起动画的旧弹窗，避免与新弹窗重叠
  document.querySelectorAll('#easing-editor.closing').forEach(e => e.remove());
  const isNone = easing === EASING_NONE;
  const bezier = easingToBezier(easing) || [0, 0, 0, 0];
  easingEditor = { bezier, apply: applyFn, anchor, dragging: -1, inputs: {}, none: isNone, inputsEl: null };
  const pop = document.createElement('div');
  pop.id = 'easing-editor';
  pop.className = 'easing-editor';
  const title = document.createElement('div');
  title.className = 'ee-title';
  title.textContent = t('easing.editorTitle');
  pop.appendChild(title);

  const inputs = document.createElement('div');
  inputs.className = 'ee-inputs';
  const mkRow = (label, idxX, idxY) => {
    const row = document.createElement('div');
    row.className = 'ee-input-row';
    const lab = document.createElement('span');
    lab.className = 'ee-input-label';
    lab.textContent = label;
    row.appendChild(lab);
    const mkInp = (idx) => {
      const isX = idx % 2 === 0;
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.step = '0.01';
      if (isX) { inp.min = '0'; inp.max = '1'; }
      else { inp.min = String(EE_Y_LO); inp.max = String(EE_Y_HI); }
      inp.value = bezier[idx].toFixed(3);
      inp.addEventListener('input', () => {
        let v = parseFloat(inp.value);
        if (!Number.isFinite(v)) v = 0;
        v = isX ? Math.min(1, Math.max(0, v)) : Math.min(EE_Y_HI, Math.max(EE_Y_LO, v));
        easingEditor.bezier[idx] = v;
        easingEditor.apply(easingEditor.bezier.slice());
        drawEasingEditor();
      });
      inp.addEventListener('change', () => { refreshFunctionPanel(); });
      easingEditor.inputs[idx] = inp;
      row.appendChild(inp);
    };
    mkInp(idxX); mkInp(idxY);
    return row;
  };
  inputs.appendChild(mkRow('P1', 0, 1));
  inputs.appendChild(mkRow('P2', 2, 3));
  pop.appendChild(inputs);
  easingEditor.inputsEl = inputs;
  if (isNone) inputs.style.display = 'none';

  const canvas = document.createElement('canvas');
  canvas.className = 'ee-canvas';
  canvas.width = EE_W; canvas.height = EE_H;
  pop.appendChild(canvas);
  const presetSel = document.createElement('select');
  presetSel.className = 'ee-presets';
  const opt0 = document.createElement('option');
  opt0.value = ''; opt0.textContent = t('easing.presets');
  presetSel.appendChild(opt0);
  const noneOpt = document.createElement('option');
  noneOpt.value = String(EASING_NONE); noneOpt.textContent = t('easing.none');
  presetSel.appendChild(noneOpt);
  for (let i = 0; i < EASINGS.length; i++) {
    const o = document.createElement('option');
    o.value = i; o.textContent = t(EASINGS[i][0]);
    presetSel.appendChild(o);
  }
  if (Number.isInteger(easing)) presetSel.value = String(easing); // 预设/无缓动下拉回显当前值
  presetSel.onchange = () => {
    if (presetSel.value === '') return;
    if (presetSel.value === String(EASING_NONE)) {
      easingEditor.none = true;
      if (easingEditor.inputsEl) easingEditor.inputsEl.style.display = 'none';
      easingEditor.apply(EASING_NONE);
    } else {
      easingEditor.none = false;
      if (easingEditor.inputsEl) easingEditor.inputsEl.style.display = '';
      const idx = parseInt(presetSel.value, 10);
      easingEditor.bezier = easingToBezier(idx);
      easingEditor.apply(idx);
      syncEasingInputs();
    }
    drawEasingEditor();
    refreshFunctionPanel();
  };
  pop.appendChild(presetSel);
  customSelect(presetSel);
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.min(r.left, window.innerWidth - 236) + 'px';
  const popH = pop.offsetHeight || 260;
  let top = r.bottom + 6;
  if (top + popH > window.innerHeight - 8) top = Math.max(8, r.top - popH - 6);
  pop.style.top = top + 'px';
  drawEasingEditor();
  canvas.addEventListener('pointerdown', onEasingPointerDown);
  canvas.addEventListener('pointermove', onEasingPointerMove);
  canvas.addEventListener('pointerup', () => { if (easingEditor) { easingEditor.dragging = -1; refreshFunctionPanel(); } });
  canvas.addEventListener('pointercancel', () => { if (easingEditor) easingEditor.dragging = -1; });
  setTimeout(() => document.addEventListener('pointerdown', onEasingDocPointerDown), 0);
}

export function syncEasingInputs() {
  if (!easingEditor || easingEditor.none) return;
  for (let i = 0; i < 4; i++) {
    const inp = easingEditor.inputs[i];
    if (inp && document.activeElement !== inp) inp.value = easingEditor.bezier[i].toFixed(3);
  }
}

export function onEasingDocPointerDown(e) {
  if (easingEditor && !e.target.closest('#easing-editor')) { closeEasingEditor(); refreshFunctionPanel(); }
}

export function closeEasingEditor() {
  easingEditor = null;
  document.removeEventListener('pointerdown', onEasingDocPointerDown);
  const pop = document.getElementById('easing-editor');
  if (!pop || pop.classList.contains('closing')) return;
  pop.classList.add('closing');
  setTimeout(() => pop.remove(), 160); // 等收起动画播完再移除
}

// 绘制区常量：方框 x∈[0,1]（几乎占满宽度），y∈[0,1] 允许溢出到 [EE_Y_LO, EE_Y_HI]
export const EE_W = 160;
export const EE_H = 160;
export const EE_MX = 8;
export const EE_Y_LO = -0.75;
export const EE_Y_HI = 1.75;
export const EE_BOX_W = EE_W - EE_MX * 2;
export const EE_BOX_H = EE_H / (EE_Y_HI - EE_Y_LO);

export function eePx(x) { return EE_MX + Math.min(1, Math.max(0, x)) * EE_BOX_W; }
export function eePy(y) { return (EE_Y_HI - y) * EE_BOX_H; }

export function drawEasingEditor() {
  const pop = document.getElementById('easing-editor');
  if (!pop || !easingEditor) return;
  const [x1, y1, x2, y2] = easingEditor.bezier;
  syncEasingInputs();
  const canvas = pop.querySelector('.ee-canvas');
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#171a20';
  ctx.fillRect(0, 0, w, h);

  // 方框 [0,1]×[0,1]（正方形）
  ctx.strokeStyle = '#323848';
  ctx.lineWidth = 1;
  ctx.strokeRect(EE_MX, eePy(1), EE_BOX_W, EE_BOX_H);
  // 中线参考线
  ctx.strokeStyle = '#252b36';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(EE_MX, eePy(0.5)); ctx.lineTo(EE_MX + EE_BOX_W, eePy(0.5));
  ctx.moveTo(EE_MX + EE_BOX_W / 2, eePy(1)); ctx.lineTo(EE_MX + EE_BOX_W / 2, eePy(0));
  ctx.stroke();
  ctx.setLineDash([]);

  if (easingEditor.none) {
    // 无缓动：阶跃曲线（0 保持到 x=1，再跳到 1）
    ctx.strokeStyle = '#5b9dff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(eePx(0), eePy(0));
    ctx.lineTo(eePx(1), eePy(0));
    ctx.lineTo(eePx(1), eePy(1));
    ctx.stroke();
    return;
  }

  // 曲线（y 超出 [0,1] 时延伸到方框外）
  ctx.strokeStyle = '#5b9dff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i <= 48; i++) {
    const t = i / 48;
    const bx = eePx(cubicBezierX(t, x1, x2));
    const by = eePy(cubicBezierY(t, y1, y2));
    if (i === 0) ctx.moveTo(bx, by); else ctx.lineTo(bx, by);
  }
  ctx.stroke();

  // 控制线（端点 → 控制点）
  ctx.strokeStyle = '#4a5568';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(eePx(0), eePy(0)); ctx.lineTo(eePx(x1), eePy(y1));
  ctx.moveTo(eePx(1), eePy(1)); ctx.lineTo(eePx(x2), eePy(y2));
  ctx.stroke();

  // 控制点球（可移出方框）
  drawPoint(ctx, eePx(x1), eePy(y1), '#ff6b6b');
  drawPoint(ctx, eePx(x2), eePy(y2), '#6ba7ff');
}

export function drawPoint(ctx, x, y, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

export function onEasingPointerDown(e) {
  if (!easingEditor || easingEditor.none) return;
  const canvas = document.getElementById('easing-editor').querySelector('.ee-canvas');
  const rect = canvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left - EE_MX) / EE_BOX_W;
  const my = EE_Y_HI - (e.clientY - rect.top) / EE_BOX_H;
  const [x1, y1, x2, y2] = easingEditor.bezier;
  const d1 = Math.hypot(mx - x1, my - y1);
  const d2 = Math.hypot(mx - x2, my - y2);
  easingEditor.dragging = d1 < d2 ? 0 : 1;
  canvas.setPointerCapture(e.pointerId);
}

export function onEasingPointerMove(e) {
  if (!easingEditor || easingEditor.none || easingEditor.dragging < 0) return;
  const canvas = document.getElementById('easing-editor').querySelector('.ee-canvas');
  const rect = canvas.getBoundingClientRect();
  let mx = (e.clientX - rect.left - EE_MX) / EE_BOX_W;
  let my = EE_Y_HI - (e.clientY - rect.top) / EE_BOX_H;
  mx = Math.min(1, Math.max(0, mx));
  my = Math.min(EE_Y_HI, Math.max(EE_Y_LO, my));
  const b = easingEditor.bezier;
  if (easingEditor.dragging === 0) { b[0] = mx; b[1] = my; }
  else { b[2] = mx; b[3] = my; }
  drawEasingEditor();
  easingEditor.apply(b.slice());
}
