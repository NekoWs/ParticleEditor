// UI 初始化与主循环：绑定菜单 / 工具栏 / 属性面板 / 时间轴事件，跑渲染主循环，
// 并处理工作区拖拽缩放、文件拖放打开、页面关闭前的未保存提示。本文件最后加载，
// 可以直接调用前面脚本定义的全局函数。

import { t, applyI18nDom, setLanguage } from './core/i18n.js';
import { setTheme, getTheme, applyThemeDom } from './core/theme.js';
import { hasCoarsePointer } from './core/device.js';
import { state, FUNCTION_PRESETS, getParticle, getFunction, isDerivedParticle, updateTopbarTitle, clearObjectState } from './core/constants.js';
import { setShiftHeld } from './interaction/input-state.js';
import { showAboutModal, hexToRgba, rgbaToHex } from './ui/ui.js';
import { openColorPicker } from './ui/color-picker.js';
import { easeInOut } from './core/easing.js';
import { openEasingEditor, easingCurveSVG } from './ui/easing-editor.js';
import { customSelect, refreshCustomSelect } from './ui/select.js';
import { viewport, renderer, camera, controls, scene, pointsMaterial, camTransition, setCamTransition, planePulse, setPlanePulse, updateRenderScale, applySceneTheme } from './scene/scene.js';
import { rebuildPoints, rebuildPointsTime, maxMs, updateAnimatedUV, updateCameraWidgets } from './core/animation.js';
import { editSelectionUniform, editSelectionRotationUniform } from './core/edit.js';
import { pushUndo, undo, redo, beginContinuous, endContinuous } from './state/undo.js';
import { currentSelected, selectedGroupName, deleteSelected, selectAll } from './interaction/interaction.js';
import { createGroup } from './ui/tree.js';
import { createFunctionObject } from './core/generators.js';
import { syncFunctionVarValues, drawTimeline, updateLoopIndicator, TL_PX_PER_MS, setTLPxPerMs, timelineViewStart, setTimelineViewStart, scrubAutoPan, timelineXToMs, refreshFunctionPanel } from './ui/panels.js';
import { drawTimelineLayers, tlInitLayerEvents, refreshAllPanelsLight } from './ui/timeline-layers.js';
import { initTimelineTree, refreshTimelineTree, tlTreeState } from './ui/timeline-tree.js';
import { initTextureEditor, syncTextureSelection, updateTexOverlay, texAnimOverlayActive, refreshTexturePanel } from './ui/texture-editor.js';
import { applyWorkspaceState } from './ui/blocks-ui.js';
import { initTooltip } from './ui/tooltip.js';
import { initMobileUI } from './ui/mobile.js';
import { initImportMenu } from './ui/import-image.js';
import { showWelcome } from './ui/welcome.js';
import { initWorkspace } from './ui/workspace.js';
import { initTitleBar } from './ui/titlebar.js';
import { newFile, openFile, saveFile, saveFileAs, exportAnimation, loadFile, confirmDiscardChanges, ensureProjectKey } from './io/io.js';
import { drawAxisGizmo, slerp } from './interaction/axis-gizmo.js';
import { updateGizmo, updateGizmoFrame, restoreAxisColors, setAxisGlow } from './interaction/gizmo.js';
import { getCamera, DEFAULT_CAMERA_ID } from './core/constants.js';
import { lockCamera, unlockCamera, applyCameraPose } from './core/cameras.js';

// 时间轴数值变化后的统一刷新：粒子状态、时间 UI、函数变量插值显示。
// 多处 scrub / 播放头拖动路径共用，避免漏刷某一项。
export function applyTimeChange() {
  updateTimeUI();
  rebuildPoints(false);
  syncFunctionVarValues();
}

export function updateTimeUI() {
  const timeEl = document.getElementById('tl-time');
  const s = (Math.round(state.time) / 1000).toFixed(3);
  timeEl.value = s;
  timeEl.size = Math.max(1, s.length);
  document.getElementById('tl-max').textContent = (maxMs() / 1000).toFixed(3);
}

