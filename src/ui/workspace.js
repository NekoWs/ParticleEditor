// 工作区系统 v4：
// - 左右竖向图标栏（各分上/下半区），图标点击展开/收起面板；
// - 侧边区域（左/右）为「手风琴 + 单槽位」：同侧同一时刻显示一个槽位，槽位内最多上下叠 2 个面板；
// - 底部坞可上下/左右排列面板（默认：控制面板在上、时间轴面板在下）；
// - 图标/面板头/时间轴控制条背景可拖动：同栏重排、跨半区/跨栏移动、停靠侧边/底部、拖出浮动；
// - 面板头背景拖动等价于拖动其图标；
// - 自定义工作区保存/管理/自动布局/重置保留，自动记住上一次布局；预设已移除。

import { t, applyI18nDom } from '../core/i18n.js';
import { modalPrompt, modalConfirm } from './ui.js';

const LS_ACTIVE = 'pdraw-workspace-active';
const LS_CUSTOM = 'pdraw-workspace-custom';

const PANELS = ['props', 'fx', 'texEditor', 'uv', 'tlControls', 'timeline'];
const PANE_EL_ID = {
  props: 'pane-props', fx: 'pane-fx', texEditor: 'pane-tex-editor', uv: 'pane-uv',
  tlControls: 'pane-tl-controls', timeline: 'pane-timeline',
};
const FLOAT_SIZES = {
  props: { w: 340, h: 480 }, fx: { w: 340, h: 480 }, texEditor: { w: 560, h: 460 },
  uv: { w: 380, h: 460 }, tlControls: { w: 480, h: 130 }, timeline: { w: 780, h: 380 },
};

const ICONS = {
  props: '<svg viewBox="0 0 18 18"><path d="M5 2.5h6l2.5 2.5V15a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M11 2.5V5h2.5M7 8.5h4M7 11h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  fx: '<svg viewBox="0 0 18 18"><path d="M4 14c1.5-4 2.5-6 4-6s2.5 4 4 4 2.5-4 4-6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><text x="9" y="5" font-size="5.5" fill="currentColor" text-anchor="middle" font-family="monospace">f(x)</text></svg>',
  texEditor: '<svg viewBox="0 0 18 18"><rect x="3" y="3" width="12" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 7h12M7 3v12M11 3v12M3 11h12" stroke="currentColor" stroke-width="1"/></svg>',
  uv: '<svg viewBox="0 0 18 18"><rect x="3" y="3" width="12" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 9h12M9 3v12" stroke="currentColor" stroke-width="1.2"/><circle cx="9" cy="9" r="1.4" fill="currentColor"/></svg>',
  tlControls: '<svg viewBox="0 0 18 18"><path d="M4.5 5.5v7l7-3.5-7-3.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M2.5 3.5h13M2.5 14.5h13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  timeline: '<svg viewBox="0 0 18 18"><rect x="2" y="4" width="14" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5 4v10M9 4v10M13 4v10" stroke="currentColor" stroke-width="1"/><circle cx="7" cy="9" r="1.5" fill="currentColor"/></svg>',
};

function defaultState() {
  return {
    strips: {
      left: { top: [], bottom: ['tlControls', 'timeline'] },
      right: { top: ['props', 'fx', 'texEditor', 'uv'], bottom: [] },
    },
    dock: {
      props: 'right', fx: 'right', texEditor: 'right', uv: 'right',
      tlControls: 'bottom', timeline: 'bottom',
    },
    open: { left: [], right: ['props'], bottom: ['tlControls', 'timeline'] },
    bottomDir: 'vert',
    sizes: { left: [100], right: [100], bottom: [50, 50] },
    areaLeftW: null, areaRightW: null, bottomH: null,
    sidebarVisible: true, timelineVisible: true,
    floats: {},
  };
}

let _state = defaultState();
let initialized = false;
let suppressClick = false;
const zones = {};

