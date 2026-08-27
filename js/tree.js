/* =========================================================================
 * 组 / 粒子列表（树状时间轴，分量级）
 * ======================================================================= */


import { t, tf } from './i18n.js';
import { state, COMP_LABELS, PARTICLE_TRACK_DEFS, GROUP_PROP_DEFS, FUNCTION_PROP_DEFS, TRACK_COMPS, compPr, splitCompPr, getParticle, getFunction, isDerivedParticle, nextGroupName } from './constants.js';
import { shiftHeld, getDragIds, setDragIds } from './input-state.js';
import { modalAlert } from './ui.js';
import { baseValue, componentValueAt, particleValueAt, trackValueAt, findTrackByPr, zeroArray, rebuildPoints, resetVelOffsets } from './animation.js';
import { editComponentValue, removeKeyframe, renameParticle, renameGroup, moveParticlesToGroup, removeGroupAndTracks } from './edit.js';
import { pushUndo, popUndo } from './undo.js';
import { deleteFunctionObject } from './generators.js';
import { deleteSelected } from './interaction.js';
import { makeEasingBtn } from './easing-editor.js';
import { TL_PX_PER_TICK, compTimelineViewStart, setCompTimelineViewStart, COMP_TL_MIN_VIEW_START, scrubAutoPan } from './panels.js';
import { updateTimeUI } from './main.js';
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
  refreshParticleTree();
}

export function deleteGroup(name) {
  pushUndo();
  removeGroupAndTracks(name);
  rebuildPoints();
  refreshParticleTree();
}

export function groupedIds() {
  const ids = new Set();
  for (const members of Object.values(state.groups)) for (const id of members) ids.add(id);
  return ids;
}

export function refreshParticleTree() {
  const box = document.getElementById('particle-tree');
  if (!box) return;
  box.innerHTML = '';
  if (state.particles.length === 0 && Object.keys(state.groups).length === 0 && state.functions.length === 0) {
    box.innerHTML = '<div class="hint" style="padding:8px">' + t('tree.empty') + '</div>';
    return;
  }
  const grouped = groupedIds();
  for (const p of state.particles) {
    if (grouped.has(p.id) || p.fx) continue;
    box.appendChild(renderParticleNode(p));
  }
  for (const name of Object.keys(state.groups)) box.appendChild(renderGroupNode(name));
  for (const fx of state.functions) box.appendChild(renderFunctionNode(fx));
  refreshCompTimelines();
}

export function refreshTreeSelection() {
  document.querySelectorAll('.ptree-head').forEach(head => {
    head.classList.toggle('selected', state.selected.has(head.dataset.pid));
  });
  document.querySelectorAll('.ptree-head.group').forEach(head => {
    head.classList.toggle('selected', head.dataset.gname != null && head.dataset.gname === state.selectedGroup);
  });
  document.querySelectorAll('.ptree-head.func').forEach(head => {
    head.classList.toggle('selected', head.dataset.fxid != null && head.dataset.fxid === state.selectedFunction);
  });
}

/* =========================================================================
 * 右键菜单
 * ======================================================================= */

