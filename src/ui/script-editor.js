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
import { parseProgram, ARRAY_METHOD_NAMES } from '../core/script-lang.js';
import { CONSTANTS } from '../core/script/lexical.js';
import { localizeScriptError } from '../core/script-error-i18n.js';

// .pdraw 脚本语言（func setup/tick/process + 自定义函数）的 CodeMirror 编辑器封装：
// 语法高亮 + 自动补全 + 解析错误诊断。fx.source 是唯一源码字段。

export const SCRIPT_KEYWORDS = [
  'this', 'setup', 'process', 'tick', 'func', 'of', 'const', 'let', 'undefined',
  'if', 'else', 'while', 'do', 'for', 'break', 'continue', 'return',
  'true', 'false',
];

export const SCRIPT_THIS_FIELDS = [
  'time', 'animTime', 'duration', 'particles',
];

const THIS_FIELD_SET = new Set(SCRIPT_THIS_FIELDS);

export const SCRIPT_BUILTINS = [
  'vec2', 'vec3', 'vec4', 'mat3', 'mat4',
  'translate', 'scale', 'rotate', 'lookAt', 'rotX', 'rotY', 'rotZ', 'rotAxis',
  'dot', 'cross', 'len', 'len2', 'norm', 'lerp', 'mix', 'distance', 'angle_between', 'project', 'reflect',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'sqrt', 'abs', 'sign', 'exp', 'log', 'ln', 'floor', 'ceil', 'round', 'fract', 'pow',
  'min', 'max', 'clamp', 'step', 'smoothstep', 'mod', 'map_range', 'remap', 'int', 'float', 'bool',
  'noise', 'fbm', 'rand', 'random',
  'ease_linear', 'ease_in_out', 'ease_out_back', 'ease_in_elastic',
  'unique', 'reverse', 'sort', 'print', 'assert',
];

const KEYWORD_SET = new Set(SCRIPT_KEYWORDS);
const BUILTIN_SET = new Set(SCRIPT_BUILTINS);

