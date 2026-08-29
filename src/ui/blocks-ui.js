/* =========================================================================
 * 拼图代码块 UI（数据流层）
 * 渲染与交互全部委托给 puzzle-canvas.js（canvas），本文件只负责：
 *   - bctx 工作区数据模型与生命周期（open/close/preview/undo）
 *   - 积木数据模型工具（克隆 / 类型 / 调色板 / 查找 / 重命名）
 *   - 工作区持久化（localStorage）
 *   - 悬浮窗（场景 / 代码回显）与顶层 DOM 骨架
 * 依赖 blocks.js、float-window.js、easing.js、constants.js、undo.js、panels.js、generators.js
 * ======================================================================= */

import { t, tf, _etf } from '../core/i18n.js';
import { state, getFunction } from '../core/constants.js';
import { ATTR_NAMES } from '../core/easing.js';
import { modalAlert } from './ui.js';
import { T_SCALAR, T_VEC, T_MAT, T_ANY, FUNC_BLOCKS, STMT_BLOCKS, PALETTE_GROUPS, OP_SYMBOLS, OP_LABELS, collectTemps, walkStatements, codeToStatements, statementsToCode, exprType, typeAccepts, fmtNum } from '../core/blocks.js';
import { makeFloatWindow } from './float-window.js';
import { pushUndo, cloneVars } from '../state/undo.js';
import { commitFunctionRebuild, refreshFunctionPanel, drawTimeline } from './panels.js';
import { refreshParticleTree } from './tree.js';
import { rebuildPoints } from '../core/animation.js';
import { gizmoGroup } from '../scene/scene.js';
import { resize } from '../main.js';
import { setPuzzleHost, initPuzzleCanvas, puzzleCanvasRender, puzzleCanvasResize, puzzleCanvasBeginLens, puzzleCanvasCancelEdit } from './puzzle-canvas.js';

export const TYPE_LABEL = { scalar: 'blk.type.scalar', vec: 'blk.type.vec', mat: 'blk.type.mat', any: 'blk.type.any' };
/* —— 积木类别配色 —— */
export const GROUP_COLOR = {
  pos: 'blk-pos', color: 'blk-color', appearance: 'blk-appearance',
  math: 'blk-math', vec: 'blk-vec', mat: 'blk-mat', var: 'blk-var', const: 'blk-const',
  logic: 'blk-logic', array: 'blk-array',
};

/* —— 语句块槽规格（ASCII 名原样显示；中文语义槽用 i18n 键 blk.slot.*） —— */
export const STMT_SLOTS = {
  pos: [['X', T_SCALAR], ['Y', T_SCALAR], ['Z', T_SCALAR]],
  vel: [['vx', T_SCALAR], ['vy', T_SCALAR], ['vz', T_SCALAR]],
  col: [['R', T_SCALAR], ['G', T_SCALAR], ['B', T_SCALAR], ['A', T_SCALAR]],
  scl: [['blk.slot.scale', T_SCALAR]],
  light: [['blk.slot.light', T_SCALAR]],
};
export const BIG_BLOCKS = { pos: true, vel: true };

export const BUILTIN_VAR_INFO = {
  i: 'blk.var.i',
  n: 'blk.var.n',
  t: 'blk.var.t',
};
export const BUILTIN_VAR_NAMES = ['i', 'n', 't'];

export let bctx = null;
export let puzzleWin = null;
export let viewportOrigin = null;

/* =========================================================================
 * 节点工具
 * ======================================================================= */

export function cloneExprNode(n) {
  if (!n) return n;
  const o = { kind: n.kind };
  if (n.kind === 'num') o.value = n.value;
  else if (n.kind === 'bool') o.value = n.value;
  else if (n.kind === 'var') o.name = n.name;
  else if (n.kind === 'func') { o.name = n.name; o.args = n.args.map(cloneExprNode); }
  else if (n.kind === 'op') { o.op = n.op; o.a = cloneExprNode(n.a); o.b = cloneExprNode(n.b); }
  else if (n.kind === 'comp') { o.axis = n.axis; o.target = cloneExprNode(n.target); }
  else if (n.kind === 'neg') { o.a = cloneExprNode(n.a); }
  else if (n.kind === 'not') { o.a = cloneExprNode(n.a); }
  else if (n.kind === 'ternary') { o.cond = cloneExprNode(n.cond); o.a = cloneExprNode(n.a); o.b = cloneExprNode(n.b); }
  else if (n.kind === 'index') { o.target = cloneExprNode(n.target); o.index = cloneExprNode(n.index); }
  else if (n.kind === 'method') { o.obj = cloneExprNode(n.obj); o.method = n.method; o.args = n.args.map(cloneExprNode); }
  else if (n.kind === 'array') { o.items = n.items.map(cloneExprNode); }
  else if (n.kind === 'chain') { o.terms = n.terms.map(cloneExprNode); o.ops = n.ops.slice(); }
  return o;
}
export function cloneStmt(s) {
  const o = { ...s };
  if (s.slots) o.slots = s.slots.map(cloneExprNode);
  if (s.expr) o.expr = cloneExprNode(s.expr);
  if (s.cond) o.cond = cloneExprNode(s.cond);
  if (s.init) o.init = cloneExprNode(s.init);
  if (s.inc) o.inc = cloneExprNode(s.inc);
  if (Array.isArray(s.body)) o.body = s.body.map(cloneStmt);
  if (Array.isArray(s.elseBody)) o.elseBody = s.elseBody.map(cloneStmt);
  if (Array.isArray(s.params)) o.params = s.params.slice();
  return o;
}
export function cloneStmts(stmts) { return stmts.map(cloneStmt); }