export function closeContextMenu() {
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

const evShift = () => shiftHeld;
export let treeAnchorId = null;

export function startRename(el, onCommit, onCancel) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = el.textContent;
  input.className = 'rename-input';
  el.replaceWith(input);
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

/* =========================================================================
 * 粒子节点
 * ======================================================================= */

export function renderParticleNode(p) {
  const root = document.createElement('div');
  root.className = 'ptree-particle';
  const expanded = state.expandedParticles.has(p.id);
  const head = document.createElement('div');
  head.className = 'ptree-head' + (state.selected.has(p.id) ? ' selected' : '');
  head.dataset.pid = p.id;
  head.draggable = true;
  head.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', p.id);
    setDragIds(state.selected.has(p.id) ? [...state.selected] : [p.id]);
  });
  head.addEventListener('dragend', () => { setDragIds(null); });
  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.textContent = expanded ? '▾' : '▸';
  arrow.onclick = (e) => {
    e.stopPropagation();
    if (expanded) state.expandedParticles.delete(p.id); else state.expandedParticles.add(p.id);
    refreshParticleTree();
  };
  const pid = document.createElement('span');
  pid.className = 'pid'; pid.textContent = p.id;
  pid.title = t('tree.dblclickRename');
  pid.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRename(pid, (v) => renameParticle(p.id, v), () => refreshParticleTree());
  });
  head.appendChild(arrow); head.appendChild(pid);
  const trackCount = state.tracks.filter(tr => tr.ids.length === 1 && tr.ids[0] === p.id).length;
  if (trackCount > 0) {
    const cnt = document.createElement('span');
    cnt.className = 'ptree-track-count';
    cnt.textContent = tf('tree.trackCount', trackCount);
    head.appendChild(cnt);
  }
  head.onclick = () => {
    if (evShift()) {
      const anchorIdx = treeAnchorId ? state.particles.findIndex(x => x.id === treeAnchorId) : -1;
      const idx = state.particles.findIndex(x => x.id === p.id);
      if (anchorIdx >= 0 && idx >= 0 && anchorIdx !== idx) {
        const a = Math.min(anchorIdx, idx), b = Math.max(anchorIdx, idx);
        state.selected.clear();
        for (let i = a; i <= b; i++) state.selected.add(state.particles[i].id);
      } else {
        state.selected.add(p.id);
      }
    } else {
      state.selected.clear();
      state.selected.add(p.id);
      treeAnchorId = p.id;
    }
    state.selectedGroup = null;
    state.selectedFunction = null;
    rebuildPoints();
  };
  head.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      { label: t('tree.deleteParticle'), danger: true, action: () => { state.selected = new Set([p.id]); deleteSelected(); } },
    ]);
  });
  root.appendChild(head);
  if (expanded) {
    root.appendChild(renderPropSection(p.id, PARTICLE_TRACK_DEFS));
  }
  return root;
}

/* =========================================================================
 * 属性分组 + 分量行（图形化时间轴）
 * ======================================================================= */

// 目标分量值（id 可为 'p0' | 'g:g0' | 'f:fx0'）
export function targetComponentValue(id, prop, comp, T) {
  const pr = compPr(prop, comp);
  if (id.startsWith('g:')) {
    const gname = id.slice(2);
    const base = baseValueFor(id, prop, comp);
    const tr = findTrackByPr(pr, 'g:' + gname);
    if (!tr || tr.kf.length === 0) return base;
    return tr.m === 'op' ? base + trackValueAt(tr, T, 0) : trackValueAt(tr, T, base);
  }
  if (id.startsWith('f:')) {
    const fxId = id.slice(2);
    const base = baseValueFor(id, prop, comp);
    const tr = findTrackByPr(pr, 'f:' + fxId);
    if (!tr || tr.kf.length === 0) return base;
    return tr.m === 'op' ? base + trackValueAt(tr, T, 0) : trackValueAt(tr, T, base);
  }
  const p = getParticle(id);
  return p ? componentValueAt(p, prop, comp, T) : 0;
}

export function renderPropSection(id, props) {
  const wrap = document.createElement('div');
  wrap.className = 'ptree-props';
  for (const prop of props) wrap.appendChild(renderPropNode(id, prop));
  return wrap;
}

export function renderPropNode(id, prop) {
  const comps = TRACK_COMPS[prop];
  const wrap = document.createElement('div');
  wrap.className = 'ptree-prop';
  const key = id + '|' + prop;
  const expanded = state.expandedProps.has(key);
  const head = document.createElement('div');
  head.className = 'ptree-prop-head';
  head.innerHTML = '<span class="arrow">' + (expanded ? '▾' : '▸') + '</span><span class="plabel">' + t('prop.' + prop) + '</span>';
  head.onclick = () => {
    if (expanded) state.expandedProps.delete(key); else state.expandedProps.add(key);
    refreshParticleTree();
  };
  wrap.appendChild(head);
  if (expanded) {
    const rows = document.createElement('div');
    rows.className = 'ptree-comp-rows';
    for (const comp of comps) rows.appendChild(renderCompRow(id, prop, comp));
    wrap.appendChild(rows);
  }
  return wrap;
}

