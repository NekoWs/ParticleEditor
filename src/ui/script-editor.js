import { EditorView, keymap } from '@codemirror/view';
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
const BUILTIN_SET = new Set(SCRIPT_BUILTINS);

const scriptLanguage = StreamLanguage.define({
  name: 'pdraw-script',
  startState() {
    return { inBlockComment: false, afterDot: false, afterThisDot: false, lastWord: '' };
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

    if (stream.match(/^(==|!=|<=|>=|&&|\|\|)/)) {
      state.afterDot = false;
      state.afterThisDot = false;
      return 'operator';
    }

    if (stream.match(/^[+\-*/%!?:=<>()[\]{},;]/)) {
      state.afterDot = false;
      state.afterThisDot = false;
      return 'operator';
    }

    // 点运算符：标记下一标识符是字段（this.*）还是方法调用（*.push(...)）。
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
        return isThisField ? 'propertyName' : 'function';
      }

      state.lastWord = word;
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

// Islands Dark 配色（参考 vscode-dark-islands 主题）
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

const scriptHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: PALETTE.keyword },
  { tag: tags.comment, color: PALETTE.comment, fontStyle: 'italic' },
  { tag: tags.string, color: PALETTE.string },
  { tag: tags.number, color: PALETTE.number },
  { tag: tags.operator, color: PALETTE.operator },
  { tag: tags.function, color: PALETTE.function },
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

    // 换行或语句刚结束时（分号/括号后）不弹补全。
    const lastChar = before.slice(-1);
    if (lastChar === ';' || lastChar === '\n' || lastChar === '{' || lastChar === '}' || lastChar === ')') return null;

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
        ...closeBracketsKeymap,
        ...completionKeymap,
      ]),
      scriptLintSource(fx, field),
      EditorView.theme({
        '&': { minHeight: `${rows * 1.4 + 0.7}em` },
      }),
    ],
  });

  const view = new EditorView({ state, parent });

  // 点击容器空白区域也进入编辑；只有点击正文区才交给 CodeMirror 原生选择逻辑。
  // preventDefault 阻止浏览器默认焦点跳转，否则 view.focus() 会被随后的默认行为顶掉。
  parent.addEventListener('mousedown', (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest('.cm-content')) return;
    event.preventDefault();
    view.focus();
  });

  return view;
}