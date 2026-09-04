/* =========================================================================
 * 拼图代码块：积木树数据模型 + 代码文本 ↔ 积木树 双向转换 + 类型系统
 * 纯逻辑模块，无 DOM 依赖（可在 node 下测试）。
 *
 * 积木树：
 *   代码块 = 有序语句列表 [ statement, ... ]
 *   statement ：
 *     { kind:'pos'|'pos_vec'|'vel'|'vel_vec'|'col'|'scl'|'glow'|'light'|'set', ... }
 *   表达式节点 expr：
 *     { kind:'num', value }                    数字（可为负）
 *     { kind:'var', name }                     变量引用（i/n/t / 函数变量 / 临时变量）
 *     { kind:'func', name, args:[expr,...] }   函数调用
 *     { kind:'op', op:'+|-|*|/|%|^', a, b }    二元运算
 *     { kind:'chain', terms:[expr...], ops:[op...] } 动态算式（从左到右：t0 op0 t1 op1 t2 ...）
 *     { kind:'comp', axis:'x'|'y'|'z', target } 向量分量访问（后缀 .x/.y/.z）
 *     { kind:'neg', a }                        一元负号（仅用于 -x 等非数字；-数字合并进 num）
 * ======================================================================= */


import { _et, _etf } from './i18n.js';
import { SCRIPT_BINARY_PRECEDENCE as PREC, SCRIPT_NEG_PREC as NEG_PREC, SCRIPT_FUNCTION_NAMES, parseExprList } from './script-lang.js';

const SCRIPT_FUNC_SET = new Set(SCRIPT_FUNCTION_NAMES);

/* —— 类型 —— */
export const T_SCALAR = 'scalar';
export const T_VEC = 'vec';
export const T_MAT = 'mat';
export const T_ANY = 'any'; // 临时变量（类型由赋值决定，放宽约束）

// PREC/NEG_PREC 来自 script-lang 的优先级表；ATOM_PREC 为原子表达式的虚拟优先级
export const ATOM_PREC = 10;

/* —— 语句块槽规格（ASCII 名原样显示；中文语义槽用 i18n 键 blk.slot.*） —— */
export const STMT_SLOTS = {
  pos: [['X', T_SCALAR], ['Y', T_SCALAR], ['Z', T_SCALAR]],
  vel: [['vx', T_SCALAR], ['vy', T_SCALAR], ['vz', T_SCALAR]],
  col: [['R', T_SCALAR], ['G', T_SCALAR], ['B', T_SCALAR], ['A', T_SCALAR]],
  scl: [['blk.slot.scale', T_SCALAR]],
  light: [['blk.slot.light', T_SCALAR]],
};
export const BIG_BLOCKS = { pos: true, vel: true };

// 数组方法默认参数个数（用于从调色板新建 method 块时预置正确数量的参数槽）。
export const METHOD_ARITY = {
  push: 1, insert: 2, remove: 1, slice: 2, size: 0,
  find: 1, includes: 1, sort: 0, unique: 0, reverse: 0,
};

// this 只读字段（拼图内作为可直接拖入表达式的上下文变量；v12 spawn 模型）。
export const CTX_VAR_FIELDS = ['time', 'duration', 'particles'];
// 上下文变量的短显示名（工作台积木与下拉列表使用）。
export const BUILTIN_VAR_INFO = {
  'this.time': 'blk.ctx.time',
  'this.duration': 'blk.ctx.duration',
  'this.particles': 'blk.ctx.particles',
};
// 上下文变量的帮助文本（Alt 悬停/下拉提示使用，较完整）。
export const CTX_VAR_INFO = {
  'this.time': 'blk.var.time',
  'this.duration': 'blk.var.duration',
  'this.particles': 'blk.var.particles',
};
export const BUILTIN_VAR_NAMES = Object.keys(BUILTIN_VAR_INFO);

// 返回 member 节点对应的 this.* 上下文键（如 'this.index' / 'this.uv.x'），非上下文返回 null。
export function memberCtxKey(n) {
  if (!n || n.kind !== 'member') return null;
  if (n.obj && n.obj.kind === 'var' && n.obj.name === 'this') return 'this.' + n.field;
  if ((n.field === 'x' || n.field === 'y') && n.obj && n.obj.kind === 'member' &&
      n.obj.obj && n.obj.obj.kind === 'var' && n.obj.obj.name === 'this' && n.obj.field === 'uv') {
    return 'this.uv.' + n.field;
  }
  return null;
}

