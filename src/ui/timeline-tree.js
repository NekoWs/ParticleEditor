/* =========================================================================
 * 底部时间轴左侧分层列表（AE 式）
 *
 * - 顶层仅展示：函数对象（f:fxId）、组（g:组名）；
 * - 组展开：pos/rot/vel/col/scl 属性时间轴 + 同级「粒子列表」；
 *   粒子展开：粒子自身的 pos/vel/col/scl 属性时间轴；
 * - 函数对象展开：pos/rot/scl 基本修改 + 「变量」列表；
 *   变量只接受常数（fx.vars[name].base），可给变量在当前时间添加关键帧；
 * - 属性/分量/变量行内各有一个迷你时间轴 canvas，与底部标尺共享
 *   timelineViewStart / TL_PX_PER_TICK（panels.js），横向平移时同步重绘；
 * - 0t 默认关键帧（轨道创建时的基线 kf0）不画菱形。
 * ======================================================================= */

import { t, tf, LANG } from '../core/i18n.js';
import {
  state, TRACK_COMPS, COMP_LABELS, GROUP_PROP_DEFS, PARTICLE_TRACK_DEFS, FUNCTION_PROP_DEFS,
  compPr, getParticle, getFunction, isDerivedParticle,
} from '../core/constants.js';
import { TL_PX_PER_TICK, timelineViewStart } from './panels.js';
import { findTrackByPr } from '../core/animation-eval.js';
import { baseValueFor, editComponentValue } from '../core/edit.js';
import { targetComponentValue, addComponentKeyframe } from './tree.js';
import { rebuildFunctionObject } from '../core/generators.js';
import { pushUndo } from '../state/undo.js';
import { varKfValue } from '../core/easing.js';
import { modalAlert } from './ui.js';

export const tlTreeState = { expanded: new Set() };

// 分量关键帧菱形配色（X/Y/Z 与 R/G/B/A 区分，便于属性行聚合显示）
const COMP_COLORS = {
  x: '#ffcc55', y: '#5b9dff', z: '#6bd489',
  r: '#ff7b6b', g: '#6bd489', b: '#5b9dff', a: '#e57fae',
};

let lastSig = null;
let eventsBound = false;

/* =========================================================================
 * 小工具
 * ======================================================================= */

function el(tag, cls) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

function fmtNum(v) {
  if (typeof v !== 'number' || !isFinite(v)) return '0';
  return String(Math.round(v * 100) / 100);
}

function rebuildFxSafe(fx) {
  try {
    rebuildFunctionObject(fx);
  } catch (e) {
    modalAlert(t('fx.exprError'), e.message);
  }
}

function makeArrow(key, expanded) {
  const arrow = el('span', 'tt-arrow');
  arrow.textContent = expanded ? '▾' : '▸';
  arrow.dataset.key = key;
  return arrow;
}

function toggleKey(key) {
  if (tlTreeState.expanded.has(key)) tlTreeState.expanded.delete(key);
  else tlTreeState.expanded.add(key);
  refreshTimelineTree();
}

