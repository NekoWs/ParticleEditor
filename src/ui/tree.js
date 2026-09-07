// 组操作 / 右键菜单 / 重命名 / 关键帧编辑弹窗 / 数据查询。左侧粒子树 UI 已移除，
// 这里保留组操作、右键菜单、关键帧编辑弹窗和组质心 / 目标分量值等查询工具；
// 旧的粒子树节点渲染与 .comp-timeline 分量时间轴已删除（由 timeline-layers.js 承担）。

import { t, tf } from '../core/i18n.js';
import { state, COMP_LABELS, compPr, splitCompPr, getParticle, isDerivedParticle, nextGroupName } from '../core/constants.js';
import { modalAlert } from './ui.js';
import { baseValue, componentValueAt, particleValueAt, trackValueAt, findTrackByPr, zeroArray, rebuildPoints } from '../core/animation.js';
import { removeGroupAndTracks, baseValueFor } from '../core/edit.js';
import { cameraValueAt } from '../core/cameras.js';
import { pushUndo, popUndo } from '../state/undo.js';
import { makeEasingBtn, easingCurveSVG } from './easing-editor.js';
import { r3 } from '../io/io.js';
import { TL_PX_PER_TICK, compTimelineViewStart, commitFunctionRebuild } from './panels.js';

// —— 组操作 ——

export function createGroup() {
  if (state.selected.size < 1) { modalAlert(t('tree.hint'), t('tree.selectParticlesFirst')); return; }
  pushUndo();
  const name = nextGroupName();
  const idSet = new Set([...state.selected].filter(id => !isDerivedParticle(getParticle(id))));
  if (idSet.size < 1) { popUndo(); modalAlert(t('tree.hint'), t('tree.derivedNoGroup')); return; }
  for (const g in state.groups) {
    state.groups[g] = state.groups[g].filter(id => !idSet.has(id));
    if (state.groups[g].length === 0) delete state.groups[g];
  }
  state.groups[name] = [...idSet];
  state.selectedGroup = name;
  state.selectedCamera = null; // 建组后选中组，取消摄像机选中
}

export function deleteGroup(name) {
  pushUndo();
  removeGroupAndTracks(name);
  rebuildPoints();
}

// —— 右键菜单 ——

function closeContextMenu() {
  const m = document.getElementById('context-menu');
  if (!m || m.classList.contains('closing')) return;
  m.classList.add('closing');
  setTimeout(() => m.remove(), 130); // 等收起动画（左上→右下展开的逆过程）播完再移除
}

export function showContextMenu(x, y, items) {
  closeContextMenu();
  // 新菜单即将出现：立即清掉仍在播放收起动画的旧菜单，避免重叠
  document.querySelectorAll('#context-menu.closing').forEach(e => e.remove());
  const menu = document.createElement('div');
  menu.id = 'context-menu';
  menu.className = 'context-menu';
  for (const item of items) {
    if (item === null) { const sep = document.createElement('div'); sep.className = 'cm-sep'; menu.appendChild(sep); continue; }
    const btn = document.createElement('button');
    btn.className = 'cm-item' + (item.danger ? ' danger' : '');
    btn.textContent = item.label;
    btn.onclick = () => { closeContextMenu(); item.action(); };
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  menu.style.left = Math.min(x, window.innerWidth - 160) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - items.length * 32 - 12) + 'px';
}

window.addEventListener('pointerdown', (e) => { if (!e.target.closest('#context-menu') && !e.target.closest('.kf-editor')) closeContextMenu(); });

// —— 重命名 ——

export function startRename(el, onCommit, onCancel) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = el.textContent;
  input.className = 'rename-input';
  el.replaceWith(input);
  syncRenameWidth(input);
  input.addEventListener('input', () => syncRenameWidth(input));
  input.focus();
  input.select();
  let done = false;
  const commit = () => { if (done) return; done = true; onCommit(input.value); };
  const cancel = () => { if (done) return; done = true; onCancel(); };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') cancel();
  });
}

// 让重命名输入框宽度随内容变化（保留左右各 5px padding + 各 1px border）
let renameMeasureCtx = null;
function syncRenameWidth(input) {
  if (!renameMeasureCtx) renameMeasureCtx = document.createElement('canvas').getContext('2d');
  renameMeasureCtx.font = getComputedStyle(input).font;
  const text = input.value || 'M';
  const contentW = Math.max(1, renameMeasureCtx.measureText(text).width);
  input.style.width = Math.ceil(contentW + 12) + 'px';   // 12 = 5*2 padding + 1*2 border
}

