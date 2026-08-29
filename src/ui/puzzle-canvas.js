/* =========================================================================
 * 拼图模式 Canvas 渲染器
 * 把拼图界面（调色板 / 工作区 / 底部变量区 / 代码回显）全部画到 canvas 上，
 * 命中检测与拖动/缩放/平移/编辑交互也走 canvas 坐标。
 *
 * 本模块不依赖 blocks-ui，避免循环 import。blocks-ui 通过 setPuzzleHost()
 * 注入数据访问与变更回调；本模块只负责布局、绘制、命中与输入。
 * ======================================================================= */

import { t, tf } from '../core/i18n.js';
import { getFunction } from '../core/constants.js';
import { ATTR_NAMES } from '../core/easing.js';
import { rgbToHex, hexToRgb } from './ui.js';
import {
  T_SCALAR, T_VEC, T_MAT, T_ANY,
  FUNC_BLOCKS, STMT_BLOCKS, PALETTE_GROUPS,
  fmtNum, statementsToCode,
  STMT_SLOTS, BIG_BLOCKS, BUILTIN_VAR_NAMES, GROUP_COLOR,
  isBoolOp, opSlotType, slotRef, N0,
} from '../core/blocks.js';

/* ============================ host 注入 ============================ */

let H = null;
export function setPuzzleHost(host) { H = host; }

/* ============================ 常量 ============================ */

const FONT = '13px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
const FONT_MONO = '12px Consolas, "SFMono-Regular", monospace';
const TEXT_H = 16;

const STMT_PAD_X = 12, STMT_PAD_Y = 7;
const SLOT_PAD_X = 7, SLOT_PAD_Y = 4;
const EXPR_PAD_X = 8, EXPR_PAD_Y = 3;
const EXPR_H = 20;
const BUMP_H = 12, BUMP_X = 14, BUMP_W = 26;
const HAT_H = 24;
const BODY_INDENT = 20;
const CTL_PAD = 8;
const CTL_MOUTH = 0;    // 左侧 C 形开口已按需求移除，子块仍缩进
const OP_W = 20, OP_H = 18;
const APPEND_W = 22;
const COLOR_W = 26, COLOR_H = 18;
const TOGGLE_H = 20, EDIT_H = 20, ATTR_H = 20;
const DRAG_THRESHOLD = 5;

const PAL_SCALE = 1.2;  // 调色板积木放大比例
const PAL_LEFT = 10, PAL_TOP = 8, PAL_GAP = 8;

const VARS_H = 108;
const VARS_PAD = 10, VARS_GAP = 8, VARS_ROW_H = 30;

const CTL_KINDS = new Set(['if', 'while', 'for', 'do', 'func']);
const SIMPLE_CTL = new Set(['global', 'static', 'break', 'continue', 'return']);

const CLS_COLORS = {
  'blk-pos': '#1f9d55',
  'blk-color': '#9d3fbf',
  'blk-appearance': '#d98a1f',
  'blk-math': '#1f6fd9',
  'blk-vec': '#7a3fd9',
  'blk-mat': '#0f8fae',
  'blk-var': '#d97a1f',
  'blk-const': '#4a5568',
  'blk-logic': '#e0a01f',
  'blk-array': '#d9537f',
  'blk-raw': '#1b1f28',
  'blk-ctl': '#202838',
  'blk-start': '#6a8f3c',
  'blk-frag': '#7a6a3c',
};

/* ============================ 运行状态 ============================ */

const S = {
  palCanvas: null, workCanvas: null, echoCanvas: null, ghostCanvas: null,
  palCtx: null, workCtx: null, echoCtx: null, ghostCtx: null,
  dpr: 1,
  palScroll: 0,
  varsScroll: 0,
  echoScroll: 0,
  wsRegions: [],
  varRegions: [],
  palRegions: [],
  drag: null,
  edit: null,
  editMouse: null,
  lens: null,
  dropHover: null,
  hover: null,
};

/* ============================ 小工具 ============================ */

function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch (e) { return fallback; }
}
function theme() {
  return {
    bg: cssVar('--bg', '#12141a'),
    panel: cssVar('--panel', '#1c1f27'),
    panel2: cssVar('--panel-2', '#262a34'),
    panel3: cssVar('--panel-3', '#2f3440'),
    border: cssVar('--border', '#323848'),
    text: cssVar('--text', '#e8ecf4'),
    muted: cssVar('--muted', '#8b93a7'),
    accent: cssVar('--accent', '#5b9dff'),
    danger: cssVar('--danger', '#ff6b6b'),
  };
}

function textW(ctx, text, font) {
  if (!ctx) return (text || '').length * 7;
  const f = font || FONT;
  if (ctx.font !== f) ctx.font = f;
  return ctx.measureText(text == null ? '' : String(text)).width;
}

function typeLabel(type) {
  const m = { [T_SCALAR]: 'blk.type.scalar', [T_VEC]: 'blk.type.vec', [T_MAT]: 'blk.type.mat', [T_ANY]: 'blk.type.any' };
  return t(m[type] || 'blk.type.any');
}

function blockColor(cls) {
  for (const k in CLS_COLORS) if ((cls || '').includes(k)) return CLS_COLORS[k];
  return '#2a4d78';
}
function stmtCls(s) {
  if (CTL_KINDS.has(s.kind) || SIMPLE_CTL.has(s.kind)) return 'blk-ctl';
  if (s.kind === 'raw') return 'blk-raw';
  const g = STMT_BLOCKS[s.kind] && STMT_BLOCKS[s.kind].group;
  return GROUP_COLOR[g] || 'blk-var';
}
function funcColor(name) {
  const r = FUNC_BLOCKS[name] && FUNC_BLOCKS[name].ret;
  if (r === T_VEC) return 'blk-vec';
  if (r === T_MAT) return 'blk-mat';
  return 'blk-math';
}
function exprCls(node) {
  switch (node.kind) {
    case 'num': return 'blk-const';
    case 'bool': return 'blk-const blk-bool';
    case 'var': return (node.name === 'pi' || node.name === 'e') ? 'blk-const' : 'blk-var';
    case 'func': return funcColor(node.name);
    case 'op': return 'blk-math' + (isBoolOp(node.op) ? ' blk-bool' : '');
    case 'chain': return 'blk-math';
    case 'comp': return 'blk-vec';
    case 'neg': return 'blk-math';
    case 'not': return 'blk-math blk-bool';
    case 'ternary': return 'blk-math';
    case 'index': return 'blk-array';
    case 'method': return 'blk-array';
    case 'array': return 'blk-array';
    default: return 'blk-var';
  }
}
function exprShape(node) {
  if (node.kind === 'bool' || node.kind === 'not') return 'bool';
  if (node.kind === 'op' && isBoolOp(node.op)) return 'bool';
  if (node.kind === 'ternary') return 'bool';
  return 'capsule';
}
function isExprNode(node) { return node && typeof node === 'object' && node.kind; }

/* ============================ 路径 ============================ */

function rrPath(c, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}
function capsulePath(c, x, y, w, h) { rrPath(c, x, y, w, h, h / 2); }
function hexPath(c, x, y, w, h) {
  const n = Math.min(h * 0.28, w * 0.28);
  c.beginPath();
  c.moveTo(x + n, y);
  c.lineTo(x + w - n, y);
  c.lineTo(x + w, y + h / 2);
  c.lineTo(x + w - n, y + h);
  c.lineTo(x + n, y + h);
  c.lineTo(x, y + h / 2);
  c.closePath();
}
/** 普通语句块：顶部凹口（凹入）+ 底部凸起（凸出）；noBump 时顶部平直（起始块下方第一块）。 */
function stmtPath(c, x, y, w, h, noBump) {
  const T = BUMP_H, bx = BUMP_X, bw = BUMP_W;
  const bxl = x + bx, bxr = bxl + bw;
  const r = Math.min(10, w / 2, h / 2);
  const n = Math.min(T / 2, bw / 2);
  const top = y, bot = y + h;
  c.beginPath();
  c.moveTo(x + r, top);
  if (noBump) {
    // 顶部平直：无凹口
  } else {
    // 顶部凹口：向内凹入
    c.lineTo(bxl, top);
    c.quadraticCurveTo(bxl, top + T, bxl + n, top + T);
    c.lineTo(bxr - n, top + T);
    c.quadraticCurveTo(bxr, top + T, bxr, top);
  }
  c.lineTo(x + w - r, top);
  c.arcTo(x + w, top, x + w, top + r, r);
  c.lineTo(x + w, bot - r);
  c.arcTo(x + w, bot, x + w - r, bot, r);
  // 底部凸起：向外凸出
  c.lineTo(bxr, bot);
  c.quadraticCurveTo(bxr, bot + T, bxr - n, bot + T);
  c.lineTo(bxl + n, bot + T);
  c.quadraticCurveTo(bxl, bot + T, bxl, bot);
  c.lineTo(x + r, bot);
  c.arcTo(x, bot, x, bot - r, r);
  c.lineTo(x, top + r);
  c.arcTo(x, top, x + r, top, r);
  c.closePath();
}
/** hat 起点块：圆头，无顶部凹口（起始块上无上一块），底部平直接第一块。 */
function hatPath(c, x, y, w, h) {
  rrPath(c, x, y, w, h, Math.min(12, w / 2, h / 2));
}

/* ============================ 布局：表达式 ============================ */

function layoutSlot(ref, slotType, label, x, y, out, ctx) {
  const cur = ref.get();
  if (cur && isExprNode(cur)) {
    const e = layoutExpr(cur, x, y, out, ctx);
    // 占用槽也要作为落点（可替换），在子表达式之上放一个透明命中区域。
    out.push({ kind: 'slot', shape: 'slot-hidden', ref, slotType, x, y, w: e.w, h: e.h, segments: [] });
    return e;
  }
  const ph = (label ? label + ' ' : '') + typeLabel(slotType);
  const tw = textW(ctx, ph, FONT);
  const w = tw + SLOT_PAD_X * 2;
  const h = EXPR_H;
  out.push({
    kind: 'slot', shape: 'slot', ref, slotType, x, y, w, h,
    segments: [{ text: ph, x: x + SLOT_PAD_X, y: y + EXPR_H / 2, font: FONT }],
  });
  return { w, h };
}