const el = (id) => document.getElementById(id);
const layoutEl = () => document.querySelector('.layout');

/* —— 工具 —— */

function rectOf(node) { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; }
function inRect(x, y, r) { return x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height; }
function numOr(v, fallback) { return (typeof v === 'number' && isFinite(v)) ? v : fallback; }

function stripOf(id, st) {
  const s = st || _state;
  for (const strip of ['left', 'right']) for (const half of ['top', 'bottom']) {
    if (s.strips[strip][half].includes(id)) return strip;
  }
  return 'right';
}

function defaultDockFor(id, st) {
  if (id === 'tlControls' || id === 'timeline') return 'bottom';
  return stripOf(id, st);
}

function normalizeSizes(arr, n) {
  const a = Array.isArray(arr) ? arr.map((x) => +x || 0) : [];
  while (a.length < n) a.push(0);
  const used = a.slice(0, n);
  const sum = used.reduce((x, y) => x + y, 0);
  if (sum > 0) return used.map((x) => Math.round((x / sum) * 100));
  return used.map((_, i) => Math.round(100 / n));
}

function normalize(s) {
  const out = defaultState();
  if (!s || typeof s !== 'object') return out;

  // 图标布局：每个面板恰好在四个半区之一出现一次。
  const seen = new Set();
  for (const strip of ['left', 'right']) {
    for (const half of ['top', 'bottom']) {
      const arr = (s.strips && s.strips[strip] && Array.isArray(s.strips[strip][half])) ? s.strips[strip][half] : [];
      out.strips[strip][half] = [];
      for (const id of arr) {
        if (PANELS.includes(id) && !seen.has(id)) { out.strips[strip][half].push(id); seen.add(id); }
      }
    }
  }
  for (const id of PANELS) if (!seen.has(id)) out.strips.right.top.push(id);

  // 停靠归属
  for (const id of PANELS) {
    const d = s.dock && s.dock[id];
    out.dock[id] = (d === 'left' || d === 'right' || d === 'bottom' || d === 'float') ? d : defaultDockFor(id, out);
  }

  // 展开状态
  const san = (arr) => (Array.isArray(arr) ? arr.filter((id) => PANELS.includes(id)) : []);
  out.open.left = san(s.open && s.open.left).filter((id) => out.dock[id] === 'left');
  out.open.right = san(s.open && s.open.right).filter((id) => out.dock[id] === 'right');
  out.open.bottom = san(s.open && s.open.bottom).filter((id) => out.dock[id] === 'bottom').slice(0, 2);

  out.bottomDir = s.bottomDir === 'horiz' ? 'horiz' : 'vert';
  out.sizes.left = normalizeSizes(s.sizes && s.sizes.left, out.open.left.length || 1);
  out.sizes.right = normalizeSizes(s.sizes && s.sizes.right, out.open.right.length || 1);
  out.sizes.bottom = normalizeSizes(s.sizes && s.sizes.bottom, out.open.bottom.length || 1);

  out.areaLeftW = numOr(s.areaLeftW, null);
  out.areaRightW = numOr(s.areaRightW, null);
  out.bottomH = numOr(s.bottomH, null);
  out.sidebarVisible = s.sidebarVisible !== false;
  out.timelineVisible = s.timelineVisible !== false;

  out.floats = {};
  if (s.floats && typeof s.floats === 'object') {
    for (const id of PANELS) {
      if (s.floats[id]) {
        const f = s.floats[id];
        out.floats[id] = {
          x: Math.round(f.x || 60), y: Math.round(f.y || 80),
          w: Math.round(f.w || FLOAT_SIZES[id].w), h: Math.round(f.h || FLOAT_SIZES[id].h),
        };
        out.dock[id] = 'float';
      }
    }
  }
  for (const id of PANELS) {
    if (out.dock[id] === 'float' && !out.floats[id]) out.dock[id] = defaultDockFor(id, out);
  }
  return out;
}

