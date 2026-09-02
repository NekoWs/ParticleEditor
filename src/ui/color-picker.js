/* =========================================================================
 * 共享 canvas 取色器：SV 面板 + 色相条 + 右侧竖直透明度条 + 8 位 hex 输入框
 * 供拼图颜色块与主属性面板复用。自包含：首次调用时创建 canvas 与 hex input
 * 并挂到 document.body，所有交互由本模块处理。
 * ======================================================================= */

import { hexToRgba, rgbaToHex } from './ui.js';

const W = 200, H = 178;
const SV_X = 8, SV_Y = 8, SV_W = 118, SV_H = 118;
const HUE_X = 134, HUE_Y = 8, HUE_W = 12, HUE_H = 118;
const ALPHA_X = 154, ALPHA_Y = 8, ALPHA_W = 12, ALPHA_H = 118;
const SWATCH_X = 8, SWATCH_Y = 136, SWATCH_W = 34, SWATCH_H = 26;
const HEX_X = 50, HEX_Y = 136, HEX_W = 142, HEX_H = 26;

let canvas = null;
let ctx = null;
let hexInput = null;
let state = null;      // { rgba:[r,g,b,a], h,s,v, left, top, onInput, onClose }
let drag = null;

function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch (e) { return fallback; }
}
function theme() {
  return {
    panel2: cssVar('--panel-2', '#262a34'),
    border: cssVar('--border', '#323848'),
  };
}

function ensureDom() {
  if (canvas && hexInput) return;
  canvas = document.createElement('canvas');
  canvas.id = 'shared-color-picker';
  canvas.style.position = 'fixed';
  canvas.style.zIndex = '12000';
  canvas.style.display = 'none';
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  canvas.style.borderRadius = '8px';
  canvas.style.boxShadow = '0 8px 24px rgba(0,0,0,0.45)';
  document.body.appendChild(canvas);
  ctx = canvas.getContext('2d');

  hexInput = document.createElement('input');
  hexInput.type = 'text';
  hexInput.maxLength = 9;
  hexInput.spellcheck = false;
  hexInput.setAttribute('autocomplete', 'off');
  hexInput.className = 'pc-color-hex';
  hexInput.style.position = 'fixed';
  hexInput.style.zIndex = '12001';
  hexInput.style.display = 'none';
  document.body.appendChild(hexInput);

  canvas.addEventListener('pointerdown', onDown);
  hexInput.addEventListener('input', onHexInput);
  hexInput.addEventListener('blur', () => { if (state) hexInput.value = hexString(); });
  hexInput.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') { ev.preventDefault(); hexInput.blur(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); closeColorPicker(); }
  });
  hexInput.addEventListener('focus', () => { drag = null; });
  document.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function rgbToHsv(rgb) {
  const r = rgb[0], g = rgb[1], b = rgb[2];
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}
function hsvToRgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  return [r + m, g + m, b + m];
}

function hexString() {
  if (!state) return '#ffffffff';
  return rgbaToHex(state.rgba[0], state.rgba[1], state.rgba[2], state.rgba[3]);
}

function emit(commit) {
  if (!state) return;
  if (state.onInput) state.onInput(state.rgba.slice());
  if (commit) draw();
}

function drawCheckerboard(c, x, y, w, h, size) {
  const s = size || 6;
  c.save();
  c.beginPath();
  c.rect(x, y, w, h);
  c.clip();
  c.fillStyle = '#e8ecf4';
  c.fillRect(x, y, w, h);
  c.fillStyle = '#9aa3b5';
  for (let gy = y; gy < y + h; gy += s) {
    for (let gx = x; gx < x + w; gx += s) {
      if (((gx - x) / s + (gy - y) / s) % 2 < 1) continue;
      c.fillRect(gx, gy, Math.min(s, x + w - gx), Math.min(s, y + h - gy));
    }
  }
  c.restore();
}

