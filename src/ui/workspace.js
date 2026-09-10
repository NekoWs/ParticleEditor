// 工作区系统 v2：
// - 桌面端侧栏可停靠左/右、时间轴可停靠上/下，支持折叠；
// - 侧栏选项卡（属性/函数对象/贴图）可拖出为浮动窗口（分离），浮动窗口可拖回侧栏合并为标签；
// - 内置一键预设 + 自动布局 + 自定义工作区本地保存；
// - 所有吸附预览按放置后的真实尺寸渲染，放置后尺寸与预览一致。
// 窄屏（≤1024px）由 mobile.css 抽屉布局接管，本模块不做布局干预。

import { isNarrowLayout } from '../core/device.js';
import { t, applyI18nDom } from '../core/i18n.js';
import { modalPrompt, modalConfirm } from './ui.js';

const LS_ACTIVE = 'pdraw-workspace-active';
const LS_CUSTOM = 'pdraw-workspace-custom';

const PANES = ['props', 'fx', 'texture'];
const FLOAT_SIZES = { props: { w: 340, h: 480 }, fx: { w: 340, h: 480 }, texture: { w: 560, h: 460 } };

// 预设：停靠边与可见性；浮动的面板一律收回到侧栏。
const PRESETS = {
  default:     { sidebarDock: 'right', sidebarVisible: true,  timelineDock: 'bottom', timelineVisible: true },
  left:        { sidebarDock: 'left',  sidebarVisible: true,  timelineDock: 'bottom', timelineVisible: true },
  draw:        { sidebarDock: 'right', sidebarVisible: false, timelineDock: 'bottom', timelineVisible: true },
  animate:     { sidebarDock: 'right', sidebarVisible: true,  timelineDock: 'bottom', timelineVisible: true, timelineHeight: 480 },
  timelineTop: { sidebarDock: 'right', sidebarVisible: true,  timelineDock: 'top',    timelineVisible: true },
};

const layoutEl = () => document.querySelector('.layout');
const sidebarEl = () => document.querySelector('.sidebar');
const tabsEl = () => document.getElementById('sidebar-tabs');
const paneEl = (id) => document.getElementById('pane-' + id);
const tabEl = (id) => tabsEl() && tabsEl().querySelector('.tab[data-tab="' + id + '"]');

let _dock = { sidebar: 'right', timeline: 'bottom' };
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
  out.floats = {};
  if (s.floats && typeof s.floats === 'object') {
    for (const id of PANES) {
      if (s.floats[id]) out.floats[id] = { x: Math.round(s.floats[id].x || 60), y: Math.round(s.floats[id].y || 80) };
    }
  }
  return out;
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
    floats,
  };
}

export function applyWorkspaceState(state, persist = true) {
  const s = normalize(state);
  const l = layoutEl(), b = document.body;

  _dock.sidebar = s.sidebarDock;
  _dock.timeline = s.timelineDock;

  b.classList.remove('ws-sidebar-hidden', 'ws-timeline-top', 'ws-timeline-hidden');
  l.classList.remove('ws-sidebar-left');

  if (!s.sidebarVisible) b.classList.add('ws-sidebar-hidden');
  else if (s.sidebarDock === 'left') l.classList.add('ws-sidebar-left');

  if (!s.timelineVisible) b.classList.add('ws-timeline-hidden');
  else if (s.timelineDock === 'top') b.classList.add('ws-timeline-top');

  if (s.sidebarWidth) l.style.setProperty('--right-w', s.sidebarWidth + 'px');
  if (s.timelineHeight) b.style.setProperty('--tl-h', s.timelineHeight + 'px');

  syncFloats(s.floats);
  syncSidebarActive();

  if (persist) { try { localStorage.setItem(LS_ACTIVE, JSON.stringify(s)); } catch (e) { /* 忽略 */ } }
}

