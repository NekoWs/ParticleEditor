// 脚本语言运行时（setup / tick / process）+ process 字节码编译器与 VM。
// 词法常量见 script/lexical.js，tokenizer / parser 见 script/parser.js。
// 纯逻辑 ESM，不依赖 DOM/THREE/浏览器 API；错误一律抛 Error，消息含行列号（本模块用英文）。
//
// 跨端一致性（Kotlin 端照此实现，算法必须可精确复刻）：
//   PRNG：mulberry32；rand() 用对象级状态，rand(seed)=mulberry32(seed|0) 的下一个值，不共享对象状态。
//   3D Simplex：标准 Gustavson；排列表由 mulberry32(seed) 对 [0..255] 做 Fisher-Yates 生成。
//   fbm：octaves ≥1，lacunarity=2.0，gain=0.5，累加后除以幅度和再 clamp 到 [-1,1]。
//   值形态：num/bool 是 JS 原生；vec/mat 是 { t, x,y,z... } / { t, m }；array 是 JS Array。

import { FAST_MATH } from './fastmath.js';
import { CTX_NAME, CONSTANTS, COMP_ALIAS, BUILTIN_FUNCTIONS, parseError } from './script/lexical.js';
import { parseProgram, parseExpression } from './script/parser.js';
import {
  vec2, vec3, vec4, mat3, mat4,
  isVec, isMat, vecDim, vecComps, mkVec,
  VEC_METHODS,
} from './script/vec.js';
import {
  color, isColor, colorComponent, colorWithComponent,
  COLOR_METHODS,
} from './script/color.js';
export { parseProgram, parseExpression };

// this 只读字段（setup/tick/process 通用）：
//   time=对象本地毫秒（绝对−st）、animTime=全局播放毫秒、duration=对象时长毫秒（无上限回退动画总长）、particles=粒子列表。
const CTX_SETUP_READ = new Set(['count', 'time', 'duration']);
const CTX_PROCESS_READ = new Set(['index', 'count', 'time', 'delta', 'duration', 'uv']);

// this 输出字段（process 内可读可写）。
const CTX_OUT_FIELDS = new Set(['position', 'color', 'velocity', 'scale', 'glow', 'light', 'life']);
const CTX_VEC_FIELDS = new Set(['position', 'color', 'velocity']);

// this 字段 → 字节码编号（只读 + 输出共用）。
const CTX_FIELD_NAMES = ['index', 'count', 'time', 'animTime', 'delta', 'duration', 'uv', 'life', 'position', 'color', 'velocity', 'scale', 'glow', 'light', 'particles'];
const CTX_FIELD_CODE = {};
CTX_FIELD_NAMES.forEach((n, i) => { CTX_FIELD_CODE[n] = i; });
const CTX_FIELD_BY_CODE = CTX_FIELD_NAMES;

// 常量。PI / E 在 tokenizer 里直接变成数值字面量，这里保留以防查表。

// 向量分量访问名：r/g/b 是 x/y/z 的别名，a 是 w 的别名。

const MAX_LOOP_ITERATIONS = 100000;
const MAX_TOTAL_LOOP_ITERATIONS = 1000000;
const MAX_RECURSION_DEPTH = 64;
const MAX_VALUE_DEPTH = 128;
const MAX_FBM_OCTAVES = 64;
const EQ_TOLERANCE = 1e-6;          // 数组 find/includes/unique 相等容差

// —— 值类型构造与判定 ——

// 粒子句柄 / 粒子列表。w 为宿主侧粒子存储对象。
// 句柄对象按 w 缓存复用：process 的 for-of 每帧每粒子都会取一次句柄，
// 逐次新建 {t:'particle',w} 会产生大量短命对象并拖累 GC。
const particleValue = (w) => (w._pv || (w._pv = { t: 'particle', w }));
const particleList = (list) => ({ t: 'particleList', list });

const isNum = (v) => typeof v === 'number';
const isBool = (v) => typeof v === 'boolean';
const isFunc = (v) => v != null && v.t === 'func';
const isLambda = (v) => v != null && v.t === 'lambda';
const isCallable = (v) => isFunc(v) || isLambda(v);
const isObj = (v) => v != null && v.t === 'obj';
const isParticle = (v) => v != null && v.t === 'particle';
const isParticleList = (v) => v != null && v.t === 'particleList';

// 无参 lambda 调用时的内部哨兵：绑定为 it 的占位，访问时抛错。
const IT_NOT_BOUND = Symbol('it-not-bound');

function typeName(v) {
  if (v === undefined) return 'undefined';
  if (typeof v === 'number') return 'num';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return 'array';
  if (v == null) return 'null';
  if (v.t === 'vec2' || v.t === 'vec3' || v.t === 'vec4' || v.t === 'mat3' || v.t === 'mat4' ||
      v.t === 'func' || v.t === 'lambda' || v.t === 'obj' || v.t === 'color' ||
      v.t === 'particle' || v.t === 'particleList') return v.t;
  return 'unknown';
}

// —— 错误 ——


function runtimeError(msg, node) {
  if (node && node.line != null) return new Error(`${msg} (line ${node.line}, col ${node.col})`);
  return new Error(msg);
}

function expectNum(v, name, node) {
  if (!isNum(v)) throw runtimeError(`${name} requires a num, got ${typeName(v)}`, node);
  return v;
}

function expectInt(v, name, node) {
  const n = expectNum(v, name, node);
  if (!Number.isInteger(n)) throw runtimeError(`${name} requires an integer, got ${n}`, node);
  return n;
}

function expectVec(v, name, node) {
  if (!isVec(v)) throw runtimeError(`${name} requires a vec2/vec3/vec4, got ${typeName(v)}`, node);
  return v;
}

function expectArr(v, name, node) {
  if (!Array.isArray(v)) throw runtimeError(`${name} requires an array, got ${typeName(v)}`, node);
  return v;
}

function sameDimVec(a, b, node) {
  if (vecDim(a) !== vecDim(b)) throw runtimeError('vector dimension mismatch', node);
}

// —— PRNG：mulberry32 ——
// 标准 mulberry32：state 为 32 位有符号整数，初始 state = seed|0。
// Kotlin 端用 Int/Long 模拟 32 位回绕即可精确复刻。
function mulberry32(seed) {
  let a = seed | 0;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// —— 3D Simplex 噪声（标准 Gustavson + 种子排列表）——
// Grad3 用标准 12 方向梯度表；排列表由 mulberry32(seed) 对 [0..255] 做 Fisher-Yates 生成。
// 结果 32*sum 理论范围约 [-1,1]，为避免极少数浮点越界（误差量级 <1e-12），返回时 clamp 到 [-1,1]。

const GRAD3 = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];
const SIMPLEX_F3 = 1 / 3;
const SIMPLEX_G3 = 1 / 6;

const simplexCache = new Map();

function makePermutation(seed) {
  const key = seed | 0;
  const cached = simplexCache.get(key);
  if (cached) return cached;

  const p = Array.from({ length: 256 }, (_, i) => i);
  const rng = mulberry32(key);
  // 固定 shuffle 顺序：从高位向低位，j = floor(rng() * (i + 1))。
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }

  const perm = new Array(512);
  const permMod12 = new Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    permMod12[i] = perm[i] % 12;
  }
  const entry = { perm, permMod12 };
  simplexCache.set(key, entry);
  return entry;
}

function grad3Dot(gi, x, y, z) {
  const g = GRAD3[gi];
  return g[0] * x + g[1] * y + g[2] * z;
}

function noise3D(xin, yin, zin, seed) {
  const { perm, permMod12 } = makePermutation(seed);

  const s = (xin + yin + zin) * SIMPLEX_F3;
  const i = Math.floor(xin + s);
  const j = Math.floor(yin + s);
  const k = Math.floor(zin + s);
  const t = (i + j + k) * SIMPLEX_G3;
  const X0 = i - t;
  const Y0 = j - t;
  const Z0 = k - t;
  const x0 = xin - X0;
  const y0 = yin - Y0;
  const z0 = zin - Z0;

  let i1, j1, k1, i2, j2, k2;
  if (x0 >= y0) {
    if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
    else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
  } else {
    if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
  }

  const x1 = x0 - i1 + SIMPLEX_G3;
  const y1 = y0 - j1 + SIMPLEX_G3;
  const z1 = z0 - k1 + SIMPLEX_G3;
  const x2 = x0 - i2 + 2 * SIMPLEX_G3;
  const y2 = y0 - j2 + 2 * SIMPLEX_G3;
  const z2 = z0 - k2 + 2 * SIMPLEX_G3;
  const x3 = x0 - 1 + 3 * SIMPLEX_G3;
  const y3 = y0 - 1 + 3 * SIMPLEX_G3;
  const z3 = z0 - 1 + 3 * SIMPLEX_G3;

  const ii = i & 255;
  const jj = j & 255;
  const kk = k & 255;

  const gi0 = permMod12[ii + perm[jj + perm[kk]]];
  const gi1 = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]];
  const gi2 = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]];
  const gi3 = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]];

  let n0 = 0, n1 = 0, n2 = 0, n3 = 0;

  let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
  if (t0 >= 0) { t0 *= t0; n0 = t0 * t0 * grad3Dot(gi0, x0, y0, z0); }
  let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
  if (t1 >= 0) { t1 *= t1; n1 = t1 * t1 * grad3Dot(gi1, x1, y1, z1); }
  let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
  if (t2 >= 0) { t2 *= t2; n2 = t2 * t2 * grad3Dot(gi2, x2, y2, z2); }
  let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
  if (t3 >= 0) { t3 *= t3; n3 = t3 * t3 * grad3Dot(gi3, x3, y3, z3); }

  const out = 32.0 * (n0 + n1 + n2 + n3);
  return Math.max(-1, Math.min(1, out));
}


// —— 相等比较 / 排序比较 ——

// ==/!=：精确比较（无容差）。
function eqExact(a, b, depth = 0) {
  if (depth > MAX_VALUE_DEPTH) throw new Error('value nesting too deep');
  if (a === undefined || b === undefined) return a === undefined && b === undefined;
  if (isNum(a) && isNum(b)) return a === b;
  if (isBool(a) && isBool(b)) return a === b;
  if (isVec(a) && isVec(b)) {
    if (a.t !== b.t) return false;
    if (a.t === 'vec2') return a.x === b.x && a.y === b.y;
    if (a.t === 'vec3') return a.x === b.x && a.y === b.y && a.z === b.z;
    return a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w;
  }
  if (isMat(a) && isMat(b)) {
    if (a.t !== b.t) return false;
    const ma = a.m, mb = b.m;
    for (let i = 0; i < ma.length; i++) {
      for (let j = 0; j < ma[i].length; j++) {
        if (ma[i][j] !== mb[i][j]) return false;
      }
    }
    return true;
  }
  if (isColor(a) && isColor(b)) {
    return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!eqExact(a[i], b[i], depth + 1)) return false;
    return true;
  }
  return false;
}

// find/includes/unique 相等：数值与向量/矩阵分量按 1e-6 容差，布尔精确，数组递归。
function eqTol(a, b, depth = 0) {
  if (depth > MAX_VALUE_DEPTH) throw new Error('value nesting too deep');
  if (a === undefined || b === undefined) return a === undefined && b === undefined;
  if (isNum(a) && isNum(b)) return Math.abs(a - b) <= EQ_TOLERANCE;
  if (isBool(a) && isBool(b)) return a === b;
  if (isVec(a) && isVec(b)) {
    if (a.t !== b.t) return false;
    if (a.t === 'vec2') {
      return Math.abs(a.x - b.x) <= EQ_TOLERANCE && Math.abs(a.y - b.y) <= EQ_TOLERANCE;
    }
    if (a.t === 'vec3') {
      return Math.abs(a.x - b.x) <= EQ_TOLERANCE &&
        Math.abs(a.y - b.y) <= EQ_TOLERANCE &&
        Math.abs(a.z - b.z) <= EQ_TOLERANCE;
    }
    return Math.abs(a.x - b.x) <= EQ_TOLERANCE &&
      Math.abs(a.y - b.y) <= EQ_TOLERANCE &&
      Math.abs(a.z - b.z) <= EQ_TOLERANCE &&
      Math.abs(a.w - b.w) <= EQ_TOLERANCE;
  }
  if (isMat(a) && isMat(b)) {
    if (a.t !== b.t) return false;
    const ma = a.m, mb = b.m;
    for (let i = 0; i < ma.length; i++) {
      for (let j = 0; j < ma[i].length; j++) {
        if (Math.abs(ma[i][j] - mb[i][j]) > EQ_TOLERANCE) return false;
      }
    }
    return true;
  }
  if (isColor(a) && isColor(b)) {
    return Math.abs(a.r - b.r) <= EQ_TOLERANCE &&
      Math.abs(a.g - b.g) <= EQ_TOLERANCE &&
      Math.abs(a.b - b.b) <= EQ_TOLERANCE &&
      Math.abs(a.a - b.a) <= EQ_TOLERANCE;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!eqTol(a[i], b[i], depth + 1)) return false;
    return true;
  }
  return false;
}

// when 的 case 匹配：数值/向量/矩阵/颜色分量按 1e-6 容差，布尔/字符串精确，数组递归。
function whenEqual(a, b, depth = 0) {
  if (depth > MAX_VALUE_DEPTH) throw new Error('value nesting too deep');
  if (a === undefined || b === undefined) return a === undefined && b === undefined;
  if (isNum(a) && isNum(b)) return Math.abs(a - b) <= EQ_TOLERANCE;
  if (isBool(a) && isBool(b)) return a === b;
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (isVec(a) && isVec(b)) return eqTol(a, b);
  if (isMat(a) && isMat(b)) return eqTol(a, b);
  if (isColor(a) && isColor(b)) return eqTol(a, b);
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!whenEqual(a[i], b[i], depth + 1)) return false;
    return true;
  }
  return false;
}

// 默认升序排序比较。返回 -1 / 0 / 1。混合类型直接抛错。
function defaultCompare(a, b, node, depth = 0) {
  if (depth > MAX_VALUE_DEPTH) throw new Error('value nesting too deep');
  const ta = typeName(a);
  const tb = typeName(b);
  if (ta !== tb) throw runtimeError(`cannot sort mixed types (${ta} vs ${tb})`, node);

  if (ta === 'num') return a < b ? -1 : a > b ? 1 : 0;
  if (ta === 'bool') return (a ? 1 : 0) < (b ? 1 : 0) ? -1 : (a ? 1 : 0) > (b ? 1 : 0) ? 1 : 0;
  if (ta === 'vec2' || ta === 'vec3') {
    const ca = vecComps(a);
    const cb = vecComps(b);
    for (let i = 0; i < ca.length; i++) {
      if (ca[i] < cb[i]) return -1;
      if (ca[i] > cb[i]) return 1;
    }
    return 0;
  }
  if (ta === 'mat3' || ta === 'mat4') {
    for (let i = 0; i < a.m.length; i++) {
      for (let j = 0; j < a.m[i].length; j++) {
        if (a.m[i][j] < b.m[i][j]) return -1;
        if (a.m[i][j] > b.m[i][j]) return 1;
      }
    }
    return 0;
  }
  if (ta === 'array') {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const c = defaultCompare(a[i], b[i], node, depth + 1);
      if (c !== 0) return c;
    }
    return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
  }
  throw runtimeError(`values of type ${ta} are not sortable`, node);
}

// —— 控制流信号（return / break / continue）——

class Flow {
  constructor(kind, value) {
    this.kind = kind;
    this.value = value;
  }
}

// —— 运行时（解释器）——

class Runtime {
  constructor(phase, program, objState, statics, env, ctx) {
    this.phase = phase;
    this.program = program;
    this.objState = objState;
    this.statics = statics || null;
    this.env = env || null;
    this.ctx = ctx || null;
    this.scopes = [];
    this.scopePool = [];
    this.constSets = [];
    this.escapedScopes = new Set(); // 被闭包捕获的作用域，出栈时不归还池
    this.receiverStack = [];        // apply 块的接收者粒子
    this.funcDepth = 0;
    this.inFunction = false;
    this.usedIterations = 0;        // 本次运行跨所有循环/重复的全局迭代预算

    const varsObj = (phase === 'setup' || phase === 'toplevel') ? (env && env.vars) : (ctx && ctx.vars);
    this.varsMap = new Map();
    if (varsObj) {
      for (const k of Object.keys(varsObj)) this.varsMap.set(k, varsObj[k]);
    }
  }

  pushScope(map) {
    if (map) { this.scopes.push(map); this.constSets.push(null); return; }
    // 块作用域是 process 热路径：每粒子每帧会进出多个块作用域（for-of 体、if/else 分支），
    // 逐次 new Map() 造成巨量分配与 GC 抖动。复用空 Map 池，出栈时清空归还。
    const s = this.scopePool.length > 0 ? this.scopePool.pop() : new Map();
    this.scopes.push(s);
    this.constSets.push(null);
  }
  popScope() {
    const s = this.scopes.pop();
    this.constSets.pop();
    if (s && typeof s.clear === 'function' && !this.escapedScopes.has(s) && this.scopePool.length < 128) {
      s.clear();
      this.scopePool.push(s);
    }
  }
  markCapturedScopes() {
    for (const s of this.scopes) this.escapedScopes.add(s);
  }
  currentScope() { return this.scopes[this.scopes.length - 1]; }
  currentConstSet() { return this.constSets[this.constSets.length - 1]; }
  markConst(name) {
    let cs = this.constSets[this.constSets.length - 1];
    if (!cs) { cs = new Set(); this.constSets[this.constSets.length - 1] = cs; }
    cs.add(name);
  }

  // 全局迭代预算：所有循环/重复共用，防止嵌套循环把每循环上限相乘放大到无法接受。
  guardLoop(node) {
    if (++this.usedIterations > MAX_TOTAL_LOOP_ITERATIONS) {
      throw runtimeError(`total loop iteration limit (${MAX_TOTAL_LOOP_ITERATIONS}) exceeded`, node);
    }
  }

  /* —— 名称查找 —— */