export function isBoolOp(op) {
  return op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=' || op === '&&' || op === '||';
}

export function nodeToBlockType(n) {
  switch (n.kind) {
    case 'num': return { cls: 'blk-const', label: fmtNum(n.value) };
    case 'bool': return { cls: 'blk-const blk-bool', label: n.value ? 'true' : 'false' };
    case 'var': return { cls: n.name === 'pi' || n.name === 'e' ? 'blk-const' : 'blk-var', label: n.name };
    case 'func': return { cls: GROUP_COLOR[funcGroup(n.name)], label: n.name };
    case 'op': return { cls: 'blk-math' + (isBoolOp(n.op) ? ' blk-bool' : ''), label: n.op };
    case 'chain': return { cls: 'blk-math', label: t('blk.chain') };
    case 'comp': return { cls: 'blk-vec', label: '.' + n.axis };
    case 'neg': return { cls: 'blk-math', label: '−' };
    case 'not': return { cls: 'blk-math blk-bool', label: '!' };
    case 'ternary': return { cls: 'blk-math', label: '?:' };
    case 'index': return { cls: 'blk-array', label: '[]' };
    case 'method': return { cls: 'blk-array', label: '.' + n.method };
    case 'array': return { cls: 'blk-array', label: '[]' };
    default: return { cls: 'blk-var', label: '?' };
  }
}
export function funcGroup(name) {
  const r = FUNC_BLOCKS[name].ret;
  if (r === T_VEC) return 'vec';
  if (r === T_MAT) return 'mat';
  return 'math';
}
export function blockVarTypeOf(name) {
  if (name === 'i' || name === 'n' || name === 't') return T_SCALAR;
  if (name === 'pi' || name === 'e') return T_SCALAR;
  if (ATTR_NAMES.includes(name)) return T_SCALAR; // 属性（x/y/z/…）是标量
  if (bctx && name in bctx.varExprs) return T_SCALAR;
  return T_ANY;
}
export function availableVars() {
  const out = ['i', 'n', 't'];
  if (bctx) {
    for (const name of bctx.varOrder) if (name in bctx.varExprs && !out.includes(name)) out.push(name);
    const all = [...bctx.chain, ...bctx.setupChain, ...bctx.frags.flatMap(f => f.stmts)];
    for (const t of collectTemps(all)) if (!out.includes(t)) out.push(t);
  }
  return out;
}

/* =========================================================================
 * 槽位引用与查找
 * ======================================================================= */

export function slotRef(get, set, type) { return { get, set, type }; }
export function opSlotType(op, side) {
  if (op === '^' || op === '%') return T_SCALAR;
  if (op === '/') return side === 'r' ? T_SCALAR : T_ANY;
  return T_ANY;
}

export function freshTempName() {
  let k = 0;
  const all = bctx ? [...bctx.chain, ...bctx.setupChain, ...bctx.frags.flatMap(f => f.stmts)] : [];
  const names = new Set(collectTemps(all));
  while (names.has('v' + k)) k++;
  return 'v' + k;
}
export function findAllStmts() {
  const out = [];
  if (bctx) walkStatements([...bctx.chain, ...bctx.setupChain, ...bctx.frags.flatMap(f => f.stmts)], s => out.push(s));
  return out;
}
export function findSlotRefByNode(stmts, node) {
  let result = null;
  const walkExpr = (n, get, set) => {
    if (result) return;
    if (n.kind === 'func') {
      const spec = FUNC_BLOCKS[n.name];
      for (let i = 0; i < n.args.length; i++) {
        const slotType = spec && spec.args[i] ? spec.args[i][1] : T_ANY;
        if (n.args[i] === node) { result = slotRef(() => n.args[i], v => { n.args[i] = v; }, slotType); return; }
        walkExpr(n.args[i], () => n.args[i], v => { n.args[i] = v; });
      }
    } else if (n.kind === 'op') {
      const lt = opSlotType(n.op, 'l'), rt = opSlotType(n.op, 'r');
      if (n.a === node) { result = slotRef(() => n.a, v => { n.a = v; }, lt); return; }
      if (n.b === node) { result = slotRef(() => n.b, v => { n.b = v; }, rt); return; }
      walkExpr(n.a, () => n.a, v => { n.a = v; });
      walkExpr(n.b, () => n.b, v => { n.b = v; });
    } else if (n.kind === 'comp') {
      if (n.target === node) { result = slotRef(() => n.target, v => { n.target = v; }, T_VEC); return; }
      walkExpr(n.target, () => n.target, v => { n.target = v; });
    } else if (n.kind === 'neg') {
      if (n.a === node) { result = slotRef(() => n.a, v => { n.a = v; }, T_ANY); return; }
      walkExpr(n.a, () => n.a, v => { n.a = v; });
    } else if (n.kind === 'chain') {
      for (let i = 0; i < n.terms.length; i++) {
        if (n.terms[i] === node) { result = slotRef(() => n.terms[i], v => { n.terms[i] = v; }, T_ANY); return; }
        walkExpr(n.terms[i], () => n.terms[i], v => { n.terms[i] = v; });
      }
    }
  };
  const walkStmt = (s) => {
    if (result) return;
    if (s.slots) {
      for (let i = 0; i < s.slots.length; i++) {
        const slotType = T_ANY;
        if (s.slots[i] === node) { result = slotRef(() => s.slots[i], v => { s.slots[i] = v; }, slotType); return; }
        if (s.slots[i]) walkExpr(s.slots[i], () => s.slots[i], v => { s.slots[i] = v; });
      }
    }
    if (s.expr) {
      if (s.expr === node) { result = slotRef(() => s.expr, v => { s.expr = v; }, T_ANY); return; }
      walkExpr(s.expr, () => s.expr, v => { s.expr = v; });
    }
    if (s.cond) {
      if (s.cond === node) { result = slotRef(() => s.cond, v => { s.cond = v; }, T_ANY); return; }
      walkExpr(s.cond, () => s.cond, v => { s.cond = v; });
    }
  };
  stmts.forEach(walkStmt);
  return result;
}
export function findExprDetach(node) {
  const found = findSlotRefByNode(findAllStmts(), node);
  if (found) return () => { found.set(defaultExprFor(found.type)); return node; };
  return null;
}
export function removeChainOp(chain, index) {
  chain.ops.splice(index, 1);
  chain.terms.splice(index + 1, 1);
  if (chain.ops.length === 0) {
    const ref = findSlotRefByNode(findAllStmts(), chain);
    if (ref) ref.set(chain.terms[0]);
  }
}

