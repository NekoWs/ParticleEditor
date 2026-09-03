/* =========================================================================
 * 底部时间轴左侧标签轨（与 #tl-layers-canvas 的 lane 行一一对应）
 *
 * - 本模块只渲染 HTML 标签/三角形/数值输入/添加关键帧按钮；
 * - 关键帧菱形、播放头、刻度统一由 timeline-layers.js 在 canvas 上绘制；
 * - tlTreeState.expanded 是展开状态的唯一来源；
 * - tlTreeFlatRows() 输出与 HTML 完全一致的扁平行列表，供 canvas 读取。
 * ======================================================================= */

import { t, tf, LANG } from '../core/i18n.js';
import { hasTouch } from '../core/device.js';
import {
  state, propComps, COMP_LABELS, GROUP_PROP_DEFS, PARTICLE_TRACK_DEFS, FUNCTION_PROP_DEFS, CAMERA_PROP_DEFS, FUNCTION_PRESETS,
  getParticle, getFunction, getCamera, isDerivedParticle, plainParticleCache,
} from '../core/constants.js';
import { editComponentValue, renameGroup, renameParticle } from '../core/edit.js';
import { targetComponentValue, startRename } from './tree.js';
import { pushUndo } from '../state/undo.js';
import { varKfValue, FUNCS } from '../core/easing.js';
import { modalAlert } from './ui.js';
import { rebuildPoints } from '../core/animation.js';
import { refreshFunctionPanel, commitFunctionRebuild } from './panels.js';
import { camTrackId } from '../core/cameras.js';
import { refreshCameraTabs } from '../main.js';
import { updateGizmo } from '../interaction/gizmo.js';