  lookupName(name, node) {
    // this 不是值，只能通过 this.field 访问。
    if (name === CTX_NAME) {
      throw runtimeError(`'this' is not a value; use this.<field>`, node);
    }
    // 1) 块级 / 函数局部作用域（由内向外）
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const s = this.scopes[i];
      if (s.has(name)) {
        const v = s.get(name);
        if (name === 'it' && v === IT_NOT_BOUND) {
          throw runtimeError('it is not defined in a no-argument lambda call', node);
        }
        return v;
      }
    }
    // 2) global（对象级）
    if (this.objState.globals.has(name)) return this.objState.globals.get(name);
    // 3) fx.vars 注入
    if (this.varsMap.has(name)) return this.varsMap.get(name);
    // 4) 常量
    if (CONSTANTS.has(name)) return CONSTANTS.get(name);
    // 5) 顶层函数（作为 func 值；若被同名变量遮蔽，上面的作用域/global 会先命中）
    if (this.program.functions.has(name)) return { t: 'func', name };
    throw runtimeError(`unknown variable '${name}'`, node);
  }

  /* —— 赋值 —— */

  assignName(name, value, node) {
    if (name === CTX_NAME) {
      throw runtimeError(`cannot assign to 'this'; use this.<field> = ...`, node);
    }

    // 局部作用域（含 const 只读检查）
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const s = this.scopes[i];
      if (s.has(name)) {
        const cs = this.constSets[i];
        if (cs && cs.has(name)) throw runtimeError(`cannot assign to const '${name}'`, node);
        s.set(name, value);
        return;
      }
    }

    // 全局（顶层 let/const）：let 处处可写，const 只读。
    if (this.objState.globals.has(name)) {
      if (this.objState.constGlobals && this.objState.constGlobals.has(name)) {
        throw runtimeError(`cannot assign to const '${name}'`, node);
      }
      this.objState.globals.set(name, value);
      return;
    }

    // 只读名：fx.vars 与常量。
    if (this.varsMap.has(name) || CONSTANTS.has(name)) {
      throw runtimeError(`cannot assign to read-only name '${name}'`, node);
    }

    // 不再隐式声明：赋值给未声明名报错。
    throw runtimeError(`undeclared variable '${name}'`, node);
  }

  assignCtxField(target, value, node) {
    if (target.object.type !== 'var' || target.object.name !== CTX_NAME) {
      throw runtimeError(`only this has fields '.${target.field}'`, node);
    }
    throw runtimeError(`this.${target.field} is read-only`, node);
  }

  assignTarget(target, value, node) {
    if (target.type === 'var') {
      this.assignName(target.name, value, node);
      return;
    }
    if (target.type === 'member') {
      if (target.object.type === 'var' && target.object.name === CTX_NAME) {
        if (this.receiverStack.length > 0) {
          particleSetField(this.receiverStack[this.receiverStack.length - 1], target.field, value, node);
          return;
        }
        throw runtimeError(`this.${target.field} is read-only`, node);
      }
      const obj = this.evalExpr(target.object);
      if (isParticle(obj)) {
        particleSetField(obj, target.field, value, node);
        return;
      }
      if (isObj(obj)) {
        obj.fields.set(target.field, value);
        return;
      }
      throw runtimeError(`only this / particle / objects have fields '.${target.field}'`, node);
    }
    if (target.type === 'index') {
      const arr = this.evalExpr(target.target);
      if (isObj(arr)) {
        const key = this.evalExpr(target.index);
        if (typeof key !== 'string') {
          throw runtimeError(`object index requires a string, got ${typeName(key)}`, node);
        }
        arr.fields.set(key, value);
        return;
      }
      if (!Array.isArray(arr)) throw runtimeError('indexed assignment target is not an array', node);
      const idx = this.evalExpr(target.index);
      const n = expectInt(idx, 'array index', node);
      if (n < 0 || n >= arr.length) {
        throw runtimeError(`array index ${n} out of bounds (size ${arr.length})`, node);
      }
      arr[n] = value;
      return;
    }
    if (target.type === 'comp') {
      const v = this.evalExpr(target.target);
      // particle 上 .x/.y/.z/.w/.r/.g/.b/.a 不是保留字段，按自定义字段存取（p.color.a 仍是颜色分量）。
      if (isParticle(v)) {
        particleSetField(v, target.comp, value, node);
        return;
      }
      // obj 单字母键按字段写入。
      if (isObj(v)) {
        v.fields.set(target.comp, value);
        return;
      }
      if (isColor(v)) {
        const updated = colorCompWrite(v, target.comp, expectNum(value, 'component value', node), node);
        this.assignTarget(target.target, updated, node);
        return;
      }
      if (!isVec(v)) throw runtimeError('component assignment target is not a vector', node);
      const comp = COMP_ALIAS[target.comp];
      if ((v.t === 'vec2' && (comp === 'z' || comp === 'w')) ||
          (v.t === 'vec3' && comp === 'w')) {
        throw runtimeError(`${v.t} has no component '${target.comp}'`, node);
      }
      const updated = setVecComp(v, comp, expectNum(value, 'component value', node));
      this.assignTarget(target.target, updated, node);
      return;
    }
    throw runtimeError(`invalid assignment target '${target.type}'`, node);
  }

  /* —— 语句执行 —— */

  execStmt(node) {
    switch (node.type) {
      case 'block': return this.execBlock(node);
      case 'if': {
        const c = this.evalExpr(node.cond);
        if (truthy(c, node.cond)) this.execStmt(node.then);
        else if (node.els) this.execStmt(node.els);
        return;
      }
      case 'while': return this.execWhile(node);
      case 'do': return this.execDoWhile(node);
      case 'for': return this.execFor(node);
      case 'break': throw new Flow('break');
      case 'continue': throw new Flow('continue');
      case 'return': {
        const v = node.expr ? this.evalExpr(node.expr) : undefined;
        throw new Flow('return', v);
      }
      case 'declare': {
        this.execDeclare(node);
        return;
      }
      case 'destructure': {
        this.execDestructure(node);
        return;
      }
      case 'whenstmt': {
        this.execWhenStmt(node);
        return;
      }
      case 'forof': return this.execForOf(node);
      case 'expr': {
        this.evalExpr(node.expr);
        return;
      }
      case 'assign': {
        this.execAssign(node);
        return;
      }
      default:
        throw runtimeError(`unknown statement type '${node.type}'`, node);
    }
  }

  execBlock(node) {
    this.pushScope(new Map());
    try {
      for (const st of node.body) this.execStmt(st);
    } finally {
      this.popScope();
    }
  }

  execAssign(node) {
    if (node.target.type === 'unpack') {
      const v = this.evalExpr(node.value);
      const vals = unpackValues(v, node.target.names.length, node);
      for (let i = 0; i < node.target.names.length; i++) {
        this.assignName(node.target.names[i], vals[i], node);
      }
    } else {
      const v = this.evalExpr(node.value);
      this.assignTarget(node.target, v, node);
    }
  }

  execDeclare(node) {
    // 同作用域重复声明（let/const 与参数）报错；多声明按声明顺序求值。
    for (const d of node.decls) {
      if (this.currentScope().has(d.name)) {
        throw runtimeError(`duplicate declaration '${d.name}'`, d);
      }
      const v = d.init ? this.evalExpr(d.init) : undefined;
      this.currentScope().set(d.name, v);
      if (node.kind === 'const') this.markConst(d.name);
    }
  }

  execDestructure(node) {
    const v = this.evalExpr(node.value);
    if (!isObj(v)) {
      throw runtimeError(`object destructuring requires an object, got ${typeName(v)}`, node);
    }
    for (const name of node.names) {
      if (this.currentScope().has(name)) {
        throw runtimeError(`duplicate declaration '${name}'`, node);
      }
      this.currentScope().set(name, v.fields.get(name));
      if (node.kind === 'const') this.markConst(name);
    }
  }

  execWhenStmt(node) {
    const subject = this.evalExpr(node.subject);
    for (const c of node.cases) {
      if (whenEqual(subject, this.evalExpr(c.label), c.label)) {
        this.execStmt(c.body);
        return;
      }
    }
    if (node.els) this.execStmt(node.els);
  }

  execWhile(node) {
    let iter = 0;
    while (true) {
      const c = this.evalExpr(node.cond);
      if (!truthy(c, node.cond)) break;
      if (++iter > MAX_LOOP_ITERATIONS) {
        throw runtimeError(`loop iteration limit (${MAX_LOOP_ITERATIONS}) exceeded`, node);
      }
      this.guardLoop(node);
      try {
        this.execStmt(node.body);
      } catch (f) {
        if (f instanceof Flow && f.kind === 'break') break;
        if (f instanceof Flow && f.kind === 'continue') continue;
        throw f;
      }
    }
  }

  execDoWhile(node) {
    let iter = 0;
    do {
      if (++iter > MAX_LOOP_ITERATIONS) {
        throw runtimeError(`loop iteration limit (${MAX_LOOP_ITERATIONS}) exceeded`, node);
      }
      this.guardLoop(node);
      try {
        this.execStmt(node.body);
      } catch (f) {
        if (f instanceof Flow && f.kind === 'break') break;
        if (f instanceof Flow && f.kind === 'continue') { /* 跳到条件判断 */ }
        else throw f;
      }
    } while (truthy(this.evalExpr(node.cond), node.cond));
  }

  execFor(node) {
    this.pushScope(new Map());
    try {
      if (node.init) this.execForPart(node.init);
      let iter = 0;
      while (true) {
        if (node.cond) {
          const c = this.evalExpr(node.cond);
          if (!truthy(c, node.cond)) break;
        }
        if (++iter > MAX_LOOP_ITERATIONS) {
          throw runtimeError(`loop iteration limit (${MAX_LOOP_ITERATIONS}) exceeded`, node);
        }
        this.guardLoop(node);
        try {
          this.execStmt(node.body);
        } catch (f) {
          if (f instanceof Flow && f.kind === 'break') break;
          if (f instanceof Flow && f.kind === 'continue') { /* 落到 inc */ }
          else throw f;
        }
        if (node.inc) this.execForPart(node.inc);
      }
    } finally {
      this.popScope();
    }
  }

  execForPart(part) {
    if (part.type === 'assign') this.execAssign(part);
    else if (part.type === 'declare') this.execDeclare(part);
    else this.evalExpr(part);
  }

  execForOf(node) {
    const iter = this.evalExpr(node.iter);
    let snapshot;
    if (isParticleList(iter)) {
      snapshot = iter.list.slice();
    } else if (Array.isArray(iter)) {
      snapshot = iter.slice();
    } else {
      throw runtimeError(`for-of requires a particle list or array, got ${typeName(iter)}`, node.iter);
    }
    this.pushScope(new Map());
    if (node.kind === 'const') this.markConst(node.name);
    try {
      let idx = 0;
      for (const item of snapshot) {
        if (++idx > MAX_LOOP_ITERATIONS) {
          throw runtimeError(`loop iteration limit (${MAX_LOOP_ITERATIONS}) exceeded`, node);
        }
        this.guardLoop(node);
        // 循环自身的每次迭代直接写回循环变量，不经过 assignName（const 循环变量不因此报错）。
        this.currentScope().set(node.name, isParticleList(iter) ? particleValue(item) : item);
        try {
          this.execStmt(node.body);
        } catch (f) {
          if (f instanceof Flow && f.kind === 'break') break;
          if (f instanceof Flow && f.kind === 'continue') continue;
          throw f;
        }
      }
    } finally {
      this.popScope();
    }
  }

  /* —— 表达式求值 —— */

  evalExpr(node) {
    switch (node.type) {
      case 'num': return node.value;
      case 'str': return node.value;
      case 'bool': return node.value;
      case 'undefined': return undefined;
      case 'var': return this.lookupName(node.name, node);
      case 'array': return node.items.map((it) => this.evalExpr(it));
      case 'unary': return this.evalUnary(node);
      case 'binary': return this.evalBinary(node);
      case 'ternary': {
        const c = this.evalExpr(node.cond);
        return truthy(c, node.cond) ? this.evalExpr(node.thenExpr) : this.evalExpr(node.elseExpr);
      }
      case 'index': return this.evalIndex(node);
      case 'comp': return this.evalComp(node);
      case 'member': return this.evalMember(node);
      case 'call': return this.evalCall(node);
      case 'method': return this.evalMethod(node);
      case 'lambda': return this.evalLambda(node);
      case 'obj': return this.evalObj(node);
      case 'whenexpr': return this.evalWhenExpr(node);
      case 'apply': return this.evalApply(node);
      case 'preinc': {
        const old = this.evalLValue(node.target);
        const nv = incDecValue(old, node.op, node);
        this.assignTarget(node.target, nv, node);
        return nv;
      }
      case 'postinc': {
        const old = this.evalLValue(node.target);
        const nv = incDecValue(old, node.op, node);
        this.assignTarget(node.target, nv, node);
        return old;
      }
      default:
        throw runtimeError(`unknown expression type '${node.type}'`, node);
    }
  }

  evalUnary(node) {
    const v = this.evalExpr(node.operand);
    if (node.op === '!') {
      if (!isNum(v) && !isBool(v) && v !== undefined) {
        throw runtimeError(`'!' requires a num/bool, got ${typeName(v)}`, node);
      }
      return !truthy(v, node);
    }
    // 一元负号
    if (isNum(v)) return -v;
    if (isVec(v)) {
      const c = vecComps(v).map((x) => -x);
      return mkVec(vecDim(v), c);
    }
    if (isMat(v)) {
      const m = v.m.map((row) => row.map((x) => -x));
      return v.t === 'mat3' ? mat3(m) : mat4(m);
    }
    throw runtimeError(`unary '-' not supported for ${typeName(v)}`, node);
  }

  evalBinary(node) {
    const op = node.op;
    // 短路逻辑
    if (op === '&&') {
      const l = this.evalExpr(node.left);
      if (!truthy(l, node.left)) return l;
      const r = this.evalExpr(node.right);
      if (!isNum(r) && !isBool(r) && r !== undefined) throw runtimeError(`'&&' requires num/bool operands, got ${typeName(r)}`, node);
      return r;
    }
    if (op === '||') {
      const l = this.evalExpr(node.left);
      if (truthy(l, node.left)) return l;
      const r = this.evalExpr(node.right);
      if (!isNum(r) && !isBool(r) && r !== undefined) throw runtimeError(`'||' requires num/bool operands, got ${typeName(r)}`, node);
      return r;
    }
    const a = this.evalExpr(node.left);
    const b = this.evalExpr(node.right);
    return binaryOp(op, a, b, node);
  }

  evalIndex(node) {
    const target = this.evalExpr(node.target);
    if (isObj(target)) {
      const key = this.evalExpr(node.index);
      if (typeof key !== 'string') {
        throw runtimeError(`object index requires a string, got ${typeName(key)}`, node);
      }
      return target.fields.get(key);
    }
    const idx = this.evalExpr(node.index);
    const n = expectInt(idx, 'index', node);
    if (isParticleList(target)) {
      if (n < 0 || n >= target.list.length) {
        throw runtimeError(`particle list index ${n} out of bounds (size ${target.list.length})`, node);
      }
      return particleValue(target.list[n]);
    }
    if (!Array.isArray(target)) {
      throw runtimeError(`index access requires an array, particle list or object, got ${typeName(target)}`, node);
    }
    if (n < 0 || n >= target.length) {
      throw runtimeError(`array index ${n} out of bounds (size ${target.length})`, node);
    }
    return target[n];
  }

  evalComp(node) {
    const target = this.evalExpr(node.target);
    // particle 上 .x/.y/.z/.w/.r/.g/.b/.a 不是保留字段，按自定义字段读取。
    if (isParticle(target)) return particleGetField(target, node.comp, node);
    // obj 的单字母键（a/b/x...）与分量访问同名，按字段读取。
    if (isObj(target)) return target.fields.get(node.comp);
    if (isColor(target)) return colorCompRead(target, node.comp, node);
    if (!isVec(target)) {
      throw runtimeError(`component access requires a vector or color, got ${typeName(target)}`, node);
    }
    const comp = COMP_ALIAS[node.comp];
    if ((target.t === 'vec2' && (comp === 'z' || comp === 'w')) ||
        (target.t === 'vec3' && comp === 'w')) {
      throw runtimeError(`${target.t} has no component '${node.comp}'`, node);
    }
    return target[comp];
  }

  evalMember(node) {
    const field = node.field;
    if (node.object.type === 'var' && node.object.name === CTX_NAME) {
      if (this.receiverStack.length > 0) {
        return particleGetField(this.receiverStack[this.receiverStack.length - 1], field, node);
      }
      return ctxRead(field, this, node);
    }
    const obj = this.evalExpr(node.object);
    if (isParticle(obj)) return particleGetField(obj, field, node);
    if (isObj(obj)) return obj.fields.get(field);
    throw runtimeError(`only this / particle / objects have fields '.${field}'`, node);
  }

  // 读取可赋值目标（++/-- 用）
  evalLValue(target) {
    if (target.type === 'var') return this.lookupName(target.name, target);
    if (target.type === 'member') return this.evalMember(target);
    if (target.type === 'index') return this.evalIndex(target);
    if (target.type === 'comp') return this.evalComp(target);
    throw runtimeError(`invalid increment target '${target.type}'`, target);
  }

  evalCall(node) {
    const args = node.args.map((a) => this.evalExpr(a));
    return this.callCallee(node.callee, args, node);
  }

  // 求值并调用一个 callable（内建 / 用户函数 / lambda 值）。
  callCallee(callee, args, node) {
    if (callee.type === 'var') {
      const name = callee.name;
      if (BUILTIN_FUNCTIONS.has(name)) {
        return callBuiltin(name, args, this, node);
      }
      if (this.program.functions.has(name)) {
        return this.callUserFunc(this.program.functions.get(name), args, node);
      }
    }
    const fn = this.evalExpr(callee);
    return this.callValue(fn, args, node);
  }

  callValue(fn, args, node) {
    if (isFunc(fn)) return this.callUserFunc(this.program.functions.get(fn.name), args, node);
    if (isLambda(fn)) return this.callLambda(fn, args, node);
    throw runtimeError(`value of type ${typeName(fn)} is not callable`, node);
  }

  evalMethod(node) {
    // this.spawn(config)
    if (node.object.type === 'var' && node.object.name === CTX_NAME && node.method === 'spawn') {
      const fx = fxRuntime(this);
      if (!fx || typeof fx.spawn !== 'function') {
        throw runtimeError('this.spawn is not available here', node);
      }
      if (node.args.length > 1) {
        throw runtimeError('this.spawn expects at most 1 argument', node);
      }
      const args = node.args.map((a) => this.evalExpr(a));
      const w = fx.spawn(args.length === 1 ? args[0] : undefined);
      if (!w) throw runtimeError('spawn failed', node);
      return particleValue(w);
    }

    const obj = this.evalExpr(node.object);
    const args = node.args.map((a) => this.evalExpr(a));
    return this.callMethod(obj, node.method, args, node);
  }

  callMethod(obj, method, args, node) {
    if (isParticle(obj)) {
      if (method === 'kill') {
        if (args.length !== 0) throw runtimeError("'kill' takes no arguments", node);
        particleKill(obj, node);
        return 0;
      }
      throw runtimeError(`particle has no method '.${method}()'`, node);
    }
    if (isParticleList(obj)) {
      if (method === 'size') return obj.list.length;
      throw runtimeError(`particle list has no method '.${method}()'`, node);
    }
    if (isVec(obj)) return callVecMethod(obj, method, args, node);
    if (isColor(obj)) return callColorMethod(obj, method, args, node);
    if (isObj(obj)) {
      throw runtimeError(`objects have no method '.${method}()'`, node);
    }
    if (!Array.isArray(obj)) {
      throw runtimeError(`method '.${method}()' requires an array, particle, particle list, vector or color, got ${typeName(obj)}`, node);
    }
    return applyArrayMethod(obj, method, args, this, node);
  }

  evalLambda(node) {
    // 捕获当前作用域链（按引用），供调用时安装。
    this.markCapturedScopes();
    return {
      t: 'lambda',
      params: node.params.slice(),
      body: node.body,
      closure: this.scopes.slice(),
      closureConsts: this.constSets.slice(),
    };
  }

  evalObj(node) {
    const fields = new Map();
    for (const [k, exprNode] of node.fields) fields.set(k, this.evalExpr(exprNode));
    return { t: 'obj', fields };
  }

  evalWhenExpr(node) {
    const subject = this.evalExpr(node.subject);
    for (const c of node.cases) {
      if (whenEqual(subject, this.evalExpr(c.label), c.label)) return this.evalExpr(c.expr);
    }
    if (node.els) return this.evalExpr(node.els);
    throw runtimeError('when expression has no matching case and no else', node);
  }

  evalApply(node) {
    const pv = this.evalExpr(node.target);
    if (!isParticle(pv)) {
      throw runtimeError(`'apply' requires a particle, got ${typeName(pv)}`, node);
    }
    const fn = this.evalLambda(node.body);
    return this.callLambdaReceiver(fn, pv, node);
  }

  // 调用带接收者的 lambda：this=粒子，裸名优先解析为粒子字段。返回接收者粒子。
  callLambdaReceiver(fn, pv, node) {
    if (this.funcDepth >= MAX_RECURSION_DEPTH) {
      throw runtimeError(`maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded`, node);
    }
    this.funcDepth++;
    const prevInFunction = this.inFunction;
    this.inFunction = true;
    const savedScopes = this.scopes;
    const savedConsts = this.constSets;

    this.scopes = fn.closure.slice();
    this.constSets = fn.closureConsts.slice();
    this.pushScope(new ParticleScope(pv));
    this.pushScope(new Map());
    this.receiverStack.push(pv);
    try {
      this.execLambdaBody(fn.body);
    } catch (f) {
      if (!(f instanceof Flow && f.kind === 'return')) throw f;
    } finally {
      this.receiverStack.pop();
      this.popScope(); // 参数作用域
      this.popScope(); // 接收者作用域
      this.scopes = savedScopes;
      this.constSets = savedConsts;
      this.inFunction = prevInFunction;
      this.funcDepth--;
    }
    return pv;
  }

  callLambda(fn, args, node) {
    if (fn.params.length === 0 && args.length >= 2) {
      throw runtimeError(`lambda with no parameter list accepts at most 1 argument, got ${args.length}`, node);
    }
    if (this.funcDepth >= MAX_RECURSION_DEPTH) {
      throw runtimeError(`maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded`, node);
    }
    this.funcDepth++;
    const prevInFunction = this.inFunction;
    this.inFunction = true;
    const savedScopes = this.scopes;
    const savedConsts = this.constSets;

    this.scopes = fn.closure.slice();
    this.constSets = fn.closureConsts.slice();
    this.pushScope(new Map());
    if (fn.params.length === 0) {
      if (args.length === 0) this.currentScope().set('it', IT_NOT_BOUND);
      else this.currentScope().set('it', args[0]);
    } else {
      if (args.length !== fn.params.length) {
        throw runtimeError(`lambda expects ${fn.params.length} argument(s), got ${args.length}`, node);
      }
      for (let i = 0; i < fn.params.length; i++) {
        this.currentScope().set(fn.params[i], args[i]);
      }
    }

    let result = undefined;
    try {
      result = this.execLambdaBody(fn.body);
    } catch (f) {
      if (f instanceof Flow && f.kind === 'return') result = f.value;
      else throw f;
    } finally {
      this.popScope();
      this.scopes = savedScopes;
      this.constSets = savedConsts;
      this.inFunction = prevInFunction;
      this.funcDepth--;
    }
    return result;
  }

  // 执行 lambda 块体；值是最后一条表达式的值，return 由调用方捕获。
  execLambdaBody(body) {
    this.pushScope(new Map());
    let result = undefined;
    try {
      for (const st of body.body) {
        if (st.type === 'expr') result = this.evalExpr(st.expr);
        else {
          this.execStmt(st);
          result = undefined;
        }
      }
    } finally {
      this.popScope();
    }
    return result;
  }

  callUserFunc(fn, args, node) {
    if (!fn) throw runtimeError('function not found', node);
    if (this.funcDepth >= MAX_RECURSION_DEPTH) {
      throw runtimeError(`maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded`, node);
    }
    this.funcDepth++;
    const prevInFunction = this.inFunction;
    this.inFunction = true;

    this.pushScope(new Map());
    for (let i = 0; i < fn.params.length; i++) {
      this.currentScope().set(fn.params[i], i < args.length ? args[i] : undefined);
    }

    let result = undefined;
    try {
      this.execStmt(fn.body);
    } catch (f) {
      if (f instanceof Flow && f.kind === 'return') result = f.value;
      else throw f;
    } finally {
      this.popScope();
      this.inFunction = prevInFunction;
      this.funcDepth--;
    }
    return result;
  }
}

