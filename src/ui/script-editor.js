import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import {
  StreamLanguage,
  HighlightStyle,
  syntaxHighlighting,
  bracketMatching,
  indentOnInput,
  indentUnit,
} from '@codemirror/language';
import { tags } from '@lezer/highlight';
import {
  autocompletion,
  acceptCompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
} from '@codemirror/autocomplete';
import { indentWithTab, insertNewlineAndIndent } from '@codemirror/commands';
import { linter } from '@codemirror/lint';
import { highlightSelectionMatches } from '@codemirror/search';
import { parseProgram, ARRAY_METHOD_NAMES } from '../core/script-lang.js';
import { localizeScriptError } from '../core/script-error-i18n.js';

/**
 * .pdraw 脚本语言（v12：func setup/tick/process + 自定义函数）的 CodeMirror 编辑器封装：
 * 语法高亮 + 自动补全 + 解析错误诊断。fx.source 为唯一源码字段。
 */

export const SCRIPT_KEYWORDS = [
  'this', 'setup', 'process', 'tick', 'func', 'global', 'of', 'const',
  'if', 'else', 'while', 'do', 'for', 'break', 'continue', 'return',
  'true', 'false',
];

export const SCRIPT_THIS_FIELDS = [
  'time', 'duration', 'particles',
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

    if (stream.match(/^(==|!=|<=|>=|&&|\|\||\+\+|--)/)) {
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
      if (word === 'pi' || word === 'true' || word === 'false') return 'atom';
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

/** 从解析错误消息中提取 (line, col)，均为 1 起。 */
export function parseErrorLocation(message) {
  const m = /\(line (\d+), col (\d+)\)$/.exec(message || '');
  if (!m) return null;
  return { line: parseInt(m[1], 10), col: parseInt(m[2], 10) };
}

/* -------------------------------------------------------------------------
 * 轻量类型推断
 * ---------------------------------------------------------------------- */

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
      if (env.has(node.name)) return env.get(node.name);
      if (node.name === 'pi' || node.name === 'e') return 'num';
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
    case 'method': return ARRAY_METHOD_RETURN_TYPES[node.method] || 'unknown';
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
    if (ch === ';' || ch === '{' || ch === '}') { cut = text.slice(0, i + 1); break; }
  }
  if (!cut) return '';
  let depth = 0;
  for (const ch of cut) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  return cut + '}'.repeat(Math.max(0, depth));
}

// 遍历语句收集变量类型（含 for-of 循环变量）。
function collectTypes(stmts, env) {
  for (const st of stmts) {
    if (!st) continue;
    if (st.type === 'global') {
      env.set(st.name, st.init ? inferExprType(st.init, env) : 'unknown');
    } else if (st.type === 'assign' && st.target && st.target.type === 'var') {
      env.set(st.target.name, inferExprType(st.value, env));
    } else if (st.type === 'forof') {
      const iterT = inferExprType(st.iter, env);
      env.set(st.name, iterT === 'particleList' ? 'particle' : 'unknown');
      if (Array.isArray(st.body)) collectTypes(st.body, env);
      else if (st.body && Array.isArray(st.body.body)) collectTypes(st.body.body, env);
    } else if (st.type === 'block' && Array.isArray(st.body)) {
      collectTypes(st.body, env);
    } else if (st.type === 'if') {
      if (st.then) collectTypes(Array.isArray(st.then) ? st.then : [st.then], env);
      if (st.els) collectTypes(Array.isArray(st.els) ? st.els : [st.els], env);
    } else if (st.type === 'while' || st.type === 'do' || st.type === 'for') {
      if (st.body) collectTypes(Array.isArray(st.body) ? st.body : [st.body], env);
    }
  }
}

/** 解析当前完整源码（必要时截断未完成语句），返回各函数环境。 */
function buildScriptEnvs(fx, pos) {
  const empty = { setup: new Map(), tick: new Map(), process: new Map(), funcs: new Map(), current: new Map() };
  const src = (fx && fx.source) || '';
  const code = pos != null ? truncateIncomplete(src, pos) : src;
  let program;
  try {
    program = parseProgram(code);
  } catch {
    return empty;
  }

  const globals = new Map();
  const setupEnv = new Map();
  const tickEnv = new Map();
  const processEnv = new Map();
  const funcsEnv = new Map();
  const seed = (env) => {
    env.set('pi', 'num');
    env.set('e', 'num');
    for (const name of Object.keys(fx?.vars || {})) env.set(name, 'num');
  };
  seed(setupEnv); seed(tickEnv); seed(processEnv); seed(funcsEnv);

  if (program.setup) {
    collectTypes(program.setup.body.body, setupEnv);
    for (const [name, t] of setupEnv) if (name !== 'pi' && name !== 'e' && !(name in (fx?.vars || {}))) globals.set(name, t);
  }
  for (const [name, t] of globals) { tickEnv.set(name, t); processEnv.set(name, t); funcsEnv.set(name, t); }
  if (program.tick) collectTypes(program.tick.body.body, tickEnv);
  if (program.process) collectTypes(program.process.body.body, processEnv);
  // 自定义函数参数
  for (const [name, fn] of program.functions) {
    const env = new Map(globals);
    seed(env);
    for (const p of fn.params) env.set(p, 'unknown');
    collectTypes(fn.body.body, env);
    funcsEnv.set(name, 'func');
  }

  return { setup: setupEnv, tick: tickEnv, process: processEnv, funcs: funcsEnv, current: processEnv };
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

  const envs = buildScriptEnvs(fx, pos);
  const fnName = enclosingFuncName(fx && fx.source, pos);
  const env = fnName === 'setup' ? envs.setup : fnName === 'tick' ? envs.tick : fnName === 'process' ? envs.process : envs.funcs;
  return env.get(name) || 'unknown';
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

/** 诊断：解析完整源码，把 parseProgram 错误映射为 CodeMirror 标记。 */
export function scriptLintSource(fx) {
  return linter((view) => {
    const code = view.state.doc.toString();
    try {
      parseProgram(code);
      return [];
    } catch (e) {
      const loc = parseErrorLocation(e.message);
      const doc = view.state.doc;
      if (!loc) {
        return [{ from: 0, to: doc.length, severity: 'error', message: localizeScriptError(e.message) }];
      }
      const lineNo = Math.max(1, Math.min(doc.lines, loc.line));
      const line = doc.line(lineNo);
      const from = Math.min(line.from + Math.max(0, loc.col - 1), line.to);
      const message = localizeScriptError((e.message || '').replace(/\s*\(line \d+, col \d+\)$/, ''));
      return [{ from, to: from, severity: 'error', message }];
    }
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
        // 显式放行删除键：报错/lint/补全弹层存在时也保证可删除。
        { key: 'Backspace', run: () => false },
        { key: 'Delete', run: () => false },
        ...closeBracketsKeymap,
        ...completionKeymap,
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