export function renderCompRow(id, prop, comp) {
  const pr = compPr(prop, comp);
  const row = document.createElement('div');
  row.className = 'ptree-comp-row';
  const label = document.createElement('span');
  label.className = 'clabel';
  label.textContent = COMP_LABELS[comp]; // 分量标签 X/Y/Z 无需翻译
  row.appendChild(label);
  const val = document.createElement('input');
  val.className = 'cval';
  val.type = 'number';
  val.step = '0.01';
  val.dataset.trackId = id;
  val.dataset.trackPr = pr;
  val.addEventListener('change', () => {
    const v = parseFloat(val.value);
    if (isFinite(v)) editComponentValue(id, prop, comp, Math.round(state.time), v);
  });
  row.appendChild(val);
  const canvas = document.createElement('canvas');
  canvas.className = 'comp-timeline';
  canvas.dataset.trackId = id;
  canvas.dataset.trackPr = pr;
  canvas.dataset.prop = prop;
  canvas.dataset.comp = comp;
  row.appendChild(canvas);
  const addBtn = document.createElement('button');
  addBtn.className = 'kf-add';
  addBtn.innerHTML = '◇+';
  addBtn.title = t('tree.addKfHint');
  addBtn.onclick = () => addComponentKeyframe(id, prop, comp);
  row.appendChild(addBtn);
  bindCompTimeline(canvas, id, pr);
  return row;
}

/* =========================================================================
 * 组节点
 * ======================================================================= */

export function renderGroupNode(name) {
  const root = document.createElement('div');
  root.className = 'ptree-particle';
  const members = state.groups[name] || [];
  const expanded = state.expandedParticles.has('g:' + name);
  const head = document.createElement('div');
  head.className = 'ptree-head group';
  head.dataset.gname = name;
  head.addEventListener('dragover', (e) => {
    if (getDragIds()) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; head.classList.add('drop-hint'); }
  });
  head.addEventListener('dragleave', () => head.classList.remove('drop-hint'));
  head.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    head.classList.remove('drop-hint');
    const ids = getDragIds();
    if (ids) moveParticlesToGroup(ids, name);
    setDragIds(null);
  });
  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.textContent = expanded ? '▾' : '▸';
  arrow.onclick = (e) => {
    e.stopPropagation();
    if (expanded) state.expandedParticles.delete('g:' + name); else state.expandedParticles.add('g:' + name);
    refreshParticleTree();
  };
  const label = document.createElement('span');
  label.className = 'pid';
  label.textContent = name;
  label.title = t('tree.dblclickRename');
  label.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRename(label, (v) => renameGroup(name, v), () => refreshParticleTree());
  });
  const count = document.createElement('span');
  count.className = 'pstyle';
  count.textContent = tf('tree.memberCount', members.length);
  head.appendChild(arrow); head.appendChild(label); head.appendChild(count);
  head.onclick = () => {
    state.selected.clear();
    state.selectedGroup = name;
    state.selectedFunction = null;
    rebuildPoints();
  };
  head.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      { label: t('tree.deleteGroup'), danger: true, action: () => deleteGroup(name) },
    ]);
  });
  root.appendChild(head);
  if (expanded) {
    const section = document.createElement('div');
    section.className = 'ptree-sub';
    section.appendChild(renderGroupPropsNode(name));
    section.appendChild(renderGroupMembersNode(name, members));
    root.appendChild(section);
  }
  return root;
}

