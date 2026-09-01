/* =========================================================================
 * 拼图代码块 UI（数据流层）
 * 渲染与交互全部委托给 puzzle-canvas.js（canvas），本文件只负责：
 *   - bctx 工作区数据模型与生命周期（open/close/preview/undo）
 *   - 积木数据模型工具（克隆 / 类型 / 调色板 / 查找 / 重命名）
 *   - 工作区持久化（localStorage）
 *   - 悬浮窗（场景 / 代码回显）与顶层 DOM 骨架
 * 依赖 blocks.js、float-window.js、easing.js、constants.js、undo.js、panels.js、generators.js
 * ======================================================================= */

import {_etf, t, tf} from '../core/i18n.js';
import {getFunction, state} from '../core/constants.js';
import {ATTR_NAMES} from '../core/easing.js';
import {modalAlert} from './ui.js';
import {
  BUILTIN_VAR_INFO,
  codeToStatements,
  collectTemps,
  exprType,
  FUNC_BLOCKS,
  METHOD_ARITY,
  N0,
  OP_LABELS,
  OP_SYMBOLS,
  opSlotType,
  slotRef,
  statementsToCode,
  statementsToCodeSpans,
  STMT_BLOCKS,
  T_ANY,
  T_SCALAR,
  T_VEC,
  typeAccepts,
  walkStatements
} from '../core/blocks.js';
import {validateFunctionScript} from '../core/generators.js';
import {makeFloatWindow} from './float-window.js';
import {cloneVars, pushUndo} from '../state/undo.js';
import {commitFunctionRebuild, drawTimeline, refreshFunctionPanel} from './panels.js';
import {rebuildPoints} from '../core/animation.js';
import {gizmoGroup} from '../scene/scene.js';
import {resize} from '../main.js';
import {
  initPuzzleCanvas,
  puzzleCanvasCancelEdit,
  puzzleCanvasRender,
  puzzleCanvasResize,
  setPuzzleHost
} from './puzzle-canvas.js';

export const TYPE_LABEL = { scalar: 'blk.type.scalar', vec: 'blk.type.vec', mat: 'blk.type.mat', any: 'blk.type.any' };

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
  if (s.count) o.count = cloneExprNode(s.count);
  if (Array.isArray(s.body)) o.body = s.body.map(cloneStmt);
  if (Array.isArray(s.elseBody)) o.elseBody = s.elseBody.map(cloneStmt);
  if (Array.isArray(s.params)) o.params = s.params.slice();
  return o;
}
export function cloneStmts(stmts) { return stmts.map(cloneStmt); }

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
    const all = [...bctx.chain, ...bctx.setupChain, ...bctx.frags.flatMap(f => f.stmts), ...bctx.funcs.map(f => f.stmt)];
    for (const t of collectTemps(all)) if (!out.includes(t)) out.push(t);
  }
  return out;
}

/* =========================================================================
 * 槽位引用与查找
 * ======================================================================= */