/* —— 合并块下拉定义（三角函数/数值操作/限制/数组操作/上下文） —— */
// 函数合并组：组内函数共用一个拼图，通过下拉切换实际函数名。
export const FUNC_DROPDOWNS = {
  trig: { label: 'blk.dd.trig', desc: 'blk.dd.trig.desc', funcs: ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2'] },
  numeric: { label: 'blk.dd.numeric', desc: 'blk.dd.numeric.desc', funcs: ['sqrt', 'abs', 'sign', 'exp', 'log', 'ln', 'floor', 'ceil', 'round', 'fract'] },
  clamp: { label: 'blk.dd.clamp', desc: 'blk.dd.clamp.desc', funcs: ['min', 'max', 'clamp'] },
};
export function funcDropdownGroup(name) {
  for (const g in FUNC_DROPDOWNS) if (FUNC_DROPDOWNS[g].funcs.includes(name)) return g;
  return null;
}
// 数组操作合并块：全部走 method 节点，下拉切换方法名。
export const ARRAY_METHODS = ['push', 'insert', 'remove', 'slice', 'size', 'find', 'includes', 'sort', 'unique', 'reverse'];

// 数组方法的自然语言拼图模板（替代代码形式 `[数组].方法(...)`）。
// parts 中：{text} 文本、{slot:'obj'} 对象槽、{slot:0..} 参数槽、{dd:true} 方法名下拉芯片。
// phrase 为下拉芯片显示文字（blk.method.<name>.phrase）；zh/en 各自一份保证多语言。
export const METHOD_PHRASES = {
  push: {
    phrase: 'blk.method.push.phrase',
    zh: [{ text: '给 ' }, { slot: 'obj' }, { text: ' ' }, { dd: true }, { text: ' ' }, { slot: 0 }],
    en: [{ dd: true }, { text: ' ' }, { slot: 0 }, { text: ' to ' }, { slot: 'obj' }],
  },
  insert: {
    phrase: 'blk.method.insert.phrase',
    zh: [{ text: '在 ' }, { slot: 'obj' }, { text: ' 的位置 ' }, { slot: 0 }, { text: ' ' }, { dd: true }, { text: ' ' }, { slot: 1 }],
    en: [{ dd: true }, { text: ' ' }, { slot: 1 }, { text: ' into ' }, { slot: 'obj' }, { text: ' at ' }, { slot: 0 }],
  },
  remove: {
    phrase: 'blk.method.remove.phrase',
    zh: [{ text: '从 ' }, { slot: 'obj' }, { text: ' ' }, { dd: true }, { text: ' 第 ' }, { slot: 0 }, { text: ' 位' }],
    en: [{ dd: true }, { text: ' from ' }, { slot: 'obj' }, { text: ' at ' }, { slot: 0 }],
  },
  slice: {
    phrase: 'blk.method.slice.phrase',
    zh: [{ text: '从 ' }, { slot: 'obj' }, { text: ' ' }, { dd: true }, { text: ' ' }, { slot: 0 }, { text: ' 到 ' }, { slot: 1 }],
    en: [{ dd: true }, { text: ' ' }, { slot: 'obj' }, { text: ' from ' }, { slot: 0 }, { text: ' to ' }, { slot: 1 }],
  },
  size: {
    phrase: 'blk.method.size.phrase',
    zh: [{ text: '获取 ' }, { slot: 'obj' }, { text: ' 的 ' }, { dd: true }],
    en: [{ text: 'Get ' }, { dd: true }, { text: ' of ' }, { slot: 'obj' }],
  },
  find: {
    phrase: 'blk.method.find.phrase',
    zh: [{ text: '在 ' }, { slot: 'obj' }, { text: ' 中 ' }, { dd: true }, { text: ' ' }, { slot: 0 }],
    en: [{ dd: true }, { text: ' ' }, { slot: 0 }, { text: ' in ' }, { slot: 'obj' }],
  },
  includes: {
    phrase: 'blk.method.includes.phrase',
    zh: [{ text: '判断 ' }, { slot: 'obj' }, { text: ' 是否 ' }, { dd: true }, { text: ' ' }, { slot: 0 }],
    en: [{ text: 'Check if ' }, { slot: 'obj' }, { text: ' ' }, { dd: true }, { text: ' ' }, { slot: 0 }],
  },
  sort: {
    phrase: 'blk.method.sort.phrase',
    zh: [{ text: '对 ' }, { slot: 'obj' }, { text: ' ' }, { dd: true }],
    en: [{ dd: true }, { text: ' ' }, { slot: 'obj' }],
  },
  unique: {
    phrase: 'blk.method.unique.phrase',
    zh: [{ text: '对 ' }, { slot: 'obj' }, { text: ' ' }, { dd: true }],
    en: [{ dd: true }, { text: ' ' }, { slot: 'obj' }],
  },
  reverse: {
    phrase: 'blk.method.reverse.phrase',
    zh: [{ dd: true }, { text: ' ' }, { slot: 'obj' }],
    en: [{ dd: true }, { text: ' ' }, { slot: 'obj' }],
  },
};

// 取某数组方法在当前语言下的自然语言 parts。
export function methodPhraseParts(method, lang) {
  const p = METHOD_PHRASES[method];
  if (!p) return null;
  return (lang === 'en' && p.en) ? p.en : p.zh;
}
// 运算符下拉：算术 + 比较 + 逻辑（替代被移除的独立运算符块）。
export const ALL_OPERATORS = ['+', '-', '*', '/', '%', '^', '==', '!=', '<', '<=', '>', '>=', '&&', '||'];

/* —— 积木类别 → CSS 类名（渲染层与数据层共用） —— */
export const GROUP_COLOR = {
  pos: 'blk-pos', color: 'blk-color', appearance: 'blk-appearance',
  math: 'blk-math', vec: 'blk-vec', mat: 'blk-mat', var: 'blk-var', const: 'blk-const',
  logic: 'blk-logic', array: 'blk-array',
};

/* —— 槽位/类型小工具（blocks-ui 与 puzzle-canvas 共用，避免循环 import） —— */
export function isBoolOp(op) {
  return op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=' || op === '&&' || op === '||';
}
export function opSlotType(op, side) {
  if (op === '^' || op === '%') return T_SCALAR;
  if (op === '/') return side === 'r' ? T_SCALAR : T_ANY;
  return T_ANY;
}
export function slotRef(get, set, type) { return { get, set, type }; }
export function N0() { return { kind: 'num', value: 0 }; }

/* —— 函数块定义：label 显示名，ret 返回类型，args 参数槽 [标签|i18n键, 类型]，desc|i18n键 —— */
/* 标签约定：以 "blk." 开头的为 i18n 键，其余（a/b/x/y/z/θ/φ/R/r 等）原样显示。 */
export const FUNC_BLOCKS = {
  sin: { ret: T_SCALAR, args: [['blk.arg.angle', T_SCALAR]], desc: 'blk.func.sin.desc' },
  cos: { ret: T_SCALAR, args: [['blk.arg.angle', T_SCALAR]], desc: 'blk.func.cos.desc' },
  tan: { ret: T_SCALAR, args: [['blk.arg.angle', T_SCALAR]], desc: 'blk.func.tan.desc' },
  asin: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.asin.desc' },
  acos: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.acos.desc' },
  atan: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.atan.desc' },
  atan2: { ret: T_SCALAR, args: [['y', T_SCALAR], ['x', T_SCALAR]], desc: 'blk.func.atan2.desc' },
  sqrt: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.sqrt.desc' },
  abs: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.abs.desc' },
  sign: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.sign.desc' },
  exp: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.exp.desc' },
  log: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.log.desc' },
  ln: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.ln.desc' },
  floor: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.floor.desc' },
  ceil: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.ceil.desc' },
  round: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.round.desc' },
  fract: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.fract.desc' },
  pow: { ret: T_SCALAR, args: [['blk.arg.base', T_SCALAR], ['blk.arg.exp', T_SCALAR]], desc: 'blk.func.pow.desc' },
  min: { ret: T_SCALAR, args: [['a', T_SCALAR], ['b', T_SCALAR]], desc: 'blk.func.min.desc' },
  max: { ret: T_SCALAR, args: [['a', T_SCALAR], ['b', T_SCALAR]], desc: 'blk.func.max.desc' },
  clamp: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR], ['blk.arg.lo', T_SCALAR], ['blk.arg.hi', T_SCALAR]], desc: 'blk.func.clamp.desc' },
  lerp: { ret: T_SCALAR, args: [['a', T_SCALAR], ['b', T_SCALAR], ['t', T_SCALAR]], desc: 'blk.func.lerp.desc' },
  step: { ret: T_SCALAR, args: [['blk.arg.edge', T_SCALAR], ['blk.arg.value', T_SCALAR]], desc: 'blk.func.step.desc' },
  smoothstep: { ret: T_SCALAR, args: [['blk.arg.lo', T_SCALAR], ['blk.arg.hi', T_SCALAR], ['blk.arg.value', T_SCALAR]], desc: 'blk.func.smoothstep.desc' },
  mod: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR], ['blk.arg.mod', T_SCALAR]], desc: 'blk.func.mod.desc' },
  random: { ret: T_SCALAR, args: [], desc: 'blk.func.random.desc' },
  rand: { ret: T_SCALAR, args: [['blk.arg.seed', T_SCALAR]], desc: 'blk.func.rand.desc' },
  vec: { ret: T_VEC, args: [['x', T_SCALAR], ['y', T_SCALAR], ['z', T_SCALAR]], desc: 'blk.func.vec.desc' },
  dot: { ret: T_SCALAR, args: [['a', T_VEC], ['b', T_VEC]], desc: 'blk.func.dot.desc' },
  cross: { ret: T_VEC, args: [['a', T_VEC], ['b', T_VEC]], desc: 'blk.func.cross.desc' },
  len: { ret: T_SCALAR, args: [['blk.arg.vec', T_ANY]], desc: 'blk.func.len.desc' },
  norm: { ret: T_VEC, args: [['blk.arg.vec', T_VEC]], desc: 'blk.func.norm.desc' },
  rotX: { ret: T_MAT, args: [['blk.arg.angle', T_SCALAR]], desc: 'blk.func.rotX.desc' },
  rotY: { ret: T_MAT, args: [['blk.arg.angle', T_SCALAR]], desc: 'blk.func.rotY.desc' },
  rotZ: { ret: T_MAT, args: [['blk.arg.angle', T_SCALAR]], desc: 'blk.func.rotZ.desc' },
  rotAxis: { ret: T_MAT, args: [['blk.arg.axis', T_VEC], ['blk.arg.angle', T_SCALAR]], desc: 'blk.func.rotAxis.desc' },
  polar: { ret: T_VEC, args: [['blk.arg.radius', T_SCALAR], ['blk.arg.angle', T_SCALAR]], desc: 'blk.func.polar.desc' },
  sphere: { ret: T_VEC, args: [['blk.arg.radius', T_SCALAR], ['θ', T_SCALAR], ['φ', T_SCALAR]], desc: 'blk.func.sphere.desc' },
  torus: { ret: T_VEC, args: [['R', T_SCALAR], ['r', T_SCALAR], ['θ', T_SCALAR], ['φ', T_SCALAR]], desc: 'blk.func.torus.desc' },
};