// —— 数据查询 ——

// 目标分量值（id 可为 'p0' | 'g:g0' | 'f:fx0' | 'c:cam1'）
export function targetComponentValue(id, prop, comp, T) {
  const pr = compPr(prop, comp);
  if (id.startsWith('g:') || id.startsWith('f:')) {
    const base = baseValueFor(id, prop, comp);
    const tr = findTrackByPr(pr, id);
    if (!tr || tr.kf.length === 0) return base;
    return tr.m === 'op' ? base + trackValueAt(tr, T, 0) : trackValueAt(tr, T, base);
  }
  if (id.startsWith('c:')) {
    return cameraValueAt(id.slice(2), prop, comp, T);
  }
  const p = getParticle(id);
  return p ? componentValueAt(p, prop, comp, T) : 0;
}

export function groupCentroidValue(name, prop) {
  if (prop === 'rot' || prop === 'spin' || prop === 'center') return [0, 0, 0];
  if (prop === 'scl') return [1, 1, 1]; // 组缩放基准为 1（整体位置缩放，与粒子大小无关）
  const members = (state.groups[name] || []).map(getParticle).filter(Boolean);
  if (members.length === 0) return zeroArray(prop);
  const sum = zeroArray(prop);
  for (const m of members) {
    const v = baseValue(m, prop);
    for (let i = 0; i < sum.length; i++) sum[i] += v[i];
  }
  return sum.map(v => r3(v / members.length));
}

export function groupCurrentCentroid(name, prop) {
  const members = (state.groups[name] || []).map(getParticle).filter(Boolean);
  if (members.length === 0) return zeroArray(prop);
  const sum = zeroArray(prop);
  for (const m of members) {
    const v = particleValueAt(m, prop, state.time);
    for (let i = 0; i < sum.length; i++) sum[i] += v[i];
  }
  return sum.map(v => r3(v / members.length));
}

// —— 关键帧编辑弹窗（底部时间轴 lane 复用） ——

export function drawDiamond(ctx, x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fill();
}

let keyframeEditorBox = null;
let keyframeEditorInputs = null;

function closeKeyframeEditor(immediate) {
  keyframeEditorBox = null;
  keyframeEditorInputs = null;
  document.removeEventListener('pointerdown', onKfDocPointerDown);
  const b = document.getElementById('kf-editor-pop');
  if (!b) return;
  if (immediate || b.classList.contains('closing')) { b.remove(); return; }
  b.classList.add('closing');
  b.addEventListener('animationend', () => b.remove(), { once: true });
}

function onKfDocPointerDown(e) {
  if (keyframeEditorBox && !e.target.closest('#kf-editor-pop') && !e.target.closest('#easing-editor')) closeKeyframeEditor();
}

export function openKeyframeEditor(canvas, id, pr, tick, clientX, clientY) {
  const tr = findTrackByPr(pr, id);
  const kf = tr && tr.kf.find(k => k[0] === tick);
  if (!kf) return;
  const [prop, comp] = splitCompPr(pr);
  closeContextMenu();
  closeKeyframeEditor(true);
  openKeyframeEditorCommon({
    title: tf('tree.editKf', t('prop.' + prop), COMP_LABELS[comp]),
    kfArr: tr.kf, kf, clientX, clientY,
    onCommit: () => rebuildPoints(),
    onCancel: () => rebuildPoints(),
    positionFallback: (box) => {
      // 悬浮定位：水平对准关键帧菱形，垂直在其下方
      const rect = canvas.getBoundingClientRect();
      const kfX = rect.left + (tick - compTimelineViewStart) * TL_PX_PER_TICK;
      box.style.left = Math.min(Math.max(8, kfX), window.innerWidth - box.offsetWidth - 8) + 'px';
      const top = rect.bottom + 6;
      box.style.top = (top + box.offsetHeight > window.innerHeight - 8 ? Math.max(8, rect.top - box.offsetHeight - 6) : top) + 'px';
    },
  });
}