export function syncPlayButton() {
  document.getElementById('btn-play').textContent = state.playing ? t('timeline.pause') : t('timeline.play');
}

export function togglePlay() {
  if (!state.playing && !state.loop) {
    // 播放完毕（非循环）后 state.time 停在末尾，再点播放应立即从头重播，
    // 否则下一帧会因 time 仍等于 maxMs 而立刻再次暂停。
    const mx = maxMs();
    if (mx > 0 && state.time >= mx) {
      state.time = 0;
      updateTimeUI();
      rebuildPoints();
      syncFunctionVarValues();
    }
  }
  state.playing = !state.playing;
  syncPlayButton();
}

window.addEventListener('keydown', (e) => { if (e.key === 'Shift') setShiftHeld(true); });
window.addEventListener('keyup', (e) => { if (e.key === 'Shift') setShiftHeld(false); });
window.addEventListener('keydown', (e) => { if (e.key === 'Control') document.body.classList.add('ctrl-held'); });
window.addEventListener('keyup', (e) => { if (e.key === 'Control') document.body.classList.remove('ctrl-held'); });

// 数字输入框滚轮：步进至少 0.1（不再 0.01 微调），按 min/max 钳制并触发 input/change 提交。
window.addEventListener('wheel', (ev) => {
  const el = ev.target;
  if (!el || el.tagName !== 'INPUT' || el.type !== 'number') return;
  if (el.disabled) return;
  ev.preventDefault();
  const dir = ev.deltaY < 0 ? 1 : -1;
  let step = parseFloat(el.step);
  if (!isFinite(step) || step < 0.1) step = 0.1;
  const cur = parseFloat(el.value);
  const base = isFinite(cur) ? cur : 0;
  let next = base + dir * step;
  next = Math.round(next * 1000) / 1000;
  if (el.min !== '' && next < parseFloat(el.min)) next = parseFloat(el.min);
  if (el.max !== '' && next > parseFloat(el.max)) next = parseFloat(el.max);
  if (next === base) return;
  el.value = next;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, { passive: false });

// 重建函数对象预设下拉（语言切换后重新取标签）
export function refreshFxPresetOptions() {
  const sel = document.getElementById('fx-preset-add');
  if (!sel) return;
  sel.innerHTML = '';
  for (const id in FUNCTION_PRESETS) {
    const o = document.createElement('option'); o.value = id; o.textContent = t('fx.preset.' + id);
    sel.appendChild(o);
  }
  sel.value = 'blank';
  refreshCustomSelect(sel);
}

// 重建视口上方摄像机选项卡：『默认』固定第一项 + 各摄像机 + 每项删除/重命名
export function refreshCameraTabs() {
  const host = document.getElementById('camera-tabs');
  if (!host) return;
  host.innerHTML = '';
  // 没有用户摄像机时整条切换栏隐藏；锁定到某摄像机时禁用全部工具，回默认后恢复。
  host.hidden = state.cameras.length === 0;
  const camActive = !!state.activeCamera && state.activeCamera !== DEFAULT_CAMERA_ID;
  document.querySelectorAll('.tool').forEach(b => { b.disabled = camActive; });
  if (camActive && state.tool !== 'select') {
    state.tool = 'select';
    document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === 'select'));
    updateGizmo();
  }

  const mkTab = (id, label, isDefault) => {
    const el = document.createElement('button');
    el.className = 'cam-tab';
    el.dataset.camId = id;
    el.dataset.camDefault = isDefault ? '1' : '';
    const sp = document.createElement('span');
    sp.textContent = label;
    el.appendChild(sp);
    if (!isDefault) {
      const del = document.createElement('span');
      del.className = 'cam-del';
      del.textContent = '×';
      del.dataset.del = '1';
      el.appendChild(del);
    }
    return el;
  };

  const active = state.activeCamera || DEFAULT_CAMERA_ID;
  const defTab = mkTab(DEFAULT_CAMERA_ID, t('cam.default'), true);
  defTab.classList.toggle('active', active === DEFAULT_CAMERA_ID);
  host.appendChild(defTab);

  for (const c of state.cameras) {
    const el = mkTab(c.id, c.name, false);
    el.classList.toggle('active', active === c.id);
    host.appendChild(el);
  }
}

