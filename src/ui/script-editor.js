import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import {
  StreamLanguage,
  HighlightStyle,
  syntaxHighlighting,
  bracketMatching,
  indentOnInput,
  indentUnit,
  indentService,
} from '@codemirror/language';
import { tags } from '@lezer/highlight';
import {
  autocompletion,
  acceptCompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
} from '@codemirror/autocomplete';
import { indentWithTab, insertNewlineAndIndent, history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { linter } from '@codemirror/lint';
import { highlightSelectionMatches } from '@codemirror/search';
import { parseProgram, parseExpression, ARRAY_METHOD_NAMES } from '../core/script-lang.js';
import { CONSTANTS } from '../core/script/lexical.js';
import { localizeScriptError } from '../core/script-error-i18n.js';

// .pdraw 脚本语言（func setup/tick/process + 自定义函数）的 CodeMirror 编辑器封装：
// 语法高亮 + 自动补全 + 解析错误诊断。fx.source 是唯一源码字段。

export const SCRIPT_KEYWORDS = [
  'this', 'setup', 'process', 'tick', 'func', 'of', 'const', 'let', 'undefined',
  'if', 'else', 'while', 'do', 'for', 'break', 'continue', 'return',
  'true', 'false', 'when',
];

export const SCRIPT_THIS_FIELDS = [
  'time', 'animTime', 'duration', 'particles',
];

const THIS_FIELD_SET = new Set(SCRIPT_THIS_FIELDS);
const THIS_METHOD_SET = new Set(['spawn']);

const PARTICLE_FIELD_TYPES = {
  position: 'vec3', color: 'vec4', velocity: 'vec3', scale: 'num',
  glow: 'bool', light: 'num', life: 'num', index: 'num',
};
const PARTICLE_FIELD_SET = new Set(Object.keys(PARTICLE_FIELD_TYPES));
const PARTICLE_METHODS = ['kill', 'apply'];

export const SCRIPT_BUILTINS = [
  'vec2', 'vec3', 'vec4', 'mat3', 'mat4',
  'norm', 'hash', 'phases', 'repeat',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'sqrt', 'abs', 'sign', 'exp', 'log', 'ln', 'floor', 'ceil', 'round', 'fract', 'pow',
  'min', 'max', 'clamp', 'step', 'smoothstep', 'mod', 'map_range', 'remap', 'int', 'float', 'bool',
  'noise', 'fbm', 'rand', 'random',
  'ease_linear', 'ease_in_out', 'ease_out_back', 'ease_in_elastic',
  'color',
  'unique', 'reverse', 'sort', 'print', 'assert',
];

const KEYWORD_SET = new Set(SCRIPT_KEYWORDS);
const BUILTIN_SET = new Set(SCRIPT_BUILTINS);

export const scriptLanguage = StreamLanguage.define({
  name: 'pdraw-script',
  tokenTable: {
    function: tags.function(tags.variableName),
    itParam: tags.strong,
  },
  startState() {
    return {
      inBlockComment: false, afterDot: false, afterThisDot: false, lastWord: '', afterFunc: false,
      braceDepth: 0, applyStack: [], pendingApply: false,
    };
  },
  token(stream, state) {
    if (state.inBlockComment) {
      if (stream.match('*/')) { state.inBlockComment = false; return 'comment'; }
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.eatSpace()) return null;

    // `.apply` 后的 `{` 打开粒子接收者 lambda，行内空格由 eatSpace 吞掉后此标记仍在。
    const pendingApply = state.pendingApply;
    state.pendingApply = false;

    if (stream.match('//')) { stream.skipToEnd(); return 'comment'; }
    if (stream.match('/*')) { state.inBlockComment = true; return 'comment'; }

    if (stream.peek() === '"') {
      stream.next();
      while (!stream.eol() && stream.peek() !== '"') {
        if (stream.peek() === '\\') stream.next();
        stream.next();
      }
      if (stream.peek() === '"') stream.next();
      return 'string';
    }

    if (stream.match(/^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/)) {
      state.afterDot = false;
      state.afterThisDot = false;
      return 'number';
    }

    if (stream.match(/^(==|!=|<=|>=|&&|\|\||\+\+|--|\+=|-=|\*=|\/=|%=|\^=)/)) {
      state.afterDot = false;
      state.afterThisDot = false;
      return 'operator';
    }

    if (stream.match(/^\{/)) {
      state.braceDepth++;
      if (pendingApply) state.applyStack.push(state.braceDepth);
      state.afterDot = false;
      state.afterThisDot = false;
      state.afterFunc = false;
      return 'operator';
    }
    if (stream.match(/^\}/)) {
      if (state.applyStack.length && state.applyStack[state.applyStack.length - 1] === state.braceDepth) {
        state.applyStack.pop();
      }
      state.braceDepth = Math.max(0, state.braceDepth - 1);
      state.afterDot = false;
      state.afterThisDot = false;
      state.afterFunc = false;
      return 'operator';
    }

    if (stream.match(/^[+\-*/%!?:=<>()[\],;]/)) {
      state.afterDot = false;
      state.afterThisDot = false;
      return 'operator';
    }

    if (stream.match(/^\./)) {
      state.afterDot = true;
      state.afterThisDot = state.lastWord === 'this';
      return 'operator';
    }

    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      const word = stream.current();

      if (state.afterDot) {
        const isThisField = state.afterThisDot;
        state.afterDot = false;
        state.afterThisDot = false;
        state.lastWord = word;
        if (isThisField) return THIS_METHOD_SET.has(word) ? 'function' : 'propertyName';
        if (word === 'apply') {
          state.pendingApply = true;
          return 'function';
        }
        return stream.match(/^\s*\(/, false) ? 'function' : 'propertyName';
      }

      state.lastWord = word;

      // func 关键字后紧跟的函数名（setup/tick/process/自定义函数）按函数名着色。
      if (state.afterFunc) {
        state.afterFunc = false;
        return 'function';
      }
      if (word === 'func') { state.afterFunc = true; return 'keyword'; }
      if (word === 'this') return 'keyword';
      // apply 块内裸名优先解析为粒子字段，按属性着色（但 color(...) 等函数调用仍按函数）。
      if (state.applyStack.length > 0 && PARTICLE_FIELD_SET.has(word) && !stream.match(/^\s*\(/, false)) return 'propertyName';
      // lambda 隐式参数 it 加粗。
      if (word === 'it') return 'itParam';
      if (KEYWORD_SET.has(word)) return 'keyword';
      if (word === 'PI' || word === 'E' || word === 'true' || word === 'false' || word === 'undefined') return 'atom';
      if (BUILTIN_SET.has(word)) return 'function';
      return 'variableName';
    }

    stream.next();
    return null;
  },
});

const PALETTE = {
  bg: '#181a1d',
  gutter: '#181a1d',
  gutterText: '#4e5157',
  text: '#bcbec4',
  keyword: '#cf8e6d',
  string: '#6aab73',
  number: '#2aacb8',
  comment: '#7a7e85',
  function: '#56a8f5',
  variable: '#bcbec4',
  property: '#c77dbb',
  atom: '#cf8e6d',
  operator: '#bcbec4',
  selection: '#373b39',
  activeLine: '#252629',
  tooltipBg: '#2b2d30',
  tooltipText: '#bcbec4',
  tooltipBorder: '#3c3f41',
  tooltipSelected: '#25324d',
  tooltipSelectedText: '#bcbec4',
  highlight: '#548af7',
};

export const scriptHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: PALETTE.keyword },
  { tag: tags.comment, color: PALETTE.comment, fontStyle: 'italic' },
  { tag: tags.string, color: PALETTE.string },
  { tag: tags.number, color: PALETTE.number },
  { tag: tags.operator, color: PALETTE.operator },
  { tag: tags.function(tags.variableName), color: PALETTE.function },
  { tag: tags.variableName, color: PALETTE.variable },
  { tag: tags.strong, color: PALETTE.variable, fontWeight: 'bold' },
  { tag: tags.propertyName, color: PALETTE.property },
  { tag: tags.atom, color: PALETTE.atom },
]);

