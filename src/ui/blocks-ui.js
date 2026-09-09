// 拼图代码块 UI（数据流层）。渲染与交互全部交给 puzzle-canvas.js（canvas），这里只管
// bctx 工作区数据模型与生命周期（open/close/preview/undo）、积木数据模型工具（克隆/类型/
// 调色板/查找/重命名）、工作区持久化（localStorage），以及悬浮窗（场景/代码回显）与顶层 DOM 骨架。

import {_etf, t, tf} from '../core/i18n.js';
import { isNarrowLayout } from '../core/device.js';
import {getFunction, state} from '../core/constants.js';
import {modalAlert} from './ui.js';
import {
  ARRAY_METHODS,
  BUILTIN_VAR_INFO,
  CTX_VAR_FIELDS,
  CTX_VAR_INFO,
  FUNC_DROPDOWNS,
  codeToStatements,
  collectTemps,
  exprToCode,
  exprType,
  FUNC_BLOCKS,
  METHOD_ARITY,
  N0,
  OP_LABELS,
  memberCtxKey,
  opSlotType,
  slotRef,
  splitStatements,
  statementsToCode,
  statementsToCodeSpans,
  STMT_BLOCKS,
  stmtComplete,
  T_ANY,
  T_SCALAR,
  T_VEC,
  typeAccepts,
  walkStatements
} from '../core/blocks.js';
import {validateFunctionScript, buildScriptSource} from '../core/generators.js';
import {parseProgram} from '../core/script-lang.js';
import {makeFloatWindow} from './float-window.js';
import {cloneVars, pushUndo} from '../state/undo.js';
import {commitFunctionRebuild, drawTimeline, refreshFunctionPanel} from './panels.js';
import {rebuildPoints} from '../core/animation.js';
import {gizmoGroup} from '../scene/scene.js';
import {resize} from '../main.js';
import {
  initPuzzleCanvas,
  puzzleCanvasCancelEdit,
  puzzleCanvasMeasureChain,
  puzzleCanvasRender,
  puzzleCanvasResize,
  setPuzzleHost
} from './puzzle-canvas.js';

export const TYPE_LABEL = { scalar: 'blk.type.scalar', vec: 'blk.type.vec', mat: 'blk.type.mat', any: 'blk.type.any' };

export let bctx = null;
export let puzzleWin = null;
export let viewportOrigin = null;

// —— 节点工具 ——

export function cloneExprNode(n) {
  if (!n) return n;
  const o = { kind: n.kind };
  if (n.kind === 'num') o.value = n.value;
  else if (n.kind === 'bool') o.value = n.value;
  else if (n.kind === 'var') o.name = n.name;
  else if (n.kind === 'member') { o.obj = cloneExprNode(n.obj); o.field = n.field; }
  else if (n.kind === 'func') { o.name = n.name; o.args = n.args.map(cloneExprNode); }
  else if (n.kind === 'op') { o.op = n.op; o.a = cloneExprNode(n.a); o.b = cloneExprNode(n.b); }
  else if (n.kind === 'comp') { o.axis = n.axis; o.target = cloneExprNode(n.target); }
  else if (n.kind === 'neg') { o.a = cloneExprNode(n.a); }
  else if (n.kind === 'not') { o.a = cloneExprNode(n.a); }
  else if (n.kind === 'ternary') { o.cond = cloneExprNode(n.cond); o.a = cloneExprNode(n.a); o.b = cloneExprNode(n.b); }
  else if (n.kind === 'index') { o.target = cloneExprNode(n.target); o.index = cloneExprNode(n.index); }
  else if (n.kind === 'method') { o.obj = cloneExprNode(n.obj); o.method = n.method; o.args = n.args.map(cloneExprNode); }
  else if (n.kind === 'chaincall') { o.obj = cloneExprNode(n.obj); o.calls = n.calls.map(c => ({ method: c.method, args: c.args.map(cloneExprNode) })); }
  else if (n.kind === 'array') { o.items = n.items.map(cloneExprNode); }
  else if (n.kind === 'chain') { o.terms = n.terms.map(cloneExprNode); o.ops = n.ops.slice(); }
  else if (n.kind === 'lambda') { o.params = n.params ? n.params.slice() : []; o.body = cloneExprNode(n.body); }
  else if (n.kind === 'obj') { o.entries = (n.entries || []).map(e => ({ key: e.key, value: cloneExprNode(e.value) })); }
  else if (n.kind === 'apply') { o.target = cloneExprNode(n.target); o.body = cloneExprNode(n.body); }
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
  if (s.subject) o.subject = cloneExprNode(s.subject);
  if (Array.isArray(s.cases)) o.cases = s.cases.map(c => ({ label: cloneExprNode(c.label), body: (c.body || []).map(cloneStmt) }));
  if (Array.isArray(s.els)) o.els = s.els.map(cloneStmt);
  if (Array.isArray(s.names)) o.names = s.names.slice();
  if (s.value) o.value = cloneExprNode(s.value);
  if (s.config) o.config = cloneExprNode(s.config);
  return o;
}
export function cloneStmts(stmts) { return stmts.map(cloneStmt); }