export function freshTempName() {
  let k = 0;
  const all = bctx ? [...bctx.chain, ...bctx.setupChain, ...bctx.frags.flatMap(f => f.stmts), ...bctx.funcs.map(f => f.stmt)] : [];
  const names = new Set(collectTemps(all));
  while (names.has('v' + k)) k++;
  return 'v' + k;
}
export function freshFuncName() {
  const used = new Set((bctx && bctx.funcs ? bctx.funcs : []).map(f => f.stmt && f.stmt.name).filter(Boolean));
  let n = 1;
  while (used.has('fun' + n)) n++;
  return 'fun' + n;
}
export function customFuncStmt(name) {
  if (!bctx || !Array.isArray(bctx.funcs)) return null;
  for (const f of bctx.funcs) if (f.stmt && f.stmt.name === name) return f.stmt;
  return null;
}
export function customFuncParams(name) {
  const stmt = customFuncStmt(name);
  return stmt && Array.isArray(stmt.params) ? stmt.params : [];
}
export function findAllStmts() {
  const out = [];
  if (bctx) walkStatements([...bctx.chain, ...bctx.setupChain, ...bctx.frags.flatMap(f => f.stmts), ...bctx.funcs.map(f => f.stmt)], s => out.push(s));
  return out;
}
export function findSlotRefByNode(stmts, node) {
  let result = null;
  const walkExpr = (n, get, set) => {
    if (result || !n) return;
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
    } else if (n.kind === 'index') {
      if (n.target === node) { result = slotRef(() => n.target, v => { n.target = v; }, T_ANY); return; }
      if (n.index === node) { result = slotRef(() => n.index, v => { n.index = v; }, T_ANY); return; }
      walkExpr(n.target, () => n.target, v => { n.target = v; });
      walkExpr(n.index, () => n.index, v => { n.index = v; });
    } else if (n.kind === 'method') {
      if (n.obj === node) { result = slotRef(() => n.obj, v => { n.obj = v; }, T_ANY); return; }
      for (let i = 0; i < n.args.length; i++) {
        if (n.args[i] === node) { result = slotRef(() => n.args[i], v => { n.args[i] = v; }, T_ANY); return; }
        walkExpr(n.args[i], () => n.args[i], v => { n.args[i] = v; });
      }
      walkExpr(n.obj, () => n.obj, v => { n.obj = v; });
    } else if (n.kind === 'array') {
      for (let i = 0; i < n.items.length; i++) {
        if (n.items[i] === node) { result = slotRef(() => n.items[i], v => { n.items[i] = v; }, T_ANY); return; }
        walkExpr(n.items[i], () => n.items[i], v => { n.items[i] = v; });
      }
    } else if (n.kind === 'ternary') {
      if (n.cond === node) { result = slotRef(() => n.cond, v => { n.cond = v; }, T_ANY); return; }
      if (n.a === node) { result = slotRef(() => n.a, v => { n.a = v; }, T_ANY); return; }
      if (n.b === node) { result = slotRef(() => n.b, v => { n.b = v; }, T_ANY); return; }
      walkExpr(n.cond, () => n.cond, v => { n.cond = v; });
      walkExpr(n.a, () => n.a, v => { n.a = v; });
      walkExpr(n.b, () => n.b, v => { n.b = v; });
    } else if (n.kind === 'not') {
      if (n.a === node) { result = slotRef(() => n.a, v => { n.a = v; }, T_ANY); return; }
      walkExpr(n.a, () => n.a, v => { n.a = v; });
    }
  };
  const walkStmt = (s) => {
    if (result) return;
    if (s.slots) {
      for (let i = 0; i < s.slots.length; i++) {
        if (s.slots[i] === node) { result = slotRef(() => s.slots[i], v => { s.slots[i] = v; }, T_ANY); return; }
        if (s.slots[i] != null) walkExpr(s.slots[i], () => s.slots[i], v => { s.slots[i] = v; });
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
    if (s.count) {
      if (s.count === node) { result = slotRef(() => s.count, v => { s.count = v; }, T_SCALAR); return; }
      walkExpr(s.count, () => s.count, v => { s.count = v; });
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

export const NVEC = () => ({ kind: 'func', name: 'vec', args: [N0(), N0(), N0()] });

export function newStmtNode(kind) {
  switch (kind) {
    case 'pos': return { kind, slots: [null, null, null] };
    case 'vel': return { kind, slots: [null, null, null] };
    case 'col': return { kind, slots: [null, null, null, null] };
    case 'scl': return { kind, expr: null };
    case 'light': return { kind, expr: null };
    case 'glow': return { kind, on: true };
    case 'set': return { kind, name: freshTempName(), expr: null };
    case 'attr': return { kind, name: 'x', expr: null };
    case 'pos_vec': case 'vel_vec': return { kind, expr: null };
    case 'if': return { kind: 'if', cond: null, body: [], elseBody: null };
    case 'while': return { kind: 'while', cond: null, body: [] };
    case 'for': return { kind: 'for', init: '', cond: '', inc: '', body: [] };
    case 'do': return { kind: 'do', body: [], cond: null };
    case 'repeat': return { kind: 'repeat', body: [] };
    case 'repeat_n': return { kind: 'repeat_n', count: null, body: [] };
    case 'repeat_until': return { kind: 'repeat_until', cond: null, body: [] };
    case 'func': return { kind: 'func', name: freshFuncName(), params: [], body: [] };
    case 'global': case 'static': return { kind, name: '', expr: null };
    case 'comment': return { kind: 'comment', text: '' };
    case 'break': return { kind: 'break' };
    case 'continue': return { kind: 'continue' };
    case 'return': return { kind: 'return', expr: null };
    default: throw new Error(_etf('err.unknownStmt', kind));
  }
}
export function newExprNodeFromTemplate(template) {
  if (template.kind === 'num') return { kind: 'num', value: 1 };
  if (template.kind === 'var') return { kind: 'var', name: template.name };
  if (template.kind === 'comp') return { kind: 'comp', axis: 'x', target: null };
  if (template.kind === 'func') {
    const spec = FUNC_BLOCKS[template.name];
    const n = spec ? spec.args.length : customFuncParams(template.name).length;
    return { kind: 'func', name: template.name, args: Array.from({ length: n }, () => null) };
  }
  if (template.kind === 'op') return { kind: 'op', op: template.op, a: null, b: null };
  if (template.kind === 'chain') return { kind: 'chain', terms: [null, null], ops: ['+'] };
  if (template.kind === 'bool') return { kind: 'bool', value: template.value };
  if (template.kind === 'not') return { kind: 'not', a: null };
  if (template.kind === 'ternary') return { kind: 'ternary', cond: null, a: null, b: null };
  if (template.kind === 'index') return { kind: 'index', target: null, index: null };
  if (template.kind === 'method') return { kind: 'method', obj: null, method: template.method, args: Array.from({ length: METHOD_ARITY[template.method] ?? 0 }, () => null) };
  if (template.kind === 'array') return { kind: 'array', items: [null] };
  return null;
}
export function defaultExprFor(type) {
  // 默认留空：从槽位拖走表达式后槽位回到「未填写」状态。
  return null;
}

/* =========================================================================
 * 调色板
 * ======================================================================= */

export function funcInfo(name) {
  const f = FUNC_BLOCKS[name];
  if (!f) {
    const params = customFuncParams(name);
    return t('blk.customFunc') + ' ' + name + (params.length ? '(' + params.join(', ') + ')' : '()');
  }
  const args = (f.args || []).map(a => t(a[0])).join(', ');
  return t(f.desc) + (args ? '（' + args + '）' : '');
}

// 数组方法帮助文本：优先取 blk.method.<name>.desc，缺失时回退到通用描述。
export function methodInfo(name) {
  const k = 'blk.method.' + name + '.desc';
  const s = t(k);
  return s === k ? t('blk.methodDesc') : s;
}

export function nodeInfo(n) {
  switch (n.kind) {
    case 'num': return t('blk.constNum');
    case 'bool': return t('blk.constNum');
    case 'var': return (BUILTIN_VAR_INFO[n.name] && t(BUILTIN_VAR_INFO[n.name])) || t('blk.var');
    case 'func': return funcInfo(n.name);
    case 'op': return (OP_LABELS[n.op] && t(OP_LABELS[n.op])) || t('blk.op');
    case 'chain': return t('blk.chainDesc');
    case 'comp': return t('blk.compDesc');
    case 'neg': return t('blk.neg');
    case 'not': return t('blk.notDesc');
    case 'ternary': return t('blk.ternaryDesc');
    case 'index': return t('blk.indexDesc');
    case 'method': return methodInfo(n.method);
    case 'array': return t('blk.arrayDesc');
    default: return '';
  }
}

export function buildPaletteGroup(g) {
  const items = [];
  if (g.id === 'start') {
    items.push({ key: 'hat:setup', type: 'hat', kind: 'setup', label: t('blk.setup'), info: t('blk.stmt.setup.desc') });
    items.push({ key: 'hat:process', type: 'hat', kind: 'process', label: t('blk.start'), info: t('blk.stmt.process.desc') });
    items.push({ key: 'hat:func', type: 'hat', kind: 'func', label: t('blk.stmt.func'), info: t('blk.stmt.func.desc') });
  } else if (g.id === 'funcs') {
    for (const f of (bctx && bctx.funcs ? bctx.funcs : [])) {
      const name = f.stmt && f.stmt.name;
      if (!name) continue;
      const params = f.stmt.params || [];
      items.push({ key: 'func:' + name, type: 'expr', template: { kind: 'func', name, args: [] }, label: name + (params.length ? '(' + params.join(', ') + ')' : '()'), info: t('blk.customFunc') + ' ' + name });
      // 每个函数参数生成一个可拖入表达式的变量拼图，便于在函数体内引用参数。
      for (const param of params) {
        items.push({ key: 'func-param:' + name + ':' + param, type: 'expr', template: { kind: 'var', name: param }, label: param, info: tf('blk.funcParam', param) });
      }
    }
  } else if (g.id === 'pos') {
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
    ['if', 'repeat_n', 'repeat', 'repeat_until', 'while', 'do', 'break', 'continue', 'return', 'global', 'static'].forEach(k => {
      items.push({ key: 'stmt:' + k, type: 'stmt', kind: k, label: t(STMT_BLOCKS[k] ? STMT_BLOCKS[k].label : 'blk.stmt.' + k), info: t(STMT_BLOCKS[k] ? STMT_BLOCKS[k].desc : 'blk.stmt.' + k) });
    });
    items.push({ key: 'if-branch:else', type: 'if-branch', branch: 'else', label: t('blk.stmt.else'), info: t('blk.stmt.else.desc') });
    items.push({ key: 'if-branch:else_if', type: 'if-branch', branch: 'else_if', label: t('blk.stmt.else_if'), info: t('blk.stmt.else_if.desc') });
    items.push({ key: 'stmt:comment', type: 'stmt', kind: 'comment', label: t('blk.stmt.comment.label'), info: t('blk.stmt.comment.desc') });
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
    for (const method of Object.keys(METHOD_ARITY)) {
      items.push({ key: 'method:' + method, type: 'method', method, template: { kind: 'method', method }, label: '.' + method + '()', info: methodInfo(method) });
    }
  } else if (g.id === 'mat') {
    ['rotX', 'rotY', 'rotZ', 'rotAxis'].forEach(name => items.push({ key: 'func:' + name, type: 'expr', template: { kind: 'func', name, args: [] }, label: name, info: funcInfo(name) }));
  }
  return items;
}

/* =========================================================================
 * 重命名
 * ======================================================================= */

export function renameRefsInAll(oldName, newName) {
  renameRefsInStmts([...bctx.chain, ...bctx.setupChain, ...bctx.frags.flatMap(f => f.stmts), ...bctx.funcs.map(f => f.stmt)], oldName, newName);
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
    if (s.count) walk(s.count);
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
  for (const f of bctx.funcs) {
    const r = findStmtInList([f.stmt], s);
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

export function hatExists(kind) {
  if (!bctx) return false;
  if (kind === 'setup') return !!bctx.layout.setup;
  if (kind === 'process') return !!bctx.layout.chain;
  if (kind === 'func') return true; // 函数起始块允许存在多个
  return false;
}
export function createHat(kind, x, y) {
  if (!bctx) return false;
  if (kind === 'setup') {
    if (bctx.layout.setup) return false;
    bctx.layout.setup = { x, y };
    return true;
  }
  if (kind === 'process') {
    if (bctx.layout.chain) return false;
    bctx.layout.chain = { x, y };
    return true;
  }
  if (kind === 'func') {
    bctx.funcs.push({ x, y, stmt: newStmtNode('func') });
    return true;
  }
  return false;
}

export function canPlaceIntoTarget(slotType, source) {
  if (!source || source.stmt) return false;
  if (source.type === 'palette') {
    if (!source.template) return false;
    return typeAccepts(slotType, exprType(newExprNodeFromTemplate(source.template), blockVarTypeOf));
  }
  if (source.type === 'expr') return typeAccepts(slotType, exprType(source.node, blockVarTypeOf));
  if (source.type === 'method') {
    const node = newExprNodeFromTemplate(source.template || { kind: 'method', method: source.method });
    return typeAccepts(slotType, exprType(node, blockVarTypeOf));
  }
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
    commitCount: (fx) => commitFunctionRebuild(fx, { silent: true }),
    close: (commit) => closeBlockDrawer(commit),
    newStmtNode: (kind) => newStmtNode(kind),
    newExprNodeFromTemplate: (tpl) => newExprNodeFromTemplate(tpl),
    buildPaletteGroup: (g) => buildPaletteGroup(g),
    availableVars: () => availableVars(),
    funcInfo: (name) => funcInfo(name),
    nodeInfo: (n) => nodeInfo(n),
    blockVarTypeOf: (name) => blockVarTypeOf(name),
    customFuncParams: (name) => customFuncParams(name),
    findExprDetach: (node) => findExprDetach(node),
    removeChainOp: (chain, index) => removeChainOp(chain, index),
    stmtGroupLocation: (s) => stmtGroupLocation(s),
    detachStmtGroupNow: (s) => detachStmtGroupNow(s),
    restoreStmtGroup: (loc, group) => restoreStmtGroup(loc, group),
    canPlaceIntoTarget: (slotType, source) => canPlaceIntoTarget(slotType, source),
    hatExists: (kind) => hatExists(kind),
    createHat: (kind, x, y) => createHat(kind, x, y),
    renameVarGlobal: (oldName, newName) => renameVarGlobal(oldName, newName),
    renameRefsInAll: (oldName, newName) => renameRefsInAll(oldName, newName),
    getErrors: () => (bctx ? (bctx.errors || []) : []),
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

  // 取色器（canvas 浮层）
  const colorCanvas = document.createElement('canvas');
  colorCanvas.id = 'puzzle-color-canvas';
  document.body.appendChild(colorCanvas);

  // 顶部工具栏
  const toolbar = document.createElement('div');
  toolbar.id = 'puzzle-toolbar';
  const mkBtn = (id, text, cls) => { const b = document.createElement('button'); b.id = id; b.textContent = text; b.className = cls || 'btn'; return b; };
  const title = document.createElement('span'); title.className = 'pz-title'; title.textContent = t('blk.title');
  const fxName = document.createElement('span'); fxName.className = 'pz-fx'; fxName.id = 'puzzle-fx-name';
  const spacer = document.createElement('span'); spacer.className = 'pz-spacer';
  toolbar.appendChild(title); toolbar.appendChild(fxName); toolbar.appendChild(spacer);
  toolbar.appendChild(mkBtn('puzzle-ok', t('common.ok'), 'btn bd-ok'));
  toolbar.appendChild(mkBtn('puzzle-cancel', t('common.cancel')));
  document.body.appendChild(toolbar);

  // 场景悬浮窗（右下角）
  const vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
  const sceneWin = makeFloatWindow('fwin-scene', t('blk.scene'), { x: vw - 440, y: vh - 320, w: 420, h: 300, minW: 240, minH: 160, onResize: () => { if (typeof resize === 'function') resize(); } });
  document.body.appendChild(sceneWin.el);

  // 代码回显悬浮窗（默认在场景上方）
  const echoWin = makeFloatWindow('fwin-echo', t('blk.code'), { x: vw - 440, y: vh - 560, w: 340, h: 200, minW: 200, minH: 120, onResize: () => { if (typeof puzzleCanvasResize === 'function') puzzleCanvasResize(); } });
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

function extractTopLevelFuncs(stmts) {
  const funcs = [];
  const rest = [];
  for (const s of stmts) {
    if (s && s.kind === 'func') funcs.push(s);
    else rest.push(s);
  }
  return { funcs, rest };
}

export function openBlockDrawer(fx) {
  ensurePuzzleDom();
  let chain, setupChain, funcStmts;
  try {
    chain = codeToStatements(fx.process || '');
    setupChain = codeToStatements(fx.setup || '');
    funcStmts = codeToStatements(fx.funcs || '');
    // 旧工程可能把 func 误存在 setup/process 内；按规范迁移为顶层函数。
    const cExtract = extractTopLevelFuncs(chain);
    const sExtract = extractTopLevelFuncs(setupChain);
    chain = cExtract.rest;
    setupChain = sExtract.rest;
    funcStmts = funcStmts.concat(cExtract.funcs, sExtract.funcs);
  }
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
  const savedHats = saved.hats || null;
  // 起始块存在性：新格式显式记录；旧格式按「是否有代码 / 是否保存过位置」回退。
  const hasSetup = savedHats ? !!savedHats.setup : (setupChain.length > 0 || !!saved.setup);
  const hasProcess = savedHats ? !!savedHats.process : (chain.length > 0 || !!saved.chain);
  const setupPos = (saved.setup && typeof saved.setup === 'object') ? saved.setup : { x: 40, y: 120 };
  const chainPos = (saved.chain && typeof saved.chain === 'object') ? saved.chain : { x: 40, y: 40 };
  const funcs = funcStmts.map((stmt, i) => {
    const sp = saved.funcs && saved.funcs[i];
    return {
      x: (sp && sp.x != null) ? sp.x : 360,
      y: (sp && sp.y != null) ? sp.y : 40 + i * 40,
      stmt,
    };
  });
  bctx = {
    fxId: fx.id,
    chain,
    setupChain,
    funcs,
    frags: (saved.frags || []).map(f => ({ stmts: codeToStatements(f.code || ''), x: f.x, y: f.y })).filter(f => f.stmts.length > 0),
    varExprs, varOrder,
    errors: [],
    snapshot: { setup: fx.setup || '', process: fx.process || '', funcs: fx.funcs || '', vars: cloneVars(fx.vars), preset: fx.preset, params: fx.params },
    undoStack: [], redoStack: [],
    layout: {
      chain: hasProcess ? chainPos : null,
      setup: hasSetup ? setupPos : null,
      view: saved.view || { x: 0, y: 0, scale: 1 },
    },
  };
  bctx.errors = computeBctxErrors();
  if (bctx.errors.length) fx._error = bctx.errors[0].message;
  else fx._error = null;
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
    const newCode = bctx.layout.chain ? statementsToCode(bctx.chain) : '';
    const setupText = bctx.layout.setup ? statementsToCode(bctx.setupChain) : '';
    const funcsText = statementsToCode(bctx.funcs.map(f => f.stmt));
    fx.process = newCode;
    fx.setup = setupText;
    fx.funcs = funcsText;
    for (const name of bctx.varOrder) {
      if (name in bctx.varExprs) {
        const v = fx.vars[name];
        if (v && (v.kf || []).length === 0) v.base = Number.isFinite(bctx.varExprs[name]) ? bctx.varExprs[name] : 0;
      }
    }
    if (newCode !== bctx.snapshot.process || setupText !== bctx.snapshot.setup || funcsText !== bctx.snapshot.funcs) { fx.preset = null; fx.params = null; }
    pushUndo();
    let err = null;
    try { err = validateFunctionScript(fx, setupText, newCode, funcsText); }
    catch (e) { err = e; }
    if (err) {
      // 保留已保存的代码与错误标记；不重建粒子，避免把半成品渲染写入场景。
      fx._error = err.message;
    } else {
      fx._error = null;
      commitFunctionRebuild(fx, { silent: true });
    }
  } else if (fx) {
    fx.process = bctx.snapshot.process;
    fx.setup = bctx.snapshot.setup;
    fx.funcs = bctx.snapshot.funcs;
    fx.vars = cloneVars(bctx.snapshot.vars);
    fx.preset = bctx.snapshot.preset;
    fx.params = bctx.snapshot.params;
    fx._error = null;
    commitFunctionRebuild(fx, { silent: true });
  }
  if (fx) {
    fx.ui = {
      hats: { setup: !!bctx.layout.setup, process: !!bctx.layout.chain },
      chain: bctx.layout.chain || undefined,
      setup: bctx.layout.setup || undefined,
      view: bctx.layout.view,
      frags: bctx.frags.filter(f => f.stmts.length > 0).map(f => ({ code: statementsToCode(f.stmts), x: f.x, y: f.y })),
      funcs: bctx.funcs.map(f => ({ x: f.x, y: f.y })),
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
  }
  bctx = null;
  refreshFunctionPanel();
}

export function refreshCodeEcho() {
  if (!bctx) return;
  blockPreview();
  puzzleCanvasRender();
}

/* —— 错误定位（把 script-lang 的 line/col 映射回积木） —— */
function lineCountOf(str) { return (str === '') ? 0 : str.split('\n').length; }

function parseErrorLine(msg) {
  const m = /\(line\s+(\d+),\s*col\s+(\d+)\)/.exec(msg || '');
  return m ? { line: parseInt(m[1], 10), col: parseInt(m[2], 10) } : null;
}

function findSpanIn(spans, line) {
  for (const span of (spans || [])) {
    if (line >= span.start && line <= span.end) return span.stmt;
  }
  return null;
}

function mapErrorToStmt(funcsSpans, setupSpans, processSpans, funcsCode, setupCode, processCode, message) {
  const loc = parseErrorLine(message);
  if (!loc) return null;
  const funcsPrefix = funcsCode ? funcsCode + '\n' : '';
  const setupPrefixLines = lineCountOf(funcsPrefix + 'setup {\n') - 1;
  const setupLineCount = lineCountOf(setupCode);
  if (loc.line > setupPrefixLines && loc.line <= setupPrefixLines + setupLineCount) {
    return findSpanIn(setupSpans, loc.line - setupPrefixLines);
  }
  const processPrefixLines = lineCountOf(funcsPrefix + 'setup {\n' + setupCode + '\n}\nprocess {\n') - 1;
  if (loc.line > processPrefixLines) return findSpanIn(processSpans, loc.line - processPrefixLines);
  if (funcsCode && loc.line <= lineCountOf(funcsCode)) return findSpanIn(funcsSpans, loc.line);
  return null;
}

function errorsFromValidation(fx, setupCode, processCode, funcsCode, err) {
  const funcsSpans = statementsToCodeSpans(bctx.funcs.map(f => f.stmt)).spans;
  const setupSpans = statementsToCodeSpans(bctx.setupChain).spans;
  const processSpans = statementsToCodeSpans(bctx.chain).spans;
  const stmt = mapErrorToStmt(funcsSpans, setupSpans, processSpans, funcsCode, setupCode, processCode, err && err.message);
  if (stmt) return [{ stmt, message: err.message }];
  // 没有可定位行号时，仍保留错误并挂到首个可用语句，避免静默吞掉。
  const any = bctx.chain[0] || bctx.setupChain[0] || (bctx.funcs[0] && bctx.funcs[0].stmt);
  return any ? [{ stmt: any, message: err.message }] : [{ message: err.message }];
}

function computeBctxErrors() {
  if (!bctx) return [];
  const fx = getFunction(bctx.fxId);
  if (!fx) return [];
  const setupCode = bctx.layout.setup ? statementsToCode(bctx.setupChain) : '';
  const processCode = bctx.layout.chain ? statementsToCode(bctx.chain) : '';
  const funcsCode = statementsToCode(bctx.funcs.map(f => f.stmt));
  let err = null;
  try { err = validateFunctionScript(fx, setupCode, processCode, funcsCode); }
  catch (e) { err = e; }
  if (!err) return [];
  return errorsFromValidation(fx, setupCode, processCode, funcsCode, err);
}

export function blockPreview() {
  if (!bctx) return;
  const fx = getFunction(bctx.fxId);
  if (!fx) return;
  const code = bctx.layout.chain ? statementsToCode(bctx.chain) : '';
  const setupText = bctx.layout.setup ? statementsToCode(bctx.setupChain) : '';
  const funcsText = statementsToCode(bctx.funcs.map(f => f.stmt));
  fx.process = code;
  fx.setup = setupText;
  fx.funcs = funcsText;
  for (const name of bctx.varOrder) {
    if (name in bctx.varExprs) {
      const v = fx.vars[name];
      if (v && (v.kf || []).length === 0) v.base = Number.isFinite(bctx.varExprs[name]) ? bctx.varExprs[name] : 0;
    }
  }
  let err = null;
  try { err = validateFunctionScript(fx, setupText, code, funcsText); }
  catch (e) { err = e; }
  if (err) {
    fx._error = err.message;
    bctx.errors = errorsFromValidation(fx, setupText, code, funcsText, err);
  } else {
    fx._error = null;
    bctx.errors = [];
    commitFunctionRebuild(fx, { silent: true });
  }
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
    funcs: (bctx.funcs || []).map(f => ({ stmt: cloneStmt(f.stmt), x: f.x, y: f.y })),
    frags: bctx.frags.map(f => ({ stmts: cloneStmts(f.stmts), x: f.x, y: f.y })),
    varExprs: deepCloneVarExprs(bctx.varExprs),
    chainPos: bctx.layout.chain ? { x: bctx.layout.chain.x, y: bctx.layout.chain.y } : null,
    setupPos: bctx.layout.setup ? { x: bctx.layout.setup.x, y: bctx.layout.setup.y } : null,
  };
}
export function restoreBctx(s) {
  bctx.chain = cloneStmts(s.chain);
  bctx.setupChain = cloneStmts(s.setupChain);
  bctx.funcs = (s.funcs || []).map(f => ({ stmt: cloneStmt(f.stmt), x: f.x, y: f.y }));
  bctx.frags = s.frags.map(f => ({ stmts: cloneStmts(f.stmts), x: f.x, y: f.y }));
  bctx.varExprs = deepCloneVarExprs(s.varExprs);
  bctx.layout.chain = s.chainPos ? { x: s.chainPos.x, y: s.chainPos.y } : null;
  bctx.layout.setup = s.setupPos ? { x: s.setupPos.x, y: s.setupPos.y } : null;
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