// 字符串哈希（结构签名用，避免超大成员列表 join 成巨型字符串）
function hashStr(s, h) {
  h = h | 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

// 结构签名：对象/成员/变量/展开状态/语言变化时重建 DOM；
// 关键帧数值、当前时间、视口平移等变化只走 drawTimelineTree 轻刷新。
function structureSignature() {
  const parts = [];
  parts.push('L:' + LANG);
  for (const [name, members] of Object.entries(state.groups)) {
    let h = members.length;
    if (tlTreeState.expanded.has('g:' + name + '|@members')) {
      for (const id of members) h = hashStr(id, h);
    }
    parts.push('G:' + name + ':' + h);
  }
  for (const fx of state.functions) {
    const names = Object.keys(fx.vars || {});
    let h = names.length;
    if (tlTreeState.expanded.has('f:' + fx.id + '|@vars')) {
      for (const n of names) h = hashStr(n, h);
    }
    parts.push('F:' + fx.id + ':' + hashStr(fx.name || '', 0) + ':' + fx.count + ':' + h);
  }
  parts.push('X:' + [...tlTreeState.expanded].sort().join('|'));
  return parts.join(';');
}

/* =========================================================================
 * 行渲染
 * ======================================================================= */

function renderGroupNode(name) {
  const members = state.groups[name] || [];
  const key = 'g:' + name;
  const expanded = tlTreeState.expanded.has(key);
  const root = el('div', 'tt-node tt-group');
  const head = el('div', 'tt-head tt-group-head');
  head.appendChild(makeArrow(key, expanded));
  const label = el('span', 'tt-label');
  label.textContent = name;
  label.title = name;
  const count = el('span', 'tt-count');
  count.textContent = tf('tree.memberCount', members.length);
  head.appendChild(label);
  head.appendChild(count);
  root.appendChild(head);
  if (expanded) {
    const sub = el('div', 'tt-sub');
    for (const prop of GROUP_PROP_DEFS) sub.appendChild(renderPropRow('g:' + name, prop));
    sub.appendChild(renderParticleListNode(name, members));
    root.appendChild(sub);
  }
  return root;
}

function renderParticleListNode(gname, members) {
  const key = 'g:' + gname + '|@members';
  const expanded = tlTreeState.expanded.has(key);
  const wrap = el('div', 'tt-members-node');
  const head = el('div', 'tt-subhead');
  head.appendChild(makeArrow(key, expanded));
  const label = el('span', 'tt-sub-label');
  label.textContent = tf('tree.particleListCount', members.length);
  head.appendChild(label);
  wrap.appendChild(head);
  if (expanded) {
    const list = el('div', 'tt-sub');
    for (const id of members) {
      const p = getParticle(id);
      if (p) list.appendChild(renderParticleNode(p));
    }
    wrap.appendChild(list);
  }
  return wrap;
}

function renderParticleNode(p) {
  const key = 'p:' + p.id;
  const expanded = tlTreeState.expanded.has(key);
  const readOnly = isDerivedParticle(p);
  const root = el('div', 'tt-node tt-particle');
  const head = el('div', 'tt-head');
  head.appendChild(makeArrow(key, expanded));
  const label = el('span', 'tt-label');
  label.textContent = p.id;
  label.title = p.id;
  head.appendChild(label);
  root.appendChild(head);
  if (expanded) {
    const sub = el('div', 'tt-sub');
    for (const prop of PARTICLE_TRACK_DEFS) sub.appendChild(renderPropRow(p.id, prop, readOnly));
    root.appendChild(sub);
  }
  return root;
}

function renderFunctionNode(fx) {
  const key = 'f:' + fx.id;
  const expanded = tlTreeState.expanded.has(key);
  const root = el('div', 'tt-node tt-fx');
  const head = el('div', 'tt-head tt-fx-head');
  head.appendChild(makeArrow(key, expanded));
  const label = el('span', 'tt-label');
  label.textContent = fx.name;
  label.title = fx.name;
  const count = el('span', 'tt-count');
  count.textContent = tf('tree.fxParticleCount', fx.count);
  head.appendChild(label);
  head.appendChild(count);
  root.appendChild(head);
  if (expanded) {
    const sub = el('div', 'tt-sub');
    for (const prop of FUNCTION_PROP_DEFS) sub.appendChild(renderPropRow('f:' + fx.id, prop));
    sub.appendChild(renderVarsNode(fx));
    root.appendChild(sub);
  }
  return root;
}

function renderVarsNode(fx) {
  const names = Object.keys(fx.vars || {});
  const key = 'f:' + fx.id + '|@vars';
  const expanded = tlTreeState.expanded.has(key);
  const wrap = el('div', 'tt-vars-node');
  const head = el('div', 'tt-subhead');
  head.appendChild(makeArrow(key, expanded));
  const label = el('span', 'tt-sub-label');
  label.textContent = t('fx.varList') + ' (' + names.length + ')';
  head.appendChild(label);
  wrap.appendChild(head);
  if (expanded) {
    const list = el('div', 'tt-sub');
    if (names.length === 0) {
      const empty = el('div', 'tt-empty');
      empty.textContent = '—';
      list.appendChild(empty);
    } else {
      for (const name of names) list.appendChild(renderVarRow(fx, name));
    }
    wrap.appendChild(list);
  }
  return wrap;
}

function renderVarRow(fx, name) {
  const row = el('div', 'tt-var-row');
  const label = el('span', 'tt-vname');
  label.textContent = name;
  label.title = name;
  const val = el('input', 'tt-var-val');
  val.type = 'number';
  val.step = '0.01';
  val.dataset.fxid = fx.id;
  val.dataset.name = name;
  const mini = el('canvas', 'tt-mini');
  mini.dataset.kind = 'var';
  mini.dataset.fxid = fx.id;
  mini.dataset.name = name;
  const add = el('button', 'tt-add-var-kf');
  add.textContent = '◇+';
  add.title = t('tree.addKfHint');
  add.dataset.fxid = fx.id;
  add.dataset.name = name;
  row.appendChild(label);
  row.appendChild(val);
  row.appendChild(mini);
  row.appendChild(add);
  return row;
}

function renderPropRow(id, prop, readOnly) {
  const comps = TRACK_COMPS[prop];
  const key = id + '|' + prop;
  const expanded = tlTreeState.expanded.has(key);
  const root = el('div', 'tt-prop');
  const head = el('div', 'tt-prop-head');
  head.appendChild(makeArrow(key, expanded));
  const label = el('span', 'tt-plabel');
  label.textContent = t('prop.' + prop);
  head.appendChild(label);

  // XYZ 行：[x, y, z] 三个可编辑当前值 + 迷你时间轴
  const vec = el('span', 'tt-vec');
  vec.appendChild(document.createTextNode('['));
  comps.forEach((comp, i) => {
    if (i > 0) vec.appendChild(document.createTextNode(','));
    const inp = el('input', 'tt-val');
    inp.type = 'number';
    inp.step = '0.01';
    inp.dataset.id = id;
    inp.dataset.prop = prop;
    inp.dataset.comp = comp;
    inp.title = COMP_LABELS[comp];
    if (readOnly) inp.disabled = true;
    vec.appendChild(inp);
  });
  vec.appendChild(document.createTextNode(']'));
  head.appendChild(vec);

  const mini = el('canvas', 'tt-mini');
  mini.dataset.kind = 'prop';
  mini.dataset.id = id;
  mini.dataset.prop = prop;
  head.appendChild(mini);
  root.appendChild(head);

  if (expanded) {
    const rows = el('div', 'tt-sub tt-comp-rows');
    for (const comp of comps) rows.appendChild(renderCompRow(id, prop, comp, readOnly));
    root.appendChild(rows);
  }
  return root;
}

function renderCompRow(id, prop, comp, readOnly) {
  const row = el('div', 'tt-comp-row');
  const label = el('span', 'tt-clabel');
  label.textContent = COMP_LABELS[comp];
  const val = el('input', 'tt-val tt-cval');
  val.type = 'number';
  val.step = '0.01';
  val.dataset.id = id;
  val.dataset.prop = prop;
  val.dataset.comp = comp;
  if (readOnly) val.disabled = true;
  const mini = el('canvas', 'tt-mini');
  mini.dataset.kind = 'comp';
  mini.dataset.id = id;
  mini.dataset.prop = prop;
  mini.dataset.comp = comp;
  const add = el('button', 'tt-add-kf');
  add.textContent = '◇+';
  add.title = t('tree.addKfHint');
  add.dataset.id = id;
  add.dataset.prop = prop;
  add.dataset.comp = comp;
  if (readOnly) add.disabled = true;
  row.appendChild(label);
  row.appendChild(val);
  row.appendChild(mini);
  row.appendChild(add);
  return row;
}

/* =========================================================================
 * 迷你时间轴绘制
 * ======================================================================= */

function drawKfDiamond(ctx, x, cy, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, cy - 4);
  ctx.lineTo(x + 4, cy);
  ctx.lineTo(x, cy + 4);
  ctx.lineTo(x - 4, cy);
  ctx.closePath();
  ctx.fill();
}

