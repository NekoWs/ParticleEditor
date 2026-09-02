/* =========================================================================
 * 缓动求值与迷你表达式引擎
 * 职责：
 *   1) 贝塞尔缓动求值（cubicBezier / easeVal / easeInOut）
 *   2) 标量/向量/矩阵表达式求值（tokenize / compileExpr / execRpn / evaluate）
 * ======================================================================= */


import { _et, _etf } from './i18n.js';
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

/* =========================================================================
 * 迷你表达式求值器（标量 / 向量 vec3 / 矩阵 mat3）
 * ======================================================================= */

// —— 值类型标记 ——
export function isVec(v) { return v != null && v.__v === 3; }
export function isMat(v) { return v != null && v.__m === 3; }
export function vec3(x, y, z) { return { __v: 3, x, y, z }; }
export function mat3(m) { return { __m: 3, m }; }

export const FUNCS = {
  sin: 1, cos: 1, tan: 1, asin: 1, acos: 1, atan: 1, atan2: 2,
  sqrt: 1, abs: 1, sign: 1, exp: 1, log: 1, ln: 1,
  floor: 1, ceil: 1, round: 1, fract: 1, pow: 2, min: 2, max: 2, clamp: 3, lerp: 3, step: 2, smoothstep: 3, mod: 2, random: 0, rand: 1,
  vec: 3, dot: 2, cross: 2, len: 1, norm: 1,
  rotX: 1, rotY: 1, rotZ: 1, rotAxis: 2,
  polar: 2, sphere: 3, torus: 4,
};
export const FUNC_IMPL = {
  sin: a => Math.sin(a), cos: a => Math.cos(a), tan: a => Math.tan(a),
  asin: a => Math.asin(a), acos: a => Math.acos(a), atan: a => Math.atan(a), atan2: (a, b) => Math.atan2(a, b),
  sqrt: a => Math.sqrt(a), abs: a => Math.abs(a), sign: a => Math.sign(a), exp: a => Math.exp(a),
  log: a => Math.log(a), ln: a => Math.log(a),
  floor: a => Math.floor(a), ceil: a => Math.ceil(a), round: a => Math.round(a), fract: a => a - Math.floor(a),
  pow: (a, b) => Math.pow(a, b), min: (a, b) => Math.min(a, b), max: (a, b) => Math.max(a, b),
  clamp: (a, b, c) => Math.min(Math.max(a, b), c), lerp: (a, b, c) => a + (b - a) * c,
  step: (e, x) => (x >= e ? 1 : 0), smoothstep: (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); },
  mod: (a, b) => a - b * Math.floor(a / b),
  random: () => Math.random(),
  rand: i => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); },
  vec: (x, y, z) => vec3(x, y, z),
  dot: (a, b) => { if (!isVec(a) || !isVec(b)) throw new Error(_et('err.dotNeedsVec')); return a.x * b.x + a.y * b.y + a.z * b.z; },
  cross: (a, b) => { if (!isVec(a) || !isVec(b)) throw new Error(_et('err.crossNeedsVec')); return vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x); },
  len: a => isVec(a) ? Math.hypot(a.x, a.y, a.z) : Math.abs(a),
  norm: a => { if (!isVec(a)) throw new Error(_et('err.normNeedsVec')); const l = Math.hypot(a.x, a.y, a.z) || 1; return vec3(a.x / l, a.y / l, a.z / l); },
  rotX: t => { const c = Math.cos(t), s = Math.sin(t); return mat3([[1, 0, 0], [0, c, -s], [0, s, c]]); },
  rotY: t => { const c = Math.cos(t), s = Math.sin(t); return mat3([[c, 0, s], [0, 1, 0], [-s, 0, c]]); },
  rotZ: t => { const c = Math.cos(t), s = Math.sin(t); return mat3([[c, -s, 0], [s, c, 0], [0, 0, 1]]); },
  rotAxis: (axis, t) => {
    if (!isVec(axis)) throw new Error(_et('err.rotAxisNeedsVec'));
    const l = Math.hypot(axis.x, axis.y, axis.z) || 1;
    const x = axis.x / l, y = axis.y / l, z = axis.z / l;
    const c = Math.cos(t), s = Math.sin(t), C = 1 - c;
    return mat3([
      [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
      [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
      [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
    ]);
  },
  polar: (r, a) => vec3(r * Math.cos(a), 0, r * Math.sin(a)),
  sphere: (r, th, ph) => vec3(r * Math.sin(th) * Math.cos(ph), r * Math.cos(th), r * Math.sin(th) * Math.sin(ph)),
  torus: (R, r, th, ph) => vec3((R + r * Math.cos(th)) * Math.cos(ph), r * Math.sin(th), (R + r * Math.cos(th)) * Math.sin(ph)),
};
export const PREC = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3 };
export const NEG_PREC = 2.5; // 一元负号优先级：高于 * / %，低于 ^（-2^2 = -(2^2)）

export function matVec(M, v) {
  const m = M.m;
  return vec3(
    m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z,
    m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
    m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z,
  );
}
export function matMat(A, B) {
  const a = A.m, b = B.m, o = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i][j] += a[i][k] * b[k][j];
  return mat3(o);
}

