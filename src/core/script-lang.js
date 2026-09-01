/* =========================================================================
 * 自包含脚本语言运行时（setup / process）
 * -------------------------------------------------------------------------
 * 职责：
 *   1) tokenizer —— 把源码切成带行列号的 token 流
 *   2) 递归下降 parser —— 产出 AST（setup / process / 顶层 func）
 *   3) 解释器 —— 执行 setup（对象级）与 process（粒子级）
 *
 * 设计约束：
 *   - 纯逻辑 ESM：不依赖 DOM / THREE / 浏览器 API，可在 Node/Vitest 直接 import。
 *   - 值与对象形态：
 *       num   → JS number
 *       bool  → JS boolean
 *       vec2  → { t:'vec2', x, y }
 *       vec3  → { t:'vec3', x, y, z }
 *       mat3  → { t:'mat3', m:[[r0c0,r0c1,r0c2],[...],[...]] }（行主序）
 *       mat4  → { t:'mat4', m:[[...] x4] }（行主序）
 *       array → JS Array
 *       func  → { t:'func', name }
 *   - 错误一律抛 Error，消息含行列号 / 语句上下文（本模块使用英文消息文本）。
 *
 * 跨端一致性（Kotlin 端会照此实现，算法必须可精确复刻）：
 *   PRNG
 *     mulberry32：见 mulberry32()。rand() 使用对象级 PRNG 状态（对象 setup 时
 *     创建，每次 rand() 推进）；rand(seed) = mulberry32(seed|0) 的下一个值，
 *     不共享对象状态。
 *   3D Simplex
 *     标准 Gustavson 3D simplex：Grad3 梯度表 + 256 排列表。排列表由种子生成：
 *     先构造 [0..255] identity permutation，再用 mulberry32(seed) 做
 *     Fisher-Yates shuffle（固定顺序：i 从 255 递减到 1，j = floor(rng()*(i+1))，
 *     交换 p[i]、p[j]），最后按标准做法复制到 perm / permMod12（各 512 长）。
 *     noise(x,y,z) 使用 fx.seed 生成排列表；noise(x,y,z,seed) 使用显式 seed。
 *     标准结果 = 32 * 四角贡献和（理论范围约 [-1,1]）；为消除浮点误差越界，
 *     额外 clamp 到 [-1,1]（归一化说明见 noise3D()，Kotlin 端照做）。
 *   fbm
 *     octaves 至少 1；lacunarity = 2.0，gain = 0.5；累加后除以幅度和，
 *     再 clamp 到 [-1,1]。
 * ======================================================================= */

/* -------------------------------------------------------------------------
 * 常量 / 关键字 / 保留字
 * ---------------------------------------------------------------------- */

import { FAST_MATH } from './fastmath.js';

const KEYWORDS = new Set([
  'setup', 'process', 'func', 'return', 'if', 'else', 'while', 'do', 'for',
  'break', 'continue', 'global', 'static', 'true', 'false',
]);

// 粒子属性保留字（§8）：不能用于普通变量 / 函数参数 / 数组下标名。
const ATTR_NAMES = ['x', 'y', 'z', 'r', 'g', 'b', 'a', 'vx', 'vy', 'vz', 'sc', 'glow', 'light'];
const ATTR_SET = new Set(ATTR_NAMES);

// 内置只读量（§9）。setup 仅 n/t 可见；process 全部可见。
const BUILTIN_NAMES = new Set(['i', 'idx', 'n', 't', 'dt', 'uv_x', 'uv_y', 'life']);

// 常量（§13）。pi / e 在 tokenizer 中直接变成数值字面量，这里保留以防查表。
const CONSTANTS = new Map([
  ['TAU', Math.PI * 2],
  ['HALF_PI', Math.PI / 2],
  ['QUARTER_PI', Math.PI / 4],
  ['DEG2RAD', Math.PI / 180],
  ['RAD2DEG', 180 / Math.PI],
  ['pi', Math.PI],
  ['e', Math.E],
]);

// 向量分量访问名：r/g/b 分别是 x/y/z 的别名（§5 后缀）。
const COMP_ALIAS = { x: 'x', y: 'y', z: 'z', r: 'x', g: 'y', b: 'z' };
const COMP_NAMES = new Set(['x', 'y', 'z', 'r', 'g', 'b']);

const MAX_LOOP_ITERATIONS = 100000; // §14
const MAX_RECURSION_DEPTH = 64;     // §14
const EQ_TOLERANCE = 1e-6;          // 数组 find/includes/unique 相等容差（§10）

/* -------------------------------------------------------------------------
 * 值类型构造与判定
 * ---------------------------------------------------------------------- */

const vec2 = (x, y) => ({ t: 'vec2', x, y });
const vec3 = (x, y, z) => ({ t: 'vec3', x, y, z });
const mat3 = (m) => ({ t: 'mat3', m });
const mat4 = (m) => ({ t: 'mat4', m });

const isNum = (v) => typeof v === 'number';
const isBool = (v) => typeof v === 'boolean';
const isVec = (v) => v != null && (v.t === 'vec2' || v.t === 'vec3');
const isMat = (v) => v != null && (v.t === 'mat3' || v.t === 'mat4');
const isFunc = (v) => v != null && v.t === 'func';

const vecDim = (v) => (v.t === 'vec2' ? 2 : 3);
const vecComps = (v) => (v.t === 'vec2' ? [v.x, v.y] : [v.x, v.y, v.z]);
const mkVec = (dim, comps) => (dim === 2 ? vec2(comps[0], comps[1]) : vec3(comps[0], comps[1], comps[2]));

function typeName(v) {
  if (typeof v === 'number') return 'num';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return 'array';
  if (v == null) return 'null';
  if (v.t === 'vec2' || v.t === 'vec3' || v.t === 'mat3' || v.t === 'mat4' || v.t === 'func') return v.t;
  return 'unknown';
}

/* -------------------------------------------------------------------------
 * 错误
 * ---------------------------------------------------------------------- */

function parseError(msg, line, col) {
  return new Error(`${msg} (line ${line}, col ${col})`);
}

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
  if (!isVec(v)) throw runtimeError(`${name} requires a vec2/vec3, got ${typeName(v)}`, node);
  return v;
}

function expectArr(v, name, node) {
  if (!Array.isArray(v)) throw runtimeError(`${name} requires an array, got ${typeName(v)}`, node);
  return v;
}

function sameDimVec(a, b, node) {
  if (vecDim(a) !== vecDim(b)) throw runtimeError('vector dimension mismatch', node);
}

/* =========================================================================
 * PRNG —— mulberry32
 * -------------------------------------------------------------------------
 * 标准 mulberry32：
 *   state 为 32 位有符号整数，初始 state = seed | 0。
 *   每步：
 *     state = (state + 0x6D2B79F5) | 0
 *     t = Math.imul(state ^ (state >>> 15), 1 | state)
 *     t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
 *     return ((t ^ (t >>> 14)) >>> 0) / 4294967296      // [0, 1)
 * Kotlin 端用 Int/Long 模拟 32 位回绕即可精确复刻。
 * ======================================================================= */