/* =========================================================================
 * 默认值
 * ======================================================================= */

export const N0 = () => ({ kind: 'num', value: 0 });
export const NVEC = () => ({ kind: 'func', name: 'vec', args: [N0(), N0(), N0()] });

export function newStmtNode(kind) {
  switch (kind) {
    case 'pos': return { kind, slots: [N0(), N0(), N0()] };
    case 'vel': return { kind, slots: [N0(), N0(), N0()] };
    case 'col': return { kind, slots: [N0(), N0(), N0(), N0()] };
    case 'scl': return { kind, expr: N0() };
    case 'light': return { kind, expr: N0() };
    case 'glow': return { kind, on: true };
    case 'set': return { kind, name: freshTempName(), expr: N0() };
    case 'attr': return { kind, name: 'x', expr: N0() };
    case 'pos_vec': case 'vel_vec': return { kind, expr: NVEC() };
    case 'if': return { kind: 'if', cond: N0(), body: [], elseBody: null };
    case 'while': return { kind: 'while', cond: N0(), body: [] };
    case 'for': return { kind: 'for', init: 'k = 0', cond: 'k < 10', inc: 'k = k + 1', body: [] };
    case 'do': return { kind: 'do', body: [], cond: N0() };
    case 'func': return { kind: 'func', name: 'f', params: [], body: [] };
    case 'global': case 'static': return { kind, name: 'v0', expr: N0() };
    case 'break': return { kind: 'break' };
    case 'continue': return { kind: 'continue' };
    case 'return': return { kind: 'return', expr: N0() };
    default: throw new Error(_etf('err.unknownStmt', kind));
  }
}
export function newExprNodeFromTemplate(template) {
  if (template.kind === 'num') return { kind: 'num', value: 1 };
  if (template.kind === 'var') return { kind: 'var', name: template.name };
  if (template.kind === 'comp') return { kind: 'comp', axis: 'x', target: NVEC() };
  if (template.kind === 'func') {
    const n = FUNC_BLOCKS[template.name].args.length;
    return { kind: 'func', name: template.name, args: Array.from({ length: n }, () => N0()) };
  }
  if (template.kind === 'op') return { kind: 'op', op: template.op, a: N0(), b: N0() };
  if (template.kind === 'chain') return { kind: 'chain', terms: [N0(), N0()], ops: ['+'] };
  if (template.kind === 'bool') return { kind: 'bool', value: template.value };
  if (template.kind === 'not') return { kind: 'not', a: N0() };
  if (template.kind === 'ternary') return { kind: 'ternary', cond: N0(), a: N0(), b: N0() };
  if (template.kind === 'index') return { kind: 'index', target: N0(), index: N0() };
  if (template.kind === 'method') return { kind: 'method', obj: N0(), method: template.method, args: [] };
  if (template.kind === 'array') return { kind: 'array', items: [N0(), N0()] };
  return N0();
}
export function defaultExprFor(type) {
  if (type === T_VEC) return NVEC();
  if (type === T_MAT) return { kind: 'func', name: 'rotZ', args: [N0()] };
  return N0();
}
export function stmtExprSlotType(s) {
  if (s.kind === 'pos_vec' || s.kind === 'vel_vec') return T_VEC;
  return T_SCALAR;
}

/* =========================================================================
 * 调色板
 * ======================================================================= */