export function blockVarTypeOf(name) {
  if (name === 'PI' || name === 'E') return T_SCALAR;
  if (bctx && name in bctx.varExprs) return T_SCALAR;
  return T_ANY;
}
export function availableVars() {
  const out = [];
  if (bctx) {
    for (const name of bctx.varOrder) if (name in bctx.varExprs && !out.includes(name)) out.push(name);
    const all = [...bctx.chain, ...bctx.setupChain, ...bctx.tickChain, ...bctx.frags.flatMap(f => f.stmts), ...bctx.funcs.map(f => f.stmt)];
    for (const t of collectTemps(all)) if (!out.includes(t)) out.push(t);
  }
  return out;
}
export function ctxVarTemplate(field) {
  if (field.startsWith('uv.')) return { kind: 'member', obj: { kind: 'member', obj: { kind: 'var', name: 'this' }, field: 'uv' }, field: field.slice(3) };
  return { kind: 'member', obj: { kind: 'var', name: 'this' }, field };
}

/** 数组方法短显示名（中文等按语言显示）。 */
export function methodLabel(name) {
  const k = 'blk.method.' + name + '.label';
  const s = t(k);
  return s === k ? name : s;
}

/** 上下文值短显示名（索引/总数/…）。 */
export function ctxLabel(field) {
  const key = 'this.' + field;
  return (BUILTIN_VAR_INFO[key] && t(BUILTIN_VAR_INFO[key])) || key;
}
export function ctxInfo(field) {
  const key = 'this.' + field;
  return (CTX_VAR_INFO[key] && t(CTX_VAR_INFO[key])) || '';
}

/** 给 puzzle-canvas 构建下拉列表用的条目（value / label / info）。 */
export function funcDropdownItems(group) {
  const spec = FUNC_DROPDOWNS[group];
  if (!spec) return [];
  return spec.funcs.map(name => ({ value: name, label: name, info: funcInfo(name) }));
}
export function arrayDropdownItems() {
  return ARRAY_METHODS.map(m => ({ value: m, label: methodLabel(m), info: methodInfo(m) }));
}
export function ctxDropdownItems() {
  return CTX_VAR_FIELDS.map(f => {
    const value = 'this.' + f;
    return { value, label: ctxLabel(f), info: ctxInfo(f) || ctxLabel(f) };
  });
}

/** 合并函数块：把 func 节点切换为同组内另一个函数，参数多退少补。 */
export function applyFuncSelection(node, name) {
  if (!node || node.kind !== 'func') return false;
  const spec = FUNC_BLOCKS[name];
  const n = spec ? spec.args.length : customFuncParams(name).length;
  const args = (node.args || []).slice(0, n);
  while (args.length < n) args.push(null);
  node.name = name;
  node.args = args;
  return true;
}

/** 数组操作块：把 method 节点切换为另一个数组方法，参数多退少补。 */
export function applyMethodSelection(node, method) {
  if (!node || node.kind !== 'method') return false;
  const n = METHOD_ARITY[method] ?? 0;
  const args = (node.args || []).slice(0, n);
  while (args.length < n) args.push(null);
  node.method = method;
  node.args = args;
  return true;
}

// 用新节点替换表达式树中的旧节点，给上下文等下拉切换用。
export function replaceExprNode(oldNode, newNode) {
  const ref = findSlotRefByNode(findAllStmts(), oldNode);
  if (ref) { ref.set(newNode); return true; }
  return false;
}

// —— 槽位引用与查找 ——

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

// —— 默认值 ——

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
    case 'attr': return { kind, name: 'position.x', expr: null };
    case 'pos_vec': case 'vel_vec': return { kind, expr: null };
    case 'if': return { kind: 'if', cond: null, body: [], elseBody: null };
    case 'while': return { kind: 'while', cond: null, body: [] };
    case 'for': return { kind: 'for', init: '', cond: '', inc: '', body: [] };
    case 'do': return { kind: 'do', body: [], cond: null };
    case 'repeat': return { kind: 'repeat', body: [] };
    case 'repeat_n': return { kind: 'repeat_n', count: null, body: [] };
    case 'repeat_until': return { kind: 'repeat_until', cond: null, body: [] };
    case 'for_of': return { kind: 'for_of', name: 'p', body: [] };
    case 'spawn': return { kind: 'spawn', name: 'p', config: null };
    case 'when': return { kind: 'when', subject: null, cases: [], els: null };
    case 'destructure': return { kind: 'destructure', decl: 'let', names: ['a', 'b'], value: null };
    case 'repeat_fn': return { kind: 'repeat_fn', count: null, body: [] };
    case 'func': return { kind: 'func', name: freshFuncName(), params: [], body: [] };
    case 'global': return { kind: 'global', name: '', expr: null, decl: 'let' };
    case 'const': return { kind: 'global', name: '', expr: null, decl: 'const' };
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
  if (template.kind === 'member') return { kind: 'member', obj: cloneExprNode(template.obj), field: template.field };
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
  if (template.kind === 'chaincall') return { kind: 'chaincall', obj: cloneExprNode(template.obj), calls: template.calls.map(c => ({ method: c.method, args: c.args.map(cloneExprNode) })) };
  return null;
}
export function defaultExprFor(type) {
  // 默认留空：从槽位拖走表达式后槽位回到「未填写」状态。
  return null;
}

