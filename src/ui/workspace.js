// 工作区系统：桌面端侧栏 / 时间轴可拖放停靠（左/右、上/下）与折叠，
// 内置一键预设工作区，并支持自定义工作区的本地保存 / 应用 / 重命名 / 删除。
// 窄屏（≤1024px）由 mobile.css 的抽屉布局接管，本模块只注入菜单与把手、不做布局干预。

import { isNarrowLayout } from '../core/device.js';
import { t, applyI18nDom } from '../core/i18n.js';
import { modalPrompt, modalConfirm } from './ui.js';

const LS_ACTIVE = 'pdraw-workspace-active';
const LS_CUSTOM = 'pdraw-workspace-custom';

// 内置预设：仅覆盖停靠边与可见性；宽/高沿用当前值或默认值。
const PRESETS = {
  default:     { sidebarDock: 'right', sidebarVisible: true,  timelineDock: 'bottom', timelineVisible: true },
  left:        { sidebarDock: 'left',  sidebarVisible: true,  timelineDock: 'bottom', timelineVisible: true },
  draw:        { sidebarDock: 'right', sidebarVisible: false, timelineDock: 'bottom', timelineVisible: true },
  animate:     { sidebarDock: 'right', sidebarVisible: true,  timelineDock: 'bottom', timelineVisible: true, timelineHeight: 480 },
  timelineTop: { sidebarDock: 'right', sidebarVisible: true,  timelineDock: 'top',    timelineVisible: true },
};

const layoutEl = () => document.querySelector('.layout');
const sidebarEl = () => document.querySelector('.sidebar');
const timelineEl = () => document.querySelector('.timeline');

// 停靠边单独记录：折叠时对应类会被移除，不能从 DOM 类反推。
let _dock = { sidebar: 'right', timeline: 'bottom' };
let initialized = false;

function normalize(s) {
  return {
    sidebarDock: s.sidebarDock === 'left' ? 'left' : 'right',
    sidebarVisible: s.sidebarVisible !== false,
    timelineDock: s.timelineDock === 'top' ? 'top' : 'bottom',
    timelineVisible: s.timelineVisible !== false,
    sidebarWidth: s.sidebarWidth || null,
    timelineHeight: s.timelineHeight || null,
  };
}

export function currentWorkspaceState() {
  const l = layoutEl(), b = document.body;
  return {
    sidebarDock: _dock.sidebar,
    sidebarVisible: !b.classList.contains('ws-sidebar-hidden'),
    timelineDock: _dock.timeline,
    timelineVisible: !b.classList.contains('ws-timeline-hidden'),
    sidebarWidth: parseInt(l.style.getPropertyValue('--right-w'), 10) || 320,
    timelineHeight: parseInt(b.style.getPropertyValue('--tl-h'), 10) || 360,
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

  if (persist) { try { localStorage.setItem(LS_ACTIVE, JSON.stringify(s)); } catch (e) { /* 忽略 */ } }
}

function loadActive() { try { return JSON.parse(localStorage.getItem(LS_ACTIVE)) || null; } catch (e) { return null; } }
function customMap() { try { return JSON.parse(localStorage.getItem(LS_CUSTOM)) || {}; } catch (e) { return {}; } }
function saveCustomMap(m) { try { localStorage.setItem(LS_CUSTOM, JSON.stringify(m)); } catch (e) { /* 忽略 */ } }

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

/* —— 拖放吸附 —— */

const zones = {};

function buildZones() {
  const defs = {
    left:   'left:0;top:0;width:30%;height:100%;',
    right:  'right:0;top:0;width:30%;height:100%;',
    top:    'left:0;top:0;width:100%;height:24%;',
    bottom: 'left:0;bottom:0;width:100%;height:24%;',
  };
  for (const key in defs) {
    const el = document.createElement('div');
    el.className = 'ws-drop-zone';
    el.dataset.wsZone = key;
    el.style.cssText = defs[key];
    document.body.appendChild(el);
    zones[key] = el;
  }
}

function zonesFor(panel) {
  return panel === 'sidebar' ? [zones.left, zones.right] : [zones.top, zones.bottom];
}

function setupDrag(panel) {
  const grip = document.getElementById(panel === 'sidebar' ? 'ws-grip-sidebar' : 'ws-grip-timeline');
  if (!grip) return;
  let dragging = false;
  let activeKey = null;

  const setVisible = (on) => zonesFor(panel).forEach(z => z.classList.toggle('visible', on));
  const setActive = (k) => zonesFor(panel).forEach(z => z.classList.toggle('active', z.dataset.wsZone === k));

  const update = (ev) => {
    const k = panel === 'sidebar'
      ? (ev.clientX < window.innerWidth * 0.3 ? 'left' : ev.clientX > window.innerWidth * 0.7 ? 'right' : null)
      : (ev.clientY < window.innerHeight * 0.24 ? 'top' : ev.clientY > window.innerHeight * 0.76 ? 'bottom' : null);
    activeKey = k;
    setActive(k);
  };

  grip.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || isNarrowLayout()) return;
    dragging = true; activeKey = null;
    grip.setPointerCapture(ev.pointerId);
    document.body.classList.add('ws-dragging');
    setVisible(true);
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
    setVisible(false);
    setActive(null);
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
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

function closeManage() { document.querySelectorAll('.ws-manage-pop').forEach(p => p.remove()); }

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

function bindMenu() {
  document.getElementById('menu-window').addEventListener('click', (ev) => {
    const preset = ev.target.closest('.ws-preset');
    if (preset) {
      const p = PRESETS[preset.dataset.wsPreset];
      if (p) {
        closeMenuWindow();
        applyWorkspaceState(Object.assign({}, p), true);
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
    if (id === 'ws-toggle-sidebar') {
      const s = currentWorkspaceState();
      s.sidebarVisible = !s.sidebarVisible;
      applyWorkspaceState(s, true);
    } else if (id === 'ws-toggle-timeline') {
      const s = currentWorkspaceState();
      s.timelineVisible = !s.timelineVisible;
      applyWorkspaceState(s, true);
    } else if (id === 'ws-save') {
      closeMenuWindow();
      saveCustomFlow();
    } else if (id === 'ws-manage') {
      closeMenuWindow();
      openManage();
    } else if (id === 'ws-reset') {
      closeMenuWindow();
      applyWorkspaceState(Object.assign({}, PRESETS.default), true);
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
  setupDrag('sidebar');
  setupDrag('timeline');

  const saved = loadActive();
  applyWorkspaceState(saved && typeof saved === 'object' ? saved : PRESETS.default, false);
  renderCustomList();
  applyI18nDom();
}