// 组/函数对象共用的「属性分组」子节点：默认展开，entityId 为 'g:name' 或 'f:fxId'。
function renderPropsSubNode(key, entityId, propDefs) {
  const wrap = document.createElement('div');
  // 属性分组默认展开：expandedProps 中没有该键时视为「展开」。
  const isCollapsed = state.expandedProps.has(key);
  const head = document.createElement('div');
  head.className = 'ptree-subhead';
  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.textContent = isCollapsed ? '▸' : '▾';
  const label = document.createElement('span');
  label.textContent = t('tab.props');
  head.appendChild(arrow); head.appendChild(label);
  head.onclick = () => {
    if (isCollapsed) state.expandedProps.delete(key); else state.expandedProps.add(key);
    refreshParticleTree();
  };
  wrap.appendChild(head);
  if (!isCollapsed) wrap.appendChild(renderPropSection(entityId, propDefs));
  return wrap;
}

export function renderGroupPropsNode(name) {
  return renderPropsSubNode('g:' + name + '|@props', 'g:' + name, GROUP_PROP_DEFS);
}

// 组/函数对象共用的「成员列表」子节点：members 为粒子对象数组。
function renderMembersSubNode(key, members) {
  const wrap = document.createElement('div');
  const expanded = state.expandedProps.has(key);
  const head = document.createElement('div');
  head.className = 'ptree-subhead';
  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.textContent = expanded ? '▾' : '▸';
  const label = document.createElement('span');
  label.textContent = tf('tree.particleListCount', members.length);
  head.appendChild(arrow); head.appendChild(label);
  head.onclick = () => {
    if (expanded) state.expandedProps.delete(key); else state.expandedProps.add(key);
    refreshParticleTree();
  };
  wrap.appendChild(head);
  if (expanded) {
    const list = document.createElement('div');
    list.className = 'ptree-members';
    for (const p of members) list.appendChild(renderParticleNode(p));
    wrap.appendChild(list);
  }
  return wrap;
}

export function renderGroupMembersNode(name, members) {
  return renderMembersSubNode('g:' + name + '|@members', members.map(getParticle).filter(Boolean));
}

/* =========================================================================
 * 函数对象节点
 * ======================================================================= */

export function renameFunction(oldId, newName) {
  newName = (newName || '').trim();
  if (!newName) return false;
  pushUndo();
  const fx = getFunction(oldId);
  if (fx) fx.name = newName;
  refreshParticleTree();
  refreshFunctionPanel();
  return true;
}

export function renderFunctionNode(fx) {
  const root = document.createElement('div');
  root.className = 'ptree-particle';
  const expanded = state.expandedParticles.has('f:' + fx.id);
  const head = document.createElement('div');
  head.className = 'ptree-head func';
  head.dataset.fxid = fx.id;
  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.textContent = expanded ? '▾' : '▸';
  arrow.onclick = (e) => {
    e.stopPropagation();
    if (expanded) state.expandedParticles.delete('f:' + fx.id); else state.expandedParticles.add('f:' + fx.id);
    refreshParticleTree();
  };
  const label = document.createElement('span');
  label.className = 'pid';
  label.textContent = fx.name;
  label.title = t('tree.dblclickRename');
  label.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRename(label, (v) => renameFunction(fx.id, v), () => refreshParticleTree());
  });
  const count = document.createElement('span');
  count.className = 'pstyle';
  count.textContent = tf('tree.fxParticleCount', fx.count);
  head.appendChild(arrow); head.appendChild(label); head.appendChild(count);
  head.onclick = () => {
    state.selected.clear();
    state.selectedGroup = null;
    state.selectedFunction = fx.id;
    rebuildPoints();
    refreshFunctionPanel();
  };
  head.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      { label: t('tree.deleteFx'), danger: true, action: () => deleteFunctionObject(fx.id) },
    ]);
  });
  root.appendChild(head);
  if (expanded) {
    const section = document.createElement('div');
    section.className = 'ptree-sub';
    section.appendChild(renderFunctionPropsNode(fx));
    section.appendChild(renderFunctionMembersNode(fx));
    root.appendChild(section);
  }
  return root;
}

export function renderFunctionPropsNode(fx) {
  return renderPropsSubNode('f:' + fx.id + '|@props', 'f:' + fx.id, FUNCTION_PROP_DEFS);
}

