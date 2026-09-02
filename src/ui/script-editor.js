import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import {
  StreamLanguage,
  HighlightStyle,
  syntaxHighlighting,
} from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { autocompletion } from '@codemirror/autocomplete';
import { linter } from '@codemirror/lint';
import { parseProgram } from '../core/script-lang.js';

/**
 * .pdraw 脚本语言（setup/process/funcs）的 CodeMirror 编辑器封装：
 * 语法高亮 + 自动补全 + 解析错误诊断。语言定义以 docs/script-lang-spec.md 为准。
 */

export const SCRIPT_KEYWORDS = [
  'setup', 'process', 'func', 'global', 'static',
  'if', 'else', 'while', 'do', 'for', 'break', 'continue', 'return',
  'true', 'false',
];

export const SCRIPT_THIS_FIELDS = [
  'index', 'count', 'time', 'delta', 'duration', 'uv',
  'position', 'color', 'velocity', 'scale', 'glow', 'light', 'life',
];

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
const THIS_SET = new Set(SCRIPT_THIS_FIELDS);
const BUILTIN_SET = new Set(SCRIPT_BUILTINS);

const scriptLanguage = StreamLanguage.define({
  name: 'pdraw-script',
  startState() { return { inBlockComment: false }; },
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

    if (stream.match(/^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/)) return 'number';

    if (stream.match(/^(==|!=|<=|>=|&&|\|\|)/)) return 'operator';
    if (stream.match(/^[+\-*/%!?:=<>()[\]{},;.]/)) return 'operator';

    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      const word = stream.current();
      if (KEYWORD_SET.has(word)) return 'keyword';
      if (word === 'pi' || word === 'true' || word === 'false') return 'atom';
      if (BUILTIN_SET.has(word)) return 'function';
      return 'variableName';
    }

    stream.next();
    return null;
  },
});

// IDEA Darcula 风格配色
const PALETTE = {
  bg: '#2b2b2b',
  gutter: '#313335',
  text: '#a9b7c6',
  keyword: '#cc7832',
  string: '#6a8759',
  number: '#6897bb',
  comment: '#808080',
  function: '#ffc66d',
  variable: '#a9b7c6',
  atom: '#9876aa',
  operator: '#a9b7c6',
  selection: '#214283',
  activeLine: '#323232',
  tooltipBg: '#3c3f41',
  tooltipText: '#a9b7c6',
  tooltipSelected: '#2d5f9e',
};

const scriptHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: PALETTE.keyword },
  { tag: tags.comment, color: PALETTE.comment },
  { tag: tags.string, color: PALETTE.string },
  { tag: tags.number, color: PALETTE.number },
  { tag: tags.operator, color: PALETTE.operator },
  { tag: tags.function, color: PALETTE.function },
  { tag: tags.variableName, color: PALETTE.variable },
  { tag: tags.atom, color: PALETTE.atom },
]);

const scriptTheme = EditorView.theme({
  '&': {
    backgroundColor: PALETTE.bg,
    color: PALETTE.text,
    fontSize: '12px',
  },
  '.cm-content': {
    fontFamily: '"SFMono-Regular", Consolas, monospace',
    lineHeight: '1.4',
    caretColor: PALETTE.text,
    padding: '5px 7px',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: PALETTE.text },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: PALETTE.selection,
  },
  '.cm-gutters': { backgroundColor: PALETTE.gutter, color: PALETTE.comment, border: 'none' },
  '.cm-activeLine': { backgroundColor: PALETTE.activeLine },
  '.cm-activeLineGutter': { backgroundColor: PALETTE.activeLine },
  '.cm-tooltip': {
    backgroundColor: PALETTE.tooltipBg,
    color: PALETTE.tooltipText,
    border: '1px solid #4b4e50',
  },
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: PALETTE.tooltipBg,
    color: PALETTE.tooltipText,
  },
  '.cm-tooltip.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: PALETTE.tooltipSelected,
    color: '#ffffff',
  },
  '.cm-completionMatchedText': { color: PALETTE.function, textDecoration: 'none' },
  '.cm-completionDetail': { color: PALETTE.comment, fontStyle: 'normal' },
});