// 0t 默认关键帧（轨道创建时写入的基线 kf0）不画菱形
function isDefaultKf(tr, id, prop, comp, kf) {
  if (kf[0] !== 0) return false;
  const baseline = tr.m === 'op' ? 0 : baseValueFor(id, prop, comp);
  return Math.abs(kf[1] - baseline) < 1e-6;
}

function drawKfsForTrack(ctx, tr, id, prop, comp, w, h, color) {
  const pxPerTick = TL_PX_PER_TICK;
  const viewStart = timelineViewStart;
  for (const kf of tr.kf) {
    if (isDefaultKf(tr, id, prop, comp, kf)) continue;
    const x = (kf[0] - viewStart) * pxPerTick;
    if (x < -6 || x > w + 6) continue;
    drawKfDiamond(ctx, x, h / 2, color);
  }
}

function drawMiniTimeline(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 1;
  const h = canvas.clientHeight || 1;
  const W = Math.round(w * dpr);
  const H = Math.round(h * dpr);
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#181b22';
  ctx.fillRect(0, 0, w, h);

  const pxPerTick = TL_PX_PER_TICK;
  const viewStart = timelineViewStart;
  const viewEnd = viewStart + w / pxPerTick;

  // 中线
  ctx.strokeStyle = '#2b303a';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  // 与底部标尺同一视口的刻度（每 5 tick）
  ctx.strokeStyle = '#3a3f4b';
  for (let tick = Math.max(0, Math.floor(viewStart / 5) * 5); tick <= viewEnd; tick += 5) {
    const x = (tick - viewStart) * pxPerTick;
    ctx.beginPath();
    ctx.moveTo(x, h / 2 - 4);
    ctx.lineTo(x, h / 2 + 4);
    ctx.stroke();
  }

  const kind = canvas.dataset.kind;
  if (kind === 'comp') {
    const id = canvas.dataset.id;
    const prop = canvas.dataset.prop;
    const comp = canvas.dataset.comp;
    const tr = findTrackByPr(compPr(prop, comp), id);
    if (tr) drawKfsForTrack(ctx, tr, id, prop, comp, w, h, COMP_COLORS[comp] || '#ffcc55');
  } else if (kind === 'prop') {
    const id = canvas.dataset.id;
    const prop = canvas.dataset.prop;
    for (const comp of TRACK_COMPS[prop] || []) {
      const tr = findTrackByPr(compPr(prop, comp), id);
      if (tr) drawKfsForTrack(ctx, tr, id, prop, comp, w, h, COMP_COLORS[comp] || '#ffcc55');
    }
  } else if (kind === 'var') {
    const fx = getFunction(canvas.dataset.fxid);
    const v = fx && fx.vars && fx.vars[canvas.dataset.name];
    const kfs = v && v.kf ? v.kf : [];
    for (const kf of kfs) {
      const x = (kf[0] - viewStart) * pxPerTick;
      if (x < -6 || x > w + 6) continue;
      drawKfDiamond(ctx, x, h / 2, '#ffcc55');
    }
  }

  // 播放头（与底部标尺对齐）
  const phx = (state.time - viewStart) * pxPerTick;
  if (phx >= -1 && phx <= w + 1) {
    ctx.strokeStyle = '#ffcc55';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(phx, 0);
    ctx.lineTo(phx, h);
    ctx.stroke();
  }
}

