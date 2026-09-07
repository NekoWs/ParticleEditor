// 缓动求值与变量关键帧插值。
// 旧迷你表达式引擎已移除，表达式求值统一走 script-lang.js。

import { EASINGS } from './constants.js';
import { EASING_NONE } from './easing-constants.js';

export function cubicBezierX(t, x1, x2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  return ((ax * t + bx) * t + cx) * t;
}
export function cubicBezierY(t, y1, y2) {
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  return ((ay * t + by) * t + cy) * t;
}
export function cubicBezier(t, x1, y1, x2, y2) {
  if (x1 === y1 && x2 === y2) return t; // 对角贝塞尔（含 LINEAR）即线性，避免牛顿迭代浮点误差
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const dxFor = s => (3 * ax * s + 2 * bx) * s + cx;
  let s = t;
  for (let i = 0; i < 8; i++) { const e = cubicBezierX(s, x1, x2) - t; if (Math.abs(e) < 1e-6) break; s -= e / dxFor(s); }
  return cubicBezierY(s, y1, y2);
}

export const EASE_CACHE_Q = 1000; // t 量化精度（1/1000，视觉无感，用于缓存去重）
export const easeCache = [];     // easing → 长度 EASE_CACHE_Q+1 的数组，惰性分配
export function easeVal(t, easing) {
  const t1 = t < 0 ? 0 : (t > 1 ? 1 : t);
  if (easing === EASING_NONE) return t1 >= 1 ? 1 : 0; // 无缓动：阶跃（保持到下一关键帧）
  if (Array.isArray(easing)) return cubicBezier(t1, easing[0], easing[1], easing[2], easing[3]);
  const p = EASINGS[easing] || EASINGS[0];
  // LINEAR：x1==y1 && x2==y2（对角贝塞尔），直接返回 t，跳过牛顿迭代
  if (p[1] === 0 && p[2] === 0 && p[3] === 1 && p[4] === 1) return t1;
  let cache = easeCache[easing];
  if (!cache) { cache = new Array(EASE_CACHE_Q + 1).fill(-1); easeCache[easing] = cache; }
  const q = (t1 * EASE_CACHE_Q) | 0;
  let v = cache[q];
  if (v === -1) { v = cubicBezier(t1, p[1], p[2], p[3], p[4]); cache[q] = v; }
  return v;
}

export function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

// 变量关键帧插值（kf: [tick, value, easing]，value 为标量）
export function varKfValue(kf, t) {
  if (!kf || kf.length === 0) return 0;
  if (t <= kf[0][0]) return kf[0][1];
  if (t >= kf[kf.length - 1][0]) return kf[kf.length - 1][1];
  for (let i = 0; i < kf.length - 1; i++) {
    const a = kf[i], b = kf[i + 1];
    if (t >= a[0] && t <= b[0]) {
      const dur = b[0] - a[0];
      return a[1] + (b[1] - a[1]) * easeVal(dur === 0 ? 1 : (t - a[0]) / dur, b[2]);
    }
  }
  return kf[kf.length - 1][1];
}