function handleCameraTabClick(ev) {
  const delEl = ev.target.closest('.cam-del');
  const tab = ev.target.closest('.cam-tab');
  if (!tab) return;
  const id = tab.dataset.camId;
  if (delEl) {
    // 删除摄像机 + 连带删除其轨道
    const cam = getCamera(id);
    if (!cam) return;
    pushUndo();
    const idx = state.cameras.indexOf(cam);
    if (idx >= 0) state.cameras.splice(idx, 1);
    state.tracks = state.tracks.filter(tr => !(tr.ids && tr.ids.includes('c:' + id)));
    // 仅删除当前锁定的摄像机时才解锁回默认；删除其它摄像机不改变当前视角
    if (state.activeCamera === id) unlockCamera();
    refreshCameraTabs();
    refreshTimelineTree();
    return;
  }
  if (id === DEFAULT_CAMERA_ID) {
    unlockCamera();
  } else {
    lockCamera(id);
  }
  refreshCameraTabs();
}

// 双击选项卡重命名（非默认）
function handleCameraTabDblClick(ev) {
  const tab = ev.target.closest('.cam-tab');
  if (!tab || tab.dataset.camDefault) return;
  const cam = getCamera(tab.dataset.camId);
  if (!cam) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = cam.name;
  input.style.cssText = 'width:80px;height:18px;font-size:12px;border:1px solid var(--accent);border-radius:3px;padding:0 4px;';
  tab.textContent = '';
  tab.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commitRename) => {
    if (done) return;
    done = true;
    if (commitRename) {
      const v = input.value.trim();
      if (v && v !== cam.name) { pushUndo(); cam.name = v; }
    }
    refreshCameraTabs();
    refreshTimelineTree();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.stopPropagation(); finish(true); }
    else if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