/* —— 语句块定义：label/desc 为 i18n 键（blk.stmt.<kind>.*），group 调色板分组 —— */
export const STMT_BLOCKS = {
  pos: { label: 'blk.stmt.pos.label', group: 'pos', slotCount: 3, desc: 'blk.stmt.pos.desc' },
  pos_vec: { label: 'blk.stmt.pos_vec.label', group: 'pos', slotCount: 1, desc: 'blk.stmt.pos_vec.desc' },
  vel: { label: 'blk.stmt.vel.label', group: 'pos', slotCount: 3, desc: 'blk.stmt.vel.desc' },
  vel_vec: { label: 'blk.stmt.vel_vec.label', group: 'pos', slotCount: 1, desc: 'blk.stmt.vel_vec.desc' },
  col: { label: 'blk.stmt.col.label', group: 'color', slotCount: 4, desc: 'blk.stmt.col.desc' },
  scl: { label: 'blk.stmt.scl.label', group: 'appearance', slotCount: 1, desc: 'blk.stmt.scl.desc' },
  glow: { label: 'blk.stmt.glow.label', group: 'appearance', toggle: true, desc: 'blk.stmt.glow.desc' },
  light: { label: 'blk.stmt.light.label', group: 'appearance', slotCount: 1, desc: 'blk.stmt.light.desc' },
  attr: { label: 'blk.stmt.attr.label', group: 'pos', named: true, desc: 'blk.stmt.attr.desc' },
  set: { label: 'blk.stmt.set.label', group: 'var', named: true, desc: 'blk.stmt.set.desc' },
  comment: { label: 'blk.stmt.comment.label', group: 'logic', named: true, desc: 'blk.stmt.comment.desc' },
  repeat: { label: 'blk.stmt.repeat.label', group: 'logic', desc: 'blk.stmt.repeat.desc' },
  repeat_n: { label: 'blk.stmt.repeat_n.label', group: 'logic', desc: 'blk.stmt.repeat_n.desc' },
  repeat_until: { label: 'blk.stmt.repeat_until.label', group: 'logic', desc: 'blk.stmt.repeat_until.desc' },
};

/* —— 调色板分组（顺序即显示顺序；label 为 i18n 键 blk.pal.<id>） —— */
export const PALETTE_GROUPS = [
  { id: 'start', label: 'blk.pal.start' },
  { id: 'funcs', label: 'blk.pal.funcs' },
  { id: 'props', label: 'blk.pal.props' },
  { id: 'logic', label: 'blk.pal.logic' },
  { id: 'math', label: 'blk.pal.math' },
  { id: 'vec', label: 'blk.pal.vec' },
  { id: 'mat', label: 'blk.pal.mat' },
  { id: 'array', label: 'blk.pal.array' },
  { id: 'var', label: 'blk.pal.var' },
  { id: 'const', label: 'blk.pal.const' },
];

/* —— 运算符块（组内 math；值为 i18n 键 blk.op.*） —— */
export const OP_SYMBOLS = ['+', '-', '*', '/', '%', '^'];
export const OP_LABELS = { '+': 'blk.op.add', '-': 'blk.op.sub', '*': 'blk.op.mul', '/': 'blk.op.div', '%': 'blk.op.mod', '^': 'blk.op.pow', '==': 'blk.op.eq', '!=': 'blk.op.ne', '<': 'blk.op.lt', '<=': 'blk.op.le', '>': 'blk.op.gt', '>=': 'blk.op.ge', '&&': 'blk.op.and', '||': 'blk.op.or' };

/* =========================================================================
 * 类型
 * ======================================================================= */

export function typeAccepts(slotType, blockType) {
  if (slotType === T_ANY || blockType === T_ANY) return true;
  return slotType === blockType;
}