export function funcInfo(name) {
  const f = FUNC_BLOCKS[name];
  const args = (f.args || []).map(a => t(a[0])).join(', ');
  return t(f.desc) + (args ? '（' + args + '）' : '');
}

export function nodeInfo(n) {
  switch (n.kind) {
    case 'num': return t('blk.constNum');
    case 'var': return (BUILTIN_VAR_INFO[n.name] && t(BUILTIN_VAR_INFO[n.name])) || t('blk.var');
    case 'func': return funcInfo(n.name);
    case 'op': return (OP_LABELS[n.op] && t(OP_LABELS[n.op])) || t('blk.op');
    case 'chain': return t('blk.chainDesc');
    case 'comp': return t('blk.compDesc');
    case 'neg': return t('blk.neg');
    default: return '';
  }
}

export function buildPaletteGroup(g) {
  const items = [];
  if (g.id === 'pos') {
    ['pos', 'pos_vec', 'vel', 'vel_vec'].forEach(k => items.push({ key: 'stmt:' + k, type: 'stmt', kind: k, label: t(STMT_BLOCKS[k].label), info: t(STMT_BLOCKS[k].desc) }));
    items.push({ key: 'stmt:attr', type: 'stmt', kind: 'attr', label: t(STMT_BLOCKS.attr.label), info: t(STMT_BLOCKS.attr.desc) });
  } else if (g.id === 'color') {
    items.push({ key: 'stmt:col', type: 'stmt', kind: 'col', label: t(STMT_BLOCKS.col.label), info: t(STMT_BLOCKS.col.desc) });
  } else if (g.id === 'appearance') {
    ['scl', 'glow', 'light'].forEach(k => items.push({ key: 'stmt:' + k, type: 'stmt', kind: k, label: t(STMT_BLOCKS[k].label), info: t(STMT_BLOCKS[k].desc) }));
  } else if (g.id === 'var') {
    items.push({ key: 'stmt:set', type: 'stmt', kind: 'set', label: t(STMT_BLOCKS.set.label), info: t(STMT_BLOCKS.set.desc) });
    for (const name of availableVars()) items.push({ key: 'var:' + name, type: 'expr', template: { kind: 'var', name }, label: name, info: (BUILTIN_VAR_INFO[name] && t(BUILTIN_VAR_INFO[name])) || t('blk.var') });
  } else if (g.id === 'const') {
    items.push({ key: 'expr:num', type: 'expr', template: { kind: 'num', value: 1 }, label: t('blk.type.scalar'), info: t('blk.constNum') });
    items.push({ key: 'expr:pi', type: 'expr', template: { kind: 'var', name: 'pi' }, label: 'pi', info: t('blk.piInfo') });
    items.push({ key: 'expr:e', type: 'expr', template: { kind: 'var', name: 'e' }, label: 'e', info: t('blk.eInfo') });
  } else if (g.id === 'logic') {
    ['if', 'while', 'for', 'do', 'break', 'continue', 'return', 'func', 'global', 'static'].forEach(k => {
      items.push({ key: 'stmt:' + k, type: 'stmt', kind: k, label: t('blk.stmt.' + k), info: t('blk.stmt.' + k) });
    });
    items.push({ key: 'expr:ternary', type: 'expr', template: { kind: 'ternary' }, label: '?:', info: t('blk.ternaryDesc') });
    items.push({ key: 'expr:not', type: 'expr', template: { kind: 'not' }, label: '!', info: t('blk.notDesc') });
    items.push({ key: 'expr:bool:true', type: 'expr', template: { kind: 'bool', value: true }, label: 'true', info: t('blk.constNum') });
    items.push({ key: 'expr:bool:false', type: 'expr', template: { kind: 'bool', value: false }, label: 'false', info: t('blk.constNum') });
    for (const op of ['==', '!=', '<', '<=', '>', '>=', '&&', '||']) {
      items.push({ key: 'expr:op:' + op, type: 'expr', template: { kind: 'op', op }, label: op, info: (OP_LABELS[op] && t(OP_LABELS[op])) || op });
    }
  } else if (g.id === 'math') {
    items.push({ key: 'expr:chain', type: 'expr', template: { kind: 'chain', terms: [{ kind: 'num', value: 0 }, { kind: 'num', value: 0 }], ops: ['+'] }, label: t('blk.chain'), info: t('blk.chainDesc') });
    for (const op of OP_SYMBOLS) items.push({ key: 'opval:' + op, type: 'opval', op, label: op, info: (OP_LABELS[op] && t(OP_LABELS[op])) || op });
    for (const name in FUNC_BLOCKS) {
      const r = FUNC_BLOCKS[name].ret;
      if (r === T_SCALAR && !['vec', 'dot', 'cross', 'len', 'norm'].includes(name)) items.push({ key: 'func:' + name, type: 'expr', template: { kind: 'func', name, args: [] }, label: name, info: funcInfo(name) });
    }
  } else if (g.id === 'vec') {
    ['vec', 'cross', 'norm', 'polar', 'sphere', 'torus', 'dot', 'len'].forEach(name => {
      if (FUNC_BLOCKS[name]) items.push({ key: 'func:' + name, type: 'expr', template: { kind: 'func', name, args: [] }, label: name, info: funcInfo(name) });
    });
    items.push({ key: 'expr:comp', type: 'expr', template: { kind: 'comp', axis: 'x', target: null }, label: t('blk.comp'), info: t('blk.compDesc') });
    items.push({ key: 'expr:array', type: 'expr', template: { kind: 'array' }, label: '[]', info: t('blk.arrayDesc') });
    items.push({ key: 'expr:index', type: 'expr', template: { kind: 'index' }, label: '[ ]', info: t('blk.indexDesc') });
    items.push({ key: 'expr:method:push', type: 'expr', template: { kind: 'method', method: 'push' }, label: '.push()', info: t('blk.methodDesc') });
    items.push({ key: 'expr:method:size', type: 'expr', template: { kind: 'method', method: 'size' }, label: '.size()', info: t('blk.methodDesc') });
  } else if (g.id === 'mat') {
    ['rotX', 'rotY', 'rotZ', 'rotAxis'].forEach(name => items.push({ key: 'func:' + name, type: 'expr', template: { kind: 'func', name, args: [] }, label: name, info: funcInfo(name) }));
  }
  return items;
}