/* =========================================================================
 * 刷新 / 初始化
 * ======================================================================= */

// 轻刷新：重绘所有迷你时间轴 + 更新当前值输入（不重建 DOM）
export function drawTimelineTree() {
  const root = document.getElementById('tl-tree');
  if (!root) return;
  root.querySelectorAll('canvas.tt-mini').forEach(drawMiniTimeline);
  root.querySelectorAll('input.tt-val').forEach(inp => {
    if (document.activeElement === inp) return; // 编辑中不覆盖
    const id = inp.dataset.id;
    const prop = inp.dataset.prop;
    const comp = inp.dataset.comp;
    inp.value = fmtNum(targetComponentValue(id, prop, comp, state.time));
  });
  root.querySelectorAll('input.tt-var-val').forEach(inp => {
    if (document.activeElement === inp) return;
    const fx = getFunction(inp.dataset.fxid);
    const v = fx && fx.vars && fx.vars[inp.dataset.name];
    if (!v) {
      inp.value = '0';
      inp.disabled = true;
      return;
    }
    const kf = v.kf || [];
    if (kf.length > 0) {
      inp.value = fmtNum(varKfValue(kf, state.time));
      inp.disabled = true;
    } else {
      inp.value = fmtNum(Number.isFinite(v.base) ? v.base : 0);
      inp.disabled = false;
    }
  });
}