export function opResultType(op, ta, tb) {
  if (op === '^' || op === '%') return T_SCALAR;
  if (op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=' || op === '&&' || op === '||') return T_SCALAR;
  if (op === '/') return (ta === T_VEC && (tb === T_SCALAR || tb === T_ANY)) ? T_VEC : T_SCALAR;
  if (op === '+' || op === '-') {
    if ((ta === T_VEC || ta === T_ANY) && (tb === T_VEC || tb === T_ANY)) return T_VEC;
    if ((ta === T_MAT || ta === T_ANY) && (tb === T_MAT || tb === T_ANY)) return T_MAT;
    return T_SCALAR;
  }
  if (op === '*') {
    if (ta === T_MAT && tb === T_VEC) return T_VEC;
    if (ta === T_MAT && tb === T_MAT) return T_MAT;
    if (ta === T_MAT) return T_MAT;
    if (ta === T_VEC && (tb === T_SCALAR || tb === T_ANY)) return T_VEC;
    if (ta === T_VEC && tb === T_VEC) return T_VEC;
    if ((ta === T_SCALAR || ta === T_ANY) && tb === T_VEC) return T_VEC;
    if ((ta === T_SCALAR || ta === T_ANY) && tb === T_MAT) return T_MAT;
    return T_SCALAR;
  }
  return T_ANY;
}

/** 推断表达式节点类型。varTypeOf(name) 返回该变量的类型（标量/向量/矩阵/any）。 */
export function exprType(node, varTypeOf) {
  if (!node) return T_ANY;
  const vt = varTypeOf || (() => T_ANY);
  switch (node.kind) {
    case 'num': return T_SCALAR;
    case 'bool': return T_SCALAR;
    case 'var': return (node.name === 'pi' || node.name === 'e') ? T_SCALAR : vt(node.name);
    case 'member': return (node.field === 'uv' || node.field === 'position' || node.field === 'color' || node.field === 'velocity') ? T_VEC : T_SCALAR;
    case 'func': return FUNC_BLOCKS[node.name] ? FUNC_BLOCKS[node.name].ret : T_ANY;
    case 'array': return T_ANY;
    case 'index': return T_ANY;
    case 'method': return T_ANY;
    case 'comp': return T_SCALAR;
    case 'not': return T_SCALAR;
    case 'ternary': return T_ANY;
    case 'neg': return exprType(node.a, vt);
    case 'chain': {
      if (node.terms.some(t => !t)) return T_ANY;
      // 按运算符优先级求类型（* / % 优先于 + -），与 exprToCode 生成代码的求值语义一致
      const tt = node.terms.map(t => exprType(t, vt));
      const oo = node.ops.slice();
      for (let i = 0; i < oo.length;) {
        if (oo[i] === '*' || oo[i] === '/' || oo[i] === '%') {
          tt[i] = opResultType(oo[i], tt[i], tt[i + 1]);
          tt.splice(i + 1, 1);
          oo.splice(i, 1);
        } else {
          i++;
        }
      }
      let t = tt[0];
      for (let j = 0; j < oo.length; j++) t = opResultType(oo[j], t, tt[j + 1]);
      return t;
    }
    case 'op': return (node.a == null || node.b == null) ? T_ANY : opResultType(node.op, exprType(node.a, vt), exprType(node.b, vt));
    default: return T_ANY;
  }
}

/** 表达式是否已填满（所有参数槽都有值）。空槽（null）表示未填写。 */
export function exprComplete(node) {
  if (!node) return false;
  switch (node.kind) {
    case 'num': case 'bool': case 'var': return true;
    case 'member': return exprComplete(node.obj);
    case 'func': return node.args.every(exprComplete);
    case 'op': return exprComplete(node.a) && exprComplete(node.b);
    case 'chain': return node.terms.every(exprComplete);
    case 'comp': return exprComplete(node.target);
    case 'neg': case 'not': return exprComplete(node.a);
    case 'ternary': return exprComplete(node.cond) && exprComplete(node.a) && exprComplete(node.b);
    case 'index': return exprComplete(node.target) && exprComplete(node.index);
    case 'method': return exprComplete(node.obj) && node.args.every(exprComplete);
    case 'array': return true; // 数组字面量允许留空；生成时跳过空槽（全空生成 []）
    default: return false;
  }
}

/** 语句是否有生成代码所需的最少参数；缺参视为空块（无效果），生成时跳过。 */
export function stmtComplete(s) {
  if (!s) return false;
  switch (s.kind) {
    case 'pos': case 'vel': case 'col': return (s.slots || []).every(exprComplete);
    case 'pos_vec': case 'vel_vec': case 'scl': case 'light': case 'attr': case 'set': case 'expr':
      return exprComplete(s.expr);
    case 'glow': case 'break': case 'continue': case 'raw': case 'comment': return true;
    case 'return': return s.expr == null || exprComplete(s.expr);
    case 'if': case 'while': case 'do': return exprComplete(s.cond);
    case 'for': return String(s.cond || '').trim() !== '';
    case 'repeat': return true;
    case 'repeat_n': return exprComplete(s.count);
    case 'repeat_until': return exprComplete(s.cond);
    case 'func': return String(s.name || '').trim() !== '';
    case 'global': case 'static':
      return String(s.name || '').trim() !== '' && (s.expr == null || exprComplete(s.expr));
    default: return true;
  }
}

/* =========================================================================
 * 代码生成（积木树 → 文本）
 * ======================================================================= */

export function fmtNum(v) {
  if (!Number.isFinite(v)) return '0';
  const neg = v < 0;
  const a = Math.abs(v);
  let s = String(a);
  if (s.includes('e') || s.includes('E')) s = a.toFixed(15).replace(/\.?0+$/, '');
  s = (s === '-0' || s === '') ? '0' : s;
  return neg ? '-' + s : s;
}

/** 表达式节点 → 代码。parentPrec 为父级要求的优先级（低于则加括号）。 */
export function exprToCode(node, parentPrec) {
  if (!node) return '';
  let s, p;
  switch (node.kind) {
    case 'num':
      // 负数字面量作为操作数时需加括号（如 2 * -3 → 2 * (-3)），优先级降到最低
      s = fmtNum(node.value);
      p = (node.value < 0) ? 0.5 : ATOM_PREC;
      break;
    case 'bool':
      s = node.value ? 'true' : 'false'; p = ATOM_PREC; break;
    case 'var':
      s = node.name; p = ATOM_PREC; break;
    case 'member':
      s = exprToCode(node.obj, ATOM_PREC) + '.' + node.field; p = ATOM_PREC; break;
    case 'func':
      s = node.name + '(' + node.args.map(a => exprToCode(a, 0)).join(', ') + ')'; p = ATOM_PREC; break;
    case 'array':
      s = '[' + node.items.filter(a => exprComplete(a)).map(a => exprToCode(a, 0)).join(', ') + ']'; p = ATOM_PREC; break;
    case 'index':
      s = exprToCode(node.target, ATOM_PREC) + '[' + exprToCode(node.index, 0) + ']'; p = ATOM_PREC; break;
    case 'method':
      s = exprToCode(node.obj, ATOM_PREC) + '.' + node.method + '(' + node.args.map(a => exprToCode(a, 0)).join(', ') + ')'; p = ATOM_PREC; break;
    case 'comp':
      s = exprToCode(node.target, ATOM_PREC) + '.' + node.axis; p = ATOM_PREC; break;
    case 'not':
      s = '!' + exprToCode(node.a, NEG_PREC); p = NEG_PREC; break;
    case 'neg':
      s = '-' + exprToCode(node.a, NEG_PREC); p = NEG_PREC; break;
    case 'ternary':
      s = exprToCode(node.cond, 1) + ' ? ' + exprToCode(node.a, 0) + ' : ' + exprToCode(node.b, 0.75); p = 0.75; break;
    case 'op': {
      const prec = PREC[node.op];
      const rightAssoc = node.op === '^';
      // 左结合：左操作数用 prec、右操作数用 prec+1；右结合(^)：左操作数用 prec+1、右操作数用 prec
      const left = exprToCode(node.a, prec + (rightAssoc ? 1 : 0));
      const right = exprToCode(node.b, rightAssoc ? prec : prec + 1);
      s = left + ' ' + node.op + ' ' + right;
      p = prec;
      break;
    }
    case 'chain': {
      // 动态算式：从左到右 t0 op0 t1 op1 t2 ...，按标准优先级加括号
      // 首项作为第一个 op 的左操作数；中间项作为前一个 op 的右操作数；末项作为最后一个 op 的右操作数
      const n = node.ops.length;
      s = exprToCode(node.terms[0], n > 0 ? PREC[node.ops[0]] : 0);
      for (let i = 0; i < n; i++) {
        const op = node.ops[i];
        const prec = PREC[op];
        s += ' ' + op + ' ' + exprToCode(node.terms[i + 1], prec + 1);
      }
      // 整体优先级取所有运算符的最低（混合优先级 chain 下首个不一定最低），用于父级加括号判断
      p = ATOM_PREC;
      for (let i = 0; i < n; i++) { const pr = PREC[node.ops[i]]; if (pr < p) p = pr; }
      break;
    }
    default: throw new Error(_etf('err.unknownExprNode', node.kind));
  }
  return (p < parentPrec) ? '(' + s + ')' : s;
}

function indentPad(level) { return '  '.repeat(Math.max(0, level || 0)); }
function lineCount(str) { return (str === '') ? 0 : str.split('\n').length; }

function stmtNeedsSemi(code) {
  const t = (code || '').trim();
  if (!t) return false;
  if (t.endsWith('}') || t.endsWith(';') || t.endsWith('*/')) return false;
  return !t.startsWith('//');
}

function emitComment(s, pad) {
  const text = String(s.text || '');
  if (!text.includes('\n')) return pad + '// ' + text;
  return pad + '/*\n' + text.split('\n').map(l => pad + ' ' + l).join('\n') + '\n' + pad + ' */';
}

function emitStmt(s, level, spans, lineStart) {
  if (!stmtComplete(s)) return '';
  const pad = indentPad(level);
  const start = lineStart || 1;
  switch (s.kind) {
    case 'pos': return pad + 'this.position = [' + s.slots.map(x => exprToCode(x, 0)).join(', ') + ']';
    case 'pos_vec': return pad + 'this.position = ' + exprToCode(s.expr, 0);
    case 'vel': return pad + 'this.velocity = [' + s.slots.map(x => exprToCode(x, 0)).join(', ') + ']';
    case 'vel_vec': return pad + 'this.velocity = ' + exprToCode(s.expr, 0);
    case 'col': return pad + 'this.color = [' + s.slots.map(x => exprToCode(x, 0)).join(', ') + ']';
    case 'scl': return pad + 'this.scale = ' + exprToCode(s.expr, 0);
    case 'glow': return pad + 'this.glow = ' + (s.on ? '1' : '0');
    case 'light': return pad + 'this.light = ' + exprToCode(s.expr, 0);
    case 'attr': return pad + 'this.' + s.name + ' = ' + exprToCode(s.expr, 0);
    case 'set': return pad + s.name + ' = ' + exprToCode(s.expr, 0);
    case 'expr': return pad + exprToCode(s.expr, 0) + ';';
    case 'raw': return s.text || '';
    case 'comment': return emitComment(s, pad);
    case 'break': return pad + 'break;';
    case 'continue': return pad + 'continue;';
    case 'return': return pad + (s.expr ? 'return ' + exprToCode(s.expr, 0) + ';' : 'return;');
    case 'if': {
      const cond = exprToCode(s.cond, 0);
      const body = emitList(s.body || [], level + 1, spans, start + 1);
      const bodyLines = lineCount(body);
      let out = pad + 'if (' + cond + ') {\n';
      if (body) out += body + '\n';
      out += pad + '}';
      if (s.elseBody && s.elseBody.length) {
        const elseLine = start + bodyLines + 1;
        if (s.elseBody.length === 1 && s.elseBody[0].kind === 'if') {
          out += ' else ' + emitStmt(s.elseBody[0], level, spans, elseLine);
        } else {
          out += ' else {\n';
          out += emitList(s.elseBody, level + 1, spans, elseLine + 1);
          out += '\n' + pad + '}';
        }
      }
      return out;
    }
    case 'while': {
      const body = emitList(s.body || [], level + 1, spans, start + 1);
      return pad + 'while (' + exprToCode(s.cond, 0) + ') {\n' + body + '\n' + pad + '}';
    }
    case 'do': {
      const body = emitList(s.body || [], level + 1, spans, start + 1);
      return pad + 'do {\n' + body + '\n' + pad + '} while (' + exprToCode(s.cond, 0) + ');';
    }
    case 'for': {
      const body = emitList(s.body || [], level + 1, spans, start + 1);
      return pad + 'for (' + (s.init || '') + '; ' + (s.cond || '') + '; ' + (s.inc || '') + ') {\n' + body + '\n' + pad + '}';
    }
    case 'repeat': {
      const body = emitList(s.body || [], level + 1, spans, start + 1);
      return pad + 'while (true) {\n' + body + '\n' + pad + '}';
    }
    case 'repeat_n': {
      const body = emitList(s.body || [], level + 1, spans, start + 1);
      // 循环变量 _rep 与代码解析端约定一致，保证往返稳定。
      return pad + 'for (_rep = 0; _rep < ' + exprToCode(s.count, 0) + '; _rep = _rep + 1) {\n' + body + '\n' + pad + '}';
    }
    case 'repeat_until': {
      const body = emitList(s.body || [], level + 1, spans, start + 1);
      // 「重复执行直到 cond」= while (!(cond))。
      const cond = exprToCode(s.cond, 0);
      return pad + 'while (!(' + cond + ')) {\n' + body + '\n' + pad + '}';
    }
    case 'func': {
      const body = emitList(s.body || [], level + 1, spans, start + 1);
      return pad + 'func ' + s.name + '(' + (s.params || []).join(', ') + ') {\n' + body + '\n' + pad + '}';
    }
    case 'global': case 'static': return pad + s.kind + ' ' + s.name + (s.expr ? ' = ' + exprToCode(s.expr, 0) : '') + ';';
    default: throw new Error(_etf('err.unknownStmt', s.kind));
  }
}

function emitList(list, level, spans, startLine) {
  let out = '';
  let line = startLine || 1;
  for (const s of list || []) {
    let code = emitStmt(s, level, spans, line);
    if (code == null || code === '') continue;
    if (stmtNeedsSemi(code)) code += ';';
    const n = lineCount(code);
    if (spans) spans.push({ stmt: s, start: line, end: line + n - 1 });
    if (out) out += '\n';
    out += code;
    line += n;
  }
  return out;
}

export function stmtToCode(s, level) {
  return emitStmt(s, level || 0, null);
}

export function statementsToCode(stmts, level) {
  return emitList(stmts || [], level || 0, null);
}

/** 与 statementsToCode 相同的代码，另返回每条语句（含嵌套语句）在生成代码中的行区间。 */
export function statementsToCodeSpans(stmts, level) {
  const spans = [];
  const code = emitList(stmts || [], level || 0, spans);
  return { code, spans };
}

/* =========================================================================
 * 代码解析（文本 → 积木树）
 * ======================================================================= */

/**
 * 拼图专用分词：与 script-lang 表达式语法对齐，但 pi/e 保留为标识符
 * 使往返序列化保持 `pi`/`e` 原样、不损失精度。
 */
export function blockTokenize(expr) {
  const tokens = [];
  let i = 0;
  let expectOperand = true;
  const isIdentStart = c => /[a-zA-Z_]/.test(c);
  const isIdentPart = c => /[a-zA-Z0-9_]/.test(c);
  while (i < expr.length) {
    const c = expr[i];
    if (c === ' ' || c === '\t' || c === '\n') { i++; continue; }
    // 字符串字面量：拼图表达式不支持字符串，仅保证 token 化不破坏其后内容；
    // parseExpr 遇到 str token 会抛错，使语句降级为 raw 而非被错误解析。
    if (c === '"') {
      let j = i + 1;
      while (j < expr.length && expr[j] !== '"') j++;
      tokens.push({ t: 'str', v: expr.slice(i + 1, j) });
      i = j + 1; expectOperand = false; continue;
    }
    // 多字符运算符
    const two = expr.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '&&' || two === '||') {
      tokens.push({ t: 'op', op: two });
      i += 2; expectOperand = true; continue;
    }
    if (c === '.' && /[xyzwrgba]/.test(expr[i + 1] || '') && !/[a-zA-Z0-9_]/.test(expr[i + 2] || '')) {
      tokens.push({ t: 'comp', axis: expr[i + 1] }); i += 2; expectOperand = false; continue;
    }
    if (c === '.' && isIdentStart(expr[i + 1] || '')) {
      tokens.push({ t: 'dot' }); i++; expectOperand = false; continue;
    }
    if ((c >= '0' && c <= '9') || (c === '.' && (expr[i + 1] >= '0' && expr[i + 1] <= '9'))) {
      let j = i; while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
      tokens.push({ t: 'num', v: parseFloat(expr.slice(i, j)) }); i = j; expectOperand = false; continue;
    }
    if (isIdentStart(c)) {
      let j = i; while (j < expr.length && isIdentPart(expr[j])) j++;
      const name = expr.slice(i, j);
      if (name === 'true') { tokens.push({ t: 'bool', v: true }); }
      else if (name === 'false') { tokens.push({ t: 'bool', v: false }); }
      else if (SCRIPT_FUNC_SET.has(name)) tokens.push({ t: 'func', name });
      else tokens.push({ t: 'var', name }); // pi/e 归为 var，序列化时原样输出
      i = j; expectOperand = false; continue;
    }
    if (c === '-' && expectOperand) { tokens.push({ t: 'neg' }); i++; continue; } // 一元负号
    if (c === '!') { tokens.push({ t: 'not' }); i++; expectOperand = true; continue; }
    if (c === '?') { tokens.push({ t: '?' }); i++; expectOperand = true; continue; }
    if (c === ':') { tokens.push({ t: ':' }); i++; expectOperand = true; continue; }
    if (c === '[') { tokens.push({ t: '[' }); i++; expectOperand = true; continue; }
    if (c === ']') { tokens.push({ t: ']' }); i++; expectOperand = false; continue; }
    if ('<>+-*/%^(),'.includes(c)) { tokens.push({ t: c }); i++; expectOperand = (c === '(' || c === ',' || '<>+-*/%^'.includes(c)); continue; }
    i++;
  }
  return tokens;
}