/* =========================================================================
 * 重命名
 * ======================================================================= */

export function renameRefsInAll(oldName, newName) {
  renameRefsInStmts([...bctx.chain, ...bctx.setupChain, ...bctx.frags.flatMap(f => f.stmts)], oldName, newName);
}
export function renameRefsInStmts(stmts, oldName, newName) {
  const walk = (n) => {
    if (!n) return;
    if (n.kind === 'var' && n.name === oldName) n.name = newName;
    if (n.kind === 'func' || n.kind === 'method') n.args.forEach(walk);
    if (n.kind === 'op') { walk(n.a); walk(n.b); }
    if (n.kind === 'comp' || n.kind === 'index') { walk(n.target); if (n.index) walk(n.index); }
    if (n.kind === 'neg' || n.kind === 'not') walk(n.a);
    if (n.kind === 'ternary') { walk(n.cond); walk(n.a); walk(n.b); }
    if (n.kind === 'array') n.items.forEach(walk);
    if (n.kind === 'chain') n.terms.forEach(walk);
  };
  walkStatements(stmts, s => {
    if (s.kind === 'set' && s.name === oldName) s.name = newName;
    if (s.slots) s.slots.forEach(walk);
    if (s.expr) walk(s.expr);
    if (s.cond) walk(s.cond);
    if (s.init) walk(s.init);
    if (s.inc) walk(s.inc);
  });
}

export function renameVarGlobal(oldName, newName) {
  if (oldName in bctx.varExprs) {
    bctx.varExprs[newName] = bctx.varExprs[oldName];
    delete bctx.varExprs[oldName];
    const idx = bctx.varOrder.indexOf(oldName);
    if (idx >= 0) bctx.varOrder[idx] = newName;
  }
  renameRefsInAll(oldName, newName);
}

/* =========================================================================
 * 语句组定位 / 移动
 * ======================================================================= */

function findStmtInList(list, target) {
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (s === target) return { chain: list, index: i };
    if (Array.isArray(s.body)) {
      const r = findStmtInList(s.body, target);
      if (r) return r;
    }
    if (Array.isArray(s.elseBody)) {
      const r = findStmtInList(s.elseBody, target);
      if (r) return r;
    }
  }
  return null;
}
export function stmtGroupLocation(s) {
  if (!bctx) return null;
  for (const chain of [bctx.chain, bctx.setupChain]) {
    const r = findStmtInList(chain, s);
    if (r) return r;
  }
  for (const f of bctx.frags) {
    const r = findStmtInList(f.stmts, s);
    if (r) return r;
  }
  return null;
}
export function detachStmtGroupNow(s) {
  const loc = stmtGroupLocation(s);
  if (!loc) return null;
  return loc.chain.splice(loc.index);
}
export function restoreStmtGroup(loc, group) {
  if (!loc || !loc.chain) return;
  loc.chain.splice(loc.index, 0, ...group);
}

export function canPlaceIntoTarget(slotType, source) {
  if (!source || source.stmt) return false;
  if (source.type === 'palette') {
    if (!source.template) return false;
    return typeAccepts(slotType, exprType(newExprNodeFromTemplate(source.template), blockVarTypeOf));
  }
  if (source.type === 'expr') return typeAccepts(slotType, exprType(source.node, blockVarTypeOf));
  return false;
}

/* =========================================================================
 * 渲染入口（委托 canvas）
 * ======================================================================= */

export function renderPalette() { puzzleCanvasRender(); }
export function renderChain() { puzzleCanvasRender(); }

/* =========================================================================
 * 生命周期
 * ======================================================================= */