/** 行内流动布局：把 parts 依次排到一行，返回总宽/高；子区域与文本段写入 out/seg。 */
function inlineFlow(parts, x, y, out, seg, ctx) {
  let cx = x;
  let h = EXPR_H;
  const children = [];
  const textSegs = [];
  const spans = [];
  for (const p of parts) {
    const start = children.length;
    let partH = EXPR_H;
    if (p.text != null) {
      const tw = textW(ctx, p.text, FONT);
      textSegs.push({ text: p.text, x: cx, y: y, font: FONT });
      cx += tw;
    } else if (p.slot) {
      const r = layoutSlot(p.slot.ref, p.slot.type, p.slot.label, cx, y, children, ctx);
      cx += r.w; h = Math.max(h, r.h); partH = r.h;
    } else if (p.op) {
      children.push({ kind: 'op', shape: 'op', opSlot: p.op, x: cx, y, w: OP_W, h: OP_H, segments: [{ text: p.op.chain.ops[p.op.index] || '?', x: cx + OP_W / 2, y: y + OP_H / 2, font: FONT, align: 'center' }] });
      cx += OP_W; partH = OP_H;
    } else if (p.append) {
      children.push({ kind: 'append', shape: 'append', chainAppend: p.append, x: cx, y, w: APPEND_W, h: OP_H, segments: [{ text: '+', x: cx + APPEND_W / 2, y: y + OP_H / 2, font: FONT, align: 'center' }] });
      cx += APPEND_W; partH = OP_H;
    } else if (p.comp) {
      const label = '.' + p.comp.node.axis;
      const tw = textW(ctx, label, FONT);
      children.push({ kind: 'comp', shape: 'comp', comp: p.comp, x: cx, y, w: tw + 4, h: EXPR_H, segments: [{ text: label, x: cx + 2, y: y + EXPR_H / 2, font: FONT }] });
      cx += tw + 4; partH = EXPR_H;
    } else if (p.edit) {
      const val = p.edit.value == null ? '' : String(p.edit.value);
      const tw = textW(ctx, val, FONT) + 8;
      children.push({ kind: 'edit', shape: 'edit', edit: p.edit, x: cx, y, w: tw, h: EDIT_H, segments: [{ text: val, x: cx + 4, y: y + EDIT_H / 2, font: FONT }] });
      cx += tw; partH = EDIT_H;
    } else if (p.attr) {
      const val = p.attr.stmt.name || '';
      const tw = textW(ctx, val, FONT) + 8;
      children.push({ kind: 'attr', shape: 'attr', attr: p.attr, x: cx, y, w: tw, h: ATTR_H, segments: [{ text: val, x: cx + 4, y: y + ATTR_H / 2, font: FONT }] });
      cx += tw; partH = ATTR_H;
    } else if (p.toggle) {
      const tw = textW(ctx, p.toggle.label, FONT) + 16;
      children.push({ kind: 'toggle', shape: 'toggle', toggle: p.toggle, x: cx, y, w: tw, h: TOGGLE_H, segments: [{ text: p.toggle.label, x: cx + 8, y: y + TOGGLE_H / 2, font: FONT }] });
      cx += tw; partH = TOGGLE_H;
    } else if (p.color) {
      children.push({ kind: 'color', shape: 'color', color: p.color, x: cx, y, w: COLOR_W, h: COLOR_H, segments: [] });
      cx += COLOR_W; partH = COLOR_H;
    }
    spans.push({ start, end: children.length, h: partH });
  }
  // 以整行高度为基准做垂直居中
  const centerY = y + h / 2;
  for (const s of textSegs) s.y = centerY;
  for (const span of spans) {
    const dy = centerY - (y + span.h / 2);
    for (let i = span.start; i < span.end; i++) {
      children[i].y += dy;
      for (const sg of children[i].segments || []) sg.y += dy;
    }
  }
  for (const c of children) out.push(c);
  for (const s of textSegs) seg.push(s);
  return { w: cx - x, h };
}

function exprParts(node) {
  const P = [];
  switch (node.kind) {
    case 'num': P.push({ text: fmtNum(node.value) }); break;
    case 'bool': P.push({ text: node.value ? 'true' : 'false' }); break;
    case 'var': P.push({ text: node.name }); break;
    case 'func': {
      const spec = FUNC_BLOCKS[node.name];
      P.push({ text: node.name + '(' });
      (spec ? spec.args : node.args).forEach((arg, i) => {
        if (i > 0) P.push({ text: ', ' });
        const argType = spec ? spec.args[i][1] : T_ANY;
        const argLabel = spec ? t(spec.args[i][0]) : '';
        P.push({ slot: { ref: slotRef(() => node.args[i], v => { node.args[i] = v; }, argType), type: argType, label: argLabel } });
      });
      P.push({ text: ')' });
      break;
    }
    case 'op':
      P.push({ slot: { ref: slotRef(() => node.a, v => { node.a = v; }, opSlotType(node.op, 'l')), type: opSlotType(node.op, 'l'), label: '' } });
      P.push({ text: node.op });
      P.push({ slot: { ref: slotRef(() => node.b, v => { node.b = v; }, opSlotType(node.op, 'r')), type: opSlotType(node.op, 'r'), label: '' } });
      break;
    case 'chain': {
      P.push({ slot: { ref: slotRef(() => node.terms[0], v => { node.terms[0] = v; }, T_ANY), type: T_ANY, label: '' } });
      node.ops.forEach((op, i) => {
        P.push({ op: { chain: node, index: i } });
        P.push({ slot: { ref: slotRef(() => node.terms[i + 1], v => { node.terms[i + 1] = v; }, T_ANY), type: T_ANY, label: '' } });
      });
      P.push({ append: { chain: node } });
      break;
    }
    case 'comp':
      P.push({ slot: { ref: slotRef(() => node.target, v => { node.target = v; }, T_VEC), type: T_VEC, label: '' } });
      P.push({ comp: { node } });
      break;
    case 'neg':
      P.push({ text: '−' });
      P.push({ slot: { ref: slotRef(() => node.a, v => { node.a = v; }, T_ANY), type: T_ANY, label: '' } });
      break;
    case 'not':
      P.push({ text: '!' });
      P.push({ slot: { ref: slotRef(() => node.a, v => { node.a = v; }, T_ANY), type: T_ANY, label: '' } });
      break;
    case 'ternary':
      P.push({ slot: { ref: slotRef(() => node.cond, v => { node.cond = v; }, T_ANY), type: T_ANY, label: '' } });
      P.push({ text: ' ? ' });
      P.push({ slot: { ref: slotRef(() => node.a, v => { node.a = v; }, T_ANY), type: T_ANY, label: '' } });
      P.push({ text: ' : ' });
      P.push({ slot: { ref: slotRef(() => node.b, v => { node.b = v; }, T_ANY), type: T_ANY, label: '' } });
      break;
    case 'index':
      P.push({ slot: { ref: slotRef(() => node.target, v => { node.target = v; }, T_ANY), type: T_ANY, label: '' } });
      P.push({ text: '[' });
      P.push({ slot: { ref: slotRef(() => node.index, v => { node.index = v; }, T_ANY), type: T_ANY, label: '' } });
      P.push({ text: ']' });
      break;
    case 'method':
      P.push({ slot: { ref: slotRef(() => node.obj, v => { node.obj = v; }, T_ANY), type: T_ANY, label: '' } });
      P.push({ text: '.' + node.method + '(' });
      node.args.forEach((_, i) => {
        if (i > 0) P.push({ text: ', ' });
        P.push({ slot: { ref: slotRef(() => node.args[i], v => { node.args[i] = v; }, T_ANY), type: T_ANY, label: '' } });
      });
      P.push({ text: ')' });
      break;
    case 'array':
      P.push({ text: '[' });
      node.items.forEach((_, i) => {
        if (i > 0) P.push({ text: ', ' });
        P.push({ slot: { ref: slotRef(() => node.items[i], v => { node.items[i] = v; }, T_ANY), type: T_ANY, label: '' } });
      });
      P.push({ text: ']' });
      break;
    default: P.push({ text: '?' });
  }
  return P;
}

function layoutExpr(node, x, y, out, ctx) {
  const seg = [];
  const children = [];
  const flow = inlineFlow(exprParts(node), x + EXPR_PAD_X, y + EXPR_PAD_Y, children, seg, ctx);
  const w = flow.w + EXPR_PAD_X * 2;
  const h = Math.max(EXPR_H, flow.h + EXPR_PAD_Y * 2);
  out.push({ kind: 'expr', shape: exprShape(node), cls: exprCls(node), node, x, y, w, h, segments: seg });
  for (const c of children) out.push(c);
  return { w, h };
}

/* ============================ 布局：语句 ============================ */

function stmtParts(s) {
  if (s.kind === 'expr') {
    return [
      { slot: { ref: slotRef(() => s.expr, v => { s.expr = v; }, T_ANY), type: T_ANY, label: '' } },
    ];
  }
  if (s.kind === 'set') {
    return [
      { edit: { kind: 'text', value: s.name, commit: (v) => {
        const nn = String(v).trim();
        if (!nn || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(nn) || ATTR_NAMES.includes(nn) || BUILTIN_VAR_NAMES.includes(nn) || nn === s.name) return false;
        H.pushUndo();
        H.renameRefsInAll(s.name, nn);
        s.name = nn;
        return true;
      } } },
      { text: ' = ' },
      { slot: { ref: slotRef(() => s.expr, v => { s.expr = v; }, T_ANY), type: T_ANY, label: '' } },
    ];
  }
  if (s.kind === 'attr') {
    const attrs = ATTR_NAMES.filter(n => n !== 'glow');
    return [
      { attr: { stmt: s, onClick: () => {
        const idx = attrs.indexOf(s.name);
        H.pushUndo();
        s.name = attrs[(idx + 1) % attrs.length];
        return true;
      } } },
      { text: ' = ' },
      { slot: { ref: slotRef(() => s.expr, v => { s.expr = v; }, T_SCALAR), type: T_SCALAR, label: '' } },
    ];
  }
  if (s.kind === 'glow') {
    return [
      { toggle: { stmt: s, label: s.on ? t('blk.glowOn') : t('blk.glowOff'), onClick: () => {
        H.pushUndo();
        s.on = !s.on;
        return true;
      } } },
    ];
  }
  if (s.kind === 'col') {
    const v = (n) => (n && n.kind === 'num') ? Math.min(1, Math.max(0, n.value)) : 1;
    return [
      { text: t(STMT_BLOCKS.col.label) + ' ' },
      { color: { stmt: s, hex: () => rgbToHex(v(s.slots[0]), v(s.slots[1]), v(s.slots[2])), commit: (hex) => {
        const [r, g, b] = hexToRgb(hex);
        const setSlot = (i, val) => { if (s.slots[i] && s.slots[i].kind === 'num') s.slots[i].value = val; else s.slots[i] = { kind: 'num', value: val }; };
        setSlot(0, r); setSlot(1, g); setSlot(2, b);
        H.pushUndo();
        return true;
      } } },
      { text: ' ' + t('props.opacity') + ' ' },
      { slot: { ref: slotRef(() => s.slots[3], v => { s.slots[3] = v; }, T_SCALAR), type: T_SCALAR, label: '' } },
    ];
  }
  const label = t(STMT_BLOCKS[s.kind].label) + ' ';
  const slotType = (s.kind === 'pos_vec' || s.kind === 'vel_vec') ? T_VEC : T_SCALAR;
  const getExpr = () => s.expr;
  const setExpr = (v) => { s.expr = v; };
  return [
    { text: label },
    { slot: { ref: slotRef(getExpr, setExpr, slotType), type: slotType, label: '' } },
  ];
}

function layoutSimpleStmt(s, x, y, out, ctx, opts) {
  const seg = [];
  const children = [];
  const flow = inlineFlow(stmtParts(s), x + STMT_PAD_X, y + STMT_PAD_Y, children, seg, ctx);
  const w = flow.w + STMT_PAD_X * 2;
  const h = Math.max(EXPR_H, flow.h + STMT_PAD_Y * 2);
  out.push({ kind: 'stmt', shape: 'stmt', cls: stmtCls(s), stmt: s, x, y, w, h, segments: seg, noBump: !!(opts && opts.noBump) });
  for (const c of children) out.push(c);
  return { w, h };
}

function layoutBigStmt(s, x, y, out, ctx, opts) {
  const seg = [];
  const children = [];
  const head = t(STMT_BLOCKS[s.kind].label);
  const headW = textW(ctx, head, FONT);
  const padX = STMT_PAD_X, padY = STMT_PAD_Y;
  let maxW = headW;
  const rows = [];
  const spec = STMT_SLOTS[s.kind] || [];
  let cy = y + padY + TEXT_H;
  spec.forEach((sl, i) => {
    const lab = t(sl[0]);
    const lw = textW(ctx, lab, FONT);
    const slotRes = layoutSlot(slotRef(() => s.slots[i], v => { s.slots[i] = v; }, sl[1]), sl[1], '', x + padX + lw + 6, cy, children, ctx);
    rows.push({ lab, lx: x + padX, slot: slotRes, y: cy });
    maxW = Math.max(maxW, lw + 6 + slotRes.w);
    cy += Math.max(EXPR_H, slotRes.h) + 3;
  });
  const w = maxW + padX * 2;
  const h = (cy - y) + padY - 3;
  seg.push({ text: head, x: x + padX, y: y + padY + TEXT_H / 2, font: FONT });
  for (const r of rows) {
    seg.push({ text: r.lab, x: r.lx, y: r.y + EXPR_H / 2, font: FONT });
  }
  out.push({ kind: 'stmt', shape: 'stmt', cls: stmtCls(s), stmt: s, x, y, w, h, segments: seg, noBump: !!(opts && opts.noBump) });
  for (const c of children) out.push(c);
  return { w, h };
}