const scriptTheme = EditorView.theme({
  '&': {
    backgroundColor: PALETTE.bg,
    color: PALETTE.text,
    fontSize: '12px',
  },
  '.cm-editor': { cursor: 'text' },
  '.cm-content': {
    fontFamily: '"SFMono-Regular", Consolas, monospace',
    lineHeight: '1.4',
    caretColor: PALETTE.text,
    padding: '5px 7px',
    cursor: 'text',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: PALETTE.text, borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: PALETTE.selection,
  },
  '.cm-gutters': { backgroundColor: PALETTE.gutter, color: PALETTE.gutterText, border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 6px', minWidth: '24px' },
  '.cm-activeLine': { backgroundColor: PALETTE.activeLine },
  '.cm-activeLineGutter': { backgroundColor: PALETTE.activeLine },
  '.cm-matchingBracket': { backgroundColor: PALETTE.selection, outline: `1px solid ${PALETTE.text}` },
  '.cm-nonmatchingBracket': { backgroundColor: '#f75464' },
  '.cm-selectionMatch': { backgroundColor: `${PALETTE.highlight}40` },
  '.cm-tooltip': {
    backgroundColor: PALETTE.tooltipBg,
    color: PALETTE.tooltipText,
    border: `1px solid ${PALETTE.tooltipBorder}`,
  },
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: PALETTE.tooltipBg,
    color: PALETTE.tooltipText,
  },
  '.cm-tooltip.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: PALETTE.tooltipSelected,
    color: PALETTE.tooltipSelectedText,
  },
  '.cm-completionMatchedText': { color: PALETTE.highlight, textDecoration: 'none' },
  '.cm-completionDetail': { color: PALETTE.comment, fontStyle: 'normal' },
});

/** 统计 [0, endPos) 内未闭合的 `{` 数量（跳过字符串与注释）。 */
function braceDepthIn(doc, endPos) {
  const text = doc.sliceString(0, endPos);
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
  }
  return depth;
}

/** 基于花括号深度的缩进：新行按未闭合 `{` 深度缩进，`}` 行退回一层。 */
export const scriptIndentService = indentService.of((context, pos) => {
  const level = braceDepthIn(context.state.doc, pos)
    - (context.simulatedBreak === pos ? 0 : (/^\s*}/.test(context.lineAt(pos, 1).text) ? 1 : 0));
  return Math.max(0, level * context.unit);
});

/** 从解析错误消息中提取 (line, col)，均为 1 起。 */
export function parseErrorLocation(message) {
  const m = /\(line (\d+), col (\d+)\)$/.exec(message || '');
  if (!m) return null;
  return { line: parseInt(m[1], 10), col: parseInt(m[2], 10) };
}