function loadActive() { try { return JSON.parse(localStorage.getItem(LS_ACTIVE)) || null; } catch (e) { return null; } }
function customMap() { try { return JSON.parse(localStorage.getItem(LS_CUSTOM)) || {}; } catch (e) { return {}; } }
function saveCustomMap(m) { try { localStorage.setItem(LS_CUSTOM, JSON.stringify(m)); } catch (e) { /* 忽略 */ } }

/* —— 浮动 / 合并 —— */

function floatWindow(id) { return document.querySelector('.ws-float[data-pane="' + id + '"]'); }

function floatPane(id, x, y) {
  if (!paneEl(id)) return;
  if (isNarrowLayout()) return;
  let win = floatWindow(id);
  if (!win) {
    win = document.createElement('div');
    win.className = 'ws-float';
    win.dataset.pane = id;
    win.style.width = FLOAT_SIZES[id].w + 'px';
    win.style.height = FLOAT_SIZES[id].h + 'px';

    const bar = document.createElement('div');
    bar.className = 'ws-float-titlebar';
    const title = document.createElement('span');
    title.className = 'ws-float-title';
    title.textContent = t('tab.' + id);
    const dockBtn = document.createElement('button');
    dockBtn.className = 'ws-float-dock';
    dockBtn.dataset.i18nTitle = 'ws.dockBack';
    dockBtn.title = t('ws.dockBack');
    dockBtn.textContent = t('ws.dockBack');
    dockBtn.addEventListener('click', () => { dockPane(id); applyWorkspaceState(currentWorkspaceState(), true); });
    bar.append(title, dockBtn);

    const body = document.createElement('div');
    body.className = 'ws-float-body';
    body.appendChild(paneEl(id));
    win.append(bar, body);
    document.body.appendChild(win);

    paneEl(id).classList.add('active'); // 贴图等面板浮动后仍需按需刷新
    const tb = tabEl(id);
    if (tb) tb.style.display = 'none';
  }
  win.style.left = x + 'px';
  win.style.top = y + 'px';
  syncSidebarActive();
}

function dockPane(id) {
  const win = floatWindow(id);
  if (win) win.remove();
  const pane = paneEl(id);
  if (pane && !pane.closest('.sidebar')) sidebarEl().appendChild(pane);
  const tb = tabEl(id);
  if (tb) tb.style.display = '';
  if (pane) pane.classList.remove('active');
  syncSidebarActive();
}

function dockAll() {
  for (const id of PANES) dockPane(id);
}

function syncFloats(floats) {
  const map = floats || {};
  for (const id of PANES) {
    if (map[id] && !isNarrowLayout()) floatPane(id, map[id].x, map[id].y);
    else dockPane(id);
  }
  syncSidebarActive();
}

function syncSidebarActive() {
  const strip = tabsEl();
  if (!strip) return;
  const visible = [...strip.querySelectorAll('.tab[data-tab]')].filter((tb) => tb.style.display !== 'none');
  let activeTab = visible.find((tb) => tb.classList.contains('active'));
  if (!activeTab && visible.length) { activeTab = visible[0]; activeTab.classList.add('active'); }
  visible.forEach((tb) => tb.classList.toggle('active', tb === activeTab));
  for (const id of PANES) {
    const pane = paneEl(id);
    const tb = tabEl(id);
    if (pane && pane.closest('.sidebar')) {
      pane.classList.toggle('active', !!tb && tb.classList.contains('active'));
    }
  }
}

/* —— DOM 注入 —— */

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

/* —— 吸附区与预览 —— */