function currentState() {
  return {
    strips: JSON.parse(JSON.stringify(_state.strips)),
    dock: Object.assign({}, _state.dock),
    open: { left: _state.open.left.slice(), right: _state.open.right.slice(), bottom: _state.open.bottom.slice() },
    bottomDir: _state.bottomDir,
    sizes: { left: _state.sizes.left.slice(), right: _state.sizes.right.slice(), bottom: _state.sizes.bottom.slice() },
    areaLeftW: _state.areaLeftW, areaRightW: _state.areaRightW, bottomH: _state.bottomH,
    sidebarVisible: _state.sidebarVisible, timelineVisible: _state.timelineVisible,
    floats: JSON.parse(JSON.stringify(_state.floats)),
  };
}

function persistActive() { try { localStorage.setItem(LS_ACTIVE, JSON.stringify(currentState())); } catch (e) { /* 忽略 */ } }
function customMap() { try { return JSON.parse(localStorage.getItem(LS_CUSTOM)) || {}; } catch (e) { return {}; } }
function saveCustomMap(m) { try { localStorage.setItem(LS_CUSTOM, JSON.stringify(m)); } catch (e) { /* 忽略 */ } }

/* —— 渲染 —— */

function capturePanes() {
  const map = {};
  for (const id of PANELS) map[id] = el(PANE_EL_ID[id]);
  return map;
}

function isOpen(id) {
  const d = _state.dock[id];
  if (d === 'left') return _state.open.left.includes(id);
  if (d === 'right') return _state.open.right.includes(id);
  if (d === 'bottom') return _state.open.bottom.includes(id);
  if (d === 'float') return !!_state.floats[id];
  return false;
}

function buildPaneWrap(id, pane) {
  const wrap = document.createElement('div');
  wrap.className = 'ws-pane-wrap';
  wrap.dataset.panel = id;
  if (id !== 'tlControls') {
    const head = document.createElement('div');
    head.className = 'ws-tabs ws-pane-head';
    head.dataset.panel = id;
    const title = document.createElement('span');
    title.className = 'ws-tab ws-tab-title';
    title.dataset.i18n = 'tab.' + id;
    title.textContent = t('tab.' + id);
    head.appendChild(title);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ws-pane-close';
    close.textContent = '✕';
    close.dataset.i18nTitle = 'common.close';
    close.title = t('common.close');
    close.addEventListener('click', () => collapsePanel(id));
    head.appendChild(close);
    wrap.appendChild(head);
  }
  wrap.appendChild(pane);
  return wrap;
}

function buildSplit(dock, dir, index) {
  const sp = document.createElement('div');
  sp.className = 'ws-split ' + (dir === 'h' ? 'ws-split-h' : 'ws-split-v');
  sp.dataset.dock = dock;
  sp.dataset.index = index;
  return sp;
}

function renderStrips() {
  for (const strip of ['left', 'right']) {
    for (const half of ['top', 'bottom']) {
      const box = el('strip-' + strip + '-' + half);
      if (!box) continue;
      box.innerHTML = '';
      for (const id of _state.strips[strip][half]) {
        const btn = document.createElement('button');
        btn.className = 'ws-icon';
        btn.type = 'button';
        btn.dataset.panel = id;
        btn.innerHTML = ICONS[id];
        btn.dataset.i18nTitle = 'tab.' + id;
        btn.title = t('tab.' + id);
        btn.classList.toggle('active', isOpen(id));
        btn.addEventListener('click', () => {
          if (suppressClick) return;
          togglePanel(id);
        });
        box.appendChild(btn);
      }
    }
  }
}

function renderDocks(panes) {
  const holder = el('panes');
  for (const id of PANELS) {
    const p = panes[id];
    if (!p) continue;
    p.classList.remove('active');
    if (p.parentElement !== holder) holder.appendChild(p);
  }
  renderArea('left', panes);
  renderArea('right', panes);
  renderBottom(panes);
  syncFloats(panes);
}

