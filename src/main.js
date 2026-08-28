/* =========================================================================
 * UI 初始化与主循环
 * 职责：绑定菜单 / 工具栏 / 属性面板 / 时间轴事件，初始化应用并运行渲染主循环，
 *       处理工作区拖拽缩放、文件拖放打开、页面关闭前的未保存提示。
 * 依赖：本文件最后加载，可直接调用前面所有脚本定义的全局函数。
 * ======================================================================= */

import { t, applyI18nDom, setLanguage } from './core/i18n.js';
import { state, FUNCTION_PRESETS, getParticle, isDerivedParticle, updateTopbarTitle } from './core/constants.js';
import { setShiftHeld, getDragIds, setDragIds } from './interaction/input-state.js';
import { showAboutModal } from './ui/ui.js';
import { easeInOut } from './core/easing.js';
import { openEasingEditor, easingCurveSVG } from './ui/easing-editor.js';
import { viewport, renderer, camera, controls, scene, pointsMaterial, selectedMaterial, focalLengthPx, camTransition, setCamTransition, planePulse, setPlanePulse, updateRenderScale } from './scene/scene.js';
import { rebuildPoints, rebuildPointsTime, maxTick, resetVelOffsets, updateAnimatedUV } from './core/animation.js';
import { editSelectionUniform, addParticle, removeParticlesFromGroups } from './core/edit.js';
import { pushUndo, undo, redo, beginContinuous, endContinuous } from './state/undo.js';
import { currentSelected, selectedGroupName, deleteSelected, selectAll } from './interaction/interaction.js';
import { refreshParticleTree, createGroup, showContextMenu, refreshCompTimelines } from './ui/tree.js';
import { createFunctionObject } from './core/generators.js';
import { syncFunctionVarValues, drawTimeline, updateLoopIndicator, hexToRgb, TL_PX_PER_TICK, setTLPxPerTick, timelineViewStart, setTimelineViewStart, scrubAutoPan, timelineXToTick, refreshFunctionPanel } from './ui/panels.js';
import { drawTimelineLayers, tlInitLayerEvents, refreshAllPanelsLight } from './ui/timeline-layers.js';
import { initTimelineTree, refreshTimelineTree, tlTreeState } from './ui/timeline-tree.js';
import { initTextureEditor, syncTextureSelection, updateTexOverlay, texAnimOverlayActive, refreshTexturePanel } from './ui/texture-editor.js';
import { applyWorkspaceState, saveWorkspaceState } from './ui/blocks-ui.js';
import { initImportMenu } from './ui/import-image.js';
import { newFile, openFile, saveFile, saveFileAs, exportAnimation, loadFile, confirmDiscardChanges, ensureProjectKey } from './io/io.js';
import { drawAxisGizmo, slerp } from './interaction/axis-gizmo.js';
import { updateGizmo, updateGizmoFrame, restoreAxisColors, setAxisGlow } from './interaction/gizmo.js';

// 时间轴数值变化后的统一刷新：粒子状态、时间 UI、函数变量插值显示。
// 多处 scrub / 播放头拖动路径共用，避免漏刷某一项。
export function applyTimeChange() {
  resetVelOffsets();
  updateTimeUI();
  rebuildPoints();
  syncFunctionVarValues();
}

export function updateTimeUI() {
  document.getElementById('tl-time').value = Math.round(state.time);
  document.getElementById('tl-max').textContent = maxTick();
}

export function syncPlayButton() {
  document.getElementById('btn-play').textContent = state.playing ? t('timeline.pause') : t('timeline.play');
}

export function togglePlay() {
  state.playing = !state.playing;
  syncPlayButton();
  resetVelOffsets();
}

window.addEventListener('keydown', (e) => { if (e.key === 'Shift') setShiftHeld(true); });
window.addEventListener('keyup', (e) => { if (e.key === 'Shift') setShiftHeld(false); });
window.addEventListener('keydown', (e) => { if (e.key === 'Control') document.body.classList.add('ctrl-held'); });
window.addEventListener('keyup', (e) => { if (e.key === 'Control') document.body.classList.remove('ctrl-held'); });

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
}