function layoutRawStmt(s, x, y, out, ctx) {
  const text = s.text || '';
  const tw = Math.max(textW(ctx, text, FONT_MONO), 80);
  const w = Math.max(140, tw + 16);
  const h = 26;
  out.push({
    kind: 'stmt', shape: 'raw', cls: 'blk-raw', stmt: s, x, y, w, h,
    edit: { kind: 'area', value: text, commit: (v) => { s.text = String(v); return true; } },
    segments: [{ text: text || '…', x: x + 8, y: y + h / 2, font: FONT_MONO }],
  });
  return { w, h };
}

function dropRegion(ref, index, x, y, w, h) {
  return { kind: 'drop', shape: 'drop', drop: { chain: ref.chain || null, frag: ref.frag || null, index }, x, y, w, h, segments: [] };
}

function ctlHeaderParts(s) {
  const P = [];
  if (s.kind === 'if') {
    P.push({ text: t('blk.stmt.if') + ' ' });
    P.push({ slot: { ref: slotRef(() => s.cond, v => { s.cond = v; }, T_ANY), type: T_ANY, label: '' } });
  } else if (s.kind === 'while') {
    P.push({ text: t('blk.stmt.while') + ' ' });
    P.push({ slot: { ref: slotRef(() => s.cond, v => { s.cond = v; }, T_ANY), type: T_ANY, label: '' } });
  } else if (s.kind === 'for') {
    P.push({ text: t('blk.stmt.for') + ' ' });
    P.push({ edit: { kind: 'text', value: s.init, commit: (v) => { s.init = String(v); return true; } } });
    P.push({ text: ' ' });
    P.push({ edit: { kind: 'text', value: s.cond, commit: (v) => { s.cond = String(v); return true; } } });
    P.push({ text: ' ' });
    P.push({ edit: { kind: 'text', value: s.inc, commit: (v) => { s.inc = String(v); return true; } } });
  } else if (s.kind === 'do') {
    P.push({ text: t('blk.stmt.do') + ' ' });
  } else if (s.kind === 'func') {
    P.push({ text: t('blk.stmt.func') + ' ' });
    P.push({ edit: { kind: 'text', value: s.name, commit: (v) => { s.name = String(v).trim(); return true; } } });
    P.push({ text: '(' });
    P.push({ edit: { kind: 'text', value: (s.params || []).join(', '), commit: (v) => { s.params = String(v).split(',').map(x => x.trim()).filter(Boolean); return true; } } });
    P.push({ text: ') ' });
  } else if (s.kind === 'global' || s.kind === 'static') {
    P.push({ text: t('blk.stmt.' + s.kind) + ' ' });
    P.push({ edit: { kind: 'text', value: s.name, commit: (v) => { s.name = String(v).trim(); return true; } } });
    if (s.expr != null) {
      P.push({ text: ' = ' });
      P.push({ slot: { ref: slotRef(() => s.expr, v => { s.expr = v; }, T_ANY), type: T_ANY, label: '' } });
    }
  } else if (s.kind === 'break') {
    P.push({ text: t('blk.stmt.break') });
  } else if (s.kind === 'continue') {
    P.push({ text: t('blk.stmt.continue') });
  } else if (s.kind === 'return') {
    P.push({ text: t('blk.stmt.return') + ' ' });
    if (s.expr != null) P.push({ slot: { ref: slotRef(() => s.expr, v => { s.expr = v; }, T_ANY), type: T_ANY, label: '' } });
  }
  return P;
}

function layoutBody(list, bx, by, out, ctx, ref) {
  const arr = list || [];
  let cy = by;
  let maxW = 0;
  if (arr.length === 0) {
    out.push(dropRegion(ref, 0, bx, cy, 200, 22));
    return { w: 200, h: 22 };
  }
  for (let i = 0; i < arr.length; i++) {
    out.push(dropRegion(ref, i, bx, cy - 5, 200, 10));
    const d = layoutStmt(arr[i], bx, cy, out, ctx, { noBump: i === 0 });
    maxW = Math.max(maxW, d.w);
    cy += d.h;
  }
  out.push(dropRegion(ref, arr.length, bx, cy - 5, 200, 10));
  return { w: maxW, h: cy - by };
}

function layoutSimpleCtl(s, x, y, out, ctx, opts) {
  const seg = [];
  const children = [];
  const flow = inlineFlow(ctlHeaderParts(s), x + STMT_PAD_X, y + STMT_PAD_Y, children, seg, ctx);
  const w = flow.w + STMT_PAD_X * 2;
  const h = Math.max(EXPR_H, flow.h + STMT_PAD_Y * 2);
  out.push({ kind: 'stmt', shape: 'stmt', cls: 'blk-ctl', stmt: s, x, y, w, h, segments: seg, noBump: !!(opts && opts.noBump) });
  for (const c of children) out.push(c);
  return { w, h };
}

function layoutCtlStmt(s, x, y, out, ctx, opts) {
  const seg = [];
  const children = [];
  const hx = x + CTL_MOUTH + CTL_PAD;
  const hy = y + CTL_PAD;
  const flow = inlineFlow(ctlHeaderParts(s), hx, hy, children, seg, ctx);
  let contentW = flow.w;
  let bodyY = hy + Math.max(EXPR_H, flow.h) + 8;
  let bodyH = 0, bodyW = 0;
  let tailY = bodyY;

  if (s.kind === 'if') {
    const b = layoutBody(s.body || [], hx + BODY_INDENT, bodyY, children, ctx, { chain: s.body });
    bodyW = b.w; bodyH = b.h;
    tailY = bodyY + bodyH;
    if (s.elseBody && s.elseBody.length) {
      children.push({ kind: 'text', shape: 'text', x: hx, y: tailY, w: 0, h: 0, segments: [{ text: t('blk.stmt.else'), x: hx, y: tailY + TEXT_H / 2, font: FONT }] });
      tailY += TEXT_H + 4;
      const e = layoutBody(s.elseBody, hx + BODY_INDENT, tailY, children, ctx, { chain: s.elseBody });
      bodyW = Math.max(bodyW, e.w);
      bodyH += (TEXT_H + 4) + e.h;
      tailY += e.h;
    }
  } else if (s.kind === 'do') {
    const b = layoutBody(s.body || [], hx + BODY_INDENT, bodyY, children, ctx, { chain: s.body });
    bodyW = b.w; bodyH = b.h;
    tailY = bodyY + bodyH;
    // do-while 尾部条件
    const tailSeg = [];
    const tailFlow = inlineFlow([
      { text: ' ' + t('blk.stmt.while') + ' ' },
      { slot: { ref: slotRef(() => s.cond, v => { s.cond = v; }, T_ANY), type: T_ANY, label: '' } },
    ], hx, tailY + 2, children, tailSeg, ctx);
    seg.push(...tailSeg);
    contentW = Math.max(contentW, tailFlow.w);
    bodyH += tailFlow.h + 4;
    tailY += tailFlow.h + 4;
  } else {
    const b = layoutBody(s.body || [], hx + BODY_INDENT, bodyY, children, ctx, { chain: s.body });
    bodyW = b.w; bodyH = b.h;
    tailY = bodyY + bodyH;
  }

  contentW = Math.max(contentW, bodyW + BODY_INDENT);
  const w = contentW + CTL_PAD * 2 + CTL_MOUTH;
  const h = (tailY - y) + CTL_PAD;
  out.push({ kind: 'stmt', shape: 'stmt', cls: 'blk-ctl', stmt: s, x, y, w, h, segments: seg, noBump: !!(opts && opts.noBump) });
  for (const c of children) out.push(c);
  return { w, h };
}

function layoutStmt(s, x, y, out, ctx, opts) {
  if (s.kind === 'raw') return layoutRawStmt(s, x, y, out, ctx);
  if (CTL_KINDS.has(s.kind)) return layoutCtlStmt(s, x, y, out, ctx, opts);
  if (SIMPLE_CTL.has(s.kind)) return layoutSimpleCtl(s, x, y, out, ctx, opts);
  if (s.kind === 'col' || s.kind === 'glow') return layoutSimpleStmt(s, x, y, out, ctx, opts);
  if (BIG_BLOCKS[s.kind]) return layoutBigStmt(s, x, y, out, ctx, opts);
  return layoutSimpleStmt(s, x, y, out, ctx, opts);
}

/* ============================ 布局：链 / 工作区 ============================ */

function layoutChain(arr, x, y, out, ctx, opts) {
  const headH = HAT_H;
  let cy = y + headH;
  let stackW = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = layoutStmt(arr[i], x, cy, out, ctx, { noBump: i === 0 });
    stackW = Math.max(stackW, d.w);
    cy += d.h;
  }
  const titleW = textW(ctx, opts.title, FONT) + 28;
  const headW = Math.max(titleW, stackW, 60);
  out.push({
    kind: 'head', shape: 'hat', head: opts.head, cls: opts.frag ? 'blk-frag' : 'blk-start',
    x, y, w: headW, h: headH,
    segments: [{ text: opts.title, x: x + 14, y: y + headH / 2, font: FONT }],
  });
  const dropRef = { chain: opts.dropRef.chain || null, frag: opts.dropRef.frag || null };
  if (arr.length === 0) {
    out.push(dropRegion(dropRef, 0, x, y + headH, Math.max(headW, 200), 22));
  } else {
    let b = y + headH;
    for (let i = 0; i < arr.length; i++) {
      out.push(dropRegion(dropRef, i, x, b - 5, Math.max(stackW, 120), 10));
      b += layoutStmtHeight(arr[i], ctx);
    }
    out.push(dropRegion(dropRef, arr.length, x, b - 5, Math.max(stackW, 120), 10));
  }
}

function layoutStmtHeight(s, ctx) {
  const tmp = [];
  return layoutStmt(s, 0, 0, tmp, ctx).h;
}

function layoutWorkspace() {
  const out = [];
  if (!H || !H.getBctx() || !S.workCtx) { S.wsRegions = out; return; }
  const bctx = H.getBctx();
  const l = bctx.layout;
  const ctx = S.workCtx;
  layoutChain(bctx.setupChain, l.setup.x, l.setup.y, out, ctx, { title: t('fx.setupBlock'), head: { key: 'setup' }, dropRef: { chain: bctx.setupChain } });
  layoutChain(bctx.chain, l.chain.x, l.chain.y, out, ctx, { title: t('blk.start'), head: { key: 'chain' }, dropRef: { chain: bctx.chain } });
  for (const f of bctx.frags) {
    layoutChain(f.stmts, f.x, f.y, out, ctx, { title: t('blk.fragment'), head: { frag: f }, frag: f, dropRef: { frag: f } });
  }
  S.wsRegions = out;
}

/* ============================ 布局：变量区 ============================ */