/* —— 粒子 / this 字段读取写入 —— */

function ensureOut(ctx) {
  if (!ctx) ctx = {};
  if (!ctx.out) ctx.out = {};
  const out = ctx.out;
  if (!Array.isArray(out.pos)) out.pos = [0, 0, 0];
  if (!Array.isArray(out.color)) out.color = [1, 1, 1, 1];
  if (!Array.isArray(out.vel)) out.vel = [0, 0, 0];
  if (!isNum(out.scale)) out.scale = 1;
  if (!isBool(out.glow)) out.glow = false;
  if (!isNum(out.light)) out.light = 0;
  if (!isNum(out.life)) out.life = -1;
  return out;
}

// 当前函数对象运行时上下文（setup 用 env，tick/process 用 ctx）。
function fxRuntime(rt) {
  return rt.phase === 'setup' ? rt.env : rt.ctx;
}

function ctxRead(field, rt, node) {
  if (rt.phase === 'expr') {
    // 单表达式上下文（UV 字段表达式等）：保留旧 index/count/time/delta/duration/uv 与输出字段。
    const c = rt.ctx || null;
    if (field === 'index') return c && c.i != null ? c.i : 0;
    if (field === 'count') return c && c.n != null ? c.n : 0;
    if (field === 'time') return c && c.t != null ? c.t : 0;
    if (field === 'delta') return c && c.dt != null ? c.dt : 0;
    if (field === 'duration') return c && c.duration != null ? c.duration : 0;
    if (field === 'uv') return vec2(
      c && c.uv_x != null ? c.uv_x : 0,
      c && c.uv_y != null ? c.uv_y : 0,
    );
    const out = ensureOut(c);
    switch (field) {
      case 'position': return vec3(out.pos[0], out.pos[1], out.pos[2]);
      case 'color': return vec4(out.color[0], out.color[1], out.color[2], out.color[3]);
      case 'velocity': return vec3(out.vel[0], out.vel[1], out.vel[2]);
      case 'scale': return out.scale;
      case 'glow': return out.glow;
      case 'light': return out.light;
      case 'life': return out.life;
      default: throw runtimeError(`unknown this field '.${field}'`, node);
    }
  }

  if (rt.phase === 'toplevel') {
    throw runtimeError(`this.${field} is not available here`, node);
  }
  const fx = fxRuntime(rt) || null;
  const t = fx && fx.t != null ? fx.t : 0;
  const st = fx && fx.st != null ? fx.st : 0;
  if (field === 'time') return t - st;
  if (field === 'animTime') return t;
  if (field === 'duration') {
    const d = fx && fx.duration != null ? fx.duration : 0;
    return d > 0 ? d : (fx && fx.maxMs != null ? fx.maxMs : 0);
  }
  if (field === 'particles') return particleList(fx && Array.isArray(fx.particles) ? fx.particles : []);
  throw runtimeError(`this.${field} is not available here`, node);
}

function ctxWrite(field, value, rt, node) {
  throw runtimeError(`this.${field} is read-only`, node);
}

function vecFieldValues(value, len, what, node) {
  if (isVec(value)) {
    if (vecDim(value) !== len) {
      throw runtimeError(`${what} requires a vec${len}, got ${typeName(value)}`, node);
    }
    return vecComps(value);
  }
  if (Array.isArray(value)) {
    if (value.length !== len) {
      throw runtimeError(`${what} requires an array of ${len} numbers, got length ${value.length}`, node);
    }
    return value.map((x, i) => expectNum(x, `${what}[${i}]`, node));
  }
  throw runtimeError(`${what} requires a vec${len} or array of ${len} numbers, got ${typeName(value)}`, node);
}

function writeParticleColor(w, value, node) {
  if (isColor(value)) {
    w.color[0] = clamp01(value.r);
    w.color[1] = clamp01(value.g);
    w.color[2] = clamp01(value.b);
    w.color[3] = clamp01(value.a);
    return;
  }
  if (isVec(value)) {
    if (value.t === 'vec3') {
      w.color[0] = clamp01(value.x);
      w.color[1] = clamp01(value.y);
      w.color[2] = clamp01(value.z);
      return;
    }
    if (value.t === 'vec4') {
      w.color[0] = clamp01(value.x);
      w.color[1] = clamp01(value.y);
      w.color[2] = clamp01(value.z);
      w.color[3] = clamp01(value.w);
      return;
    }
  } else if (Array.isArray(value)) {
    if (value.length === 3) {
      w.color[0] = clamp01(expectNum(value[0], 'particle.color[0]', node));
      w.color[1] = clamp01(expectNum(value[1], 'particle.color[1]', node));
      w.color[2] = clamp01(expectNum(value[2], 'particle.color[2]', node));
      return;
    }
    if (value.length === 4) {
      w.color[0] = clamp01(expectNum(value[0], 'particle.color[0]', node));
      w.color[1] = clamp01(expectNum(value[1], 'particle.color[1]', node));
      w.color[2] = clamp01(expectNum(value[2], 'particle.color[2]', node));
      w.color[3] = clamp01(expectNum(value[3], 'particle.color[3]', node));
      return;
    }
  }
  throw runtimeError(`particle.color requires a color, vec3, vec4, [r,g,b] or [r,g,b,a], got ${typeName(value)}`, node);
}

function particleGetField(pv, field, node) {
  const w = pv.w;
  switch (field) {
    case 'position': return vec3(w.pos[0], w.pos[1], w.pos[2]);
    case 'color': return color(w.color[0], w.color[1], w.color[2], w.color[3]);
    case 'velocity': return vec3(w.vel[0], w.vel[1], w.vel[2]);
    case 'scale': return w.scale;
    case 'glow': return w.glow;
    case 'light': return w.light;
    case 'life': return w.life;
    case 'index': return w.index;
    default: {
      const cf = w.cf;
      return (cf && cf[field] !== undefined) ? cf[field] : undefined;
    }
  }
}

function particleSetField(pv, field, value, node) {
  const w = pv.w;
  switch (field) {
    case 'position': {
      const c = vecFieldValues(value, 3, 'particle.position', node);
      w.pos[0] = c[0]; w.pos[1] = c[1]; w.pos[2] = c[2];
      return;
    }
    case 'velocity': {
      const c = vecFieldValues(value, 3, 'particle.velocity', node);
      w.vel[0] = c[0]; w.vel[1] = c[1]; w.vel[2] = c[2];
      return;
    }
    case 'color':
      writeParticleColor(w, value, node);
      return;
    case 'scale':
      w.scale = expectNum(value, 'particle.scale', node);
      return;
    case 'glow':
      if (!isNum(value) && !isBool(value)) {
        throw runtimeError(`particle.glow requires a num/bool, got ${typeName(value)}`, node);
      }
      w.glow = value > 0.5;
      return;
    case 'light':
      w.light = Math.max(0, Math.min(15, Math.round(expectNum(value, 'particle.light', node))));
      return;
    case 'life': {
      const v = Math.round(expectNum(value, 'particle.life', node));
      w.life = Number.isFinite(v) ? (v < 0 ? -1 : v) : -1;
      return;
    }
    case 'index':
      throw runtimeError('particle.index is read-only', node);
    default: {
      if (!w.cf) w.cf = Object.create(null);
      w.cf[field] = value;
      return;
    }
  }
}

function particleKill(pv, node) {
  const w = pv.w;
  if (typeof w.kill === 'function') w.kill();
  else w.alive = false;
}

// apply 块的接收者作用域：裸名按粒子字段读写，粒子无该字段时回退外层作用域。
const PARTICLE_FIELDS = new Set(['position', 'color', 'velocity', 'scale', 'glow', 'light', 'life', 'index']);

function particleHasField(pv, name) {
  if (PARTICLE_FIELDS.has(name)) return true;
  const cf = pv.w.cf;
  return !!(cf && (name in cf));
}

class ParticleScope {
  constructor(pv) { this.pv = pv; }
  has(name) { return particleHasField(this.pv, name); }
  get(name) { return particleGetField(this.pv, name, null); }
  set(name, value) { particleSetField(this.pv, name, value, null); }
}

function colorCompRead(c, comp, node) {
  try { return colorComponent(c, comp); } catch (e) { throw runtimeError(e.message, node); }
}

function colorCompWrite(c, comp, value, node) {
  try { return colorWithComponent(c, comp, value); } catch (e) { throw runtimeError(e.message, node); }
}

function callVecMethod(v, method, args, node) {
  const impl = VEC_METHODS[method];
  if (!impl) throw runtimeError(`vector has no method '.${method}()'`, node);
  try { return impl(v, args); } catch (e) { throw runtimeError(e.message, node); }
}

function callColorMethod(c, method, args, node) {
  const impl = COLOR_METHODS[method];
  if (!impl) throw runtimeError(`color has no method '.${method}()'`, node);
  try { return impl(c, args); } catch (e) { throw runtimeError(e.message, node); }
}

function setVecComp(v, comp, value) {
  if (v.t === 'vec2') {
    return vec2(comp === 'x' ? value : v.x, comp === 'y' ? value : v.y);
  }
  if (v.t === 'vec3') {
    return vec3(
      comp === 'x' ? value : v.x,
      comp === 'y' ? value : v.y,
      comp === 'z' ? value : v.z,
    );
  }
  return vec4(
    comp === 'x' ? value : v.x,
    comp === 'y' ? value : v.y,
    comp === 'z' ? value : v.z,
    comp === 'w' ? value : v.w,
  );
}

function unpackValues(v, count, node) {
  if (isVec(v)) {
    const comps = vecComps(v);
    if (comps.length !== count) {
      throw runtimeError(`cannot unpack ${comps.length} components into ${count} names`, node);
    }
    return comps;
  }
  if (Array.isArray(v)) {
    if (v.length !== count) {
      throw runtimeError(`cannot unpack array of length ${v.length} into ${count} names`, node);
    }
    return v;
  }
  throw runtimeError(`unpack requires a vector or array, got ${typeName(v)}`, node);
}

function truthy(v, node) {
  if (v === undefined) return false;
  if (isBool(v)) return v;
  if (isNum(v)) return v !== 0;
  throw runtimeError(`condition requires a num/bool, got ${typeName(v)}`, node);
}

function incDecValue(v, op, node) {
  const n = expectNum(v, op === '++' ? "'++' operand" : "'--' operand", node);
  return op === '++' ? n + 1 : n - 1;
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const clampNum = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// —— 运算 ——

function binaryOp(op, a, b, node) {
  switch (op) {
    case '+': {
      if (isNum(a) && isNum(b)) return a + b;
      if (isVec(a) && isVec(b)) {
        sameDimVec(a, b, node);
        const ca = vecComps(a), cb = vecComps(b);
        return mkVec(vecDim(a), ca.map((x, i) => x + cb[i]));
      }
      if (isMat(a) && isMat(b)) {
        if (a.t !== b.t) throw runtimeError('matrix dimension mismatch', node);
        const m = a.m.map((row, i) => row.map((x, j) => x + b.m[i][j]));
        return a.t === 'mat3' ? mat3(m) : mat4(m);
      }
      throw runtimeError(`operator '+' not supported for ${typeName(a)} and ${typeName(b)}`, node);
    }
    case '-': {
      if (isNum(a) && isNum(b)) return a - b;
      if (isVec(a) && isVec(b)) {
        sameDimVec(a, b, node);
        const ca = vecComps(a), cb = vecComps(b);
        return mkVec(vecDim(a), ca.map((x, i) => x - cb[i]));
      }
      if (isMat(a) && isMat(b)) {
        if (a.t !== b.t) throw runtimeError('matrix dimension mismatch', node);
        const m = a.m.map((row, i) => row.map((x, j) => x - b.m[i][j]));
        return a.t === 'mat3' ? mat3(m) : mat4(m);
      }
      throw runtimeError(`operator '-' not supported for ${typeName(a)} and ${typeName(b)}`, node);
    }
    case '*': {
      if (isMat(a)) {
        if (isMat(b)) return matMul(a, b, node);
        if (isVec(b)) return matVecMul(a, b, node);
        if (isNum(b)) return matScale(a, b);
      }
      if (isVec(a)) {
        if (isNum(b)) {
          const c = vecComps(a).map((x) => x * b);
          return mkVec(vecDim(a), c);
        }
        if (isVec(b)) {
          sameDimVec(a, b, node);
          const ca = vecComps(a), cb = vecComps(b);
          return mkVec(vecDim(a), ca.map((x, i) => x * cb[i]));
        }
      }
      if (isNum(a)) {
        if (isNum(b)) return a * b;
        if (isVec(b)) {
          const c = vecComps(b).map((x) => a * x);
          return mkVec(vecDim(b), c);
        }
        if (isMat(b)) return matScale(b, a);
      }
      throw runtimeError(`operator '*' not supported for ${typeName(a)} and ${typeName(b)}`, node);
    }
    case '/': {
      if (isNum(a) && isNum(b)) {
        if (b === 0) throw runtimeError('division by zero', node);
        return a / b;
      }
      if (isVec(a) && isNum(b)) {
        if (b === 0) throw runtimeError('division by zero', node);
        const c = vecComps(a).map((x) => x / b);
        return mkVec(vecDim(a), c);
      }
      if (isMat(a) && isNum(b)) {
        if (b === 0) throw runtimeError('division by zero', node);
        return matScale(a, 1 / b);
      }
      throw runtimeError(`operator '/' not supported for ${typeName(a)} and ${typeName(b)}`, node);
    }
    case '%': {
      if (isNum(a) && isNum(b)) return a % b;
      throw runtimeError(`operator '%' only supports nums, got ${typeName(a)} and ${typeName(b)}`, node);
    }
    case '^': {
      if (isNum(a) && isNum(b)) return Math.pow(a, b);
      throw runtimeError(`operator '^' only supports nums, got ${typeName(a)} and ${typeName(b)}`, node);
    }
    case '==': return eqExact(a, b);
    case '!=': return !eqExact(a, b);
    case '<': case '<=': case '>': case '>=': {
      if (!isNum(a) && !isBool(a)) throw runtimeError(`operator '${op}' requires num/bool, got ${typeName(a)}`, node);
      if (!isNum(b) && !isBool(b)) throw runtimeError(`operator '${op}' requires num/bool, got ${typeName(b)}`, node);
      const an = isNum(a) ? a : (a ? 1 : 0);
      const bn = isNum(b) ? b : (b ? 1 : 0);
      switch (op) {
        case '<': return an < bn;
        case '<=': return an <= bn;
        case '>': return an > bn;
        case '>=': return an >= bn;
        default: return false;
      }
    }
    default:
      throw runtimeError(`unknown operator '${op}'`, node);
  }
}

function matScale(m, s) {
  const out = m.m.map((row) => row.map((x) => x * s));
  return m.t === 'mat3' ? mat3(out) : mat4(out);
}

function matMul(a, b, node) {
  if (a.t !== b.t) throw runtimeError('matrix dimension mismatch', node);
  const n = a.t === 'mat3' ? 3 : 4;
  const out = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += a.m[i][k] * b.m[k][j];
      out[i][j] = s;
    }
  }
  return a.t === 'mat3' ? mat3(out) : mat4(out);
}

function matVecMul(m, v, node) {
  if (m.t === 'mat3') {
    if (vecDim(v) !== 3) throw runtimeError('mat3 requires a vec3 operand', node);
    const mm = m.m;
    return vec3(
      mm[0][0] * v.x + mm[0][1] * v.y + mm[0][2] * v.z,
      mm[1][0] * v.x + mm[1][1] * v.y + mm[1][2] * v.z,
      mm[2][0] * v.x + mm[2][1] * v.y + mm[2][2] * v.z,
    );
  }
  // mat4 * vec4：完整 4x4 变换。
  if (vecDim(v) === 4) {
    const mm = m.m;
    return vec4(
      mm[0][0] * v.x + mm[0][1] * v.y + mm[0][2] * v.z + mm[0][3] * v.w,
      mm[1][0] * v.x + mm[1][1] * v.y + mm[1][2] * v.z + mm[1][3] * v.w,
      mm[2][0] * v.x + mm[2][1] * v.y + mm[2][2] * v.z + mm[2][3] * v.w,
      mm[3][0] * v.x + mm[3][1] * v.y + mm[3][2] * v.z + mm[3][3] * v.w,
    );
  }
  // mat4 * vec3：按仿射变换（w = 1），忽略第 4 行。
  if (vecDim(v) !== 3) throw runtimeError('mat4 requires a vec3 or vec4 operand', node);
  const mm = m.m;
  return vec3(
    mm[0][0] * v.x + mm[0][1] * v.y + mm[0][2] * v.z + mm[0][3],
    mm[1][0] * v.x + mm[1][1] * v.y + mm[1][2] * v.z + mm[1][3],
    mm[2][0] * v.x + mm[2][1] * v.y + mm[2][2] * v.z + mm[2][3],
  );
}

// —— 数组方法与集合内建 ——

function sliceIndex(n, size) {
  let k = Math.trunc(n);
  if (k < 0) k = Math.max(size + k, 0);
  else k = Math.min(k, size);
  return k;
}

function arrayUnique(arr) {
  const out = [];
  for (const x of arr) {
    if (!out.some((y) => eqTol(x, y))) out.push(x);
  }
  return out;
}

function arraySort(arr, cmpVal, rt, node) {
  if (cmpVal === undefined) {
    arr.sort((a, b) => defaultCompare(a, b, node));
    return arr;
  }
  if (!isCallable(cmpVal)) {
    throw runtimeError(`sort comparator must be a function, got ${typeName(cmpVal)}`, node);
  }
  arr.sort((a, b) => {
    const res = rt.callValue(cmpVal, [a, b], node);
    if (!isNum(res)) throw runtimeError('comparator function must return a num', node);
    return res;
  });
  return arr;
}

function applyArrayMethod(arr, method, args, rt, node) {
  switch (method) {
    case 'push': {
      if (args.length !== 1) throw runtimeError('push expects 1 argument', node);
      arr.push(args[0]);
      return arr;
    }
    case 'insert': {
      if (args.length !== 2) throw runtimeError('insert expects 2 arguments', node);
      const idx = expectInt(args[0], 'insert index', node);
      if (idx < 0 || idx > arr.length) {
        throw runtimeError(`insert index ${idx} out of bounds (size ${arr.length})`, node);
      }
      arr.splice(idx, 0, args[1]);
      return arr;
    }
    case 'remove': {
      if (args.length !== 1) throw runtimeError('remove expects 1 argument', node);
      const idx = expectInt(args[0], 'remove index', node);
      if (idx < 0 || idx >= arr.length) {
        throw runtimeError(`remove index ${idx} out of bounds (size ${arr.length})`, node);
      }
      arr.splice(idx, 1);
      return arr;
    }
    case 'slice': {
      const size = arr.length;
      let start = 0;
      let end = size;
      if (args.length >= 1) start = sliceIndex(expectNum(args[0], 'slice start', node), size);
      if (args.length >= 2) end = sliceIndex(expectNum(args[1], 'slice end', node), size);
      if (args.length > 2) throw runtimeError('slice expects at most 2 arguments', node);
      if (start > end) return [];
      return arr.slice(start, end);
    }
    case 'size': {
      if (args.length !== 0) throw runtimeError('size expects no arguments', node);
      return arr.length;
    }
    case 'find': {
      if (args.length !== 1) throw runtimeError('find expects 1 argument', node);
      for (let i = 0; i < arr.length; i++) if (eqTol(arr[i], args[0])) return i;
      return -1;
    }
    case 'includes': {
      if (args.length !== 1) throw runtimeError('includes expects 1 argument', node);
      for (const x of arr) if (eqTol(x, args[0])) return true;
      return false;
    }
    case 'sort': {
      if (args.length > 1) throw runtimeError('sort expects at most 1 argument', node);
      return arraySort(arr, args.length === 1 ? args[0] : undefined, rt, node);
    }
    case 'unique': {
      if (args.length !== 0) throw runtimeError('unique expects no arguments', node);
      return arrayUnique(arr);
    }
    case 'reverse': {
      if (args.length !== 0) throw runtimeError('reverse expects no arguments', node);
      arr.reverse();
      return arr;
    }
    default:
      throw runtimeError(`unknown array method '.${method}()'`, node);
  }
}

// —— 向量 / 矩阵内建函数 ——

