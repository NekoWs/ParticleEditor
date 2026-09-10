// 工作区系统 v3：
// - 桌面端侧栏（左/右）为「垂直分组栈」，支持上下分窗（多个面板组上下堆叠、可拖分隔条改高）；
// - 底部坞为「水平分组行」，支持左右分窗（时间轴与其他面板左右并排、可拖分隔条改宽）；
// - 侧栏标签可拖出为浮动窗口，浮动窗口可拖回侧栏/底部坞或合并为标签；
// - 内置预设 + 自动布局 + 自定义工作区本地保存；
// - 吸附预览按放置后的真实尺寸渲染，放置后尺寸与预览一致。
// 窄屏（≤1024px）由 mobile.css 抽屉布局接管。

import { isNarrowLayout } from '../core/device.js';
import { t, applyI18nDom } from '../core/i18n.js';
import { modalPrompt, modalConfirm } from './ui.js';

const LS_ACTIVE = 'pdraw-workspace-active';
const LS_CUSTOM = 'pdraw-workspace-custom';

const PANES = ['props', 'fx', 'texture'];
const FLOAT_SIZES = { props: { w: 340, h: 480 }, fx: { w: 340, h: 480 }, texture: { w: 560, h: 460 } };

const PRESETS = {
  default:     { sidebarDock: 'right', sidebarVisible: true,  timelineDock: 'bottom', timelineVisible: true },
  left:        { sidebarDock: 'left',  sidebarVisible: true,  timelineDock: 'bottom', timelineVisible: true },
  draw:        { sidebarDock: 'right', sidebarVisible: false, timelineDock: 'bottom', timelineVisible: true },
  animate:     { sidebarDock: 'right', sidebarVisible: true,  timelineDock: 'bottom', timelineVisible: true, timelineHeight: 480 },
  timelineTop: { sidebarDock: 'right', sidebarVisible: true,  timelineDock: 'top',    timelineVisible: true },
};

function defaultGroups() {
  return {
    sideGroups: [{ panes: ['props', 'fx', 'texture'], active: 'props' }],
    sideSizes: [100],
    bottomGroups: [{ panes: ['timeline'], active: 'timeline' }],
    bottomSizes: [100],
  };
}

const layoutEl = () => document.querySelector('.layout');
const sidebarEl = () => document.querySelector('.sidebar');
const bottomEl = () => document.getElementById('ws-bottom');
const floatWindow = (id) => document.querySelector('.ws-float[data-pane="' + id + '"]');

let _dock = { sidebar: 'right', timeline: 'bottom' };
let _state = Object.assign({}, PRESETS.default, defaultGroups(), { sidebarWidth: 320, timelineHeight: 360, floats: {} });
let initialized = false;
let suppressTabClick = false;

const zones = {};

function normalize(s) {
  const out = {
    sidebarDock: s.sidebarDock === 'left' ? 'left' : 'right',
    sidebarVisible: s.sidebarVisible !== false,
    timelineDock: s.timelineDock === 'top' ? 'top' : 'bottom',
    timelineVisible: s.timelineVisible !== false,
    sidebarWidth: s.sidebarWidth || null,
    timelineHeight: s.timelineHeight || null,
  };
  const g = defaultGroups();
  out.sideGroups = normalizeGroups(s.sideGroups, true) || g.sideGroups;
  out.bottomGroups = normalizeGroups(s.bottomGroups, false) || g.bottomGroups;
  out.floats = {};
  if (s.floats && typeof s.floats === 'object') {
    for (const id of PANES) {
      if (s.floats[id]) out.floats[id] = { x: Math.round(s.floats[id].x || 60), y: Math.round(s.floats[id].y || 80) };
    }
  }
  // 每个面板恰好在「侧栏/底部/浮动」之一。
  const placed = new Set();
  out.sideGroups.forEach((gr) => gr.panes.forEach((p) => placed.add(p)));
  out.bottomGroups.forEach((gr) => gr.panes.forEach((p) => placed.add(p)));
  for (const id of PANES) if (out.floats[id]) placed.add(id);
  for (const id of PANES) {
    if (!placed.has(id)) { out.sideGroups[0].panes.push(id); placed.add(id); }
  }
  for (const id of PANES) {
    if (out.floats[id]) {
      out.sideGroups.forEach((gr) => { gr.panes = gr.panes.filter((p) => p !== id); });
      out.bottomGroups.forEach((gr) => { gr.panes = gr.panes.filter((p) => p !== id); });
    }
  }
  out.sideGroups = out.sideGroups.filter((gr) => gr.panes.length);
  out.bottomGroups = out.bottomGroups.filter((gr) => gr.panes.length);
  if (!out.sideGroups.length && !Object.keys(out.floats).length) {
    out.sideGroups = [{ panes: ['props', 'fx', 'texture'], active: 'props' }];
  }
  if (!out.bottomGroups.length) out.bottomGroups = [{ panes: ['timeline'], active: 'timeline' }];
  out.sideSizes = normalizeSizes(s.sideSizes, out.sideGroups.length);
  out.bottomSizes = normalizeSizes(s.bottomSizes, out.bottomGroups.length);
  return out;
}