// —— 调色板 ——

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
    case 'member': {
      const key = memberCtxKey(n);
      return (CTX_VAR_INFO[key] && t(CTX_VAR_INFO[key])) || t('blk.var');
    }
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
    items.push({ key: 'hat:tick', type: 'hat', kind: 'tick', label: t('blk.tick'), info: t('blk.stmt.tick.desc') });
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
  } else if (g.id === 'props') {
    items.push({ key: 'stmt:spawn', type: 'stmt', kind: 'spawn', label: t(STMT_BLOCKS.spawn.label), info: t(STMT_BLOCKS.spawn.desc) });
    ['pos_vec', 'vel_vec'].forEach(k => items.push({ key: 'stmt:' + k, type: 'stmt', kind: k, label: t(STMT_BLOCKS[k].label), info: t(STMT_BLOCKS[k].desc) }));
    items.push({ key: 'stmt:col', type: 'stmt', kind: 'col', label: t(STMT_BLOCKS.col.label), info: t(STMT_BLOCKS.col.desc) });
    ['scl', 'glow', 'light'].forEach(k => items.push({ key: 'stmt:' + k, type: 'stmt', kind: k, label: t(STMT_BLOCKS[k].label), info: t(STMT_BLOCKS[k].desc) }));
    items.push({ key: 'stmt:attr', type: 'stmt', kind: 'attr', label: t(STMT_BLOCKS.attr.label), info: t(STMT_BLOCKS.attr.desc) });
  } else if (g.id === 'logic') {
    ['if', 'repeat_n', 'repeat', 'repeat_until', 'repeat_fn', 'for_of', 'while', 'do', 'when', 'break', 'continue', 'return', 'global', 'const'].forEach(k => {
      items.push({ key: 'stmt:' + k, type: 'stmt', kind: k, label: t(STMT_BLOCKS[k] ? STMT_BLOCKS[k].label : 'blk.stmt.' + k), info: t(STMT_BLOCKS[k] ? STMT_BLOCKS[k].desc : 'blk.stmt.' + k) });
    });
    items.push({ key: 'if-branch:else', type: 'if-branch', branch: 'else', label: t('blk.stmt.else'), info: t('blk.stmt.else.desc') });
    items.push({ key: 'if-branch:else_if', type: 'if-branch', branch: 'else_if', label: t('blk.stmt.else_if'), info: t('blk.stmt.else_if.desc') });
    items.push({ key: 'stmt:comment', type: 'stmt', kind: 'comment', label: t('blk.stmt.comment.label'), info: t('blk.stmt.comment.desc') });
    items.push({ key: 'expr:ternary', type: 'expr', template: { kind: 'ternary' }, label: '?:', info: t('blk.ternaryDesc') });
    items.push({ key: 'expr:not', type: 'expr', template: { kind: 'not' }, label: '!', info: t('blk.notDesc') });
    items.push({ key: 'expr:bool:true', type: 'expr', template: { kind: 'bool', value: true }, label: t('blk.bool.true'), info: t('blk.constNum') });
    items.push({ key: 'expr:bool:false', type: 'expr', template: { kind: 'bool', value: false }, label: t('blk.bool.false'), info: t('blk.constNum') });
  } else if (g.id === 'math') {
    items.push({ key: 'expr:chain', type: 'expr', template: { kind: 'chain', terms: [{ kind: 'num', value: 0 }, { kind: 'num', value: 0 }], ops: ['+'] }, label: t('blk.chain'), info: t('blk.chainDesc') });
    items.push({ key: 'dd:trig', type: 'func-dd', group: 'trig', selection: 'sin', label: t(FUNC_DROPDOWNS.trig.label), info: t(FUNC_DROPDOWNS.trig.desc) });
    items.push({ key: 'dd:numeric', type: 'func-dd', group: 'numeric', selection: 'sqrt', label: t(FUNC_DROPDOWNS.numeric.label), info: t(FUNC_DROPDOWNS.numeric.desc) });
    items.push({ key: 'dd:clamp', type: 'func-dd', group: 'clamp', selection: 'min', label: t(FUNC_DROPDOWNS.clamp.label), info: t(FUNC_DROPDOWNS.clamp.desc) });
    for (const name of ['pow', 'step', 'smoothstep', 'mod', 'random', 'rand', 'hash', 'norm', 'phases']) {
      if (FUNC_BLOCKS[name]) items.push({ key: 'func:' + name, type: 'expr', template: { kind: 'func', name, args: [] }, label: name, info: funcInfo(name) });
    }
  } else if (g.id === 'vec') {
    ['vec', 'polar', 'sphere', 'torus'].forEach(name => {
      if (FUNC_BLOCKS[name]) items.push({ key: 'func:' + name, type: 'expr', template: { kind: 'func', name, args: [] }, label: name, info: funcInfo(name) });
    });
    items.push({ key: 'expr:chaincall:vec', type: 'expr', template: { kind: 'chaincall', obj: { kind: 'func', name: 'vec', args: [] }, calls: [{ method: 'rotateY', args: [] }, { method: 'rotateX', args: [] }] }, label: t('blk.chaincall'), info: t('blk.chaincall.desc') });
    items.push({ key: 'expr:comp', type: 'expr', template: { kind: 'comp', axis: 'x', target: null }, label: t('blk.comp'), info: t('blk.compDesc') });
  } else if (g.id === 'mat') {
    ['mat3', 'mat4'].forEach(name => items.push({ key: 'func:' + name, type: 'expr', template: { kind: 'func', name, args: [] }, label: name, info: funcInfo(name) }));
  } else if (g.id === 'color') {
    ['color'].forEach(name => {
      if (FUNC_BLOCKS[name]) items.push({ key: 'func:' + name, type: 'expr', template: { kind: 'func', name, args: [] }, label: name, info: funcInfo(name) });
    });
    items.push({ key: 'expr:chaincall:color', type: 'expr', template: { kind: 'chaincall', obj: { kind: 'func', name: 'color', args: [] }, calls: [{ method: 'red', args: [] }, { method: 'alpha', args: [] }] }, label: t('blk.chaincall'), info: t('blk.chaincall.desc') });
  } else if (g.id === 'array') {
    items.push({ key: 'expr:array', type: 'expr', template: { kind: 'array' }, label: '[]', info: t('blk.arrayDesc') });
    items.push({ key: 'expr:index', type: 'expr', template: { kind: 'index' }, label: '[ ]', info: t('blk.indexDesc') });
    items.push({ key: 'dd:array', type: 'method-dd', selection: 'push', label: t('blk.dd.array'), info: t('blk.dd.array.desc') });
  } else if (g.id === 'var') {
    items.push({ key: 'stmt:set', type: 'stmt', kind: 'set', label: t(STMT_BLOCKS.set.label), info: t(STMT_BLOCKS.set.desc) });
    items.push({ key: 'stmt:destructure', type: 'stmt', kind: 'destructure', label: t(STMT_BLOCKS.destructure.label), info: t(STMT_BLOCKS.destructure.desc) });
    items.push({ key: 'dd:context', type: 'ctx-dd', selection: 'this.time', label: t('blk.dd.context'), info: t('blk.dd.context.desc') });
    for (const name of availableVars()) items.push({ key: 'var:' + name, type: 'expr', template: { kind: 'var', name }, label: name, info: t('blk.var') });
  } else if (g.id === 'const') {
    items.push({ key: 'expr:num', type: 'expr', template: { kind: 'num', value: 1 }, label: t('blk.type.scalar'), info: t('blk.constNum') });
    items.push({ key: 'expr:PI', type: 'expr', template: { kind: 'var', name: 'PI' }, label: 'PI', info: t('blk.piInfo') });
    items.push({ key: 'expr:E', type: 'expr', template: { kind: 'var', name: 'E' }, label: 'E', info: t('blk.eInfo') });
  }
  return items;
}