export function initUI() {
  applyI18nDom();
  ensureProjectKey(); // 启动时就把密钥建好，没点「新建」直接编辑保存也能带私钥
  initTooltip();
  initMobileUI();
  initImportMenu();
  syncPlayButton();
  const tlEase = document.getElementById('tl-easing');
  tlEase.innerHTML = easingCurveSVG(state.defaultEasing);
  tlEase.onclick = () => openEasingEditor(state.defaultEasing, (e) => {
    state.defaultEasing = e;
    tlEase.innerHTML = easingCurveSVG(e);
  }, tlEase);

  // 菜单（桌面悬停展开；触屏点击切换，点外部关闭）
  const closeMenus = () => document.querySelectorAll('.menu').forEach(m => m.classList.remove('open'));
  const positionMenuDropdown = (menu) => {
    const dd = menu.querySelector('.dropdown');
    const btn = menu.querySelector('.menu-btn');
    if (!dd || !btn) return;
    const rect = btn.getBoundingClientRect();
    // 小屏 menubar 可能横向滚动，absolute 下拉会被裁切；统一按 fixed 相对视口定位。
    dd.style.position = 'fixed';
    dd.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - 200 - 4)) + 'px';
    // 与按钮底部齐平，避免按钮和下拉之间的空隙导致悬停移动时菜单闪关
    dd.style.top = rect.bottom + 'px';
  };
  const openMenu = (menu) => {
    document.querySelectorAll('.menu').forEach(m => m.classList.remove('open'));
    positionMenuDropdown(menu);
    menu.classList.add('open');
  };
  document.querySelectorAll('.menu').forEach(menu => {
    if (hasCoarsePointer()) {
      // 触屏：点击切换，避免合成 mouseenter 与 click 互相打架导致菜单闪开即关。
      const btn = menu.querySelector('.menu-btn');
      if (btn) btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const wasOpen = menu.classList.contains('open');
        closeMenus();
        if (!wasOpen) openMenu(menu);
      });
    } else {
      // 桌面：悬停展开；离开时延迟收起，给指针穿过按钮与下拉之间的空隙留出时间，
      // 避免快速移动时菜单闪关。
      let closeTimer = 0;
      menu.addEventListener('mouseenter', () => {
        clearTimeout(closeTimer);
        openMenu(menu);
      });
      menu.addEventListener('mouseleave', () => {
        closeTimer = setTimeout(() => { menu.classList.remove('open'); }, 150);
      });
    }
  });
  document.addEventListener('pointerdown', (ev) => {
    if (!ev.target.closest('.menu')) closeMenus();
  });
  document.getElementById('btn-about').addEventListener('click', () => { closeMenus(); showAboutModal(); });
  // 语言切换
  document.getElementById('menu-lang').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-lang]');
    if (!btn) return;
    closeMenus();
    setLanguage(btn.dataset.lang);
    // 动态面板不依赖 data-i18n，需在语言切换后就地重建/刷新
    refreshFxPresetOptions();
    refreshFunctionPanel();
    refreshTimelineTree();
    drawTimelineLayers();
    refreshCameraTabs();
  });
  // 主题切换（亮/暗配色）
  applyThemeDom();
  applySceneTheme();
  const updateThemeChecks = () => {
    const cur = getTheme();
    const dark = document.getElementById('theme-check-dark');
    const light = document.getElementById('theme-check-light');
    if (dark) dark.style.visibility = cur === 'dark' ? 'visible' : 'hidden';
    if (light) light.style.visibility = cur === 'light' ? 'visible' : 'hidden';
  };
  updateThemeChecks();
  document.getElementById('menu-theme').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-theme]');
    if (!btn) return;
    closeMenus();
    setTheme(btn.dataset.theme);
    applySceneTheme();
    drawTimeline();
    drawTimelineLayers();
    tlEase.innerHTML = easingCurveSVG(state.defaultEasing);
    updateThemeChecks();
  });
  document.getElementById('btn-new').addEventListener('click', async () => { closeMenus(); await newFile(); refreshCameraTabs(); refreshTimelineTree(); });
  document.getElementById('btn-open').addEventListener('click', () => { closeMenus(); openFile(); });
  document.getElementById('btn-save').addEventListener('click', () => { closeMenus(); saveFile(); });
  document.getElementById('btn-saveas').addEventListener('click', () => { closeMenus(); saveFileAs(); });
  document.getElementById('btn-export').addEventListener('click', () => { closeMenus(); exportAnimation(); });
  document.getElementById('btn-clear').addEventListener('click', () => { closeMenus(); clearAll(); });
  document.getElementById('btn-undo').addEventListener('click', () => { closeMenus(); undo(); });
  document.getElementById('btn-redo').addEventListener('click', () => { closeMenus(); redo(); });
  document.getElementById('btn-selall').addEventListener('click', () => { closeMenus(); selectAll(); });
  document.getElementById('btn-delete-selected').addEventListener('click', () => { closeMenus(); deleteSelected(); });
  document.getElementById('btn-group').addEventListener('click', () => { closeMenus(); createGroup(); });

  // 工具
  document.getElementById('tools').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.tool');
    if (!btn) return;
    state.tool = btn.dataset.tool;
    document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b === btn));
    updateGizmo(); // 切换工具时立即刷新 gizmo 显示模式
  });

  // 摄像机选项卡（视口上方）
  const camTabs = document.getElementById('camera-tabs');
  camTabs.addEventListener('click', handleCameraTabClick);
  camTabs.addEventListener('dblclick', handleCameraTabDblClick);
  refreshCameraTabs();

  // 选项卡切换、停靠与分窗由 workspace.js 管理（initWorkspace 在 initUI 之前运行）。

  // 函数对象
  const fxPresetSel = document.getElementById('fx-preset-add');
  refreshFxPresetOptions();
  customSelect(fxPresetSel);
  document.getElementById('btn-fx-preset-add').addEventListener('click', () => {
    if (fxPresetSel.value) createFunctionObject(fxPresetSel.value);
  });
  refreshFunctionPanel();

  // 属性
  document.getElementById('prop-glow').addEventListener('change', (ev) => { pushUndo(); currentSelected().forEach(p => { p.glow = ev.target.checked; }); rebuildPoints(); });
  document.getElementById('prop-life').addEventListener('change', (ev) => {
    const v = parseInt(ev.target.value, 10);
    const life = (isNaN(v) || v < 0) ? -1 : v;
    pushUndo();
    const gname = selectedGroupName();
    const targets = gname
      ? (state.groups[gname] || []).map(id => getParticle(id)).filter(Boolean)
      : currentSelected();
    targets.forEach(p => { if (!isDerivedParticle(p)) p.life = life; });
    refreshAllPanelsLight();
  });
  document.getElementById('prop-light').addEventListener('input', (ev) => { beginContinuous(); document.getElementById('light-val').textContent = ev.target.value; currentSelected().forEach(p => { p.lightLevel = parseInt(ev.target.value); }); rebuildPoints(); });
  document.getElementById('prop-light').addEventListener('change', endContinuous);
  document.getElementById('prop-color').addEventListener('input', (ev) => { beginContinuous(); applyColorFromInputs(); updatePropColorSwatch(); });
  document.getElementById('prop-color').addEventListener('change', (ev) => { endContinuous(); applyColorFromInputs(); updatePropColorSwatch(); });
  document.getElementById('prop-color-btn').addEventListener('click', (ev) => {
    const rgba = hexToRgba(document.getElementById('prop-color').value) || [1, 1, 1, 1];
    const rect = ev.currentTarget.getBoundingClientRect();
    pushUndo();
    openColorPicker({
      x: rect.left, y: rect.top,
      rgba,
      onInput: (out) => {
        document.getElementById('prop-color').value = rgbaToHex(out[0], out[1], out[2], out[3]);
        applyColorFromInputs();
        updatePropColorSwatch();
      },
    });
  });
  bindVec3Inputs(['prop-scale-x', 'prop-scale-y', 'prop-scale-z'], applyScaleFromInputs);
  bindVec3Inputs(['prop-posx', 'prop-posy', 'prop-posz'], applyPositionFromInputs);
  bindVec3Inputs(['prop-spin-x', 'prop-spin-y', 'prop-spin-z'], applySpinFromInputs);
  bindVec3Inputs(['prop-rot-x', 'prop-rot-y', 'prop-rot-z'], applyOrbitFromInputs);
  bindVec3Inputs(['prop-center-x', 'prop-center-y', 'prop-center-z'], applyCenterFromInputs);
  document.getElementById('prop-spin-space').addEventListener('click', () => {
    const fxId = state.selectedFunction;
    const gname = selectedGroupName();
    if (!fxId && !gname) return;
    pushUndo();
    if (fxId) {
      const fx = getFunction(fxId);
      if (fx) fx.spinSpace = fx.spinSpace === 'local' ? 'world' : 'local';
    } else {
      state.groupSpinSpace[gname] = state.groupSpinSpace[gname] === 'world' ? 'local' : 'world';
    }
    rebuildPoints();
    refreshTimelineTree();
  });
  document.getElementById('prop-rot-space').addEventListener('click', () => {
    const fxId = state.selectedFunction;
    const gname = selectedGroupName();
    if (!fxId && !gname) return;
    pushUndo();
    if (fxId) {
      const fx = getFunction(fxId);
      if (fx) fx.rotSpace = fx.rotSpace === 'local' ? 'world' : 'local';
    } else {
      state.groupRotSpace[gname] = state.groupRotSpace[gname] === 'world' ? 'local' : 'world';
    }
    rebuildPoints();
    refreshTimelineTree();
  });

  // 时间轴
  document.getElementById('btn-play').addEventListener('click', togglePlay);
  document.getElementById('tl-speed').addEventListener('change', (ev) => { state.playSpeed = Math.max(0.1, parseFloat(ev.target.value) || 1); });
  document.getElementById('tl-time').addEventListener('input', (ev) => { state.time = (parseFloat(ev.target.value) || 0) * 1000; state.scrubbing = true; applyTimeChange(); drawTimelineLayers(); });
  document.getElementById('tl-time').addEventListener('change', () => { state.scrubbing = false; });
  document.getElementById('tl-loop').addEventListener('change', (ev) => { state.loop = ev.target.checked; updateLoopIndicator(); });
  tlInitLayerEvents();
  initTimelineTree();

  // 文件导入
  document.getElementById('file-import').addEventListener('change', (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    state.fileHandle = null;
    loadFile(f);
    ev.target.value = '';
  });

  // 时间轴点击/拖动
  const tlCanvas = document.getElementById('timeline');
  let tlDrag = null; // { mode: 'scrub' | 'pan', lastX }
  tlCanvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 && ev.button !== 1) return;
    // 拖动时间轴时，之前聚焦的输入框应取消焦点而非保持/重新聚焦
    if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) {
      document.activeElement.blur();
    }
    ev.preventDefault();
    tlCanvas.setPointerCapture(ev.pointerId);
    if (ev.button === 1) { // 中键：平移视图
      tlDrag = { mode: 'pan', lastX: ev.clientX };
    } else {
      tlDrag = { mode: 'scrub', lastX: ev.clientX };
      state.scrubbing = true;
      if (state.playing) { state.playing = false; syncPlayButton(); }
      state.time = Math.max(0, timelineXToMs(ev.clientX));
      applyTimeChange();
    }
  });
  tlCanvas.addEventListener('pointermove', (ev) => {
    if (!tlDrag) return;
    if (tlDrag.mode === 'pan') {
      setTimelineViewStart(Math.max(0, timelineViewStart - (ev.clientX - tlDrag.lastX) / TL_PX_PER_MS));
    } else {
      // scrub：AE 式滞后自动平移（越界时视图单向外追、游标钉边缘；反向时若指针仍在可视区外则视图不回缩）
      const r = scrubAutoPan(tlDrag, ev.clientX, tlCanvas.getBoundingClientRect(), timelineViewStart, state.time, TL_PX_PER_MS, 0);
      setTimelineViewStart(r.viewStart);
      state.time = r.time;
      updateTimeUI();
    }
    tlDrag.lastX = ev.clientX;
    drawTimeline();
    if (tlDrag.mode === 'scrub') { rebuildPoints(false); syncFunctionVarValues(); }
  });
  tlCanvas.addEventListener('pointerup', () => { tlDrag = null; state.scrubbing = false; });
  tlCanvas.addEventListener('pointerleave', () => { tlDrag = null; state.scrubbing = false; });
  tlCanvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    // 悬停上方标尺滚轮缩放：以指针位置为锚点，放大/缩小每毫秒像素
    const rect = tlCanvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const anchorMs = timelineViewStart + mx / TL_PX_PER_MS;
    const factor = ev.deltaY < 0 ? 1.2 : 1 / 1.2;
    setTLPxPerMs(TL_PX_PER_MS * factor);
    setTimelineViewStart(Math.max(0, anchorMs - mx / TL_PX_PER_MS));
    drawTimeline();
    drawTimelineLayers();
  }, { passive: false });

  updateTimeUI();
  rebuildPoints();
  refreshTimelineTree();
  // 恢复工作区状态（粒子列表宽）
  applyWorkspaceState();
  // 栏宽恢复会改变视口尺寸：立即重设 renderer，避免首帧场景缺块
  resize();
  initTextureEditor();
}