// —— 轻量类型推断 ——

const THIS_FIELD_TYPES = {
  time: 'num', duration: 'num', particles: 'particleList', spawn: 'func',
};

const VEC_COMPONENTS = {
  vec2: ['x', 'y', 'r', 'g'],
  vec3: ['x', 'y', 'z', 'r', 'g', 'b'],
  vec4: ['x', 'y', 'z', 'w', 'r', 'g', 'b', 'a'],
};

const ARRAY_METHOD_RETURN_TYPES = {
  push: 'array', insert: 'array', remove: 'array', slice: 'array',
  sort: 'array', unique: 'array', reverse: 'array',
  size: 'num', find: 'num', includes: 'bool',
};

const COLOR_COMPONENTS = ['r', 'g', 'b', 'a', 'x', 'y', 'z', 'w'];
const COLOR_METHOD_NAMES = ['toRGB', 'toHSV', 'red', 'green', 'blue', 'alpha', 'hue', 'saturation', 'value', 'shift_hue'];
const VEC_COMMON_METHODS = ['normalize', 'dot', 'len', 'len2', 'dist', 'angleTo', 'project', 'reflect', 'lerp', 'translate', 'scale'];
const VEC3_EXTRA_METHODS = ['cross', 'rotateX', 'rotateY', 'rotateZ'];

const BUILTIN_RETURN_TYPES = {
  vec2: 'vec2', vec3: 'vec3', vec4: 'vec4', vec: 'vec3',
  mat3: 'mat3', mat4: 'mat4',
  norm: 'num', hash: 'num',
  color: 'color',
  sin: 'num', cos: 'num', tan: 'num', asin: 'num', acos: 'num', atan: 'num', atan2: 'num',
  sqrt: 'num', abs: 'num', sign: 'num', exp: 'num', log: 'num', ln: 'num',
  floor: 'num', ceil: 'num', round: 'num', fract: 'num', pow: 'num',
  min: 'num', max: 'num', step: 'num', smoothstep: 'num', mod: 'num',
  map_range: 'num', remap: 'num',
  noise: 'num', fbm: 'num', rand: 'num', random: 'num',
  ease_linear: 'num', ease_in_out: 'num', ease_out_back: 'num', ease_in_elastic: 'num',
  bool: 'bool',
  print: 'num', assert: 'num',
  unique: 'array', reverse: 'array', sort: 'array',
};

const isVecType = (t) => t === 'vec2' || t === 'vec3' || t === 'vec4';
const isMatType = (t) => t === 'mat3' || t === 'mat4';

function inferBinaryType(op, l, r) {
  if (l === 'unknown' || r === 'unknown') return 'unknown';
  if (op === '&&' || op === '||' || op === '<' || op === '<=' || op === '>' || op === '>=' || op === '==' || op === '!=') {
    return 'bool';
  }
  if (op === '+' || op === '-' || op === '*' || op === '/' || op === '%' || op === '^') {
    if (isVecType(l) && isVecType(r)) return l === r ? l : 'unknown';
    if (isVecType(l) && r === 'num') return l;
    if (l === 'num' && isVecType(r)) return r;
    if (isMatType(l) && r === 'num') return l;
    if (l === 'num' && isMatType(r)) return r;
    if (isMatType(l) && isMatType(r)) return l === r ? l : 'unknown';
    if (l === 'num' && r === 'num') return 'num';
  }
  return 'unknown';
}

function inferCallType(node, env) {
  const callee = node.callee;
  if (!callee || callee.type !== 'var') return 'unknown';
  const name = callee.name;

  if (name === 'clamp') {
    return node.args.length ? inferExprType(node.args[0], env) : 'unknown';
  }
  if (name === 'int' || name === 'float') {
    const at = node.args.length ? inferExprType(node.args[0], env) : 'unknown';
    if (at === 'bool') return 'num';
    if (at === 'num' || isVecType(at) || isMatType(at)) return at;
    return 'unknown';
  }
  return BUILTIN_RETURN_TYPES[name] || 'unknown';
}

const VEC_METHOD_RETURN = {
  normalize: 'same', dot: 'num', cross: 'vec3', len: 'num', len2: 'num', dist: 'num',
  angleTo: 'num', project: 'same', reflect: 'same', lerp: 'same',
  rotateX: 'vec3', rotateY: 'vec3', rotateZ: 'vec3', translate: 'same', scale: 'same',
};

function vecMethodReturnType(vecT, method) {
  const r = VEC_METHOD_RETURN[method];
  if (r === 'same') return vecT;
  if (r === 'vec3') return 'vec3';
  if (r === 'num') return 'num';
  return 'unknown';
}

const COLOR_CHANNEL_METHODS = new Set(['red', 'green', 'blue', 'alpha', 'hue', 'saturation', 'value']);

function colorMethodReturnType(method, args) {
  if (method === 'toRGB' || method === 'toHSV') return 'obj';
  if (COLOR_CHANNEL_METHODS.has(method)) return args && args.length >= 1 ? 'color' : 'num';
  if (method === 'shift_hue') return 'color';
  return 'unknown';
}