function normalizeVec3(v, node) {
  const l = Math.hypot(v.x, v.y, v.z);
  if (l === 0) throw runtimeError('cannot normalize a zero-length vector', node);
  return vec3(v.x / l, v.y / l, v.z / l);
}

function mat3FromRows(r0, r1, r2) {
  return mat3([
    [r0.x, r0.y, r0.z],
    [r1.x, r1.y, r1.z],
    [r2.x, r2.y, r2.z],
  ]);
}

function mapComponents(v, fn, node) {
  if (isNum(v)) return fn(v);
  if (isVec(v)) {
    const c = vecComps(v).map(fn);
    return mkVec(vecDim(v), c);
  }
  if (isMat(v)) {
    const m = v.m.map((row) => row.map(fn));
    return v.t === 'mat3' ? mat3(m) : mat4(m);
  }
  throw runtimeError(`operation not supported for ${typeName(v)}`, node);
}

function lerpImpl(a, b, t, node) {
  expectNum(t, 'lerp t', node);
  if (isNum(a) && isNum(b)) return a + (b - a) * t;
  if (isVec(a) && isVec(b)) {
    sameDimVec(a, b, node);
    const ca = vecComps(a), cb = vecComps(b);
    return mkVec(vecDim(a), ca.map((x, i) => x + (cb[i] - x) * t));
  }
  throw runtimeError(`lerp requires two nums or two vectors, got ${typeName(a)} and ${typeName(b)}`, node);
}

function clampImpl(v, lo, hi, node) {
  if (isNum(v)) {
    expectNum(lo, 'clamp lo', node);
    expectNum(hi, 'clamp hi', node);
    return clampNum(v, lo, hi);
  }
  if (isVec(v)) {
    const dim = vecDim(v);
    const comps = vecComps(v);
    const out = comps.map((x, i) => {
      let l = lo;
      let h = hi;
      if (isVec(lo)) { if (vecDim(lo) !== dim) throw runtimeError('clamp bound dimension mismatch', node); l = vecComps(lo)[i]; }
      else expectNum(lo, 'clamp lo', node);
      if (isVec(hi)) { if (vecDim(hi) !== dim) throw runtimeError('clamp bound dimension mismatch', node); h = vecComps(hi)[i]; }
      else expectNum(hi, 'clamp hi', node);
      return clampNum(x, l, h);
    });
    return mkVec(dim, out);
  }
  throw runtimeError(`clamp not supported for ${typeName(v)}`, node);
}

// —— 内建函数表 ——


function builtin(name, minArgs, maxArgs, impl) {
  return [name, { min: minArgs, max: maxArgs, impl }];
}

function checkArity(name, args, min, max, node) {
  if (args.length < min || (max != null && args.length > max)) {
    const want = max == null ? `at least ${min}` : (min === max ? `${min}` : `${min}..${max}`);
    throw runtimeError(`${name} expects ${want} argument(s), got ${args.length}`, node);
  }
}

const BUILTIN_TABLE = new Map([
  // —— 调试（print 输出到终端；assert 全阶段可用）——
  builtin('print', 0, null, (args, rt, node) => {
    const line = args.map(formatValue).join(' ');
    const out = (rt.phase === 'setup' ? rt.env : rt.ctx);
    if (out && typeof out.print === 'function') out.print(line);
    else console.log(line);
    return 0;
  }),
  builtin('assert', 2, 2, (args, rt, node) => {
    if (!truthy(args[0], node)) throw new Error(String(args[1]));
    return 0;
  }),

  // —— 构造 / 变换 ——
  builtin('vec2', 2, 2, (args, rt, node) => vec2(expectNum(args[0], 'vec2', node), expectNum(args[1], 'vec2', node))),
  builtin('vec3', 3, 3, (args, rt, node) => vec3(expectNum(args[0], 'vec3', node), expectNum(args[1], 'vec3', node), expectNum(args[2], 'vec3', node))),
  builtin('vec4', 4, 4, (args, rt, node) => vec4(expectNum(args[0], 'vec4', node), expectNum(args[1], 'vec4', node), expectNum(args[2], 'vec4', node), expectNum(args[3], 'vec4', node))),
  builtin('vec', 3, 3, (args, rt, node) => vec3(expectNum(args[0], 'vec', node), expectNum(args[1], 'vec', node), expectNum(args[2], 'vec', node))),
  builtin('mat3', 3, 3, (args, rt, node) => {
    const r0 = expectVec(args[0], 'mat3', node);
    const r1 = expectVec(args[1], 'mat3', node);
    const r2 = expectVec(args[2], 'mat3', node);
    if (vecDim(r0) !== 3 || vecDim(r1) !== 3 || vecDim(r2) !== 3) {
      throw runtimeError('mat3 rows must be vec3', node);
    }
    return mat3FromRows(r0, r1, r2);
  }),
  builtin('mat4', 4, 4, (args, rt, node) => {
    const rows = [];
    for (let i = 0; i < 4; i++) {
      const r = expectVec(args[i], 'mat4', node);
      if (vecDim(r) !== 4) throw runtimeError('mat4 rows must be vec4', node);
      rows.push([r.x, r.y, r.z, r.w]);
    }
    return mat4(rows);
  }),

  builtin('norm', 2, 2, (args, rt, node) => {
    const a = expectInt(args[0], 'norm', node);
    const b = expectInt(args[1], 'norm', node);
    if (a < 0 || b < 0) throw runtimeError('norm requires non-negative integers', node);
    return a / Math.max(b - 1, 1);
  }),

  // —— 数学与钳制 ——
  builtin('clamp', 3, 3, (args, rt, node) => clampImpl(args[0], args[1], args[2], node)),
  builtin('map_range', 5, 5, (args, rt, node) => {
    const val = expectNum(args[0], 'map_range', node);
    const in1 = expectNum(args[1], 'map_range', node);
    const in2 = expectNum(args[2], 'map_range', node);
    const out1 = expectNum(args[3], 'map_range', node);
    const out2 = expectNum(args[4], 'map_range', node);
    if (in1 === in2) throw runtimeError('map_range input range is empty', node);
    return out1 + ((val - in1) / (in2 - in1)) * (out2 - out1);
  }),
  builtin('remap', 5, 5, (args, rt, node) => {
    const val = expectNum(args[0], 'remap', node);
    const in1 = expectNum(args[1], 'remap', node);
    const in2 = expectNum(args[2], 'remap', node);
    const out1 = expectNum(args[3], 'remap', node);
    const out2 = expectNum(args[4], 'remap', node);
    if (in1 === in2) throw runtimeError('remap input range is empty', node);
    const r = out1 + ((val - in1) / (in2 - in1)) * (out2 - out1);
    return clampNum(r, Math.min(out1, out2), Math.max(out1, out2));
  }),
  builtin('int', 1, 1, (args, rt, node) => {
    const v = args[0];
    if (isBool(v)) throw runtimeError(`int does not accept bool`, node);
    return mapComponents(v, Math.trunc, node);
  }),
  builtin('float', 1, 1, (args, rt, node) => {
    const v = args[0];
    if (isBool(v)) throw runtimeError(`float does not accept bool`, node);
    return mapComponents(v, (x) => x, node);
  }),
  builtin('bool', 1, 1, (args, rt, node) => {
    const v = args[0];
    if (v === undefined) return false;
    if (!isNum(v) && !isBool(v)) throw runtimeError(`bool requires a num/bool, got ${typeName(v)}`, node);
    return isBool(v) ? v : v !== 0;
  }),

  // —— 标量数学 ——
  builtin('sin', 1, 1, (args, rt, node) => Math.sin(expectNum(args[0], 'sin', node))),
  builtin('cos', 1, 1, (args, rt, node) => Math.cos(expectNum(args[0], 'cos', node))),
  builtin('tan', 1, 1, (args, rt, node) => Math.tan(expectNum(args[0], 'tan', node))),
  builtin('asin', 1, 1, (args, rt, node) => Math.asin(expectNum(args[0], 'asin', node))),
  builtin('acos', 1, 1, (args, rt, node) => Math.acos(expectNum(args[0], 'acos', node))),
  builtin('atan', 1, 1, (args, rt, node) => Math.atan(expectNum(args[0], 'atan', node))),
  builtin('atan2', 2, 2, (args, rt, node) => Math.atan2(expectNum(args[0], 'atan2', node), expectNum(args[1], 'atan2', node))),
  builtin('sqrt', 1, 1, (args, rt, node) => Math.sqrt(expectNum(args[0], 'sqrt', node))),
  builtin('abs', 1, 1, (args, rt, node) => Math.abs(expectNum(args[0], 'abs', node))),
  builtin('sign', 1, 1, (args, rt, node) => Math.sign(expectNum(args[0], 'sign', node))),
  builtin('exp', 1, 1, (args, rt, node) => Math.exp(expectNum(args[0], 'exp', node))),
  // 与既有表达式引擎一致：log 与 ln 都取自然对数。
  builtin('log', 1, 1, (args, rt, node) => Math.log(expectNum(args[0], 'log', node))),
  builtin('ln', 1, 1, (args, rt, node) => Math.log(expectNum(args[0], 'ln', node))),
  builtin('floor', 1, 1, (args, rt, node) => Math.floor(expectNum(args[0], 'floor', node))),
  builtin('ceil', 1, 1, (args, rt, node) => Math.ceil(expectNum(args[0], 'ceil', node))),
  builtin('round', 1, 1, (args, rt, node) => Math.round(expectNum(args[0], 'round', node))),
  builtin('fract', 1, 1, (args, rt, node) => { const x = expectNum(args[0], 'fract', node); return x - Math.floor(x); }),
  builtin('pow', 2, 2, (args, rt, node) => Math.pow(expectNum(args[0], 'pow', node), expectNum(args[1], 'pow', node))),
  builtin('min', 2, 2, (args, rt, node) => Math.min(expectNum(args[0], 'min', node), expectNum(args[1], 'min', node))),
  builtin('max', 2, 2, (args, rt, node) => Math.max(expectNum(args[0], 'max', node), expectNum(args[1], 'max', node))),
  builtin('step', 2, 2, (args, rt, node) => (expectNum(args[1], 'step', node) >= expectNum(args[0], 'step', node) ? 1 : 0)),
  builtin('smoothstep', 3, 3, (args, rt, node) => {
    const e0 = expectNum(args[0], 'smoothstep', node);
    const e1 = expectNum(args[1], 'smoothstep', node);
    const x = expectNum(args[2], 'smoothstep', node);
    const t = clampNum((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  }),
  builtin('mod', 2, 2, (args, rt, node) => {
    const a = expectNum(args[0], 'mod', node);
    const b = expectNum(args[1], 'mod', node);
    if (b === 0) throw runtimeError('mod by zero', node);
    return a - b * Math.floor(a / b);
  }),

  // —— 噪声与随机 ——
  builtin('noise', 3, 4, (args, rt, node) => {
    const x = expectNum(args[0], 'noise', node);
    const y = expectNum(args[1], 'noise', node);
    const z = expectNum(args[2], 'noise', node);
    const seed = args.length >= 4 ? (expectNum(args[3], 'noise seed', node) | 0) : rt.objState.seed;
    return noise3D(x, y, z, seed);
  }),
  builtin('fbm', 4, 5, (args, rt, node) => {
    const x = expectNum(args[0], 'fbm', node);
    const y = expectNum(args[1], 'fbm', node);
    const z = expectNum(args[2], 'fbm', node);
    let octaves = Math.trunc(expectNum(args[3], 'fbm octaves', node));
    if (octaves < 1) throw runtimeError('fbm octaves must be at least 1', node);
    if (octaves > MAX_FBM_OCTAVES) throw runtimeError(`fbm octaves must be at most ${MAX_FBM_OCTAVES}`, node);
    const seed = args.length >= 5 ? (expectNum(args[4], 'fbm seed', node) | 0) : rt.objState.seed;

    // lacunarity = 2.0, gain = 0.5；累加后除以幅度和，再 clamp 到 [-1,1]。
    let amp = 1.0;
    let freq = 1.0;
    let sum = 0.0;
    let ampSum = 0.0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * noise3D(x * freq, y * freq, z * freq, seed);
      ampSum += amp;
      amp *= 0.5;
      freq *= 2.0;
    }
    const out = sum / ampSum;
    return Math.max(-1, Math.min(1, out));
  }),
  builtin('rand', 0, 1, (args, rt, node) => {
    if (args.length === 0) return rt.objState.rand();
    return mulberry32((expectNum(args[0], 'rand seed', node) | 0))();
  }),
  builtin('random', 0, 0, (args, rt, node) => Math.random()),

  // —— 哈希 / 阶段 / 集合辅助 ——
  builtin('hash', 2, 2, (args, rt, node) => {
    const seed = expectInt(args[0], 'hash seed', node);
    const salt = expectInt(args[1], 'hash salt', node);
    let x = ((seed ^ salt) + 0x9e3779b9) | 0;
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) | 0;
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) | 0;
    x = x ^ (x >>> 16);
    return ((x >>> 0) & 0x7fffffff) / 2147483648.0;
  }),
  builtin('phases', 2, 2, (args, rt, node) => {
    const t = expectNum(args[0], 'phases', node);
    const src = args[1];
    if (!isObj(src)) throw runtimeError(`phases requires an object, got ${typeName(src)}`, node);
    const out = new Map();
    for (const [k, range] of src.fields) {
      if (!Array.isArray(range) || range.length !== 2) {
        throw runtimeError(`phases key '${k}' requires a [a,b] array`, node);
      }
      const a = expectNum(range[0], `phases '${k}' range[0]`, node);
      const b = expectNum(range[1], `phases '${k}' range[1]`, node);
      const tt = clampNum((t - a) / (b - a), 0, 1);
      out.set(k, tt * tt * (3 - 2 * tt));
    }
    return { t: 'obj', fields: out };
  }),
  builtin('repeat', 2, 2, (args, rt, node) => {
    const n = Math.trunc(expectNum(args[0], 'repeat count', node));
    const fn = args[1];
    if (!isCallable(fn)) throw runtimeError(`repeat requires a function, got ${typeName(fn)}`, node);
    for (let i = 0; i < n; i++) {
      if (i >= MAX_LOOP_ITERATIONS) {
        throw runtimeError(`loop iteration limit (${MAX_LOOP_ITERATIONS}) exceeded`, node);
      }
      rt.guardLoop(node);
      rt.callValue(fn, [i], node);
    }
    return 0;
  }),

  // —— 颜色 ——
  builtin('color', 4, 4, (args, rt, node) => color(
    expectNum(args[0], 'color', node),
    expectNum(args[1], 'color', node),
    expectNum(args[2], 'color', node),
    expectNum(args[3], 'color', node),
  )),

  // —— 缓动 ——
  builtin('ease_linear', 3, 3, (args, rt, node) => {
    const a = expectNum(args[0], 'ease_linear', node);
    const b = expectNum(args[1], 'ease_linear', node);
    const t = expectNum(args[2], 'ease_linear', node);
    return a + (b - a) * t;
  }),
  builtin('ease_in_out', 3, 3, (args, rt, node) => {
    const a = expectNum(args[0], 'ease_in_out', node);
    const b = expectNum(args[1], 'ease_in_out', node);
    const t = clampNum(expectNum(args[2], 'ease_in_out', node), 0, 1);
    return a + (b - a) * t * t * (3 - 2 * t);
  }),
  builtin('ease_out_back', 3, 3, (args, rt, node) => {
    const a = expectNum(args[0], 'ease_out_back', node);
    const b = expectNum(args[1], 'ease_out_back', node);
    const t = clampNum(expectNum(args[2], 'ease_out_back', node), 0, 1);
    const c1 = 1.70158;
    const u = t - 1;
    return a + (b - a) * (1 + (c1 + 1) * u * u * u + c1 * u * u);
  }),
  builtin('ease_in_elastic', 3, 3, (args, rt, node) => {
    const a = expectNum(args[0], 'ease_in_elastic', node);
    const b = expectNum(args[1], 'ease_in_elastic', node);
    const t = clampNum(expectNum(args[2], 'ease_in_elastic', node), 0, 1);
    let v;
    if (t === 0) v = 0;
    else if (t === 1) v = 1;
    else v = -Math.pow(2, 10 * (t - 1)) * Math.sin((t * 10 - 10.75) * (2 * Math.PI) / 3);
    return a + (b - a) * v;
  }),

  // —— 集合 ——
  builtin('unique', 1, 1, (args, rt, node) => arrayUnique(expectArr(args[0], 'unique', node))),
  builtin('reverse', 1, 1, (args, rt, node) => {
    const arr = expectArr(args[0], 'reverse', node);
    arr.reverse();
    return arr;
  }),
  builtin('sort', 1, 2, (args, rt, node) => {
    const arr = expectArr(args[0], 'sort', node);
    return arraySort(arr, args.length >= 2 ? args[1] : undefined, rt, node);
  }),
]);

// 内建函数归类。默认全部可见，本轮无 import 语法。
const BUILTIN_PKG = {
  print: 'debug', assert: 'debug',
  vec2: 'vec', vec3: 'vec', vec4: 'vec', vec: 'vec', mat3: 'vec',
  translate: 'vec', scale: 'vec', rotate: 'vec', lookAt: 'vec',
  rotX: 'vec', rotY: 'vec', rotZ: 'vec', rotAxis: 'vec',
  rotateX: 'vec', rotateY: 'vec', rotateZ: 'vec',
  norm: 'math',
  clamp: 'math', map_range: 'math', remap: 'math', int: 'math', float: 'math', bool: 'math',
  sin: 'math', cos: 'math', tan: 'math', asin: 'math', acos: 'math', atan: 'math', atan2: 'math',
  sqrt: 'math', abs: 'math', sign: 'math', exp: 'math', log: 'math', ln: 'math',
  floor: 'math', ceil: 'math', round: 'math', fract: 'math', pow: 'math', min: 'math', max: 'math',
  step: 'math', smoothstep: 'math', mod: 'math',
  hash: 'math',
  noise: 'noise', fbm: 'noise', rand: 'noise', random: 'noise',
  ease_linear: 'ease', ease_in_out: 'ease', ease_out_back: 'ease', ease_in_elastic: 'ease',
  phases: 'collection', repeat: 'collection', unique: 'collection', reverse: 'collection', sort: 'collection',
  color: 'color', red: 'color', green: 'color', blue: 'color', alpha: 'color',
  hue: 'color', saturation: 'color', value: 'color', rgb2hsv: 'color', hsv2rgb: 'color',
};
for (const [name, entry] of BUILTIN_TABLE) {
  entry.pkg = BUILTIN_PKG[name] || 'math';
}

function callBuiltin(name, args, rt, node) {
  const entry = BUILTIN_TABLE.get(name);
  if (!entry) throw runtimeError(`unknown builtin '${name}'`, node);
  checkArity(name, args, entry.min, entry.max, node);
  // 快速标量数学：仅 process 且 fx.fastMath 开启时替换（类型校验与精确路径一致）。
  if (rt.phase === 'process' && rt.ctx && rt.ctx.fastMath && FAST_MATH[name]) {
    for (let i = 0; i < args.length; i++) expectNum(args[i], name, node);
    return FAST_MATH[name](...args);
  }
  return entry.impl(args, rt, node);
}

/* —— 向量 / 矩阵变换细节 —— */

function dotSelf(v) {
  const c = vecComps(v);
  let s = 0;
  for (const x of c) s += x * x;
  return s;
}

function dotComps(a, b) {
  const ca = vecComps(a), cb = vecComps(b);
  let s = 0;
  for (let i = 0; i < ca.length; i++) s += ca[i] * cb[i];
  return s;
}

function normVecOrZero(v) {
  const l = Math.sqrt(dotSelf(v));
  if (l === 0) return mkVec(vecDim(v), vecComps(v).map(() => 0));
  return mkVec(vecDim(v), vecComps(v).map((x) => x / l));
}

function rotXMat3(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return mat3([[1, 0, 0], [0, c, -s], [0, s, c]]);
}
function rotYMat3(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return mat3([[c, 0, s], [0, 1, 0], [-s, 0, c]]);
}
function rotZMat3(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return mat3([[c, -s, 0], [s, c, 0], [0, 0, 1]]);
}

// Rodrigues 旋转（3x3，行主序）。
function mat3Rodrigues(axis, a) {
  const x = axis.x, y = axis.y, z = axis.z;
  const c = Math.cos(a), s = Math.sin(a), C = 1 - c;
  return mat3([
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ]);
}

function mat4Rodrigues(axis, a) {
  const m = mat3Rodrigues(axis, a).m;
  return mat4([
    [m[0][0], m[0][1], m[0][2], 0],
    [m[1][0], m[1][1], m[1][2], 0],
    [m[2][0], m[2][1], m[2][2], 0],
    [0, 0, 0, 1],
  ]);
}