function makePuzzleHost() {
  return {
    getBctx: () => bctx,
    pushUndo: () => bctxPushUndo(),
    undo: () => bctxUndo(),
    redo: () => bctxRedo(),
    refreshPreview: () => refreshCodeEcho(),
    commitCount: (fx) => commitFunctionRebuild(fx),
    close: (commit) => closeBlockDrawer(commit),
    newStmtNode: (kind) => newStmtNode(kind),
    newExprNodeFromTemplate: (tpl) => newExprNodeFromTemplate(tpl),
    buildPaletteGroup: (g) => buildPaletteGroup(g),
    availableVars: () => availableVars(),
    funcInfo: (name) => funcInfo(name),
    nodeInfo: (n) => nodeInfo(n),
    blockVarTypeOf: (name) => blockVarTypeOf(name),
    findExprDetach: (node) => findExprDetach(node),
    removeChainOp: (chain, index) => removeChainOp(chain, index),
    stmtGroupLocation: (s) => stmtGroupLocation(s),
    detachStmtGroupNow: (s) => detachStmtGroupNow(s),
    restoreStmtGroup: (loc, group) => restoreStmtGroup(loc, group),
    canPlaceIntoTarget: (slotType, source) => canPlaceIntoTarget(slotType, source),
    renameVarGlobal: (oldName, newName) => renameVarGlobal(oldName, newName),
    renameRefsInAll: (oldName, newName) => renameRefsInAll(oldName, newName),
  };
}

export function ensurePuzzleDom() {
  if (document.getElementById('puzzle-overlay')) return;
  const vp = document.getElementById('viewport');
  viewportOrigin = { parent: vp.parentElement, next: vp.nextSibling };

  const overlay = document.createElement('div');
  overlay.id = 'puzzle-overlay';

  const main = document.createElement('div');
  main.className = 'puzzle-main';
  const palette = document.createElement('div');
  palette.id = 'puzzle-palette';
  const palCanvas = document.createElement('canvas');
  palCanvas.id = 'puzzle-palette-canvas';
  palette.appendChild(palCanvas);
  const palResize = document.createElement('div');
  palResize.id = 'pal-resize';
  const workspace = document.createElement('div');
  workspace.id = 'puzzle-workspace';
  const workCanvas = document.createElement('canvas');
  workCanvas.id = 'puzzle-workspace-canvas';
  workspace.appendChild(workCanvas);
  main.appendChild(palette);
  main.appendChild(palResize);
  main.appendChild(workspace);
  overlay.appendChild(main);
  document.body.appendChild(overlay);

  // 拖拽幽灵层（全屏 canvas，pointer-events:none）
  const ghostCanvas = document.createElement('canvas');
  ghostCanvas.id = 'puzzle-ghost-canvas';
  document.body.appendChild(ghostCanvas);

  // 顶部工具栏
  const toolbar = document.createElement('div');
  toolbar.id = 'puzzle-toolbar';
  const mkBtn = (id, text, cls) => { const b = document.createElement('button'); b.id = id; b.textContent = text; b.className = cls || 'btn'; return b; };
  const title = document.createElement('span'); title.className = 'pz-title'; title.textContent = t('blk.title');
  const fxName = document.createElement('span'); fxName.className = 'pz-fx'; fxName.id = 'puzzle-fx-name';
  const spacer = document.createElement('span'); spacer.className = 'pz-spacer';
  toolbar.appendChild(title); toolbar.appendChild(fxName); toolbar.appendChild(spacer);
  const lensBtn = document.createElement('button');
  lensBtn.id = 'puzzle-lens';
  lensBtn.className = 'pz-lens';
  lensBtn.textContent = '🔍';
  lensBtn.title = t('blk.lensHint');
  lensBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); puzzleCanvasBeginLens(e); });
  toolbar.appendChild(lensBtn);
  toolbar.appendChild(mkBtn('puzzle-ok', t('common.ok'), 'btn bd-ok'));
  toolbar.appendChild(mkBtn('puzzle-cancel', t('common.cancel')));
  document.body.appendChild(toolbar);

  // 场景悬浮窗（右下角）
  const vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
  const sceneWin = makeFloatWindow('fwin-scene', t('blk.scene'), { x: vw - 440, y: vh - 320, w: 420, h: 300, minW: 240, minH: 160, onResize: () => { if (typeof resize === 'function') resize(); } });
  document.body.appendChild(sceneWin.el);

  // 代码回显悬浮窗（默认在场景上方）
  const echoWin = makeFloatWindow('fwin-echo', t('blk.code'), { x: vw - 440, y: vh - 560, w: 340, h: 200, minW: 200, minH: 120 });
  const echoCanvas = document.createElement('canvas');
  echoCanvas.id = 'puzzle-echo-canvas';
  echoWin.body.appendChild(echoCanvas);
  document.body.appendChild(echoWin.el);

  puzzleWin = { scene: sceneWin, echo: echoWin };

  document.getElementById('puzzle-ok').addEventListener('click', () => closeBlockDrawer(true));
  document.getElementById('puzzle-cancel').addEventListener('click', () => closeBlockDrawer(false));

  // 调色盘宽度拖动（分隔条保留为 DOM 控件）
  (function setupPalResize() {
    const handle = document.getElementById('pal-resize');
    const mainEl = document.querySelector('.puzzle-main');
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.classList.add('dragging');
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!handle.classList.contains('dragging')) return;
      const rect = mainEl.getBoundingClientRect();
      let w = e.clientX - rect.left;
      w = Math.max(180, Math.min(500, w));
      mainEl.style.setProperty('--pal-w', w + 'px');
      saveWorkspaceState();
      puzzleCanvasResize();
    });
    handle.addEventListener('pointerup', () => { handle.classList.remove('dragging'); saveWorkspaceState(); });
  })();

  setPuzzleHost(makePuzzleHost());
  initPuzzleCanvas();
}