function inferExprType(node, env) {
  if (!node) return 'unknown';
  switch (node.type) {
    case 'num': return 'num';
    case 'str': return 'string';
    case 'bool': return 'bool';
    case 'array': return 'array';
    case 'var': {
      const t = lookupType(env, node.name);
      if (t != null) return t;
      if (node.name === 'PI' || node.name === 'E') return 'num';
      return 'unknown';
    }
    case 'unary': {
      const t = inferExprType(node.operand, env);
      if (node.op === '!') return 'bool';
      if (node.op === '-') return (t === 'num' || isVecType(t) || isMatType(t)) ? t : 'unknown';
      return 'unknown';
    }
    case 'binary':
      return inferBinaryType(node.op, inferExprType(node.left, env), inferExprType(node.right, env));
    case 'ternary': {
      const a = inferExprType(node.thenExpr, env);
      const b = inferExprType(node.elseExpr, env);
      return a === b ? a : 'unknown';
    }
    case 'call': return inferCallType(node, env);
    case 'lambda': return 'lambda';
    case 'obj': return 'obj';
    case 'apply': return inferExprType(node.target, env);
    case 'method': {
      if (node.object && node.object.type === 'var' && node.object.name === 'this' && node.method === 'spawn') {
        return 'particle';
      }
      const objT = inferExprType(node.object, env);
      if (objT === 'array') return ARRAY_METHOD_RETURN_TYPES[node.method] || 'unknown';
      if (objT === 'particleList') return node.method === 'size' ? 'num' : 'unknown';
      if (isVecType(objT)) return vecMethodReturnType(objT, node.method);
      if (objT === 'color') return colorMethodReturnType(node.method, node.args);
      return 'unknown';
    }
    case 'comp': return 'num';
    case 'member': {
      if (node.object && node.object.type === 'var' && node.object.name === 'this') {
        return THIS_FIELD_TYPES[node.field] || 'unknown';
      }
      const objT = inferExprType(node.object, env);
      if (objT === 'particle') return PARTICLE_FIELD_TYPES[node.field] || 'unknown';
      return 'unknown';
    }
    case 'preinc': case 'postinc': return 'num';
    default: return 'unknown';
  }
}

/** 截掉光标所在的那条未完成语句，并补齐未闭合的 `}`，使剩余代码可被 parseProgram 解析。 */
function truncateIncomplete(code, pos) {
  const text = code == null ? '' : String(code);
  const upto = text.slice(0, Math.max(0, Math.min(pos, text.length)));
  let cut = '';
  for (let i = upto.length - 1; i >= 0; i--) {
    const ch = upto[i];
    if (ch === ';' || ch === '{' || ch === '}' || ch === '\n') { cut = text.slice(0, i + 1); break; }
  }
  if (!cut) return '';
  let depth = 0;
  for (const ch of cut) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  return cut + '}'.repeat(Math.max(0, depth));
}

// —— 作用域链与类型查找 ——

function childScope(scope) {
  const child = new Map();
  child.parent = scope;
  return child;
}

/** 沿作用域链由内向外查找名字类型。 */
function lookupType(scope, name) {
  let cur = scope;
  while (cur) {
    if (cur.has(name)) return cur.get(name);
    cur = cur.parent;
  }
  return null;
}

/** 赋值：沿作用域链更新最近已有绑定；不存在则在当前作用域新建。 */
function assignType(scope, name, type) {
  let cur = scope;
  while (cur) {
    if (cur.has(name)) { cur.set(name, type); return; }
    cur = cur.parent;
  }
  scope.set(name, type);
}

/** 1 起行列号 → 0 起字符偏移。 */
function lineColToOffset(src, line, col) {
  let off = 0;
  let curLine = 1;
  while (curLine < line && off < src.length) {
    if (src[off] === '\n') curLine++;
    off++;
  }
  return off + Math.max(0, (col || 1) - 1);
}

/** 找到 openOffset 处 `{` 的匹配 `}` 偏移（跳过字符串与注释）。 */
function matchingBraceOffset(src, openOffset) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = openOffset; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return src.length;
}

function bodyList(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.body)) return body.body;
  return body ? [body] : [];
}

/** 语句体若为 `{...}` 块，返回其 `{` 偏移，否则 null。 */
function bodyBraceOffset(bodyStmt, src) {
  if (bodyStmt && bodyStmt.type === 'block') return lineColToOffset(src, bodyStmt.line, bodyStmt.col);
  return null;
}

/** 收集顶层 let/const 声明（对象级全局，跨函数可见）。 */
function collectGlobals(decls, globals) {
  for (const d of decls || []) {
    if (!d) continue;
    for (const dec of d.decls || []) {
      globals.set(dec.name, dec.init ? inferExprType(dec.init, globals) : 'unknown');
    }
  }
}

/** 深度优先遍历语句（含嵌套块/分支/循环），对每个语句节点回调一次。 */
function walkStmt(st, visit) {
  if (!st) return;
  visit(st);
  switch (st.type) {
    case 'block':
      for (const s of st.body || []) walkStmt(s, visit);
      return;
    case 'if':
      walkStmt(st.then, visit);
      if (st.els) walkStmt(st.els, visit);
      return;
    case 'while': case 'do':
      walkStmt(st.body, visit);
      return;
    case 'for':
      if (st.init) walkStmt(st.init, visit);
      if (st.inc) walkStmt(st.inc, visit);
      walkStmt(st.body, visit);
      return;
    case 'forof':
      walkStmt(st.body, visit);
      return;
    case 'whenstmt':
      for (const c of st.cases || []) walkStmt(c.body, visit);
      if (st.els) walkStmt(st.els, visit);
      return;
  }
}