export function clearAll() {
  pushUndo();
  clearObjectState();
  if (tlTreeState && tlTreeState.expanded) tlTreeState.expanded.clear();
  updateTimeUI(); rebuildPoints(); refreshTimelineTree(); refreshFunctionPanel();
  refreshCameraTabs();
}

// 读取三个数值输入框组成的向量；任一框为空/非法时返回 null。
export function readVec3Inputs(ids) {
  const v = ids.map(id => parseFloat(document.getElementById(id).value));
  return v.some(Number.isNaN) ? null : v;
}

// 为三个向量输入框统一绑定 input（连续编辑）与 change（结束连续编辑）。
export function bindVec3Inputs(ids, apply) {
  ids.forEach(id => {
    document.getElementById(id).addEventListener('input', () => { beginContinuous(); apply(); });
    document.getElementById(id).addEventListener('change', endContinuous);
  });
}

export function applyColorFromInputs() {
  const rgba = hexToRgba(document.getElementById('prop-color').value);
  if (!rgba) return;
  editSelectionUniform('col', rgba);
}

export function updatePropColorSwatch() {
  const rgba = hexToRgba(document.getElementById('prop-color').value);
  if (rgba) {
    document.getElementById('prop-color-btn').style.background =
      'linear-gradient(rgba(' + Math.round(rgba[0] * 255) + ',' + Math.round(rgba[1] * 255) + ',' + Math.round(rgba[2] * 255) + ',' + rgba[3] + '), rgba(' +
      Math.round(rgba[0] * 255) + ',' + Math.round(rgba[1] * 255) + ',' + Math.round(rgba[2] * 255) + ',' + rgba[3] + ')), repeating-conic-gradient(#777 0 25%, #bbb 0 50%) 0 0 / 10px 10px';
  }
}