/** 把单个代码段包装成可被 parseProgram 解析的完整脚本源。 */
export function buildSectionSource(field, code) {
  const text = code == null ? '' : String(code);
  if (field === 'setup') return `setup {\n${text}\n}\n`;
  if (field === 'process') return `process {\n${text}\n}\n`;
  return text; // funcs：顶层函数定义，无需包装
}

/** 从解析错误消息中提取 (line, col)，均为 1 起。 */
export function parseErrorLocation(message) {
  const m = /\(line (\d+), col (\d+)\)$/.exec(message || '');
  if (!m) return null;
  return { line: parseInt(m[1], 10), col: parseInt(m[2], 10) };
}

/** 代码段字段的包装前缀行数（错误行号映射回编辑器时减去）。 */
function wrapperLines(field) {
  return field === 'funcs' ? 0 : 1;
}

/** 自动补全：关键字 + 内置函数 + this 字段 + 函数变量 + 代码中已出现的标识符。 */
export function scriptCompletionSource(fx) {
  return (context) => {
    const before = context.state.sliceDoc(0, context.pos);
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

    const options = [];
    for (const kw of SCRIPT_KEYWORDS) options.push({ label: kw, type: 'keyword' });
    for (const fn of SCRIPT_BUILTINS) options.push({ label: fn, type: 'function', detail: 'builtin' });
    for (const name of Object.keys(fx?.vars || {})) options.push({ label: name, type: 'variable', detail: 'var' });

    const seen = new Set(SCRIPT_KEYWORDS);
    for (const fn of SCRIPT_BUILTINS) seen.add(fn);
    const doc = context.state.doc.toString();
    for (const m of doc.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      const name = m[0];
      if (!seen.has(name) && !BUILTIN_SET.has(name) && !KEYWORD_SET.has(name) && name !== 'this') {
        seen.add(name);
        options.push({ label: name, type: 'variable' });
      }
    }

    return { from, options, validFor: /^\w*$/ };
  };
}

/** 诊断：解析当前代码段，把 parseProgram 错误映射为 CodeMirror 标记。 */
export function scriptLintSource(fx, field) {
  return linter((view) => {
    const code = view.state.doc.toString();
    try {
      parseProgram(buildSectionSource(field, code));
      return [];
    } catch (e) {
      const loc = parseErrorLocation(e.message);
      const doc = view.state.doc;
      if (!loc) {
        return [{ from: 0, to: doc.length, severity: 'error', message: e.message }];
      }
      const editorLine = Math.max(1, Math.min(doc.lines, loc.line - wrapperLines(field)));
      const line = doc.line(editorLine);
      const from = Math.min(line.from + Math.max(0, loc.col - 1), line.to);
      const message = (e.message || '').replace(/\s*\(line \d+, col \d+\)$/, '');
      return [{ from, to: from, severity: 'error', message }];
    }
  });
}

/**
 * 创建脚本代码编辑器并挂到父元素。
 * @param parent 父 DOM 节点
 * @param opts { fx, field, rows, onChange }；onChange 在每次文档更新时调用（传入新文本）
 * @returns {EditorView}
 */
export function createScriptEditor(parent, opts) {
  const { fx, field, rows = 4, onChange } = opts;
  const state = EditorState.create({
    doc: fx[field] || '',
    extensions: [
      scriptLanguage,
      syntaxHighlighting(scriptHighlightStyle),
      scriptTheme,
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged && onChange) onChange(update.state.doc.toString());
      }),
      autocompletion({ override: [scriptCompletionSource(fx)] }),
      scriptLintSource(fx, field),
      EditorView.theme({
        '&': { minHeight: `${rows * 1.4 + 0.7}em` },
      }),
    ],
  });

  const view = new EditorView({ state, parent });

  // 点击 .fx-code 容器任意空白区域也进入编辑（否则只有内容区可点）。
  parent.addEventListener('mousedown', (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest('.cm-editor')) return;
    view.focus();
  });

  return view;
}