function layoutVars(cw) {
  const out = [];
  if (!H || !H.getBctx() || !S.workCtx) { S.varRegions = out; S.varsContentH = 0; return; }
  const bctx = H.getBctx();
  const fx = getFunction(bctx.fxId);
  const ctx = S.workCtx;
  const maxW = cw - VARS_PAD * 2;
  let x = VARS_PAD, y = VARS_PAD, rowH = 0;

  const place = (region, w) => {
    if (x + w > maxW && x > VARS_PAD) { x = VARS_PAD; y += rowH + VARS_GAP; rowH = 0; }
    region.x = x; region.y = y + (region._dy || 0);
    x += w + VARS_GAP;
    rowH = Math.max(rowH, region.h + (region._dy || 0));
    out.push(region);
  };

  // 采样数
  {
    const lab = t('blk.sampleCount');
    const val = fx ? String(fx.count) : '1';
    const lw = textW(ctx, lab, FONT);
    const eqw = textW(ctx, ' = ', FONT);
    const vw = textW(ctx, val, FONT) + 12;
    const w = 14 + lw + eqw + vw + 8;
    const row = { kind: 'var-row', shape: 'row', varRow: { kind: 'count' }, x, y, w, h: VARS_ROW_H, segments: [] };
    place(row, w);
    row.segments.push({ text: lab, x: row.x + 7, y: row.y + VARS_ROW_H / 2, font: FONT });
    row.segments.push({ text: ' = ', x: row.x + 7 + lw, y: row.y + VARS_ROW_H / 2, font: FONT });
    out.push({
      kind: 'edit', shape: 'edit', space: 'var',
      edit: { kind: 'num', value: val, commit: (v) => {
        if (!fx) return false;
        fx.count = Math.max(1, Math.round(parseInt(v) || 1));
        H.commitCount(fx);
        return true;
      } },
      x: row.x + 7 + lw + eqw, y: row.y + (VARS_ROW_H - EDIT_H) / 2, w: vw, h: EDIT_H,
      segments: [{ text: val, x: row.x + 7 + lw + eqw + 6, y: row.y + VARS_ROW_H / 2, font: FONT }],
    });
  }

  // 变量行
  for (const name of bctx.varOrder) {
    if (!(name in bctx.varExprs)) continue;
    const v = fx && fx.vars[name];
    const hasKf = v && (v.kf || []).length > 0;
    const val = Number.isFinite(bctx.varExprs[name]) ? String(bctx.varExprs[name]) : '0';
    if (hasKf) {
      const hint = tf('blk.varHasKf', name);
      const tw = textW(ctx, hint, FONT) + 12;
      const row = { kind: 'var-row', shape: 'row', varRow: { name, disabled: true }, x, y, w: tw, h: VARS_ROW_H, segments: [{ text: hint, x: x + 7, y: y + VARS_ROW_H / 2, font: FONT }] };
      place(row, tw);
      continue;
    }
    const eqw = textW(ctx, ' = ', FONT);
    const lw = textW(ctx, name, FONT) + 10;
    const vw = textW(ctx, val, FONT) + 12;
    const w = 14 + lw + eqw + vw + 8;
    const row = { kind: 'var-row', shape: 'row', varRow: { name }, x, y, w, h: VARS_ROW_H, segments: [] };
    place(row, w);
    row.segments.push({ text: ' = ', x: row.x + 7 + lw, y: row.y + VARS_ROW_H / 2, font: FONT });
    const nameEdit = {
      kind: 'edit', shape: 'edit', space: 'var',
      edit: { kind: 'text', value: name, commit: (v) => {
        const nn = String(v).trim();
        if (!nn || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(nn) || ATTR_NAMES.includes(nn) || BUILTIN_VAR_NAMES.includes(nn) || nn === name) return false;
        if (nn in bctx.varExprs) return false;
        H.pushUndo();
        H.renameVarGlobal(name, nn);
        return true;
      } },
      x: row.x + 7, y: row.y + (VARS_ROW_H - EDIT_H) / 2, w: lw, h: EDIT_H,
      segments: [{ text: name, x: row.x + 12, y: row.y + VARS_ROW_H / 2, font: FONT }],
    };
    const valEdit = {
      kind: 'edit', shape: 'edit', space: 'var',
      edit: { kind: 'num', value: val, commit: (v) => {
        const n = parseFloat(v);
        if (Number.isFinite(n)) { H.pushUndo(); bctx.varExprs[name] = n; return true; }
        return false;
      } },
      x: row.x + 7 + lw + eqw, y: row.y + (VARS_ROW_H - EDIT_H) / 2, w: vw, h: EDIT_H,
      segments: [{ text: val, x: row.x + 7 + lw + eqw + 6, y: row.y + VARS_ROW_H / 2, font: FONT }],
    };
    out.push(nameEdit, valEdit);
  }

  // 属性标签（x/y/z/…，可拖入表达式槽作为变量引用）
  for (const name of ATTR_NAMES) {
    if (name === 'glow') continue;
    const tw = textW(ctx, name, FONT) + 14;
    const tag = {
      kind: 'attr-var', shape: 'tag', attrVar: name, x, y: y, _dy: (VARS_ROW_H - ATTR_H) / 2, w: tw, h: ATTR_H,
      segments: [{ text: name, x: x + 7, y: y + VARS_ROW_H / 2, font: FONT }],
    };
    place(tag, tw);
  }

  S.varRegions = out;
  S.varsContentH = y + rowH + VARS_PAD;
}

/* ============================ 布局：调色板 ============================ */

function paletteItemSize(item, ctx) {
  const tmp = [];
  if (item.type === 'opval') {
    return { w: textW(ctx, item.op, FONT) + 16, h: EXPR_H };
  }
  if (item.type === 'stmt') {
    const d = layoutStmt(H.newStmtNode(item.kind), 0, 0, tmp, ctx);
    return { w: d.w, h: d.h };
  }
  const d = layoutExpr(H.newExprNodeFromTemplate(item.template), 0, 0, tmp, ctx);
  return { w: d.w, h: d.h };
}

function layoutPalette(contentW) {
  const out = [];
  if (!H || !S.palCtx) { S.palRegions = out; return; }
  const ctx = S.palCtx;
  let cy = PAL_TOP;
  const innerW = contentW - PAL_LEFT * 2;
  for (const g of PALETTE_GROUPS) {
    out.push({ kind: 'pal-title', shape: 'title', x: PAL_LEFT, y: cy, w: 0, h: 20, segments: [{ text: t(g.label), x: PAL_LEFT, y: cy + 10, font: FONT }] });
    cy += 24;
    const items = H.buildPaletteGroup(g);
    let rx = PAL_LEFT, rowH = 0;
    for (const item of items) {
      const d = paletteItemSize(item, ctx);
      if (rx + d.w > PAL_LEFT + innerW && rx > PAL_LEFT) { cy += rowH + PAL_GAP; rx = PAL_LEFT; rowH = 0; }
      out.push({ kind: 'pal-item', shape: 'pal-item', item, x: rx, y: cy, w: d.w, h: d.h, segments: [] });
      rx += d.w + PAL_GAP;
      rowH = Math.max(rowH, d.h);
    }
    cy += rowH + 10;
  }
  S.palRegions = out;
}

/* ============================ 绘制 ============================ */

function drawSegments(ctx, segs, color) {
  for (const s of segs || []) {
    ctx.font = s.font || FONT;
    ctx.fillStyle = color || '#fff';
    ctx.textAlign = s.align || 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.text, s.x, s.y);
  }
}

function drawHighlight(ctx, region, color, scale) {
  ctx.save();
  ctx.strokeStyle = color || 'rgba(255,255,255,0.5)';
  ctx.lineWidth = (scale || 1) * 2;
  if (region.shape === 'bool') hexPath(ctx, region.x - 3, region.y - 3, region.w + 6, region.h + 6);
  else rrPath(ctx, region.x - 3, region.y - 3, region.w + 6, region.h + 6, 8);
  ctx.stroke();
  ctx.restore();
}

function strokeRegionSegments(ctx, r, strokeStyle, segColor) {
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = 1;
  ctx.stroke();
  drawSegments(ctx, r.segments, segColor);
  ctx.restore();
}

function drawExprRegion(ctx, r) {
  ctx.save();
  if (S.edit && S.edit.region === r) {
    // 数字等表达式进入编辑态时，使用与文本输入框一致的样式：灰底小圆角 + 下虚线 + 光标
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    rrPath(ctx, r.x, r.y, r.w, r.h, 4);
    ctx.fill();
    drawInlineEditContent(ctx, r, S.edit.buffer);
    ctx.restore();
    return;
  }
  const color = blockColor(r.cls);
  ctx.fillStyle = color;
  if (r.shape === 'bool') hexPath(ctx, r.x, r.y, r.w, r.h);
  else capsulePath(ctx, r.x, r.y, r.w, r.h);
  ctx.fill();
  strokeRegionSegments(ctx, r, 'rgba(0,0,0,0.25)', '#fff');
}

function drawStmtRegion(ctx, r) {
  const color = blockColor(r.cls);
  ctx.save();
  ctx.fillStyle = color;
  if (r.shape === 'raw') rrPath(ctx, r.x, r.y, r.w, r.h, 6);
  else stmtPath(ctx, r.x, r.y, r.w, r.h, !!r.noBump);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 1;
  ctx.stroke();
  if (S.edit && S.edit.region === r) drawInlineEditContent(ctx, r, S.edit.buffer);
  else drawSegments(ctx, r.segments, '#fff');
  ctx.restore();
}

function drawHeadRegion(ctx, r) {
  const color = blockColor(r.cls);
  ctx.save();
  ctx.fillStyle = color;
  hatPath(ctx, r.x, r.y, r.w, r.h);
  ctx.fill();
  strokeRegionSegments(ctx, r, 'rgba(0,0,0,0.25)', '#fff');
}

function drawSlotRegion(ctx, r) {
  if (r.shape === 'slot-hidden') return;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.14)';
  rrPath(ctx, r.x, r.y, r.w, r.h, 7);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);
  drawSegments(ctx, r.segments, 'rgba(255,255,255,0.6)');
  ctx.restore();
}

function drawOpRegion(ctx, r) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  rrPath(ctx, r.x, r.y, r.w, r.h, 5);
  ctx.fill();
  drawSegments(ctx, r.segments, '#fff');
  ctx.restore();
}

function drawAppendRegion(ctx, r) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  rrPath(ctx, r.x, r.y, r.w, r.h, 5);
  ctx.stroke();
  ctx.setLineDash([]);
  drawSegments(ctx, r.segments, 'rgba(255,255,255,0.6)');
  ctx.restore();
}

function drawInlineEditContent(ctx, r, text) {
  const font = (r.segments && r.segments[0] && r.segments[0].font) || FONT;
  ctx.font = font;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const tx = r.x + 4;
  const ty = r.y + r.h / 2;
  if (S.edit && S.edit.region === r) {
    const s0 = Math.min(S.edit.selStart, S.edit.selEnd);
    const s1 = Math.max(S.edit.selStart, S.edit.selEnd);
    if (s0 !== s1) {
      const w0 = ctx.measureText(text.slice(0, s0)).width;
      const w1 = ctx.measureText(text.slice(0, s1)).width;
      ctx.fillStyle = 'rgba(91,157,255,0.45)';
      ctx.fillRect(tx + w0, r.y + 2, w1 - w0, r.h - 4);
    }
  }
  ctx.fillStyle = '#fff';
  ctx.fillText(text, tx, ty);
  if (S.edit && S.edit.region === r && (typeof Date === 'undefined' || Math.floor(Date.now() / 500) % 2 === 0)) {
    const cursor = Math.min(text.length, S.edit.selEnd);
    const cw = ctx.measureText(text.slice(0, cursor)).width;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tx + cw + 1, r.y + 3);
    ctx.lineTo(tx + cw + 1, r.y + r.h - 3);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.setLineDash([3, 2]);
  ctx.lineWidth = 1;
  ctx.moveTo(r.x + 3, r.y + r.h - 2);
  ctx.lineTo(r.x + r.w - 3, r.y + r.h - 2);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawEditRegion(ctx, r) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  rrPath(ctx, r.x, r.y, r.w, r.h, 4);
  ctx.fill();
  const text = (S.edit && S.edit.region === r) ? S.edit.buffer : ((r.segments && r.segments[0]) ? r.segments[0].text : '');
  drawInlineEditContent(ctx, r, text);
  ctx.restore();
}

function drawAttrRegion(ctx, r) {
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  rrPath(ctx, r.x, r.y, r.w, r.h, 5);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1;
  ctx.stroke();
  drawSegments(ctx, r.segments, '#fff');
  ctx.restore();
}