export function applyPositionFromInputs() {
  const v = readVec3Inputs(['prop-posx', 'prop-posy', 'prop-posz']);
  if (v) editSelectionUniform('pos', v);
}

export function applyScaleFromInputs() {
  // 粒子缩放只有 X/Y；函数对象整体缩放才有 Z
  const ids = state.selectedFunction
    ? ['prop-scale-x', 'prop-scale-y', 'prop-scale-z']
    : ['prop-scale-x', 'prop-scale-y'];
  const v = readVec3Inputs(ids);
  if (v) editSelectionUniform('scl', v);
}

export function applySpinFromInputs() {
  const v = readVec3Inputs(['prop-spin-x', 'prop-spin-y', 'prop-spin-z']);
  if (v) editSelectionRotationUniform('spin', v);
}

export function applyOrbitFromInputs() {
  const v = readVec3Inputs(['prop-rot-x', 'prop-rot-y', 'prop-rot-z']);
  if (v) editSelectionRotationUniform('rot', v);
}

export function applyCenterFromInputs() {
  const v = readVec3Inputs(['prop-center-x', 'prop-center-y', 'prop-center-z']);
  if (v) editSelectionRotationUniform('center', v);
}

// 侧边区域宽度 / 底部坞高度调整由 workspace.js 管理。