export function negate(v) {
  if (typeof v === 'number') return -v;
  if (isVec(v)) return vec3(-v.x, -v.y, -v.z);
  if (isMat(v)) return mat3(v.m.map(r => r.map(c => -c)));
  throw new Error(_et('err.negType'));
}

export function applyOp(op, a, b) {
  if (op === '+') {
    if (isVec(a) && isVec(b)) return vec3(a.x + b.x, a.y + b.y, a.z + b.z);
    if (isMat(a) && isMat(b)) return mat3(a.m.map((r, i) => r.map((c, j) => c + b.m[i][j])));
    if (typeof a === 'number' && typeof b === 'number') return a + b;
    throw new Error(_et('err.opAdd'));
  }
  if (op === '-') {
    if (isVec(a) && isVec(b)) return vec3(a.x - b.x, a.y - b.y, a.z - b.z);
    if (isMat(a) && isMat(b)) return mat3(a.m.map((r, i) => r.map((c, j) => c - b.m[i][j])));
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    throw new Error(_et('err.opSub'));
  }
  if (op === '*') {
    if (isMat(a)) {
      if (isVec(b)) return matVec(a, b);
      if (isMat(b)) return matMat(a, b);
      if (typeof b === 'number') return mat3(a.m.map(r => r.map(c => c * b)));
    }
    if (isVec(a)) {
      if (typeof b === 'number') return vec3(a.x * b, a.y * b, a.z * b);
      if (isVec(b)) return vec3(a.x * b.x, a.y * b.y, a.z * b.z);
    }
    if (typeof a === 'number') {
      if (isVec(b)) return vec3(a * b.x, a * b.y, a * b.z);
      if (isMat(b)) return mat3(b.m.map(r => r.map(c => a * c)));
      return a * b;
    }
    throw new Error(_et('err.opMul'));
  }
  if (op === '/') {
    if (isVec(a) && typeof b === 'number') return vec3(a.x / b, a.y / b, a.z / b);
    if (typeof a === 'number' && typeof b === 'number') return a / b;
    throw new Error(_et('err.opDiv'));
  }
  if (op === '%') {
    if (typeof a === 'number' && typeof b === 'number') return a % b;
    throw new Error(_et('err.opMod'));
  }
  if (op === '^') {
    if (typeof a === 'number' && typeof b === 'number') return Math.pow(a, b);
    throw new Error(_et('err.opPow'));
  }
  throw new Error(_etf('err.unknownOp', op));
}

export function tokenize(expr) {
  const tokens = [];
  let i = 0;
  let expectOperand = true; // 一元负号判定：期望操作数时遇到的 - 是负号
  while (i < expr.length) {
    const c = expr[i];
    if (c === ' ' || c === '\t' || c === '\n') { i++; continue; }
    if (c === '.' && (expr[i + 1] === 'x' || expr[i + 1] === 'y' || expr[i + 1] === 'z')) {
      tokens.push({ t: 'comp', axis: expr[i + 1] }); i += 2; expectOperand = false; continue;
    }
    if ((c >= '0' && c <= '9') || c === '.') {
      let j = i; while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
      tokens.push({ t: 'num', v: parseFloat(expr.slice(i, j)) }); i = j; expectOperand = false; continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i; while (j < expr.length && /[a-zA-Z0-9_]/.test(expr[j])) j++;
      const name = expr.slice(i, j);
      if (name === 'pi') tokens.push({ t: 'num', v: Math.PI });
      else if (name === 'e') tokens.push({ t: 'num', v: Math.E });
      else if (name in FUNCS) tokens.push({ t: 'func', name });
      else tokens.push({ t: 'var', name });
      i = j; expectOperand = false; continue;
    }
    if (c === '-' && expectOperand) { tokens.push({ t: 'neg' }); i++; continue; } // 一元负号，仍期望操作数
    if ('+-*/%^(),'.includes(c)) { tokens.push({ t: c }); i++; expectOperand = (c === '(' || c === ',' || '+-*/%^'.includes(c)); continue; }
    i++;
  }
  return tokens;
}

// 被动输入 getter（get_entity_*/get_world_*，游戏内由模组每 tick 求值）：
// 编辑器预览拿不到真实世界数据，统一 stub 让带 getter 的公式结构可正常预览。
// get_entity_pos 整取替换为 vec(0,0,0)（unpack 三分量赋值与 .x 分量访问都成立）；
// 其余 getter 替换为标量 0。与 Kotlin 端 GetterRewriter 语义对应。
export const GETTER_POS_RE = /\bget_entity_pos\s*\(\s*[^()]*?\s*\)/g;
export const GETTER_CALL_RE = /\b(?:get_entity|get_world)_[a-z_]+\s*\(\s*[^()]*?\s*\)/g;