function normalizeGroups(list, side) {
  if (!Array.isArray(list) || !list.length) return null;
  const out = [];
  for (const gr of list) {
    if (!gr || !Array.isArray(gr.panes) || !gr.panes.length) continue;
    const panes = gr.panes.filter((p) => (side ? PANES.includes(p) : (p === 'timeline' || PANES.includes(p))));
    if (!panes.length) continue;
    out.push({ panes, active: panes.includes(gr.active) ? gr.active : panes[0] });
  }
  return out.length ? out : null;
}

function normalizeSizes(sizes, n) {
  const arr = Array.isArray(sizes) ? sizes.map((x) => +x || 0) : [];
  while (arr.length < n) arr.push(0);
  const used = arr.slice(0, n);
  const sum = used.reduce((a, b) => a + b, 0);
  if (sum > 0) return used.map((x) => Math.round(x / sum * 100));
  return used.map((_, i) => Math.round(100 / n));
}

export function currentWorkspaceState() {
  const l = layoutEl(), b = document.body;
  const floats = {};
  document.querySelectorAll('.ws-float[data-pane]').forEach((w) => {
    floats[w.dataset.pane] = { x: parseInt(w.style.left, 10) || 60, y: parseInt(w.style.top, 10) || 80 };
  });
  return {
    sidebarDock: _dock.sidebar,
    sidebarVisible: !b.classList.contains('ws-sidebar-hidden'),
    timelineDock: _dock.timeline,
    timelineVisible: !b.classList.contains('ws-timeline-hidden'),
    sidebarWidth: parseInt(l.style.getPropertyValue('--right-w'), 10) || 320,
    timelineHeight: parseInt(b.style.getPropertyValue('--tl-h'), 10) || 360,
    sideGroups: _state.sideGroups.map((g) => ({ panes: g.panes.slice(), active: g.active })),
    sideSizes: _state.sideSizes.slice(),
    bottomGroups: _state.bottomGroups.map((g) => ({ panes: g.panes.slice(), active: g.active })),
    bottomSizes: _state.bottomSizes.slice(),
    floats,
  };
}

export function applyWorkspaceState(state, persist = true) {
  _state = normalize(state);
  if (isNarrowLayout()) {
    for (const id of PANES) {
      if (_state.floats[id]) {
        delete _state.floats[id];
        if (!_state.sideGroups[0].panes.includes(id)) _state.sideGroups[0].panes.push(id);
      }
    }
    _state.sideSizes = normalizeSizes(_state.sideSizes, _state.sideGroups.length);
    _state.bottomSizes = normalizeSizes(_state.bottomSizes, _state.bottomGroups.length);
  }
  _dock.sidebar = _state.sidebarDock;
  _dock.timeline = _state.timelineDock;

  const l = layoutEl(), b = document.body;
  b.classList.remove('ws-sidebar-hidden', 'ws-timeline-top', 'ws-timeline-hidden');
  l.classList.remove('ws-sidebar-left');
  if (!_state.sidebarVisible) b.classList.add('ws-sidebar-hidden');
  else if (_state.sidebarDock === 'left') l.classList.add('ws-sidebar-left');
  if (!_state.timelineVisible) b.classList.add('ws-timeline-hidden');
  else if (_state.timelineDock === 'top') b.classList.add('ws-timeline-top');

  if (_state.sidebarWidth) l.style.setProperty('--right-w', _state.sidebarWidth + 'px');
  if (_state.timelineHeight) b.style.setProperty('--tl-h', _state.timelineHeight + 'px');

  commit(persist);
}

function loadActive() { try { return JSON.parse(localStorage.getItem(LS_ACTIVE)) || null; } catch (e) { return null; } }
function customMap() { try { return JSON.parse(localStorage.getItem(LS_CUSTOM)) || {}; } catch (e) { return {}; } }
function saveCustomMap(m) { try { localStorage.setItem(LS_CUSTOM, JSON.stringify(m)); } catch (e) { /* 忽略 */ } }
function persistActive() { try { localStorage.setItem(LS_ACTIVE, JSON.stringify(currentWorkspaceState())); } catch (e) { /* 忽略 */ } }

/* —— 渲染（先取 DOM 引用再清空容器，避免 getElementById 失效） —— */

function capturePanes() {
  const map = { timeline: document.querySelector('.timeline') };
  for (const id of PANES) map[id] = document.getElementById('pane-' + id);
  return map;
}

function ensureBottomDock() {
  let b = document.getElementById('ws-bottom');
  if (!b) {
    b = document.createElement('div');
    b.id = 'ws-bottom';
    document.body.appendChild(b);
  }
  return b;
}