// lookAt：标准 view 观察矩阵（行主序），f = norm(target - eye)。
function lookAtMat4(eye, target, up, node) {
  const fx = target.x - eye.x;
  const fy = target.y - eye.y;
  const fz = target.z - eye.z;
  const fl = Math.hypot(fx, fy, fz);
  if (fl === 0) throw runtimeError('lookAt target equals eye', node);
  const f = vec3(fx / fl, fy / fl, fz / fl);

  const sx = f.y * up.z - f.z * up.y;
  const sy = f.z * up.x - f.x * up.z;
  const sz = f.x * up.y - f.y * up.x;
  const sl = Math.hypot(sx, sy, sz);
  if (sl === 0) throw runtimeError('lookAt up is parallel to view direction', node);
  const s = vec3(sx / sl, sy / sl, sz / sl);

  const u = vec3(s.y * f.z - s.z * f.y, s.z * f.x - s.x * f.z, s.x * f.y - s.y * f.x);

  return mat4([
    [s.x, s.y, s.z, -(s.x * eye.x + s.y * eye.y + s.z * eye.z)],
    [u.x, u.y, u.z, -(u.x * eye.x + u.y * eye.y + u.z * eye.z)],
    [-f.x, -f.y, -f.z, (f.x * eye.x + f.y * eye.y + f.z * eye.z)],
    [0, 0, 0, 1],
  ]);
}

// —— 值格式化（print）——

function formatValue(v, depth = 0) {
  if (depth > MAX_VALUE_DEPTH) throw new Error('value nesting too deep');
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return v;
  if (isVec(v)) {
    if (v.t === 'vec2') return `vec2(${v.x}, ${v.y})`;
    if (v.t === 'vec3') return `vec3(${v.x}, ${v.y}, ${v.z})`;
    return `vec4(${v.x}, ${v.y}, ${v.z}, ${v.w})`;
  }
  if (isMat(v)) {
    const name = v.t === 'mat3' ? 'mat3' : 'mat4';
    return `${name}(${v.m.map((row) => `[${row.join(', ')}]`).join(', ')})`;
  }
  if (Array.isArray(v)) return `[${v.map((x) => formatValue(x, depth + 1)).join(', ')}]`;
  if (isFunc(v)) return `func ${v.name}`;
  if (isLambda(v)) return `lambda(${v.params.join(', ')})`;
  if (isColor(v)) return `color(${v.r}, ${v.g}, ${v.b}, ${v.a})`;
  if (isObj(v)) {
    const parts = [];
    for (const [k, val] of v.fields) parts.push(`${k}: ${formatValue(val, depth + 1)}`);
    return `{${parts.join(', ')}}`;
  }
  return String(v);
}

// —— 字节码编译器 + 栈式虚拟机（process 专用）——
// setup 走上面的 AST Runtime；process 编译成扁平指令流执行。名称查找/赋值复用 Runtime 语义。

const OP = {
  CONST: 0, POP: 1, DUP: 2,
  LOAD: 3, STORE: 4,
  LOAD_CTX_FIELD: 5, STORE_CTX_FIELD: 6,
  LOAD_UNIFORM: 9, STORE_UNIFORM: 10,
  UNARY: 11, BINARY: 12,
  ARRAY: 13, INDEX: 14, INDEX_STORE: 15,
  COMP: 16, COMP_STORE: 17, COMP_STORE_INDEX: 18,
  UNPACK: 19, STATIC: 20,
  JUMP: 21, JUMP_IF_FALSE: 22, JUMP_IF_TRUE: 23,
  CALL_BUILTIN: 24, CALL_USER: 25, CALL_VALUE: 26, METHOD: 27,
  ENTER_SCOPE: 28, EXIT_SCOPE: 29, RETURN: 30, LOOP_GUARD: 31,
  LOAD_MEMBER: 32, STORE_MEMBER: 33, STORE_MEMBER_COMP: 34,
  ITER_BEGIN: 35, ITER_NEXT: 36, SPAWN: 37,
  LOAD_LOCAL: 38, STORE_LOCAL: 39,
  STORE_LOCAL_FORCE: 40,
  STORE_LOCAL_COMP: 41,
  OBJ: 42, WHEN_EQ: 43, RT_EXPR: 44,
};

const UNARY_OPS = ['-', '!'];
const BIN_OPS = ['+', '-', '*', '/', '%', '^', '==', '!=', '<', '<=', '>', '>='];

const BUILTIN_CODE = new Map();
const BUILTIN_BY_CODE = [];
for (const name of BUILTIN_TABLE.keys()) {
  BUILTIN_CODE.set(name, BUILTIN_BY_CODE.length);
  BUILTIN_BY_CODE.push(name);
}

const METHOD_NAMES = ['push', 'insert', 'remove', 'slice', 'size', 'find', 'includes', 'sort', 'unique', 'reverse'];
/** 数组方法名（编辑器补全等复用）。 */
export const ARRAY_METHOD_NAMES = METHOD_NAMES;
const METHOD_CODE = {};
METHOD_NAMES.forEach((n, i) => { METHOD_CODE[n] = i; });
const METHOD_BY_CODE = METHOD_NAMES;

// 按原始别名编码分量，保留 r/g/b/a 与 x/y/z/w 的书写形式。
// 向量运算用 COMP_ALIAS 归一化到 x/y/z/w；particle 上的分量回退为自定义字段时按原始别名存取。
const COMP_CODE = { x: 0, y: 1, z: 2, w: 3, r: 4, g: 5, b: 6, a: 7 };
const COMP_BY_CODE = ['x', 'y', 'z', 'w', 'r', 'g', 'b', 'a'];

// 可安全提升为 uniform 的纯内建（无 PRNG/随机、无数组变异、无回调）。
const PURE_BUILTINS = new Set();
for (const name of BUILTIN_TABLE.keys()) {
  if (!['rand', 'random', 'print', 'assert', 'unique', 'reverse', 'sort', 'repeat'].includes(name)) {
    PURE_BUILTINS.add(name);
  }
}

function makeLoc(line, col) { return { line, col }; }

class Compiler {
  constructor(program, varNames, globalNames) {
    this.program = program;
    this.code = [];
    this.locs = [];
    this.consts = [];
    this.constMap = new Map();
    this.names = [];
    this.nameMap = new Map();
    this.funcs = [];
    this.funcByName = new Map();
    this.funcIdxByName = new Map();
    this.hoisted = new Map();   // name -> uniform slot
    this.invariant = null;
    this.loopStack = [];
    this.loopCounters = 0;
    this.phase = 'process';     // 'process'（顶层，可烘焙属性/内置读）| 'func'
    this.varNames = varNames;
    this.globalNames = globalNames || [];
    this.syntheticSeq = 0;
    this.rtNodes = [];
    // 寄存器式局部变量：作用域栈（每帧 name -> slot）+ 槽位分配器。
    this.scopeStack = [new Map()];
    this.slotCount = 0;
    this.constSlots = new Map();

    // 预注册用户函数（便于前向引用）
    for (const [fname, fn] of program.functions) {
      const idx = this.funcs.length;
      this.funcs.push({ name: fname, params: fn.params.map(p => this.internName(p)), addr: -1 });
      this.funcByName.set(fname, fn);
      this.funcIdxByName.set(fname, idx);
    }
  }

  internName(name) {
    let idx = this.nameMap.get(name);
    if (idx === undefined) {
      idx = this.names.length;
      this.nameMap.set(name, idx);
      this.names.push(name);
    }
    return idx;
  }

  internConst(v) {
    let idx = this.constMap.get(v);
    if (idx === undefined) {
      idx = this.consts.length;
      this.constMap.set(v, idx);
      this.consts.push(v);
    }
    return idx;
  }

  emit1(op, node) { const i = this.code.length; this.code.push(op); this.locs[i] = node ? [node.line, node.col] : null; return i; }
  emit2(op, a, node) { const i = this.code.length; this.code.push(op, a); this.locs[i] = node ? [node.line, node.col] : null; return i; }
  emit3(op, a, b, node) { const i = this.code.length; this.code.push(op, a, b); this.locs[i] = node ? [node.line, node.col] : null; return i; }

  patchJump(instrIdx, target) { this.code[instrIdx + 1] = target; }
  pc() { return this.code.length; }
  allocLoopCounter() { return this.loopCounters++; }
  // 编译器内部合成名（for-of 迭代器存储）：用 \u0000 前缀保证与用户标识符不冲突。
  synthName() { return '\u0000it' + (this.syntheticSeq++); }

  /* —— 局部变量槽位（寄存器式，热路径绕开 Map 查找）—— */

  allocSlot() { return this.slotCount++; }
  lookupLocal(name) {
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      const s = this.scopeStack[i];
      if (s.has(name)) return s.get(name);
    }
    return -1;
  }
  declareLocal(name) {
    const slot = this.allocSlot();
    this.scopeStack[this.scopeStack.length - 1].set(name, slot);
    return slot;
  }
  hasLocalInCurrentScope(name) {
    return this.scopeStack[this.scopeStack.length - 1].has(name);
  }
  pushScopeFrame() { this.scopeStack.push(new Map()); }
  popScopeFrame() { this.scopeStack.pop(); }

  /* 委托 AST Runtime 求值的新构造（lambda/apply）：记录当前可见的局部名→槽位对，运行时按槽位同步。 */
  emitRtExpr(node) {
    const seen = new Set();
    const pairs = [];
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      for (const [name, slot] of this.scopeStack[i]) {
        if (!seen.has(name)) { seen.add(name); pairs.push([name, slot]); }
      }
    }
    const idx = this.rtNodes.length;
    this.rtNodes.push({ node, pairs });
    this.emit2(OP.RT_EXPR, idx, node);
  }

  /* —— 表达式 —— */

  compileExpr(node) {
    switch (node.type) {
      case 'num': case 'str': case 'bool':
        this.emit2(OP.CONST, this.internConst(node.value), node);
        return;
      case 'undefined':
        this.emit2(OP.CONST, this.internConst(undefined), node);
        return;
      case 'var': {
        const name = node.name;
        if (name === CTX_NAME) {
          throw parseError(`'this' is not a value; use this.<field>`, node.line, node.col);
        }
        if (this.hoisted.has(name)) {
          this.emit2(OP.LOAD_UNIFORM, this.hoisted.get(name), node);
          return;
        }
        if (CONSTANTS.has(name)) {
          this.emit2(OP.CONST, this.internConst(CONSTANTS.get(name)), node);
          return;
        }
        const slot = this.lookupLocal(name);
        if (slot >= 0) {
          this.emit2(OP.LOAD_LOCAL, slot, node);
        } else {
          this.emit2(OP.LOAD, this.internName(name), node);
        }
        return;
      }
      case 'member': {
        if (node.object.type === 'var' && node.object.name === CTX_NAME) {
          if (!CTX_FIELD_CODE.hasOwnProperty(node.field)) {
            throw parseError(`unknown this field '.${node.field}'`, node.line, node.col);
          }
          this.emit2(OP.LOAD_CTX_FIELD, CTX_FIELD_CODE[node.field], node);
          return;
        }
        // 粒子句柄字段（p.foo / p.position 等）：运行时按 particle 类型校验。
        this.compileExpr(node.object);
        this.emit2(OP.LOAD_MEMBER, this.internName(node.field), node);
        return;
      }
      case 'array': {
        for (const item of node.items) this.compileExpr(item);
        this.emit2(OP.ARRAY, node.items.length, node);
        return;
      }
      case 'unary': {
        this.compileExpr(node.operand);
        this.emit2(OP.UNARY, UNARY_OPS.indexOf(node.op), node);
        return;
      }
      case 'binary': {
        if (node.op === '&&') {
          this.compileExpr(node.left);
          this.emit1(OP.DUP, node);
          const jf = this.emit2(OP.JUMP_IF_FALSE, 0, node);
          this.emit1(OP.POP, node);
          this.compileExpr(node.right);
          const end = this.pc();
          this.patchJump(jf, end);
          return;
        }
        if (node.op === '||') {
          this.compileExpr(node.left);
          this.emit1(OP.DUP, node);
          const jt = this.emit2(OP.JUMP_IF_TRUE, 0, node);
          this.emit1(OP.POP, node);
          this.compileExpr(node.right);
          const end = this.pc();
          this.patchJump(jt, end);
          return;
        }
        this.compileExpr(node.left);
        this.compileExpr(node.right);
        this.emit2(OP.BINARY, BIN_OPS.indexOf(node.op), node);
        return;
      }
      case 'ternary': {
        this.compileExpr(node.cond);
        const jf = this.emit2(OP.JUMP_IF_FALSE, 0, node);
        this.compileExpr(node.thenExpr);
        const jend = this.emit2(OP.JUMP, 0, node);
        const elseStart = this.pc();
        this.patchJump(jf, elseStart);
        this.compileExpr(node.elseExpr);
        const end = this.pc();
        this.patchJump(jend, end);
        return;
      }
      case 'index': {
        this.compileExpr(node.target);
        this.compileExpr(node.index);
        this.emit1(OP.INDEX, node);
        return;
      }
      case 'comp': {
        this.compileExpr(node.target);
        this.emit2(OP.COMP, COMP_CODE[node.comp], node);
        return;
      }
      case 'call':
        this.compileCall(node);
        return;
      case 'method': {
        if (node.object.type === 'var' && node.object.name === CTX_NAME && node.method === 'spawn') {
          for (const a of node.args) this.compileExpr(a);
          this.emit2(OP.SPAWN, node.args.length, node);
          return;
        }
        this.compileExpr(node.object);
        for (const a of node.args) this.compileExpr(a);
        this.emit3(OP.METHOD, this.internName(node.method), node.args.length, node);
        return;
      }
      case 'obj': {
        const entries = [...node.fields];
        for (const [, e] of entries) this.compileExpr(e);
        this.emit1(OP.OBJ, node);
        this.code.push(entries.length);
        for (const [k] of entries) this.code.push(this.internName(k));
        return;
      }
      case 'whenexpr': {
        this.compileExpr(node.subject);
        const jumps = [];
        for (const c of node.cases) {
          this.emit1(OP.DUP, node);
          this.compileExpr(c.label);
          this.emit1(OP.WHEN_EQ, node);
          jumps.push(this.emit2(OP.JUMP_IF_TRUE, 0, node));
        }
        this.emit1(OP.POP, node);
        this.compileExpr(node.els);
        const jend = this.emit2(OP.JUMP, 0, node);
        const endJumps = [];
        for (let i = 0; i < node.cases.length; i++) {
          const start = this.pc();
          this.patchJump(jumps[i], start);
          this.emit1(OP.POP, node);
          this.compileExpr(node.cases[i].expr);
          endJumps.push(this.emit2(OP.JUMP, 0, node));
        }
        const end = this.pc();
        this.patchJump(jend, end);
        for (const j of endJumps) this.patchJump(j, end);
        return;
      }
      case 'lambda':
      case 'apply':
        this.emitRtExpr(node);
        return;
      default:
        throw parseError(`cannot compile expression type '${node.type}'`, node.line, node.col);
    }
  }

  compileCall(node) {
    const callee = node.callee;
    if (callee.type === 'var' && BUILTIN_FUNCTIONS.has(callee.name)) {
      for (const a of node.args) this.compileExpr(a);
      this.emit3(OP.CALL_BUILTIN, BUILTIN_CODE.get(callee.name), node.args.length, node);
      return;
    }
    if (callee.type === 'var' && this.program.functions.has(callee.name)) {
      for (const a of node.args) this.compileExpr(a);
      this.emit3(OP.CALL_USER, this.funcIdxByName.get(callee.name), node.args.length, node);
      return;
    }
    this.compileExpr(callee);
    for (const a of node.args) this.compileExpr(a);
    this.emit2(OP.CALL_VALUE, node.args.length, node);
  }

  /* —— 赋值目标（值已压栈）—— */

  compileTarget(target) {
    switch (target.type) {
      case 'var': {
        const name = target.name;
        if (name === CTX_NAME) {
          throw parseError(`cannot assign to 'this'; use this.<field> = ...`, target.line, target.col);
        }
        const slot = this.lookupLocal(name);
        if (slot >= 0) {
          this.emit2(OP.STORE_LOCAL, slot, target);
          return;
        }
        // 非局部名（global / fx.var / 常量 / 未声明）：交给 Runtime 按名字处理（const/只读/未声明报错）。
        this.emit2(OP.STORE, this.internName(name), target);
        return;
      }
      case 'member': {
        if (target.object.type === 'var' && target.object.name === CTX_NAME) {
          if (!CTX_FIELD_CODE.hasOwnProperty(target.field)) {
            throw parseError(`unknown this field '.${target.field}'`, target.line, target.col);
          }
          this.emit2(OP.STORE_CTX_FIELD, CTX_FIELD_CODE[target.field], target);
          return;
        }
        this.compileExpr(target.object);
        this.emit2(OP.STORE_MEMBER, this.internName(target.field), target);
        return;
      }
      case 'index':
        this.compileExpr(target.target);
        this.compileExpr(target.index);
        this.emit1(OP.INDEX_STORE, target);
        return;
      case 'comp': {
        const inner = target.target;
        if (inner.type === 'var') {
          const slot = this.lookupLocal(inner.name);
          if (slot >= 0) {
            this.emit2(OP.LOAD_LOCAL, slot, inner);
            this.emit2(OP.COMP_STORE, COMP_CODE[target.comp], target);
            this.emit2(OP.STORE_LOCAL_COMP, slot, target);
          } else {
            this.emit2(OP.LOAD, this.internName(inner.name), inner);
            this.emit2(OP.COMP_STORE, COMP_CODE[target.comp], target);
            this.emit2(OP.STORE, this.internName(inner.name), target);
          }
        } else if (inner.type === 'member') {
          if (inner.object.type === 'var' && inner.object.name === CTX_NAME) {
            if (!CTX_FIELD_CODE.hasOwnProperty(inner.field)) {
              throw parseError(`unknown this field '.${inner.field}'`, inner.line, inner.col);
            }
            this.emit2(OP.LOAD_CTX_FIELD, CTX_FIELD_CODE[inner.field], inner);
            this.emit2(OP.COMP_STORE, COMP_CODE[target.comp], target);
            this.emit2(OP.STORE_CTX_FIELD, CTX_FIELD_CODE[inner.field], target);
          } else {
            // 粒子字段分量赋值：p.position.x = v
            // 栈序：先 DUP 出对象句柄用于写回，LOAD_MEMBER 消费一份读旧值。
            this.compileExpr(inner.object);
            this.emit1(OP.DUP, inner);
            this.emit2(OP.LOAD_MEMBER, this.internName(inner.field), inner);
            this.emit3(OP.STORE_MEMBER_COMP, this.internName(inner.field), COMP_CODE[target.comp], target);
          }
        } else if (inner.type === 'index') {
          this.compileExpr(inner.target);
          this.compileExpr(inner.index);
          this.emit2(OP.COMP_STORE_INDEX, COMP_CODE[target.comp], target);
        } else {
          // 嵌套 comp 等：与 AST 一致，求值后会在 COMP_STORE 处报「不是向量」。
          this.compileExpr(inner);
          this.emit2(OP.COMP_STORE, COMP_CODE[target.comp], target);
        }
        return;
      }
      default:
        throw parseError(`invalid assignment target '${target.type}'`, target.line, target.col);
    }
  }

  compileAssign(node) {
    this.compileExpr(node.value);
    if (node.target.type === 'unpack') {
      this.emit2(OP.UNPACK, node.target.names.length, node);
      for (let i = node.target.names.length - 1; i >= 0; i--) {
        this.emit2(OP.STORE, this.internName(node.target.names[i]), node);
      }
    } else {
      this.compileTarget(node.target);
    }
  }

  /* —— 语句 —— */

  compileStmt(st) {
    switch (st.type) {
      case 'declare': {
        for (const d of st.decls) {
          if (this.hasLocalInCurrentScope(d.name)) {
            throw parseError(`duplicate declaration '${d.name}'`, d.line, d.col);
          }
          const slot = this.declareLocal(d.name);
          if (st.kind === 'const') this.constSlots.set(slot, d.name);
          if (d.init) this.compileExpr(d.init);
          else this.emit2(OP.CONST, this.internConst(undefined), d);
          // 初始化赋值对 const 合法：绕过只读检查（与 for-of 的 const 循环变量一致）。
          this.emit2(st.kind === 'const' ? OP.STORE_LOCAL_FORCE : OP.STORE_LOCAL, slot, d);
        }
        return;
      }
      case 'block':
        this.pushScopeFrame();
        this.emit1(OP.ENTER_SCOPE, st);
        for (const s of st.body) this.compileStmt(s);
        this.emit1(OP.EXIT_SCOPE, st);
        this.popScopeFrame();
        return;
      case 'if': {
        this.compileExpr(st.cond);
        const jf = this.emit2(OP.JUMP_IF_FALSE, 0, st);
        this.compileStmt(st.then);
        if (st.els) {
          const jend = this.emit2(OP.JUMP, 0, st);
          const elseStart = this.pc();
          this.patchJump(jf, elseStart);
          this.compileStmt(st.els);
          this.patchJump(jend, this.pc());
        } else {
          this.patchJump(jf, this.pc());
        }
        return;
      }
      case 'while': {
        const loop = { breaks: [], continues: [] };
        this.loopStack.push(loop);
        const start = this.pc();
        this.compileExpr(st.cond);
        const jf = this.emit2(OP.JUMP_IF_FALSE, 0, st);
        this.emit2(OP.LOOP_GUARD, this.allocLoopCounter(), st);
        this.compileStmt(st.body);
        const contTarget = this.pc();
        for (const p of loop.continues) this.patchJump(p, contTarget);
        this.emit2(OP.JUMP, start, st);
        const end = this.pc();
        this.patchJump(jf, end);
        for (const p of loop.breaks) this.patchJump(p, end);
        this.loopStack.pop();
        return;
      }
      case 'do': {
        const loop = { breaks: [], continues: [] };
        this.loopStack.push(loop);
        const start = this.pc();
        this.emit2(OP.LOOP_GUARD, this.allocLoopCounter(), st);
        this.compileStmt(st.body);
        const contTarget = this.pc();
        for (const p of loop.continues) this.patchJump(p, contTarget);
        this.compileExpr(st.cond);
        this.emit2(OP.JUMP_IF_TRUE, start, st);
        const end = this.pc();
        for (const p of loop.breaks) this.patchJump(p, end);
        this.loopStack.pop();
        return;
      }
      case 'for': {
        const loop = { breaks: [], continues: [] };
        this.loopStack.push(loop);
        this.pushScopeFrame();
        this.emit1(OP.ENTER_SCOPE, st);
        if (st.init) this.compileForPart(st.init);
        const start = this.pc();
        let jf = null;
        if (st.cond) {
          this.compileExpr(st.cond);
          jf = this.emit2(OP.JUMP_IF_FALSE, 0, st);
        }
        this.emit2(OP.LOOP_GUARD, this.allocLoopCounter(), st);
        this.compileStmt(st.body);
        const contTarget = this.pc();
        for (const p of loop.continues) this.patchJump(p, contTarget);
        if (st.inc) this.compileForPart(st.inc);
        this.emit2(OP.JUMP, start, st);
        const end = this.pc();
        if (jf != null) this.patchJump(jf, end);
        for (const p of loop.breaks) this.patchJump(p, end);
        this.emit1(OP.EXIT_SCOPE, st);
        this.popScopeFrame();
        this.loopStack.pop();
        return;
      }
      case 'forof': {
        const loop = { breaks: [], continues: [] };
        this.loopStack.push(loop);
        this.pushScopeFrame();
        this.emit1(OP.ENTER_SCOPE, st);
        this.compileExpr(st.iter);
        this.emit1(OP.ITER_BEGIN, st);
        const itSlot = this.declareLocal(this.synthName());
        this.emit2(OP.STORE_LOCAL, itSlot, st);
        const varSlot = this.declareLocal(st.name);
        if (st.kind === 'const') this.constSlots.set(varSlot, st.name);
        const start = this.pc();
        this.emit2(OP.LOAD_LOCAL, itSlot, st);
        this.emit1(OP.ITER_NEXT, st);
        this.emit2(OP.STORE_LOCAL, itSlot, st);
        const jf = this.emit2(OP.JUMP_IF_FALSE, 0, st);
        this.emit2(st.kind === 'const' ? OP.STORE_LOCAL_FORCE : OP.STORE_LOCAL, varSlot, st);
        this.emit2(OP.LOOP_GUARD, this.allocLoopCounter(), st);
        this.compileStmt(st.body);
        const contTarget = this.pc();
        for (const p of loop.continues) this.patchJump(p, contTarget);
        this.emit2(OP.JUMP, start, st);
        const end = this.pc();
        this.patchJump(jf, end);
        for (const p of loop.breaks) this.patchJump(p, end);
        this.emit1(OP.EXIT_SCOPE, st);
        this.popScopeFrame();
        this.loopStack.pop();
        return;
      }
      case 'break': {
        const loop = this.loopStack[this.loopStack.length - 1];
        if (!loop) throw parseError("'break' outside loop", st.line, st.col);
        const i = this.emit2(OP.JUMP, 0, st);
        loop.breaks.push(i);
        return;
      }
      case 'continue': {
        const loop = this.loopStack[this.loopStack.length - 1];
        if (!loop) throw parseError("'continue' outside loop", st.line, st.col);
        const i = this.emit2(OP.JUMP, 0, st);
        loop.continues.push(i);
        return;
      }
      case 'return': {
        if (st.expr) this.compileExpr(st.expr);
        else this.emit2(OP.CONST, this.internConst(0), st);
        this.emit1(OP.RETURN, st);
        return;
      }
      case 'static': {
        if (st.init) this.compileExpr(st.init);
        else this.emit2(OP.CONST, this.internConst(0), st);
        this.emit2(OP.STATIC, this.internName(st.name), st);
        return;
      }
      case 'expr':
        this.compileExpr(st.expr);
        this.emit1(OP.POP, st);
        return;
      case 'assign':
        this.compileAssign(st);
        this.emit1(OP.POP, st);
        return;
      case 'whenstmt': {
        this.compileExpr(st.subject);
        const jumps = [];
        for (const c of st.cases) {
          this.emit1(OP.DUP, st);
          this.compileExpr(c.label);
          this.emit1(OP.WHEN_EQ, st);
          jumps.push(this.emit2(OP.JUMP_IF_TRUE, 0, st));
        }
        this.emit1(OP.POP, st);
        if (st.els) this.compileStmt(st.els);
        const jend = this.emit2(OP.JUMP, 0, st);
        const endJumps = [];
        for (let i = 0; i < st.cases.length; i++) {
          const start = this.pc();
          this.patchJump(jumps[i], start);
          this.emit1(OP.POP, st);
          this.compileStmt(st.cases[i].body);
          endJumps.push(this.emit2(OP.JUMP, 0, st));
        }
        const end = this.pc();
        this.patchJump(jend, end);
        for (const j of endJumps) this.patchJump(j, end);
        return;
      }
      case 'destructure': {
        this.compileExpr(st.value);
        for (const name of st.names) {
          if (this.hasLocalInCurrentScope(name)) {
            throw parseError(`duplicate declaration '${name}'`, st.line, st.col);
          }
          const slot = this.declareLocal(name);
          if (st.kind === 'const') this.constSlots.set(slot, name);
          this.emit1(OP.DUP, st);
          this.emit2(OP.CONST, this.internConst(name), st);
          this.emit1(OP.INDEX, st);
          this.emit2(st.kind === 'const' ? OP.STORE_LOCAL_FORCE : OP.STORE_LOCAL, slot, st);
        }
        this.emit1(OP.POP, st);
        return;
      }
      default:
        throw parseError(`cannot compile statement type '${st.type}'`, st.line, st.col);
    }
  }

  compileForPart(part) {
    if (part.type === 'assign') this.compileAssign(part);
    else if (part.type === 'declare') this.compileStmt(part);
    else this.compileExpr(part);
    if (part.type !== 'declare') this.emit1(OP.POP, part);
  }
}