export function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  updateRenderScale();
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (!document.body.classList.contains('puzzle-mode')) {
    drawTimeline();
  }
}
window.addEventListener('resize', resize);
resize();

export let last = performance.now();
const fpsFrameSamples = []; // 最近帧间隔采样
const COMMON_REFRESH_RATES = [60, 75, 90, 120, 144, 160, 165, 180, 240, 360];

function snapToDisplayRefresh(rawFps, range = 2) {
  const rounded = Math.round(rawFps);
  for (const rate of COMMON_REFRESH_RATES) {
    if (Math.abs(rounded - rate) <= range) return rate;
  }
  return rounded;
}

export function animate(now) {
  const frameMs = now - last;
  const dt = Math.min(frameMs / 1000, 0.1);
  last = now;
  fpsFrameSamples.push(frameMs);
  if (fpsFrameSamples.length > 60) fpsFrameSamples.shift();

  const sorted = [...fpsFrameSamples].sort((a, b) => a - b);
  const middleFrame = Math.max(1, sorted[Math.max(0, Math.floor(sorted.length * 0.5))]);
  let fps = Math.round(1000 / middleFrame);

  const refresh = snapToDisplayRefresh(fps);
  const fpsEl = document.getElementById('fps-counter');
  if (fpsEl) fpsEl.textContent = refresh + 'FPS';

  if (camTransition) {
    const t = Math.min(1, (now - camTransition.t0) / camTransition.dur);
    const e = easeInOut(t);
    const dir = slerp(camTransition.startDir, camTransition.endDir, e);
    camera.position.copy(camTransition.target).addScaledVector(dir, camTransition.dist);
    camera.up.lerpVectors(camTransition.startUp, camTransition.endUp, e).normalize();
    camera.lookAt(camTransition.target);
    if (t >= 1) setCamTransition(null);
    controls.update();
  }

  if (planePulse) {
    const t = (now - planePulse.t0) / planePulse.dur;
    if (t >= 1) {
      restoreAxisColors();
      setPlanePulse(null);
    } else {
      setAxisGlow(planePulse.axes, Math.sin(Math.PI * t) * 0.85);
    }
  }

  if (state.playing) {
    state.time += dt * 1000 * state.playSpeed;
    const mx = maxMs();
    if (state.time >= mx && mx > 0) {
      if (state.loop) { state.time = 0; }
      else { state.time = mx; state.playing = false; syncPlayButton(); }
    }
    updateTimeUI();
    rebuildPointsTime(false);
    syncFunctionVarValues();
  }
  // 仅动画贴图粒子需要每帧随墙钟推进 UV 帧：轻量更新（只改 sx/sy），
  // 避免对数十万粒子每帧完整 rebuildPoints 造成卡顿。
  updateAnimatedUV();
  // 标尺与图层区每帧重绘（播放头推进、粒子增删/拖拽都依赖；canvas 开销可忽略）
  drawTimeline();
  drawTimelineLayers();
  controls.update();
  updateGizmoFrame();
  // 切到某摄像机时：视口相机跟随该摄像机在当前 time 的关键帧姿态（运镜预览）
  if (state.activeCamera && state.activeCamera !== DEFAULT_CAMERA_ID) {
    applyCameraPose(state.activeCamera, state.time);
  }
  pointsMaterial.uniforms.uTime.value = performance.now() / 1000;
  // 摄像机可视化：每帧按当前 time 求姿态并更新线框（位置/朝向/视锥张角/高亮）
  updateCameraWidgets(state.time);
  renderer.render(scene, camera);
  drawAxisGizmo();
  // 选中粒子/函数对象/组变化时，贴图编辑器自动切换到其贴图（内部按目标签名去重）
  syncTextureSelection();
  // UV 动画预览：贴图 tab 激活且当前为动画模式时，逐帧刷新 overlay 让 UV 预览框跟随动画帧移动
  if (texAnimOverlayActive()) {
    updateTexOverlay();
  }

  // 调度下一帧：渲染器卡顿（帧耗时超阈值）时改用 setTimeout(0) 让出主线程给 DOM 事件，
  // 避免持续满载导致浏览器弹出「网页未响应」、输入/点击等交互被拖垮。
  if (frameMs > 50) {
    setTimeout(() => requestAnimationFrame(animate), 0);
  } else {
    requestAnimationFrame(animate);
  }
}

initWorkspace();
initUI();
initTitleBar();
updateTopbarTitle();
if (!state.hasProject) showWelcome();
requestAnimationFrame(animate);

// 关闭页面前若未保存则提示
window.addEventListener('beforeunload', (ev) => {
  if (state.dirty) {
    ev.preventDefault();
    ev.preventDefault();
  }
});

// Tauri 桌面端原生关窗不触发 beforeunload，交给桥接层做同样的未保存拦截。
import('./io/tauri-bridge.js').then(m => m.installCloseGuard()).catch(() => {});

// 拖拽文件到窗口即可打开
(function setupDragDrop() {
  window.addEventListener('dragover', (ev) => { ev.preventDefault(); });
  window.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (!file) return;
    if ((await confirmDiscardChanges(t('common.open'))) === 'cancel') return;
    state.fileHandle = null;
    loadFile(file);
  });
})();