function drawToggleRegion(ctx, r) {
  const on = r.toggle && r.toggle.stmt && r.toggle.stmt.on;
  ctx.save();
  ctx.fillStyle = on ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.25)';
  rrPath(ctx, r.x, r.y, r.w, r.h, 8);
  ctx.fill();
  drawSegments(ctx, r.segments, on ? '#222' : 'rgba(255,255,255,0.9)');
  ctx.restore();
}

function drawColorRegion(ctx, r) {
  ctx.save();
  const hex = r.color && r.color.hex ? r.color.hex() : '#808080';
  ctx.fillStyle = hex;
  rrPath(ctx, r.x, r.y, r.w, r.h, 4);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function drawCompRegion(ctx, r) {
  ctx.save();
  drawSegments(ctx, r.segments, '#fff');
  ctx.restore();
}

function drawDropRegion(ctx, r, th) {
  // 块与块之间的落点区域不再常驻绘制虚线提示框；仅在拖拽经过时显示高亮目标。
  const active = th && th.region === r;
  if (!active) return;
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1;
  rrPath(ctx, r.x, r.y, r.w, r.h, 3);
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function drawVarRowRegion(ctx, r) {
  ctx.save();
  const disabled = r.varRow && r.varRow.disabled;
  ctx.fillStyle = disabled ? 'rgba(0,0,0,0.18)' : 'rgba(47,52,64,0.9)';
  rrPath(ctx, r.x, r.y, r.w, r.h, 6);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.stroke();
  drawSegments(ctx, r.segments, disabled ? 'rgba(139,147,167,0.9)' : '#fff');
  ctx.restore();
}

function drawTitleRegion(ctx, r) {
  ctx.save();
  drawSegments(ctx, r.segments, 'rgba(139,147,167,1)');
  ctx.restore();
}

function drawRegion(ctx, r, th) {
  switch (r.kind) {
    case 'expr': drawExprRegion(ctx, r); break;
    case 'stmt': drawStmtRegion(ctx, r); break;
    case 'head': drawHeadRegion(ctx, r); break;
    case 'slot': drawSlotRegion(ctx, r); break;
    case 'op': drawOpRegion(ctx, r); break;
    case 'append': drawAppendRegion(ctx, r); break;
    case 'edit': drawEditRegion(ctx, r); break;
    case 'attr': drawAttrRegion(ctx, r); break;
    case 'toggle': drawToggleRegion(ctx, r); break;
    case 'color': drawColorRegion(ctx, r); break;
    case 'comp': drawCompRegion(ctx, r); break;
    case 'drop': drawDropRegion(ctx, r, th); break;
    case 'var-row': drawVarRowRegion(ctx, r); break;
    case 'attr-var': drawAttrRegion(ctx, r); break;
    case 'pal-title': drawTitleRegion(ctx, r); break;
    case 'pal-item': drawPalItemRegion(ctx, r); break;
    case 'text': drawSegments(ctx, r.segments, '#fff'); break;
  }
}

function drawPalItemRegion(ctx, r) {
  const tmp = [];
  const item = r.item;
  if (item.type === 'opval') {
    ctx.save();
    ctx.fillStyle = blockColor('blk-math');
    capsulePath(ctx, r.x, r.y, r.w, r.h);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();
    drawSegments(ctx, [{ text: item.op, x: r.x + r.w / 2, y: r.y + r.h / 2, font: FONT, align: 'center' }], '#fff');
    ctx.restore();
    return;
  }
  const node = item.type === 'stmt' ? H.newStmtNode(item.kind) : H.newExprNodeFromTemplate(item.template);
  if (item.type === 'stmt') layoutStmt(node, r.x, r.y, tmp, ctx);
  else layoutExpr(node, r.x, r.y, tmp, ctx);
  for (const reg of tmp) drawRegion(ctx, reg, null);
}

/* ============================ 渲染 ============================ */

function clearCanvas(ctx, c, color) {
  if (!ctx || !c) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
}

function renderPaletteCanvas() {
  const ctx = S.palCtx, c = S.palCanvas;
  if (!ctx || !c) return;
  const th = theme();
  const cw = c.clientWidth || c.width;
  const ch = c.clientHeight || c.height;
  clearCanvas(ctx, c, th.panel2);
  if (!H || !H.getBctx()) return;
  layoutPalette(cw / PAL_SCALE);
  ctx.setTransform(S.dpr * PAL_SCALE, 0, 0, S.dpr * PAL_SCALE, S.dpr * PAL_LEFT, S.dpr * (PAL_TOP - S.palScroll));
  const visTop = S.palScroll / PAL_SCALE - 40;
  const visBot = (S.palScroll + ch) / PAL_SCALE + 40;
  for (const r of S.palRegions) {
    if (r.kind === 'pal-item' && (r.y + r.h < visTop || r.y > visBot)) continue;
    drawRegion(ctx, r, null);
  }
  if (S.hover && S.hover.kind === 'pal-item') {
    const r = S.hover;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    rrPath(ctx, r.x - 2, r.y - 2, r.w + 4, r.h + 4, 6);
    ctx.stroke();
  }
}

function renderWorkCanvas() {
  const ctx = S.workCtx, c = S.workCanvas;
  if (!ctx || !c) return;
  const th = theme();
  const cw = c.clientWidth || c.width;
  const ch = c.clientHeight || c.height;
  clearCanvas(ctx, c, th.bg);
  if (!H || !H.getBctx()) return;
  const bctx = H.getBctx();
  const v = bctx.layout.view;
  const scale = v.scale;

  ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  const gs = 22 * scale;
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  const ox = ((v.x % gs) + gs) % gs;
  const oy = ((v.y % gs) + gs) % gs;
  for (let gx = ox; gx < cw; gx += gs) {
    for (let gy = oy; gy < ch - VARS_H; gy += gs) {
      ctx.beginPath();
      ctx.arc(gx, gy, 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 编辑态复用上一次布局，避免重排导致 S.edit.region 失配（输入变化通过 S.edit.buffer 直接显示）
  if (!S.edit) layoutWorkspace();
  ctx.setTransform(S.dpr * scale, 0, 0, S.dpr * scale, S.dpr * v.x, S.dpr * v.y);
  for (const r of S.wsRegions) if (r.kind === 'head') drawRegion(ctx, r, null);
  for (const r of S.wsRegions) if (r.kind !== 'drop' && r.kind !== 'head') drawRegion(ctx, r, null);
  // 可放置区域画在拼图上层，避免被积木遮挡
  for (const r of S.wsRegions) if (r.kind === 'drop') drawRegion(ctx, r, S.dropHover);

  if (S.dropHover && S.dropHover.region && S.dropHover.region.kind !== 'drop') {
    const r = S.dropHover.region;
    drawHighlight(ctx, r, S.dropHover.valid ? 'rgba(255,255,255,0.85)' : 'rgba(255,107,107,0.9)', 1 / scale);
  }

  // Scratch 式落点预览：在有效语句落点处画一个占位块
  if (S.dropHover && S.dropHover.valid && S.dropHover.region && S.dropHover.region.kind === 'drop' && S.dropHover.previewH) {
    const r = S.dropHover.region;
    const ph = S.dropHover.previewH;
    // 插入点与落点带上边缘对齐（普通落点带高 10，边界在其中心；空链落点带从其上边缘开始）
    const py = r.h > 12 ? r.y + r.h / 2 : r.y;
    ctx.save();
    ctx.fillStyle = 'rgba(91,157,255,0.16)';
    ctx.strokeStyle = 'rgba(91,157,255,0.85)';
    ctx.lineWidth = 1.5 / scale;
    rrPath(ctx, r.x, py, Math.max(r.w, 120), ph, 8);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  renderVars(ctx, cw, ch, th);
}

function renderVars(ctx, cw, ch, th) {
  const varTop = ch - VARS_H;
  ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  ctx.fillStyle = 'rgba(18,20,26,0.88)';
  ctx.fillRect(0, varTop, cw, VARS_H);
  ctx.strokeStyle = th.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, varTop + 0.5);
  ctx.lineTo(cw, varTop + 0.5);
  ctx.stroke();

  // 编辑态复用上一次变量区布局，保证 S.edit.region 仍能命中重绘
  if (!S.edit) layoutVars(cw);
  const scroll = Math.max(0, Math.min(S.varsScroll, Math.max(0, S.varsContentH - VARS_H)));
  S.varsScroll = scroll;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, varTop, cw, VARS_H);
  ctx.clip();
  ctx.translate(0, varTop - scroll);
  for (const r of S.varRegions) drawRegion(ctx, r, null);
  ctx.restore();
}

function renderEchoCanvas() {
  const ctx = S.echoCtx, c = S.echoCanvas;
  if (!ctx || !c) return;
  const th = theme();
  const cw = c.clientWidth || c.width;
  const ch = c.clientHeight || c.height;
  clearCanvas(ctx, c, th.panel);
  if (!H || !H.getBctx()) return;
  const code = statementsToCode(H.getBctx().chain) || '';
  const font = FONT_MONO;
  ctx.font = font;
  const lh = 16;
  const maxW = cw - 20;
  const lines = [];
  for (const raw of code.split('\n')) {
    if (raw === '') { lines.push(''); continue; }
    let cur = '';
    for (const word of raw.split('')) {
      if (cur && ctx.measureText(cur + word).width > maxW) { lines.push(cur); cur = word; }
      else cur += word;
    }
    lines.push(cur);
  }
  const contentH = lines.length * lh + 20;
  const maxScroll = Math.max(0, contentH - ch);
  S.echoScroll = Math.max(0, Math.min(S.echoScroll, maxScroll));
  ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, cw, ch);
  ctx.clip();
  ctx.translate(0, -S.echoScroll);
  ctx.fillStyle = th.muted;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  lines.forEach((ln, i) => ctx.fillText(ln, 10, 10 + i * lh));
  ctx.restore();
}

function renderGhost() {
  const ctx = S.ghostCtx, c = S.ghostCanvas;
  if (!ctx || !c) return;
  clearCanvas(ctx, c, 'rgba(0,0,0,0)');
  ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);

  if (S.lens) {
    ctx.font = '22px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🔍', S.lens.x, S.lens.y);
    if (S.lens.info) {
      const info = S.lens.info;
      ctx.font = FONT;
      const tw = ctx.measureText(info).width;
      const bx = S.lens.x + 14, by = S.lens.y + 14;
      ctx.fillStyle = 'rgba(47,52,64,0.97)';
      rrPath(ctx, bx, by, tw + 20, 30, 6);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(info, bx + 10, by + 15);
    }
    return;
  }

  const d = S.drag;
  if (!d || d.mode !== 'ghost') return;
  const gx = d.curX - d.grabDx;
  const gy = d.curY - d.grabDy;
  const scale = d.ghostScale || 1;
  ctx.save();
  ctx.setTransform(S.dpr * scale, 0, 0, S.dpr * scale, S.dpr * gx, S.dpr * gy);

  if (d.source.type === 'stmt-group') {
    const tmp = [];
    let cy = 0;
    for (const s of d.source.group) {
      const dd = layoutStmt(s, 0, cy, tmp, ctx);
      cy += dd.h;
    }
    for (const r of tmp) drawRegion(ctx, r, null);
  } else if (d.source.type === 'opval' || d.source.type === 'op-remove') {
    const op = d.source.type === 'opval' ? d.source.op : d.source.chain.ops[d.source.index];
    const tw = textW(ctx, op, FONT) + 16;
    ctx.fillStyle = blockColor('blk-math');
    capsulePath(ctx, 0, 0, tw, EXPR_H);
    ctx.fill();
    drawSegments(ctx, [{ text: op, x: tw / 2, y: EXPR_H / 2, font: FONT, align: 'center' }], '#fff');
  } else if (d.source.type === 'expr') {
    const tmp = [];
    layoutExpr(d.source.node, 0, 0, tmp, ctx);
    for (const r of tmp) drawRegion(ctx, r, null);
  } else if (d.source.type === 'palette') {
    const tmp = [];
    const node = d.source.stmt ? H.newStmtNode(d.source.stmtKind) : H.newExprNodeFromTemplate(d.source.template);
    if (d.source.stmt) layoutStmt(node, 0, 0, tmp, ctx);
    else layoutExpr(node, 0, 0, tmp, ctx);
    for (const r of tmp) drawRegion(ctx, r, null);
  }
  ctx.restore();
}

/* ============================ 命中检测 ============================ */

function contains(r, px, py) {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

function hitPalette(mx, my) {
  if (!S.palCanvas) return null;
  const cx = (mx - PAL_LEFT) / PAL_SCALE;
  const cy = (my - PAL_TOP + S.palScroll) / PAL_SCALE;
  let item = null;
  for (const r of S.palRegions) {
    if (r.kind === 'pal-item' && contains(r, cx, cy)) item = r;
  }
  if (!item) return null;
  const rect = S.palCanvas.getBoundingClientRect();
  item.sx = rect.left + (item.x * PAL_SCALE + PAL_LEFT);
  item.sy = rect.top + (item.y * PAL_SCALE + PAL_TOP - S.palScroll);
  item.sw = item.w * PAL_SCALE;
  item.sh = item.h * PAL_SCALE;
  return item;
}

function hitVars(mx, my) {
  if (!S.workCanvas) return null;
  const c = S.workCanvas;
  const ch = c.clientHeight || c.height;
  const varTop = ch - VARS_H;
  if (my < varTop) return null;
  const ly = my - varTop + S.varsScroll;
  for (let i = S.varRegions.length - 1; i >= 0; i--) {
    const r = S.varRegions[i];
    if (contains(r, mx, ly)) return r;
  }
  return null;
}

function hitWorkspace(mx, my, dropMode) {
  if (!H || !H.getBctx() || !S.workCanvas) return { kind: 'blank', wx: 0, wy: 0 };
  const bctx = H.getBctx();
  const v = bctx.layout.view;
  const wx = (mx - v.x) / v.scale;
  const wy = (my - v.y) / v.scale;

  if (dropMode) {
    // 正向遍历优先命中最内层槽（拖到嵌套表达式内部时进入内部槽，而不是替换整个外层块）
    for (let i = 0; i < S.wsRegions.length; i++) {
      const r = S.wsRegions[i];
      if ((r.kind === 'slot' || r.kind === 'op' || r.kind === 'append') && contains(r, wx, wy)) return r;
    }
    for (let i = S.wsRegions.length - 1; i >= 0; i--) {
      const r = S.wsRegions[i];
      if (r.kind === 'drop' && contains(r, wx, wy)) return r;
    }
    return { kind: 'blank', wx, wy };
  }
  for (let i = S.wsRegions.length - 1; i >= 0; i--) {
    const r = S.wsRegions[i];
    if (r.kind === 'drop') continue;
    if (r.kind === 'slot' && r.shape === 'slot-hidden') continue;
    if (contains(r, wx, wy)) return r;
  }
  return { kind: 'blank', wx, wy };
}

function dragPreviewH(source) {
  if (!S.workCtx) return 20;
  if (source.type === 'palette' && source.stmt) {
    try { return Math.max(20, layoutStmtHeight(H.newStmtNode(source.stmtKind), S.workCtx)); } catch (e) { return 20; }
  }
  if (source.type === 'stmt-group' && Array.isArray(source.group)) {
    let h = 0;
    for (const s of source.group) {
      try { h += layoutStmtHeight(s, S.workCtx); } catch (e) { h += 20; }
    }
    return Math.max(20, h);
  }
  return 20;
}

function nearestDropWorld(gx, gy, scale) {
  let best = null, bestD = 36 / scale;
  for (const r of S.wsRegions) {
    if (r.kind !== 'drop') continue;
    const dy = Math.abs(gy - (r.y + r.h / 2));
    const dx = Math.abs(gx - r.x);
    if (dy < bestD && dx < 160 / scale) { bestD = dy; best = r; }
  }
  return best;
}

function worldToScreenRect(r) {
  const bctx = H.getBctx();
  const v = bctx.layout.view;
  const rect = S.workCanvas.getBoundingClientRect();
  return {
    left: rect.left + r.x * v.scale + v.x,
    top: rect.top + r.y * v.scale + v.y,
    width: r.w * v.scale,
    height: r.h * v.scale,
  };
}

/* ============================ 编辑浮层 ============================ */

let editBlinkTimer = null;
function beginInlineEdit(region, editOverride) {
  const edit = editOverride || (region && region.edit);
  if (!region || !edit) return;
  if (S.edit) commitEdit();
  S.edit = {
    region,
    edit,
    kind: edit.kind,
    buffer: String(edit.value == null ? '' : edit.value),
    selStart: 0,
    selEnd: 0,
  };
  S.edit.selStart = S.edit.buffer.length;
  S.edit.selEnd = S.edit.buffer.length;
  if (editBlinkTimer == null && typeof setInterval === 'function') {
    editBlinkTimer = setInterval(() => { if (S.edit) puzzleCanvasRender(); }, 500);
  }
  puzzleCanvasRender();
}
function stopEditTimer() {
  if (editBlinkTimer != null) {
    if (typeof clearInterval === 'function') clearInterval(editBlinkTimer);
    editBlinkTimer = null;
  }
}
function commitEdit() {
  if (!S.edit) return;
  const edit = S.edit;
  S.edit = null;
  stopEditTimer();
  const ok = edit.edit.commit(edit.buffer) !== false;
  if (ok && H) H.refreshPreview();
  puzzleCanvasRender();
}
function cancelEdit() {
  if (!S.edit) return;
  S.edit = null;
  S.editMouse = null;
  stopEditTimer();
  puzzleCanvasRender();
}

function editClamp(i) { return Math.max(0, Math.min(S.edit.buffer.length, i)); }
function setEditSel(s, e) {
  S.edit.selStart = editClamp(s);
  S.edit.selEnd = (e == null) ? S.edit.selStart : editClamp(e);
}
function editSelectedRange() {
  return [Math.min(S.edit.selStart, S.edit.selEnd), Math.max(S.edit.selStart, S.edit.selEnd)];
}
function editReplace(text) {
  const [s, e] = editSelectedRange();
  S.edit.buffer = S.edit.buffer.slice(0, s) + text + S.edit.buffer.slice(e);
  setEditSel(s + text.length, s + text.length);
}
function editDeleteBack() {
  const [s, e] = editSelectedRange();
  if (s !== e) { S.edit.buffer = S.edit.buffer.slice(0, s) + S.edit.buffer.slice(e); setEditSel(s, s); }
  else if (s > 0) { S.edit.buffer = S.edit.buffer.slice(0, s - 1) + S.edit.buffer.slice(s); setEditSel(s - 1, s - 1); }
}
function editDeleteFwd() {
  const [s, e] = editSelectedRange();
  if (s !== e) { S.edit.buffer = S.edit.buffer.slice(0, s) + S.edit.buffer.slice(e); setEditSel(s, s); }
  else if (e < S.edit.buffer.length) { S.edit.buffer = S.edit.buffer.slice(0, e) + S.edit.buffer.slice(e + 1); setEditSel(e, e); }
}
function editMoveCursor(step, extend) {
  const len = S.edit.buffer.length;
  const [s, e] = editSelectedRange();
  if (step < 0) {
    if (!extend) setEditSel((s !== e) ? s : Math.max(0, e - 1), (s !== e) ? s : Math.max(0, e - 1));
    else setEditSel(s, Math.max(0, e - 1));
  } else {
    if (!extend) setEditSel((s !== e) ? e : Math.min(len, e + 1), (s !== e) ? e : Math.min(len, e + 1));
    else setEditSel(s, Math.min(len, e + 1));
  }
}
function editMoveHome(extend) {
  if (extend) setEditSel(0, S.edit.selEnd);
  else setEditSel(0, 0);
}
function editMoveEnd(extend) {
  if (extend) setEditSel(S.edit.selStart, S.edit.buffer.length);
  else setEditSel(S.edit.buffer.length, S.edit.buffer.length);
}
function editIndexAtX(region, space, mx) {
  const text = S.edit.buffer;
  const font = (region.segments && region.segments[0] && region.segments[0].font) || FONT;
  const ctx = S.workCtx;
  if (!ctx || !ctx.measureText) return text.length;
  ctx.font = font;
  let px = mx;
  if (space !== 'var') {
    const v = H.getBctx().layout.view;
    px = (mx - v.x) / v.scale;
  }
  const tx = region.x + 4;
  let idx = text.length;
  for (let i = 0; i <= text.length; i++) {
    if (tx + ctx.measureText(text.slice(0, i)).width > px) { idx = i; break; }
  }
  return Math.max(0, Math.min(text.length, idx));
}
function copyText(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  } catch (e) { /* 剪贴板不可用时忽略 */ }
}
async function pasteText() {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard || !navigator.clipboard.readText) return;
    const text = await navigator.clipboard.readText();
    if (!S.edit) return;
    const filtered = S.edit.kind === 'num' ? text.split('').filter(c => /[0-9.\-]/.test(c)).join('') : text;
    if (filtered) editReplace(filtered);
    puzzleCanvasRender();
  } catch (e) { /* 剪贴板不可用时忽略 */ }
}