export function initUI() {
  applyI18nDom();
  ensureProjectKey(); // 启动即确保密钥存在：未点「新建」直接编辑保存也能带私钥
  initImportMenu();
  syncPlayButton();
  const tlEase = document.getElementById('tl-easing');
  tlEase.innerHTML = easingCurveSVG(state.defaultEasing);
  tlEase.onclick = () => openEasingEditor(state.defaultEasing, (e) => {
    state.defaultEasing = e;
    tlEase.innerHTML = easingCurveSVG(e);
  }, tlEase);

  // 菜单（悬停展开）
  document.querySelectorAll('.menu').forEach(menu => {
    menu.addEventListener('mouseenter', () => {
      document.querySelectorAll('.menu').forEach(m => m.classList.remove('open'));
      menu.classList.add('open');
    });
    menu.addEventListener('mouseleave', () => menu.classList.remove('open'));
  });
  const closeMenus = () => document.querySelectorAll('.menu').forEach(m => m.classList.remove('open'));
  document.getElementById('btn-about').addEventListener('click', () => { closeMenus(); showAboutModal(); });
  // 语言切换
  document.getElementById('menu-lang').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-lang]');
    if (!btn) return;
    closeMenus();
    setLanguage(btn.dataset.lang);
  });
  document.getElementById('btn-new').addEventListener('click', () => { closeMenus(); newFile(); });
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

  // 右侧选项卡切换
  document.getElementById('sidebar-tabs').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.tab');
    if (!btn) return;
    document.querySelectorAll('#sidebar-tabs .tab').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + btn.dataset.tab));
    if (btn.dataset.tab === 'texture') refreshTexturePanel();
  });

  // 函数对象
  const fxPresetSel = document.getElementById('fx-preset-add');
  refreshFxPresetOptions();
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
    const gname = (typeof selectedGroupName === 'function') ? selectedGroupName() : null;
    const targets = gname
      ? (state.groups[gname] || []).map(id => getParticle(id)).filter(Boolean)
      : currentSelected();
    targets.forEach(p => { if (!isDerivedParticle(p)) p.life = life; });
    if (typeof refreshAllPanelsLight === 'function') refreshAllPanelsLight(); else rebuildPoints();
  });
  document.getElementById('prop-light').addEventListener('input', (ev) => { beginContinuous(); document.getElementById('light-val').textContent = ev.target.value; currentSelected().forEach(p => { p.lightLevel = parseInt(ev.target.value); }); rebuildPoints(); });
  document.getElementById('prop-light').addEventListener('change', endContinuous);
  document.getElementById('prop-alpha').addEventListener('input', (ev) => { beginContinuous(); document.getElementById('alpha-val').textContent = parseFloat(ev.target.value).toFixed(2); applyColorFromInputs(); });
  document.getElementById('prop-alpha').addEventListener('change', endContinuous);
  document.getElementById('prop-color').addEventListener('input', (ev) => { beginContinuous(); applyColorFromInputs(); });
  document.getElementById('prop-color').addEventListener('change', endContinuous);
  bindVec3Inputs(['prop-scale-x', 'prop-scale-y', 'prop-scale-z'], applyScaleFromInputs);
  bindVec3Inputs(['prop-posx', 'prop-posy', 'prop-posz'], applyPositionFromInputs);

  // 时间轴
  document.getElementById('btn-play').addEventListener('click', togglePlay);
  document.getElementById('tl-speed').addEventListener('change', (ev) => { state.playSpeed = Math.max(0.1, parseFloat(ev.target.value) || 1); });
  document.getElementById('tl-time').addEventListener('input', (ev) => { state.time = parseFloat(ev.target.value) || 0; state.scrubbing = true; applyTimeChange(); if (typeof drawTimelineLayers === 'function') drawTimelineLayers(); });
  document.getElementById('tl-time').addEventListener('change', () => { state.scrubbing = false; });
  document.getElementById('tl-loop').addEventListener('change', (ev) => { state.loop = ev.target.checked; updateLoopIndicator(); });
  if (typeof tlInitLayerEvents === 'function') tlInitLayerEvents();
  if (typeof initTimelineTree === 'function') initTimelineTree();

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
    ev.preventDefault();
    tlCanvas.setPointerCapture(ev.pointerId);
    if (ev.button === 1) { // 中键：平移视图
      tlDrag = { mode: 'pan', lastX: ev.clientX };
    } else {
      tlDrag = { mode: 'scrub', lastX: ev.clientX };
      state.scrubbing = true;
      state.time = Math.max(0, timelineXToTick(ev.clientX));
      applyTimeChange();
    }
  });
  tlCanvas.addEventListener('pointermove', (ev) => {
    if (!tlDrag) return;
    if (tlDrag.mode === 'pan') {
      setTimelineViewStart(Math.max(0, timelineViewStart - (ev.clientX - tlDrag.lastX) / TL_PX_PER_TICK));
    } else {
      // scrub：AE 式滞后自动平移（越界时视图单向外追、游标钉边缘；反向时若指针仍在可视区外则视图不回缩）
      const r = scrubAutoPan(tlDrag, ev.clientX, tlCanvas.getBoundingClientRect(), timelineViewStart, state.time, TL_PX_PER_TICK, 0);
      setTimelineViewStart(r.viewStart);
      state.time = r.time;
      updateTimeUI();
    }
    tlDrag.lastX = ev.clientX;
    drawTimeline();
    if (tlDrag.mode === 'scrub') { rebuildPoints(); syncFunctionVarValues(); }
  });
  tlCanvas.addEventListener('pointerup', () => { tlDrag = null; state.scrubbing = false; });
  tlCanvas.addEventListener('pointerleave', () => { tlDrag = null; state.scrubbing = false; });
  tlCanvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    // 悬停上方标尺滚轮缩放：以指针位置为锚点，放大/缩小每 tick 像素
    const rect = tlCanvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const anchorTick = timelineViewStart + mx / TL_PX_PER_TICK;
    const factor = ev.deltaY < 0 ? 1.2 : 1 / 1.2;
    setTLPxPerTick(TL_PX_PER_TICK * factor);
    setTimelineViewStart(Math.max(0, anchorTick - mx / TL_PX_PER_TICK));
    drawTimeline();
    if (typeof drawTimelineLayers === 'function') drawTimelineLayers();
  }, { passive: false });

  rebuildPoints();
  refreshParticleTree();
  if (typeof refreshTimelineTree === 'function') refreshTimelineTree();
  // 恢复工作区状态（粒子列表宽）
  if (typeof applyWorkspaceState === 'function') applyWorkspaceState();
  // 栏宽恢复会改变视口尺寸：立即重设 renderer，避免首帧场景缺块
  resize();
  if (typeof initTextureEditor === 'function') initTextureEditor();
}