/** 收集函数内声明的局部名（含参数），避免跨函数类型推断误写同名全局。 */
function collectLocalDecls(fn, set) {
  for (const p of fn.params || []) set.add(p);
  walkStmt(fn.body, (st) => {
    if (st.type === 'declare') {
      for (const d of st.decls || []) set.add(d.name);
    } else if (st.type === 'destructure') {
      for (const n of st.names || []) set.add(n);
    } else if (st.type === 'forof') {
      set.add(st.name);
    } else if (st.type === 'for' && st.init) {
      if (st.init.type === 'declare') for (const d of st.init.decls || []) set.add(d.name);
      else if (st.init.type === 'assign' && st.init.target && st.init.target.type === 'var') set.add(st.init.target.name);
    }
  });
}

/** 跨函数传播全局变量类型：setup 里 p = this.spawn() 后，process 里 p. 也能补全粒子成员。 */
function collectGlobalAssignTypes(program, globals) {
  const fns = [];
  if (program.setup) fns.push(program.setup);
  if (program.tick) fns.push(program.tick);
  if (program.process) fns.push(program.process);
  for (const fn of program.functions.values()) fns.push(fn);

  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    for (const fn of fns) {
      const locals = new Set();
      collectLocalDecls(fn, locals);
      walkStmt(fn.body, (st) => {
        if (st.type !== 'assign' || !st.target || st.target.type !== 'var') return;
        const name = st.target.name;
        if (!globals.has(name) || locals.has(name)) return;
        const t = inferExprType(st.value, globals);
        const cur = globals.get(name);
        if ((cur == null || cur === 'unknown') && t !== 'unknown') {
          globals.set(name, t);
          changed = true;
        }
      });
    }
    if (!changed) break;
  }
}

/** 光标位于 if/else-if/else 链的哪个分支就进入该分支，否则返回 null。 */
function walkIfAtPos(st, scope, cursor, src) {
  const thenOpen = bodyBraceOffset(st.then, src);
  if (thenOpen != null && thenOpen <= cursor && cursor < matchingBraceOffset(src, thenOpen)) {
    return walkScopeAtPos(bodyList(st.then), childScope(scope), cursor, src);
  }
  const els = st.els;
  if (!els) return null;
  if (els.type === 'if') return walkIfAtPos(els, scope, cursor, src);
  const elseOpen = bodyBraceOffset(els, src);
  if (elseOpen != null && elseOpen <= cursor && cursor < matchingBraceOffset(src, elseOpen)) {
    return walkScopeAtPos(bodyList(els), childScope(scope), cursor, src);
  }
  return null;
}

/** 沿语句顺序推进作用域，找到光标所在的最近作用域；块内局部变量不泄漏到块外。 */
function walkScopeAtPos(stmts, scope, cursor, src) {
  for (const st of stmts) {
    if (!st) continue;
    const start = lineColToOffset(src, st.line, st.col);
    if (start > cursor) break;

    if (st.type === 'declare') {
      for (const d of st.decls) {
        assignType(scope, d.name, d.init ? inferExprType(d.init, scope) : 'unknown');
      }
    } else if (st.type === 'assign' && st.target && st.target.type === 'var') {
      assignType(scope, st.target.name, inferExprType(st.value, scope));
    } else if (st.type === 'block') {
      if (cursor < matchingBraceOffset(src, start)) {
        return walkScopeAtPos(st.body, childScope(scope), cursor, src);
      }
    } else if (st.type === 'forof') {
      const child = childScope(scope);
      child.set(st.name, inferExprType(st.iter, scope) === 'particleList' ? 'particle' : 'unknown');
      const open = bodyBraceOffset(st.body, src);
      if (open != null && open <= cursor && cursor < matchingBraceOffset(src, open)) {
        return walkScopeAtPos(bodyList(st.body), child, cursor, src);
      }
    } else if (st.type === 'for') {
      const child = childScope(scope);
      if (st.init && st.init.type === 'declare') {
        for (const d of st.init.decls) {
          child.set(d.name, d.init ? inferExprType(d.init, child) : 'unknown');
        }
      } else if (st.init && st.init.type === 'assign' && st.init.target && st.init.target.type === 'var') {
        child.set(st.init.target.name, inferExprType(st.init.value, child));
      }
      const open = bodyBraceOffset(st.body, src);
      if (open != null && open <= cursor && cursor < matchingBraceOffset(src, open)) {
        return walkScopeAtPos(bodyList(st.body), child, cursor, src);
      }
    } else if (st.type === 'while' || st.type === 'do') {
      const open = bodyBraceOffset(st.body, src);
      if (open != null && open <= cursor && cursor < matchingBraceOffset(src, open)) {
        return walkScopeAtPos(bodyList(st.body), childScope(scope), cursor, src);
      }
    } else if (st.type === 'if') {
      const inside = walkIfAtPos(st, scope, cursor, src);
      if (inside) return inside;
    }
  }
  return scope;
}