function buildGroup(group, dock, index, panes) {
  const wrap = document.createElement('div');
  wrap.className = 'ws-group';
  wrap.dataset.dock = dock;
  wrap.dataset.index = index;
  const sizes = dock === 'side' ? _state.sideSizes : _state.bottomSizes;
  wrap.style.flex = '0 0 ' + (sizes[index] || 0) + '%';

  const hasTabs = group.panes.some((p) => p !== 'timeline');
  if (hasTabs) {
    const tabs = document.createElement('div');
    tabs.className = 'ws-tabs';
    for (const id of group.panes) {
      if (id === 'timeline') continue;
      const tb = document.createElement('button');
      tb.className = 'ws-tab' + (id === group.active ? ' active' : '');
      tb.dataset.pane = id;
      tb.dataset.i18n = 'tab.' + id;
      tabs.appendChild(tb);
    }
    wrap.appendChild(tabs);
  }

  const body = document.createElement('div');
  body.className = 'ws-group-body';
  for (const id of group.panes) {
    const el = panes[id];
    if (!el) continue;
    el.classList.toggle('active', id === group.active);
    body.appendChild(el);
  }
  wrap.appendChild(body);
  return wrap;
}

function buildSplit(dock, index) {
  const s = document.createElement('div');
  s.className = 'ws-split ' + (dock === 'side' ? 'ws-split-h' : 'ws-split-v');
  s.dataset.dock = dock;
  s.dataset.index = index;
  return s;
}

function renderDocks(panes) {
  const sb = sidebarEl();
  [...sb.children].forEach((el) => { if (!el.classList.contains('ws-grip')) el.remove(); });
  _state.sideGroups.forEach((g, i) => {
    sb.appendChild(buildGroup(g, 'side', i, panes));
    if (i < _state.sideGroups.length - 1) sb.appendChild(buildSplit('side', i));
  });

  const bb = ensureBottomDock();
  [...bb.children].forEach((el) => el.remove());
  _state.bottomGroups.forEach((g, i) => {
    bb.appendChild(buildGroup(g, 'bottom', i, panes));
    if (i < _state.bottomGroups.length - 1) bb.appendChild(buildSplit('bottom', i));
  });
}

function createFloatWindow(id, el) {
  const win = document.createElement('div');
  win.className = 'ws-float';
  win.dataset.pane = id;
  win.style.width = FLOAT_SIZES[id].w + 'px';
  win.style.height = FLOAT_SIZES[id].h + 'px';

  const bar = document.createElement('div');
  bar.className = 'ws-float-titlebar';
  const title = document.createElement('span');
  title.className = 'ws-float-title';
  title.dataset.i18n = 'tab.' + id;
  const dockBtn = document.createElement('button');
  dockBtn.className = 'ws-float-dock';
  dockBtn.dataset.i18nTitle = 'ws.dockBack';
  dockBtn.title = t('ws.dockBack');
  dockBtn.textContent = t('ws.dockBack');
  dockBtn.addEventListener('click', () => { dockFloat(id); });
  bar.append(title, dockBtn);

  const body = document.createElement('div');
  body.className = 'ws-float-body';
  body.appendChild(el);
  win.append(bar, body);
  document.body.appendChild(win);
  el.classList.add('active');
}

function syncFloatsWindows(panes) {
  for (const id of PANES) {
    const inFloat = !!_state.floats[id];
    let win = floatWindow(id);
    if (inFloat) {
      if (!win) createFloatWindow(id, panes[id]);
      win = floatWindow(id);
      win.style.left = _state.floats[id].x + 'px';
      win.style.top = _state.floats[id].y + 'px';
    } else if (win) {
      win.remove();
    }
  }
}

function commit(persist = true) {
  const panes = capturePanes();
  renderDocks(panes);
  syncFloatsWindows(panes);
  applyI18nDom();
  if (persist) persistActive();
  // 布局变化后按新尺寸重排 3D 视口/标尺并重绘 lane 画布，避免旧尺寸画布露出空白。
  window.dispatchEvent(new Event('resize'));
  import('./timeline-layers.js').then((m) => m.drawTimelineLayers()).catch(() => {});
}

/* —— 面板归属变更 —— */

function removePaneFromCurrent(id) {
  const win = floatWindow(id);
  if (win) { win.remove(); delete _state.floats[id]; }
  for (const dock of ['side', 'bottom']) {
    const list = dock === 'side' ? _state.sideGroups : _state.bottomGroups;
    const sizes = dock === 'side' ? _state.sideSizes : _state.bottomSizes;
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      const k = g.panes.indexOf(id);
      if (k >= 0) {
        g.panes.splice(k, 1);
        if (g.active === id) g.active = g.panes[0] || null;
        if (!g.panes.length) { list.splice(i, 1); sizes.splice(i, 1); }
        return;
      }
    }
  }
}