function openColorEdit(region) {
  if (!region || !region.color) return;
  const rect = worldToScreenRect(region);
  const input = document.createElement('input');
  input.type = 'color';
  input.className = 'pc-color-input';
  input.value = region.color.hex ? region.color.hex() : '#808080';
  input.style.left = rect.left + 'px';
  input.style.top = rect.top + 'px';
  input.style.width = rect.width + 'px';
  input.style.height = rect.height + 'px';
  document.body.appendChild(input);
  const cleanup = () => { if (input.parentNode) input.parentNode.removeChild(input); };
  input.addEventListener('input', () => {
    if (region.color.commit) {
      const ok = region.color.commit(input.value) !== false;
      if (ok) { H.refreshPreview(); puzzleCanvasRender(); }
    }
  });
  input.addEventListener('change', cleanup);
  input.addEventListener('blur', cleanup);
}

/* ============================ 拖拽 ============================ */

function startGhostDrag(source, e, grabDx, grabDy, ghostScale) {
  S.drag = {
    mode: 'ghost',
    source,
    startX: e.clientX, startY: e.clientY, curX: e.clientX, curY: e.clientY,
    grabDx, grabDy, ghostScale,
    started: false, target: null, valid: false,
  };
}

function startPaletteDrag(item, e) {
  const p = item.item;
  let source;
  if (p.type === 'opval') {
    source = { type: 'opval', op: p.op };
  } else {
    source = { type: 'palette', stmt: p.type === 'stmt', stmtKind: p.kind, template: p.template };
  }
  startGhostDrag(source, e, e.clientX - item.sx, e.clientY - item.sy, PAL_SCALE);
  renderGhost();
}

function startExprDrag(r, e) {
  const rect = worldToScreenRect(r);
  startGhostDrag({ type: 'expr', node: r.node, region: r, detach: H.findExprDetach(r.node) }, e, e.clientX - rect.left, e.clientY - rect.top, H.getBctx().layout.view.scale);
  renderGhost();
}

function startOpRemove(r, e) {
  const rect = worldToScreenRect(r);
  startGhostDrag({ type: 'op-remove', chain: r.opSlot.chain, index: r.opSlot.index }, e, e.clientX - rect.left, e.clientY - rect.top, H.getBctx().layout.view.scale);
  renderGhost();
}

function startStmtGroupPending(r, e) {
  const rect = worldToScreenRect(r);
  const loc = H.stmtGroupLocation(r.stmt);
  if (!loc) return;
  S.drag = {
    mode: 'stmt-group-pending',
    source: { type: 'stmt-group-pending', stmt: r.stmt, loc },
    startX: e.clientX, startY: e.clientY, curX: e.clientX, curY: e.clientY,
    grabDx: e.clientX - rect.left, grabDy: e.clientY - rect.top,
    ghostScale: H.getBctx().layout.view.scale,
    target: null, valid: false,
  };
}