export function renderFunctionMembersNode(fx) {
  return renderMembersSubNode('f:' + fx.id + '|@members', state.particles.filter(p => p.fx === fx.id));
}

/* =========================================================================
 * 组质心（向量级）
 * ======================================================================= */

export function groupCentroidValue(name, prop) {
  if (prop === 'rot') return [0, 0, 0];
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

/* =========================================================================
 * 图形化时间轴：渲染 + 交互 + 刷新
 * ======================================================================= */

export const TL_HIT_PX = 6; // 菱形命中半径（像素）
export let selectedKeyframe = null; // { id, pr, tick }：当前选中的关键帧（变蓝）

export function selectKeyframe(id, pr, tick) {
  selectedKeyframe = (id && pr && tick != null) ? { id, pr, tick } : null;
  refreshCompTimelines();
}

export function drawCompTimeline(canvas, pr, id) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const pxPerTick = TL_PX_PER_TICK;
  const viewStart = compTimelineViewStart;
  ctx.fillStyle = '#1f222a'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#3a3f4b'; ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
  // 刻度竖线：每 5 tick 短、每 10 tick 长（与底部标尺/图层区同一视口对齐；数字只在标尺显示）
  const viewEnd = viewStart + w / pxPerTick;
  for (let t = Math.max(0, Math.floor(viewStart / 5) * 5); t <= viewEnd; t += 5) {
    const tx = (t - viewStart) * pxPerTick;
    const half = ((t % 10) + 10) % 10 === 0 ? 9 : 4;
    ctx.beginPath(); ctx.moveTo(tx, h / 2 - half); ctx.lineTo(tx, h / 2 + half); ctx.stroke();
  }
  const tr = findTrackByPr(pr, id);
  const kfs = tr ? tr.kf : [];
  for (const kf of kfs) {
    const x = (kf[0] - viewStart) * pxPerTick;
    if (x < -6 || x > w + 6) continue;
    const sel = selectedKeyframe && selectedKeyframe.id === id && selectedKeyframe.pr === pr && selectedKeyframe.tick === kf[0];
    drawDiamond(ctx, x, h / 2, 5, sel ? '#5b9dff' : '#ffcc55');
  }
  const phx = (state.time - viewStart) * pxPerTick;
  if (phx >= 0 && phx <= w) {
    ctx.strokeStyle = '#ffcc55'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(phx, 0); ctx.lineTo(phx, h); ctx.stroke();
  }
}

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

export function canvasTickAt(canvas, clientX) {
  const rect = canvas.getBoundingClientRect();
  return compTimelineViewStart + (clientX - rect.left) / TL_PX_PER_TICK;
}

export function hitKeyframe(pr, id, tick) {
  const tr = findTrackByPr(pr, id);
  if (!tr) return null;
  return tr.kf.find(kf => Math.abs((kf[0] - tick) * TL_PX_PER_TICK) < TL_HIT_PX) || null;
}