export const scriptLanguage = StreamLanguage.define({
  name: 'pdraw-script',
  tokenTable: {
    function: tags.function(tags.variableName),
  },
  startState() {
    return { inBlockComment: false, afterDot: false, afterThisDot: false, lastWord: '', afterFunc: false };
  },
  token(stream, state) {
    if (state.inBlockComment) {
      if (stream.match('*/')) { state.inBlockComment = false; return 'comment'; }
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.eatSpace()) return null;

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

    if (stream.match(/^[+\-*/%!?:=<>()[\]{},;]/)) {
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
        if (isThisField) return 'propertyName';
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
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: PALETTE.text },
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

const PARTICLE_FIELD_TYPES = {
  position: 'vec3', color: 'vec4', velocity: 'vec3', scale: 'num',
  glow: 'bool', light: 'num', life: 'num', index: 'num',
};
const PARTICLE_METHODS = ['kill'];

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

const BUILTIN_RETURN_TYPES = {
  vec2: 'vec2', vec3: 'vec3', vec4: 'vec4', vec: 'vec3',
  mat3: 'mat3', mat4: 'mat4',
  translate: 'mat4', scale: 'mat4', rotate: 'mat4', lookAt: 'mat4',
  rotX: 'mat3', rotY: 'mat3', rotZ: 'mat3', rotAxis: 'mat3',
  cross: 'vec3',
  dot: 'num', len: 'num', len2: 'num', distance: 'num', angle_between: 'num',
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

  if (name === 'lerp' || name === 'mix' || name === 'clamp') {
    return node.args.length ? inferExprType(node.args[0], env) : 'unknown';
  }
  if (name === 'norm' || name === 'project' || name === 'reflect') {
    const at = node.args.length ? inferExprType(node.args[0], env) : 'unknown';
    return isVecType(at) ? at : 'unknown';
  }
  if (name === 'int' || name === 'float') {
    const at = node.args.length ? inferExprType(node.args[0], env) : 'unknown';
    if (at === 'bool') return 'num';
    if (at === 'num' || isVecType(at) || isMatType(at)) return at;
    return 'unknown';
  }
  return BUILTIN_RETURN_TYPES[name] || 'unknown';
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
    case 'method': {
      if (node.object && node.object.type === 'var' && node.object.name === 'this' && node.method === 'spawn') {
        return 'particle';
      }
      return ARRAY_METHOD_RETURN_TYPES[node.method] || 'unknown';
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
    globals.set(d.name, d.init ? inferExprType(d.init, globals) : 'unknown');
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
      assignType(scope, st.name, st.init ? inferExprType(st.init, scope) : 'unknown');
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
        child.set(st.init.name, st.init.init ? inferExprType(st.init.init, child) : 'unknown');
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

function resolveDotReceiverType(name, before, matchIndex, fx, pos) {
  const prefix = before.slice(0, matchIndex);
  if (/this\s*\.\s*$/.test(prefix)) return THIS_FIELD_TYPES[name] || 'unknown';

  const scope = buildScriptEnvs(fx, pos);
  return lookupType(scope, name) || 'unknown';
}

/** 自动补全：关键字 + 内置函数 + this 字段 + 粒子/向量/数组成员 + 代码中已出现的标识符。 */
export function scriptCompletionSource(fx) {
  return (context) => {
    const before = context.state.sliceDoc(0, context.pos);

    const lastChar = before.slice(-1);
    if (lastChar === ';' || lastChar === '\n' || lastChar === '{' || lastChar === '}' || lastChar === ')' || lastChar === ' ') return null;

    const word = context.matchBefore(/[\w.]*/);
    const from = word ? word.from : context.pos;

    const afterThisDot = /this\s*\.\s*[\w]*$/.test(before);
    if (afterThisDot) {
      return {
        from: context.pos - (/[\w]*$/.exec(before)?.[0]?.length || 0),
        options: SCRIPT_THIS_FIELDS.map((name) => ({ label: name, type: 'property' })),
        validFor: /^\w*$/,
      };
    }

    const dot = /([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)?$/.exec(before);
    if (dot) {
      const partial = dot[2] || '';
      const receiverType = resolveDotReceiverType(dot[1], before, dot.index, fx, context.pos);
      const make = (labels, type) => ({
        from: context.pos - partial.length,
        options: labels.map((label) => ({ label, type })),
        validFor: /^\w*$/,
      });
      if (receiverType === 'array') return make(ARRAY_METHOD_NAMES, 'method');
      if (receiverType === 'particleList') return make(['size'], 'method');
      if (receiverType === 'particle') return make([...Object.keys(PARTICLE_FIELD_TYPES), ...PARTICLE_METHODS], 'property');
      if (VEC_COMPONENTS[receiverType]) return make(VEC_COMPONENTS[receiverType], 'property');
      return null;
    }

    const options = [];
    for (const kw of SCRIPT_KEYWORDS) options.push({ label: kw, type: 'keyword' });
    for (const fn of SCRIPT_BUILTINS) options.push({ label: fn, type: 'function', detail: 'builtin' });
    for (const name of Object.keys(fx?.vars || {})) options.push({ label: name, type: 'variable', detail: 'var' });

    const seen = new Set(SCRIPT_KEYWORDS);
    for (const fn of SCRIPT_BUILTINS) seen.add(fn);
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
    globalNames.add(d.name);
    if (d.kind === 'const') globalConst.add(d.name);
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
        if (scope.names.has(node.name)) {
          diags.push({ line: node.line, col: node.col, msg: `duplicate declaration '${node.name}'` });
        }
        scope.names.set(node.name, node.kind);
        if (node.init) expr(node.init, scope);
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
    for (const d of program.globals || []) if (d.init) expr(d.init, s);
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