function buildZones() {
  const defs = {
    left:   { rect: () => ({ left: 0, top: 0, width: sidebarWidthPx(), height: window.innerHeight }) },
    right:  { rect: () => ({ left: window.innerWidth - sidebarWidthPx(), top: 0, width: sidebarWidthPx(), height: window.innerHeight }) },
    top:    { rect: () => ({ left: 0, top: 0, width: window.innerWidth, height: timelineHeightPx() }) },
    bottom: { rect: () => ({ left: 0, top: window.innerHeight - timelineHeightPx(), width: window.innerWidth, height: timelineHeightPx() }) },
  };
  for (const key in defs) {
    const el = document.createElement('div');
    el.className = 'ws-drop-zone';
    el.dataset.wsZone = key;
    el.style.cssText = 'position:fixed;z-index:500;pointer-events:none;';
    document.body.appendChild(el);
    zones[key] = el;
  }
  // 浮动预览区：尺寸在拖拽时按面板目标尺寸设置
  const fz = document.createElement('div');
  fz.className = 'ws-drop-zone';
  fz.dataset.wsZone = 'float';
  fz.style.cssText = 'position:fixed;z-index:500;pointer-events:none;';
  document.body.appendChild(fz);
  zones.float = fz;
  // 合并预览区：浮动窗口拖回侧栏时高亮标签栏（放置后的真实位置）
  const mz = document.createElement('div');
  mz.className = 'ws-drop-zone';
  mz.dataset.wsZone = 'merge';
  mz.style.cssText = 'position:fixed;z-index:500;pointer-events:none;';
  document.body.appendChild(mz);
  zones.merge = mz;
}

function sidebarWidthPx() {
  return parseInt(layoutEl().style.getPropertyValue('--right-w'), 10) || 320;
}
function timelineHeightPx() {
  return parseInt(document.body.style.getPropertyValue('--tl-h'), 10) || 360;
}

function placeZone(key, rect) {
  const z = zones[key];
  if (!z || !rect) return;
  z.style.left = rect.left + 'px';
  z.style.top = rect.top + 'px';
  z.style.width = rect.width + 'px';
  z.style.height = rect.height + 'px';
}
function showZones(keys) {
  Object.keys(zones).forEach((k) => zones[k].classList.toggle('visible', keys.includes(k)));
}
function clearZones() {
  Object.keys(zones).forEach((k) => zones[k].classList.remove('visible', 'active'));
}

function inRect(x, y, r) {
  return x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
}

/* —— 侧栏 / 时间轴把手：停靠到边 —— */

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
    const keys = panel === 'sidebar' ? ['left', 'right'] : ['top', 'bottom'];
    keys.forEach((k) => placeZone(k, rectForKey(k)));
    showZones(keys);
    update(ev);
  });
  grip.addEventListener('pointermove', (ev) => { if (dragging) update(ev); });

  const end = () => {
    if (!dragging) return;
    if (activeKey) {
      const s = currentWorkspaceState();
      if (panel === 'sidebar') s.sidebarDock = activeKey;
      else s.timelineDock = activeKey;
      applyWorkspaceState(s, true);
    }
    dragging = false; activeKey = null;
    document.body.classList.remove('ws-dragging');
    clearZones();
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);

  function update(ev) {
    const keys = panel === 'sidebar' ? ['left', 'right'] : ['top', 'bottom'];
    let hit = null;
    for (const k of keys) if (inRect(ev.clientX, ev.clientY, rectForKey(k))) { hit = k; break; }
    activeKey = hit;
    keys.forEach((k) => zones[k].classList.toggle('active', k === hit));
  }
}

function rectForKey(key) {
  const sw = sidebarWidthPx(), th = timelineHeightPx();
  if (key === 'left') return { left: 0, top: 0, width: sw, height: window.innerHeight };
  if (key === 'right') return { left: window.innerWidth - sw, top: 0, width: sw, height: window.innerHeight };
  if (key === 'top') return { left: 0, top: 0, width: window.innerWidth, height: th };
  if (key === 'bottom') return { left: 0, top: window.innerHeight - th, width: window.innerWidth, height: th };
  return null;
}

/* —— 选项卡拖出 → 浮动（分离） —— */