function mulberry32(seed) {
  let a = seed | 0;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* =========================================================================
 * 3D Simplex 噪声（标准 Gustavson 实现 + 种子排列表）
 * -------------------------------------------------------------------------
 * Grad3 梯度表（12 个方向，标准表）：
 *   [1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],
 *   [1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],
 *   [0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]
 * 排列表生成（见 makePermutation）：
 *   p = [0..255] identity
 *   用 mulberry32(seed) 做 Fisher-Yates：for i = 255 down to 1:
 *     j = floor(rng() * (i + 1)); swap(p[i], p[j])
 *   perm[i] = p[i & 255]（i in 0..511）
 *   permMod12[i] = perm[i] % 12
 * 结果归一化：标准结果 32 * sum 理论范围约 [-1,1]。为避免极少数浮点越界
 * （>1 或 <-1 的误差量级 < 1e-12），返回时 clamp 到 [-1,1]。Kotlin 端照做。
 * ======================================================================= */

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

/* =========================================================================
 * Tokenizer
 * ======================================================================= */

function isDigit(c) { return c >= '0' && c <= '9'; }
function isIdentStart(c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'; }
function isIdentPart(c) { return isIdentStart(c) || isDigit(c); }

function tokenize(source) {
  const tokens = [];
  const src = String(source == null ? '' : source);
  const len = src.length;
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = () => {
    const c = src[i++];
    if (c === '\n') { line++; col = 1; } else { col++; }
    return c;
  };

  while (i < len) {
    const c = src[i];

    // 空白
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { advance(); continue; }

    // 行注释
    if (c === '/' && src[i + 1] === '/') {
      while (i < len && src[i] !== '\n') advance();
      continue;
    }

    // 块注释
    if (c === '/' && src[i + 1] === '*') {
      const startLine = line, startCol = col;
      advance(); advance();
      let closed = false;
      while (i < len) {
        if (src[i] === '*' && src[i + 1] === '/') { advance(); advance(); closed = true; break; }
        advance();
      }
      if (!closed) throw parseError('unterminated block comment', startLine, startCol);
      continue;
    }

    // 数字：123、1.5、.5、1e3（负号由一元 - 处理）
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      const startLine = line, startCol = col;
      const m = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i));
      const text = m[0];
      for (let k = 0; k < text.length; k++) advance();
      tokens.push({ type: 'num', value: parseFloat(text), line: startLine, col: startCol });
      continue;
    }

    // 字符串
    if (c === '"') {
      const startLine = line, startCol = col;
      advance();
      let out = '';
      let closed = false;
      while (i < len) {
        const ch = src[i];
        if (ch === '"') { advance(); closed = true; break; }
        if (ch === '\\') {
          advance();
          const esc = src[i];
          if (esc === 'n') { out += '\n'; advance(); }
          else if (esc === 'r') { out += '\r'; advance(); }
          else if (esc === 't') { out += '\t'; advance(); }
          else if (esc === '"') { out += '"'; advance(); }
          else if (esc === '\\') { out += '\\'; advance(); }
          else { out += esc; advance(); }
          continue;
        }
        out += ch;
        advance();
      }
      if (!closed) throw parseError('unterminated string literal', startLine, startCol);
      tokens.push({ type: 'str', value: out, line: startLine, col: startCol });
      continue;
    }

    // 标识符 / 关键字
    if (isIdentStart(c)) {
      const startLine = line, startCol = col;
      let name = '';
      while (i < len && isIdentPart(src[i])) name += advance();
      // pi / e 是数值字面量保留名（§13）
      if (name === 'pi') tokens.push({ type: 'num', value: Math.PI, line: startLine, col: startCol });
      else if (name === 'e') tokens.push({ type: 'num', value: Math.E, line: startLine, col: startCol });
      else tokens.push({ type: 'ident', value: name, line: startLine, col: startCol });
      continue;
    }

    // 两字符运算符
    if ((c === '=' || c === '!' || c === '<' || c === '>') && src[i + 1] === '=') {
      const startLine = line, startCol = col;
      let op;
      if (c === '=') op = '==';
      else if (c === '!') op = '!=';
      else if (c === '<') op = '<=';
      else op = '>=';
      advance(); advance();
      tokens.push({ type: 'punct', value: op, line: startLine, col: startCol });
      continue;
    }
    if ((c === '&' && src[i + 1] === '&') || (c === '|' && src[i + 1] === '|')) {
      const startLine = line, startCol = col;
      const op = c === '&' ? '&&' : '||';
      advance(); advance();
      tokens.push({ type: 'punct', value: op, line: startLine, col: startCol });
      continue;
    }

    // 单字符运算符 / 分隔符
    if ('+-*/%^!?:=<>()[]{},;.'.includes(c)) {
      const startLine = line, startCol = col;
      advance();
      tokens.push({ type: 'punct', value: c, line: startLine, col: startCol });
      continue;
    }

    throw parseError(`unexpected character '${c}'`, line, col);
  }

  tokens.push({ type: 'eof', value: '<eof>', line, col });
  return tokens;
}

/* =========================================================================
 * Parser（递归下降）
 * ======================================================================= */

function toLValue(expr, tok) {
  switch (expr.type) {
    case 'var':
      return { type: 'var', name: expr.name, line: expr.line, col: expr.col };
    case 'index':
      return { type: 'index', target: expr.target, index: expr.index, line: expr.line, col: expr.col };
    case 'comp':
      return { type: 'comp', target: expr.target, comp: expr.comp, line: expr.line, col: expr.col };
    case 'array': {
      const names = [];
      for (const item of expr.items) {
        if (item.type !== 'var') {
          throw parseError('destructuring assignment names must be identifiers', item.line, item.col);
        }
        names.push(item.name);
      }
      return { type: 'unpack', names, line: expr.line, col: expr.col };
    }
    default:
      throw parseError('invalid assignment target', tok.line, tok.col);
  }
}

class Parser {
  constructor(source) {
    this.tokens = tokenize(source);
    this.pos = 0;
    this.phase = null;     // 'setup' | 'process' | 'func'（当前顶层区块）
    this.loopDepth = 0;
  }

