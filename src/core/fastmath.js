/* =========================================================================
 * 快速标量数学近似（仅 process 且 fx.fastMath 开启时使用）
 * -------------------------------------------------------------------------
 * 目标精度：
 *   - sin/cos/tan 最大绝对误差 ≤ 1e-4
 *   - asin/acos/atan/atan2/exp/log/ln/pow 相对误差 ≤ 1e-4
 * 跨端约束：Kotlin 端（ScriptFastMath.kt）必须用完全相同的公式与运算顺序，
 * 双精度 IEEE 754 运算下保证逐位一致。
 * 退化/越界输入（如负底数 pow、subnormal log）回退到精确实现。
 * ======================================================================= */

const PI = Math.PI;
const HALF_PI = Math.PI / 2;
const TWO_PI = Math.PI * 2;
const INV_TWO_PI = 0.15915494309189535;
const LN2 = Math.LN2;
const LOG2E = 1.4426950408889634;

/* ---- sin/cos：先把角度归约到 [-π, π]，再映射到 [0, π/2] 用泰勒多项式 ---- */

function reduceAngle(x) {
  return x - Math.floor(x * INV_TWO_PI + 0.5) * TWO_PI;
}

// sin(x) 在 [0, π/2] 的泰勒展开（到 x^13）。该区间内误差 < 1e-9。
function sinPoly(x) {
  const x2 = x * x;
  let p = 1.6059043836821613e-10;    // +1/13!
  p = p * x2 - 2.505210838544172e-8; // -1/11!
  p = p * x2 + 2.7557319223985893e-6; // +1/9!
  p = p * x2 - 0.00019841269841269841; // -1/7!
  p = p * x2 + 0.008333333333333333;  // +1/5!
  p = p * x2 - 0.16666666666666666;   // -1/3!
  p = p * x2 + 1.0;                   // +1/1!
  return p * x;
}

export function fastSin(x) {
  if (!Number.isFinite(x)) return Math.sin(x);
  let r = reduceAngle(x);
  let s = 1;
  if (r < 0) { r = -r; s = -1; }
  if (r > HALF_PI) r = PI - r;
  return s * sinPoly(r);
}

export function fastCos(x) {
  return fastSin(x + HALF_PI);
}

export function fastTan(x) {
  return fastSin(x) / fastCos(x);
}

/* ---- exp：x = n*ln2 + f，exp(x) = 2^n * exp(f) ---- */

// exp(y) 泰勒展开（到 y^7）；|y| ≤ ln2/2 时误差 < 1e-8。
function expTaylor(y) {
  let p = 1.0 / 5040;
  p = p * y + 1.0 / 720;
  p = p * y + 1.0 / 120;
  p = p * y + 1.0 / 24;
  p = p * y + 1.0 / 6;
  p = p * y + 0.5;
  p = p * y + 1.0;
  p = p * y + 1.0;
  return p;
}

// 共享缓冲：scalePow2 与 logParts 复用，避免每次调用分配对象。
const _bitsBuf = new ArrayBuffer(8);
const _bitsDv = new DataView(_bitsBuf);

function doubleToParts(x) {
  _bitsDv.setFloat64(0, x, false); // 显式大端序，跨平台一致
  return [_bitsDv.getUint32(0, false), _bitsDv.getUint32(4, false)];
}

function partsToDouble(hi, lo) {
  _bitsDv.setUint32(0, hi, false);
  _bitsDv.setUint32(4, lo, false);
  return _bitsDv.getFloat64(0, false);
}

// 把 x 乘以 2^n（整数）。指数溢出/下溢或 subnormal 时回退到 Math.pow。
function scalePow2(x, n) {
  if (!Number.isFinite(x) || x === 0 || n === 0) return x;
  const [hi, lo] = doubleToParts(x);
  let e = ((hi >>> 20) & 0x7ff);
  if (e === 0) return x * Math.pow(2, n); // subnormal / zero
  e += n;
  if (e <= 0 || e >= 0x7ff) return x * Math.pow(2, n);
  const newHi = (hi & 0x800fffff) | (e << 20);
  return partsToDouble(newHi, lo);
}

