// 欢迎面板：未打开项目时全屏覆盖，展示各函数对象预设的实时渲染预览，
// 点击预设或空白/打开项目后进入编辑界面。预览图按预设真实求值第一帧后
// 离屏渲染成 PNG（内存缓存，不落盘、不写本地存储）。

import * as THREE from 'three';
import { t } from '../core/i18n.js';
import { state, FUNCTION_PRESETS, PRESET_PREVIEW_OVERRIDES, PARTICLE_SIZE_FACTOR } from '../core/constants.js';
import { LANGS } from '../core/langs.js';
import { cssVar } from '../core/theme.js';
import { pointsMaterial, makeParticleQuadGeometry, camera, controls } from '../scene/scene.js';
import { applyPreset, evaluateFxFrame } from '../core/generators.js';
import { invalidateMaxMsCache } from '../core/animation.js';
import { confirmDiscardChanges, createBlankProject, createProjectFromPreset, openFile, loadFile } from '../io/io.js';
import { modalPrompt } from './ui.js';

const PREVIEW_SIZE = 256;

const previewCache = new Map();
let welcomeEl = null;

function themeHex(name, fallback) {
  const c = cssVar(name, fallback).replace('#', '');
  return parseInt(c, 16);
}

// 与主场景地面网格同款：跳过 x=0 / z=0 中心线，颜色跟随主题。
function makePreviewGrid() {
  const half = 500, step = 1;
  const pts = [];
  for (let i = -half; i <= half; i++) {
    const v = i * step;
    if (Math.abs(v) < 1e-6) continue;
    pts.push(-half, 0, v, half, 0, v);
    pts.push(v, 0, -half, v, 0, half);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({ color: themeHex('--grid-color', '#2c3342'), transparent: true, opacity: 0.9 });
  return new THREE.LineSegments(geo, mat);
}

let offRenderer = null, offScene = null, offCamera = null, offMaterial = null;
function ensureOffscreen() {
  if (offRenderer) return;
  offRenderer = new THREE.WebGLRenderer({
    canvas: document.createElement('canvas'),
    preserveDrawingBuffer: true,
    antialias: true,
  });
  offRenderer.setClearColor(themeHex('--stage-clear', '#14161c'), 1);
  offScene = new THREE.Scene();
  offScene.add(makePreviewGrid());
  offCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  offMaterial = pointsMaterial.clone(); // 预设无贴图，纯色分支即可；复用一个材质避免每张图 clone/dispose
}

function setZeroUV(geo, n) {
  geo.setAttribute('aUV', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
  geo.setAttribute('aUVScale', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
  geo.setAttribute('aUVAnim', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
  geo.setAttribute('aUVTex', new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2));
  geo.setAttribute('aUVMode', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
}

// 把粒子缓冲画成一张离屏 PNG（256×256）。fx.center 仅作平移，默认 [0,0,0]。
function renderParticlesToImage(parts, fx, pos, fov) {
  ensureOffscreen();
  const n = parts.length;
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 4);
  const sizes = new Float32Array(n * 2);
  const SZF = PARTICLE_SIZE_FACTOR;
  for (let i = 0; i < n; i++) {
    const p = parts[i];
    positions[i * 3] = p.pos[0] + fx.center[0];
    positions[i * 3 + 1] = p.pos[1] + fx.center[1];
    positions[i * 3 + 2] = p.pos[2] + fx.center[2];
    colors[i * 4] = p.color[0]; colors[i * 4 + 1] = p.color[1]; colors[i * 4 + 2] = p.color[2]; colors[i * 4 + 3] = p.color[3];
    let sx = p.scale[0] * SZF, sy = p.scale[1] * SZF;
    if (sx < 0.02) sx = 0.02;
    if (sy < 0.02) sy = 0.02;
    sizes[i * 2] = sx; sizes[i * 2 + 1] = sy;
  }

  const geo = makeParticleQuadGeometry();
  geo.setAttribute('aPosition', new THREE.InstancedBufferAttribute(positions, 3));
  geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 4));
  geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizes, 2));
  setZeroUV(geo, n);

  const mesh = new THREE.InstancedMesh(geo, offMaterial, n);
  mesh.frustumCulled = false;
  offScene.add(mesh);

  offCamera.fov = fov;
  offCamera.aspect = 1;
  offCamera.position.set(pos[0], pos[1], pos[2]);
  offCamera.up.set(0, 1, 0);
  offCamera.lookAt(0, 0, 0);
  offCamera.updateProjectionMatrix();
  offRenderer.setSize(PREVIEW_SIZE, PREVIEW_SIZE);
  offRenderer.render(offScene, offCamera);
  const url = offRenderer.domElement.toDataURL('image/png');

  offScene.remove(mesh);
  geo.dispose();
  return url;
}