// 编译表达式 → RPN 指令数组（变量保留为 {t:'var',name} 符号，求值期查表，供高频求值复用）
export function compileExpr(expr) {
  if (expr.indexOf('get_') !== -1) {
    expr = expr.replace(GETTER_POS_RE, 'vec(0,0,0)').replace(GETTER_CALL_RE, '0');
  }
  const output = [];
  const stack = [];
  for (const tk of tokenize(expr)) {
    if (tk.t === 'num') output.push(tk.v);
    else if (tk.t === 'var') output.push(tk); // 保留符号，延迟到执行期查表
    else if (tk.t === 'func') stack.push(tk.name);
    else if (tk.t === 'comp') output.push(tk);
    else if (tk.t === 'neg') {
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top === '(' || top === 'neg') break;
        if (top in FUNCS) { output.push(stack.pop()); continue; }
        if (top in PREC && PREC[top] > NEG_PREC) output.push(stack.pop());
        else break;
      }
      stack.push('neg');
    }
    else if (tk.t === ',') { while (stack.length && stack[stack.length - 1] !== '(') output.push(stack.pop()); }
    else if (tk.t === '(') stack.push(tk.t);
    else if (tk.t === ')') {
      while (stack.length && stack[stack.length - 1] !== '(') output.push(stack.pop());
      stack.pop();
      if (stack.length && stack[stack.length - 1] in FUNCS) output.push(stack.pop());
    } else if (tk.t in PREC) {
      const prec = PREC[tk.t], rightAssoc = tk.t === '^';
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top === '(') break;
        if (top === 'neg') { if (NEG_PREC > prec) output.push(stack.pop()); else break; continue; }
        if (top in FUNCS) { output.push(stack.pop()); continue; }
        if (top in PREC && (PREC[top] > prec || (PREC[top] === prec && !rightAssoc))) output.push(stack.pop());
        else break;
      }
      stack.push(tk.t);
    }
  }
  while (stack.length) output.push(stack.pop());
  return output;
}

// 执行 RPN（compileExpr 输出），vars 为变量查表（对象或函数）
export function execRpn(output, vars) {
  const isFn = typeof vars === 'function';
  const s = [];
  for (let i = 0; i < output.length; i++) {
    const o = output[i];
    const to = typeof o;
    if (to === 'number' || to === 'object') {
      if (to === 'number') { s.push(o); continue; }
      // object：{t:'comp'} / {t:'var'} / 向量矩阵值（防御）
      if (isVec(o) || isMat(o)) { s.push(o); continue; }
      if (o.t === 'comp') {
        const v = s.pop();
        if (!isVec(v)) throw new Error(_et('err.compNeedsVec'));
        s.push(o.axis === 'x' ? v.x : o.axis === 'y' ? v.y : v.z);
      } else {
        const v = isFn ? vars(o.name) : vars[o.name];
        if (v === undefined) throw new Error(_etf('err.unknownVar', o.name));
        s.push(v);
      }
      continue;
    }
    // string：'neg' / 函数名 / 运算符
    if (o === 'neg') { const v = s.pop(); s.push(negate(v)); continue; }
    const argc = FUNCS[o];
    if (argc !== undefined) {
      if (argc === 0) s.push(FUNC_IMPL[o]());
      else if (argc === 1) s.push(FUNC_IMPL[o](s.pop()));
      else if (argc === 2) { const b = s.pop(), a = s.pop(); s.push(FUNC_IMPL[o](a, b)); }
      else { const args = new Array(argc); for (let k = argc - 1; k >= 0; k--) args[k] = s.pop(); s.push(FUNC_IMPL[o](...args)); }
      continue;
    }
    const b = s.pop(), a = s.pop(); s.push(applyOp(o, a, b));
  }
  return s[s.length - 1];
}

export function evaluate(expr, vars) {
  return execRpn(compileExpr(expr), vars);
}

/* =========================================================================
 * 函数对象：公式代码块求值（分号分隔、顺序执行、打包/单分量赋值、临时变量）
 * ======================================================================= */

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

// 解析名称列表 [x,y,z] → ['x','y','z']
export function parseNameList(s) {
  const inner = s.trim().replace(/^\[/, '').replace(/\]$/, '');
  return inner.split(',').map(x => x.trim()).filter(Boolean);
}

// 解析表达式列表 [e1,e2,e3] → ['e1','e2','e3']（跳过括号内逗号）
export function parseExprList(s) {
  const inner = s.trim();
  if (!inner.startsWith('[') || !inner.endsWith(']')) return [inner];
  const body = inner.slice(1, -1);
  const parts = [];
  let depth = 0, cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}