/** 解析源码（必要时截断未完成语句），返回光标处可见的作用域链。 */
function buildScriptEnvs(fx, pos) {
  const src = (fx && fx.source) || '';
  const code = pos != null ? truncateIncomplete(src, pos) : src;
  let program;
  try {
    program = parseProgram(code);
  } catch {
    return new Map();
  }

  const globals = new Map();
  collectGlobals(program.globals, globals);
  collectGlobalAssignTypes(program, globals);

  const root = new Map(globals);
  root.set('PI', 'num');
  root.set('E', 'num');
  for (const name of Object.keys(fx?.vars || {})) root.set(name, 'num');

  if (pos == null) return root;

  const cursor = Math.max(0, Math.min(pos, src.length));
  const fnName = enclosingFuncName(src, cursor);
  const fn = program.setup && program.setup.name === fnName ? program.setup
    : program.tick && program.tick.name === fnName ? program.tick
    : program.process && program.process.name === fnName ? program.process
    : program.functions.get(fnName);
  if (!fn) return root;

  for (const p of fn.params || []) root.set(p, 'unknown');
  return walkScopeAtPos(fn.body.body, root, cursor, src);
}

/** 找到光标所在的顶层函数名（setup/tick/process/自定义函数）。 */
function enclosingFuncName(src, pos) {
  const upto = String(src || '').slice(0, Math.max(0, Math.min(pos, String(src || '').length)));
  const re = /func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m, last = null;
  while ((m = re.exec(upto))) last = m[1];
  return last;
}

/** 统计光标前未闭合的 apply 块层数（`.apply { … }`），供其内裸名粒子字段补全使用。 */
function applyLambdaDepthAt(src, pos) {
  const n = Math.min(pos, src.length);
  let braceDepth = 0;
  const applyStack = [];
  let pendingApply = false;
  let afterDot = false;
  let inBlockComment = false;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (inBlockComment) {
      if (c === '*' && src[i + 1] === '/') { inBlockComment = false; i += 2; }
      else i++;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { inBlockComment = true; i += 2; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '{') {
      braceDepth++;
      if (pendingApply) { applyStack.push(braceDepth); pendingApply = false; }
      afterDot = false;
      i++;
      continue;
    }
    if (c === '}') {
      if (applyStack.length && applyStack[applyStack.length - 1] === braceDepth) applyStack.pop();
      braceDepth = Math.max(0, braceDepth - 1);
      afterDot = false;
      i++;
      continue;
    }
    if (c === '.') { afterDot = true; i++; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      let w = '';
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) { w += src[j]; j++; }
      if (afterDot) {
        if (w === 'apply') pendingApply = true;
        afterDot = false;
      }
      i = j;
      continue;
    }
    pendingApply = false;
    afterDot = false;
    i++;
  }
  return applyStack.length;
}

/** 从光标前文本中定位成员访问的接收者表达式起点（支持 p.color / vec3(...) 等链式）。 */
function receiverStart(before, dotIndex) {
  let depth = 0;
  let i = dotIndex - 1;
  while (i >= 0 && /\s/.test(before[i])) i--;
  for (; i >= 0; i--) {
    const c = before[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') {
      if (depth === 0) return i + 1;
      depth--;
    } else if (depth === 0) {
      if (c === ';' || c === ',' || '=+-*/%<>!&|^?:'.includes(c)) return i + 1;
      if (c === '\n') {
        let j = i + 1;
        while (j < before.length && /\s/.test(before[j])) j++;
        if (before[j] !== '.') return i + 1; // 新行不是 . 续行，即上一条语句结束
      }
    }
  }
  return 0;
}

/** 解析接收者表达式文本并推断其类型。 */
function resolveReceiverType(receiverText, fx, pos) {
  const scope = buildScriptEnvs(fx, pos);
  let node;
  try {
    node = parseExpression(receiverText);
  } catch {
    return 'unknown';
  }
  return inferExprType(node, scope);
}

function vecMethodsForType(type) {
  return type === 'vec3' ? [...VEC_COMMON_METHODS, ...VEC3_EXTRA_METHODS] : VEC_COMMON_METHODS;
}

/** 依接收者类型给出成员补全项；无成员可补时返回 null。 */
function memberOptionsForType(type) {
  if (type === 'array') {
    return ARRAY_METHOD_NAMES.map((m) => ({ label: m, type: 'method', detail: 'array' }));
  }
  if (type === 'particleList') {
    return [{ label: 'size', type: 'method', detail: 'particle list' }];
  }
  if (type === 'particle') {
    return [
      ...Object.keys(PARTICLE_FIELD_TYPES).map((f) => ({ label: f, type: 'property', detail: 'particle' })),
      ...PARTICLE_METHODS.map((m) => ({ label: m, type: 'method', detail: 'particle' })),
    ];
  }
  if (VEC_COMPONENTS[type]) {
    return [
      ...VEC_COMPONENTS[type].map((c) => ({ label: c, type: 'property', detail: type })),
      ...vecMethodsForType(type).map((m) => ({ label: m, type: 'method', detail: type })),
    ];
  }
  if (type === 'color') {
    return [
      ...COLOR_COMPONENTS.map((c) => ({ label: c, type: 'property', detail: 'color' })),
      ...COLOR_METHOD_NAMES.map((m) => ({ label: m, type: 'method', detail: 'color' })),
    ];
  }
  return null;
}