function renderBlankPreview() {
  const c = document.createElement('canvas');
  c.width = c.height = PREVIEW_SIZE;
  const ctx = c.getContext('2d');
  ctx.fillStyle = cssVar('--stage-clear', '#14161c');
  ctx.fillRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
  ctx.fillStyle = cssVar('--muted', '#8e98ac');
  ctx.font = '600 20px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(t('fx.preset.blank'), PREVIEW_SIZE / 2, PREVIEW_SIZE / 2);
  return c.toDataURL('image/png');
}

// 渲染单个预设的第一帧预览；空白预设返回纯背景占位图。
// 求值期间临时隔离 state.particles/functions，结束后还原，不污染主工程。
function renderPresetPreview(presetId) {
  if (presetId === 'blank') return renderBlankPreview();
  const ov = PRESET_PREVIEW_OVERRIDES[presetId] || {};
  const pos = Array.isArray(ov.pos) && ov.pos.length === 3 ? ov.pos : [10, 10, 10];
  const fov = Number.isFinite(ov.fov) ? ov.fov : 50;
  const frame = Number.isFinite(ov.frame) ? ov.frame : 0;

  const savedParticles = state.particles;
  const savedFunctions = state.functions;
  state.particles = [];
  state.functions = [];
  let url = null;
  try {
    const fx = {
      id: '__welcome_' + presetId,
      name: t('fx.preset.' + presetId),
      center: [0, 0, 0],
      source: '',
      seed: 0,
      vars: {},
      duration: 5000,
      preset: null,
      params: null,
      fastMath: false,
      frameSync: false,
      spinSpace: 'local',
      rotSpace: 'local',
    };
    state.functions.push(fx);
    applyPreset(fx, presetId);
    try { evaluateFxFrame(fx, frame); } catch (e) { /* 脚本错误：只渲染空场景 */ }
    url = renderParticlesToImage(state.particles, fx, pos, fov);
  } catch (e) {
    url = null;
  } finally {
    state.particles = savedParticles;
    state.functions = savedFunctions;
    invalidateMaxMsCache();
  }
  return url || renderBlankPreview();
}

// 预设英文名 → 全小写下划线项目名（与 my_animation 风格一致）。
function autoProjectName(id) {
  const en = (LANGS.en && LANGS.en['fx.preset.' + id]) || id;
  const slug = en.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || id;
}

function resetMainCamera() {
  camera.position.set(10, 10, 10);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);
  controls.target.set(0, 0, 0);
  controls.update();
}

export function welcomeOpen() { return !!welcomeEl && welcomeEl.isConnected; }

function hideWelcome() {
  if (welcomeEl) {
    welcomeEl.remove();
    welcomeEl = null;
  }
}

async function finishCreate() {
  resetMainCamera();
  hideWelcome();
  try {
    const { refreshTimelineTree } = await import('./timeline-tree.js');
    if (typeof refreshTimelineTree === 'function') refreshTimelineTree();
  } catch (_) { /* 动态加载失败不影响创建流程 */ }
  try {
    const { refreshCameraTabs } = await import('../main.js');
    if (typeof refreshCameraTabs === 'function') refreshCameraTabs();
  } catch (_) { /* 动态加载失败不影响创建流程 */ }
}