export function clearAll() {
  pushUndo();
  state.particles = []; state.tracks = []; state.groups = {}; state.functions = [];
  state.textures = {}; state.currentTexture = null; state.groupUV = {};
  state.selected.clear(); state.selectedGroup = null; state.selectedFunction = null;
  state.expandedParticles.clear(); state.expandedProps.clear();
  if (tlTreeState && tlTreeState.expanded) tlTreeState.expanded.clear();
  state.time = 0;
  updateTimeUI(); rebuildPoints(); refreshParticleTree(); refreshTimelineTree(); refreshFunctionPanel();
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
  const rgb = hexToRgb(document.getElementById('prop-color').value);
  const a = parseFloat(document.getElementById('prop-alpha').value);
  editSelectionUniform('col', [rgb[0], rgb[1], rgb[2], a]);
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

/* 右侧栏拖拽调整大小（左侧粒子列表已移除，仅保留时间轴粒子列表） */
(function setupPanelResizeAndDrop() {
  const handleR = document.getElementById('resize-handle-r');
  if (!handleR) return;
  let resizingR = false;
  handleR.addEventListener('pointerdown', (e) => {
    resizingR = true;
    handleR.classList.add('dragging');
    handleR.setPointerCapture(e.pointerId);
  });
  handleR.addEventListener('pointermove', (e) => {
    if (!resizingR) return;
    const layout = document.querySelector('.layout');
    const rect = layout.getBoundingClientRect();
    let w = rect.right - e.clientX;
    w = Math.max(240, Math.min(640, w));
    layout.style.setProperty('--right-w', w + 'px');
    resize();
  });
  handleR.addEventListener('pointerup', () => { resizingR = false; handleR.classList.remove('dragging'); if (typeof saveWorkspaceState === 'function') saveWorkspaceState(); });
})();

export function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  updateRenderScale();
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  pointsMaterial.uniforms.uPixelScale.value = focalLengthPx();
  selectedMaterial.uniforms.uPixelScale.value = focalLengthPx();
  if (!document.body.classList.contains('puzzle-mode')) {
    drawTimeline();
    if (typeof refreshCompTimelines === 'function') refreshCompTimelines();
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
  requestAnimationFrame(animate);
  const frameMs = now - last;
  const dt = Math.min(frameMs / 1000, 0.1);
  last = now;
  fpsFrameSamples.push(frameMs);
  if (fpsFrameSamples.length > 60) fpsFrameSamples.shift();

  const sorted = [...fpsFrameSamples].sort((a, b) => a - b);
  const middleFrame = Math.max(1, sorted[Math.max(0, Math.floor(sorted.length * 0.5))]);
  let fps = Math.round(1000 / middleFrame);

  const fpsEl = document.getElementById('fps-counter');
  if (fpsEl) fpsEl.textContent = snapToDisplayRefresh(fps) + 'FPS';

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
    state.time += dt * 20 * state.playSpeed;
    const mx = maxTick();
    if (state.time >= mx && mx > 0) {
      if (state.loop) { state.time = 0; resetVelOffsets(); }
      else { state.time = mx; state.playing = false; syncPlayButton(); resetVelOffsets(); }
    }
    updateTimeUI();
    rebuildPointsTime(false);
    syncFunctionVarValues();
  }
  // 仅动画贴图粒子需要每帧随墙钟推进 UV 帧：轻量更新（只改 sx/sy），
  // 避免对数十万粒子每帧完整 rebuildPoints 造成卡顿。
  if (typeof updateAnimatedUV === 'function') updateAnimatedUV();
  // 标尺与图层区每帧重绘（播放头推进、粒子增删/拖拽都依赖；canvas 开销可忽略）
  drawTimeline();
  if (typeof drawTimelineLayers === 'function') drawTimelineLayers();
  controls.update();
  updateGizmoFrame();
  pointsMaterial.uniforms.uTime.value = performance.now() / 1000;
  renderer.render(scene, camera);
  drawAxisGizmo();
  // 选中粒子/函数对象/组变化时，贴图编辑器自动切换到其贴图（内部按目标签名去重）
  if (typeof syncTextureSelection === 'function') syncTextureSelection();
  // UV 动画预览：贴图 tab 激活且当前为动画模式时，逐帧刷新 overlay 让 UV 预览框跟随动画帧移动
  if (typeof texAnimOverlayActive === 'function' && texAnimOverlayActive()) {
    if (typeof updateTexOverlay === 'function') updateTexOverlay();
  }
}

initUI();
updateTopbarTitle();
requestAnimationFrame(animate);

// 关闭页面前若未保存则提示
window.addEventListener('beforeunload', (ev) => {
  if (state.dirty) {
    ev.preventDefault();
    ev.returnValue = '';
  }
});

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