/** 自动补全：关键字 + 内置函数 + this 字段 + 粒子/向量/颜色/数组成员 + 代码中已出现的标识符。 */
export function scriptCompletionSource(fx) {
  return (context) => {
    const before = context.state.sliceDoc(0, context.pos);

    const lastChar = before.slice(-1);
    if (lastChar === ';' || lastChar === '\n' || lastChar === '{' || lastChar === '}' || lastChar === ')' || lastChar === ' ') return null;

    // 成员访问：receiver.member 或 receiver. （含 this. / p.color. / vec3(...). 等链式）
    const memberM = /\.\s*([A-Za-z_][A-Za-z0-9_]*)?$/.exec(before);
    if (memberM) {
      const partial = memberM[1] || '';
      const dotIndex = before.length - memberM[0].length;
      const receiverText = before.slice(receiverStart(before, dotIndex), dotIndex).trim();

      if (receiverText === 'this') {
        return {
          from: context.pos - partial.length,
          options: [
            ...SCRIPT_THIS_FIELDS.map((name) => ({ label: name, type: 'property', detail: 'this' })),
            ...['spawn'].map((name) => ({ label: name, type: 'method', detail: 'this' })),
          ],
          validFor: /^\w*$/,
        };
      }

      const options = memberOptionsForType(resolveReceiverType(receiverText, fx, context.pos));
      if (!options) return null;
      return { from: context.pos - partial.length, options, validFor: /^\w*$/ };
    }

    // 普通标识符 / 关键字补全
    const word = context.matchBefore(/[\w.]*/);
    const from = word ? word.from : context.pos;

    const options = [];
    const seen = new Set();
    // apply 块内裸名即粒子字段，优先给出。
    if (applyLambdaDepthAt(before, before.length) > 0) {
      for (const f of PARTICLE_FIELD_SET) {
        seen.add(f);
        options.push({ label: f, type: 'property', detail: 'particle' });
      }
    }
    for (const kw of SCRIPT_KEYWORDS) if (!seen.has(kw)) { seen.add(kw); options.push({ label: kw, type: 'keyword' }); }
    for (const fn of SCRIPT_BUILTINS) if (!seen.has(fn)) { seen.add(fn); options.push({ label: fn, type: 'function', detail: 'builtin' }); }
    for (const name of Object.keys(fx?.vars || {})) if (!seen.has(name)) { seen.add(name); options.push({ label: name, type: 'variable', detail: 'var' }); }

    const doc = context.state.doc.toString();
    for (const m of doc.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      const name = m[0];
      if (!seen.has(name) && !BUILTIN_SET.has(name) && !KEYWORD_SET.has(name) && !THIS_FIELD_SET.has(name)) {
        seen.add(name);
        options.push({ label: name, type: 'variable' });
      }
    }

    return { from, options, validFor: /^\w*$/ };
  };
}

/** 静态作用域诊断：未声明变量 / const 重新赋值 / 重复声明（英文源文，展示前走 localizeScriptError）。 */
export function staticScriptDiagnostics(program, fx) {
  const diags = [];
  const globalNames = new Set();
  const globalConst = new Set();
  for (const d of program.globals || []) {
    for (const dec of d.decls || []) {
      globalNames.add(dec.name);
      if (d.kind === 'const') globalConst.add(dec.name);
    }
  }
  const varNames = new Set(Object.keys(fx?.vars || {}));
  const funcNames = new Set(program.functions.keys());
  const known = (name) => CONSTANTS.has(name) || BUILTIN_SET.has(name) || varNames.has(name) || globalNames.has(name);

  function Scope(parent) { this.names = new Map(); this.parent = parent || null; }
  Scope.prototype.lookup = function (name) {
    for (let s = this; s; s = s.parent) if (s.names.has(name)) return s.names.get(name);
    return null;
  };

  function expr(node, scope) {
    if (!node) return;
    switch (node.type) {
      case 'var': {
        if (node.name !== 'this' && !scope.lookup(node.name) && !known(node.name) && !funcNames.has(node.name)) {
          diags.push({ line: node.line, col: node.col, msg: `unknown variable '${node.name}'` });
        }
        return;
      }
      case 'unary': expr(node.operand, scope); return;
      case 'binary': expr(node.left, scope); expr(node.right, scope); return;
      case 'ternary': expr(node.cond, scope); expr(node.thenExpr, scope); expr(node.elseExpr, scope); return;
      case 'index': expr(node.target, scope); expr(node.index, scope); return;
      case 'comp': expr(node.target, scope); return;
      case 'member':
        if (!(node.object.type === 'var' && node.object.name === 'this')) expr(node.object, scope);
        return;
      case 'call': expr(node.callee, scope); node.args.forEach((a) => expr(a, scope)); return;
      case 'method': expr(node.object, scope); node.args.forEach((a) => expr(a, scope)); return;
      case 'array': node.items.forEach((it) => expr(it, scope)); return;
      case 'preinc': case 'postinc': checkAssignTarget(node.target, scope); return;
      case 'num': case 'str': case 'bool': case 'undefined': return;
    }
  }

  function checkAssignTarget(target, scope) {
    if (target.type === 'var') {
      if (target.name === 'this') return;
      const kind = scope.lookup(target.name);
      if (kind === 'const') diags.push({ line: target.line, col: target.col, msg: `cannot assign to const '${target.name}'` });
      else if (!kind && !known(target.name)) diags.push({ line: target.line, col: target.col, msg: `undeclared variable '${target.name}'` });
    } else if (target.type === 'comp') {
      expr(target.target, scope);
    } else if (target.type === 'index') {
      expr(target.target, scope); expr(target.index, scope);
    } else if (target.type === 'member') {
      if (!(target.object.type === 'var' && target.object.name === 'this')) expr(target.object, scope);
    } else if (target.type === 'unpack') {
      for (const n of target.names) {
        const kind = scope.lookup(n);
        if (kind === 'const') diags.push({ line: target.line, col: target.col, msg: `cannot assign to const '${n}'` });
        else if (!kind && !known(n)) diags.push({ line: target.line, col: target.col, msg: `undeclared variable '${n}'` });
      }
    }
  }

  function stmt(node, scope) {
    if (!node) return;
    switch (node.type) {
      case 'block': {
        const s = new Scope(scope);
        for (const st of node.body) stmt(st, s);
        return;
      }
      case 'declare': {
        for (const d of node.decls) {
          if (scope.names.has(d.name)) {
            diags.push({ line: d.line, col: d.col, msg: `duplicate declaration '${d.name}'` });
          }
          scope.names.set(d.name, node.kind);
          if (d.init) expr(d.init, scope);
        }
        return;
      }
      case 'assign': expr(node.value, scope); checkAssignTarget(node.target, scope); return;
      case 'expr': expr(node.expr, scope); return;
      case 'if': expr(node.cond, scope); stmt(node.then, scope); if (node.els) stmt(node.els, scope); return;
      case 'while': expr(node.cond, scope); stmt(node.body, scope); return;
      case 'do': stmt(node.body, scope); expr(node.cond, scope); return;
      case 'for': {
        const s = new Scope(scope);
        if (node.init) stmt(node.init, s);
        if (node.cond) expr(node.cond, s);
        if (node.inc) stmt(node.inc, s);
        stmt(node.body, s);
        return;
      }
      case 'forof': {
        const s = new Scope(scope);
        s.names.set(node.name, node.kind === 'const' ? 'const' : 'let');
        expr(node.iter, scope);
        stmt(node.body, s);
        return;
      }
      case 'return': if (node.expr) expr(node.expr, scope); return;
      case 'break': case 'continue': return;
    }
  }

  {
    const s = new Scope(null);
    for (const d of program.globals || []) {
      for (const dec of d.decls || []) if (dec.init) expr(dec.init, s);
    }
  }
  for (const fn of [program.setup, program.tick, program.process]) {
    if (!fn) continue;
    const s = new Scope(null);
    for (const p of fn.params || []) s.names.set(p, 'let');
    stmt(fn.body, s);
  }
  for (const fn of (program.functions || new Map()).values()) {
    const s = new Scope(null);
    for (const p of fn.params) s.names.set(p, 'let');
    stmt(fn.body, s);
  }
  return diags;
}