  peek(offset = 0) {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  next() {
    const tok = this.tokens[this.pos];
    if (tok.type !== 'eof') this.pos++;
    return tok;
  }

  check(value) {
    const tok = this.peek();
    return tok.value === value;
  }

  match(value) {
    if (this.check(value)) { this.next(); return true; }
    return false;
  }

  matchKw(kw) {
    const tok = this.peek();
    if (tok.type === 'ident' && tok.value === kw) { this.next(); return true; }
    return false;
  }

  atEnd() { return this.peek().type === 'eof'; }

  errorAt(tok, msg) { throw parseError(msg, tok.line, tok.col); }

  expect(value, what) {
    const tok = this.peek();
    if (tok.value !== value) {
      throw parseError(`expected '${value}'${what ? ' ' + what : ''}, got '${tok.value}'`, tok.line, tok.col);
    }
    return this.next();
  }

  expectIdent() {
    const tok = this.peek();
    if (tok.type !== 'ident') {
      throw parseError(`expected identifier, got '${tok.value}'`, tok.line, tok.col);
    }
    return this.next();
  }

  expectKw(kw) {
    const tok = this.peek();
    if (tok.type !== 'ident' || tok.value !== kw) {
      throw parseError(`expected '${kw}', got '${tok.value}'`, tok.line, tok.col);
    }
    return this.next();
  }

  /* -- 顶层 -- */

  parseProgram() {
    const setup = [];
    const process = [];
    const functions = new Map();

    while (!this.atEnd()) {
      if (this.matchKw('setup')) {
        this.expect('{');
        this.phase = 'setup';
        while (!this.check('}') && !this.atEnd()) setup.push(this.parseStatement());
        this.expect('}');
        this.phase = null;
      } else if (this.matchKw('process')) {
        this.expect('{');
        this.phase = 'process';
        while (!this.check('}') && !this.atEnd()) process.push(this.parseStatement());
        this.expect('}');
        this.phase = null;
      } else if (this.matchKw('func')) {
        const nameTok = this.expectIdent();
        this.validateFuncName(nameTok);
        this.expect('(');
        const params = this.parseParamList();
        this.expect(')');
        this.phase = 'func';
        const body = this.parseBlock();
        this.phase = null;
        if (functions.has(nameTok.value)) {
          this.errorAt(nameTok, `duplicate function name '${nameTok.value}'`);
        }
        functions.set(nameTok.value, {
          type: 'func', name: nameTok.value, params, body,
          line: nameTok.line, col: nameTok.col,
        });
      } else {
        const tok = this.peek();
        this.errorAt(tok, `expected 'setup', 'process' or 'func', got '${tok.value}'`);
      }
    }

    return { setup, process, functions };
  }

  validateFuncName(tok) {
    const name = tok.value;
    if (KEYWORDS.has(name) || ATTR_SET.has(name) || BUILTIN_NAMES.has(name) ||
        CONSTANTS.has(name) || BUILTIN_FUNCTIONS.has(name)) {
      this.errorAt(tok, `reserved name cannot be used as function name: '${name}'`);
    }
  }

  parseParamList() {
    const params = [];
    if (!this.check(')')) {
      const tok = this.expectIdent();
      this.validateParamName(tok);
      params.push(tok.value);
      while (this.match(',')) {
        const t2 = this.expectIdent();
        this.validateParamName(t2);
        params.push(t2.value);
      }
    }
    return params;
  }

  validateParamName(tok) {
    const name = tok.value;
    if (KEYWORDS.has(name) || ATTR_SET.has(name) || BUILTIN_NAMES.has(name)) {
      this.errorAt(tok, `reserved name cannot be used as parameter: '${name}'`);
    }
  }

  parseBlock() {
    const open = this.expect('{');
    const body = [];
    while (!this.check('}') && !this.atEnd()) body.push(this.parseStatement());
    this.expect('}');
    return { type: 'block', body, line: open.line, col: open.col };
  }

  /* -- 语句 -- */

  parseStatement() {
    const tok = this.peek();

    if (tok.type === 'punct' && tok.value === '{') return this.parseBlock();

    if (tok.type === 'ident') {
      switch (tok.value) {
        case 'if': return this.parseIf();
        case 'while': return this.parseWhile();
        case 'do': return this.parseDoWhile();
        case 'for': return this.parseFor();
        case 'break': return this.parseBreak(tok);
        case 'continue': return this.parseContinue(tok);
        case 'return': return this.parseReturn(tok);
        case 'global': return this.parseGlobal(tok);
        case 'static': return this.parseStatic(tok);
        default: break;
      }
    }

    return this.parseAssignOrExprStatement();
  }

  parseIf() {
    const start = this.next(); // 'if'
    this.expect('(');
    const cond = this.parseTernary();
    this.expect(')');
    const then = this.parseStatement();
    let els = null;
    if (this.matchKw('else')) els = this.parseStatement();
    return { type: 'if', cond, then, els, line: start.line, col: start.col };
  }

  parseWhile() {
    const start = this.next();
    this.expect('(');
    const cond = this.parseTernary();
    this.expect(')');
    this.loopDepth++;
    const body = this.parseStatement();
    this.loopDepth--;
    return { type: 'while', cond, body, line: start.line, col: start.col };
  }

  parseDoWhile() {
    const start = this.next();
    this.loopDepth++;
    const body = this.parseStatement();
    this.loopDepth--;
    this.expectKw('while');
    this.expect('(');
    const cond = this.parseTernary();
    this.expect(')');
    this.expect(';');
    return { type: 'do', body, cond, line: start.line, col: start.col };
  }

  parseFor() {
    const start = this.next();
    this.expect('(');
    let init = null;
    if (!this.check(';')) init = this.parseAssignExpr();
    this.expect(';');
    let cond = null;
    if (!this.check(';')) cond = this.parseTernary();
    this.expect(';');
    let inc = null;
    if (!this.check(')')) inc = this.parseAssignExpr();
    this.expect(')');
    this.loopDepth++;
    const body = this.parseStatement();
    this.loopDepth--;
    return { type: 'for', init, cond, inc, body, line: start.line, col: start.col };
  }

  parseBreak(tok) {
    if (this.loopDepth === 0) this.errorAt(tok, "'break' outside loop");
    this.next();
    this.expect(';');
    return { type: 'break', line: tok.line, col: tok.col };
  }

  parseContinue(tok) {
    if (this.loopDepth === 0) this.errorAt(tok, "'continue' outside loop");
    this.next();
    this.expect(';');
    return { type: 'continue', line: tok.line, col: tok.col };
  }

  parseReturn(tok) {
    if (this.phase !== 'func') this.errorAt(tok, "'return' only allowed inside a function");
    this.next();
    let expr = null;
    if (!this.check(';')) expr = this.parseTernary();
    this.expect(';');
    return { type: 'return', expr, line: tok.line, col: tok.col };
  }

  parseGlobal(tok) {
    if (this.phase !== 'setup') this.errorAt(tok, "'global' only allowed inside setup");
    return this.parseGlobalStaticBody(tok, 'global');
  }

  parseStatic(tok) {
    if (this.phase !== 'process') this.errorAt(tok, "'static' only allowed inside process");
    return this.parseGlobalStaticBody(tok, 'static');
  }

  parseGlobalStaticBody(tok, type) {
    this.next();
    const nameTok = this.expectIdent();
    this.validateGlobalStaticName(nameTok);
    let init = null;
    if (this.match('=')) init = this.parseTernary();
    this.expect(';');
    return { type, name: nameTok.value, init, line: tok.line, col: tok.col };
  }

  validateGlobalStaticName(tok) {
    const name = tok.value;
    if (KEYWORDS.has(name) || CONSTANTS.has(name)) {
      this.errorAt(tok, `reserved name cannot be declared: '${name}'`);
      return;
    }
    if (this.phase === 'setup') {
      // setup 只保留 n/t 只读内置量；粒子属性与其余内置名都允许作为变量。
      if (name === 'n' || name === 't') {
        this.errorAt(tok, `reserved name cannot be declared: '${name}'`);
      }
    } else if (this.phase === 'process') {
      if (ATTR_SET.has(name) || BUILTIN_NAMES.has(name)) {
        this.errorAt(tok, `reserved name cannot be declared: '${name}'`);
      }
    }
  }

  parseAssignOrExprStatement() {
    const start = this.peek();
    const expr = this.parseAssignExpr();
    if (expr.type === 'assign') {
      this.expect(';');
      return expr;
    }
    this.expect(';');
    if (expr.type !== 'call' && expr.type !== 'method') {
      this.errorAt(start, 'expression statement must be a function call');
    }
    return { type: 'expr', expr, line: start.line, col: start.col };
  }

  // 语句层赋值：= 右结合，且只在此处出现（§5 优先级 1）。
  parseAssignExpr() {
    const start = this.peek();
    const left = this.parseTernary();
    if (this.match('=')) {
      const target = toLValue(left, start);
      const value = this.parseAssignExpr();
      return { type: 'assign', target, value, line: start.line, col: start.col };
    }
    return left;
  }

  /* -- 表达式 -- */

  parseTernary() {
    const cond = this.parseOr();
    if (this.match('?')) {
      const qTok = this.tokens[this.pos - 1];
      const thenExpr = this.parseTernary();
      this.expect(':');
      const elseExpr = this.parseTernary();
      return { type: 'ternary', cond, thenExpr, elseExpr, line: qTok.line, col: qTok.col };
    }
    return cond;
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.match('||')) {
      const opTok = this.tokens[this.pos - 1];
      const right = this.parseAnd();
      left = { type: 'binary', op: '||', left, right, line: opTok.line, col: opTok.col };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseEquality();
    while (this.match('&&')) {
      const opTok = this.tokens[this.pos - 1];
      const right = this.parseEquality();
      left = { type: 'binary', op: '&&', left, right, line: opTok.line, col: opTok.col };
    }
    return left;
  }

  parseEquality() {
    let left = this.parseComparison();
    while (this.check('==') || this.check('!=')) {
      const opTok = this.next();
      const right = this.parseComparison();
      left = { type: 'binary', op: opTok.value, left, right, line: opTok.line, col: opTok.col };
    }
    return left;
  }

  parseComparison() {
    let left = this.parseAdditive();
    while (this.check('<') || this.check('<=') || this.check('>') || this.check('>=')) {
      const opTok = this.next();
      const right = this.parseAdditive();
      left = { type: 'binary', op: opTok.value, left, right, line: opTok.line, col: opTok.col };
    }
    return left;
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.check('+') || this.check('-')) {
      const opTok = this.next();
      const right = this.parseMultiplicative();
      left = { type: 'binary', op: opTok.value, left, right, line: opTok.line, col: opTok.col };
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parsePower();
    while (this.check('*') || this.check('/') || this.check('%')) {
      const opTok = this.next();
      const right = this.parsePower();
      left = { type: 'binary', op: opTok.value, left, right, line: opTok.line, col: opTok.col };
    }
    return left;
  }

  // 幂：优先级高于一元（§5），右结合。
  parsePower() {
    let left = this.parseUnary();
    while (this.match('^')) {
      const opTok = this.tokens[this.pos - 1];
      const right = this.parsePower();
      left = { type: 'binary', op: '^', left, right, line: opTok.line, col: opTok.col };
    }
    return left;
  }

  parseUnary() {
    if (this.check('-') || this.check('!')) {
      const opTok = this.next();
      const operand = this.parseUnary();
      return { type: 'unary', op: opTok.value, operand, line: opTok.line, col: opTok.col };
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    let expr = this.parsePrimary();
    while (true) {
      if (this.match('(')) {
        const args = this.parseArgs();
        expr = { type: 'call', callee: expr, args, line: expr.line, col: expr.col };
      } else if (this.match('[')) {
        const idx = this.parseTernary();
        this.expect(']');
        expr = { type: 'index', target: expr, index: idx, line: expr.line, col: expr.col };
      } else if (this.match('.')) {
        const nameTok = this.expectIdent();
        if (this.match('(')) {
          const args = this.parseArgs();
          expr = { type: 'method', object: expr, method: nameTok.value, args, line: expr.line, col: expr.col };
        } else {
          if (!COMP_NAMES.has(nameTok.value)) {
            this.errorAt(nameTok, `invalid component or method name '.${nameTok.value}'`);
          }
          expr = { type: 'comp', target: expr, comp: nameTok.value, line: expr.line, col: expr.col };
        }
      } else {
        break;
      }
    }
    return expr;
  }

  parseArgs() {
    const args = [];
    if (!this.check(')')) {
      args.push(this.parseTernary());
      while (this.match(',')) args.push(this.parseTernary());
    }
    this.expect(')');
    return args;
  }

  parsePrimary() {
    const tok = this.peek();

    if (tok.type === 'num') { this.next(); return { type: 'num', value: tok.value, line: tok.line, col: tok.col }; }
    if (tok.type === 'str') { this.next(); return { type: 'str', value: tok.value, line: tok.line, col: tok.col }; }

    if (tok.type === 'ident') {
      this.next();
      if (tok.value === 'true' || tok.value === 'false') {
        return { type: 'bool', value: tok.value === 'true', line: tok.line, col: tok.col };
      }
      return { type: 'var', name: tok.value, line: tok.line, col: tok.col };
    }

    if (tok.type === 'punct' && tok.value === '(') {
      this.next();
      const expr = this.parseTernary();
      this.expect(')');
      return expr;
    }

    if (tok.type === 'punct' && tok.value === '[') {
      this.next();
      const items = [];
      if (!this.check(']')) {
        items.push(this.parseTernary());
        while (this.match(',')) items.push(this.parseTernary());
      }
      this.expect(']');
      return { type: 'array', items, line: tok.line, col: tok.col };
    }

    this.errorAt(tok, `unexpected token '${tok.value}'`);
  }
}

export function parseProgram(source) {
  return new Parser(source).parseProgram();
}

/* =========================================================================
 * 相等比较 / 排序比较
 * ======================================================================= */

// §7 ==/!= ：精确比较（无容差）。
function eqExact(a, b) {
  if (isNum(a) && isNum(b)) return a === b;
  if (isBool(a) && isBool(b)) return a === b;
  if (isVec(a) && isVec(b)) {
    if (a.t !== b.t) return false;
    return a.x === b.x && a.y === b.y && (a.t === 'vec2' || a.z === b.z);
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
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!eqExact(a[i], b[i])) return false;
    return true;
  }
  return false;
}

// §10 find/includes/unique 相等：数值与向量/矩阵分量按 1e-6 容差，布尔精确，数组递归。
function eqTol(a, b) {
  if (isNum(a) && isNum(b)) return Math.abs(a - b) <= EQ_TOLERANCE;
  if (isBool(a) && isBool(b)) return a === b;
  if (isVec(a) && isVec(b)) {
    if (a.t !== b.t) return false;
    return Math.abs(a.x - b.x) <= EQ_TOLERANCE &&
      Math.abs(a.y - b.y) <= EQ_TOLERANCE &&
      (a.t === 'vec2' || Math.abs(a.z - b.z) <= EQ_TOLERANCE);
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
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!eqTol(a[i], b[i])) return false;
    return true;
  }
  return false;
}