function draw() {
  if (!ctx || !canvas || !state) return;
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = theme().panel2;
  ctx.fillRect(0, 0, W, H);

  const [r, g, b] = hsvToRgb(state.h, state.s, state.v);

  // SV 方块
  const hueCss = 'hsl(' + state.h + ',100%,50%)';
  const g1 = ctx.createLinearGradient(SV_X, SV_Y, SV_X + SV_W, SV_Y);
  g1.addColorStop(0, '#ffffff'); g1.addColorStop(1, hueCss);
  ctx.fillStyle = g1;
  ctx.fillRect(SV_X, SV_Y, SV_W, SV_H);
  const g2 = ctx.createLinearGradient(SV_X, SV_Y, SV_X, SV_Y + SV_H);
  g2.addColorStop(0, 'rgba(0,0,0,0)'); g2.addColorStop(1, '#000000');
  ctx.fillStyle = g2;
  ctx.fillRect(SV_X, SV_Y, SV_W, SV_H);
  const sx = SV_X + state.s * SV_W;
  const sy = SV_Y + (1 - state.v) * SV_H;
  ctx.beginPath(); ctx.arc(sx, sy, 5, 0, Math.PI * 2);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
  ctx.beginPath(); ctx.arc(sx, sy, 2.5, 0, Math.PI * 2);
  ctx.strokeStyle = '#111'; ctx.lineWidth = 1; ctx.stroke();

  // 色相条（竖直）
  const hg = ctx.createLinearGradient(HUE_X, HUE_Y, HUE_X, HUE_Y + HUE_H);
  hg.addColorStop(0, '#f00'); hg.addColorStop(0.17, '#ff0'); hg.addColorStop(0.34, '#0f0');
  hg.addColorStop(0.5, '#0ff'); hg.addColorStop(0.67, '#00f'); hg.addColorStop(0.84, '#f0f'); hg.addColorStop(1, '#f00');
  ctx.fillStyle = hg;
  ctx.fillRect(HUE_X, HUE_Y, HUE_W, HUE_H);
  const hy = HUE_Y + (state.h / 360) * HUE_H;
  ctx.fillStyle = '#fff';
  ctx.fillRect(HUE_X - 2, hy - 1, HUE_W + 4, 3);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1;
  ctx.strokeRect(HUE_X - 2, hy - 1, HUE_W + 4, 3);

  // 透明度条（竖直，右侧）
  drawCheckerboard(ctx, ALPHA_X, ALPHA_Y, ALPHA_W, ALPHA_H, 5);
  const ag = ctx.createLinearGradient(ALPHA_X, ALPHA_Y, ALPHA_X, ALPHA_Y + ALPHA_H);
  ag.addColorStop(0, 'rgba(' + Math.round(r * 255) + ',' + Math.round(g * 255) + ',' + Math.round(b * 255) + ',1)');
  ag.addColorStop(1, 'rgba(' + Math.round(r * 255) + ',' + Math.round(g * 255) + ',' + Math.round(b * 255) + ',0)');
  ctx.fillStyle = ag;
  ctx.fillRect(ALPHA_X, ALPHA_Y, ALPHA_W, ALPHA_H);
  const ay = ALPHA_Y + (1 - state.rgba[3]) * ALPHA_H;
  ctx.fillStyle = '#fff';
  ctx.fillRect(ALPHA_X - 2, ay - 1, ALPHA_W + 4, 3);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.strokeRect(ALPHA_X - 2, ay - 1, ALPHA_W + 4, 3);

  // 色块（含透明度棋盘格）
  drawCheckerboard(ctx, SWATCH_X, SWATCH_Y, SWATCH_W, SWATCH_H, 5);
  ctx.fillStyle = 'rgba(' + Math.round(r * 255) + ',' + Math.round(g * 255) + ',' + Math.round(b * 255) + ',' + state.rgba[3] + ')';
  ctx.fillRect(SWATCH_X, SWATCH_Y, SWATCH_W, SWATCH_H);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1;
  ctx.strokeRect(SWATCH_X, SWATCH_Y, SWATCH_W, SWATCH_H);

  // hex 输入框背景
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(HEX_X, HEX_Y, HEX_W, HEX_H, 4);
  else ctx.rect(HEX_X, HEX_Y, HEX_W, HEX_H);
  ctx.fill();

  // 外框
  ctx.strokeStyle = theme().border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(0.5, 0.5, W - 1, H - 1, 8);
  else ctx.rect(0.5, 0.5, W - 1, H - 1);
  ctx.stroke();
}