function startChainMove(r, e) {
  const key = r.head.key;
  const pos = H.getBctx().layout[key] || H.getBctx().layout.chain;
  S.drag = { mode: 'chain-move', key, startX: e.clientX, startY: e.clientY, lx: pos.x, ly: pos.y };
}
function startFragMove(r, e) {
  const f = r.head.frag;
  S.drag = { mode: 'frag-move', frag: f, startX: e.clientX, startY: e.clientY, lx: f.x, ly: f.y };
}

function startPan(e) {
  const v = H.getBctx().layout.view;
  S.drag = { mode: 'pan', startX: e.clientX, startY: e.clientY, lx: v.x, ly: v.y };
  if (S.workCanvas.setPointerCapture) S.workCanvas.setPointerCapture(e.pointerId);
}

function computeDropTarget(e) {
  const d = S.drag;
  const src = d.source;
  S.dropHover = null;
  d.target = null;
  d.valid = false;

  const palRect = S.palCanvas && S.palCanvas.getBoundingClientRect();
  if (palRect && e.clientX >= palRect.left && e.clientX <= palRect.right && e.clientY >= palRect.top && e.clientY <= palRect.bottom) {
    if (src.type === 'expr' || src.type === 'op-remove' || src.type === 'stmt-group') {
      d.target = { kind: 'delete' };
      d.valid = true;
    }
    return;
  }

  if (!S.workCanvas) return;
  const rect = S.workCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const ch = S.workCanvas.clientHeight || S.workCanvas.height;
  const hit = (my < ch - VARS_H) ? hitWorkspace(mx, my, true) : { kind: 'blank', wx: (mx - H.getBctx().layout.view.x) / H.getBctx().layout.view.scale, wy: (my - H.getBctx().layout.view.y) / H.getBctx().layout.view.scale };

  if (hit.kind === 'op') {
    d.target = { kind: 'op-slot', ref: hit.opSlot };
    d.valid = src.type === 'opval';
    S.dropHover = { region: hit, valid: d.valid };
    return;
  }
  if (hit.kind === 'append') {
    d.target = { kind: 'chain-append', ref: hit.chainAppend };
    d.valid = (src.type === 'opval' || src.type === 'expr' || (src.type === 'palette' && !src.stmt));
    S.dropHover = { region: hit, valid: d.valid };
    return;
  }
  if (hit.kind === 'slot') {
    d.target = { kind: 'slot', ref: hit.ref, slotType: hit.slotType };
    d.valid = H.canPlaceIntoTarget(hit.slotType, d.source);
    S.dropHover = { region: hit, valid: d.valid };
    return;
  }
  if (src.type === 'palette' || src.type === 'stmt-group') {
    const view = H.getBctx().layout.view;
    const gx = (e.clientX - rect.left - d.grabDx - view.x) / view.scale;
    const gy = (e.clientY - rect.top - d.grabDy - view.y) / view.scale;
    const nearest = nearestDropWorld(gx, gy, view.scale);
    if (nearest) {
      d.target = { kind: 'stmt-drop', drop: nearest.drop };
      d.valid = src.type === 'palette' ? src.stmt : true;
      S.dropHover = { region: nearest, valid: d.valid, previewH: dragPreviewH(src) };
      return;
    }
  }
  if (hit.kind === 'blank') {
    if (src.stmt || src.type === 'stmt-group') {
      const view = H.getBctx().layout.view;
      const gx = (e.clientX - rect.left - d.grabDx - view.x) / view.scale;
      const gy = (e.clientY - rect.top - d.grabDy - view.y) / view.scale;
      d.target = { kind: 'blank', x: gx, y: gy };
      d.valid = true;
    }
    return;
  }
}

function updateDrag(e) {
  const d = S.drag;
  if (!d) return;
  d.curX = e.clientX; d.curY = e.clientY;
  if (d.mode === 'pan') {
    const v = H.getBctx().layout.view;
    v.x = d.lx + (e.clientX - d.startX);
    v.y = d.ly + (e.clientY - d.startY);
    puzzleCanvasRender();
    return;
  }
  if (d.mode === 'chain-move') {
    const pos = H.getBctx().layout[d.key] || H.getBctx().layout.chain;
    const scale = H.getBctx().layout.view.scale || 1;
    pos.x = d.lx + (e.clientX - d.startX) / scale;
    pos.y = d.ly + (e.clientY - d.startY) / scale;
    puzzleCanvasRender();
    return;
  }
  if (d.mode === 'frag-move') {
    const scale = H.getBctx().layout.view.scale || 1;
    d.frag.x = d.lx + (e.clientX - d.startX) / scale;
    d.frag.y = d.ly + (e.clientY - d.startY) / scale;
    puzzleCanvasRender();
    return;
  }
  if (d.mode === 'stmt-group-pending') {
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return;
    H.pushUndo();
    const group = H.detachStmtGroupNow(d.source.stmt);
    d.source.type = 'stmt-group';
    d.source.group = group || [];
    d.mode = 'ghost';
    pruneEmptyFrags();
    puzzleCanvasRender();
    renderGhost();
    return;
  }
  if (d.mode === 'ghost') {
    d.started = true;
    computeDropTarget(e);
    renderGhost();
    puzzleCanvasRender();
  }
}

function pruneEmptyFrags() {
  const bctx = H && H.getBctx();
  if (!bctx || !Array.isArray(bctx.frags)) return;
  bctx.frags = bctx.frags.filter(f => f && Array.isArray(f.stmts) && f.stmts.length > 0);
}

function endDrag(e) {
  const d = S.drag;
  if (!d) return;
  S.drag = null;
  S.dropHover = null;
  renderGhost();

  if (d.mode === 'pan' || d.mode === 'chain-move' || d.mode === 'frag-move') { puzzleCanvasRender(); return; }
  if (d.mode === 'stmt-group-pending') { puzzleCanvasRender(); return; }

  const { source, target, valid } = d;
  if (!valid || !target) { puzzleCanvasRender(); return; }

  if (target.kind === 'delete') {
    if (source.type === 'expr') { H.pushUndo(); if (source.detach) source.detach(); H.refreshPreview(); }
    else if (source.type === 'op-remove') { H.pushUndo(); H.removeChainOp(source.chain, source.index); H.refreshPreview(); }
    else if (source.type === 'stmt-group') { pruneEmptyFrags(); }
    puzzleCanvasRender();
    return;
  }
  if (target.kind === 'op-slot') {
    if (source.type !== 'opval') { puzzleCanvasRender(); return; }
    H.pushUndo();
    target.ref.chain.ops[target.ref.index] = source.op;
    H.refreshPreview();
    puzzleCanvasRender();
    return;
  }
  if (target.kind === 'chain-append') {
    const chain = target.ref.chain;
    if (source.type === 'opval') {
      H.pushUndo();
      chain.ops.push(source.op);
      chain.terms.push(N0());
      H.refreshPreview();
    } else {
      let node;
      if (source.type === 'palette') {
        node = source.stmt ? H.newStmtNode(source.stmtKind) : H.newExprNodeFromTemplate(source.template);
        H.pushUndo();
      } else if (source.type === 'expr') {
        if (!source.detach) { puzzleCanvasRender(); return; }
        H.pushUndo();
        node = source.detach();
      } else { puzzleCanvasRender(); return; }
      chain.ops.push('+');
      chain.terms.push(node);
      H.refreshPreview();
    }
    puzzleCanvasRender();
    return;
  }
  if (target.kind === 'slot') {
    let node;
    if (source.type === 'palette') {
      node = source.stmt ? H.newStmtNode(source.stmtKind) : H.newExprNodeFromTemplate(source.template);
      H.pushUndo();
    } else if (source.type === 'expr') {
      if (!source.detach) { puzzleCanvasRender(); return; }
      H.pushUndo();
      node = source.detach();
    } else { puzzleCanvasRender(); return; }
    target.ref.set(node);
    H.refreshPreview();
    puzzleCanvasRender();
    return;
  }
  if (target.kind === 'stmt-drop') {
    if (source.type === 'palette') {
      if (!source.stmt) { puzzleCanvasRender(); return; }
      H.pushUndo();
      const stmt = H.newStmtNode(source.stmtKind);
      if (target.drop.frag) target.drop.frag.stmts.splice(target.drop.index, 0, stmt);
      else if (target.drop.chain) target.drop.chain.splice(target.drop.index, 0, stmt);
      H.refreshPreview();
    } else if (source.type === 'stmt-group') {
      if (target.drop.frag) target.drop.frag.stmts.splice(target.drop.index, 0, ...source.group);
      else if (target.drop.chain) target.drop.chain.splice(target.drop.index, 0, ...source.group);
      H.refreshPreview();
      pruneEmptyFrags();
    }
    puzzleCanvasRender();
    return;
  }
  if (target.kind === 'blank') {
    if (source.type === 'palette' && source.stmt) {
      H.pushUndo();
      const stmt = H.newStmtNode(source.stmtKind);
      H.getBctx().frags.push({ stmts: [stmt], x: target.x, y: target.y });
      H.refreshPreview();
    } else if (source.type === 'stmt-group') {
      H.getBctx().frags.push({ stmts: source.group, x: target.x, y: target.y });
      H.refreshPreview();
      pruneEmptyFrags();
    }
    puzzleCanvasRender();
    return;
  }
  puzzleCanvasRender();
}

/* ============================ 放大镜 ============================ */

export function puzzleCanvasBeginLens(e) {
  S.lens = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false, info: '' };
  renderGhost();
}
function updateLens(e) {
  if (!S.lens) return;
  S.lens.x = e.clientX; S.lens.y = e.clientY;
  if (Math.hypot(e.clientX - S.lens.startX, e.clientY - S.lens.startY) > 3) S.lens.moved = true;
  let info = '';
  const palRect = S.palCanvas && S.palCanvas.getBoundingClientRect();
  if (palRect && e.clientX >= palRect.left && e.clientX <= palRect.right && e.clientY >= palRect.top && e.clientY <= palRect.bottom) {
    const hit = hitPalette(e.clientX - palRect.left, e.clientY - palRect.top);
    if (hit && hit.item) info = hit.item.info || '';
  } else if (S.workCanvas) {
    const rect = S.workCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const ch = S.workCanvas.clientHeight || S.workCanvas.height;
    const hit = my < (ch - VARS_H) ? hitWorkspace(mx, my, false) : null;
    if (hit && hit.kind === 'expr') info = H.nodeInfo(hit.node) || '';
    else if (hit && hit.kind === 'stmt' && hit.stmt) info = t(STMT_BLOCKS[hit.stmt.kind] ? STMT_BLOCKS[hit.stmt.kind].desc : '') || '';
    else if (hit && hit.kind === 'head') info = hit.head.frag ? t('blk.fragment') : t('blk.start');
  }
  S.lens.info = info;
  renderGhost();
}
function endLens() { S.lens = null; renderGhost(); }

/* ============================ 指针事件 ============================ */

function onPalDown(e) {
  if (!H || !H.getBctx()) return;
  if (e.button !== 0) return;
  if (S.edit) commitEdit();
  const rect = S.palCanvas.getBoundingClientRect();
  const hit = hitPalette(e.clientX - rect.left, e.clientY - rect.top);
  if (hit && hit.kind === 'pal-item') {
    e.preventDefault();
    startPaletteDrag(hit, e);
  }
}