function setupTabDrag() {
  const strip = tabsEl();
  if (!strip) return;
  strip.addEventListener('pointerdown', (ev) => {
    const tab = ev.target.closest('.tab[data-tab]');
    if (!tab || isNarrowLayout() || ev.button !== 0) return;
    const id = tab.dataset.tab;
    const pane = paneEl(id);
    if (!pane || !pane.closest('.sidebar')) return;

    const sz = FLOAT_SIZES[id];
    let started = false;
    const startX = ev.clientX, startY = ev.clientY;

    const move = (ev2) => {
      if (!started && Math.hypot(ev2.clientX - startX, ev2.clientY - startY) < 6) return;
      started = true;
      document.body.classList.add('ws-dragging');
      const rect = { left: Math.max(4, ev2.clientX - sz.w / 2), top: Math.max(44, ev2.clientY - sz.h / 2), width: sz.w, height: sz.h };
      placeZone('float', rect);
      showZones(['float']);
      zones.float.classList.toggle('active', inFloatRegion(ev2));
    };
    const up = (ev2) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('ws-dragging');
      clearZones();
      if (started) suppressTabClick = true;
      if (started && inFloatRegion(ev2)) {
        floatPane(id, Math.round(ev2.clientX - sz.w / 2), Math.round(ev2.clientY - sz.h / 2));
        applyWorkspaceState(currentWorkspaceState(), true);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  // 拖拽完成后抑制「点击切换标签」。
  strip.addEventListener('click', (ev) => {
    if (suppressTabClick) { suppressTabClick = false; ev.stopPropagation(); ev.preventDefault(); }
  }, true);
}

function inFloatRegion(ev) {
  const sb = sidebarEl().getBoundingClientRect();
  const overSidebar = ev.clientX >= sb.left && ev.clientX <= sb.right && ev.clientY >= sb.top && ev.clientY <= sb.bottom;
  return !overSidebar && ev.clientY > 50 && ev.clientY < window.innerHeight - 40;
}

/* —— 浮动窗口拖动 → 合并 / 移动 —— */

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

    // 预览区 = 侧栏标签栏（合并回标签后的真实位置）。
    const tabStripRect = () => {
      const r = tabsEl().getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    };

    const move = (ev2) => {
      if (!moved && Math.hypot(ev2.clientX - startX, ev2.clientY - startY) < 6) return;
      moved = true;
      document.body.classList.add('ws-dragging');
      win.style.left = (origL + ev2.clientX - startX) + 'px';
      win.style.top = (origT + ev2.clientY - startY) + 'px';
      const over = inRect(ev2.clientX, ev2.clientY, tabStripRect());
      if (over) {
        placeZone('merge', tabStripRect());
        showZones(['merge']);
        zones.merge.classList.add('active');
      } else {
        showZones([]);
      }
    };
    const up = (ev2) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('ws-dragging');
      clearZones();
      const over = inRect(ev2.clientX, ev2.clientY, tabStripRect());
      if (over) {
        dockPane(id);
      }
      applyWorkspaceState(currentWorkspaceState(), true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

/* —— 菜单与自定义工作区 —— */

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

function closeManage() { document.querySelectorAll('.ws-manage-pop').forEach((p) => p.remove()); }

function openManage() {
  closeManage();
  const pop = document.createElement('div');
  pop.className = 'ws-manage-pop';

  const head = document.createElement('div');
  head.className = 'ws-manage-title';
  head.textContent = t('ws.manage');
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

  setTimeout(() => document.addEventListener('pointerdown', (ev) => {
    if (!ev.target.closest('.ws-manage-pop')) closeManage();
  }, { once: true }), 0);
}

function autoLayout() {
  dockAll();
  applyWorkspaceState({
    sidebarDock: 'right', sidebarVisible: true, sidebarWidth: 320,
    timelineDock: 'bottom', timelineVisible: true, timelineHeight: 360,
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
        applyWorkspaceState(Object.assign({}, p, { floats: {} }), true);
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
    else if (id === 'ws-reset') {
      closeMenuWindow();
      dockAll();
      applyWorkspaceState(Object.assign({}, PRESETS.default, { floats: {} }), true);
    }
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

  const saved = loadActive();
  applyWorkspaceState(saved && typeof saved === 'object' ? saved : Object.assign({}, PRESETS.default, { floats: {} }), false);
  renderCustomList();
  applyI18nDom();
}