function renderArea(side, panes) {
  const area = el('area-' + side);
  if (!area) return;
  [...area.children].forEach((c) => { if (!c.classList.contains('resize-handle-l') && !c.classList.contains('resize-handle-r')) c.remove(); });
  const ids = _state.open[side].filter((id) => panes[id] && _state.dock[id] === side);
  _state.open[side] = ids;
  ids.forEach((id, i) => {
    const wrap = buildPaneWrap(id, panes[id]);
    wrap.style.flex = '0 0 ' + (_state.sizes[side][i] != null ? _state.sizes[side][i] : 100) + '%';
    const pane = panes[id];
    if (pane) pane.classList.add('active');
    area.appendChild(wrap);
    if (i < ids.length - 1) area.appendChild(buildSplit(side, 'h', i));
  });
}

function renderBottom(panes) {
  const dock = el('dock-bottom');
  if (!dock) return;
  [...dock.children].forEach((c) => { if (c.id !== 'tl-module-resize') c.remove(); });
  const ids = _state.open.bottom.filter((id) => panes[id] && _state.dock[id] === 'bottom');
  _state.open.bottom = ids;
  const dir = _state.bottomDir;
  dock.dataset.dir = dir;
  const hasControls = ids.includes('tlControls');

  ids.forEach((id, i) => {
    const wrap = buildPaneWrap(id, panes[id]);
    if (dir === 'vert') {
      if (id === 'tlControls') wrap.style.flex = '0 0 auto';
      else if (hasControls && ids.length === 2) wrap.style.flex = '1 1 auto';
      else wrap.style.flex = '1 1 0';
    } else {
      wrap.style.flex = '1 1 0';
    }
    const pane = panes[id];
    if (pane) pane.classList.add('active');
    dock.appendChild(wrap);
    // 分隔条：仅在同为可伸缩面板之间插入（控制面板为自然高度时不参与）。
    const next = ids[i + 1];
    if (next && !(dir === 'vert' && (id === 'tlControls' || next === 'tlControls'))) {
      dock.appendChild(buildSplit('bottom', dir === 'vert' ? 'h' : 'v', i));
    }
  });
}

function createFloat(id, pane) {
  const win = document.createElement('div');
  win.className = 'ws-float';
  win.dataset.pane = id;
  const sz = FLOAT_SIZES[id] || { w: 340, h: 420 };
  win.style.width = sz.w + 'px';
  win.style.height = sz.h + 'px';

  const bar = document.createElement('div');
  bar.className = 'ws-float-titlebar';
  const title = document.createElement('span');
  title.className = 'ws-float-title';
  title.dataset.i18n = 'tab.' + id;
  title.textContent = t('tab.' + id);
  const dockBtn = document.createElement('button');
  dockBtn.className = 'ws-float-dock';
  dockBtn.dataset.i18n = 'ws.dockBack';
  dockBtn.textContent = t('ws.dockBack');
  dockBtn.addEventListener('click', () => dockFloatBack(id));
  bar.append(title, dockBtn);

  const body = document.createElement('div');
  body.className = 'ws-float-body';
  body.appendChild(pane);
  win.append(bar, body);
  document.body.appendChild(win);
  pane.classList.add('active');
  return win;
}

function syncFloats(panes) {
  for (const id of PANELS) {
    const f = _state.floats[id];
    let win = document.querySelector('.ws-float[data-pane="' + id + '"]');
    if (f) {
      if (!win) win = createFloat(id, panes[id]);
      const body = win.querySelector('.ws-float-body');
      const pane = panes[id];
      if (body && pane && pane.parentElement !== body) body.appendChild(pane);
      if (pane) pane.classList.add('active');
      win.style.left = f.x + 'px';
      win.style.top = f.y + 'px';
      win.style.width = f.w + 'px';
      win.style.height = f.h + 'px';
    } else if (win) {
      win.remove();
    }
  }
}

