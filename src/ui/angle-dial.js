// 角度拨盘：DevTools 风格的角度控件。
// - dialSvg(deg, size)：小图标（圆 + 蓝色指针，0° 朝上、顺时针）。
// - createAngleControl({ value, onChange })：行内控件（图标+数值°），点击弹出大表盘精调。
// - openAngleDial / closeAngleDial / angleDialOpen：单例弹出表盘，拖动指针或数字输入设角（0..359）。

import { cssVar } from '../core/theme.js';

const normDeg = (v) => { const n = Math.round(Number(v)); return ((n % 360) + 360) % 360; };

export function dialSvg(deg, size = 16) {
  const a = normDeg(deg) * Math.PI / 180;
  const c = size / 2;
  const r = Math.max(1, size / 2 - 1.5);
  const x = (c + r * Math.sin(a)).toFixed(2);
  const y = (c - r * Math.cos(a)).toFixed(2);
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
    '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<line x1="' + c + '" y1="' + c + '" x2="' + x + '" y2="' + y + '" stroke="' + (cssVar('--accent', '#5b9dff').trim() || '#5b9dff') + '" stroke-width="1.6" stroke-linecap="round"/>' +
    '</svg>';
}

let dialPop = null;

export function angleDialOpen() { return !!dialPop && dialPop.isConnected; }

export function closeAngleDial() {
  if (!dialPop) return;
  const p = dialPop;
  dialPop = null;
  window.removeEventListener('keydown', p._onKey, true);
  document.removeEventListener('pointerdown', p._onOut, true);
  p.remove();
}

export function openAngleDial({ x, y, value, onInput }) {
  closeAngleDial();
  const pop = document.createElement('div');
  pop.className = 'angle-dial-pop';
  const canvas = document.createElement('canvas');
  pop.appendChild(canvas);
  const row = document.createElement('div');
  row.className = 'angle-dial-input';
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.min = '0';
  inp.max = '359';
  inp.step = '1';
  const unit = document.createElement('span');
  unit.textContent = '°';
  row.appendChild(inp);
  row.appendChild(unit);
  pop.appendChild(row);
  document.body.appendChild(pop);

  let val = normDeg(value == null ? 0 : value);
  const SIZE = 132;
  const R = 54;

  const draw = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    const cx = SIZE / 2, cy = SIZE / 2;
    const border = cssVar('--border', '#39414e').trim() || '#39414e';
    const muted = cssVar('--muted', '#8e98ac').trim() || '#8e98ac';
    const accent = cssVar('--accent', '#5b9dff').trim() || '#5b9dff';
    // 每 30° 刻度
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    for (let d = 0; d < 360; d += 30) {
      const a = d * Math.PI / 180;
      const x0 = cx + (R - 10) * Math.sin(a), y0 = cy - (R - 10) * Math.cos(a);
      const x1 = cx + R * Math.sin(a), y1 = cy - R * Math.cos(a);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    // 外圈
    ctx.strokeStyle = border;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    // 指针
    const a = val * Math.PI / 180;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + (R - 14) * Math.sin(a), cy - (R - 14) * Math.cos(a));
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();
    // 中心数值
    ctx.fillStyle = muted;
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(val + '°', cx, cy + R - 13);
    inp.value = String(val);
  };

  const setVal = (n) => {
    val = normDeg(n);
    draw();
    if (typeof onInput === 'function') onInput(val);
  };

  let dragging = false;
  const angleFrom = (ev) => {
    const r = canvas.getBoundingClientRect();
    const dx = ev.clientX - (r.left + r.width / 2);
    const dy = ev.clientY - (r.top + r.height / 2);
    return normDeg(Math.atan2(dx, -dy) * 180 / Math.PI);
  };
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    dragging = true;
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
    setVal(angleFrom(ev));
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (dragging) setVal(angleFrom(ev));
  });
  const endDrag = () => { dragging = false; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  inp.addEventListener('input', () => {
    const n = parseInt(inp.value, 10);
    if (Number.isFinite(n)) setVal(n);
  });

  pop._onKey = (ev) => {
    if (ev.key !== 'Escape') return;
    ev.stopPropagation();
    closeAngleDial();
  };
  pop._onOut = (ev) => {
    if (ev.target && pop.contains(ev.target)) return;
    closeAngleDial();
  };
  window.addEventListener('keydown', pop._onKey, true);
  document.addEventListener('pointerdown', pop._onOut, true);

  draw();
  // 定位到点击处，越界时向视口内收
  const pr = pop.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(x, window.innerWidth - pr.width - 8)) + 'px';
  pop.style.top = Math.max(8, Math.min(y, window.innerHeight - pr.height - 8)) + 'px';
  dialPop = pop;
}

export function createAngleControl({ value = 0, onChange }) {
  let val = normDeg(value);
  const host = document.createElement('button');
  host.type = 'button';
  host.className = 'angle-ctl';
  const icon = document.createElement('span');
  icon.className = 'angle-ctl-icon';
  const label = document.createElement('span');
  label.className = 'angle-ctl-val';
  const paint = () => {
    icon.innerHTML = dialSvg(val, 15);
    label.textContent = val + '°';
  };
  paint();
  host.appendChild(icon);
  host.appendChild(label);
  host.addEventListener('click', (ev) => {
    openAngleDial({
      x: ev.clientX, y: ev.clientY,
      value: val,
      onInput: (n) => {
        val = n;
        paint();
        if (typeof onChange === 'function') onChange(n);
      },
    });
  });
  return {
    host,
    setValue(n) {
      val = normDeg(n);
      paint();
    },
  };
}