function onWorkDown(e) {
  if (!H || !H.getBctx()) return;
  if (e.button !== 0) return;
  const rect = S.workCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const ch = S.workCanvas.clientHeight || S.workCanvas.height;

  if (my >= ch - VARS_H) {
    const hit = hitVars(mx, my);
    if (S.edit && hit && S.edit.region === hit) {
      e.preventDefault();
      const idx = editIndexAtX(hit, 'var', mx);
      setEditSel(idx, idx);
      S.editMouse = { region: hit, space: 'var', baseIndex: idx };
      puzzleCanvasRender();
      return;
    }
    if (S.edit) commitEdit();
    if (hit && hit.kind === 'edit') { e.preventDefault(); beginInlineEdit(hit); return; }
    if (hit && hit.kind === 'attr-var') {
      e.preventDefault();
      const r = hit;
      startGhostDrag({ type: 'palette', stmt: false, template: { kind: 'var', name: r.attrVar } }, e, e.clientX - (rect.left + r.x), e.clientY - (rect.top + ch - VARS_H + r.y - S.varsScroll), H.getBctx().layout.view.scale);
      renderGhost();
      return;
    }
    return;
  }

  const hit = hitWorkspace(mx, my, false);
  if (S.edit && hit && S.edit.region === hit) {
    e.preventDefault();
    const idx = editIndexAtX(hit, 'work', mx);
    setEditSel(idx, idx);
    S.editMouse = { region: hit, space: 'work', baseIndex: idx };
    puzzleCanvasRender();
    return;
  }
  if (S.edit) commitEdit();
  if (hit.kind === 'head' && hit.head.key) { e.preventDefault(); startChainMove(hit, e); return; }
  if (hit.kind === 'head' && hit.head.frag) { e.preventDefault(); startFragMove(hit, e); return; }
  if (hit.kind === 'expr') { e.preventDefault(); startExprDrag(hit, e); return; }
  if (hit.kind === 'op') { e.preventDefault(); startOpRemove(hit, e); return; }
  if (hit.kind === 'edit') { e.preventDefault(); beginInlineEdit(hit); return; }
  if (hit.kind === 'attr') {
    e.preventDefault();
    if (hit.attr && hit.attr.onClick && hit.attr.onClick()) { H.refreshPreview(); puzzleCanvasRender(); }
    return;
  }
  if (hit.kind === 'toggle') {
    e.preventDefault();
    if (hit.toggle && hit.toggle.onClick && hit.toggle.onClick()) { H.refreshPreview(); puzzleCanvasRender(); }
    return;
  }
  if (hit.kind === 'color') { e.preventDefault(); openColorEdit(hit); return; }
  if (hit.kind === 'comp') {
    e.preventDefault();
    const node = hit.comp.node;
    H.pushUndo();
    node.axis = node.axis === 'x' ? 'y' : node.axis === 'y' ? 'z' : 'x';
    H.refreshPreview();
    puzzleCanvasRender();
    return;
  }
  if (hit.kind === 'stmt' && hit.stmt && hit.stmt.kind === 'raw') { e.preventDefault(); beginInlineEdit(hit); return; }
  if (hit.kind === 'stmt') { e.preventDefault(); startStmtGroupPending(hit, e); return; }
  if (hit.kind === 'blank') { e.preventDefault(); startPan(e); return; }
}

function onEchoWheel(e) {
  e.preventDefault();
  const ch = S.echoCanvas.clientHeight || S.echoCanvas.height;
  const lh = 16;
  const code = (H && H.getBctx()) ? statementsToCode(H.getBctx().chain) : '';
  const lines = code ? code.split('\n').length + 2 : 1;
  const contentH = lines * lh + 20;
  S.echoScroll = Math.max(0, Math.min(S.echoScroll + (e.deltaY > 0 ? 30 : -30), Math.max(0, contentH - ch)));
  renderEchoCanvas();
}

function onWorkWheel(e) {
  if (!H || !H.getBctx()) return;
  e.preventDefault();
  const rect = S.workCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const ch = S.workCanvas.clientHeight || S.workCanvas.height;
  if (my >= ch - VARS_H) {
    S.varsScroll = Math.max(0, S.varsScroll + (e.deltaY > 0 ? 30 : -30));
    puzzleCanvasRender();
    return;
  }
  const v = H.getBctx().layout.view;
  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  const ns = Math.min(2.5, Math.max(0.4, v.scale * factor));
  const wx = (mx - v.x) / v.scale;
  const wy = (my - v.y) / v.scale;
  v.scale = ns;
  v.x = mx - wx * ns;
  v.y = my - wy * ns;
  puzzleCanvasRender();
}

function onWindowMove(e) {
  if (S.edit) {
    if (S.editMouse && S.workCanvas) {
      const rect = S.workCanvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const idx = editIndexAtX(S.editMouse.region, S.editMouse.space, mx);
      setEditSel(S.editMouse.baseIndex, idx);
      puzzleCanvasRender();
    }
    return;
  }
  if (S.lens) { updateLens(e); return; }
  if (S.drag) { updateDrag(e); return; }
  updateHover(e);
}
function onWindowUp(e) {
  if (S.edit) {
    S.editMouse = null;
    return;
  }
  if (S.lens) { endLens(); return; }
  if (S.drag) {
    // 数字块：未拖动的点击直接进入输入浮层编辑
    const d = S.drag;
    if (d.mode === 'ghost' && !d.started && d.source.type === 'expr' && d.source.node && d.source.node.kind === 'num' && d.source.region) {
      const region = d.source.region;
      S.drag = null;
      S.dropHover = null;
      renderGhost();
      beginInlineEdit(region, {
        kind: 'num',
        value: region.node.value,
        commit: (v) => {
          const n = parseFloat(v);
          if (!Number.isFinite(n)) return false;
          H.pushUndo();
          region.node.value = n;
          return true;
        },
      });
      return;
    }
    endDrag(e);
    return;
  }
}

function updateHover(e) {
  if (!H || !H.getBctx() || !S.workCanvas || !S.palCanvas) return;
  const palRect = S.palCanvas.getBoundingClientRect();
  let hover = null;
  if (e.clientX >= palRect.left && e.clientX <= palRect.right && e.clientY >= palRect.top && e.clientY <= palRect.bottom) {
    hover = hitPalette(e.clientX - palRect.left, e.clientY - palRect.top);
  } else {
    const rect = S.workCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const ch = S.workCanvas.clientHeight || S.workCanvas.height;
    if (my >= ch - VARS_H) hover = hitVars(mx, my);
    else hover = hitWorkspace(mx, my, false);
  }
  if (hover !== S.hover) {
    S.hover = hover;
    if (S.workCanvas) {
      const kind = hover && hover.kind;
      S.workCanvas.style.cursor = (kind === 'edit' || kind === 'attr' || kind === 'toggle' || kind === 'color') ? 'pointer' : (kind === 'expr' || kind === 'stmt' || kind === 'head' || kind === 'op' || kind === 'attr-var' || kind === 'pal-item') ? 'grab' : 'default';
    }
  }
}

/* ============================ 初始化 ============================ */

function fitCanvas(canvas, ctx) {
  if (!canvas || !ctx) return;
  const dpr = S.dpr;
  // 用 CSS 布局尺寸（getBoundingClientRect）计算 backing store；
  // 不写死 style.width/height，否则 display:none 期间会把 0 固化，之后无法恢复。
  let w = 0, h = 0;
  try {
    const rect = canvas.getBoundingClientRect();
    w = rect.width; h = rect.height;
  } catch (e) { /* 测试桩无该方法时忽略 */ }
  if (!w) w = canvas.clientWidth || canvas.offsetWidth || 100;
  if (!h) h = canvas.clientHeight || canvas.offsetHeight || 100;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
}

export function puzzleCanvasResize() {
  S.dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  fitCanvas(S.palCanvas, S.palCtx);
  fitCanvas(S.workCanvas, S.workCtx);
  fitCanvas(S.echoCanvas, S.echoCtx);
  fitCanvas(S.ghostCanvas, S.ghostCtx);
  puzzleCanvasRender();
}

export function puzzleCanvasRender() {
  renderPaletteCanvas();
  renderWorkCanvas();
  renderEchoCanvas();
}

export function puzzleCanvasIsEditing() { return !!S.edit; }
export function puzzleCanvasCancelEdit() { cancelEdit(); }

export function initPuzzleCanvas() {
  S.palCanvas = document.getElementById('puzzle-palette-canvas');
  S.workCanvas = document.getElementById('puzzle-workspace-canvas');
  S.echoCanvas = document.getElementById('puzzle-echo-canvas');
  S.ghostCanvas = document.getElementById('puzzle-ghost-canvas');
  S.palCtx = S.palCanvas && typeof S.palCanvas.getContext === 'function' ? S.palCanvas.getContext('2d') : null;
  S.workCtx = S.workCanvas && typeof S.workCanvas.getContext === 'function' ? S.workCanvas.getContext('2d') : null;
  S.echoCtx = S.echoCanvas && typeof S.echoCanvas.getContext === 'function' ? S.echoCanvas.getContext('2d') : null;
  S.ghostCtx = S.ghostCanvas && typeof S.ghostCanvas.getContext === 'function' ? S.ghostCanvas.getContext('2d') : null;

  if (!S.palCtx || !S.workCtx) return;

  if (S.palCanvas) {
    S.palCanvas.addEventListener('pointerdown', onPalDown);
    S.palCanvas.addEventListener('wheel', (e) => { e.preventDefault(); S.palScroll = Math.max(0, S.palScroll + (e.deltaY > 0 ? 40 : -40)); puzzleCanvasRender(); }, { passive: false });
  }
  if (S.workCanvas) {
    S.workCanvas.addEventListener('pointerdown', onWorkDown);
    S.workCanvas.addEventListener('wheel', onWorkWheel, { passive: false });
  }
  if (S.echoCanvas) {
    S.echoCanvas.addEventListener('wheel', onEchoWheel, { passive: false });
  }
  window.addEventListener('pointermove', onWindowMove);
  window.addEventListener('pointerup', onWindowUp);
  window.addEventListener('resize', puzzleCanvasResize);
  window.addEventListener('keydown', (ev) => {
    if (!H || !H.getBctx()) return;
    if (S.edit) {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.key === 'Enter') { commitEdit(); return; }
      if (ev.key === 'Escape') { cancelEdit(); return; }
      if (ev.ctrlKey && (ev.key === 'a' || ev.key === 'A')) {
        setEditSel(0, S.edit.buffer.length);
        puzzleCanvasRender();
        return;
      }
      if (ev.ctrlKey && (ev.key === 'c' || ev.key === 'C')) {
        const [s0, s1] = editSelectedRange();
        copyText(S.edit.buffer.slice(s0, s1));
        return;
      }
      if (ev.ctrlKey && (ev.key === 'x' || ev.key === 'X')) {
        const [s0, s1] = editSelectedRange();
        copyText(S.edit.buffer.slice(s0, s1));
        editDeleteBack();
        puzzleCanvasRender();
        return;
      }
      if (ev.ctrlKey && (ev.key === 'v' || ev.key === 'V')) {
        pasteText();
        return;
      }
      if (ev.key === 'Backspace') { editDeleteBack(); puzzleCanvasRender(); return; }
      if (ev.key === 'Delete') { editDeleteFwd(); puzzleCanvasRender(); return; }
      if (ev.key === 'ArrowLeft') { editMoveCursor(-1, ev.shiftKey); puzzleCanvasRender(); return; }
      if (ev.key === 'ArrowRight') { editMoveCursor(1, ev.shiftKey); puzzleCanvasRender(); return; }
      if (ev.key === 'Home') { editMoveHome(ev.shiftKey); puzzleCanvasRender(); return; }
      if (ev.key === 'End') { editMoveEnd(ev.shiftKey); puzzleCanvasRender(); return; }
      if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        if (S.edit.kind === 'num' && !/[0-9.\-]/.test(ev.key)) return;
        editReplace(ev.key);
        puzzleCanvasRender();
        return;
      }
      return;
    }
    if (ev.ctrlKey && (ev.key === 'z' || ev.key === 'Z')) {
      ev.preventDefault();
      if (ev.shiftKey) H.redo(); else H.undo();
    } else if (ev.ctrlKey && (ev.key === 'y' || ev.key === 'Y')) {
      ev.preventDefault();
      H.redo();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      H.close(false);
    }
  });
  puzzleCanvasResize();
}