function commit(persist = true) {
  const panes = capturePanes();
  renderStrips();
  renderDocks(panes);

  const l = layoutEl();
  const showL = _state.sidebarVisible && _state.open.left.length > 0;
  const showR = _state.sidebarVisible && _state.open.right.length > 0;
  const showB = _state.timelineVisible && _state.open.bottom.length > 0;
  l.classList.toggle('area-left-open', showL);
  l.classList.toggle('area-right-open', showR);
  l.style.setProperty('--area-left-w', showL ? (_state.areaLeftW || 300) + 'px' : '0px');
  l.style.setProperty('--area-right-w', showR ? (_state.areaRightW || 320) + 'px' : '0px');
  // 底部坞：时间轴可见但无面板时保留 6px 细条作为拖放目标；整体隐藏仅由菜单开关控制。
  document.body.style.setProperty('--tl-h', _state.timelineVisible ? (showB ? (_state.bottomH || 360) + 'px' : '6px') : '0px');
  const db = el('dock-bottom');
  if (db) db.style.display = _state.timelineVisible ? '' : 'none';

  applyI18nDom();
  if (persist) persistActive();
  // 布局变化后按新尺寸重排 3D 视口/标尺并重绘 lane 画布。
  window.dispatchEvent(new Event('resize'));
  import('./timeline-layers.js').then((m) => m.drawTimelineLayers()).catch(() => {});
}

/* —— 面板开关 —— */

function collapsePanel(id) {
  _state.open.left = _state.open.left.filter((p) => p !== id);
  _state.open.right = _state.open.right.filter((p) => p !== id);
  _state.open.bottom = _state.open.bottom.filter((p) => p !== id);
  delete _state.floats[id];
  if (_state.dock[id] === 'float') _state.dock[id] = defaultDockFor(id);
  commit(true);
}

function togglePanel(id) {
  const d = _state.dock[id];
  if (d === 'float') { dockFloatBack(id); return; }
  if (d === 'left' || d === 'right') {
    const arr = _state.open[d];
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1);
    else { arr.length = 0; arr.push(id); }
  } else if (d === 'bottom') {
    const arr = _state.open.bottom;
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1);
    else { if (arr.length >= 2) arr.shift(); arr.push(id); }
  }
  refreshPanelHook(id);
  commit(true);
}

function refreshPanelHook(id) {
  if (!isOpen(id)) return;
  if (id === 'texEditor') import('./texture-editor.js').then((m) => m.refreshTexturePanel()).catch(() => {});
  else if (id === 'uv') import('./texture-editor.js').then((m) => { m.refreshUVPanel(); m.renderTexCanvas(); }).catch(() => {});
  else if (id === 'timeline') import('./timeline-layers.js').then((m) => m.drawTimelineLayers()).catch(() => {});
}

function dockFloatBack(id) {
  delete _state.floats[id];
  _state.dock[id] = defaultDockFor(id);
  const d = _state.dock[id];
  if (d === 'bottom') {
    _state.open.bottom = _state.open.bottom.filter((p) => p !== id);
    _state.open.bottom.push(id);
  } else {
    _state.open.left = _state.open.left.filter((p) => p !== id);
    _state.open.right = _state.open.right.filter((p) => p !== id);
    _state.open[d] = [id];
  }
  refreshPanelHook(id);
  commit(true);
}

/* —— 吸附区 —— */