export function openBlockDrawer(fx) {
  ensurePuzzleDom();
  let chain;
  try { chain = codeToStatements(fx.process || ''); }
  catch (e) { modalAlert(t('blk.openFailTitle'), tf('blk.parseFail', e.message)); return; }
  const varExprs = {};
  const varOrder = [];
  for (const name of Object.keys(fx.vars)) {
    const v = fx.vars[name];
    if ((v.kf || []).length > 0) continue;
    varExprs[name] = Number.isFinite(v.base) ? v.base : 0;
    varOrder.push(name);
  }
  const saved = fx.ui || {};
  bctx = {
    fxId: fx.id,
    chain,
    setupChain: codeToStatements(fx.setup || ''),
    frags: (saved.frags || []).map(f => ({ stmts: codeToStatements(f.code || ''), x: f.x, y: f.y })).filter(f => f.stmts.length > 0),
    varExprs, varOrder,
    snapshot: { setup: fx.setup || '', process: fx.process, vars: cloneVars(fx.vars), preset: fx.preset, params: fx.params },
    undoStack: [], redoStack: [],
    layout: {
      chain: saved.chain || { x: 40, y: 40 },
      setup: saved.setup || { x: 40, y: 120 },
      view: saved.view || { x: 0, y: 0, scale: 1 },
    },
  };
  // 窗口位置状态从 localStorage 工作区恢复
  applyWorkspaceState();

  document.getElementById('puzzle-fx-name').textContent = fx.name || fx.id;
  document.body.classList.add('puzzle-mode');

  const vp = document.getElementById('viewport');
  puzzleWin.scene.body.appendChild(vp);
  if (typeof resize === 'function') resize();
  puzzleCanvasResize();

  // 清除选中，隐藏 gizmo
  state.selected.clear();
  state.selectedGroup = null;
  state.selectedFunction = null;
  if (typeof gizmoGroup !== 'undefined') gizmoGroup.visible = false;

  renderPalette();
  renderChain();
}

export function closeBlockDrawer(commit) {
  if (!bctx) return;
  puzzleCanvasCancelEdit();
  const fx = getFunction(bctx.fxId);
  if (commit && fx) {
    const newCode = statementsToCode(bctx.chain);
    const setupText = statementsToCode(bctx.setupChain);
    fx.process = newCode;
    fx.setup = setupText;
    for (const name of bctx.varOrder) {
      if (name in bctx.varExprs) {
        const v = fx.vars[name];
        if (v && (v.kf || []).length === 0) v.base = Number.isFinite(bctx.varExprs[name]) ? bctx.varExprs[name] : 0;
      }
    }
    if (newCode !== bctx.snapshot.process || setupText !== bctx.snapshot.setup) { fx.preset = null; fx.params = null; }
    pushUndo();
    commitFunctionRebuild(fx);
  } else if (fx) {
    fx.process = bctx.snapshot.process;
    fx.setup = bctx.snapshot.setup;
    fx.vars = cloneVars(bctx.snapshot.vars);
    fx.preset = bctx.snapshot.preset;
    fx.params = bctx.snapshot.params;
    commitFunctionRebuild(fx);
  }
  if (fx) {
    fx.ui = {
      chain: bctx.layout.chain,
      setup: bctx.layout.setup,
      view: bctx.layout.view,
      frags: bctx.frags.filter(f => f.stmts.length > 0).map(f => ({ code: statementsToCode(f.stmts), x: f.x, y: f.y })),
    };
  }
  // 窗口位置状态保存到 localStorage 工作区
  saveWorkspaceState();

  const vp = document.getElementById('viewport');
  if (viewportOrigin && viewportOrigin.parent) {
    if (viewportOrigin.next) viewportOrigin.parent.insertBefore(vp, viewportOrigin.next);
    else viewportOrigin.parent.appendChild(vp);
  }

  document.body.classList.remove('puzzle-mode');
  if (typeof resize === 'function') resize();
  if (typeof drawTimeline === 'function') drawTimeline();

  if (fx) {
    state.selectedFunction = fx.id;
    state.selected.clear();
    state.selectedGroup = null;
    if (typeof rebuildPoints === 'function') rebuildPoints();
    if (typeof refreshParticleTree === 'function') refreshParticleTree();
  }
  bctx = null;
  refreshFunctionPanel();
}

export function refreshCodeEcho() {
  if (!bctx) return;
  puzzleCanvasRender();
  // 实时生效：每次拼图变化后自动预览
  blockPreview();
}

export function blockPreview() {
  if (!bctx) return;
  const fx = getFunction(bctx.fxId);
  if (!fx) return;
  fx.process = statementsToCode(bctx.chain);
  fx.setup = statementsToCode(bctx.setupChain);
  for (const name of bctx.varOrder) {
    if (name in bctx.varExprs) {
      const v = fx.vars[name];
      if (v && (v.kf || []).length === 0) v.base = Number.isFinite(bctx.varExprs[name]) ? bctx.varExprs[name] : 0;
    }
  }
  commitFunctionRebuild(fx);
}

