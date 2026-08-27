/* =========================================================================
 * 底部时间轴左侧标签轨（与 #tl-layers-canvas 的 lane 行一一对应）
 *
 * - 本模块只渲染 HTML 标签/三角形/数值输入/添加关键帧按钮；
 * - 关键帧菱形、播放头、刻度统一由 timeline-layers.js 在 canvas 上绘制；
 * - tlTreeState.expanded 是展开状态的唯一来源；
 * - tlTreeFlatRows() 输出与 HTML 完全一致的扁平行列表，供 canvas 读取。
 * ======================================================================= */

import { t, tf, LANG } from '../core/i18n.js';
import {
  state, TRACK_COMPS, COMP_LABELS, GROUP_PROP_DEFS, PARTICLE_TRACK_DEFS, FUNCTION_PROP_DEFS,
  getParticle, getFunction, isDerivedParticle,
} from '../core/constants.js';
import { editComponentValue } from '../core/edit.js';
import { targetComponentValue } from './tree.js';
import { rebuildFunctionObject } from '../core/generators.js';
import { pushUndo } from '../state/undo.js';
import { varKfValue } from '../core/easing.js';
import { modalAlert } from './ui.js';
import { rebuildPoints } from '../core/animation.js';
import { refreshFunctionPanel } from './panels.js';

export const TL_TREE_ROW_H = 22;
export const tlTreeState = { expanded: new Set() };
let tlTreeAnchor = null; // Shift 连续选择锚点（粒子 id 或组名/函数对象 key）

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