/** 函数对象变量的关键帧编辑弹窗（变量关键帧存储在 fx.vars[name].kf，不走粒子轨道）。 */
export function openVarKeyframeEditor(canvas, fx, name, tick, clientX, clientY) {
  const v = fx && fx.vars && fx.vars[name];
  const kfArr = v && v.kf ? v.kf : [];
  const kf = kfArr.find(k => k[0] === tick);
  if (!kf) return;
  closeContextMenu();
  closeKeyframeEditor(true);
  openKeyframeEditorCommon({
    title: tf('tree.editVarKf', name),
    kfArr, kf, clientX, clientY,
    onCommit: () => commitFunctionRebuild(fx),
    onCancel: () => commitFunctionRebuild(fx),
  });
}

// 关键帧编辑弹窗的共用 DOM 构建（openKeyframeEditor / openVarKeyframeEditor 复用）。
// 差异点：标题、提交/取消后的动作、无 clientX/clientY 时的悬浮定位（positionFallback，可省略）。
function openKeyframeEditorCommon({ title, kfArr, kf, clientX, clientY, onCommit, onCancel, positionFallback }) {
  const orig = [kf[0], kf[1], kf[2]];

  const box = document.createElement('div');
  box.id = 'kf-editor-pop';
  box.className = 'kf-editor';
  const titleEl = document.createElement('div');
  titleEl.className = 'ke-title';
  titleEl.textContent = title;
  box.appendChild(titleEl);

  const mkLabel = (text) => { const s = document.createElement('span'); s.className = 'ke-label'; s.textContent = text; return s; };

  const tRow = document.createElement('div');
  tRow.className = 'row';
  tRow.appendChild(mkLabel(t('tree.time')));
  const tIn = document.createElement('input');
  tIn.type = 'number'; tIn.min = '0'; tIn.value = kf[0];
  tRow.appendChild(tIn);
  box.appendChild(tRow);

  const vRow = document.createElement('div');
  vRow.className = 'row';
  vRow.appendChild(mkLabel(t('tree.value')));
  const vIn = document.createElement('input');
  vIn.type = 'number'; vIn.step = '0.01'; vIn.value = r3(kf[1]);
  vRow.appendChild(vIn);
  box.appendChild(vRow);

  const eRow = document.createElement('div');
  eRow.className = 'row';
  eRow.appendChild(mkLabel(t('tree.easingLabel')));
  const easeBtn = makeEasingBtn(kf[2], (nv) => { kf[2] = nv; easeBtn.innerHTML = easingCurveSVG(nv); });
  eRow.appendChild(easeBtn);
  box.appendChild(eRow);

  const btnRow = document.createElement('div');
  btnRow.className = 'ke-btns';
  const okBtn = document.createElement('button');
  okBtn.textContent = t('common.ok');
  okBtn.onclick = () => {
    pushUndo();
    kf[0] = Math.max(0, parseInt(tIn.value) || 0);
    kf[1] = parseFloat(vIn.value) || 0;
    kfArr.sort((a, b) => a[0] - b[0]);
    closeKeyframeEditor();
    onCommit();
  };
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = t('common.cancel');
  cancelBtn.onclick = () => {
    kf[0] = orig[0]; kf[1] = orig[1]; kf[2] = orig[2];
    closeKeyframeEditor();
    onCancel();
  };
  btnRow.appendChild(okBtn); btnRow.appendChild(cancelBtn);
  box.appendChild(btnRow);

  document.body.appendChild(box);

  if (clientX != null && clientY != null) {
    // 在鼠标右下弹出，避免与关键帧/播放头重叠
    box.style.left = Math.min(Math.max(8, clientX + 8), window.innerWidth - box.offsetWidth - 8) + 'px';
    box.style.top = Math.min(Math.max(8, clientY + 8), window.innerHeight - box.offsetHeight - 8) + 'px';
  } else if (positionFallback) {
    positionFallback(box);
  }

  keyframeEditorInputs = { tIn, vIn, kf };
  keyframeEditorBox = box;
  setTimeout(() => document.addEventListener('pointerdown', onKfDocPointerDown), 0);
}

/** 删除函数对象变量的关键帧。 */
export function removeVarKeyframe(fx, name, tick) {
  const v = fx && fx.vars && fx.vars[name];
  if (!v || !Array.isArray(v.kf)) return;
  pushUndo();
  v.kf = v.kf.filter(k => k[0] !== tick);
  commitFunctionRebuild(fx);
}