/* —— 不变式分析（仅 process 顶层无条件赋值）—— */

function walkExpr(node, cb) {
  if (!node) return;
  cb(node);
  switch (node.type) {
    case 'var': case 'num': case 'str': case 'bool': return;
    case 'array': node.items.forEach(e => walkExpr(e, cb)); return;
    case 'unary': walkExpr(node.operand, cb); return;
    case 'binary': walkExpr(node.left, cb); walkExpr(node.right, cb); return;
    case 'ternary': walkExpr(node.cond, cb); walkExpr(node.thenExpr, cb); walkExpr(node.elseExpr, cb); return;
    case 'index': walkExpr(node.target, cb); walkExpr(node.index, cb); return;
    case 'comp': walkExpr(node.target, cb); return;
    case 'member': walkExpr(node.object, cb); return;
    case 'call': walkExpr(node.callee, cb); node.args.forEach(a => walkExpr(a, cb)); return;
    case 'method': walkExpr(node.object, cb); node.args.forEach(a => walkExpr(a, cb)); return;
    default: return;
  }
}

function walkStmtExprs(node, cb) {
  if (!node) return;
  switch (node.type) {
    case 'block': node.body.forEach(s => walkStmtExprs(s, cb)); return;
    case 'if': walkExpr(node.cond, cb); walkStmtExprs(node.then, cb); if (node.els) walkStmtExprs(node.els, cb); return;
    case 'while': walkExpr(node.cond, cb); walkStmtExprs(node.body, cb); return;
    case 'do': walkStmtExprs(node.body, cb); walkExpr(node.cond, cb); return;
    case 'for': if (node.init) walkStmtExprs(node.init, cb); if (node.cond) walkExpr(node.cond, cb); if (node.inc) walkStmtExprs(node.inc, cb); walkStmtExprs(node.body, cb); return;
    case 'forof': walkExpr(node.iter, cb); walkStmtExprs(node.body, cb); return;
    case 'expr': walkExpr(node.expr, cb); return;
    case 'assign': if (node.target.type === 'unpack') {} else walkExpr(node.value, cb); return;
    case 'declare': for (const d of node.decls) if (d.init) walkExpr(d.init, cb); return;
    case 'static': if (node.init) walkExpr(node.init, cb); return;
    case 'return': if (node.expr) walkExpr(node.expr, cb); return;
    default: return;
  }
}

function isInvariantExpr(node, invariant, varNames) {
  switch (node.type) {
    case 'num': case 'str': case 'bool': case 'undefined': return true;
    case 'var': return invariant.has(node.name);
    case 'member': {
      if (node.object.type !== 'var' || node.object.name !== CTX_NAME) return false;
      return node.field === 'count' || node.field === 'time' || node.field === 'delta' || node.field === 'duration';
    }
    case 'unary': return isInvariantExpr(node.operand, invariant, varNames);
    case 'binary': return isInvariantExpr(node.left, invariant, varNames) && isInvariantExpr(node.right, invariant, varNames);
    case 'ternary': return isInvariantExpr(node.cond, invariant, varNames) && isInvariantExpr(node.thenExpr, invariant, varNames) && isInvariantExpr(node.elseExpr, invariant, varNames);
    case 'comp': return isInvariantExpr(node.target, invariant, varNames);
    case 'call': {
      if (node.callee.type !== 'var') return false;
      if (!PURE_BUILTINS.has(node.callee.name)) return false;
      return node.args.every(a => isInvariantExpr(a, invariant, varNames));
    }
    case 'index': case 'array': case 'method': return false;
    default: return false;
  }
}

function hoistCandidateName(name, varNames, globalNames, staticNames, program) {
  return name !== CTX_NAME && !CONSTANTS.has(name) &&
    !varNames.includes(name) && !globalNames.includes(name) && !staticNames.includes(name) &&
    !program.functions.has(name) && !BUILTIN_FUNCTIONS.has(name);
}

// 收集 process 中声明的 static 名（不能被提升为 uniform）。
function collectStaticNames(processStmts) {
  const out = new Set();
  function walk(node) {
    if (!node) return;
    if (node.type === 'static') out.add(node.name);
    if (node.type === 'block') { node.body.forEach(walk); return; }
    if (node.type === 'if') { walk(node.then); if (node.els) walk(node.els); return; }
    if (node.type === 'while') { walk(node.body); return; }
    if (node.type === 'do') { walk(node.body); return; }
    if (node.type === 'for') { if (node.init) walk(node.init); if (node.inc) walk(node.inc); walk(node.body); }
    if (node.type === 'forof') { walk(node.body); }
  }
  processStmts.forEach(walk);
  return [...out];
}

// 字节码 VM 尚未实现 break/continue 的跨块作用域清理（会留下未弹出的块作用域），
// 含 break/continue 的 process 回退 AST 解释执行（语义正确，仅性能略低）。
function containsBreakOrContinue(stmts) {
  let found = false;
  function walk(node) {
    if (!node || found) return;
    if (node.type === 'break' || node.type === 'continue') { found = true; return; }
    if (node.type === 'block') { node.body.forEach(walk); return; }
    if (node.type === 'if') { walk(node.then); if (node.els) walk(node.els); return; }
    if (node.type === 'while') { walk(node.body); return; }
    if (node.type === 'do') { walk(node.body); return; }
    if (node.type === 'for') { if (node.init) walk(node.init); if (node.inc) walk(node.inc); walk(node.body); return; }
    if (node.type === 'forof') { walk(node.body); return; }
    if (node.type === 'return') { if (node.expr) return; return; }
  }
  stmts.forEach(walk);
  return found;
}

// v13 起 process 是对象级执行（每帧一次而非每粒子），顶层不变式提升不再有收益；
// 且 let/const 使「赋值即声明」的旧提升语义不再成立。保留空实现，避免误提升未声明变量
// 而静默吞掉「未声明赋值」错误。
function findHoistedAssignments() {
  return [];
}

// —— 原生 JS 快路径编译器（process 直线标量代码）——
// 把「只有标量赋值/拆包、无循环/分支/向量/矩阵/用户函数」的 process 编译成 new Function；
// 不支持的结构返回 null，调用方回退 VM。属性钳制/glow 阈值/light/life 取整/除零报错与 VM 一致。

// 支持直接映射到 JS 标量运算的内建函数；其余（noise/fbm/rand/random/向量/矩阵/集合）回退 VM。
const NATIVE_BUILTINS = {
  sin: a => `(useFast?FM.sin(${a[0]}):Math.sin(${a[0]}))`,
  cos: a => `(useFast?FM.cos(${a[0]}):Math.cos(${a[0]}))`,
  tan: a => `(useFast?FM.tan(${a[0]}):Math.tan(${a[0]}))`,
  asin: a => `(useFast?FM.asin(${a[0]}):Math.asin(${a[0]}))`,
  acos: a => `(useFast?FM.acos(${a[0]}):Math.acos(${a[0]}))`,
  atan: a => `(useFast?FM.atan(${a[0]}):Math.atan(${a[0]}))`,
  atan2: a => `(useFast?FM.atan2(${a[0]},${a[1]}):Math.atan2(${a[0]},${a[1]}))`,
  sqrt: a => `Math.sqrt(${a[0]})`,
  abs: a => `Math.abs(${a[0]})`,
  sign: a => `Math.sign(${a[0]})`,
  exp: a => `(useFast?FM.exp(${a[0]}):Math.exp(${a[0]}))`,
  log: a => `(useFast?FM.log(${a[0]}):Math.log(${a[0]}))`,
  ln: a => `(useFast?FM.log(${a[0]}):Math.log(${a[0]}))`,
  floor: a => `Math.floor(${a[0]})`,
  ceil: a => `Math.ceil(${a[0]})`,
  round: a => `Math.round(${a[0]})`,
  fract: a => `(${a[0]}-Math.floor(${a[0]}))`,
  pow: a => `(useFast?FM.pow(${a[0]},${a[1]}):Math.pow(${a[0]},${a[1]}))`,
  min: a => `Math.min(${a[0]},${a[1]})`,
  max: a => `Math.max(${a[0]},${a[1]})`,
  clamp: a => `Math.max(${a[1]},Math.min(${a[2]},${a[0]}))`,
  lerp: a => `(${a[0]}+(${a[1]}-${a[0]})*${a[2]})`,
  mix: a => `(${a[0]}+(${a[1]}-${a[0]})*${a[2]})`,
  step: a => `(${a[1]}>=${a[0]}?1:0)`,
  smoothstep: a => `(()=>{const __t=Math.max(0,Math.min(1,((${a[2]}-${a[0]})/(${a[1]}-${a[0]}))));return __t*__t*(3-2*__t);})()`,
  mod: a => `(${a[0]}-${a[1]}*Math.floor(${a[0]}/${a[1]}))`,
  map_range: a => `(${a[3]}+((${a[0]}-${a[1]})/(${a[2]}-${a[1]}))*(${a[4]}-${a[3]}))`,
  remap: a => `(()=>{const __r=${a[3]}+((${a[0]}-${a[1]})/(${a[2]}-${a[1]}))*(${a[4]}-${a[3]});return Math.max(Math.min(${a[3]},${a[4]}),Math.min(Math.max(${a[3]},${a[4]}),__r));})()`,
  int: a => `Math.trunc(${a[0]})`,
  float: a => `(${a[0]})`,
  bool: a => `(${a[0]}!==0)`,
  ease_linear: a => `(${a[0]}+(${a[1]}-${a[0]})*${a[2]})`,
  ease_in_out: a => `(()=>{const __t=Math.max(0,Math.min(1,${a[2]}));return ${a[0]}+(${a[1]}-${a[0]})*__t*__t*(3-2*__t);})()`,
  ease_out_back: a => `(()=>{const __t=Math.max(0,Math.min(1,${a[2]}));const __u=__t-1;return ${a[0]}+(${a[1]}-${a[0]})*(1+(1.70158+1)*__u*__u*__u+1.70158*__u*__u);})()`,
  ease_in_elastic: a => `(()=>{const __t=Math.max(0,Math.min(1,${a[2]}));let __v;if(__t===0)__v=0;else if(__t===1)__v=1;else __v=-Math.pow(2,10*(__t-1))*Math.sin((__t*10-10.75)*(2*Math.PI)/3);return ${a[0]}+(${a[1]}-${a[0]})*__v;})()`,
};

const FAIL = Symbol('native-fail');