// —— 重命名 ——

export function renameRefsInAll(oldName, newName) {
  renameRefsInStmts([...bctx.chain, ...bctx.setupChain, ...bctx.tickChain, ...bctx.frags.flatMap(f => f.stmts), ...bctx.funcs.map(f => f.stmt)], oldName, newName);
}
export function renameRefsInStmts(stmts, oldName, newName) {
  const walk = (n) => {
    if (!n) return;
    if (n.kind === 'var' && n.name === oldName) n.name = newName;
    if (n.kind === 'func' || n.kind === 'method') n.args.forEach(walk);
    if (n.kind === 'chaincall') { walk(n.obj); n.calls.forEach(c => c.args.forEach(walk)); }
    if (n.kind === 'member') walk(n.obj);
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

// —— 语句组定位 / 移动 ——

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
  if (kind === 'tick') return !!bctx.layout.tick;
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
  if (kind === 'tick') {
    if (bctx.layout.tick) return false;
    bctx.layout.tick = { x, y };
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

// —— 渲染入口（委托 canvas） ——

export function renderPalette() { puzzleCanvasRender(); }
export function renderChain() { puzzleCanvasRender(); }

// —— 生命周期 ——

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
    funcDropdownItems: (group) => funcDropdownItems(group),
    arrayDropdownItems: () => arrayDropdownItems(),
    ctxDropdownItems: () => ctxDropdownItems(),
    methodLabel: (name) => methodLabel(name),
    ctxLabel: (field) => ctxLabel(field),
    applyFuncSelection: (node, name) => applyFuncSelection(node, name),
    applyMethodSelection: (node, method) => applyMethodSelection(node, method),
    replaceExprNode: (oldNode, newNode) => replaceExprNode(oldNode, newNode),
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

  // 顶部工具栏
  const toolbar = document.createElement('div');
  toolbar.id = 'puzzle-toolbar';
  const mkBtn = (id, text, cls) => { const b = document.createElement('button'); b.id = id; b.textContent = text; b.className = cls || 'btn'; return b; };
  const title = document.createElement('span'); title.className = 'pz-title'; title.textContent = t('blk.title');
  const fxName = document.createElement('span'); fxName.className = 'pz-fx'; fxName.id = 'puzzle-fx-name';
  const spacer = document.createElement('span'); spacer.className = 'pz-spacer';
  const paletteToggle = mkBtn('puzzle-palette-toggle', '☰', 'btn pz-palette-toggle');
  paletteToggle.title = t('blk.palette');
  toolbar.appendChild(title); toolbar.appendChild(fxName); toolbar.appendChild(paletteToggle); toolbar.appendChild(spacer);
  toolbar.appendChild(mkBtn('puzzle-ok', t('common.ok'), 'btn bd-ok'));
  toolbar.appendChild(mkBtn('puzzle-cancel', t('common.cancel')));
  document.body.appendChild(toolbar);
  document.getElementById('puzzle-palette-toggle').addEventListener('click', () => {
    document.body.classList.toggle('puzzle-palette-collapsed');
    puzzleCanvasResize();
  });

  // 最小化到顶栏：窗口隐藏后生成一个图标按钮，点击图标恢复。
  const taskbar = document.getElementById('puzzle-toolbar');
  const taskbarSpacer = taskbar ? taskbar.querySelector('.pz-spacer') : null;
  function addTaskIcon(label, restoreFn) {
    const icon = document.createElement('button');
    icon.className = 'puzzle-taskbar-btn';
    icon.textContent = label;
    icon.title = label;
    icon.addEventListener('click', () => restoreFn());
    if (taskbarSpacer) taskbar.insertBefore(icon, taskbarSpacer);
    else if (taskbar) taskbar.appendChild(icon);
    return icon;
  }

  // 场景悬浮窗（右下角）；小屏改为整宽浮层，避免超出视口。
  const vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
  const narrow = isNarrowLayout();
  const sceneW = narrow ? Math.max(260, vw - 16) : 420;
  const sceneH = narrow ? Math.round(vh * 0.38) : 300;
  const sceneX = narrow ? 8 : vw - 440;
  // 小屏时顶部有 44px 的拼图工具栏，窗口不能压住「代码块」标题。
  const sceneY = narrow ? 52 : vh - 320;
  let sceneTaskIcon = null;
  const sceneWin = makeFloatWindow('fwin-scene', t('blk.scene'), {
    x: sceneX, y: sceneY, w: sceneW, h: sceneH, minW: 240, minH: 160, closable: false,
    onResize: () => { if (typeof resize === 'function') resize(); },
    onMinimize: () => { sceneWin.el.style.display = 'none'; if (!sceneTaskIcon) sceneTaskIcon = addTaskIcon(t('blk.scene'), () => sceneWin.restore()); },
    onRestore: () => { sceneWin.el.style.display = ''; if (typeof resize === 'function') resize(); if (sceneTaskIcon) { sceneTaskIcon.remove(); sceneTaskIcon = null; } },
  });
  document.body.appendChild(sceneWin.el);

  // 代码回显悬浮窗（默认在场景上方）
  const echoW = narrow ? Math.max(260, vw - 16) : 340;
  const echoH = narrow ? Math.round(vh * 0.26) : 200;
  const echoX = narrow ? 8 : vw - 440;
  const echoY = narrow ? 52 + sceneH + 8 : vh - 560;
  let echoTaskIcon = null;
  const echoWin = makeFloatWindow('fwin-echo', t('blk.code'), {
    x: echoX, y: echoY, w: echoW, h: echoH, minW: 200, minH: 120, closable: false,
    onResize: () => { if (typeof puzzleCanvasResize === 'function') puzzleCanvasResize(); },
    onMinimize: () => { echoWin.el.style.display = 'none'; if (!echoTaskIcon) echoTaskIcon = addTaskIcon(t('blk.code'), () => echoWin.restore()); },
    onRestore: () => { echoWin.el.style.display = ''; if (typeof puzzleCanvasResize === 'function') puzzleCanvasResize(); if (echoTaskIcon) { echoTaskIcon.remove(); echoTaskIcon = null; } },
  });
  const echoCanvas = document.createElement('canvas');
  echoCanvas.id = 'puzzle-echo-canvas';
  echoWin.body.appendChild(echoCanvas);
  document.body.appendChild(echoWin.el);

  puzzleWin = { scene: sceneWin, echo: echoWin };

  // 小屏默认调色板更窄，给工作区留出空间。
  const mainElForPal = document.querySelector('.puzzle-main');
  if (mainElForPal && narrow) mainElForPal.style.setProperty('--pal-w', Math.round(vw * 0.56) + 'px');

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

function extractFuncBody(src, name) {
  const re = new RegExp('func\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{', 'g');
  const m = re.exec(src);
  if (!m) return '';
  let i = re.lastIndex;
  let depth = 1;
  const start = i;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return src.slice(start, i - 1);
}

// 把 fx.source 解析回拼图所需的 setup/tick/process 语句与自定义函数起始块。
function parsePuzzleSource(fx) {
  const src = fx.source || '';
  const program = parseProgram(src);
  const setupBody = program.setup ? extractFuncBody(src, 'setup') : '';
  const tickBody = program.tick ? extractFuncBody(src, 'tick') : '';
  const processBody = program.process ? extractFuncBody(src, 'process') : '';
  const funcStmts = [];
  for (const [name, fn] of program.functions) {
    const body = extractFuncBody(src, name);
    const stmts = codeToStatements('func ' + name + '(' + fn.params.join(', ') + ') {\n' + body + '\n}');
    if (stmts.length === 1 && stmts[0].kind === 'func') funcStmts.push(stmts[0]);
    else funcStmts.push({ kind: 'func', name, params: fn.params.slice(), body: codeToStatements(body) });
  }
  // 顶层 let/const 声明解析为 global 块，放在 setup 链中（关闭时再提升回顶层）。
  const globals = [];
  for (const stmt of splitStatements(src)) {
    if (!/^(?:global|let|const)\s+/.test(stmt)) continue;
    for (const n of codeToStatements(stmt)) {
      if (n.kind === 'global') globals.push(n);
    }
  }
  return { setupBody, tickBody, processBody, funcStmts, globals };
}

export function openBlockDrawer(fx) {
  ensurePuzzleDom();
  let chain, setupChain, tickChain, funcStmts, globals = [];
  try {
    const parsed = parsePuzzleSource(fx);
    setupChain = codeToStatements(parsed.setupBody);
    tickChain = codeToStatements(parsed.tickBody);
    chain = codeToStatements(parsed.processBody);
    funcStmts = parsed.funcStmts;
    globals = parsed.globals;
    // 兼容：setup/tick/process 体内若混入 func 定义，迁移为顶层函数。
    const cExtract = extractTopLevelFuncs(chain);
    const sExtract = extractTopLevelFuncs(setupChain);
    const tExtract = extractTopLevelFuncs(tickChain);
    chain = cExtract.rest;
    setupChain = [...globals, ...sExtract.rest];
    tickChain = tExtract.rest;
    funcStmts = funcStmts.concat(cExtract.funcs, sExtract.funcs, tExtract.funcs);
    // 迁移旧 per-particle process（this.position/this.color 等）：整体包进 for (const p of this.particles)，
    // 使拼图生成的新代码满足 spawn 模型。
    const PROPERTY_KINDS = new Set(['pos', 'pos_vec', 'vel', 'vel_vec', 'col', 'scl', 'glow', 'light', 'attr']);
    const hasForOf = chain.some(s => s.kind === 'for_of');
    let hasProperty = false;
    walkStatements(chain, s => { if (PROPERTY_KINDS.has(s.kind)) hasProperty = true; });
    if (chain.length && hasProperty && !hasForOf) {
      chain = [{ kind: 'for_of', name: 'p', body: chain }];
    }
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
  const hasSetup = savedHats ? (!!savedHats.setup || globals.length > 0) : (setupChain.length > 0 || !!saved.setup);
  const hasTick = savedHats ? !!savedHats.tick : (tickChain.length > 0 || !!saved.tick);
  const hasProcess = savedHats ? !!savedHats.process : (chain.length > 0 || !!saved.chain);
  // 默认位置：未保存时按前一个起始块的预期宽度向右平铺，避免默认起始块互相遮挡。
  const chainPosDefault = { x: 40, y: 40 };
  const setupPosDefault = (chain.length === 0)
    ? { x: 40, y: 40 }
    : { x: 40 + puzzleCanvasMeasureChain(chain, t('blk.start')).w + 48, y: 40 };
  const tickPosDefault = (chain.length === 0)
    ? { x: 40, y: 40 }
    : { x: 40 + puzzleCanvasMeasureChain(chain, t('blk.start')).w + 48, y: 40 };
  const setupPos = (saved.setup && typeof saved.setup === 'object') ? saved.setup : setupPosDefault;
  const tickPos = (saved.tick && typeof saved.tick === 'object') ? saved.tick : tickPosDefault;
  const chainPos = (saved.chain && typeof saved.chain === 'object') ? saved.chain : chainPosDefault;
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
    tickChain,
    funcs,
    frags: (saved.frags || []).map(f => ({ stmts: codeToStatements(f.code || ''), x: f.x, y: f.y })).filter(f => f.stmts.length > 0),
    varExprs, varOrder,
    errors: [],
    snapshot: { source: fx.source || '', vars: cloneVars(fx.vars), preset: fx.preset, params: fx.params },
    undoStack: [], redoStack: [],
    layout: {
      chain: hasProcess ? chainPos : null,
      setup: hasSetup ? setupPos : null,
      tick: hasTick ? tickPos : null,
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
  state.selectedCamera = null;
  if (typeof gizmoGroup !== 'undefined') gizmoGroup.visible = false;

  renderPalette();
  renderChain();
}

/** 组装与提交一致的完整源码：setup 链中的 global 块提升为顶层 let/const。 */
function buildPuzzleSource() {
  const setupStmts = bctx.layout.setup ? (bctx.setupChain || []) : [];
  const globals = [];
  const setupBody = [];
  for (const s of setupStmts) {
    if (s && s.kind === 'global') globals.push(s);
    else setupBody.push(s);
  }
  const globalsCode = globals.filter(stmtComplete)
    .map(s => (s.decl === 'const' ? 'const ' : 'let ') + s.name + (s.expr ? ' = ' + exprToCode(s.expr, 0) : ''))
    .join('\n');
  const setupCode = bctx.layout.setup ? statementsToCode(setupBody) : '';
  const processCode = bctx.layout.chain ? statementsToCode(bctx.chain) : '';
  const tickCode = bctx.layout.tick ? statementsToCode(bctx.tickChain) : '';
  const funcsCode = statementsToCode(bctx.funcs.map(f => f.stmt));
  const source = buildScriptSource(setupCode, processCode, tickCode, funcsCode, globalsCode);
  return { source, globalsCode, setupBody, setupCode, processCode, funcsCode };
}

export function closeBlockDrawer(commit) {
  if (!bctx) return;
  puzzleCanvasCancelEdit();
  const fx = getFunction(bctx.fxId);
  if (commit && fx) {
    const { source } = buildPuzzleSource();
    fx.source = source;
    for (const name of bctx.varOrder) {
      if (name in bctx.varExprs) {
        const v = fx.vars[name];
        if (v && (v.kf || []).length === 0) v.base = Number.isFinite(bctx.varExprs[name]) ? bctx.varExprs[name] : 0;
      }
    }
    if (source !== bctx.snapshot.source) { fx.preset = null; fx.params = null; }
    pushUndo();
    let err = null;
    try { err = validateFunctionScript(fx, source); }
    catch (e) { err = e; }
    if (err) {
      // 保留已保存的代码与错误标记；不重建粒子，避免把半成品渲染写入场景。
      fx._error = err.message;
    } else {
      fx._error = null;
      commitFunctionRebuild(fx, { silent: true });
    }
  } else if (fx) {
    fx.source = bctx.snapshot.source;
    fx.vars = cloneVars(bctx.snapshot.vars);
    fx.preset = bctx.snapshot.preset;
    fx.params = bctx.snapshot.params;
    fx._error = null;
    commitFunctionRebuild(fx, { silent: true });
  }
  if (fx) {
    fx.ui = {
      hats: { setup: !!bctx.layout.setup, tick: !!bctx.layout.tick, process: !!bctx.layout.chain },
      chain: bctx.layout.chain || undefined,
      setup: bctx.layout.setup || undefined,
      tick: bctx.layout.tick || undefined,
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
    state.selectedCamera = null; // 拼图编辑后选中函数对象，取消摄像机选中
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

// —— 错误定位（把 script-lang 的 line/col 映射回积木） ——
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

function mapErrorToStmt(funcsSpans, setupSpans, processSpans, globalsCode, funcsCode, setupCode, processCode, message) {
  const loc = parseErrorLine(message);
  if (!loc) return null;
  const gl = lineCountOf(globalsCode);
  const funcsPrefix = funcsCode ? funcsCode + '\n' : '';
  const setupPrefixLines = gl + lineCountOf(funcsPrefix + 'setup {\n') - 1;
  const setupLineCount = lineCountOf(setupCode);
  if (loc.line > setupPrefixLines && loc.line <= setupPrefixLines + setupLineCount) {
    return findSpanIn(setupSpans, loc.line - setupPrefixLines);
  }
  const processPrefixLines = gl + lineCountOf(funcsPrefix + 'setup {\n' + setupCode + '\n}\nprocess {\n') - 1;
  if (loc.line > processPrefixLines) return findSpanIn(processSpans, loc.line - processPrefixLines);
  if (funcsCode && loc.line > gl && loc.line <= gl + lineCountOf(funcsCode)) return findSpanIn(funcsSpans, loc.line - gl);
  return null;
}

function errorsFromValidation(fx, globalsCode, setupBody, setupCode, processCode, funcsCode, err) {
  const funcsSpans = statementsToCodeSpans(bctx.funcs.map(f => f.stmt)).spans;
  const setupSpans = statementsToCodeSpans(setupBody).spans;
  const processSpans = statementsToCodeSpans(bctx.chain).spans;
  const stmt = mapErrorToStmt(funcsSpans, setupSpans, processSpans, globalsCode, funcsCode, setupCode, processCode, err && err.message);
  if (stmt) return [{ stmt, message: err.message }];
  // 没有可定位行号时，仍保留错误并挂到首个可用语句，避免静默吞掉。
  const any = bctx.chain[0] || bctx.setupChain[0] || bctx.tickChain[0] || (bctx.funcs[0] && bctx.funcs[0].stmt);
  return any ? [{ stmt: any, message: err.message }] : [{ message: err.message }];
}

function computeBctxErrors() {
  if (!bctx) return [];
  const fx = getFunction(bctx.fxId);
  if (!fx) return [];
  const { source, globalsCode, setupBody, setupCode, processCode, funcsCode } = buildPuzzleSource();
  let err = null;
  try { err = validateFunctionScript(fx, source); }
  catch (e) { err = e; }
  if (!err) return [];
  return errorsFromValidation(fx, globalsCode, setupBody, setupCode, processCode, funcsCode, err);
}

export function blockPreview() {
  if (!bctx) return;
  const fx = getFunction(bctx.fxId);
  if (!fx) return;
  const { source, globalsCode, setupBody, setupCode, processCode, funcsCode } = buildPuzzleSource();
  fx.source = source;
  for (const name of bctx.varOrder) {
    if (name in bctx.varExprs) {
      const v = fx.vars[name];
      if (v && (v.kf || []).length === 0) v.base = Number.isFinite(bctx.varExprs[name]) ? bctx.varExprs[name] : 0;
    }
  }
  let err = null;
  try { err = validateFunctionScript(fx, source); }
  catch (e) { err = e; }
  if (err) {
    fx._error = err.message;
    bctx.errors = errorsFromValidation(fx, globalsCode, setupBody, setupCode, processCode, funcsCode, err);
  } else {
    fx._error = null;
    bctx.errors = [];
    commitFunctionRebuild(fx, { silent: true });
  }
}

// —— 撤销 ——

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
    tickChain: cloneStmts(bctx.tickChain),
    funcs: (bctx.funcs || []).map(f => ({ stmt: cloneStmt(f.stmt), x: f.x, y: f.y })),
    frags: bctx.frags.map(f => ({ stmts: cloneStmts(f.stmts), x: f.x, y: f.y })),
    varExprs: deepCloneVarExprs(bctx.varExprs),
    chainPos: bctx.layout.chain ? { x: bctx.layout.chain.x, y: bctx.layout.chain.y } : null,
    setupPos: bctx.layout.setup ? { x: bctx.layout.setup.x, y: bctx.layout.setup.y } : null,
    tickPos: bctx.layout.tick ? { x: bctx.layout.tick.x, y: bctx.layout.tick.y } : null,
  };
}
export function restoreBctx(s) {
  bctx.chain = cloneStmts(s.chain);
  bctx.setupChain = cloneStmts(s.setupChain);
  bctx.tickChain = cloneStmts(s.tickChain || []);
  bctx.funcs = (s.funcs || []).map(f => ({ stmt: cloneStmt(f.stmt), x: f.x, y: f.y }));
  bctx.frags = s.frags.map(f => ({ stmts: cloneStmts(f.stmts), x: f.x, y: f.y }));
  bctx.varExprs = deepCloneVarExprs(s.varExprs);
  bctx.layout.chain = s.chainPos ? { x: s.chainPos.x, y: s.chainPos.y } : null;
  bctx.layout.setup = s.setupPos ? { x: s.setupPos.x, y: s.setupPos.y } : null;
  bctx.layout.tick = s.tickPos ? { x: s.tickPos.x, y: s.tickPos.y } : null;
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

// —— 工作区持久化（localStorage） ——

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
  if (mainEl && s.paletteWidth) {
    let pw = parseInt(s.paletteWidth, 10);
    if (isNarrowLayout() && pw > window.innerWidth * 0.7) pw = Math.round(window.innerWidth * 0.56);
    if (Number.isFinite(pw) && pw > 0) mainEl.style.setProperty('--pal-w', pw + 'px');
  }
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