function mergeInto(id, targetGroup) {
  removePaneFromCurrent(id);
  if (!targetGroup.panes.includes(id)) targetGroup.panes.push(id);
  targetGroup.active = id;
}

function splitInto(dock, id, position) {
  removePaneFromCurrent(id);
  const list = dock === 'side' ? _state.sideGroups : _state.bottomGroups;
  const sizes = dock === 'side' ? _state.sideSizes : _state.bottomSizes;
  const ng = { panes: [id], active: id };
  if (position === 'start') {
    list.unshift(ng);
    sizes.unshift(50);
    for (let i = 1; i < sizes.length; i++) sizes[i] = Math.round(sizes[i] * 0.5);
  } else {
    list.push(ng);
    sizes.push(50);
    for (let i = 0; i < sizes.length - 1; i++) sizes[i] = Math.round(sizes[i] * 0.5);
  }
  const sum = sizes.reduce((a, b) => a + b, 0);
  if (sum !== 100) sizes[sizes.length - 1] += 100 - sum;
}

function floatPane(id, x, y) {
  if (isNarrowLayout()) return;
  removePaneFromCurrent(id);
  _state.floats[id] = { x, y };
}

function dockFloat(id) {
  delete _state.floats[id];
  splitInto('side', id, 'end');
  commit(true);
}

/* —— 吸附区 —— */

function buildZones() {
  const keys = ['side-top', 'side-bottom', 'bottom-left', 'bottom-right', 'float', 'merge', 'edge-left', 'edge-right', 'edge-top', 'edge-bottom'];
  for (const key of keys) {
    const el = document.createElement('div');
    el.className = 'ws-drop-zone';
    el.dataset.wsZone = key;
    el.style.cssText = 'position:fixed;z-index:500;pointer-events:none;';
    document.body.appendChild(el);
    zones[key] = el;
  }
}
function placeZone(key, r) {
  const z = zones[key];
  if (!z) return;
  z.style.left = r.left + 'px'; z.style.top = r.top + 'px';
  z.style.width = r.width + 'px'; z.style.height = r.height + 'px';
}
function showZones(keys) { Object.keys(zones).forEach((k) => zones[k].classList.toggle('visible', keys.includes(k))); }
function clearZones() { Object.keys(zones).forEach((k) => zones[k].classList.remove('visible', 'active')); }
function inRect(x, y, r) { return x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height; }
function rectOf(el) { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; }
function halfRect(r, part) {
  if (part === 'top') return { left: r.left, top: r.top, width: r.width, height: r.height / 2 };
  if (part === 'bottom') return { left: r.left, top: r.top + r.height / 2, width: r.width, height: r.height / 2 };
  if (part === 'left') return { left: r.left, top: r.top, width: r.width / 2, height: r.height };
  return { left: r.left + r.width / 2, top: r.top, width: r.width / 2, height: r.height };
}
function sidebarRect() { return rectOf(sidebarEl()); }
function bottomRect() { return rectOf(bottomEl()); }

/* —— 选项卡拖拽（分离 / 分窗 / 合并） —— */