function compileNativeProcess(program, varNames, globalNames) {
  const stmts = program.process && program.process.body ? program.process.body.body : [];
  if (stmts.length === 0) return null;
  const staticNamesSet = new Set(collectStaticNames(stmts));
  const varNamesSet = new Set(varNames);
  const globalNamesSet = new Set(globalNames);
  const funcNames = new Set(program.functions.keys());

  // 首次提及分析：只有「先写后读」的普通名才可作为原生局部变量，
  // 避免把「先读（global/static/var）后写」的名字误编译为 TDZ 局部量。
  const firstMention = new Map();
  for (const st of stmts) {
    if (st.type !== 'assign') return null;
    const t = st.target;
    if (t.type === 'var') {
      const name = t.name;
      if (!firstMention.has(name)) firstMention.set(name, 'write');
      walkExpr(st.value, (e) => {
        if (e.type === 'var' && !firstMention.has(e.name)) firstMention.set(e.name, 'read');
      });
    } else if (t.type === 'unpack') {
      for (const name of t.names) {
        if (!firstMention.has(name)) firstMention.set(name, 'write');
      }
      walkExpr(st.value, (e) => {
        if (e.type === 'var' && !firstMention.has(e.name)) firstMention.set(e.name, 'read');
      });
    } else if (t.type === 'member' || t.type === 'comp') {
      walkExpr(st.value, (e) => {
        if (e.type === 'var' && !firstMention.has(e.name)) firstMention.set(e.name, 'read');
      });
    } else {
      return null;
    }
  }

  const tempNames = new Set();
  for (const [name, mention] of firstMention) {
    if (mention !== 'write') continue;
    if (name === CTX_NAME || CONSTANTS.has(name) ||
        varNamesSet.has(name) || globalNamesSet.has(name) || staticNamesSet.has(name) ||
        funcNames.has(name) || BUILTIN_FUNCTIONS.has(name)) continue;
    tempNames.add(name);
  }

  function readExpr(name) {
    if (name === CTX_NAME) return FAIL;
    if (CONSTANTS.has(name)) return `(${CONSTANTS.get(name)})`;
    if (tempNames.has(name)) return name;
    if (staticNamesSet.has(name)) return `s.get(${JSON.stringify(name)})`;
    if (globalNamesSet.has(name)) return `g.get(${JSON.stringify(name)})`;
    if (varNamesSet.has(name)) return `v[${JSON.stringify(name)}]`;
    return FAIL;
  }

  function writeExpr(name, valExpr) {
    if (name === CTX_NAME) return FAIL;
    if (CONSTANTS.has(name) || varNamesSet.has(name) || funcNames.has(name)) return FAIL;
    if (tempNames.has(name)) return `${name}=${valExpr};`;
    if (staticNamesSet.has(name)) return `s.set(${JSON.stringify(name)},${valExpr});`;
    if (globalNamesSet.has(name)) return FAIL;
    return FAIL;
  }

  function ctxMemberReadExpr(node) {
    if (node.object.type !== 'var' || node.object.name !== CTX_NAME) return FAIL;
    switch (node.field) {
      case 'index': return 'ctx.i';
      case 'count': return 'ctx.n';
      case 'time': return 'ctx.t';
      case 'delta': return 'ctx.dt';
      case 'duration': return 'ctx.duration';
      case 'life': return 'out.life';
      case 'scale': return 'out.scale';
      case 'glow': return '(out.glow?1:0)';
      case 'light': return 'out.light';
      default: return FAIL; // uv / position / color / velocity 为向量
    }
  }

  function ctxCompReadExpr(node) {
    if (node.target.type !== 'member') return FAIL;
    const inner = node.target;
    if (inner.object.type !== 'var' || inner.object.name !== CTX_NAME) return FAIL;
    const c = COMP_ALIAS[node.comp];
    switch (inner.field) {
      case 'uv':
        if (c === 'x') return 'ctx.uv_x';
        if (c === 'y') return 'ctx.uv_y';
        return FAIL;
      case 'position':
        if (c === 'x') return 'out.pos[0]';
        if (c === 'y') return 'out.pos[1]';
        if (c === 'z') return 'out.pos[2]';
        return FAIL;
      case 'velocity':
        if (c === 'x') return 'out.vel[0]';
        if (c === 'y') return 'out.vel[1]';
        if (c === 'z') return 'out.vel[2]';
        return FAIL;
      case 'color':
        if (c === 'x') return 'out.color[0]';
        if (c === 'y') return 'out.color[1]';
        if (c === 'z') return 'out.color[2]';
        if (c === 'w') return 'out.color[3]';
        return FAIL;
      default: return FAIL;
    }
  }

  function ctxMemberWriteExpr(field, valExpr) {
    switch (field) {
      case 'scale': return `out.scale=${valExpr};`;
      case 'glow': return `out.glow=(${valExpr})>0.5;`;
      case 'light': return `out.light=__clamp15(${valExpr});`;
      case 'life': return `out.life=__clampLife(${valExpr});`;
      default: return FAIL;
    }
  }

  function ctxCompWriteExpr(field, c, valExpr) {
    switch (field) {
      case 'position':
        if (c === 'x') return `out.pos[0]=${valExpr};`;
        if (c === 'y') return `out.pos[1]=${valExpr};`;
        if (c === 'z') return `out.pos[2]=${valExpr};`;
        return FAIL;
      case 'velocity':
        if (c === 'x') return `out.vel[0]=${valExpr};`;
        if (c === 'y') return `out.vel[1]=${valExpr};`;
        if (c === 'z') return `out.vel[2]=${valExpr};`;
        return FAIL;
      case 'color':
        if (c === 'x') return `out.color[0]=__clamp01(${valExpr});`;
        if (c === 'y') return `out.color[1]=__clamp01(${valExpr});`;
        if (c === 'z') return `out.color[2]=__clamp01(${valExpr});`;
        if (c === 'w') return `out.color[3]=__clamp01(${valExpr});`;
        return FAIL;
      default: return FAIL;
    }
  }

  // 粒子属性写入必须是 num；若 RHS 可能产出 bool（VM 会抛错），退回 VM 保证语义一致。
  function mayBeBool(node, boolTemps) {
    switch (node.type) {
      case 'bool': return true;
      case 'num': case 'str': case 'array': case 'index': case 'comp': case 'member': return false;
      case 'var': return boolTemps.has(node.name);
      case 'unary': return node.op === '!';
      case 'binary': {
        if (node.op === '&&' || node.op === '||') return mayBeBool(node.left, boolTemps) || mayBeBool(node.right, boolTemps);
        if (node.op === '==' || node.op === '!=' || node.op === '<' || node.op === '<=' || node.op === '>' || node.op === '>=') return true;
        return mayBeBool(node.left, boolTemps) || mayBeBool(node.right, boolTemps);
      }
      case 'ternary': return mayBeBool(node.thenExpr, boolTemps) || mayBeBool(node.elseExpr, boolTemps);
      case 'call': return node.callee.type === 'var' && node.callee.name === 'bool';
      default: return true;
    }
  }

  function genExpr(node) {
    switch (node.type) {
      case 'num': return `(${node.value})`;
      case 'bool': return node.value ? 'true' : 'false';
      case 'str': return JSON.stringify(node.value);
      case 'var': return readExpr(node.name);
      case 'member': return ctxMemberReadExpr(node);
      case 'comp': return ctxCompReadExpr(node);
      case 'unary': {
        const v = genExpr(node.operand);
        if (v === FAIL) return FAIL;
        return node.op === '-' ? `(-${v})` : `(!__truthy(${v}))`;
      }
      case 'binary': {
        const l = genExpr(node.left);
        const r = genExpr(node.right);
        if (l === FAIL || r === FAIL) return FAIL;
        switch (node.op) {
          case '+': return `(${l}+${r})`;
          case '-': return `(${l}-${r})`;
          case '*': return `(${l}*${r})`;
          case '/': return `__div(${l},${r})`;
          case '%': return `(${l}%${r})`;
          case '^': return `(${l}**${r})`;
          case '==': return `(${l}===${r})`;
          case '!=': return `(${l}!==${r})`;
          case '<': return `(${l}<${r})`;
          case '<=': return `(${l}<=${r})`;
          case '>': return `(${l}>${r})`;
          case '>=': return `(${l}>=${r})`;
          case '&&': return `(__truthy(${l})?${r}:${l})`;
          case '||': return `(__truthy(${l})?${l}:${r})`;
          default: return FAIL;
        }
      }
      case 'ternary': {
        const c = genExpr(node.cond);
        const t = genExpr(node.thenExpr);
        const e = genExpr(node.elseExpr);
        if (c === FAIL || t === FAIL || e === FAIL) return FAIL;
        return `(__truthy(${c})?${t}:${e})`;
      }
      case 'index': {
        const t = genExpr(node.target);
        const i = genExpr(node.index);
        if (t === FAIL || i === FAIL) return FAIL;
        return `__idx(${t},${i})`;
      }
      case 'call': {
        if (node.callee.type !== 'var') return FAIL;
        const name = node.callee.name;
        const impl = NATIVE_BUILTINS[name];
        if (!impl) return FAIL;
        const args = node.args.map(genExpr);
        for (const a of args) if (a === FAIL) return FAIL;
        return impl(args);
      }
      default:
        return FAIL;
    }
  }

  const bodyLines = [];
  const boolTemps = new Set();
  for (let si = 0; si < stmts.length; si++) {
    const st = stmts[si];
    if (st.type !== 'assign') return null;
    const target = st.target;
    if (target.type === 'var') {
      if (tempNames.has(target.name) && mayBeBool(st.value, boolTemps)) boolTemps.add(target.name);
      const v = genExpr(st.value);
      if (v === FAIL) return null;
      const w = writeExpr(target.name, v);
      if (w === FAIL) return null;
      bodyLines.push(w);
    } else if (target.type === 'unpack') {
      if (st.value.type !== 'array' || st.value.items.length !== target.names.length) return null;
      const vals = [];
      for (let k = 0; k < target.names.length; k++) {
        if (tempNames.has(target.names[k]) && mayBeBool(st.value.items[k], boolTemps)) boolTemps.add(target.names[k]);
        const v = genExpr(st.value.items[k]);
        if (v === FAIL) return null;
        vals.push(v);
      }
      for (let k = 0; k < vals.length; k++) bodyLines.push(`const __u${si}_${k}=${vals[k]};`);
      for (let k = 0; k < target.names.length; k++) {
        const w = writeExpr(target.names[k], `__u${si}_${k}`);
        if (w === FAIL) return null;
        bodyLines.push(w);
      }
    } else if (target.type === 'member') {
      if (target.object.type !== 'var' || target.object.name !== CTX_NAME) return null;
      const field = target.field;
      if (field === 'position' || field === 'velocity') {
        if (st.value.type !== 'array' || st.value.items.length !== 3) return null;
        const vals = [];
        for (let k = 0; k < 3; k++) {
          if (mayBeBool(st.value.items[k], boolTemps)) return null;
          const v = genExpr(st.value.items[k]);
          if (v === FAIL) return null;
          vals.push(v);
        }
        for (let k = 0; k < 3; k++) {
          bodyLines.push(`out.${field === 'position' ? 'pos' : 'vel'}[${k}]=${vals[k]};`);
        }
      } else if (field === 'color') {
        if (st.value.type !== 'array' || (st.value.items.length !== 3 && st.value.items.length !== 4)) return null;
        const n = st.value.items.length;
        const vals = [];
        for (let k = 0; k < n; k++) {
          if (mayBeBool(st.value.items[k], boolTemps)) return null;
          const v = genExpr(st.value.items[k]);
          if (v === FAIL) return null;
          vals.push(v);
        }
        for (let k = 0; k < n; k++) bodyLines.push(`out.color[${k}]=__clamp01(${vals[k]});`);
      } else if (field === 'scale' || field === 'light' || field === 'life') {
        if (mayBeBool(st.value, boolTemps)) return null;
        const v = genExpr(st.value);
        if (v === FAIL) return null;
        const w = ctxMemberWriteExpr(field, v);
        if (w === FAIL) return null;
        bodyLines.push(w);
      } else if (field === 'glow') {
        const v = genExpr(st.value);
        if (v === FAIL) return null;
        bodyLines.push(ctxMemberWriteExpr('glow', v));
      } else {
        return null; // index/count/time/delta/uv/life 只读
      }
    } else if (target.type === 'comp') {
      const inner = target.target;
      if (inner.type !== 'member') return null;
      if (inner.object.type !== 'var' || inner.object.name !== CTX_NAME) return null;
      const field = inner.field;
      if (field !== 'position' && field !== 'velocity' && field !== 'color') return null;
      if (mayBeBool(st.value, boolTemps)) return null;
      const v = genExpr(st.value);
      if (v === FAIL) return null;
      const w = ctxCompWriteExpr(field, COMP_ALIAS[target.comp], v);
      if (w === FAIL) return null;
      bodyLines.push(w);
    } else {
      return null;
    }
  }

  const tempDecls = [...tempNames].map(name => `let ${name};`).join('');
  const src = `'use strict';
const __clamp01=(x)=>x<0?0:(x>1?1:x);
const __clamp15=(x)=>{x=Math.round(x);return x<0?0:(x>15?15:x);};
const __clampLife=(x)=>{x=Math.round(x);return Number.isFinite(x)?(x<0?-1:x):-1;};
const __truthy=(x)=>(typeof x==='number'?x!==0:x);
const __div=(a,b)=>{if(b===0)throw new Error('division by zero');return a/b;};
const __idx=(a,i)=>{if(i%1!==0)throw new Error('array index requires an integer');const n=Math.trunc(i);if(n<0||n>=a.length)throw new Error('array index '+n+' out of bounds (size '+a.length+')');return a[n];};
${tempDecls}
${bodyLines.join('\n')}
return out;`;
  try {
    return new Function('ctx', 'g', 's', 'v', 'out', 'useFast', 'FM', src);
  } catch (e) {
    return null;
  }
}

function compileProgram(program, varNames, globalNames) {
  const processStmts = program.process && program.process.body ? program.process.body.body : [];
  if (containsBreakOrContinue(processStmts)) {
    throw new Error('unsupported: break/continue in process');
  }
  const c = new Compiler(program, varNames, globalNames);
  const staticNames = collectStaticNames(processStmts);

  // 1) 分析并编译 uniform prelude（先于主代码，共享常量/名字表与 hoisted 槽位）
  const hoisted = findHoistedAssignments(processStmts, varNames, globalNames, staticNames, program);
  const prelude = [];
  const preludeLocs = [];
  const savedCode = c.code;
  const savedLocs = c.locs;
  c.code = prelude;
  c.locs = preludeLocs;
  for (let i = 0; i < hoisted.length; i++) {
    const h = hoisted[i];
    c.hoisted.set(h.name, i);
  }
  for (const h of hoisted) {
    c.compileExpr(h.expr);
    c.emit2(OP.STORE_UNIFORM, c.hoisted.get(h.name), h.node);
  }
  c.code = savedCode;
  c.locs = savedLocs;

  // 2) 编译用户函数体（阶段通用：不做属性/内置烘焙）
  c.phase = 'func';
  const funcAddr = new Array(c.funcs.length);
  for (let i = 0; i < c.funcs.length; i++) {
    const fnNode = program.functions.get(c.funcs[i].name);
    funcAddr[i] = c.pc();
    c.compileStmt(fnNode.body);
    c.emit2(OP.CONST, c.internConst(0), fnNode.body); // 隐式返回 0
    c.emit1(OP.RETURN, fnNode.body);
  }

  // 3) 编译 process 主代码（跳过已提升赋值）
  c.phase = 'process';
  const mainStart = c.pc();
  for (const st of processStmts) {
    if (st.type === 'assign' && st.target.type === 'var' && c.hoisted.has(st.target.name)) continue;
    c.compileStmt(st);
  }
  const codeEnd = c.pc();

  return {
    code: c.code, locs: c.locs, consts: c.consts, names: c.names,
    funcs: c.funcs, funcAddr, funcIdxByName: c.funcIdxByName,
    prelude, preludeLocs, uniformCount: hoisted.length,
    loopCounterCount: c.loopCounters,
    localCount: c.slotCount,
    constSlots: c.constSlots,
    rtNodes: c.rtNodes,
    mainStart, codeEnd, program,
    native: null, // 对象级 process 不再走逐粒子原生快路径（保留字段以免调用方解构失败）
  };
}

function getCompiledProgram(program, varNames, globalNames) {
  const key = varNames.join('\u0000') + '|' + globalNames.join('\u0000');
  if (program._compiled && program._compiled.varNamesKey === key) return program._compiled;
  const compiled = compileProgram(program, varNames, globalNames);
  compiled.varNamesKey = key;
  program._compiled = compiled;
  return compiled;
}

/* —— 栈式虚拟机 —— */

// VM → AST 回退作用域：把 process 局部变量槽位按名暴露给 Runtime（lambda/apply 闭包捕获）。
// 仅在字节码把新构造（lambda/apply）委托给 AST Runtime 求值时压入；出栈后若被闭包持有，
// 仍通过 _locals 数组按引用读写当前帧的槽位值。
class SlotScope {
  constructor(locals, pairs, constSlots, node) {
    this._locals = locals;
    this._map = new Map(pairs);
    this._constSlots = constSlots;
    this._node = node;
  }
  has(name) { return this._map.has(name); }
  get(name) { return this._locals[this._map.get(name)]; }
  set(name, value) {
    const slot = this._map.get(name);
    if (slot === undefined) return this;
    const constName = this._constSlots && this._constSlots.get(slot);
    if (constName !== undefined) {
      throw runtimeError(`cannot assign to const '${constName}'`, this._node);
    }
    this._locals[slot] = value;
    return this;
  }
}

class Vm {
  constructor(compiled, objState, statics, ctx, uniforms, codeArr, locsArr, startPc) {
    this.compiled = compiled;
    this.code = codeArr || compiled.code;
    this.locs = locsArr || compiled.locs;
    this.startPc = startPc != null ? startPc : 0;
    this.consts = compiled.consts;
    this.names = compiled.names;
    this.funcs = compiled.funcs;
    this.funcAddr = compiled.funcAddr;
    this.funcIdxByName = compiled.funcIdxByName;
    this.objState = objState;
    this.statics = statics;
    this.ctx = ctx;
    this.uniforms = uniforms;
    this.stack = [];
    this.callStack = [];
    this.inFunctionStack = [];
    this.scopeDepthStack = [];
    this.loopCounters = new Array(compiled.loopCounterCount || 0).fill(0);
    this.locals = new Array(compiled.localCount || 0).fill(0);
    this.constSlots = compiled.constSlots || null;
    this.rt = new Runtime('process', compiled.program, objState, statics, null, ctx);
    this.topScope = new Map();
    this.rt.pushScope(this.topScope);
    // 复用的行号对象：process 热路径逐指令调用 nodeAt，避免每指令分配 {line,col}。
    this._locObj = { line: 0, col: 0 };
  }

  // 复用一个 VM 实例执行多个粒子：重置栈/调用栈/作用域/循环计数，并切换 statics/ctx/uniforms。
  resetForRun(statics, ctx, uniforms, startPc) {
    this.statics = statics;
    this.ctx = ctx;
    this.uniforms = uniforms;
    if (startPc != null) this.startPc = startPc;
    this.stack.length = 0;
    this.callStack.length = 0;
    this.inFunctionStack.length = 0;
    this.scopeDepthStack.length = 0;
    this.loopCounters.fill(0);
    this.locals.fill(0);
    const rt = this.rt;
    rt.statics = statics;
    rt.ctx = ctx;
    rt.scopes.length = 0;
    rt.constSets.length = 0;
    rt.receiverStack.length = 0;
    rt.funcDepth = 0;
    rt.inFunction = false;
    rt.usedIterations = 0;
    this.topScope.clear();
    rt.pushScope(this.topScope);
  }

  nodeAt(opPc) {
    const loc = this.locs[opPc];
    if (!loc) return null;
    this._locObj.line = loc[0];
    this._locObj.col = loc[1];
    return this._locObj;
  }