function position() {
  if (!canvas || !state) return;
  const vw = window.innerWidth || 1200;
  const vh = window.innerHeight || 800;
  const left = Math.max(8, Math.min(state.left, vw - W - 8));
  const top = Math.max(8, Math.min(state.top, vh - H - 8));
  state.left = left;
  state.top = top;
  canvas.style.left = left + 'px';
  canvas.style.top = top + 'px';
  hexInput.style.left = (left + HEX_X) + 'px';
  hexInput.style.top = (top + HEX_Y) + 'px';
  hexInput.style.width = HEX_W + 'px';
  hexInput.style.height = HEX_H + 'px';
}

export function openColorPicker({ x, y, rgba, onInput, onClose }) {
  ensureDom();
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  canvas.width = Math.max(1, Math.round(W * dpr));
  canvas.height = Math.max(1, Math.round(H * dpr));
  const [r, g, b, a] = rgba || [1, 1, 1, 1];
  const hsv = rgbToHsv([r, g, b]);
  state = { rgba: [r, g, b, a == null ? 1 : a], h: hsv[0], s: hsv[1], v: hsv[2], left: x, top: y, onInput, onClose };
  drag = null;
  canvas.style.display = 'block';
  hexInput.style.display = 'block';
  hexInput.value = hexString();
  position();
  draw();
}

export function closeColorPicker() {
  if (!state) return;
  const cb = state.onClose;
  state = null;
  drag = null;
  if (canvas) canvas.style.display = 'none';
  if (hexInput) hexInput.style.display = 'none';
  if (cb) cb();
}

function localPoint(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function onDown(e) {
  if (!state) return;
  e.preventDefault();
  e.stopPropagation();
  const p = localPoint(e);
  if (p.x >= SV_X && p.x <= SV_X + SV_W && p.y >= SV_Y && p.y <= SV_Y + SV_H) { drag = 'sv'; updateDrag(e); return; }
  if (p.x >= HUE_X - 3 && p.x <= HUE_X + HUE_W + 3 && p.y >= HUE_Y && p.y <= HUE_Y + HUE_H) { drag = 'hue'; updateDrag(e); return; }
  if (p.x >= ALPHA_X - 3 && p.x <= ALPHA_X + ALPHA_W + 3 && p.y >= ALPHA_Y && p.y <= ALPHA_Y + ALPHA_H) { drag = 'alpha'; updateDrag(e); return; }
}

function onMove(e) {
  if (drag) { e.preventDefault(); updateDrag(e); }
}
function onUp() { drag = null; }

function updateDrag(e) {
  if (!state || !drag) return;
  const p = localPoint(e);
  if (drag === 'sv') {
    state.s = Math.max(0, Math.min(1, (p.x - SV_X) / SV_W));
    state.v = 1 - Math.max(0, Math.min(1, (p.y - SV_Y) / SV_H));
  } else if (drag === 'hue') {
    state.h = Math.max(0, Math.min(360, (p.y - HUE_Y) / HUE_H * 360));
  } else if (drag === 'alpha') {
    state.rgba[3] = 1 - Math.max(0, Math.min(1, (p.y - ALPHA_Y) / ALPHA_H));
  }
  const [r, g, b] = hsvToRgb(state.h, state.s, state.v);
  state.rgba[0] = r; state.rgba[1] = g; state.rgba[2] = b;
  hexInput.value = hexString();
  emit(false);
}

function onHexInput() {
  if (!state) return;
  const v = hexInput.value.trim();
  const rgba = hexToRgba(v);
  if (!rgba) return;
  const hsv = rgbToHsv([rgba[0], rgba[1], rgba[2]]);
  state.h = hsv[0]; state.s = hsv[1]; state.v = hsv[2];
  state.rgba = rgba;
  emit(true);
}

function onOutside(e) {
  if (!state) return;
  if (canvas && (e.target === canvas || canvas.contains(e.target))) return;
  if (hexInput && (e.target === hexInput || hexInput.contains(e.target))) return;
  closeColorPicker();
}