/** 表达式字符串 → 表达式节点（递归下降，基于 blockTokenize）。 */
export function parseExpr(str) {
  const toks = blockTokenize(str);
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const expect = (t) => { const tk = next(); if (!tk || tk.t !== t) throw new Error(_etf('err.exprNeed', t, str)); return tk; };
  const isOpTok = (t, ops) => !!t && ((t.t === 'op' && ops.includes(t.op)) || ops.includes(t.t));

  function parseCallArgs() {
    const args = [];
    if (peek() && peek().t !== ')') {
      args.push(parseTernary());
      while (peek() && peek().t === ',') { next(); args.push(parseTernary()); }
    }
    expect(')');
    return args;
  }

  function parsePrimary() {
    const tk = next();
    if (!tk) throw new Error(_et('err.exprEnd'));
    let node;
    if (tk.t === 'num') node = { kind: 'num', value: tk.v };
    else if (tk.t === 'bool') node = { kind: 'bool', value: tk.v };
    else if (tk.t === 'var') {
      // 标识符后跟 '(' 视为函数调用：内建函数、用户函数、变量保存的函数值均可调用。
      // 不再依赖 FUNCS 白名单，因此 script-lang 新增的内建函数（noise/fbm/map_range 等）
      // 都能被拼图解析为 func 节点。
      if (peek() && peek().t === '(') {
        next(); // '('
        node = { kind: 'func', name: tk.name, args: parseCallArgs() };
      } else {
        node = { kind: 'var', name: tk.name };
      }
    }
    else if (tk.t === 'neg') {
      const inner = parsePower();
      if (inner.kind === 'num') node = { kind: 'num', value: -inner.value };
      else node = { kind: 'neg', a: inner };
    } else if (tk.t === 'not') {
      node = { kind: 'not', a: parsePower() };
    } else if (tk.t === 'func') {
      if (!peek() || peek().t !== '(') throw new Error(_etf('err.funcNoParen', tk.name));
      next(); // '('
      node = { kind: 'func', name: tk.name, args: parseCallArgs() };
    } else if (tk.t === '[') {
      const items = [];
      if (peek() && peek().t !== ']') {
        items.push(parseTernary());
        while (peek() && peek().t === ',') { next(); items.push(parseTernary()); }
      }
      expect(']');
      node = { kind: 'array', items };
    } else if (tk.t === '(') {
      node = parseTernary();
      expect(')');
    } else {
      throw new Error(_etf('err.unexpectedTok', tk.t || JSON.stringify(tk)));
    }
    return node;
  }

  function parsePostfix() {
    let node = parsePrimary();
    while (peek()) {
      if (peek().t === 'comp') {
        const c = next();
        node = { kind: 'comp', axis: c.axis, target: node };
      } else if (peek().t === '[') {
        next();
        const idx = parseTernary();
        expect(']');
        node = { kind: 'index', target: node, index: idx };
      } else if (peek().t === 'dot') {
        next();
        const m = next();
        // 方法名可能恰为内建函数名（blockTokenize 会标记为 func），此处两种 token 都接受。
        if (!m || (m.t !== 'var' && m.t !== 'func')) throw new Error(_etf('err.exprNeed', 'method', str));
        if (!peek() || peek().t !== '(') { node = { kind: 'member', obj: node, field: m.name }; continue; }
        next(); // '('
        node = { kind: 'method', obj: node, method: m.name, args: parseCallArgs() };
      } else {
        break;
      }
    }
    return node;
  }

  function parsePower() {
    let node = parsePostfix();
    if (peek() && peek().t === '^') { next(); node = { kind: 'op', op: '^', a: node, b: parsePower() }; }
    return node;
  }
  function parseMulDiv() {
    const terms = [parsePower()];
    const ops = [];
    while (peek() && (peek().t === '*' || peek().t === '/' || peek().t === '%')) {
      ops.push(next().t);
      terms.push(parsePower());
    }
    const first = terms[0];
    if (first.kind === 'op' && (first.op === '*' || first.op === '/' || first.op === '%')) {
      terms.splice(0, 1, first.a, first.b);
      ops.unshift(first.op);
    }
    return (terms.length === 1) ? terms[0] : (terms.length === 2) ? { kind: 'op', op: ops[0], a: terms[0], b: terms[1] } : { kind: 'chain', terms, ops };
  }
  function parseAddSub() {
    const terms = [parseMulDiv()];
    const ops = [];
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      ops.push(next().t);
      terms.push(parseMulDiv());
    }
    if (terms.length === 1) return terms[0];
    const absorbable = (t) => t.kind === 'chain' && PREC[t.ops[0]] > 1;
    if (terms.some(absorbable)) {
      const ft = [];
      const fo = [];
      for (let i = 0; i < terms.length; i++) {
        if (i > 0) fo.push(ops[i - 1]);
        const t = terms[i];
        if (absorbable(t)) {
          ft.push(t.terms[0]);
          for (let j = 0; j < t.ops.length; j++) { fo.push(t.ops[j]); ft.push(t.terms[j + 1]); }
        } else {
          ft.push(t);
        }
      }
      return { kind: 'chain', terms: ft, ops: fo };
    }
    return (terms.length === 2) ? { kind: 'op', op: ops[0], a: terms[0], b: terms[1] } : { kind: 'chain', terms, ops };
  }
  function parseCompare() {
    let node = parseAddSub();
    while (isOpTok(peek(), ['<', '<=', '>', '>='])) {
      const tk = next();
      const op = tk.op || tk.t;
      node = { kind: 'op', op, a: node, b: parseAddSub() };
    }
    return node;
  }
  function parseEquality() {
    let node = parseCompare();
    while (isOpTok(peek(), ['==', '!='])) {
      const tk = next();
      const op = tk.op || tk.t;
      node = { kind: 'op', op, a: node, b: parseCompare() };
    }
    return node;
  }
  function parseAnd() {
    let node = parseEquality();
    while (isOpTok(peek(), ['&&'])) {
      next();
      node = { kind: 'op', op: '&&', a: node, b: parseEquality() };
    }
    return node;
  }
  function parseOr() {
    let node = parseAnd();
    while (isOpTok(peek(), ['||'])) {
      next();
      node = { kind: 'op', op: '||', a: node, b: parseAnd() };
    }
    return node;
  }
  function parseTernary() {
    const cond = parseOr();
    if (peek() && peek().t === '?') {
      next();
      const a = parseTernary();
      expect(':');
      const b = parseTernary();
      return { kind: 'ternary', cond, a, b };
    }
    return cond;
  }

  const node = parseTernary();
  if (pos < toks.length) throw new Error(_etf('err.exprExtra', str));
  return node;
}