/* =========================================================================
 * 撤销
 * ======================================================================= */

export function bctxPushUndo() {
  if (!bctx) return;
  bctx.undoStack.push(snapBctx());
  if (bctx.undoStack.length > 100) bctx.undoStack.shift();
  bctx.redoStack.length = 0;
}
export function snapBctx() {
  return {
    chain: cloneStmts(bctx.chain),
    setupChain: cloneStmts(bctx.setupChain),
    frags: bctx.frags.map(f => ({ stmts: cloneStmts(f.stmts), x: f.x, y: f.y })),
    varExprs: deepCloneVarExprs(bctx.varExprs),
    chainPos: { x: bctx.layout.chain.x, y: bctx.layout.chain.y },
    setupPos: { x: bctx.layout.setup.x, y: bctx.layout.setup.y },
  };
}
export function restoreBctx(s) {
  bctx.chain = cloneStmts(s.chain);
  bctx.setupChain = cloneStmts(s.setupChain);
  bctx.frags = s.frags.map(f => ({ stmts: cloneStmts(f.stmts), x: f.x, y: f.y }));
  bctx.varExprs = deepCloneVarExprs(s.varExprs);
  bctx.layout.chain = { x: s.chainPos.x, y: s.chainPos.y };
  bctx.layout.setup = { x: s.setupPos.x, y: s.setupPos.y };
}
export function deepCloneVarExprs(o) { const r = {}; for (const k in o) r[k] = o[k]; return r; }
export function bctxUndo() {
  if (!bctx || bctx.undoStack.length === 0) return;
  bctx.redoStack.push(snapBctx());
  restoreBctx(bctx.undoStack.pop());
  renderChain(); renderPalette();
  refreshCodeEcho();
}
export function bctxRedo() {
  if (!bctx || bctx.redoStack.length === 0) return;
  bctx.undoStack.push(snapBctx());
  restoreBctx(bctx.redoStack.pop());
  renderChain(); renderPalette();
  refreshCodeEcho();
}

/* =========================================================================
 * 工作区持久化（localStorage）
 * ======================================================================= */

export const WS_KEY = 'particledrawing.workspace';

export function loadWorkspaceState() {
  try {
    const s = JSON.parse(localStorage.getItem(WS_KEY) || '{}');
    return s || {};
  } catch (e) { return {}; }
}
export function saveWorkspaceState() {
  const s = loadWorkspaceState();
  if (puzzleWin && puzzleWin.scene) {
    s.sceneWin = { x: puzzleWin.scene.x, y: puzzleWin.scene.y, w: puzzleWin.scene.w, h: puzzleWin.scene.h, min: puzzleWin.scene.isMinimized };
    s.echoWin = { x: puzzleWin.echo.x, y: puzzleWin.echo.y, w: puzzleWin.echo.w, h: puzzleWin.echo.h, min: puzzleWin.echo.isMinimized };
  }
  const mainEl = document.querySelector('.puzzle-main');
  if (mainEl) s.paletteWidth = mainEl.style.getPropertyValue('--pal-w') || null;
  const layout = document.querySelector('.layout');
  if (layout) s.particleListWidth = layout.style.getPropertyValue('--left-w') || null;
  if (layout) s.rightPanelWidth = layout.style.getPropertyValue('--right-w') || null;
  let curTlH = '';
  try {
    const bs = document.body && document.body.style;
    if (bs && typeof bs.getPropertyValue === 'function') curTlH = bs.getPropertyValue('--tl-h').trim();
    else if (typeof getComputedStyle === 'function') curTlH = getComputedStyle(document.body).getPropertyValue('--tl-h').trim();
  } catch (_) {}
  if (curTlH) s.tlModuleH = curTlH;
  try { localStorage.setItem(WS_KEY, JSON.stringify(s)); } catch (e) {}
}
export function applyWorkspaceState() {
  const s = loadWorkspaceState();
  const layout = document.querySelector('.layout');
  if (layout && s.particleListWidth) layout.style.setProperty('--left-w', s.particleListWidth);
  if (layout && s.rightPanelWidth) layout.style.setProperty('--right-w', s.rightPanelWidth);
  const mainEl = document.querySelector('.puzzle-main');
  if (mainEl && s.paletteWidth) mainEl.style.setProperty('--pal-w', s.paletteWidth);
  try {
    const bs = document.body && document.body.style;
    if (s.tlModuleH && bs && typeof bs.setProperty === 'function') bs.setProperty('--tl-h', s.tlModuleH);
  } catch (_) {}
  if (puzzleWin && s.sceneWin) {
    puzzleWin.scene.setPos(s.sceneWin.x, s.sceneWin.y);
    puzzleWin.scene.setSize(s.sceneWin.w, s.sceneWin.h);
    if (s.sceneWin.min) puzzleWin.scene.minimize();
  }
  if (puzzleWin && s.echoWin) {
    puzzleWin.echo.setPos(s.echoWin.x, s.echoWin.y);
    puzzleWin.echo.setSize(s.echoWin.w, s.echoWin.h);
    if (s.echoWin.min) puzzleWin.echo.minimize();
  }
}