async function onPresetClick(id) {
  const r = await confirmDiscardChanges(t('common.new'));
  if (r === 'cancel') return;
  if (id === 'blank') {
    const name = await modalPrompt(t('newProject.title'), 'my_animation', t('newProject.name'));
    if (!name || !name.trim()) return;
    await createBlankProject(name);
  } else {
    const name = await modalPrompt(t('welcome.createTitle'), autoProjectName(id), t('newProject.name'));
    if (!name || !name.trim()) return;
    await createProjectFromPreset(id, name);
  }
  await finishCreate();
}

async function startPreviewCompute(cards) {
  for (const id of Object.keys(FUNCTION_PRESETS)) {
    if (!welcomeEl) return;
    let url = previewCache.get(id);
    if (!url) {
      url = renderPresetPreview(id);
      previewCache.set(id, url);
    }
    if (cards[id] && cards[id].isConnected) cards[id].style.backgroundImage = 'url(' + url + ')';
    await new Promise(r => setTimeout(r, 0));
  }
}

export function showWelcome() {
  if (welcomeEl && welcomeEl.isConnected) return;
  welcomeEl = document.createElement('div');
  welcomeEl.className = 'welcome-overlay';

  const header = document.createElement('div');
  header.className = 'welcome-header';
  const titleBox = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'welcome-title';
  title.textContent = t('welcome.title');
  const subtitle = document.createElement('div');
  subtitle.className = 'welcome-subtitle';
  subtitle.textContent = t('welcome.subtitle');
  titleBox.appendChild(title);
  titleBox.appendChild(subtitle);
  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'ui-modal-btn primary';
  openBtn.textContent = t('welcome.open');
  openBtn.addEventListener('click', async () => {
    await openFile();
    if (state.hasProject) await finishCreate();
  });
  header.appendChild(titleBox);
  header.appendChild(openBtn);
  welcomeEl.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'welcome-grid';
  const cards = {};
  for (const id of Object.keys(FUNCTION_PRESETS)) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'welcome-card';
    const preview = document.createElement('div');
    preview.className = 'welcome-card-preview';
    preview.setAttribute('role', 'img');
    preview.setAttribute('aria-label', t('fx.preset.' + id));
    const name = document.createElement('div');
    name.className = 'welcome-card-name';
    name.textContent = t('fx.preset.' + id);
    card.appendChild(preview);
    card.appendChild(name);
    card.addEventListener('click', () => onPresetClick(id));
    grid.appendChild(card);
    cards[id] = preview;
  }
  welcomeEl.appendChild(grid);
  document.body.appendChild(welcomeEl);
  startPreviewCompute(cards);
}

// 欢迎面板打开时：屏蔽全局快捷键与文件拖放，避免绕过模态进入编辑态。
// 上层 ui-modal（项目命名/未保存确认）打开时不拦截，保证其 Esc/Enter 正常。
window.addEventListener('keydown', (ev) => {
  if (!welcomeOpen()) return;
  if (document.querySelector('.ui-modal-overlay')) return;
  ev.stopPropagation();
}, true);

window.addEventListener('dragover', (ev) => {
  if (welcomeOpen()) ev.preventDefault();
}, true);

window.addEventListener('drop', async (ev) => {
  if (!welcomeOpen()) return;
  ev.preventDefault();
  ev.stopPropagation();
  const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
  if (!file) return;
  if ((await confirmDiscardChanges(t('common.open'))) === 'cancel') return;
  state.fileHandle = null;
  try { await loadFile(file); } catch (e) { /* 无效文件：留在欢迎面板 */ }
  if (state.hasProject) await finishCreate();
}, true);

// 欢迎面板打开时接管隐藏的文件选择框：无 File System Access 的路径由
// openFile 点击该 input 后走这里，避免等不到 main.js 的 change 监听而卡在欢迎页。
const fileInput = document.getElementById('file-import');
if (fileInput) {
  fileInput.addEventListener('change', async (ev) => {
    if (!welcomeOpen()) return;
    ev.stopImmediatePropagation();
    const f = ev.target.files[0];
    if (!f) return;
    state.fileHandle = null;
    try { await loadFile(f); } catch (e) { /* 无效文件：留在欢迎面板 */ }
    if (state.hasProject) await finishCreate();
    ev.target.value = '';
  }, true);
}