export function bindCompTimeline(canvas, id, pr) {
  let drag = null;
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button === 1) { // 中键：平移视图（同底部时间轴）
      ev.preventDefault();
      ev.stopPropagation();
      canvas.setPointerCapture(ev.pointerId);
      drag = { mode: 'pan', lastX: ev.clientX };
      return;
    }
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const tick = canvasTickAt(canvas, ev.clientX);
    const hit = hitKeyframe(pr, id, tick);
    canvas.setPointerCapture(ev.pointerId);
    if (hit) {
      pushUndo();
      drag = { mode: 'keyframe', kfTick: hit[0] };
      selectKeyframe(id, pr, hit[0]);
    } else {
      drag = { mode: 'scrub' };
      selectKeyframe(null);
      setTimeTo(tick);
    }
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    if (drag.mode === 'pan') {
      setCompTimelineViewStart(Math.max(COMP_TL_MIN_VIEW_START, compTimelineViewStart - (ev.clientX - drag.lastX) / TL_PX_PER_TICK));
      drag.lastX = ev.clientX;
      refreshCompTimelines();
      return;
    }
    if (drag.mode === 'keyframe') {
      // 关键帧拖拽同样做 AE 式滞后自动平移：越界时视图单向外追、关键帧钉在边缘内侧 4px；
      // 反向时若指针仍在可视区外则视图不回缩，回到可视区后恢复 1:1 跟随。
      const r = scrubAutoPan(drag, ev.clientX, canvas.getBoundingClientRect(), compTimelineViewStart, drag.kfTick, TL_PX_PER_TICK, COMP_TL_MIN_VIEW_START, 4);
      const vsChanged = r.viewStart !== compTimelineViewStart;
      setCompTimelineViewStart(r.viewStart);
      const nt = Math.max(0, Math.round(r.time)); // 关键帧对齐整数 tick
      if (nt !== drag.kfTick) {
        // 直接改关键帧时间 + 重绘，不重建 DOM（否则 canvas 被替换导致拖拽中断）
        const tr = findTrackByPr(pr, id);
        const kf = tr && tr.kf.find(k => k[0] === drag.kfTick);
        if (kf) {
          kf[0] = nt;
          tr.kf.sort((a, b) => a[0] - b[0]);
          drag.kfTick = nt;
          selectedKeyframe = { id, pr, tick: nt };
          if (keyframeEditorInputs && keyframeEditorInputs.kf === kf) {
            keyframeEditorInputs.tIn.value = nt;
          }
          rebuildPoints();
        }
      } else if (vsChanged) {
        refreshCompTimelines();
      }
    } else {
      // scrub：AE 式滞后自动平移（越界时视图单向外追、游标钉在边缘内侧 4px；反向时若指针仍在可视区外则视图不回缩）
      const r = scrubAutoPan(drag, ev.clientX, canvas.getBoundingClientRect(), compTimelineViewStart, state.time, TL_PX_PER_TICK, COMP_TL_MIN_VIEW_START, 4);
      setCompTimelineViewStart(r.viewStart);
      setTimeTo(r.time);
    }
  });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('dblclick', (ev) => {
    const tick = canvasTickAt(canvas, ev.clientX);
    const hit = hitKeyframe(pr, id, tick);
    if (hit) {
      selectKeyframe(id, pr, hit[0]);
      openKeyframeEditor(canvas, id, pr, hit[0]);
    }
  });
  canvas.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const tick = canvasTickAt(canvas, ev.clientX);
    const hit = hitKeyframe(pr, id, tick);
    if (hit) {
      selectKeyframe(id, pr, hit[0]);
      showContextMenu(ev.clientX, ev.clientY, [
        { label: t('tree.deleteKf'), danger: true, action: () => { selectKeyframe(null); removeKeyframe(id, pr, hit[0]); } },
      ]);
    }
  });
}

export function collectKeyframeTicks() {
  const set = new Set();
  for (const tr of state.tracks) for (const kf of tr.kf) set.add(kf[0]);
  return [...set].sort((a, b) => a - b);
}

export function setTimeTo(tick) {
  let t = Math.max(0, tick);
  if (shiftHeld) {
    const ticks = collectKeyframeTicks();
    if (ticks.length) {
      t = ticks.reduce((best, tk) => Math.abs(tk - t) < Math.abs(best - t) ? tk : best, ticks[0]);
    }
  }
  state.time = t;
  resetVelOffsets();
  updateTimeUI();
  rebuildPoints();
  syncFunctionVarValues();
  refreshCompTimelines();
}