// §11 默认升序排序比较。返回 -1 / 0 / 1。混合类型直接抛错。
function defaultCompare(a, b, node) {
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
      const c = defaultCompare(a[i], b[i], node);
      if (c !== 0) return c;
    }
    return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
  }
  throw runtimeError(`values of type ${ta} are not sortable`, node);
}

/* =========================================================================
 * 控制流信号（return / break / continue）
 * ======================================================================= */

class Flow {
  constructor(kind, value) {
    this.kind = kind;
    this.value = value;
  }
}

/* =========================================================================
 * 运行时（解释器）
 * ======================================================================= */

class Runtime {
  constructor(phase, program, objState, statics, env, ctx) {
    this.phase = phase;
    this.program = program;
    this.objState = objState;
    this.statics = statics || null;
    this.env = env || null;
    this.ctx = ctx || null;
    this.scopes = [];
    this.funcDepth = 0;
    this.inFunction = false;

    const varsObj = phase === 'setup' ? (env && env.vars) : (ctx && ctx.vars);
    this.varsMap = new Map();
    if (varsObj) {
      for (const k of Object.keys(varsObj)) this.varsMap.set(k, varsObj[k]);
    }
  }

  pushScope(map) { this.scopes.push(map || new Map()); }
  popScope() { this.scopes.pop(); }
  currentScope() { return this.scopes[this.scopes.length - 1]; }

  /* -- 名称查找 -- */