/** 诊断：解析完整源码，把 parseProgram 错误与静态作用域错误映射为 CodeMirror 标记。 */
export function scriptLintSource(fx) {
  return linter((view) => {
    const code = view.state.doc.toString();
    const doc = view.state.doc;
    let program;
    try {
      program = parseProgram(code);
    } catch (e) {
      const loc = parseErrorLocation(e.message);
      if (!loc) {
        return [{ from: 0, to: doc.length, severity: 'error', message: localizeScriptError(e.message) }];
      }
      const lineNo = Math.max(1, Math.min(doc.lines, loc.line));
      const line = doc.line(lineNo);
      const from = Math.min(line.from + Math.max(0, loc.col - 1), line.to);
      const message = localizeScriptError((e.message || '').replace(/\s*\(line \d+, col \d+\)$/, ''));
      return [{ from, to: from, severity: 'error', message }];
    }

    const out = [];
    for (const d of staticScriptDiagnostics(program, fx)) {
      const lineNo = Math.max(1, Math.min(doc.lines, d.line));
      const line = doc.line(lineNo);
      const from = Math.min(line.from + Math.max(0, d.col - 1), line.to);
      out.push({ from, to: from, severity: 'error', message: localizeScriptError(d.msg) });
    }
    return out;
  });
}

/**
 * 创建脚本代码编辑器并挂到父元素。
 * @param parent 父 DOM 节点
 * @param opts { fx, rows, onChange }；onChange 在每次文档更新时调用（传入新文本）
 * @returns {EditorView}
 */
export function createScriptEditor(parent, opts) {
  const { fx, rows = 10, onChange } = opts;
  const state = EditorState.create({
    doc: (fx && fx.source) || '',
    extensions: [
      scriptLanguage,
      syntaxHighlighting(scriptHighlightStyle),
      lineNumbers(),
      bracketMatching(),
      highlightSelectionMatches(),
      indentUnit.of('  '),
      scriptIndentService,
      history(),
      closeBrackets(),
      indentOnInput(),
      scriptTheme,
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged && onChange) onChange(update.state.doc.toString());
      }),
      autocompletion({
        override: [scriptCompletionSource(fx)],
        activateOnTypingDelay: 50,
      }),
      keymap.of([
        { key: 'Tab', run: acceptCompletion },
        indentWithTab,
        { key: 'Enter', run: insertNewlineAndIndent },
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      scriptLintSource(fx),
      EditorView.theme({
        '&': { minHeight: `${rows * 1.4 + 0.7}em` },
      }),
    ],
  });

  const view = new EditorView({ state, parent });

  try {
    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
      view.contentDOM.addEventListener('focus', () => {
        setTimeout(() => {
          try { parent.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
          catch (e) { if (typeof parent.scrollIntoView === 'function') parent.scrollIntoView(); }
        }, 160);
      });
    }
  } catch (e) { /* 测试桩 / 旧浏览器忽略 */ }

  parent.addEventListener('mousedown', (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest('.cm-content')) return;
    event.preventDefault();
    view.focus();
  });

  return view;
}