export const isNames = (names, expect) => names.length === expect.length && names.every((n, i) => n === expect[i]);

function matchDelim(s, openIndex, open, close) {
  let depth = 0;
  let inStr = false, esc = false;
  for (let i = openIndex; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}
function stripBraces(s) {
  const t = (s || '').trim();
  if (t.startsWith('{') && t.endsWith('}')) return t.slice(1, -1).trim();
  return t;
}
function splitTopSemicolons(s) {
  const parts = [];
  let cur = '';
  let depth = 0;
  for (const c of s) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ';' && depth === 0) { parts.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

export function stmtToNode(stmt) {
  const s = (stmt || '').trim();
  if (s.startsWith('//')) return { kind: 'comment', text: s.slice(2).trim() };
  if (s.startsWith('/*')) {
    let t = s.slice(2).trim();
    if (t.endsWith('*/')) t = t.slice(0, -2).trim();
    return { kind: 'comment', text: t };
  }
  if (s === 'break;' || s === 'break') return { kind: 'break' };
  if (s === 'continue;' || s === 'continue') return { kind: 'continue' };
  if (s === 'return;') return { kind: 'return', expr: null };
  if (/^return\b/.test(s)) return { kind: 'return', expr: parseExpr(s.slice(6).replace(/;$/, '').trim()) };

  if (/^if\s*\(/.test(s)) {
    const open = s.indexOf('(');
    const close = matchDelim(s, open, '(', ')');
    if (close < 0) throw new Error(_et('err.stmtNeedParen'));
    const cond = parseExpr(s.slice(open + 1, close).trim());
    let rest = s.slice(close + 1).trim();
    const bOpen = rest.indexOf('{');
    const bClose = matchDelim(rest, bOpen, '{', '}');
    if (bClose < 0) throw new Error(_et('err.stmtNeedBrace'));
    const body = codeToStatements(rest.slice(bOpen + 1, bClose));
    rest = rest.slice(bClose + 1).trim();
    let elseBody = null;
    if (rest.startsWith('else')) {
      const after = rest.slice(4).trim();
      if (/^if\b/.test(after)) elseBody = [stmtToNode(after)];
      else elseBody = codeToStatements(stripBraces(after));
    }
    return { kind: 'if', cond, body, elseBody };
  }
  if (/^while\s*\(/.test(s)) {
    const open = s.indexOf('(');
    const close = matchDelim(s, open, '(', ')');
    if (close < 0) throw new Error(_et('err.stmtNeedParen'));
    const cond = parseExpr(s.slice(open + 1, close).trim());
    const rest = s.slice(close + 1).trim();
    const bOpen = rest.indexOf('{');
    const bClose = matchDelim(rest, bOpen, '{', '}');
    if (bClose < 0) throw new Error(_et('err.stmtNeedBrace'));
    const body = codeToStatements(rest.slice(bOpen + 1, bClose));
    // Scratch 式循环在文本层映射回对应积木，保证往返稳定。
    if (cond.kind === 'bool' && cond.value === true) return { kind: 'repeat', body };
    if (cond.kind === 'not') return { kind: 'repeat_until', cond: cond.a, body };
    return { kind: 'while', cond, body };
  }
  if (/^for\s*\(/.test(s)) {
    const open = s.indexOf('(');
    const close = matchDelim(s, open, '(', ')');
    if (close < 0) throw new Error(_et('err.stmtNeedParen'));
    const parts = splitTopSemicolons(s.slice(open + 1, close));
    const rest = s.slice(close + 1).trim();
    const bOpen = rest.indexOf('{');
    const bClose = matchDelim(rest, bOpen, '{', '}');
    if (bClose < 0) throw new Error(_et('err.stmtNeedBrace'));
    const body = codeToStatements(rest.slice(bOpen + 1, bClose));
    const init = parts[0] || '', cond = parts[1] || '', inc = parts[2] || '';
    // 识别「重复执行 N 次」生成的 for (_rep = 0; _rep < N; _rep = _rep + 1) 模式。
    const repN = /^_rep\s*<\s*([\s\S]+)$/.exec(cond.trim());
    if (init.trim() === '_rep = 0' && inc.trim() === '_rep = _rep + 1' && repN) {
      return { kind: 'repeat_n', count: parseExpr(repN[1].trim()), body };
    }
    return { kind: 'for', init, cond, inc, body };
  }
  if (/^do\s*\{/.test(s)) {
    const bOpen = s.indexOf('{');
    const bClose = matchDelim(s, bOpen, '{', '}');
    if (bClose < 0) throw new Error(_et('err.stmtNeedBrace'));
    const body = s.slice(bOpen + 1, bClose).trim();
    const rest = s.slice(bClose + 1).trim();
    const wm = /^while\s*\(/.exec(rest);
    if (!wm) throw new Error(_et('err.stmtMissingEq', stmt));
    const open = rest.indexOf('(');
    const close = matchDelim(rest, open, '(', ')');
    const cond = parseExpr(rest.slice(open + 1, close).trim());
    return { kind: 'do', body: codeToStatements(s.slice(bOpen + 1, bClose)), cond };
  }
  if (/^func\s+/.test(s)) {
    const after = s.slice(4).trim();
    const open = after.indexOf('(');
    const close = matchDelim(after, open, '(', ')');
    if (close < 0) throw new Error(_et('err.stmtNeedParen'));
    const name = after.slice(0, open).trim();
    const params = after.slice(open + 1, close).split(',').map(x => x.trim()).filter(Boolean);
    const rest = after.slice(close + 1).trim();
    const bOpen = rest.indexOf('{');
    const bClose = matchDelim(rest, bOpen, '{', '}');
    if (bClose < 0) throw new Error(_et('err.stmtNeedBrace'));
    return { kind: 'func', name, params, body: codeToStatements(rest.slice(bOpen + 1, bClose)) };
  }
  if (/^(global|static)\s+/.test(s)) {
    const kind = s.startsWith('global') ? 'global' : 'static';
    const after = s.slice(kind.length).trim();
    const eq = after.indexOf('=');
    if (eq < 0) return { kind, name: after.replace(/;$/, '').trim(), expr: null };
    return { kind, name: after.slice(0, eq).trim(), expr: parseExpr(after.slice(eq + 1).replace(/;$/, '').trim()) };
  }

  const eq = s.indexOf('=');
  if (eq < 0) {
    // 无 '=' 的顶层语句：作为表达式语句（函数/方法调用等，如 arr.push(1)、noise(...)）。
    // 解析失败时让调用方（codeToStatements）降级为 raw 块。
    return { kind: 'expr', expr: parseExpr(s.replace(/;$/, '').trim()) };
  }
  const lhs = s.slice(0, eq).trim();
  const rhs = s.slice(eq + 1).trim();
  if (lhs.startsWith('[')) {
    // 旧 [x,y,z]=... 属性打包语法已移除；作为 raw 保留。
    throw new Error(_etf('err.unknownPack', stmt));
  }
  if (lhs === 'this.position') {
    if (rhs.startsWith('[')) {
      const exprs = parseExprList(rhs).map(e => parseExpr(e));
      if (exprs.length !== 3) throw new Error(_etf('err.assignCount2', stmt));
      return { kind: 'pos', slots: exprs };
    }
    return { kind: 'pos_vec', expr: parseExpr(rhs) };
  }
  if (lhs === 'this.velocity') {
    if (rhs.startsWith('[')) {
      const exprs = parseExprList(rhs).map(e => parseExpr(e));
      if (exprs.length !== 3) throw new Error(_etf('err.assignCount2', stmt));
      return { kind: 'vel', slots: exprs };
    }
    return { kind: 'vel_vec', expr: parseExpr(rhs) };
  }
  if (lhs === 'this.color') {
    if (rhs.startsWith('[')) {
      const exprs = parseExprList(rhs).map(e => parseExpr(e));
      if (exprs.length !== 4) throw new Error(_etf('err.assignCount2', stmt));
      return { kind: 'col', slots: exprs };
    }
    throw new Error(_etf('err.unknownUnpack', stmt));
  }
  if (lhs === 'this.scale') return { kind: 'scl', expr: parseExpr(rhs) };
  if (lhs === 'this.glow') {
    const e = parseExpr(rhs);
    if (e.kind === 'num' && (e.value === 1 || e.value === 0)) return { kind: 'glow', on: e.value === 1 };
    throw new Error(_etf('err.glowBinary', stmt));
  }
  if (lhs === 'this.light') return { kind: 'light', expr: parseExpr(rhs) };
  if (/^this\.(position|velocity|color)\.(x|y|z|r|g|b|a|w)$/.test(lhs)) {
    return { kind: 'attr', name: lhs.slice('this.'.length), expr: parseExpr(rhs) };
  }
  return { kind: 'set', name: lhs, expr: parseExpr(rhs) };
}

/** 把代码文本拆成顶层语句（尊重字符串 / 括号 / 花括号 / 注释，避免在 if/for/while 体内误拆）。 */
export function splitStatements(code) {
  const out = [];
  const src = code || '';
  let cur = '';
  let depth = 0;
  let inStr = false;
  let esc = false;
  const pushCur = () => {
    const s = cur.trim();
    if (s) out.push(s);
    cur = '';
  };
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (inStr) {
      cur += c;
      if (esc) { esc = false; }
      else if (c === '\\') { esc = true; }
      else if (c === '"') { inStr = false; }
      i++;
      continue;
    }
    if (c === '"') { inStr = true; cur += c; i++; continue; }

    // 行注释：顶层作为独立注释语句；花括号内保留原文，交给递归解析。
    if (c === '/' && src[i + 1] === '/') {
      if (depth > 0) {
        let j = i;
        while (j < src.length && src[j] !== '\n') j++;
        cur += src.slice(i, j);
        i = j;
        continue;
      }
      pushCur();
      let j = i;
      while (j < src.length && src[j] !== '\n') j++;
      const comment = src.slice(i, j).trim();
      if (comment) out.push(comment);
      i = j;
      continue;
    }
    // 块注释：顶层作为独立注释语句；花括号内保留原文。
    if (c === '/' && src[i + 1] === '*') {
      const start = i;
      let j = i + 2;
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++;
      if (j >= src.length) {
        if (depth > 0) cur += src.slice(start);
        else {
          pushCur();
          const comment = src.slice(start).trim();
          if (comment) out.push(comment);
        }
        i = src.length;
      } else {
        j += 2;
        if (depth > 0) {
          cur += src.slice(start, j);
        } else {
          pushCur();
          const comment = src.slice(start, j).trim();
          if (comment) out.push(comment);
        }
        i = j;
      }
      continue;
    }

    if (c === '(' || c === '[' || c === '{') { depth++; cur += c; i++; continue; }
    if (c === ')' || c === ']') { depth = Math.max(0, depth - 1); cur += c; i++; continue; }
    if (c === '}') {
      depth = Math.max(0, depth - 1);
      cur += c;
      if (depth === 0) {
        // 块结束后若后面不是 else / while（do-while），视为语句边界
        let j = i + 1;
        while (j < src.length && /\s/.test(src[j])) j++;
        const look = src.slice(j, j + 5);
        if (!look.startsWith('else') && !look.startsWith('while')) pushCur();
      }
      i++;
      continue;
    }
    if (c === ';' && depth === 0) {
      pushCur();
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  pushCur();
  return out;
}

/** 代码文本 → 语句列表。无法用积木表达的语句保留为 raw 文本块，确保往返不丢代码。 */
export function codeToStatements(code) {
  return splitStatements(code).map(stmt => {
    try { return stmtToNode(stmt); }
    catch (e) { return { kind: 'raw', text: stmt }; }
  });
}

/** 收集语句列表里的临时变量名（set 块）。 */
export function collectTemps(stmts) {
  const out = [];
  const seen = new Set();
  walkStatements(stmts, s => {
    if (s.kind === 'set' && !seen.has(s.name)) { seen.add(s.name); out.push(s.name); }
  });
  return out;
}

/** 深度优先遍历语句树（含 if/while/for/do/func 的 body 与 elseBody）。 */
export function walkStatements(stmts, fn) {
  for (const s of stmts || []) {
    fn(s);
    if (Array.isArray(s.body)) walkStatements(s.body, fn);
    if (Array.isArray(s.elseBody)) walkStatements(s.elseBody, fn);
  }
}