  lookupName(name, node) {
    // 1) 块级 / 函数局部作用域（由内向外）
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const s = this.scopes[i];
      if (s.has(name)) return s.get(name);
    }
    // 2) process 的内置量 / 粒子属性：先于 global，避免 setup 中同名 global 遮蔽它们。
    if (this.phase === 'process') {
      const builtin = this.lookupBuiltin(name);
      if (builtin.found) return builtin.value;
      if (ATTR_SET.has(name)) return attrRead(name, this.ctx);
    }
    // 3) global（对象级）
    if (this.objState.globals.has(name)) return this.objState.globals.get(name);
    // 4) static（每粒子）
    if (this.phase === 'process' && this.statics && this.statics.has(name)) return this.statics.get(name);
    // 5) setup 内置只读量（n/t）
    if (this.phase === 'setup') {
      const builtin = this.lookupBuiltin(name);
      if (builtin.found) return builtin.value;
    }
    // 6) fx.vars 注入
    if (this.varsMap.has(name)) return this.varsMap.get(name);
    // 7) 常量
    if (CONSTANTS.has(name)) return CONSTANTS.get(name);
    // 8) 顶层函数（作为 func 值；若被同名变量遮蔽，上面的作用域/global/static 会先命中）
    if (this.program.functions.has(name)) return { t: 'func', name };
    throw runtimeError(`unknown variable '${name}'`, node);
  }

  lookupBuiltin(name) {
    if (this.phase === 'setup') {
      if (name === 'n') return { found: true, value: this.env && this.env.n != null ? this.env.n : 0 };
      if (name === 't') return { found: true, value: this.env && this.env.t != null ? this.env.t : 0 };
    } else if (this.phase === 'process') {
      switch (name) {
        case 'i': return { found: true, value: this.ctx && this.ctx.i != null ? this.ctx.i : 0 };
        case 'idx': return { found: true, value: this.ctx && this.ctx.i != null ? this.ctx.i : 0 };
        case 'n': return { found: true, value: this.ctx && this.ctx.n != null ? this.ctx.n : 0 };
        case 't': return { found: true, value: this.ctx && this.ctx.t != null ? this.ctx.t : 0 };
        case 'dt': return { found: true, value: this.ctx && this.ctx.dt != null ? this.ctx.dt : 0 };
        case 'uv_x': return { found: true, value: this.ctx && this.ctx.uv_x != null ? this.ctx.uv_x : 0 };
        case 'uv_y': return { found: true, value: this.ctx && this.ctx.uv_y != null ? this.ctx.uv_y : 0 };
        case 'life': return { found: true, value: this.ctx && this.ctx.life != null ? this.ctx.life : 0 };
        default: break;
      }
    }
    return { found: false };
  }

  /* -- 赋值 -- */

  assignName(name, value, node) {
    // 粒子属性：仅 process 写入输出；setup 中这些名字按普通变量处理。
    if (this.phase === 'process' && ATTR_SET.has(name)) {
      attrWrite(name, value, this.ctx, node);
      return;
    }
    // 内置只读量：process 全部只读；setup 仅 n/t 只读。
    if (this.phase === 'process' && BUILTIN_NAMES.has(name)) {
      throw runtimeError(`cannot assign to read-only name '${name}'`, node);
    }
    if (this.phase === 'setup' && (name === 'n' || name === 't')) {
      throw runtimeError(`cannot assign to read-only name '${name}'`, node);
    }

    // 局部作用域
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const s = this.scopes[i];
      if (s.has(name)) { s.set(name, value); return; }
    }

    // global：setup 顶层可写，process / 函数内只读。
    if (this.objState.globals.has(name)) {
      if (this.phase === 'setup' && !this.inFunction) {
        this.objState.globals.set(name, value);
        return;
      }
      throw runtimeError(`global '${name}' is read-only here`, node);
    }

    // static：process 内可写。
    if (this.phase === 'process' && this.statics && this.statics.has(name)) {
      this.statics.set(name, value);
      return;
    }

    // 剩余只读名：fx.vars 与常量；函数名允许被变量遮蔽。
    if (this.varsMap.has(name) || CONSTANTS.has(name)) {
      throw runtimeError(`cannot assign to read-only name '${name}'`, node);
    }

    // 隐式局部变量（当前块作用域）
    this.currentScope().set(name, value);
  }

  assignTarget(target, value, node) {
    if (target.type === 'var') {
      this.assignName(target.name, value, node);
      return;
    }
    if (target.type === 'index') {
      const arr = this.evalExpr(target.target);
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
      if (!isVec(v)) throw runtimeError('component assignment target is not a vector', node);
      const comp = COMP_ALIAS[target.comp];
      if (v.t === 'vec2' && (comp === 'z')) {
        throw runtimeError(`vec2 has no component '${target.comp}'`, node);
      }
      const updated = setVecComp(v, comp, expectNum(value, 'component value', node));
      this.assignTarget(target.target, updated, node);
      return;
    }
    throw runtimeError(`invalid assignment target '${target.type}'`, node);
  }

  /* -- 语句执行 -- */

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
        const v = node.expr ? this.evalExpr(node.expr) : 0;
        throw new Flow('return', v);
      }
      case 'global': {
        const v = node.init ? this.evalExpr(node.init) : 0;
        this.objState.globals.set(node.name, v);
        return;
      }
      case 'static': {
        if (!this.statics.has(node.name)) {
          const v = node.init ? this.evalExpr(node.init) : 0;
          this.statics.set(node.name, v);
        }
        return;
      }
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

  execWhile(node) {
    let iter = 0;
    while (true) {
      const c = this.evalExpr(node.cond);
      if (!truthy(c, node.cond)) break;
      if (++iter > MAX_LOOP_ITERATIONS) {
        throw runtimeError(`loop iteration limit (${MAX_LOOP_ITERATIONS}) exceeded`, node);
      }
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
    else this.evalExpr(part);
  }

  /* -- 表达式求值 -- */

  evalExpr(node) {
    switch (node.type) {
      case 'num': return node.value;
      case 'str': return node.value;
      case 'bool': return node.value;
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
      case 'call': return this.evalCall(node);
      case 'method': return this.evalMethod(node);
      default:
        throw runtimeError(`unknown expression type '${node.type}'`, node);
    }
  }

  evalUnary(node) {
    const v = this.evalExpr(node.operand);
    if (node.op === '!') {
      if (!isNum(v) && !isBool(v)) {
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
      if (!isNum(r) && !isBool(r)) throw runtimeError(`'&&' requires num/bool operands, got ${typeName(r)}`, node);
      return r;
    }
    if (op === '||') {
      const l = this.evalExpr(node.left);
      if (truthy(l, node.left)) return l;
      const r = this.evalExpr(node.right);
      if (!isNum(r) && !isBool(r)) throw runtimeError(`'||' requires num/bool operands, got ${typeName(r)}`, node);
      return r;
    }
    const a = this.evalExpr(node.left);
    const b = this.evalExpr(node.right);
    return binaryOp(op, a, b, node);
  }

  evalIndex(node) {
    const target = this.evalExpr(node.target);
    if (!Array.isArray(target)) {
      throw runtimeError(`index access requires an array, got ${typeName(target)}`, node);
    }
    const idx = this.evalExpr(node.index);
    const n = expectInt(idx, 'array index', node);
    if (n < 0 || n >= target.length) {
      throw runtimeError(`array index ${n} out of bounds (size ${target.length})`, node);
    }
    return target[n];
  }

  evalComp(node) {
    const target = this.evalExpr(node.target);
    if (!isVec(target)) {
      throw runtimeError(`component access requires a vector, got ${typeName(target)}`, node);
    }
    const comp = COMP_ALIAS[node.comp];
    if (target.t === 'vec2' && comp === 'z') {
      throw runtimeError(`vec2 has no component '${node.comp}'`, node);
    }
    return target[comp];
  }

  evalCall(node) {
    const callee = node.callee;
    const args = node.args.map((a) => this.evalExpr(a));

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
    if (isFunc(fn)) return this.callUserFunc(this.program.functions.get(fn.name), args, node);
    throw runtimeError(`value of type ${typeName(fn)} is not callable`, node);
  }

  evalMethod(node) {
    const obj = this.evalExpr(node.object);
    if (!Array.isArray(obj)) {
      throw runtimeError(`method '.${node.method}()' requires an array, got ${typeName(obj)}`, node);
    }
    const args = node.args.map((a) => this.evalExpr(a));
    return applyArrayMethod(obj, node.method, args, this, node);
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
      this.currentScope().set(fn.params[i], i < args.length ? args[i] : 0);
    }

    let result = 0;
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

/* -- 粒属性读取/写入（§8） -- */

function ensureOut(ctx) {
  if (!ctx.out) ctx.out = {};
  const out = ctx.out;
  if (!Array.isArray(out.pos)) out.pos = [0, 0, 0];
  if (!Array.isArray(out.color)) out.color = [1, 1, 1, 1];
  if (!Array.isArray(out.vel)) out.vel = [0, 0, 0];
  if (!isNum(out.scale)) out.scale = 1;
  if (!isBool(out.glow)) out.glow = false;
  if (!isNum(out.light)) out.light = 0;
  return out;
}

function attrRead(name, ctx) {
  const out = ensureOut(ctx);
  switch (name) {
    case 'x': return out.pos[0];
    case 'y': return out.pos[1];
    case 'z': return out.pos[2];
    case 'r': return out.color[0];
    case 'g': return out.color[1];
    case 'b': return out.color[2];
    case 'a': return out.color[3];
    case 'vx': return out.vel[0];
    case 'vy': return out.vel[1];
    case 'vz': return out.vel[2];
    case 'sc': return out.scale;
    case 'glow': return out.glow;
    case 'light': return out.light;
    default: return 0;
  }
}

function attrWrite(name, value, ctx, node) {
  if (!isNum(value)) {
    throw runtimeError(`particle property '${name}' requires a num, got ${typeName(value)}`, node);
  }
  const out = ensureOut(ctx);
  switch (name) {
    case 'x': out.pos[0] = value; break;
    case 'y': out.pos[1] = value; break;
    case 'z': out.pos[2] = value; break;
    case 'r': out.color[0] = clamp01(value); break;
    case 'g': out.color[1] = clamp01(value); break;
    case 'b': out.color[2] = clamp01(value); break;
    case 'a': out.color[3] = clamp01(value); break;
    case 'vx': out.vel[0] = value; break;
    case 'vy': out.vel[1] = value; break;
    case 'vz': out.vel[2] = value; break;
    case 'sc': out.scale = value; break;
    case 'glow': out.glow = value > 0.5; break;
    case 'light': out.light = Math.max(0, Math.min(15, Math.round(value))); break;
    default: break;
  }
}

function setVecComp(v, comp, value) {
  if (v.t === 'vec2') {
    return vec2(comp === 'x' ? value : v.x, comp === 'y' ? value : v.y);
  }
  return vec3(
    comp === 'x' ? value : v.x,
    comp === 'y' ? value : v.y,
    comp === 'z' ? value : v.z,
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
  if (isBool(v)) return v;
  if (isNum(v)) return v !== 0;
  throw runtimeError(`condition requires a num/bool, got ${typeName(v)}`, node);
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const clampNum = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/* =========================================================================
 * 运算（§7）
 * ======================================================================= */

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
  // mat4 * vec3：按仿射变换（w = 1），忽略第 4 行。
  if (vecDim(v) !== 3) throw runtimeError('mat4 requires a vec3 operand', node);
  const mm = m.m;
  return vec3(
    mm[0][0] * v.x + mm[0][1] * v.y + mm[0][2] * v.z + mm[0][3],
    mm[1][0] * v.x + mm[1][1] * v.y + mm[1][2] * v.z + mm[1][3],
    mm[2][0] * v.x + mm[2][1] * v.y + mm[2][2] * v.z + mm[2][3],
  );
}

/* =========================================================================
 * 数组方法与集合内建
 * ======================================================================= */

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
  if (!isFunc(cmpVal)) {
    throw runtimeError(`sort comparator must be a function, got ${typeName(cmpVal)}`, node);
  }
  const fn = rt.program.functions.get(cmpVal.name);
  if (!fn) throw runtimeError(`comparator function '${cmpVal.name}' not found`, node);
  arr.sort((a, b) => {
    const res = rt.callUserFunc(fn, [a, b], node);
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

/* =========================================================================
 * 向量 / 矩阵内建函数
 * ======================================================================= */

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

/* =========================================================================
 * 内建函数表
 * ======================================================================= */

const BUILTIN_FUNCTIONS = new Set();

function builtin(name, minArgs, maxArgs, impl) {
  BUILTIN_FUNCTIONS.add(name);
  return [name, { min: minArgs, max: maxArgs, impl }];
}

function checkArity(name, args, min, max, node) {
  if (args.length < min || (max != null && args.length > max)) {
    const want = max == null ? `at least ${min}` : (min === max ? `${min}` : `${min}..${max}`);
    throw runtimeError(`${name} expects ${want} argument(s), got ${args.length}`, node);
  }
}

const BUILTIN_TABLE = new Map([
  // —— 调试（仅 setup）——
  builtin('print', 0, null, (args, rt, node) => {
    if (rt.phase !== 'setup') throw runtimeError("'print' is only allowed in setup", node);
    console.log(args.map(formatValue).join(' '));
    return 0;
  }),
  builtin('assert', 2, 2, (args, rt, node) => {
    if (rt.phase !== 'setup') throw runtimeError("'assert' is only allowed in setup", node);
    if (!truthy(args[0], node)) throw new Error(String(args[1]));
    return 0;
  }),

  // —— 构造 / 变换 ——
  builtin('vec2', 2, 2, (args, rt, node) => vec2(expectNum(args[0], 'vec2', node), expectNum(args[1], 'vec2', node))),
  builtin('vec3', 3, 3, (args, rt, node) => vec3(expectNum(args[0], 'vec3', node), expectNum(args[1], 'vec3', node), expectNum(args[2], 'vec3', node))),
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
  builtin('translate', 1, 1, (args, rt, node) => {
    const v = expectVec(args[0], 'translate', node);
    if (vecDim(v) !== 3) throw runtimeError('translate requires a vec3', node);
    return mat4([
      [1, 0, 0, v.x],
      [0, 1, 0, v.y],
      [0, 0, 1, v.z],
      [0, 0, 0, 1],
    ]);
  }),
  builtin('scale', 1, 3, (args, rt, node) => {
    let sx, sy, sz;
    if (args.length === 1) {
      const a = args[0];
      if (isNum(a)) { sx = sy = sz = a; }
      else if (isVec(a)) {
        const c = vecComps(a);
        sx = c[0]; sy = c[1]; sz = a.t === 'vec3' ? c[2] : 1;
      } else throw runtimeError(`scale not supported for ${typeName(a)}`, node);
    } else if (args.length === 3) {
      sx = expectNum(args[0], 'scale', node);
      sy = expectNum(args[1], 'scale', node);
      sz = expectNum(args[2], 'scale', node);
    } else {
      sx = sy = sz = 1;
    }
    return mat4([
      [sx, 0, 0, 0],
      [0, sy, 0, 0],
      [0, 0, sz, 0],
      [0, 0, 0, 1],
    ]);
  }),
  builtin('rotate', 2, 2, (args, rt, node) => {
    const axis = normalizeVec3(expectVec(args[0], 'rotate axis', node), node);
    const a = expectNum(args[1], 'rotate angle', node);
    return mat4Rodrigues(axis, a);
  }),
  builtin('lookAt', 3, 3, (args, rt, node) => {
    const eye = expectVec(args[0], 'lookAt', node);
    const target = expectVec(args[1], 'lookAt', node);
    const up = expectVec(args[2], 'lookAt', node);
    if (vecDim(eye) !== 3 || vecDim(target) !== 3 || vecDim(up) !== 3) {
      throw runtimeError('lookAt requires vec3 arguments', node);
    }
    return lookAtMat4(eye, target, up, node);
  }),
  builtin('rotX', 1, 1, (args, rt, node) => rotXMat3(expectNum(args[0], 'rotX', node))),
  builtin('rotY', 1, 1, (args, rt, node) => rotYMat3(expectNum(args[0], 'rotY', node))),
  builtin('rotZ', 1, 1, (args, rt, node) => rotZMat3(expectNum(args[0], 'rotZ', node))),
  builtin('rotAxis', 2, 2, (args, rt, node) => {
    const axis = normalizeVec3(expectVec(args[0], 'rotAxis axis', node), node);
    const a = expectNum(args[1], 'rotAxis angle', node);
    return mat3Rodrigues(axis, a);
  }),

  // —— 向量 ——
  builtin('dot', 2, 2, (args, rt, node) => {
    const a = expectVec(args[0], 'dot', node);
    const b = expectVec(args[1], 'dot', node);
    sameDimVec(a, b, node);
    const ca = vecComps(a), cb = vecComps(b);
    let s = 0;
    for (let i = 0; i < ca.length; i++) s += ca[i] * cb[i];
    return s;
  }),
  builtin('cross', 2, 2, (args, rt, node) => {
    const a = expectVec(args[0], 'cross', node);
    const b = expectVec(args[1], 'cross', node);
    if (vecDim(a) !== 3 || vecDim(b) !== 3) throw runtimeError('cross requires vec3 operands', node);
    return vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  }),
  builtin('len', 1, 1, (args, rt, node) => {
    const v = args[0];
    if (Array.isArray(v)) return v.length;
    expectVec(v, 'len', node);
    return Math.sqrt(dotSelf(v));
  }),
  builtin('len2', 1, 1, (args, rt, node) => dotSelf(expectVec(args[0], 'len2', node))),
  builtin('norm', 1, 1, (args, rt, node) => normVecOrZero(expectVec(args[0], 'norm', node))),
  builtin('lerp', 3, 3, (args, rt, node) => lerpImpl(args[0], args[1], args[2], node)),
  builtin('mix', 3, 3, (args, rt, node) => lerpImpl(args[0], args[1], args[2], node)),
  builtin('distance', 2, 2, (args, rt, node) => {
    const a = expectVec(args[0], 'distance', node);
    const b = expectVec(args[1], 'distance', node);
    sameDimVec(a, b, node);
    const ca = vecComps(a), cb = vecComps(b);
    let s = 0;
    for (let i = 0; i < ca.length; i++) s += (ca[i] - cb[i]) ** 2;
    return Math.sqrt(s);
  }),
  builtin('angle_between', 2, 2, (args, rt, node) => {
    const a = expectVec(args[0], 'angle_between', node);
    const b = expectVec(args[1], 'angle_between', node);
    sameDimVec(a, b, node);
    const na = normVecOrZero(a);
    const nb = normVecOrZero(b);
    const d = dotComps(na, nb);
    return Math.acos(clampNum(d, -1, 1));
  }),
  builtin('project', 2, 2, (args, rt, node) => {
    const a = expectVec(args[0], 'project', node);
    const b = expectVec(args[1], 'project', node);
    sameDimVec(a, b, node);
    const bb = dotSelf(b);
    if (bb === 0) throw runtimeError('project onto zero-length vector', node);
    const s = dotComps(a, b) / bb;
    return mkVec(vecDim(b), vecComps(b).map((x) => x * s));
  }),
  builtin('reflect', 2, 2, (args, rt, node) => {
    const v = expectVec(args[0], 'reflect', node);
    const n = expectVec(args[1], 'reflect', node);
    sameDimVec(v, n, node);
    const d = dotComps(v, n);
    const c = vecComps(n).map((x) => 2 * d * x);
    const cv = vecComps(v);
    return mkVec(vecDim(v), cv.map((x, i) => x - c[i]));
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
    if (isBool(v)) return v ? 1 : 0;
    return mapComponents(v, Math.trunc, node);
  }),
  builtin('float', 1, 1, (args, rt, node) => {
    const v = args[0];
    if (isBool(v)) return v ? 1 : 0;
    return mapComponents(v, (x) => x, node);
  }),
  builtin('bool', 1, 1, (args, rt, node) => {
    const v = args[0];
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

/* =========================================================================
 * 值格式化（print）
 * ======================================================================= */

function formatValue(v) {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return v;
  if (isVec(v)) return v.t === 'vec2' ? `vec2(${v.x}, ${v.y})` : `vec3(${v.x}, ${v.y}, ${v.z})`;
  if (isMat(v)) {
    const name = v.t === 'mat3' ? 'mat3' : 'mat4';
    return `${name}(${v.m.map((row) => `[${row.join(', ')}]`).join(', ')})`;
  }
  if (Array.isArray(v)) return `[${v.map(formatValue).join(', ')}]`;
  if (isFunc(v)) return `func ${v.name}`;
  return String(v);
}

/* =========================================================================
 * 字节码编译器 + 栈式虚拟机（process 专用）
 * -------------------------------------------------------------------------
 * setup 继续走上面的 AST Runtime；process 编译为扁平指令流执行，减少 AST
 * 递归分发开销。名称查找/赋值复用 Runtime 的语义（含保留字放宽与遮蔽规则）。
 * ======================================================================= */

const OP = {
  CONST: 0, POP: 1, DUP: 2,
  LOAD: 3, STORE: 4,
  LOAD_BUILTIN: 5, LOAD_ATTR: 6,
  LOAD_UNIFORM: 9, STORE_UNIFORM: 10,
  UNARY: 11, BINARY: 12,
  ARRAY: 13, INDEX: 14, INDEX_STORE: 15,
  COMP: 16, COMP_STORE: 17, COMP_STORE_INDEX: 18,
  UNPACK: 19, STATIC: 20,
  JUMP: 21, JUMP_IF_FALSE: 22, JUMP_IF_TRUE: 23,
  CALL_BUILTIN: 24, CALL_USER: 25, CALL_VALUE: 26, METHOD: 27,
  ENTER_SCOPE: 28, EXIT_SCOPE: 29, RETURN: 30, LOOP_GUARD: 31,
};

const UNARY_OPS = ['-', '!'];
const BIN_OPS = ['+', '-', '*', '/', '%', '^', '==', '!=', '<', '<=', '>', '>='];

const ATTR_CODE = {};
ATTR_NAMES.forEach((n, i) => { ATTR_CODE[n] = i; });
const ATTR_BY_CODE = ATTR_NAMES;

const BUILTIN_CODE = new Map();
const BUILTIN_BY_CODE = [];
for (const name of BUILTIN_TABLE.keys()) {
  BUILTIN_CODE.set(name, BUILTIN_BY_CODE.length);
  BUILTIN_BY_CODE.push(name);
}

const BUILTIN_NAME_CODE = {};
const BUILTIN_NAME_BY_CODE = [...BUILTIN_NAMES];
BUILTIN_NAME_BY_CODE.forEach((n, i) => { BUILTIN_NAME_CODE[n] = i; });

const METHOD_NAMES = ['push', 'insert', 'remove', 'slice', 'size', 'find', 'includes', 'sort', 'unique', 'reverse'];
const METHOD_CODE = {};
METHOD_NAMES.forEach((n, i) => { METHOD_CODE[n] = i; });
const METHOD_BY_CODE = METHOD_NAMES;

const COMP_CODE = { x: 0, y: 1, z: 2 };

// 可安全提升为 uniform 的纯内建（无 PRNG/随机、无数组变异）。
const PURE_BUILTINS = new Set();
for (const name of BUILTIN_TABLE.keys()) {
  if (!['rand', 'random', 'print', 'assert', 'unique', 'reverse', 'sort'].includes(name)) {
    PURE_BUILTINS.add(name);
  }
}

function makeLoc(line, col) { return { line, col }; }

class Compiler {
  constructor(program, varNames) {
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

  /* ---------- 表达式 ---------- */

  compileExpr(node) {
    switch (node.type) {
      case 'num': case 'str': case 'bool':
        this.emit2(OP.CONST, this.internConst(node.value), node);
        return;
      case 'var': {
        const name = node.name;
        if (this.hoisted.has(name)) {
          this.emit2(OP.LOAD_UNIFORM, this.hoisted.get(name), node);
        } else if (this.phase === 'process' && BUILTIN_NAMES.has(name)) {
          this.emit2(OP.LOAD_BUILTIN, BUILTIN_NAME_CODE[name], node);
        } else if (this.phase === 'process' && ATTR_SET.has(name)) {
          this.emit2(OP.LOAD_ATTR, ATTR_CODE[name], node);
        } else if (CONSTANTS.has(name)) {
          this.emit2(OP.CONST, this.internConst(CONSTANTS.get(name)), node);
        } else {
          this.emit2(OP.LOAD, this.internName(name), node);
        }
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
        this.emit2(OP.COMP, COMP_CODE[COMP_ALIAS[node.comp]], node);
        return;
      }
      case 'call':
        this.compileCall(node);
        return;
      case 'method': {
        this.compileExpr(node.object);
        for (const a of node.args) this.compileExpr(a);
        this.emit3(OP.METHOD, METHOD_CODE[node.method], node.args.length, node);
        return;
      }
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

  /* ---------- 赋值目标（值已压栈） ---------- */

  compileTarget(target) {
    switch (target.type) {
      case 'var':
        this.emit2(OP.STORE, this.internName(target.name), target);
        return;
      case 'index':
        this.compileExpr(target.target);
        this.compileExpr(target.index);
        this.emit1(OP.INDEX_STORE, target);
        return;
      case 'comp': {
        const inner = target.target;
        if (inner.type === 'var') {
          this.emit2(OP.LOAD, this.internName(inner.name), inner);
          this.emit2(OP.COMP_STORE, COMP_CODE[COMP_ALIAS[target.comp]], target);
          this.emit2(OP.STORE, this.internName(inner.name), target);
        } else if (inner.type === 'index') {
          this.compileExpr(inner.target);
          this.compileExpr(inner.index);
          this.emit2(OP.COMP_STORE_INDEX, COMP_CODE[COMP_ALIAS[target.comp]], target);
        } else {
          // 嵌套 comp 等：与 AST 一致，求值后会在 COMP_STORE 处报「不是向量」。
          this.compileExpr(inner);
          this.emit2(OP.COMP_STORE, COMP_CODE[COMP_ALIAS[target.comp]], target);
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

  /* ---------- 语句 ---------- */

  compileStmt(st) {
    switch (st.type) {
      case 'block':
        this.emit1(OP.ENTER_SCOPE, st);
        for (const s of st.body) this.compileStmt(s);
        this.emit1(OP.EXIT_SCOPE, st);
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
      default:
        throw parseError(`cannot compile statement type '${st.type}'`, st.line, st.col);
    }
  }

  compileForPart(part) {
    if (part.type === 'assign') this.compileAssign(part);
    else this.compileExpr(part);
    this.emit1(OP.POP, part);
  }
}

/* ---------- 不变式分析（仅 process 顶层无条件赋值） ---------- */

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
    case 'expr': walkExpr(node.expr, cb); return;
    case 'assign': if (node.target.type === 'unpack') {} else walkExpr(node.value, cb); return;
    case 'static': if (node.init) walkExpr(node.init, cb); return;
    case 'global': if (node.init) walkExpr(node.init, cb); return;
    case 'return': if (node.expr) walkExpr(node.expr, cb); return;
    default: return;
  }
}

function isInvariantExpr(node, invariant, varNames) {
  switch (node.type) {
    case 'num': case 'str': case 'bool': return true;
    case 'var': return invariant.has(node.name);
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
  return !ATTR_SET.has(name) && !BUILTIN_NAMES.has(name) && !CONSTANTS.has(name) &&
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
  }
  processStmts.forEach(walk);
  return [...out];
}

// 返回可提升的顶层无条件单次赋值列表（按源顺序）。
function findHoistedAssignments(processStmts, varNames, globalNames, staticNames, program) {
  const invariant = new Set(['n', 't', 'dt', 'life']);
  for (const n of varNames) invariant.add(n);

  // 不动点：把所有「无条件顶层赋值且 RHS 不变」的普通变量名标为不变量。
  let changed = true;
  while (changed) {
    changed = false;
    for (const st of processStmts) {
      if (st.type !== 'assign' || st.target.type !== 'var') continue;
      const name = st.target.name;
      if (invariant.has(name) || !hoistCandidateName(name, varNames, globalNames, staticNames, program)) continue;
      if (isInvariantExpr(st.value, invariant, varNames)) {
        invariant.add(name);
        changed = true;
      }
    }
  }

  // 整个 process 中每个候选名的「写入」次数（含嵌套语句；分量写入/拆包也算写入）。
  const writes = new Map();
  function addWrite(name) { writes.set(name, (writes.get(name) || 0) + 1); }
  function countWrites(node) {
    if (!node) return;
    if (node.type === 'assign') {
      if (node.target.type === 'var') addWrite(node.target.name);
      else if (node.target.type === 'comp' && node.target.target.type === 'var') addWrite(node.target.target.name);
      else if (node.target.type === 'unpack') node.target.names.forEach(addWrite);
    }
    if (node.type === 'block') { node.body.forEach(countWrites); return; }
    if (node.type === 'if') { countWrites(node.then); if (node.els) countWrites(node.els); return; }
    if (node.type === 'while') { countWrites(node.body); return; }
    if (node.type === 'do') { countWrites(node.body); return; }
    if (node.type === 'for') { if (node.init) countWrites(node.init); if (node.inc) countWrites(node.inc); countWrites(node.body); }
  }
  for (const st of processStmts) countWrites(st);

  // 首次提及必须是赋值（源顺序），避免把「先读后写」的非法脚本静默改值。
  const firstMention = new Map();
  for (const st of processStmts) {
    if (st.type === 'assign' && st.target.type === 'var') {
      const name = st.target.name;
      if (!firstMention.has(name)) firstMention.set(name, 'assign');
      walkExpr(st.value, (e) => {
        if (e.type === 'var' && !firstMention.has(e.name)) firstMention.set(e.name, 'read');
      });
    } else {
      walkStmtExprs(st, (e) => {
        if (e.type === 'var' && !firstMention.has(e.name)) firstMention.set(e.name, 'read');
      });
    }
  }

  const out = [];
  for (const st of processStmts) {
    if (st.type !== 'assign' || st.target.type !== 'var') continue;
    const name = st.target.name;
    if (!invariant.has(name)) continue;
    if (name === 'n' || name === 't' || name === 'dt' || name === 'life' || varNames.includes(name)) continue;
    if (writes.get(name) !== 1) continue;
    if (firstMention.get(name) !== 'assign') continue;
    out.push({ name, expr: st.value, node: st });
  }
  return out;
}

/* -------------------------------------------------------------------------
 * 原生 JS 快路径编译器（process 直线标量代码）
 * -------------------------------------------------------------------------
 * 把「仅由标量赋值/拆包组成、无循环/分支/向量/矩阵/用户函数」的 process 编译为
 * `new Function` 原生 JS，每个粒子只执行算术与数组读取，不再经过栈式 VM 的
 * 逐指令分发、Map 作用域查找与值装箱。任何不支持的结构返回 null，调用方回退 VM。
 * 保持与 Runtime 相同的：属性写入钳制、glow 阈值、light 取整、除零/越界报错。
 * ======================================================================= */

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
  const stmts = program.process;
  const staticNamesSet = new Set(collectStaticNames(stmts));
  const varNamesSet = new Set(varNames);
  const globalNamesSet = new Set(globalNames);
  const funcNames = new Set(program.functions.keys());

  // 首次提及分析：只有「先写后读」的普通名才可作为原生局部变量，
  // 避免把「先读（global/static/var）后写」的名字误编译为 TDZ 局部量。
  const firstMention = new Map();
  for (const st of stmts) {
    if (st.type === 'assign' && st.target.type === 'var') {
      const name = st.target.name;
      if (!firstMention.has(name)) firstMention.set(name, 'write');
      walkExpr(st.value, (e) => {
        if (e.type === 'var' && !firstMention.has(e.name)) firstMention.set(e.name, 'read');
      });
    } else if (st.type === 'assign' && st.target.type === 'unpack') {
      for (const name of st.target.names) {
        if (!firstMention.has(name)) firstMention.set(name, 'write');
      }
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
    if (ATTR_SET.has(name) || BUILTIN_NAMES.has(name) || CONSTANTS.has(name) ||
        varNamesSet.has(name) || globalNamesSet.has(name) || staticNamesSet.has(name) ||
        funcNames.has(name) || BUILTIN_FUNCTIONS.has(name)) continue;
    tempNames.add(name);
  }

  function readExpr(name) {
    if (ATTR_SET.has(name)) {
      switch (name) {
        case 'x': return 'out.pos[0]';
        case 'y': return 'out.pos[1]';
        case 'z': return 'out.pos[2]';
        case 'r': return 'out.color[0]';
        case 'g': return 'out.color[1]';
        case 'b': return 'out.color[2]';
        case 'a': return 'out.color[3]';
        case 'vx': return 'out.vel[0]';
        case 'vy': return 'out.vel[1]';
        case 'vz': return 'out.vel[2]';
        case 'sc': return 'out.scale';
        case 'glow': return '(out.glow?1:0)';
        case 'light': return 'out.light';
        default: return FAIL;
      }
    }
    if (BUILTIN_NAMES.has(name)) {
      switch (name) {
        case 'i': case 'idx': return 'ctx.i';
        case 'n': return 'ctx.n';
        case 't': return 'ctx.t';
        case 'dt': return 'ctx.dt';
        case 'uv_x': return 'ctx.uv_x';
        case 'uv_y': return 'ctx.uv_y';
        case 'life': return 'ctx.life';
        default: return FAIL;
      }
    }
    if (CONSTANTS.has(name)) return `(${CONSTANTS.get(name)})`;
    if (tempNames.has(name)) return name;
    if (staticNamesSet.has(name)) return `s.get(${JSON.stringify(name)})`;
    if (globalNamesSet.has(name)) return `g.get(${JSON.stringify(name)})`;
    if (varNamesSet.has(name)) return `v[${JSON.stringify(name)}]`;
    return FAIL;
  }

  function writeExpr(name, valExpr) {
    if (ATTR_SET.has(name)) {
      switch (name) {
        case 'x': return `out.pos[0]=${valExpr};`;
        case 'y': return `out.pos[1]=${valExpr};`;
        case 'z': return `out.pos[2]=${valExpr};`;
        case 'r': return `out.color[0]=__clamp01(${valExpr});`;
        case 'g': return `out.color[1]=__clamp01(${valExpr});`;
        case 'b': return `out.color[2]=__clamp01(${valExpr});`;
        case 'a': return `out.color[3]=__clamp01(${valExpr});`;
        case 'vx': return `out.vel[0]=${valExpr};`;
        case 'vy': return `out.vel[1]=${valExpr};`;
        case 'vz': return `out.vel[2]=${valExpr};`;
        case 'sc': return `out.scale=${valExpr};`;
        case 'glow': return `out.glow=(${valExpr})>0.5;`;
        case 'light': return `out.light=__clamp15(${valExpr});`;
        default: return FAIL;
      }
    }
    if (BUILTIN_NAMES.has(name) || CONSTANTS.has(name) || varNamesSet.has(name)) return FAIL;
    if (tempNames.has(name)) return `${name}=${valExpr};`;
    if (staticNamesSet.has(name)) return `s.set(${JSON.stringify(name)},${valExpr});`;
    if (globalNamesSet.has(name) || funcNames.has(name)) return FAIL;
    return FAIL;
  }

  // 粒子属性写入必须是 num；若 RHS 可能产出 bool（VM 会抛错），退回 VM 保证语义一致。
  function mayBeBool(node, boolTemps) {
    switch (node.type) {
      case 'bool': return true;
      case 'num': case 'str': case 'array': case 'index': case 'comp': return false;
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
      if (ATTR_SET.has(target.name) && mayBeBool(st.value, boolTemps)) return null;
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
        if (ATTR_SET.has(target.names[k]) && mayBeBool(st.value.items[k], boolTemps)) return null;
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
    } else {
      return null;
    }
  }

  const tempDecls = [...tempNames].map(name => `let ${name};`).join('');
  const src = `'use strict';
const __clamp01=(x)=>x<0?0:(x>1?1:x);
const __clamp15=(x)=>{x=Math.round(x);return x<0?0:(x>15?15:x);};
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
  const c = new Compiler(program, varNames);
  const staticNames = collectStaticNames(program.process);

  // 1) 分析并编译 uniform prelude（先于主代码，共享常量/名字表与 hoisted 槽位）
  const hoisted = findHoistedAssignments(program.process, varNames, globalNames, staticNames, program);
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
  for (const st of program.process) {
    if (st.type === 'assign' && st.target.type === 'var' && c.hoisted.has(st.target.name)) continue;
    c.compileStmt(st);
  }
  const codeEnd = c.pc();

  return {
    code: c.code, locs: c.locs, consts: c.consts, names: c.names,
    funcs: c.funcs, funcAddr, funcIdxByName: c.funcIdxByName,
    prelude, preludeLocs, uniformCount: hoisted.length,
    loopCounterCount: c.loopCounters,
    mainStart, codeEnd, program,
    native: compileNativeProcess(program, varNames, globalNames),
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

/* ---------- 栈式虚拟机 ---------- */

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
    const rt = this.rt;
    rt.statics = statics;
    rt.ctx = ctx;
    rt.scopes.length = 0;
    rt.funcDepth = 0;
    rt.inFunction = false;
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
        case OP.LOAD_BUILTIN: {
          const name = BUILTIN_NAME_BY_CODE[code[this.pc++]];
          stack.push(this.rt.lookupBuiltin(name).value);
          break;
        }
        case OP.LOAD_ATTR: {
          const name = ATTR_BY_CODE[code[this.pc++]];
          stack.push(attrRead(name, this.ctx));
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
        case OP.INDEX: {
          const idx = stack.pop();
          const arr = stack.pop();
          if (!Array.isArray(arr)) throw runtimeError(`index access requires an array, got ${typeName(arr)}`, node);
          const n = expectInt(idx, 'array index', node);
          if (n < 0 || n >= arr.length) throw runtimeError(`array index ${n} out of bounds (size ${arr.length})`, node);
          stack.push(arr[n]);
          break;
        }
        case OP.INDEX_STORE: {
          const idx = stack.pop();
          const arr = stack.pop();
          const value = stack.pop();
          if (!Array.isArray(arr)) throw runtimeError('indexed assignment target is not an array', node);
          const n = expectInt(idx, 'array index', node);
          if (n < 0 || n >= arr.length) throw runtimeError(`array index ${n} out of bounds (size ${arr.length})`, node);
          arr[n] = value;
          stack.push(value);
          break;
        }
        case OP.COMP: {
          const comp = ['x', 'y', 'z'][code[this.pc++]];
          const v = stack.pop();
          if (!isVec(v)) throw runtimeError(`component access requires a vector, got ${typeName(v)}`, node);
          if (v.t === 'vec2' && comp === 'z') throw runtimeError(`vec2 has no component '${comp}'`, node);
          stack.push(v[comp]);
          break;
        }
        case OP.COMP_STORE: {
          const comp = ['x', 'y', 'z'][code[this.pc++]];
          const old = stack.pop();
          const nv = stack.pop();
          if (!isVec(old)) throw runtimeError('component assignment target is not a vector', node);
          if (old.t === 'vec2' && comp === 'z') throw runtimeError(`vec2 has no component '${comp}'`, node);
          stack.push(setVecComp(old, comp, expectNum(nv, 'component value', node)));
          break;
        }
        case OP.COMP_STORE_INDEX: {
          const comp = ['x', 'y', 'z'][code[this.pc++]];
          const idx = stack.pop();
          const arr = stack.pop();
          const nv = stack.pop();
          if (!Array.isArray(arr)) throw runtimeError('indexed assignment target is not an array', node);
          const n = expectInt(idx, 'array index', node);
          if (n < 0 || n >= arr.length) throw runtimeError(`array index ${n} out of bounds (size ${arr.length})`, node);
          const old = arr[n];
          if (!isVec(old)) throw runtimeError('component assignment target is not a vector', node);
          if (old.t === 'vec2' && comp === 'z') throw runtimeError(`vec2 has no component '${comp}'`, node);
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
          if (!isFunc(callee)) throw runtimeError(`value of type ${typeName(callee)} is not callable`, node);
          const fidx = this.funcIdxByName.get(callee.name);
          if (fidx == null) throw runtimeError(`function '${callee.name}' not found`, node);
          this.enterFunction(fidx, args, node);
          break;
        }
        case OP.METHOD: {
          const midx = code[this.pc++];
          const argCount = code[this.pc++];
          const args = [];
          for (let i = 0; i < argCount; i++) args.push(stack.pop());
          args.reverse();
          const obj = stack.pop();
          if (!Array.isArray(obj)) throw runtimeError(`method '.${METHOD_BY_CODE[midx]}()' requires an array, got ${typeName(obj)}`, node);
          stack.push(applyArrayMethod(obj, METHOD_BY_CODE[midx], args, this.rt, node));
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

/* =========================================================================
 * 导出 API
 * ======================================================================= */

// 创建对象级状态：{ globals: Map, rand: prngState }。
export function createObjectState(seed) {
  const s = seed | 0;
  return { globals: new Map(), rand: mulberry32(s), seed: s };
}

// 执行 setup（对象级，一次）。env: { n, t, vars:{name:number} }。返回 objState。
export function runSetup(program, objState, env) {
  const rt = new Runtime('setup', program, objState, null, env, null);
  rt.pushScope(new Map());
  try {
    for (const st of program.setup) rt.execStmt(st);
  } finally {
    rt.popScope();
  }
  return objState;
}

// 创建每粒子 static 状态容器（Map）。
export function createStatics() {
  return new Map();
}

// 预编译 process 字节码（供高频求值路径复用；varNames/globalNames 每个 (fx,t) 只算一次）。
export function prepareProcess(program, varNames, globalNames) {
  return getCompiledProgram(program, varNames, globalNames);
}

// 创建可复用的 process 执行器（同一 (fx,t) 帧内逐粒子复用，避免每粒子 new Vm/new Runtime/Map）。
export function createProcessRunner(compiled, objState, ctx, uniforms) {
  return new Vm(compiled, objState, null, ctx, uniforms, null, null, compiled.mainStart);
}

// 执行原生 JS 快路径（compileNativeProcess 产物）。返回 ctx.out。
export function runNativeProcess(native, objState, statics, ctx, out, useFast) {
  return native(ctx, objState.globals, statics, ctx.vars, out, useFast, FAST_MATH);
}

// 计算 uniform 值（process 中与粒子无关的不变表达式，每个 (fx,t) 广播一次）。
export function runUniformPrelude(program, objState, statics, ctx, compiledIn) {
  const varNames = ctx && ctx.vars ? Object.keys(ctx.vars) : [];
  const globalNames = objState && objState.globals ? [...objState.globals.keys()].sort() : [];
  const compiled = compiledIn || getCompiledProgram(program, varNames, globalNames);
  const uniforms = new Array(compiled.uniformCount);
  if (compiled.prelude.length) {
    const vm = new Vm(compiled, objState, statics, ctx, uniforms, compiled.prelude, compiled.preludeLocs, 0);
    vm.run();
  }
  return uniforms;
}

// 执行 process（每粒子、每个时间点）。写入 ctx.out 并返回 ctx.out。
export function evalProcess(program, objState, statics, ctx) {
  ensureOut(ctx);
  const varNames = ctx && ctx.vars ? Object.keys(ctx.vars) : [];
  const globalNames = objState && objState.globals ? [...objState.globals.keys()].sort() : [];
  const compiled = getCompiledProgram(program, varNames, globalNames);
  const uniforms = (ctx && ctx.uniforms) || runUniformPrelude(program, objState, statics, ctx, compiled);
  const vm = new Vm(compiled, objState, statics, ctx, uniforms, null, null, compiled.mainStart);
  vm.run();
  return ctx.out;
}