function makeSpacer() {
  return el('span', 'tt-arrow tt-arrow-spacer');
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

// 结构签名：对象/成员/变量/展开状态/语言变化时重建 HTML；数值与时间变化只走 drawTimelineTree。
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
 * 扁平行列表（HTML 与 canvas lane 的唯一行模型）
 * ======================================================================= */

function pushPropRows(rows, id, prop, depth, readOnly) {
  const key = id + '|' + prop;
  const expanded = tlTreeState.expanded.has(key);
  rows.push({ key, kind: 'prop', id, prop, readOnly, expanded, depth });
  if (expanded) {
    for (const comp of TRACK_COMPS[prop]) {
      rows.push({ key: key + '|' + comp, kind: 'comp', id, prop, comp, readOnly, depth: depth + 1 });
    }
  }
}

export function tlTreeFlatRows() {
  const rows = [];

  for (const name of Object.keys(state.groups)) {
    const members = state.groups[name] || [];
    const gkey = 'g:' + name;
    const gexpanded = tlTreeState.expanded.has(gkey);
    rows.push({ key: gkey, kind: 'group', name, members, expanded: gexpanded, depth: 0 });
    if (!gexpanded) continue;

    for (const prop of GROUP_PROP_DEFS) pushPropRows(rows, 'g:' + name, prop, 1, false);

    const mkey = gkey + '|@members';
    const mexpanded = tlTreeState.expanded.has(mkey);
    rows.push({ key: mkey, kind: 'members', name, count: members.length, expanded: mexpanded, depth: 1 });
    if (!mexpanded) continue;

    for (const id of members) {
      const p = getParticle(id);
      if (!p) continue;
      const pkey = 'p:' + p.id;
      const pexpanded = tlTreeState.expanded.has(pkey);
      rows.push({ key: pkey, kind: 'particle', p, expanded: pexpanded, depth: 2 });
      if (pexpanded) {
        for (const prop of PARTICLE_TRACK_DEFS) pushPropRows(rows, p.id, prop, 3, isDerivedParticle(p));
      }
    }
  }

  for (const fx of state.functions) {
    const fkey = 'f:' + fx.id;
    const fexpanded = tlTreeState.expanded.has(fkey);
    rows.push({ key: fkey, kind: 'fx', fx, expanded: fexpanded, depth: 0 });
    if (!fexpanded) continue;

    for (const prop of FUNCTION_PROP_DEFS) pushPropRows(rows, 'f:' + fx.id, prop, 1, false);

    const names = Object.keys(fx.vars || {});
    const vkey = 'f:' + fx.id + '|@vars';
    const vexpanded = tlTreeState.expanded.has(vkey);
    rows.push({ key: vkey, kind: 'vars', fx, count: names.length, expanded: vexpanded, depth: 1 });
    if (!vexpanded) continue;

    for (const name of names) {
      rows.push({ key: 'var:' + fx.id + '|' + name, kind: 'var', fx, name, depth: 2 });
    }
  }

  return rows;
}

/* =========================================================================
 * HTML 行渲染
 * ======================================================================= */

function renderFlatRow(row) {
  const div = el('div', 'tt-row tt-' + row.kind);
  div.style.height = TL_TREE_ROW_H + 'px';
  div.style.paddingLeft = (4 + (row.depth || 0) * 12) + 'px';
  const expanded = !!row.expanded;

  switch (row.kind) {
    case 'group': {
      div.dataset.selkind = 'group';
      div.dataset.gname = row.name;
      if (state.selectedGroup === row.name) div.classList.add('selected');
      div.appendChild(makeArrow(row.key, expanded));
      const label = el('span', 'tt-label');
      label.textContent = row.name;
      label.title = row.name;
      const count = el('span', 'tt-count');
      count.textContent = tf('tree.memberCount', row.members.length);
      div.appendChild(label);
      div.appendChild(count);
      break;
    }
    case 'particle': {
      div.dataset.selkind = 'particle';
      div.dataset.pid = row.p.id;
      if (state.selected.has(row.p.id)) div.classList.add('selected');
      div.appendChild(makeArrow(row.key, expanded));
      const label = el('span', 'tt-label');
      label.textContent = row.p.id;
      label.title = row.p.id;
      div.appendChild(label);
      break;
    }
    case 'fx': {
      div.dataset.selkind = 'fx';
      div.dataset.fxid = row.fx.id;
      if (state.selectedFunction === row.fx.id) div.classList.add('selected');
      div.appendChild(makeArrow(row.key, expanded));
      const label = el('span', 'tt-label');
      label.textContent = row.fx.name;
      label.title = row.fx.name;
      const count = el('span', 'tt-count');
      count.textContent = tf('tree.fxParticleCount', row.fx.count);
      div.appendChild(label);
      div.appendChild(count);
      break;
    }
    case 'members': {
      div.appendChild(makeArrow(row.key, expanded));
      const label = el('span', 'tt-sub-label');
      label.textContent = tf('tree.particleListCount', row.count);
      div.appendChild(label);
      break;
    }
    case 'vars': {
      div.appendChild(makeArrow(row.key, expanded));
      const label = el('span', 'tt-sub-label');
      label.textContent = t('fx.varList') + ' (' + row.count + ')';
      div.appendChild(label);
      break;
    }
    case 'prop': {
      div.appendChild(makeArrow(row.key, expanded));
      const label = el('span', 'tt-plabel');
      label.textContent = t('prop.' + row.prop);
      div.appendChild(label);

      // XYZ 行：[x, y, z] 三个可编辑当前值
      const vec = el('span', 'tt-vec');
      vec.appendChild(document.createTextNode('['));
      TRACK_COMPS[row.prop].forEach((comp, i) => {
        if (i > 0) vec.appendChild(document.createTextNode(','));
        const inp = el('input', 'tt-val');
        inp.type = 'number';
        inp.step = '0.01';
        inp.dataset.id = row.id;
        inp.dataset.prop = row.prop;
        inp.dataset.comp = comp;
        inp.title = COMP_LABELS[comp];
        if (row.readOnly) inp.disabled = true;
        vec.appendChild(inp);
      });
      vec.appendChild(document.createTextNode(']'));
      div.appendChild(vec);
      break;
    }
    case 'comp': {
      div.appendChild(makeSpacer());
      const label = el('span', 'tt-clabel');
      label.textContent = COMP_LABELS[row.comp];
      const inp = el('input', 'tt-val tt-cval');
      inp.type = 'number';
      inp.step = '0.01';
      inp.dataset.id = row.id;
      inp.dataset.prop = row.prop;
      inp.dataset.comp = row.comp;
      if (row.readOnly) inp.disabled = true;
      const add = el('button', 'tt-add-kf');
      add.textContent = '◇+';
      add.title = t('tree.addKfHint');
      add.dataset.id = row.id;
      add.dataset.prop = row.prop;
      add.dataset.comp = row.comp;
      if (row.readOnly) add.disabled = true;
      div.appendChild(label);
      div.appendChild(inp);
      div.appendChild(add);
      break;
    }
    case 'var': {
      div.appendChild(makeSpacer());
      const label = el('span', 'tt-vname');
      label.textContent = row.name;
      label.title = row.name;
      const inp = el('input', 'tt-var-val');
      inp.type = 'number';
      inp.step = '0.01';
      inp.dataset.fxid = row.fx.id;
      inp.dataset.name = row.name;
      const add = el('button', 'tt-add-var-kf');
      add.textContent = '◇+';
      add.title = t('tree.addKfHint');
      add.dataset.fxid = row.fx.id;
      add.dataset.name = row.name;
      div.appendChild(label);
      div.appendChild(inp);
      div.appendChild(add);
      break;
    }
  }
  return div;
}

/* =========================================================================
 * 刷新 / 初始化
 * ======================================================================= */

// 轻刷新：仅更新数值输入框（不重建 DOM、不画 canvas）
export function drawTimelineTree() {
  const root = document.getElementById('tl-tree');
  if (!root) return;
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

// 结构刷新：仅在对象/展开状态/语言变化时重建 HTML，随后更新数值
export function refreshTimelineTree() {
  const root = document.getElementById('tl-tree');
  if (!root) return;
  const sig = structureSignature();
  if (sig !== lastSig) {
    lastSig = sig;
    const prevScroll = root.scrollTop || 0;
    root.innerHTML = '';
    const rows = tlTreeFlatRows();
    if (rows.length === 0) {
      const hint = el('div', 'tt-empty');
      hint.textContent = t('tree.empty');
      root.appendChild(hint);
    } else {
      for (const row of rows) root.appendChild(renderFlatRow(row));
    }
    root.scrollTop = prevScroll;
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
    const id = addKf.dataset.id;
    const prop = addKf.dataset.prop;
    const comp = addKf.dataset.comp;
    const t = Math.round(state.time);
    editComponentValue(id, prop, comp, t, targetComponentValue(id, prop, comp, t));
    refreshTimelineTree();
    return;
  }
  const addVar = ev.target.closest('.tt-add-var-kf');
  if (addVar) {
    addVariableKeyframe(addVar.dataset.fxid, addVar.dataset.name);
    return;
  }

  // 选中底部列表中的组 / 粒子 / 函数对象；支持 Ctrl 多选与 Shift 连续选择。
  const rowEl = ev.target.closest('.tt-row');
  if (!rowEl) return;
  const selkind = rowEl.dataset.selkind;
  if (!selkind) return;
  const multi = ev.ctrlKey || ev.metaKey;
  if (selkind === 'particle') {
    const pid = rowEl.dataset.pid;
    if (!pid) return;
    if (ev.shiftKey && tlTreeAnchor && tlTreeAnchor.kind === 'particle') {
      const flat = tlTreeFlatRows();
      const ids = flat.filter(r => r.kind === 'particle').map(r => r.p.id);
      const a = ids.indexOf(tlTreeAnchor.id);
      const b = ids.indexOf(pid);
      if (a >= 0 && b >= 0) {
        const lo = Math.min(a, b), hi = Math.max(a, b);
        state.selected.clear();
        for (let i = lo; i <= hi; i++) state.selected.add(ids[i]);
      }
    } else if (multi) {
      state.selected.has(pid) ? state.selected.delete(pid) : state.selected.add(pid);
    } else {
      state.selected.clear();
      state.selected.add(pid);
    }
    state.selectedGroup = null;
    state.selectedFunction = null;
    tlTreeAnchor = { kind: 'particle', id: pid };
    rebuildPoints();
    syncSelectionClasses();
    return;
  }
  if (selkind === 'group') {
    const gname = rowEl.dataset.gname;
    if (!gname) return;
    state.selected.clear();
    state.selectedGroup = gname;
    state.selectedFunction = null;
    tlTreeAnchor = { kind: 'group', id: gname };
    rebuildPoints();
    syncSelectionClasses();
    return;
  }
  if (selkind === 'fx') {
    const fxid = rowEl.dataset.fxid;
    if (!fxid) return;
    state.selected.clear();
    state.selectedGroup = null;
    state.selectedFunction = fxid;
    tlTreeAnchor = { kind: 'fx', id: fxid };
    rebuildPoints();
    refreshFunctionPanel();
    syncSelectionClasses();
  }
}

function syncSelectionClasses() {
  const root = document.getElementById('tl-tree');
  if (!root) return;
  root.querySelectorAll('.tt-particle').forEach(r => {
    r.classList.toggle('selected', state.selected.has(r.dataset.pid));
  });
  root.querySelectorAll('.tt-group').forEach(r => {
    r.classList.toggle('selected', state.selectedGroup === r.dataset.gname);
  });
  root.querySelectorAll('.tt-fx').forEach(r => {
    r.classList.toggle('selected', state.selectedFunction === r.dataset.fxid);
  });
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