function buildZones() {
  const keys = ['sl-top', 'sl-bottom', 'sr-top', 'sr-bottom', 'area-left', 'area-right', 'bottom', 'float'];
  for (const key of keys) {
    const z = document.createElement('div');
    z.className = 'ws-drop-zone';
    z.dataset.wsZone = key;
    z.style.cssText = 'position:fixed;z-index:500;pointer-events:none;';
    document.body.appendChild(z);
    zones[key] = z;
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

function resolveDrop(ev) {
  const x = ev.clientX, y = ev.clientY;
  const checks = [
    ['sl-top', el('strip-left-top'), { kind: 'strip', strip: 'left', half: 'top' }],
    ['sl-bottom', el('strip-left-bottom'), { kind: 'strip', strip: 'left', half: 'bottom' }],
    ['sr-top', el('strip-right-top'), { kind: 'strip', strip: 'right', half: 'top' }],
    ['sr-bottom', el('strip-right-bottom'), { kind: 'strip', strip: 'right', half: 'bottom' }],
    ['area-left', el('area-left'), { kind: 'side', side: 'left' }],
    ['area-right', el('area-right'), { kind: 'side', side: 'right' }],
    ['bottom', el('dock-bottom'), { kind: 'bottom' }],
    ['float', el('viewport'), { kind: 'float' }],
  ];
  for (const [key, node, data] of checks) {
    if (node && inRect(x, y, rectOf(node))) return Object.assign({ zoneKey: key }, data);
  }
  return null;
}

const ZONE_NODE = {
  'sl-top': 'strip-left-top', 'sl-bottom': 'strip-left-bottom',
  'sr-top': 'strip-right-top', 'sr-bottom': 'strip-right-bottom',
  'area-left': 'area-left', 'area-right': 'area-right',
  bottom: 'dock-bottom', float: 'viewport',
};

function updateZones(ev) {
  clearZones();
  const target = resolveDrop(ev);
  if (!target) return;
  const node = el(ZONE_NODE[target.zoneKey] || target.zoneKey);
  if (!node) return;
  placeZone(target.zoneKey, rectOf(node));
  showZones([target.zoneKey]);
  zones[target.zoneKey].classList.add('active');
}

function insertionIndex(id, strip, half, clientY) {
  const box = el('strip-' + strip + '-' + half);
  const icons = [...box.querySelectorAll('.ws-icon')].filter((b) => b.dataset.panel !== id);
  let idx = icons.length;
  for (let i = 0; i < icons.length; i++) {
    const r = icons[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) { idx = i; break; }
  }
  return idx;
}

function movePanelIcon(id, strip, half, idx) {
  for (const st of ['left', 'right']) for (const hf of ['top', 'bottom']) {
    const arr = _state.strips[st][hf];
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1);
  }
  const target = _state.strips[strip][half];
  target.splice(Math.max(0, Math.min(idx, target.length)), 0, id);
}

function removeFromOpen(id) {
  _state.open.left = _state.open.left.filter((p) => p !== id);
  _state.open.right = _state.open.right.filter((p) => p !== id);
  _state.open.bottom = _state.open.bottom.filter((p) => p !== id);
  delete _state.floats[id];
}

function applyDrop(id, target, ev) {
  if (target.kind === 'strip') {
    movePanelIcon(id, target.strip, target.half, insertionIndex(id, target.strip, target.half, ev.clientY));
    _state.dock[id] = target.strip;
    removeFromOpen(id);
    _state.open[target.strip] = [id];
  } else if (target.kind === 'side') {
    _state.dock[id] = target.side;
    removeFromOpen(id);
    const cur = _state.open[target.side].filter((p) => p !== id);
    if (cur.length === 0) _state.open[target.side] = [id];
    else if (cur.length === 1) _state.open[target.side] = [cur[0], id];
    else _state.open[target.side] = [id];
  } else if (target.kind === 'bottom') {
    _state.dock[id] = 'bottom';
    removeFromOpen(id);
    const arr = _state.open.bottom;
    if (!arr.includes(id)) {
      if (arr.length >= 2) arr.shift();
      arr.push(id);
    }
    const bb = rectOf(el('dock-bottom'));
    _state.bottomDir = (ev.clientX < bb.left + bb.width / 2) ? 'horiz' : 'vert';
  } else if (target.kind === 'float') {
    _state.dock[id] = 'float';
    removeFromOpen(id);
    const sz = FLOAT_SIZES[id] || { w: 340, h: 420 };
    _state.floats[id] = {
      x: Math.round(ev.clientX - sz.w / 2), y: Math.round(ev.clientY - 24),
      w: sz.w, h: sz.h,
    };
  }
  refreshPanelHook(id);
  commit(true);
}

/* —— 拖动（图标 / 面板头 / 时间轴控制条背景 / 浮动窗标题栏） —— */

function setupDrag() {
  document.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    let id = null;
    const icon = ev.target.closest('.ws-icon');
    if (icon) id = icon.dataset.panel;
    else {
      const head = ev.target.closest('.ws-pane-head');
      if (head && !ev.target.closest('button')) id = head.dataset.panel;
      else {
        const tc = ev.target.closest('.tl-controls');
        if (tc && !ev.target.closest('button, input, select, label')) id = 'tlControls';
        else {
          const fb = ev.target.closest('.ws-float-titlebar');
          if (fb && !ev.target.closest('button')) {
            const win = fb.closest('.ws-float');
            if (win) id = win.dataset.pane;
          }
        }
      }
    }
    if (!id) return;

    const startX = ev.clientX, startY = ev.clientY;
    const wasFloat = _state.dock[id] === 'float';
    const win = wasFloat ? document.querySelector('.ws-float[data-pane="' + id + '"]') : null;
    const origL = win ? (parseInt(win.style.left, 10) || 60) : 0;
    const origT = win ? (parseInt(win.style.top, 10) || 80) : 0;
    let started = false;

    const move = (ev2) => {
      if (!started && Math.hypot(ev2.clientX - startX, ev2.clientY - startY) < 6) return;
      if (!started) { started = true; document.body.classList.add('ws-dragging'); }
      if (wasFloat && win) {
        win.style.left = (origL + ev2.clientX - startX) + 'px';
        win.style.top = (origT + ev2.clientY - startY) + 'px';
      }
      updateZones(ev2);
    };
    const up = (ev2) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('ws-dragging');
      clearZones();
      if (!started) return;
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      const target = resolveDrop(ev2);
      if (wasFloat && win) {
        if (target && target.kind !== 'float') {
          delete _state.floats[id];
          applyDrop(id, target, ev2);
        } else {
          _state.floats[id] = { x: parseInt(win.style.left, 10) || 60, y: parseInt(win.style.top, 10) || 80, w: win.offsetWidth, h: win.offsetHeight };
          commit(true);
        }
      } else if (target) {
        applyDrop(id, target, ev2);
      } else {
        commit(false);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

/* —— 分隔条拖拽 —— */

function setupSplitDrag() {
  document.addEventListener('pointerdown', (ev) => {
    const sp = ev.target.closest('.ws-split');
    if (!sp || ev.button !== 0) return;
    const dock = sp.dataset.dock;
    const index = +sp.dataset.index;
    const horizontal = sp.classList.contains('ws-split-h');
    const container = sp.parentElement;
    const wraps = [...container.querySelectorAll(':scope > .ws-pane-wrap')];
    const a = wraps[index], b = wraps[index + 1];
    if (!a || !b) return;
    const sizes = dock === 'bottom' ? _state.sizes.bottom : _state.sizes[dock];
    const total = horizontal ? container.getBoundingClientRect().height : container.getBoundingClientRect().width;
    const start = horizontal ? ev.clientY : ev.clientX;
    const startA = sizes[index] != null ? sizes[index] : 50;
    const startB = sizes[index + 1] != null ? sizes[index + 1] : 50;

    const move = (ev2) => {
      const delta = ((horizontal ? ev2.clientY : ev2.clientX) - start) / total * 100;
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
      window.dispatchEvent(new Event('resize'));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

/* —— 侧边区域宽度 / 底部坞高度 —— */

function setupResize() {
  const bind = (handleId, isLeft) => {
    const handle = el(handleId);
    if (!handle) return;
    let resizing = false, startX = 0, startW = 0;
    handle.addEventListener('pointerdown', (e) => {
      resizing = true; startX = e.clientX;
      startW = isLeft ? (_state.areaLeftW || 300) : (_state.areaRightW || 320);
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!resizing) return;
      const dx = e.clientX - startX;
      let w = isLeft ? startW + dx : startW - dx;
      w = Math.max(220, Math.min(720, w));
      if (isLeft) _state.areaLeftW = w; else _state.areaRightW = w;
      layoutEl().style.setProperty(isLeft ? '--area-left-w' : '--area-right-w', w + 'px');
      window.dispatchEvent(new Event('resize'));
    });
    const stop = () => {
      if (!resizing) return;
      resizing = false;
      handle.classList.remove('dragging');
      persistActive();
    };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  };
  bind('resize-handle-l', true);
  bind('resize-handle-r', false);

  // 底部坞高度（顶边把手）
  const grip = el('tl-module-resize');
  if (grip) {
    let resizing = false, lastY = 0;
    grip.addEventListener('pointerdown', (e) => {
      resizing = true; lastY = e.clientY;
      grip.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    grip.addEventListener('pointermove', (e) => {
      if (!resizing) return;
      const dy = e.clientY - lastY;
      lastY = e.clientY;
      const cur = _state.bottomH || 360;
      const nh = Math.min(window.innerHeight * 0.78, Math.max(140, cur - dy));
      _state.bottomH = nh;
      document.body.style.setProperty('--tl-h', nh + 'px');
      window.dispatchEvent(new Event('resize'));
      import('./timeline-layers.js').then((m) => m.drawTimelineLayers()).catch(() => {});
    });
    const stop = () => {
      if (!resizing) return;
      resizing = false;
      persistActive();
    };
    grip.addEventListener('pointerup', stop);
    grip.addEventListener('pointercancel', stop);
  }
}

/* —— 菜单与自定义工作区 —— */

function injectMenu() {
  const menubar = document.querySelector('.menubar');
  const about = el('btn-about').closest('.menu');
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.innerHTML = `
    <button class="menu-btn" data-menu="window" data-i18n="menu.window">窗口</button>
    <div class="dropdown" id="menu-window">
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

function closeMenuWindow() {
  const dd = el('menu-window');
  if (dd) dd.closest('.menu').classList.remove('open');
}

function renderCustomList() {
  const box = el('ws-custom-list');
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
  m[n] = currentState();
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

function autoLayout() { applyWorkspaceState(defaultState(), true); }

function bindMenu() {
  el('menu-window').addEventListener('click', (ev) => {
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
      _state.sidebarVisible = !_state.sidebarVisible;
      commit(true);
    } else if (id === 'ws-toggle-timeline') {
      _state.timelineVisible = !_state.timelineVisible;
      commit(true);
    } else if (id === 'ws-save') { closeMenuWindow(); saveCustomFlow(); }
    else if (id === 'ws-manage') { closeMenuWindow(); openManage(); }
    else if (id === 'ws-reset') { closeMenuWindow(); autoLayout(); }
  });
}

/* —— 对外 —— */

export function applyWorkspaceState(state, persist = true) {
  _state = normalize(state);
  commit(persist);
}

export function initWorkspace() {
  if (initialized) return;
  initialized = true;

  injectMenu();
  buildZones();
  bindMenu();
  setupDrag();
  setupSplitDrag();
  setupResize();

  const saved = (() => { try { return JSON.parse(localStorage.getItem(LS_ACTIVE)) || null; } catch (e) { return null; } })();
  applyWorkspaceState(saved && typeof saved === 'object' ? saved : defaultState(), false);
  renderCustomList();
  applyI18nDom();
}