function setupTabDrag() {
  document.addEventListener('pointerdown', (ev) => {
    const tb = ev.target.closest('.ws-tab');
    if (!tb || isNarrowLayout() || ev.button !== 0) return;
    const paneId = tb.dataset.pane;
    const sz = FLOAT_SIZES[paneId] || { w: 340, h: 420 };
    let started = false;
    const startX = ev.clientX, startY = ev.clientY;

    const move = (ev2) => {
      if (!started && Math.hypot(ev2.clientX - startX, ev2.clientY - startY) < 6) return;
      started = true;
      document.body.classList.add('ws-dragging');
      renderPreview(paneId, ev2, sz, resolveDrop(paneId, ev2));
    };
    const up = (ev2) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('ws-dragging');
      clearZones();
      if (!started) return;
      suppressTabClick = true;
      const target = resolveDrop(paneId, ev2);
      if (target) { target.action(); commit(true); }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

function findTargetGroup(ev) {
  for (const el of document.querySelectorAll('.ws-group .ws-tabs')) {
    if (inRect(ev.clientX, ev.clientY, rectOf(el))) {
      const gEl = el.closest('.ws-group');
      const list = gEl.dataset.dock === 'side' ? _state.sideGroups : _state.bottomGroups;
      return list[+gEl.dataset.index];
    }
  }
  return null;
}

function resolveDrop(paneId, ev) {
  const group = findTargetGroup(ev);
  if (group && group.panes.includes(paneId)) return null;
  if (group && group.panes.some((p) => p !== 'timeline')) {
    return { kind: 'merge', action: () => mergeInto(paneId, group) };
  }
  const sb = sidebarRect();
  if (inRect(ev.clientX, ev.clientY, sb)) {
    const pos = ev.clientY < sb.top + sb.height / 2 ? 'start' : 'end';
    return { kind: pos === 'start' ? 'side-top' : 'side-bottom', action: () => splitInto('side', paneId, pos) };
  }
  const bb = bottomRect();
  if (inRect(ev.clientX, ev.clientY, bb)) {
    const pos = ev.clientX < bb.left + bb.width / 2 ? 'start' : 'end';
    return { kind: pos === 'start' ? 'bottom-left' : 'bottom-right', action: () => splitInto('bottom', paneId, pos) };
  }
  if (ev.clientY > 50 && ev.clientY < window.innerHeight - 40) {
    return { kind: 'float', action: () => floatPane(paneId, Math.round(ev.clientX - sz0(paneId).w / 2), Math.round(ev.clientY - sz0(paneId).h / 2)) };
  }
  return null;
}
function sz0(id) { return FLOAT_SIZES[id] || { w: 340, h: 420 }; }

function renderPreview(paneId, ev, sz, target) {
  if (!target) { showZones([]); return; }
  const sb = sidebarRect(), bb = bottomRect();
  if (target.kind === 'merge') {
    for (const el of document.querySelectorAll('.ws-group .ws-tabs')) {
      if (inRect(ev.clientX, ev.clientY, rectOf(el))) { placeZone('merge', rectOf(el)); showZones(['merge']); zones.merge.classList.add('active'); return; }
    }
  } else if (target.kind === 'side-top' || target.kind === 'side-bottom') {
    placeZone('side-top', halfRect(sb, 'top'));
    placeZone('side-bottom', halfRect(sb, 'bottom'));
    showZones(['side-top', 'side-bottom']);
    zones[target.kind].classList.add('active');
  } else if (target.kind === 'bottom-left' || target.kind === 'bottom-right') {
    placeZone('bottom-left', halfRect(bb, 'left'));
    placeZone('bottom-right', halfRect(bb, 'right'));
    showZones(['bottom-left', 'bottom-right']);
    zones[target.kind].classList.add('active');
  } else if (target.kind === 'float') {
    const r = { left: Math.max(4, ev.clientX - sz.w / 2), top: Math.max(44, ev.clientY - sz.h / 2), width: sz.w, height: sz.h };
    placeZone('float', r);
    showZones(['float']);
    zones.float.classList.add('active');
  }
}

/* —— 浮动窗口拖动（合并 / 分窗 / 移动） —— */

function setupFloatDrag() {
  document.addEventListener('pointerdown', (ev) => {
    const bar = ev.target.closest('.ws-float-titlebar');
    if (!bar || ev.target.closest('.ws-float-dock') || ev.button !== 0) return;
    const win = bar.closest('.ws-float');
    const id = win.dataset.pane;
    let moved = false;
    const startX = ev.clientX, startY = ev.clientY;
    const origL = parseInt(win.style.left, 10) || 60;
    const origT = parseInt(win.style.top, 10) || 80;

    const move = (ev2) => {
      if (!moved && Math.hypot(ev2.clientX - startX, ev2.clientY - startY) < 6) return;
      moved = true;
      document.body.classList.add('ws-dragging');
      win.style.left = (origL + ev2.clientX - startX) + 'px';
      win.style.top = (origT + ev2.clientY - startY) + 'px';
      const target = resolveFloatDrop(id, ev2);
      if (target) {
        if (target.kind === 'merge') {
          for (const el of document.querySelectorAll('.ws-group .ws-tabs')) {
            if (inRect(ev2.clientX, ev2.clientY, rectOf(el))) { placeZone('merge', rectOf(el)); break; }
          }
          showZones(['merge']); zones.merge.classList.add('active');
        } else if (target.kind.startsWith('side-')) {
          placeZone('side-top', halfRect(sidebarRect(), 'top'));
          placeZone('side-bottom', halfRect(sidebarRect(), 'bottom'));
          showZones(['side-top', 'side-bottom']);
          zones[target.kind].classList.add('active');
        } else if (target.kind.startsWith('bottom-')) {
          placeZone('bottom-left', halfRect(bottomRect(), 'left'));
          placeZone('bottom-right', halfRect(bottomRect(), 'right'));
          showZones(['bottom-left', 'bottom-right']);
          zones[target.kind].classList.add('active');
        }
      } else {
        showZones([]);
      }
    };
    const up = (ev2) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('ws-dragging');
      clearZones();
      const target = resolveFloatDrop(id, ev2);
      if (target) {
        delete _state.floats[id];
        target.action();
      } else if (moved) {
        _state.floats[id] = { x: parseInt(win.style.left, 10) || 60, y: parseInt(win.style.top, 10) || 80 };
      }
      commit(true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

function resolveFloatDrop(id, ev) {
  const group = findTargetGroup(ev);
  if (group && group.panes.some((p) => p !== 'timeline')) {
    return { kind: 'merge', action: () => mergeInto(id, group) };
  }
  const sb = sidebarRect();
  if (inRect(ev.clientX, ev.clientY, sb)) {
    const pos = ev.clientY < sb.top + sb.height / 2 ? 'start' : 'end';
    return { kind: pos === 'start' ? 'side-top' : 'side-bottom', action: () => splitInto('side', id, pos) };
  }
  const bb = bottomRect();
  if (inRect(ev.clientX, ev.clientY, bb)) {
    const pos = ev.clientX < bb.left + bb.width / 2 ? 'start' : 'end';
    return { kind: pos === 'start' ? 'bottom-left' : 'bottom-right', action: () => splitInto('bottom', id, pos) };
  }
  return null;
}

/* —— 分隔条拖拽 —— */

function setupSplitDrag() {
  document.addEventListener('pointerdown', (ev) => {
    const sp = ev.target.closest('.ws-split');
    if (!sp || ev.button !== 0) return;
    const dock = sp.dataset.dock;
    const index = +sp.dataset.index;
    const sizes = dock === 'side' ? _state.sideSizes : _state.bottomSizes;
    const container = dock === 'side' ? sidebarEl() : bottomEl();
    const groups = [...container.querySelectorAll('.ws-group')];
    const a = groups[index], b = groups[index + 1];
    if (!a || !b) return;
    const total = dock === 'side' ? container.getBoundingClientRect().height : container.getBoundingClientRect().width;
    const start = dock === 'side' ? ev.clientY : ev.clientX;
    const startA = sizes[index], startB = sizes[index + 1];

    const move = (ev2) => {
      const delta = ((dock === 'side' ? ev2.clientY : ev2.clientX) - start) / total * 100;
      const na = Math.max(8, Math.min(startA + startB - 8, startA + delta));
      const nb = startA + startB - na;
      sizes[index] = Math.round(na);
      sizes[index + 1] = Math.round(nb);
      a.style.flexBasis = sizes[index] + '%';
      b.style.flexBasis = sizes[index + 1] + '%';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      persistActive();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

/* —— 侧栏 / 时间轴把手：整体停靠到边 —— */

function sidebarWidthPx() { return parseInt(layoutEl().style.getPropertyValue('--right-w'), 10) || 320; }
function timelineHeightPx() { return parseInt(document.body.style.getPropertyValue('--tl-h'), 10) || 360; }

function setupEdgeDrag(panel) {
  const grip = document.getElementById(panel === 'sidebar' ? 'ws-grip-sidebar' : 'ws-grip-timeline');
  if (!grip) return;
  let dragging = false;
  let activeKey = null;

  grip.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || isNarrowLayout()) return;
    dragging = true; activeKey = null;
    grip.setPointerCapture(ev.pointerId);
    document.body.classList.add('ws-dragging');
    if (panel === 'sidebar') {
      const sw = sidebarWidthPx();
      placeZone('edge-left', { left: 0, top: 0, width: sw, height: window.innerHeight });
      placeZone('edge-right', { left: window.innerWidth - sw, top: 0, width: sw, height: window.innerHeight });
      showZones(['edge-left', 'edge-right']);
    } else {
      const th = timelineHeightPx();
      placeZone('edge-top', { left: 0, top: 0, width: window.innerWidth, height: th });
      placeZone('edge-bottom', { left: 0, top: window.innerHeight - th, width: window.innerWidth, height: th });
      showZones(['edge-top', 'edge-bottom']);
    }
    update(ev);
  });
  grip.addEventListener('pointermove', (ev) => { if (dragging) update(ev); });
  const end = () => {
    if (!dragging) return;
    if (activeKey) {
      const s = currentWorkspaceState();
      if (panel === 'sidebar') s.sidebarDock = (activeKey === 'edge-left') ? 'left' : 'right';
      else s.timelineDock = (activeKey === 'edge-top') ? 'top' : 'bottom';
      applyWorkspaceState(s, true);
    }
    dragging = false; activeKey = null;
    document.body.classList.remove('ws-dragging');
    clearZones();
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);

  function update(ev) {
    let key = null;
    if (panel === 'sidebar') {
      key = ev.clientX < window.innerWidth / 2 ? 'edge-left' : 'edge-right';
    } else {
      key = ev.clientY < window.innerHeight / 2 ? 'edge-top' : 'edge-bottom';
    }
    activeKey = key;
    ['edge-left', 'edge-right', 'edge-top', 'edge-bottom'].forEach((k) => zones[k].classList.toggle('active', k === key));
  }
}

/* —— 选项卡点击切换（分组内） —— */

function setupTabClick() {
  document.addEventListener('click', (ev) => {
    const tb = ev.target.closest('.ws-tab');
    if (!tb || suppressTabClick) return;
    const gEl = tb.closest('.ws-group');
    const list = gEl.dataset.dock === 'side' ? _state.sideGroups : _state.bottomGroups;
    const g = list[+gEl.dataset.index];
    g.active = tb.dataset.pane;
    gEl.querySelectorAll('.ws-tab').forEach((b) => b.classList.toggle('active', b === tb));
    gEl.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + tb.dataset.pane));
    if (tb.dataset.pane === 'texture') {
      import('./texture-editor.js').then((m) => m.refreshTexturePanel()).catch(() => {});
    }
  });
  document.addEventListener('click', (ev) => {
    if (suppressTabClick) { suppressTabClick = false; ev.stopPropagation(); ev.preventDefault(); }
  }, true);
}

/* —— 菜单与自定义工作区 —— */

function injectMenu() {
  const menubar = document.querySelector('.menubar');
  const about = document.getElementById('btn-about').closest('.menu');
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.innerHTML = `
    <button class="menu-btn" data-menu="window" data-i18n="menu.window">窗口</button>
    <div class="dropdown" id="menu-window">
      <div class="dd-text" data-i18n="ws.presets">工作区预设</div>
      <button class="dd-item ws-preset" data-ws-preset="default"><span data-i18n="ws.preset.default">默认</span></button>
      <button class="dd-item ws-preset" data-ws-preset="left"><span data-i18n="ws.preset.left">面板居左</span></button>
      <button class="dd-item ws-preset" data-ws-preset="draw"><span data-i18n="ws.preset.draw">专注绘制</span></button>
      <button class="dd-item ws-preset" data-ws-preset="animate"><span data-i18n="ws.preset.animate">动画编辑</span></button>
      <button class="dd-item ws-preset" data-ws-preset="timelineTop"><span data-i18n="ws.preset.timelineTop">时间轴上置</span></button>
      <div class="dd-sep"></div>
      <button class="dd-item" id="ws-auto"><span data-i18n="ws.autoLayout">自动布局</span></button>
      <button class="dd-item" id="ws-toggle-sidebar"><span data-i18n="ws.toggleSidebar">显示/隐藏侧栏</span></button>
      <button class="dd-item" id="ws-toggle-timeline"><span data-i18n="ws.toggleTimeline">显示/隐藏时间轴</span></button>
      <div class="dd-sep"></div>
      <div class="dd-text" data-i18n="ws.custom">自定义工作区</div>
      <div id="ws-custom-list"></div>
      <button class="dd-item" id="ws-save"><span data-i18n="ws.save">保存工作区…</span></button>
      <button class="dd-item" id="ws-manage"><span data-i18n="ws.manage">管理工作区…</span></button>
      <div class="dd-sep"></div>
      <button class="dd-item" id="ws-reset"><span data-i18n="ws.reset">重置工作区</span></button>
    </div>`;
  menubar.insertBefore(menu, about);
}

function injectGrips() {
  const sb = sidebarEl();
  const grip = document.createElement('div');
  grip.className = 'ws-grip ws-grip-sidebar';
  grip.id = 'ws-grip-sidebar';
  grip.dataset.wsPanel = 'sidebar';
  grip.dataset.i18nTitle = 'ws.gripSidebar';
  sb.insertBefore(grip, sb.firstChild);

  const controls = document.querySelector('.tl-controls');
  const tg = document.createElement('div');
  tg.className = 'ws-grip ws-grip-timeline';
  tg.id = 'ws-grip-timeline';
  tg.dataset.wsPanel = 'timeline';
  tg.dataset.i18nTitle = 'ws.gripTimeline';
  controls.insertBefore(tg, controls.firstChild);
}

function closeMenuWindow() {
  const dd = document.getElementById('menu-window');
  if (dd) dd.closest('.menu').classList.remove('open');
}

function renderCustomList() {
  const box = document.getElementById('ws-custom-list');
  if (!box) return;
  box.innerHTML = '';
  const m = customMap();
  const names = Object.keys(m);
  if (!names.length) {
    const p = document.createElement('div');
    p.className = 'dd-text';
    p.textContent = t('ws.noCustom');
    box.appendChild(p);
    return;
  }
  for (const name of names) {
    const b = document.createElement('button');
    b.className = 'dd-item ws-custom';
    b.dataset.wsName = name;
    const span = document.createElement('span');
    span.textContent = name;
    b.appendChild(span);
    box.appendChild(b);
  }
}

async function saveCustomFlow() {
  const name = await modalPrompt(t('ws.saveTitle'), t('ws.defaultName'), t('ws.saveMsg'));
  if (!name || !name.trim()) return;
  const n = name.trim();
  const m = customMap();
  if (m[n]) {
    const ok = await modalConfirm(t('ws.saveTitle'), t('ws.overwriteMsg'));
    if (!ok) return;
  }
  m[n] = currentWorkspaceState();
  saveCustomMap(m);
  renderCustomList();
}

function onManageDocPointerDown(ev) {
  if (!ev.target.closest('.ws-manage-pop')) closeManage();
}

function closeManage() {
  document.removeEventListener('pointerdown', onManageDocPointerDown);
  document.querySelectorAll('.ws-manage-pop').forEach((p) => p.remove());
}

function openManage() {
  closeManage();
  const pop = document.createElement('div');
  pop.className = 'ws-manage-pop';
  const head = document.createElement('div');
  head.className = 'ws-manage-title';
  const title = document.createElement('span');
  title.textContent = t('ws.manage');
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ws-manage-close';
  closeBtn.textContent = '✕';
  closeBtn.dataset.i18nTitle = 'common.close';
  closeBtn.title = t('common.close');
  closeBtn.addEventListener('click', closeManage);
  head.append(title, closeBtn);
  pop.appendChild(head);

  const list = document.createElement('div');
  list.className = 'ws-manage-list';
  const m = customMap();
  const names = Object.keys(m);
  if (!names.length) {
    const p = document.createElement('div');
    p.className = 'ws-manage-empty';
    p.textContent = t('ws.noCustom');
    list.appendChild(p);
  }
  for (const name of names) {
    const row = document.createElement('div');
    row.className = 'ws-manage-row';
    const nameBtn = document.createElement('button');
    nameBtn.className = 'ws-manage-name';
    nameBtn.textContent = name;
    nameBtn.addEventListener('click', () => { applyWorkspaceState(m[name], true); closeManage(); });
    const ren = document.createElement('button');
    ren.className = 'mini';
    ren.textContent = t('common.rename');
    ren.addEventListener('click', async () => {
      const nn = await modalPrompt(t('ws.renameTitle'), name, t('ws.renameMsg'));
      if (!nn || !nn.trim() || nn.trim() === name) return;
      const m2 = customMap();
      m2[nn.trim()] = m2[name];
      delete m2[name];
      saveCustomMap(m2);
      renderCustomList();
      openManage();
    });
    const del = document.createElement('button');
    del.className = 'mini';
    del.textContent = t('common.delete');
    del.addEventListener('click', async () => {
      const ok = await modalConfirm(t('ws.deleteTitle'), t('ws.deleteMsg'));
      if (!ok) return;
      const m2 = customMap();
      delete m2[name];
      saveCustomMap(m2);
      renderCustomList();
      openManage();
    });
    row.append(nameBtn, ren, del);
    list.appendChild(row);
  }
  pop.appendChild(list);
  document.body.appendChild(pop);
  document.addEventListener('pointerdown', onManageDocPointerDown);
}

function autoLayout() {
  const g = defaultGroups();
  applyWorkspaceState({
    sidebarDock: 'right', sidebarVisible: true, sidebarWidth: 320,
    timelineDock: 'bottom', timelineVisible: true, timelineHeight: 360,
    sideGroups: g.sideGroups, sideSizes: g.sideSizes,
    bottomGroups: g.bottomGroups, bottomSizes: g.bottomSizes,
    floats: {},
  }, true);
}

function bindMenu() {
  document.getElementById('menu-window').addEventListener('click', (ev) => {
    const preset = ev.target.closest('.ws-preset');
    if (preset) {
      const p = PRESETS[preset.dataset.wsPreset];
      if (p) {
        closeMenuWindow();
        const g = defaultGroups();
        applyWorkspaceState(Object.assign({}, p, g, { floats: {} }), true);
      }
      return;
    }
    const custom = ev.target.closest('.ws-custom');
    if (custom) {
      const m = customMap();
      const name = custom.dataset.wsName;
      if (m[name]) { closeMenuWindow(); applyWorkspaceState(m[name], true); }
      return;
    }
    const btn = ev.target.closest('button');
    if (!btn) return;
    const id = btn.id;
    if (id === 'ws-auto') { closeMenuWindow(); autoLayout(); }
    else if (id === 'ws-toggle-sidebar') {
      const s = currentWorkspaceState();
      s.sidebarVisible = !s.sidebarVisible;
      applyWorkspaceState(s, true);
    } else if (id === 'ws-toggle-timeline') {
      const s = currentWorkspaceState();
      s.timelineVisible = !s.timelineVisible;
      applyWorkspaceState(s, true);
    } else if (id === 'ws-save') { closeMenuWindow(); saveCustomFlow(); }
    else if (id === 'ws-manage') { closeMenuWindow(); openManage(); }
    else if (id === 'ws-reset') { closeMenuWindow(); autoLayout(); }
  });
}

export function initWorkspace() {
  if (initialized) return;
  initialized = true;

  injectMenu();
  injectGrips();
  buildZones();
  bindMenu();
  setupEdgeDrag('sidebar');
  setupEdgeDrag('timeline');
  setupTabDrag();
  setupFloatDrag();
  setupSplitDrag();
  setupTabClick();

  const saved = loadActive();
  applyWorkspaceState(saved && typeof saved === 'object' ? saved : Object.assign({}, PRESETS.default, defaultGroups(), { floats: {} }), false);
  renderCustomList();
  applyI18nDom();
}