  run() {
    const code = this.code;
    const stack = this.stack;
    this.pc = this.startPc;
    for (;;) {
      const pc = this.pc;
      if (pc >= code.length) break;
      const opPc = pc;
      const op = code[pc];
      this.pc = pc + 1;
      const node = this.nodeAt(opPc);
      switch (op) {
        case OP.CONST: stack.push(this.consts[code[this.pc++]]); break;
        case OP.POP: stack.pop(); break;
        case OP.DUP: stack.push(stack[stack.length - 1]); break;
        case OP.LOAD: {
          const name = this.names[code[this.pc++]];
          stack.push(this.rt.lookupName(name, node));
          break;
        }
        case OP.STORE: {
          const name = this.names[code[this.pc++]];
          this.rt.assignName(name, stack.pop(), node);
          break;
        }
        case OP.LOAD_LOCAL: stack.push(this.locals[code[this.pc++]]); break;
        case OP.STORE_LOCAL: {
          const slot = code[this.pc++];
          const constName = this.constSlots && this.constSlots.get(slot);
          if (constName !== undefined) {
            throw runtimeError(`cannot assign to const '${constName}'`, node);
          }
          this.locals[slot] = stack.pop();
          break;
        }
        case OP.STORE_LOCAL_FORCE: this.locals[code[this.pc++]] = stack.pop(); break;
        case OP.STORE_LOCAL_COMP: {
          const slot = code[this.pc++];
          const value = stack.pop();
          const constName = this.constSlots && this.constSlots.get(slot);
          if (constName !== undefined) {
            // 分量赋值写回：particle 就地变异时值仍是同一对象（合法），仅当换绑定时报 const 错误。
            if (value !== this.locals[slot]) {
              throw runtimeError(`cannot assign to const '${constName}'`, node);
            }
          } else {
            this.locals[slot] = value;
          }
          break;
        }
        case OP.LOAD_CTX_FIELD: {
          const field = CTX_FIELD_BY_CODE[code[this.pc++]];
          stack.push(ctxRead(field, this.rt, node));
          break;
        }
        case OP.STORE_CTX_FIELD: {
          const field = CTX_FIELD_BY_CODE[code[this.pc++]];
          ctxWrite(field, stack.pop(), this.rt, node);
          break;
        }
        case OP.LOAD_UNIFORM: stack.push(this.uniforms[code[this.pc++]]); break;
        case OP.STORE_UNIFORM: this.uniforms[code[this.pc++]] = stack.pop(); break;
        case OP.UNARY: {
          const uop = UNARY_OPS[code[this.pc++]];
          const v = stack.pop();
          if (uop === '!') {
            if (!isNum(v) && !isBool(v)) throw runtimeError(`'!' requires a num/bool, got ${typeName(v)}`, node);
            stack.push(!truthy(v, node));
          } else {
            if (isNum(v)) stack.push(-v);
            else if (isVec(v)) { const cc = vecComps(v).map(x => -x); stack.push(mkVec(vecDim(v), cc)); }
            else if (isMat(v)) { const m = v.m.map(row => row.map(x => -x)); stack.push(v.t === 'mat3' ? mat3(m) : mat4(m)); }
            else throw runtimeError(`unary '-' not supported for ${typeName(v)}`, node);
          }
          break;
        }
        case OP.BINARY: {
          const bop = BIN_OPS[code[this.pc++]];
          const b = stack.pop();
          const a = stack.pop();
          stack.push(binaryOp(bop, a, b, node));
          break;
        }
        case OP.ARRAY: {
          const count = code[this.pc++];
          const items = new Array(count);
          for (let i = count - 1; i >= 0; i--) items[i] = stack.pop();
          stack.push(items);
          break;
        }
        case OP.OBJ: {
          const count = code[this.pc++];
          const names = new Array(count);
          for (let i = 0; i < count; i++) names[i] = this.names[code[this.pc++]];
          const fields = new Map();
          for (let i = count - 1; i >= 0; i--) fields.set(names[i], stack.pop());
          stack.push({ t: 'obj', fields });
          break;
        }
        case OP.WHEN_EQ: {
          const b = stack.pop();
          const a = stack.pop();
          stack.push(whenEqual(a, b));
          break;
        }
        case OP.RT_EXPR: {
          const info = this.compiled.rtNodes[code[this.pc++]];
          const view = new SlotScope(this.locals, info.pairs, this.compiled.constSlots, info.node);
          this.rt.pushScope(view);
          let v;
          try { v = this.rt.evalExpr(info.node); }
          finally { this.rt.popScope(); }
          stack.push(v);
          break;
        }
        case OP.INDEX: {
          const idx = stack.pop();
          const arr = stack.pop();
          if (isObj(arr)) {
            if (typeof idx !== 'string') throw runtimeError(`object index requires a string, got ${typeName(idx)}`, node);
            stack.push(arr.fields.get(idx));
            break;
          }
          const n = expectInt(idx, 'index', node);
          if (isParticleList(arr)) {
            if (n < 0 || n >= arr.list.length) {
              throw runtimeError(`particle list index ${n} out of bounds (size ${arr.list.length})`, node);
            }
            stack.push(particleValue(arr.list[n]));
            break;
          }
          if (!Array.isArray(arr)) throw runtimeError(`index access requires an array, particle list or object, got ${typeName(arr)}`, node);
          if (n < 0 || n >= arr.length) throw runtimeError(`array index ${n} out of bounds (size ${arr.length})`, node);
          stack.push(arr[n]);
          break;
        }
        case OP.INDEX_STORE: {
          const idx = stack.pop();
          const arr = stack.pop();
          const value = stack.pop();
          if (isObj(arr)) {
            if (typeof idx !== 'string') throw runtimeError(`object index requires a string, got ${typeName(idx)}`, node);
            arr.fields.set(idx, value);
            stack.push(value);
            break;
          }
          if (!Array.isArray(arr)) throw runtimeError('indexed assignment target is not an array', node);
          const n = expectInt(idx, 'array index', node);
          if (n < 0 || n >= arr.length) throw runtimeError(`array index ${n} out of bounds (size ${arr.length})`, node);
          arr[n] = value;
          stack.push(value);
          break;
        }
        case OP.COMP: {
          const raw = COMP_BY_CODE[code[this.pc++]];
          const v = stack.pop();
          // particle 上 .x/.y/.z/.w/.r/.g/.b/.a 不是保留字段，按自定义字段读取（原始别名作为字段名）。
          if (isParticle(v)) {
            stack.push(particleGetField(v, raw, node));
            break;
          }
          if (isObj(v)) {
            stack.push(v.fields.get(raw));
            break;
          }
          if (isColor(v)) {
            stack.push(colorCompRead(v, raw, node));
            break;
          }
          const comp = COMP_ALIAS[raw];
          if (!isVec(v)) throw runtimeError(`component access requires a vector or color, got ${typeName(v)}`, node);
          if ((v.t === 'vec2' && (comp === 'z' || comp === 'w')) ||
              (v.t === 'vec3' && comp === 'w')) {
            throw runtimeError(`${v.t} has no component '${raw}'`, node);
          }
          stack.push(v[comp]);
          break;
        }
        case OP.COMP_STORE: {
          const raw = COMP_BY_CODE[code[this.pc++]];
          const old = stack.pop();
          const nv = stack.pop();
          // particle 上 .x/.y/.z/.w/.r/.g/.b/.a 不是保留字段，按自定义字段写入。
          if (isParticle(old)) {
            particleSetField(old, raw, nv, node);
            stack.push(old);
            break;
          }
          if (isObj(old)) {
            old.fields.set(raw, nv);
            stack.push(old);
            break;
          }
          if (isColor(old)) {
            stack.push(colorCompWrite(old, raw, expectNum(nv, 'component value', node), node));
            break;
          }
          const comp = COMP_ALIAS[raw];
          if (!isVec(old)) throw runtimeError('component assignment target is not a vector', node);
          if ((old.t === 'vec2' && (comp === 'z' || comp === 'w')) ||
              (old.t === 'vec3' && comp === 'w')) {
            throw runtimeError(`${old.t} has no component '${raw}'`, node);
          }
          stack.push(setVecComp(old, comp, expectNum(nv, 'component value', node)));
          break;
        }
        case OP.COMP_STORE_INDEX: {
          const raw = COMP_BY_CODE[code[this.pc++]];
          const idx = stack.pop();
          const arr = stack.pop();
          const nv = stack.pop();
          if (!Array.isArray(arr)) throw runtimeError('indexed assignment target is not an array', node);
          const n = expectInt(idx, 'array index', node);
          if (n < 0 || n >= arr.length) throw runtimeError(`array index ${n} out of bounds (size ${arr.length})`, node);
          const old = arr[n];
          if (isParticle(old)) {
            particleSetField(old, raw, nv, node);
            stack.push(old);
            break;
          }
          if (isObj(old)) {
            old.fields.set(raw, nv);
            stack.push(old);
            break;
          }
          if (isColor(old)) {
            const updated = colorCompWrite(old, raw, expectNum(nv, 'component value', node), node);
            arr[n] = updated;
            stack.push(updated);
            break;
          }
          const comp = COMP_ALIAS[raw];
          if (!isVec(old)) throw runtimeError('component assignment target is not a vector', node);
          if ((old.t === 'vec2' && (comp === 'z' || comp === 'w')) ||
              (old.t === 'vec3' && comp === 'w')) {
            throw runtimeError(`${old.t} has no component '${raw}'`, node);
          }
          const updated = setVecComp(old, comp, expectNum(nv, 'component value', node));
          arr[n] = updated;
          stack.push(updated);
          break;
        }
        case OP.UNPACK: {
          const count = code[this.pc++];
          const v = stack.pop();
          const vals = unpackValues(v, count, node);
          for (let i = 0; i < vals.length; i++) stack.push(vals[i]);
          break;
        }
        case OP.STATIC: {
          const name = this.names[code[this.pc++]];
          const value = stack.pop();
          if (!this.statics.has(name)) this.statics.set(name, value);
          break;
        }
        case OP.JUMP: this.pc = code[this.pc]; break;
        case OP.JUMP_IF_FALSE: {
          const target = code[this.pc++];
          if (!truthy(stack.pop(), node)) this.pc = target;
          break;
        }
        case OP.JUMP_IF_TRUE: {
          const target = code[this.pc++];
          if (truthy(stack.pop(), node)) this.pc = target;
          break;
        }
        case OP.CALL_BUILTIN: {
          const bidx = code[this.pc++];
          const argCount = code[this.pc++];
          const args = [];
          for (let i = 0; i < argCount; i++) args.push(stack.pop());
          args.reverse();
          stack.push(callBuiltin(BUILTIN_BY_CODE[bidx], args, this.rt, node));
          break;
        }
        case OP.CALL_USER: {
          const fidx = code[this.pc++];
          const argCount = code[this.pc++];
          const args = [];
          for (let i = 0; i < argCount; i++) args.push(stack.pop());
          args.reverse();
          this.enterFunction(fidx, args, node);
          break;
        }
        case OP.CALL_VALUE: {
          const argCount = code[this.pc++];
          const args = [];
          for (let i = 0; i < argCount; i++) args.push(stack.pop());
          args.reverse();
          const callee = stack.pop();
          if (isFunc(callee)) {
            const fidx = this.funcIdxByName.get(callee.name);
            if (fidx == null) throw runtimeError(`function '${callee.name}' not found`, node);
            this.enterFunction(fidx, args, node);
          } else if (isLambda(callee)) {
            stack.push(this.rt.callLambda(callee, args, node));
          } else {
            throw runtimeError(`value of type ${typeName(callee)} is not callable`, node);
          }
          break;
        }
        case OP.METHOD: {
          const nameIdx = code[this.pc++];
          const argCount = code[this.pc++];
          const method = this.names[nameIdx];
          const args = [];
          for (let i = 0; i < argCount; i++) args.push(stack.pop());
          args.reverse();
          const obj = stack.pop();
          if (isParticle(obj)) {
            if (method === 'kill') {
              if (args.length !== 0) throw runtimeError("'kill' takes no arguments", node);
              particleKill(obj, node);
              stack.push(0);
            } else {
              throw runtimeError(`particle has no method '.${method}()'`, node);
            }
          } else if (isParticleList(obj)) {
            if (method === 'size') stack.push(obj.list.length);
            else throw runtimeError(`particle list has no method '.${method}()'`, node);
          } else if (isVec(obj)) {
            stack.push(callVecMethod(obj, method, args, node));
          } else if (isColor(obj)) {
            stack.push(callColorMethod(obj, method, args, node));
          } else if (isObj(obj)) {
            throw runtimeError(`objects have no method '.${method}()'`, node);
          } else if (Array.isArray(obj)) {
            stack.push(applyArrayMethod(obj, method, args, this.rt, node));
          } else {
            throw runtimeError(`method '.${method}()' requires an array, particle, particle list, vector or color, got ${typeName(obj)}`, node);
          }
          break;
        }
        case OP.LOAD_MEMBER: {
          const field = this.names[code[this.pc++]];
          const obj = stack.pop();
          if (isObj(obj)) { stack.push(obj.fields.get(field)); break; }
          if (!isParticle(obj)) throw runtimeError(`only particles / objects have fields '.${field}'`, node);
          stack.push(particleGetField(obj, field, node));
          break;
        }
        case OP.STORE_MEMBER: {
          const field = this.names[code[this.pc++]];
          const obj = stack.pop();
          const value = stack.pop();
          if (isObj(obj)) { obj.fields.set(field, value); break; }
          if (!isParticle(obj)) throw runtimeError(`only particles / objects have fields '.${field}'`, node);
          particleSetField(obj, field, value, node);
          break;
        }
        case OP.STORE_MEMBER_COMP: {
          const fieldIdx = code[this.pc++];
          const raw = COMP_BY_CODE[code[this.pc++]];
          const field = this.names[fieldIdx];
          const old = stack.pop();
          const obj = stack.pop();
          const nv = stack.pop();
          if (isObj(obj)) {
            if (isColor(old)) {
              obj.fields.set(field, colorCompWrite(old, raw, expectNum(nv, 'component value', node), node));
              break;
            }
            const comp = COMP_ALIAS[raw];
            if (!isVec(old)) throw runtimeError('component assignment target is not a vector', node);
            if ((old.t === 'vec2' && (comp === 'z' || comp === 'w')) || (old.t === 'vec3' && comp === 'w')) {
              throw runtimeError(`${old.t} has no component '${raw}'`, node);
            }
            obj.fields.set(field, setVecComp(old, comp, expectNum(nv, 'component value', node)));
            break;
          }
          if (!isParticle(obj)) throw runtimeError(`only particles / objects have fields '.${field}'`, node);
          const comp = COMP_ALIAS[raw];
          if (!isVec(old)) throw runtimeError('component assignment target is not a vector', node);
          if ((old.t === 'vec2' && (comp === 'z' || comp === 'w')) || (old.t === 'vec3' && comp === 'w')) {
            throw runtimeError(`${old.t} has no component '${raw}'`, node);
          }
          particleSetField(obj, field, setVecComp(old, comp, expectNum(nv, 'component value', node)), node);
          break;
        }
        case OP.ITER_BEGIN: {
          const iterable = stack.pop();
          if (isParticleList(iterable)) {
            stack.push({ arr: iterable.list.slice(), i: 0, wrap: true });
          } else if (Array.isArray(iterable)) {
            stack.push({ arr: iterable.slice(), i: 0, wrap: false });
          } else {
            throw runtimeError(`for-of requires a particle list or array, got ${typeName(iterable)}`, node);
          }
          break;
        }
        case OP.ITER_NEXT: {
          const it = stack.pop();
          if (!it || !Array.isArray(it.arr)) throw runtimeError('invalid iterator state', node);
          if (it.i >= it.arr.length) {
            stack.push(0);
            stack.push(it);
          } else {
            const raw = it.arr[it.i];
            it.i++;
            stack.push(it.wrap ? particleValue(raw) : raw);
            stack.push(1);
            stack.push(it);
          }
          break;
        }
        case OP.SPAWN: {
          const argCount = code[this.pc++];
          const args = [];
          for (let i = 0; i < argCount; i++) args.push(stack.pop());
          args.reverse();
          if (argCount > 1) throw runtimeError('this.spawn expects at most 1 argument', node);
          const fx = fxRuntime(this.rt);
          if (!fx || typeof fx.spawn !== 'function') throw runtimeError('this.spawn is not available here', node);
          const w = fx.spawn(argCount === 1 ? args[0] : undefined);
          if (!w) throw runtimeError('spawn failed', node);
          stack.push(particleValue(w));
          break;
        }
        case OP.ENTER_SCOPE: this.rt.pushScope(new Map()); break;
        case OP.EXIT_SCOPE: this.rt.popScope(); break;
        case OP.LOOP_GUARD: {
          const slot = code[this.pc++];
          const v = (this.loopCounters[slot] = (this.loopCounters[slot] || 0) + 1);
          if (v > MAX_LOOP_ITERATIONS) {
            throw runtimeError(`loop iteration limit (${MAX_LOOP_ITERATIONS}) exceeded`, node);
          }
          this.rt.guardLoop(node);
          break;
        }
        case OP.RETURN: {
          const value = stack.pop();
          const targetDepth = this.scopeDepthStack.pop();
          while (this.rt.scopes.length > targetDepth) this.rt.popScope();
          this.rt.inFunction = this.inFunctionStack.pop();
          this.rt.funcDepth--;
          this.pc = this.callStack.pop();
          stack.push(value);
          break;
        }
        default:
          throw new Error(`unknown bytecode op ${op}`);
      }
    }
    this.rt.popScope();
    return stack;
  }

  enterFunction(fidx, args, node) {
    if (this.rt.funcDepth >= MAX_RECURSION_DEPTH) {
      throw runtimeError(`maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded`, node);
    }
    const fn = this.funcs[fidx];
    this.rt.funcDepth++;
    this.inFunctionStack.push(this.rt.inFunction);
    this.rt.inFunction = true;
    this.scopeDepthStack.push(this.rt.scopes.length);
    this.callStack.push(this.pc);
    this.rt.pushScope(new Map());
    for (let i = 0; i < fn.params.length; i++) {
      this.rt.currentScope().set(this.names[fn.params[i]], i < args.length ? args[i] : 0);
    }
    this.pc = this.funcAddr[fidx];
  }
}

// —— 导出 API ——

// 创建对象级状态：{ globals: Map, constGlobals: Set, rand: prngState }。
export function createObjectState(seed) {
  const s = seed | 0;
  return { globals: new Map(), constGlobals: new Set(), rand: mulberry32(s), seed: s };
}

// 执行顶层 let/const 声明（对象级，每次重建运行时先于 setup 执行一次）。
// env: { t, duration, vars }（无 this/spawn/particles）。按源码顺序求值，引用靠后的全局名报错（TDZ）。
export function runTopLevel(program, objState, env) {
  const globals = program.globals || [];
  if (globals.length === 0) return objState;
  const rt = new Runtime('toplevel', program, objState, null, env || null, null);
  rt.pushScope(new Map());
  try {
    for (const d of globals) {
      if (d.type === 'destructure') {
        const v = rt.evalExpr(d.value);
        if (!isObj(v)) {
          throw runtimeError('object destructuring requires an object', d);
        }
        for (const name of d.names) {
          if (objState.globals.has(name)) {
            throw runtimeError(`duplicate global '${name}'`, d);
          }
          objState.globals.set(name, v.fields.get(name));
          if (d.kind === 'const') objState.constGlobals.add(name);
        }
        continue;
      }
      for (const dec of d.decls) {
        if (objState.globals.has(dec.name)) {
          throw runtimeError(`duplicate global '${dec.name}'`, dec);
        }
        const v = dec.init ? rt.evalExpr(dec.init) : undefined;
        objState.globals.set(dec.name, v);
        if (d.kind === 'const') objState.constGlobals.add(dec.name);
      }
    }
  } finally {
    rt.popScope();
  }
  return objState;
}

// 执行 setup（对象级，一次）。env: { t, st, duration, maxMs, vars, particles, spawn }。返回 objState。
export function runSetup(program, objState, env) {
  const rt = new Runtime('setup', program, objState, null, env || null, null);
  rt.pushScope(new Map());
  try {
    if (program.setup) rt.execStmt(program.setup.body);
  } finally {
    rt.popScope();
  }
  return objState;
}

// 执行 tick（每 50ms 一次）。ctx: { t, st, duration, maxMs, vars, particles, spawn }。
export function runTick(program, objState, ctx) {
  if (!program.tick) return;
  const rt = new Runtime('tick', program, objState, null, null, ctx || null);
  rt.pushScope(new Map());
  try {
    rt.execStmt(program.tick.body);
  } finally {
    rt.popScope();
  }
}

// 执行 process（每渲染帧一次）。ctx: { t, st, duration, maxMs, vars, particles, spawn }。
// AST 解释执行 process（字节码编译失败/不支持时的回退路径，保留原错误语义）。
function runProcessAst(program, objState, ctx) {
  const rt = new Runtime('process', program, objState, null, null, ctx || null);
  rt.pushScope(new Map());
  try {
    rt.execStmt(program.process.body);
  } finally {
    rt.popScope();
  }
}

// 字节码 VM 执行 process：先跑 uniform prelude（提升的顶层不变量），再跑主代码。
function runProcessVm(compiled, program, objState, ctx) {
  const statics = new Map(); // v12 无 static 语句，空表即可
  const uniforms = new Array(compiled.uniformCount);
  const vm = new Vm(compiled, objState, statics, ctx || null, uniforms, compiled.prelude, compiled.preludeLocs, 0);
  vm.run(); // prelude → 填充 uniforms
  vm.code = compiled.code;
  vm.locs = compiled.locs;
  vm.resetForRun(statics, ctx || null, uniforms, compiled.mainStart);
  vm.run(); // 主代码
}

export function runProcessFrame(program, objState, ctx) {
  if (!program.process) return;
  if (program._vmUnsupported) { runProcessAst(program, objState, ctx); return; }
  let compiled;
  try {
    const varNames = Object.keys((ctx && ctx.vars) || {});
    const globalNames = objState && objState.globals ? [...objState.globals.keys()] : [];
    compiled = getCompiledProgram(program, varNames, globalNames);
  } catch (e) {
    // 编译器不支持（或脚本非法）→ 回退 AST，由 AST 给出规范错误/语义。
    program._vmUnsupported = true;
    runProcessAst(program, objState, ctx);
    return;
  }
  runProcessVm(compiled, program, objState, ctx);
}

// —— 单表达式求值（UV 字段 / 预设 countExpr 等标量表达式）——
// 裸表达式按 script-lang 语法解析；ctx 与 process 的 this 上下文同构，返回 number，非 number 抛错。


// 通用表达式求值：返回任意值（number/vec/mat/bool/array）。低频路径。
export function evalExpressionValue(expr, ctx) {
  const node = parseExpression(expr);
  const program = { setup: null, tick: null, process: null, functions: new Map(), globals: [] };
  const rt = new Runtime('expr', program, createObjectState(0), null, null, ctx || null);
  rt.pushScope(new Map());
  try {
    return rt.evalExpr(node);
  } finally {
    rt.popScope();
  }
}

// 低频求值：每调用一次新建 Runtime/Map（countExpr 等非热路径用）。
// 仅接受标量结果；否则抛错。
export function evalExpression(expr, ctx) {
  const v = evalExpressionValue(expr, ctx);
  if (!isNum(v)) {
    const node = parseExpression(expr);
    throw runtimeError(`expression must evaluate to a number, got ${typeName(v)}`, node);
  }
  return v;
}

// 高频求值：预解析表达式并复用 Runtime/Map/作用域（UV 逐粒子逐帧路径使用）。
// 返回 { eval(ctx) }；ctx.vars 每次求值前重建，因此可安全复用。
export function createExpressionRunner(expr) {
  const node = parseExpression(expr);
  const program = { setup: null, tick: null, process: null, functions: new Map(), globals: [] };
  const objState = createObjectState(0);
  const rt = new Runtime('expr', program, objState, null, null, null);
  rt.pushScope(new Map());
  return {
    eval(ctx) {
      rt.ctx = ctx || null;
      rt.varsMap.clear();
      const varsObj = rt.ctx && rt.ctx.vars;
      if (varsObj) {
        for (const k of Object.keys(varsObj)) rt.varsMap.set(k, varsObj[k]);
      }
      const v = rt.evalExpr(node);
      if (!isNum(v)) {
        throw runtimeError(`expression must evaluate to a number, got ${typeName(v)}`, node);
      }
      return v;
    },
  };
}

// —— 共享迁移 API（替代 easing.js 旧迷你引擎的数学/解析工具）——
// 值形态统一为本模块的 vec3/mat3；优先级与 Parser 一致：|| < && < ==/!= < 比较 < 加减 < 乘除模 < 幂。

export const SCRIPT_FUNCTION_NAMES = Object.freeze([...BUILTIN_FUNCTIONS]);

export const SCRIPT_BINARY_PRECEDENCE = Object.freeze({
  '||': 1,
  '&&': 2,
  '==': 3, '!=': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
  '^': 7,
});

export const SCRIPT_NEG_PREC = 7.5; // 一元 -/! 高于幂（-2^2 = (-2)^2）

export function scriptVec3(x, y, z) { return vec3(x, y, z); }
export function scriptMat3(rows) { return mat3(rows); }
export function scriptMatMul(A, B) { return matMul(A, B, null); }
export function scriptRotX(t) { return rotXMat3(t); }
export function scriptRotY(t) { return rotYMat3(t); }
export function scriptRotZ(t) { return rotZMat3(t); }
export function scriptRotAxis(axis, t) { return mat3Rodrigues(vec3(axis[0], axis[1], axis[2]), t); }

// 解析表达式列表 [e1,e2,e3] → ['e1','e2','e3']（跳过括号内逗号）。
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