export let TL_TREE_ROW_H = 22;
// 触屏设备使用更高的行，保证 44px 左右的触控目标；桌面保持紧凑。
export function updateTLTreeRowH() {
  try {
    TL_TREE_ROW_H = (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ? 32 : 22;
  } catch (e) {
    TL_TREE_ROW_H = 22;
  }
}
export const tlTreeState = { expanded: new Set() };
let tlTreeAnchor = null; // Shift 连续选择锚点（粒子 id 或组名/函数对象 key）

let lastSig = null;
let eventsBound = false;

// 变量名约束：必须能作为公式标识符，且不能与属性保留字、内置变量/常量、函数名冲突
const VAR_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VAR_RESERVED = new Set(['this', 'cx', 'cy', 'cz', 'out', 'pi', 'e', ...Object.keys(FUNCS)]);

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

function makeArrow(key, expanded) {
  const arrow = el('span', 'tt-arrow');
  arrow.textContent = expanded ? '▾' : '▸';
  arrow.dataset.key = key;
  return arrow;
}

function makeSpacer() {
  return el('span', 'tt-arrow tt-arrow-spacer');
}

// 重命名后迁移展开状态键（'g:old'、'g:old|@members'、'p:old|pos|x' 等 → 新键）。
function migrateExpandedKeys(oldKey, newKey) {
  const next = new Set();
  for (const k of tlTreeState.expanded) {
    if (k === oldKey) next.add(newKey);
    else if (k.startsWith(oldKey + '|')) next.add(newKey + k.slice(oldKey.length));
    else next.add(k);
  }
  tlTreeState.expanded = next;
}

function toggleKey(key) {
  if (tlTreeState.expanded.has(key)) tlTreeState.expanded.delete(key);
  else tlTreeState.expanded.add(key);
  refreshTimelineTree();
}

// 切换自转空间（world/local）。id 为 'g:组名' 或 'f:fxId'。
function toggleSpinSpace(id) {
  pushUndo();
  if (id.startsWith('f:')) {
    const fx = getFunction(id.slice(2));
    if (fx) fx.spinSpace = fx.spinSpace === 'local' ? 'world' : 'local';
  } else if (id.startsWith('g:')) {
    const gname = id.slice(2);
    state.groupSpinSpace[gname] = state.groupSpinSpace[gname] === 'world' ? 'local' : 'world';
  }
  rebuildPoints();
  refreshTimelineTree(true);
}

// 切换公转空间（world/local）。id 为 'g:组名' | 'f:fxId' | 'c:camId'。
function toggleRotSpace(id) {
  pushUndo();
  if (id.startsWith('f:')) {
    const fx = getFunction(id.slice(2));
    if (fx) fx.rotSpace = fx.rotSpace === 'local' ? 'world' : 'local';
  } else if (id.startsWith('g:')) {
    const gname = id.slice(2);
    state.groupRotSpace[gname] = state.groupRotSpace[gname] === 'world' ? 'local' : 'world';
  } else if (id.startsWith('c:')) {
    const cam = getCamera(id.slice(2));
    if (cam) cam.rotSpace = cam.rotSpace === 'world' ? 'local' : 'world';
  }
  rebuildPoints();
  refreshTimelineTree(true);
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
  const groupedIds = new Set();
  for (const members of Object.values(state.groups)) for (const id of members) groupedIds.add(id);
  const loose = plainParticleCache.filter(p => !groupedIds.has(p.id));
  let looseH = loose.length;
  for (const p of loose) looseH = hashStr(p.id, looseH);
  parts.push('P:' + looseH);
  for (const [name, members] of Object.entries(state.groups)) {
    let h = members.length;
    if (tlTreeState.expanded.has('g:' + name + '|@members')) {
      for (const id of members) h = hashStr(id, h);
    }
    parts.push('G:' + name + ':' + h);
    parts.push('GS:' + name + ':' + ((state.groupSpinSpace && state.groupSpinSpace[name] === 'world') ? 'world' : 'local'));
    parts.push('GR:' + name + ':' + ((state.groupRotSpace && state.groupRotSpace[name] === 'world') ? 'world' : 'local'));
  }
  for (const fx of state.functions) {
    const names = Object.keys(fx.vars || {});
    let h = names.length;
    if (tlTreeState.expanded.has('f:' + fx.id + '|@vars')) {
      for (const n of names) h = hashStr(n, h);
    }
    parts.push('F:' + fx.id + ':' + hashStr(fx.name || '', 0) + ':' + fx.count + ':' + h);
    parts.push('FS:' + fx.id + ':' + (fx.spinSpace === 'world' ? 'world' : 'local') + ':' + (fx.rotSpace === 'world' ? 'world' : 'local'));
  }
  for (const cam of state.cameras) {
    parts.push('C:' + cam.id + ':' + hashStr(cam.name || '', 0));
    parts.push('CR:' + cam.id + ':' + (cam.rotSpace === 'world' ? 'world' : 'local'));
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
    for (const comp of propComps(id, prop)) {
      rows.push({ key: key + '|' + comp, kind: 'comp', id, prop, comp, readOnly, depth: depth + 1 });
    }
  }
}

export function tlTreeFlatRows() {
  const rows = [];

  // 未成组、非派生的独立粒子（左侧列表已移除，这里是它们唯一入口）
  const groupedIds = new Set();
  for (const members of Object.values(state.groups)) for (const id of members) groupedIds.add(id);
  for (const p of plainParticleCache) {
    if (groupedIds.has(p.id)) continue;
    const pkey = 'p:' + p.id;
    const pexpanded = tlTreeState.expanded.has(pkey);
    rows.push({ key: pkey, kind: 'particle', p, expanded: pexpanded, depth: 0 });
    if (pexpanded) {
      for (const prop of PARTICLE_TRACK_DEFS) pushPropRows(rows, p.id, prop, 1, isDerivedParticle(p));
    }
  }

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

  // 摄像机：顶层对象，展开后显示 pos/rot/fov 属性行
  for (const cam of state.cameras) {
    const cid = camTrackId(cam.id);
    const ckey = cid;
    const cexpanded = tlTreeState.expanded.has(ckey);
    rows.push({ key: ckey, kind: 'camera', cam, expanded: cexpanded, depth: 0 });
    if (!cexpanded) continue;
    for (const prop of CAMERA_PROP_DEFS) pushPropRows(rows, cid, prop, 1, false);
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
  div.dataset.tlkey = row.key;
  const expanded = !!row.expanded;

  switch (row.kind) {
    case 'group': {
      div.dataset.selkind = 'group';
      div.dataset.gname = row.name;
      if (state.selectedGroup === row.name) div.classList.add('selected');
      div.appendChild(makeArrow(row.key, expanded));
      const label = el('span', 'tt-label');
      label.textContent = row.name;
      label.title = row.name + ' · ' + t('tree.dblclickRename');
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
      label.title = isDerivedParticle(row.p) ? row.p.id : row.p.id + ' · ' + t('tree.dblclickRename');
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
      label.title = row.fx.name + ' · ' + t('tree.dblclickRename');
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
    case 'camera': {
      div.dataset.selkind = 'camera';
      div.dataset.camid = row.cam.id;
      if (state.selectedCamera === row.cam.id) div.classList.add('selected');
      div.appendChild(makeArrow(row.key, expanded));
      const icon = el('span', 'tt-cam-icon');
      icon.textContent = '🎥';
      div.appendChild(icon);
      const label = el('span', 'tt-label');
      label.textContent = row.cam.name;
      label.title = row.cam.name + ' · ' + t('tree.dblclickRename');
      div.appendChild(label);
      break;
    }
    case 'vars': {
      div.appendChild(makeArrow(row.key, expanded));
      const label = el('span', 'tt-sub-label');
      label.textContent = t('fx.varList') + ' (' + row.count + ')';
      div.appendChild(label);
      const add = el('button', 'tt-add-var');
      add.textContent = '+';
      add.title = t('fx.addVar');
      add.dataset.fxid = row.fx.id;
      div.appendChild(add);
      break;
    }
    case 'prop': {
      div.appendChild(makeArrow(row.key, expanded));
      const label = el('span', 'tt-plabel');
      // 摄像机的 rot 行语义是「围绕看向目标点公转」，标签用「旋转」；其余对象沿用「公转」
      label.textContent = t((row.prop === 'rot' && row.id.startsWith('c:')) ? 'prop.rotCam' : 'prop.' + row.prop);
      div.appendChild(label);

      // FOV 标量行：单输入框 + 加帧按钮（无 XYZ 三段、无展开分量）
      if (row.prop === 'fov') {
        const inp = el('input', 'tt-val tt-cval');
        inp.type = 'number';
        inp.step = '1';
        inp.min = '1'; inp.max = '179';
        inp.dataset.id = row.id;
        inp.dataset.prop = row.prop;
        inp.dataset.comp = '';
        const add = el('button', 'tt-add-kf');
        add.textContent = '◇+';
        add.title = t('tree.addKfHint');
        add.dataset.id = row.id;
        add.dataset.prop = row.prop;
        add.dataset.comp = '';
        div.appendChild(inp);
        div.appendChild(add);
        break;
      }

      // XYZ 行：合并为组合输入框（不显示 XYZ 字样，靠分隔线区分三个属性）
      const vec = el('div', 'vec3');
      propComps(row.id, row.prop).forEach((comp) => {
        const seg = el('div', 'vec3-seg');
        const inp = el('input', 'tt-val vec3-input');
        inp.type = 'number';
        inp.step = '0.01';
        inp.dataset.id = row.id;
        inp.dataset.prop = row.prop;
        inp.dataset.comp = comp;
        inp.title = COMP_LABELS[comp];
        if (row.readOnly) inp.disabled = true;
        seg.appendChild(inp);
        vec.appendChild(seg);
      });
      div.appendChild(vec);

      // 空间切换按钮（W/L）放在 XYZ 之后：
      // 自转行 → 组/函数对象；公转行 → 组/函数对象 + 摄像机（旋转空间，缺省 L=local）
      if (row.prop === 'spin' && (row.id.startsWith('g:') || row.id.startsWith('f:'))) {
        const spaceBtn = el('button', 'tt-spin-space');
        spaceBtn.type = 'button';
        const cur = row.id.startsWith('f:')
          ? !((getFunction(row.id.slice(2)) || {}).spinSpace === 'world')
          : !(state.groupSpinSpace && state.groupSpinSpace[row.id.slice(2)] === 'world');
        spaceBtn.textContent = t(cur ? 'spinSpace.local' : 'spinSpace.world');
        spaceBtn.title = t('spinSpace.hint');
        spaceBtn.dataset.id = row.id;
        div.appendChild(spaceBtn);
      } else if (row.prop === 'rot' && (row.id.startsWith('g:') || row.id.startsWith('f:'))) {
        const spaceBtn = el('button', 'tt-rot-space');
        spaceBtn.type = 'button';
        const cur = row.id.startsWith('f:')
          ? !((getFunction(row.id.slice(2)) || {}).rotSpace === 'world')
          : !(state.groupRotSpace && state.groupRotSpace[row.id.slice(2)] === 'world');
        spaceBtn.textContent = t(cur ? 'rotSpace.local' : 'rotSpace.world');
        spaceBtn.title = t('rotSpace.hint');
        spaceBtn.dataset.id = row.id;
        div.appendChild(spaceBtn);
      } else if (row.prop === 'rot' && row.id.startsWith('c:')) {
        const cam = getCamera(row.id.slice(2));
        const spaceBtn = el('button', 'tt-rot-space');
        spaceBtn.type = 'button';
        spaceBtn.textContent = t((cam && cam.rotSpace === 'world') ? 'rotSpace.world' : 'rotSpace.local');
        spaceBtn.title = t('rotSpace.hint');
        spaceBtn.dataset.id = row.id;
        div.appendChild(spaceBtn);
      }
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
      label.title = row.name + ' · ' + t('tree.dblclickRename');
      label.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startRename(label, (v) => renameVariable(row.fx, row.name, v), () => refreshTimelineTree(true));
      });
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
      // 预设参数对应的变量：在变量名右侧以灰色显示参数提示（如 rad → 半径）。
      const preset = row.fx.preset && FUNCTION_PRESETS[row.fx.preset];
      const prm = preset && (preset.params || []).find(p => p.key === row.name);
      if (prm) {
        const hint = el('span', 'tt-var-hint');
        hint.textContent = t('fx.param.' + prm.key);
        div.appendChild(hint);
      }
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
    inp.disabled = false;
    inp.value = fmtNum(kf.length > 0 ? varKfValue(kf, state.time) : (Number.isFinite(v.base) ? v.base : 0));
  });
}

// 结构刷新：仅在对象/展开状态/语言变化时重建 HTML，随后更新数值。
// force=true 时无条件重建（用于行内重命名等需要恢复原始 DOM 的场景）。
export function refreshTimelineTree(force = false) {
  const root = document.getElementById('tl-tree');
  if (!root) return;
  const sig = structureSignature();
  if (force || sig !== lastSig) {
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
    root.addEventListener('dblclick', onTreeDblClick);
    root.addEventListener('change', onTreeChange);

    // 触屏没有可靠的 dblclick：手动识别双击，复用同一处理逻辑（展开/折叠、双击重命名）。
    if (hasTouch()) {
      let lastTap = null;
      root.addEventListener('pointerup', (ev) => {
        if (ev.pointerType !== 'touch') return;
        const now = Date.now();
        if (lastTap && now - lastTap.t <= 360 && Math.hypot(ev.clientX - lastTap.x, ev.clientY - lastTap.y) <= 14) {
          lastTap = null;
          onTreeDblClick(ev);
        } else {
          lastTap = { t: now, x: ev.clientX, y: ev.clientY };
        }
      });
    }
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
  const addVar = ev.target.closest('.tt-add-var');
  if (addVar) {
    addVariable(addVar.dataset.fxid);
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
  const addVarKf = ev.target.closest('.tt-add-var-kf');
  if (addVarKf) {
    addVariableKeyframe(addVarKf.dataset.fxid, addVarKf.dataset.name);
    return;
  }
  const spinSpaceBtn = ev.target.closest('.tt-spin-space');
  if (spinSpaceBtn) {
    ev.stopPropagation();
    toggleSpinSpace(spinSpaceBtn.dataset.id);
    return;
  }
  const rotSpaceBtn = ev.target.closest('.tt-rot-space');
  if (rotSpaceBtn) {
    ev.stopPropagation();
    toggleRotSpace(rotSpaceBtn.dataset.id);
    return;
  }

  // 选中底部列表中的组 / 粒子 / 函数对象；支持 Ctrl 多选与 Shift 连续选择。
  const rowEl = ev.target.closest('.tt-row');
  if (!rowEl) return;
  // 展开/折叠改为双击行触发；三角形点击仍即时切换（见 onTreeClick 顶部与 onTreeDblClick）。
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
    state.selectedCamera = null; // 选中其他对象即取消摄像机选中
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
    state.selectedCamera = null; // 选中其他对象即取消摄像机选中
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
    state.selectedCamera = null; // 选中其他对象即取消摄像机选中
    tlTreeAnchor = { kind: 'fx', id: fxid };
    rebuildPoints();
    refreshFunctionPanel();
    syncSelectionClasses();
    return;
  }
  if (selkind === 'camera') {
    const camid = rowEl.dataset.camid;
    if (!camid) return;
    // 点击摄像机行仅选中并展开属性，不切换视角（视角切换走顶部选项卡）
    state.selected.clear();
    state.selectedGroup = null;
    state.selectedFunction = null;
    state.selectedCamera = camid;
    tlTreeAnchor = { kind: 'camera', id: camid };
    // 展开该摄像机属性行，便于直接编辑
    tlTreeState.expanded.add('c:' + camid);
    refreshTimelineTree(true);
    syncSelectionClasses();
    // 选中摄像机后立即刷新 gizmo（旋转工具下在看向目标点显示旋转环）
    updateGizmo();
  }
}

// 双击名字标签 → 行内重命名（输入框替换标签，回车确认 / Esc 取消 / 失焦提交）；
// 双击行的其余部分 → 展开/折叠整行（三角形点击仍即时切换）。输入框/按钮双击不触发。
function onTreeDblClick(ev) {
  const rowEl = ev.target.closest('.tt-row');
  if (!rowEl) return;
  // 名字标签双击重命名（事件委托：行 DOM 可能在两次点击之间被重建，委托不受影响）
  const nameLabel = ev.target.closest('.tt-label');
  if (nameLabel) {
    const selkind = rowEl.dataset.selkind;
    if (selkind === 'group' && rowEl.dataset.gname) {
      startRename(nameLabel, (v) => renameGroupUI(rowEl.dataset.gname, v), () => refreshTimelineTree(true));
      return;
    }
    if (selkind === 'particle' && rowEl.dataset.pid) {
      const p = getParticle(rowEl.dataset.pid);
      if (p && !isDerivedParticle(p)) {
        startRename(nameLabel, (v) => renameParticleUI(p, v), () => refreshTimelineTree(true));
        return;
      }
    }
    if (selkind === 'fx' && rowEl.dataset.fxid) {
      const fx = getFunction(rowEl.dataset.fxid);
      if (fx) {
        startRename(nameLabel, (v) => renameFunctionUI(fx, v), () => refreshTimelineTree(true));
        return;
      }
    }
    if (selkind === 'camera' && rowEl.dataset.camid) {
      const cam = getCamera(rowEl.dataset.camid);
      if (cam) {
        startRename(nameLabel, (v) => renameCameraUI(cam, v), () => refreshTimelineTree(true));
        return;
      }
    }
    // 未命中的标签双击按普通行处理：继续走展开/折叠
  }
  const tlkey = rowEl.dataset.tlkey;
  if (!tlkey) return;
  if (ev.target.closest('input') || ev.target.closest('button') || ev.target.closest('.tt-arrow')) return;
  toggleKey(tlkey);
}

// 轻量同步树的选中高亮（供视口选区变化等跨模块路径调用）。
export function syncSelectionClasses() {
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
  root.querySelectorAll('.tt-camera').forEach(r => {
    r.classList.toggle('selected', state.selectedCamera === r.dataset.camid);
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
    // 与其他关键帧一致：直接输入值即在当前时间创建/更新关键帧
    const tick = Math.max(0, Math.round(state.time));
    const kf = v.kf || (v.kf = []);
    const existing = kf.find(k => k[0] === tick);
    if (existing) existing[1] = nv;
    else { kf.push([tick, nv, state.defaultEasing]); kf.sort((a, b) => a[0] - b[0]); }
    commitFunctionRebuild(fx);
    refreshTimelineTree();
  }
}

// 重命名组（名字即组键，需同步轨道/选中/展开状态/组级贴图与空间设置）
function renameGroupUI(oldName, raw) {
  const nn = (raw || '').trim();
  if (!nn || nn === oldName) { refreshTimelineTree(true); return; }
  if (nn in state.groups) {
    modalAlert(t('tree.hint'), tf('alert.nameTaken', nn));
    refreshTimelineTree(true);
    return;
  }
  if (!renameGroup(oldName, nn)) {
    modalAlert(t('alert.renameFailed'), t('alert.nameEmpty'));
    refreshTimelineTree(true);
    return;
  }
  migrateExpandedKeys('g:' + oldName, 'g:' + nn);
  refreshTimelineTree(true);
}

// 重命名普通粒子（派生粒子 id 是函数对象结构的一部分，不允许改名）
function renameParticleUI(p, raw) {
  if (isDerivedParticle(p)) { refreshTimelineTree(true); return; }
  const nn = (raw || '').trim();
  if (!nn || nn === p.id) { refreshTimelineTree(true); return; }
  if (getParticle(nn)) {
    modalAlert(t('tree.hint'), tf('alert.nameTaken', nn));
    refreshTimelineTree(true);
    return;
  }
  if (!renameParticle(p.id, nn)) {
    modalAlert(t('alert.renameFailed'), t('alert.nameEmpty'));
    refreshTimelineTree(true);
    return;
  }
  if (tlTreeAnchor && tlTreeAnchor.kind === 'particle' && tlTreeAnchor.id === p.id) tlTreeAnchor.id = nn;
  migrateExpandedKeys('p:' + p.id, 'p:' + nn);
  refreshTimelineTree(true);
}

// 重命名函数对象（id 不变，仅改显示名）
function renameFunctionUI(fx, raw) {
  const nn = (raw || '').trim();
  if (!nn || nn === fx.name) { refreshTimelineTree(true); return; }
  pushUndo();
  fx.name = nn;
  refreshTimelineTree(true);
  refreshFunctionPanel();
}

// 重命名摄像机（id 不变，仅改显示名；视口顶部选项卡同步刷新）
function renameCameraUI(cam, raw) {
  const nn = (raw || '').trim();
  if (!nn || nn === cam.name) { refreshTimelineTree(true); return; }
  pushUndo();
  cam.name = nn;
  refreshTimelineTree(true);
  refreshCameraTabs();
}

function renameVariable(fx, oldName, raw) {
  const nn = (raw || '').trim();
  if (!nn || nn === oldName) { refreshTimelineTree(true); return; }
  if (!VAR_IDENT_RE.test(nn)) {
    modalAlert(t('fx.varNameError'), tf('fx.varNameInvalid', nn));
    refreshTimelineTree(true);
    return;
  }
  if (VAR_RESERVED.has(nn)) {
    modalAlert(t('fx.varNameError'), tf('fx.varNameReserved', nn));
    refreshTimelineTree(true);
    return;
  }
  if (Object.prototype.hasOwnProperty.call(fx.vars || {}, nn)) {
    modalAlert(t('fx.varNameError'), tf('fx.varNameExists', nn));
    refreshTimelineTree(true);
    return;
  }
  pushUndo();
  fx.vars[nn] = fx.vars[oldName];
  delete fx.vars[oldName];
  commitFunctionRebuild(fx);
  refreshTimelineTree(true);
}

function addVariable(fxId) {
  const fx = getFunction(fxId);
  if (!fx) return;
  pushUndo();
  if (!fx.vars) fx.vars = {};
  let k = 0;
  while (('v' + k) in fx.vars) k++;
  fx.vars['v' + k] = { base: 0, kf: [] };
  // 展开变量行，让新建变量立即可见并可直接编辑
  tlTreeState.expanded.add('f:' + fx.id + '|@vars');
  commitFunctionRebuild(fx);
  refreshTimelineTree();
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
  commitFunctionRebuild(fx);
  refreshTimelineTree();
}