export function addComponentKeyframe(id, prop, comp) {
  pushUndo();
  const pr = compPr(prop, comp);
  let tr = findTrackByPr(pr, id);
  if (!tr) {
    tr = { pr, m: 'set', ids: [id], kf: [[0, baseValueFor(id, prop, comp), state.defaultEasing]] };
    state.tracks.push(tr);
  }
  const t = Math.max(0, Math.round(state.time));
  const cur = targetComponentValue(id, prop, comp, t);
  const existing = tr.kf.find(k => k[0] === t);
  if (existing) {
    existing[1] = cur; // 当前 tick 已有关键帧（如 t=0 的默认帧），更新其值
  } else {
    tr.kf.push([t, cur, state.defaultEasing]);
    tr.kf.sort((a, b) => a[0] - b[0]);
  }
  rebuildPoints();
  refreshParticleTree();
}

export function formatComponentValue(prop, comp, v) {
  if (typeof v !== 'number' || !isFinite(v)) return '—';
  return v.toFixed(2);
}

export function refreshCompTimelines() {
  document.querySelectorAll('.comp-timeline').forEach(canvas => {
    drawCompTimeline(canvas, canvas.dataset.trackPr, canvas.dataset.trackId);
  });
  document.querySelectorAll('.cval').forEach(val => {
    const [prop, comp] = splitCompPr(val.dataset.trackPr);
    const v = targetComponentValue(val.dataset.trackId, prop, comp, state.time);
    val.value = formatComponentValue(prop, comp, v);
  });
}

export let keyframeEditorBox = null;
export let keyframeEditorInputs = null;

export function closeKeyframeEditor(immediate) {
  keyframeEditorBox = null;
  keyframeEditorInputs = null;
  document.removeEventListener('pointerdown', onKfDocPointerDown);
  const b = document.getElementById('kf-editor-pop');
  if (!b) return;
  if (immediate || b.classList.contains('closing')) { b.remove(); return; }
  b.classList.add('closing');
  b.addEventListener('animationend', () => b.remove(), { once: true });
}

export function onKfDocPointerDown(e) {
  if (keyframeEditorBox && !e.target.closest('#kf-editor-pop') && !e.target.closest('#easing-editor')) closeKeyframeEditor();
}

export function openKeyframeEditor(canvas, id, pr, tick) {
  const tr = findTrackByPr(pr, id);
  const kf = tr && tr.kf.find(k => k[0] === tick);
  if (!kf) return;
  const [prop, comp] = splitCompPr(pr);
  closeContextMenu();
  closeKeyframeEditor(true);

  const orig = [kf[0], kf[1], kf[2]];

  const box = document.createElement('div');
  box.id = 'kf-editor-pop';
  box.className = 'kf-editor';
  const title = document.createElement('div');
  title.className = 'ke-title';
  title.textContent = tf('tree.editKf', t('prop.' + prop), COMP_LABELS[comp]);
  box.appendChild(title);

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
  vIn.type = 'number'; vIn.step = '0.01'; vIn.value = Math.round(kf[1] * 1000) / 1000;
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
    tr.kf.sort((a, b) => a[0] - b[0]);
    closeKeyframeEditor();
    rebuildPoints();
    refreshParticleTree();
  };
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = t('common.cancel');
  cancelBtn.onclick = () => {
    kf[0] = orig[0]; kf[1] = orig[1]; kf[2] = orig[2];
    closeKeyframeEditor();
    rebuildPoints();
    refreshParticleTree();
  };
  btnRow.appendChild(okBtn); btnRow.appendChild(cancelBtn);
  box.appendChild(btnRow);

  document.body.appendChild(box);

  // 悬浮定位：水平对准关键帧菱形，垂直在其下方
  const rect = canvas.getBoundingClientRect();
  const kfX = rect.left + (tick - compTimelineViewStart) * TL_PX_PER_TICK;
  box.style.left = Math.min(Math.max(8, kfX), window.innerWidth - box.offsetWidth - 8) + 'px';
  const top = rect.bottom + 6;
  box.style.top = (top + box.offsetHeight > window.innerHeight - 8 ? Math.max(8, rect.top - box.offsetHeight - 6) : top) + 'px';

  keyframeEditorInputs = { tIn, vIn, kf };
  keyframeEditorBox = box;
  setTimeout(() => document.addEventListener('pointerdown', onKfDocPointerDown), 0);
}
