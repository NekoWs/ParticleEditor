// 颜色类型纯函数：构造、分量访问/写入、RGB↔HSV 往返、color↔vec4 转换。无 Runtime 依赖。

import { vec3, vec4 } from './vec.js';

export const color = (r, g, b, a) => ({ t: 'color', r, g, b, a });
export const isColor = (v) => v != null && v.t === 'color';

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const isNum = (v) => typeof v === 'number';

function expectColor(c, name) {
  if (!isColor(c)) throw new Error(`${name} requires a color`);
  return c;
}

// x/y/z/w 是 r/g/b/a 的别名。
const COMP_KEY = { x: 'r', y: 'g', z: 'b', w: 'a', r: 'r', g: 'g', b: 'b', a: 'a' };

export function colorComponent(c, comp) {
  expectColor(c, 'component access');
  const k = COMP_KEY[comp];
  if (!k) throw new Error(`color has no component '${comp}'`);
  return c[k];
}

export function colorWithComponent(c, comp, value) {
  expectColor(c, 'component assignment');
  const k = COMP_KEY[comp];
  if (!k) throw new Error(`color has no component '${comp}'`);
  const out = color(c.r, c.g, c.b, c.a);
  out[k] = clamp01(value);
  return out;
}

export function colorFromVec(v) {
  if (v == null || (v.t !== 'vec3' && v.t !== 'vec4')) {
    throw new Error(`color conversion requires a vec3 or vec4, got ${v == null ? 'null' : v.t}`);
  }
  if (v.t === 'vec3') return color(clamp01(v.x), clamp01(v.y), clamp01(v.z), 1);
  return color(clamp01(v.x), clamp01(v.y), clamp01(v.z), clamp01(v.w));
}

export function colorToVec4(c) {
  expectColor(c, 'colorToVec4');
  return vec4(c.r, c.g, c.b, c.a);
}

// —— 分量 setter（纯函数，返回新 color） ——

export function red(c, v) {
  expectColor(c, 'red');
  if (!isNum(v)) throw new Error('red requires a num');
  return color(clamp01(v), c.g, c.b, c.a);
}
export function green(c, v) {
  expectColor(c, 'green');
  if (!isNum(v)) throw new Error('green requires a num');
  return color(c.r, clamp01(v), c.b, c.a);
}
export function blue(c, v) {
  expectColor(c, 'blue');
  if (!isNum(v)) throw new Error('blue requires a num');
  return color(c.r, c.g, clamp01(v), c.a);
}
export function alpha(c, v) {
  expectColor(c, 'alpha');
  if (!isNum(v)) throw new Error('alpha requires a num');
  return color(c.r, c.g, c.b, clamp01(v));
}

// —— HSV ——

export function rgb2hsv(c) {
  expectColor(c, 'rgb2hsv');
  const r = c.r, g = c.g, b = c.b;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d !== 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  const s = mx === 0 ? 0 : d / mx;
  return vec3(h, s, mx);
}

export function hsv2rgb(h, s, v) {
  let hh, ss, vv;
  if (s === undefined && v === undefined && h != null && h.t === 'vec3') {
    hh = h.x; ss = h.y; vv = h.z;
  } else {
    if (!isNum(h)) throw new Error('hsv2rgb requires 3 scalars or a vec3');
    if (!isNum(s) || !isNum(v)) throw new Error('hsv2rgb requires 3 scalars or a vec3');
    hh = h; ss = s; vv = v;
  }
  hh = hh - Math.floor(hh); // 循环 0..1
  ss = clamp01(ss);
  vv = clamp01(vv);
  const i = Math.floor(hh * 6);
  const f = hh * 6 - i;
  const p = vv * (1 - ss);
  const q = vv * (1 - f * ss);
  const t = vv * (1 - (1 - f) * ss);
  let r, g, b;
  switch (i % 6) {
    case 0: r = vv; g = t; b = p; break;
    case 1: r = q; g = vv; b = p; break;
    case 2: r = p; g = vv; b = t; break;
    case 3: r = p; g = q; b = vv; break;
    case 4: r = t; g = p; b = vv; break;
    default: r = vv; g = p; b = q; break;
  }
  return color(r, g, b, 1);
}

export function hue(c, h) {
  expectColor(c, 'hue');
  if (!isNum(h)) throw new Error('hue requires a num');
  const hsv = rgb2hsv(c);
  return hsv2rgb(h - Math.floor(h), hsv.y, hsv.z);
}

export function saturation(c, s) {
  expectColor(c, 'saturation');
  if (!isNum(s)) throw new Error('saturation requires a num');
  const hsv = rgb2hsv(c);
  return hsv2rgb(hsv.x, clamp01(s), hsv.z);
}

export function value(c, v) {
  expectColor(c, 'value');
  if (!isNum(v)) throw new Error('value requires a num');
  const hsv = rgb2hsv(c);
  return hsv2rgb(hsv.x, hsv.y, clamp01(v));
}