// 结构刷新：仅在对象/展开状态/语言变化时重建 DOM，随后轻刷新
export function refreshTimelineTree() {
  const root = document.getElementById('tl-tree');
  if (!root) return;
  const sig = structureSignature();
  if (sig !== lastSig) {
    lastSig = sig;
    root.innerHTML = '';
    if (Object.keys(state.groups).length === 0 && state.functions.length === 0) {
      const hint = el('div', 'tt-empty');
      hint.textContent = t('tree.empty');
      root.appendChild(hint);
    } else {
      for (const name of Object.keys(state.groups)) root.appendChild(renderGroupNode(name));
      for (const fx of state.functions) root.appendChild(renderFunctionNode(fx));
    }
  }
  drawTimelineTree();
}

export function initTimelineTree() {
  const root = document.getElementById('tl-tree');
  if (!root) return;
  if (!eventsBound) {
    eventsBound = true;
    root.addEventListener('click', onTreeClick);
    root.addEventListener('change', onTreeChange);
  }
  refreshTimelineTree();
}

/* =========================================================================
 * 交互
 * ======================================================================= */

function onTreeClick(ev) {
  const arrow = ev.target.closest('.tt-arrow');
  if (arrow && arrow.dataset.key) {
    ev.stopPropagation();
    toggleKey(arrow.dataset.key);
    return;
  }
  const addKf = ev.target.closest('.tt-add-kf');
  if (addKf) {
    addComponentKeyframe(addKf.dataset.id, addKf.dataset.prop, addKf.dataset.comp);
    refreshTimelineTree();
    return;
  }
  const addVar = ev.target.closest('.tt-add-var-kf');
  if (addVar) {
    addVariableKeyframe(addVar.dataset.fxid, addVar.dataset.name);
  }
}

function onTreeChange(ev) {
  const target = ev.target;
  if (target.classList && target.classList.contains('tt-val')) {
    const id = target.dataset.id;
    const prop = target.dataset.prop;
    const comp = target.dataset.comp;
    const v = parseFloat(target.value);
    if (!isFinite(v)) return;
    const p = getParticle(id);
    if (p && isDerivedParticle(p)) return; // 派生粒子基础属性只读
    editComponentValue(id, prop, comp, Math.round(state.time), v);
    refreshTimelineTree();
    return;
  }
  if (target.classList && target.classList.contains('tt-var-val')) {
    const fxId = target.dataset.fxid;
    const name = target.dataset.name;
    const fx = getFunction(fxId);
    const v = fx && fx.vars && fx.vars[name];
    if (!v) return;
    const nv = parseFloat(target.value);
    if (!isFinite(nv)) return;
    pushUndo();
    v.base = nv;
    rebuildFxSafe(fx);
    refreshTimelineTree();
  }
}

function addVariableKeyframe(fxId, name) {
  const fx = getFunction(fxId);
  const v = fx && fx.vars && fx.vars[name];
  if (!v) return;
  pushUndo();
  const tick = Math.max(0, Math.round(state.time));
  const kf = v.kf || (v.kf = []);
  const cur = kf.length > 0 ? varKfValue(kf, tick) : (Number.isFinite(v.base) ? v.base : 0);
  const existing = kf.find(k => k[0] === tick);
  if (existing) {
    existing[1] = cur;
  } else {
    kf.push([tick, cur, state.defaultEasing]);
    kf.sort((a, b) => a[0] - b[0]);
  }
  rebuildFxSafe(fx);
  refreshTimelineTree();
}