export function fastExp(x) {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return Infinity;
  if (x === -Infinity) return 0;
  const n = Math.floor(x * LOG2E + 0.5);
  const f = x - n * LN2;
  return scalePow2(expTaylor(f), n);
}

/* ---- log：把尾数归约到 [1,2)，用 atanh 级数求 log(mantissa) ---- */

// log(m) = 2*atanh(u)，u = (m-1)/(m+1)；m ∈ [1,2) → u ∈ [0, 1/3)。
function logMantissa(m) {
  const u = (m - 1) / (m + 1);
  const u2 = u * u;
  let p = 1.0 / 13;
  p = p * u2 + 1.0 / 11;
  p = p * u2 + 1.0 / 9;
  p = p * u2 + 1.0 / 7;
  p = p * u2 + 1.0 / 5;
  p = p * u2 + 1.0 / 3;
  p = p * u2 + 1.0;
  return 2 * u * p;
}

const MIN_NORMAL = 2.2250738585072014e-308;

export function fastLog(x) {
  if (!Number.isFinite(x) || x <= 0) return Math.log(x);
  if (x < MIN_NORMAL) return Math.log(x); // subnormal：极罕见，回退精确实现
  const [hi, lo] = doubleToParts(x);
  const e = ((hi >>> 20) & 0x7ff) - 1023;
  const mHi = (hi & 0x800fffff) | (1023 << 20);
  const m = partsToDouble(mHi, lo);
  return e * LN2 + logMantissa(m);
}

/* ---- pow：a > 0 时用 exp(b*log(a))；其余回退精确实现 ---- */

export function fastPow(a, b) {
  if (a > 0 && Number.isFinite(a) && Number.isFinite(b)) {
    if (b === 0) return 1;
    return fastExp(b * fastLog(a));
  }
  return Math.pow(a, b);
}

/* ---- atan / atan2 / asin / acos ---- */

// atan(u) 泰勒展开（到 u^9），|u| ≤ tan(pi/8) 时误差 < 2e-5。
function atanTaylor(u) {
  const u2 = u * u;
  let p = 1.0 / 9;
  p = p * u2 - 1.0 / 7;
  p = p * u2 + 1.0 / 5;
  p = p * u2 - 1.0 / 3;
  p = p * u2 + 1.0;
  return u * p;
}

// z ∈ [0,1]：用 u = z/(1+sqrt(1+z²)) 归约到 [0, tan(pi/8)]，atan(z)=2*atan(u)。
function atanPoly(z) {
  const u = z / (1 + Math.sqrt(1 + z * z));
  return 2 * atanTaylor(u);
}

export function fastAtan(x) {
  if (!Number.isFinite(x)) return Math.atan(x);
  const ax = Math.abs(x);
  if (ax > 1) {
    const r = atanPoly(1 / ax);
    return (x > 0 ? 1 : -1) * (HALF_PI - r);
  }
  const r = atanPoly(ax);
  return x >= 0 ? r : -r;
}

export function fastAtan2(y, x) {
  if (x > 0) return fastAtan(y / x);
  if (x < 0) {
    if (y >= 0) return fastAtan(y / x) + PI;
    return fastAtan(y / x) - PI;
  }
  // x == 0（含 NaN 由 fastAtan 回退时自然处理）
  if (y > 0) return HALF_PI;
  if (y < 0) return -HALF_PI;
  return 0;
}

export function fastAsin(x) {
  if (x > 1 || x < -1) return NaN;
  if (x === 1) return HALF_PI;
  if (x === -1) return -HALF_PI;
  return fastAtan(x / Math.sqrt(1 - x * x));
}

export function fastAcos(x) {
  return HALF_PI - fastAsin(x);
}

// 内建函数名 → 快速实现（供运行时按 fx.fastMath 分派）
export const FAST_MATH = {
  sin: fastSin,
  cos: fastCos,
  tan: fastTan,
  asin: fastAsin,
  acos: fastAcos,
  atan: fastAtan,
  atan2: fastAtan2,
  exp: fastExp,
  log: fastLog,
  ln: fastLog,
  pow: fastPow,
};