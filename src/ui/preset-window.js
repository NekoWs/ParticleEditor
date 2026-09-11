// 预设修改窗口：左侧为函数对象应用预设后的实时 3D 预览（独立渲染器 + OrbitControls，
// 左键旋转 / 右键平移 / 滚轮缩放，不使用主场景工具），右侧为参数表单（基础参数在上，
// 高级参数在「更多参数」折叠区内）。预览在隔离的 state.particles/functions 中求值，
// 不污染主工程；点「应用」把生成代码写入函数对象源码并重建。

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { t } from '../core/i18n.js';
import { state, getFunction, PARTICLE_SIZE_FACTOR } from '../core/constants.js';
import { pointsMaterial, makeParticleQuadGeometry } from '../scene/scene.js';
import { evaluateFxFrame, rebuildFunctionObject } from '../core/generators.js';
import { invalidateMaxMsCache } from '../core/animation.js';
import { cssVar } from '../core/theme.js';
import { rgbaToHex, hexToRgba } from './ui.js';
import { openColorPicker, closeColorPicker, colorPickerOpen } from './color-picker.js';
import { customSelect, refreshCustomSelect } from './select.js';
import { pushUndo } from '../state/undo.js';
import { refreshFunctionPanel } from './panels.js';
import { localizeScriptError } from '../core/script-error-i18n.js';
import { buildPresetCode, applyPresetToSource, defaultPresetValues, getPreset } from '../core/presets.js';

const SZF = PARTICLE_SIZE_FACTOR;
let current = null; // 单例窗口

function themeHex(name, fallback) {
  const c = cssVar(name, fallback).replace('#', '');
  return parseInt(c, 16);
}

function cloneFx(fx, source) {
  return {
    id: fx.id,
    name: fx.name,
    center: (fx.center || [0, 0, 0]).slice(),
    source,
    seed: fx.seed | 0,
    vars: JSON.parse(JSON.stringify(fx.vars || {})),
    duration: fx.duration || 0,
    st: fx.st || 0,
    ent: fx.ent,
    fastMath: !!fx.fastMath,
    frameSync: !!fx.frameSync,
    spinSpace: fx.spinSpace,
    rotSpace: fx.rotSpace,
    preset: fx.preset,
    params: fx.params,
  };
}

// 在隔离的 particles/functions 中求值，返回 { parts, error }；结束后还原全局数组。
function evalIsolated(fx, source, T) {
  const clone = cloneFx(fx, source);
  const savedParticles = state.particles;
  const savedFunctions = state.functions;
  state.particles = [];
  state.functions = [clone];
  let parts = [];
  let error = null;
  try {
    evaluateFxFrame(clone, T);
    parts = state.particles.slice();
    error = clone._error || null;
  } catch (e) {
    error = e && e.message ? e.message : String(e);
  } finally {
    state.particles = savedParticles;
    state.functions = savedFunctions;
    invalidateMaxMsCache();
  }
  return { parts, error };
}

// 预览时刻：夹到对象入场时间与时长内。
function previewTick(fx) {
  const st = fx.st || 0;
  const dur = fx.duration || 0;
  let T = state.time;
  if (T < st) T = st;
  if (dur > 0 && T >= st + dur) T = st + Math.max(0, dur - 1);
  return T;
}

export function presetWindowOpen() { return !!current && current.overlay.isConnected; }

export function closePresetWindow() {
  if (!current) return;
  const w = current;
  current = null;
  window.removeEventListener('keydown', w.onKey, true);
  if (w.resizeObs) w.resizeObs.disconnect();
  if (w.controls) w.controls.dispose();
  closeColorPicker();
  if (w.renderer) {
    try { w.renderer.dispose(); } catch (e) { /* 忽略 */ }
    try { w.renderer.forceContextLoss(); } catch (e) { /* 忽略 */ }
  }
  if (w.mesh) {
    w.scene.remove(w.mesh);
    if (w.geo) w.geo.dispose();
  }
  w.overlay.remove();
}

export function openPresetWindow(fxId, presetId) {
  const fx = getFunction(fxId);
  const preset = getPreset(presetId);
  if (!fx || !preset) return;
  closePresetWindow();

  const values = defaultPresetValues(preset);
  const overlay = document.createElement('div');
  overlay.className = 'ui-modal-overlay preset-overlay';

  const box = document.createElement('div');
  box.className = 'ui-modal preset-modal';

  // —— 标题 ——
  const title = document.createElement('div');
  title.className = 'ui-modal-title';
  title.textContent = t('preset.' + preset.id) + ' — ' + fx.name;
  box.appendChild(title);

  // —— 主体：左预览 / 右参数 ——
  const body = document.createElement('div');
  body.className = 'preset-body';

  const previewBox = document.createElement('div');
  previewBox.className = 'preset-preview';
  const canvas = document.createElement('canvas');
  previewBox.appendChild(canvas);
  const errHint = document.createElement('div');
  errHint.className = 'preset-preview-error';
  errHint.hidden = true;
  previewBox.appendChild(errHint);
  const hint = document.createElement('div');
  hint.className = 'preset-preview-hint';
  hint.textContent = t('preset.win.preview');
  previewBox.appendChild(hint);
  body.appendChild(previewBox);

  // —— 参数区 ——
  const paramsBox = document.createElement('div');
  paramsBox.className = 'preset-params';

  const targetRow = document.createElement('div');
  targetRow.className = 'preset-param-row preset-target-row';
  const targetLabel = document.createElement('span');
  targetLabel.className = 'preset-param-label';
  targetLabel.textContent = t('preset.win.target');
  const targetName = document.createElement('span');
  targetName.className = 'preset-target-name';
  targetName.textContent = fx.name;
  targetRow.appendChild(targetLabel);
  targetRow.appendChild(targetName);
  paramsBox.appendChild(targetRow);

  const simpleParams = preset.params.filter((p) => !p.advanced);
  const advancedParams = preset.params.filter((p) => p.advanced);
  const inputs = {};

  const mkField = (param) => {
    const row = document.createElement('div');
    row.className = 'preset-param-row';
    const lab = document.createElement('span');
    lab.className = 'preset-param-label';
    lab.textContent = t('preset.param.' + param.key);
    lab.title = lab.textContent;
    row.appendChild(lab);
    const val = values[param.key];

    if (param.type === 'bool') {
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = !!val;
      chk.addEventListener('change', () => { values[param.key] = chk.checked; scheduleRefresh(); });
      inputs[param.key] = chk;
      row.appendChild(chk);
    } else if (param.type === 'enum') {
      const sel = document.createElement('select');
      for (const o of param.options) {
        const opt = document.createElement('option');
        opt.value = o;
        opt.textContent = t('preset.opt.' + o);
        sel.appendChild(opt);
      }
      sel.value = String(val);
      sel.addEventListener('change', () => { values[param.key] = sel.value; scheduleRefresh(); });
      row.appendChild(sel);
      customSelect(sel);
      inputs[param.key] = sel;
      return row;
    } else if (param.type === 'color') {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.maxLength = 9;
      inp.spellcheck = false;
      inp.value = rgbaToHex(val[0], val[1], val[2], val[3]);
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'preset-swatch';
      sw.title = t('blk.colorPicker');
      const paint = () => {
        const rgba = hexToRgba(inp.value);
        if (rgba) {
          sw.style.background = 'linear-gradient(rgba(' +
            Math.round(rgba[0] * 255) + ',' + Math.round(rgba[1] * 255) + ',' + Math.round(rgba[2] * 255) + ',' + rgba[3] + '), rgba(' +
            Math.round(rgba[0] * 255) + ',' + Math.round(rgba[1] * 255) + ',' + Math.round(rgba[2] * 255) + ',' + rgba[3] + ')), ' +
            'repeating-conic-gradient(#777 0 25%, #bbb 0 50%) 0 0 / 10px 10px';
        }
      };
      paint();
      inp.addEventListener('input', () => {
        const rgba = hexToRgba(inp.value);
        if (rgba) { values[param.key] = rgba; paint(); scheduleRefresh(); }
      });
      sw.addEventListener('click', (ev) => {
        const rgba = hexToRgba(inp.value) || val;
        openColorPicker({
          x: ev.clientX, y: ev.clientY,
          rgba,
          onInput: (out) => {
            inp.value = rgbaToHex(out[0], out[1], out[2], out[3]);
            values[param.key] = out;
            paint();
            scheduleRefresh();
          },
        });
      });
      inputs[param.key] = inp;
      row.appendChild(inp);
      row.appendChild(sw);
    } else {
      const inp = document.createElement('input');
      inp.type = 'number';
      if (param.min != null) inp.min = param.min;
      if (param.max != null) inp.max = param.max;
      inp.step = param.step != null ? param.step : 'any';
      inp.value = String(val);
      inp.addEventListener('input', () => {
        const n = parseFloat(inp.value);
        if (Number.isFinite(n)) { values[param.key] = n; scheduleRefresh(); }
      });
      inputs[param.key] = inp;
      row.appendChild(inp);
    }
    return row;
  };

  const basicTitle = document.createElement('div');
  basicTitle.className = 'preset-section-title';
  basicTitle.textContent = t('preset.win.basic');
  paramsBox.appendChild(basicTitle);
  for (const p of simpleParams) paramsBox.appendChild(mkField(p));

  const moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = 'preset-more-toggle';
  moreBtn.textContent = t('preset.win.more') + ' ▸';
  paramsBox.appendChild(moreBtn);

  const advancedBox = document.createElement('div');
  advancedBox.className = 'preset-advanced';
  for (const p of advancedParams) advancedBox.appendChild(mkField(p));
  paramsBox.appendChild(advancedBox);
  moreBtn.addEventListener('click', () => {
    const opening = !advancedBox.classList.contains('open');
    advancedBox.classList.toggle('open', opening);
    moreBtn.textContent = (opening ? t('preset.win.less') : t('preset.win.more')) + (opening ? ' ▾' : ' ▸');
  });
  body.appendChild(paramsBox);
  box.appendChild(body);

  // —— 底部按钮 ——
  const btns = document.createElement('div');
  btns.className = 'ui-modal-btns';
  const resetBtn = document.createElement('button');
  resetBtn.className = 'ui-modal-btn';
  resetBtn.textContent = t('preset.win.reset');
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'ui-modal-btn';
  cancelBtn.textContent = t('common.cancel');
  const applyBtn = document.createElement('button');
  applyBtn.className = 'ui-modal-btn primary';
  applyBtn.textContent = t('preset.win.apply');
  btns.appendChild(resetBtn);
  btns.appendChild(cancelBtn);
  btns.appendChild(applyBtn);
  box.appendChild(btns);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  // —— 预览场景 ——
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(themeHex('--stage-clear', '#14161c'), 1);

  const scene = new THREE.Scene();
  const gridHalf = 500;
  const gridPts = [];
  for (let i = -gridHalf; i <= gridHalf; i++) {
    const v = i;
    if (Math.abs(v) < 1e-6) continue;
    gridPts.push(-gridHalf, 0, v, gridHalf, 0, v);
    gridPts.push(v, 0, -gridHalf, v, 0, gridHalf);
  }
  const gridGeo = new THREE.BufferGeometry();
  gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridPts, 3));
  scene.add(new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: themeHex('--grid-color', '#2c3342'), transparent: true, opacity: 0.9 })));
  const axisDefs = [[new THREE.Vector3(1, 0, 0), 0xff5555], [new THREE.Vector3(0, 1, 0), 0x55ff55], [new THREE.Vector3(0, 0, 1), 0x5588ff]];
  for (const [dir, color] of axisDefs) {
    const g = new THREE.BufferGeometry().setFromPoints([
      dir.clone().multiplyScalar(-gridHalf), dir.clone().multiplyScalar(gridHalf),
    ]);
    scene.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color })));
  }

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 4000);
  const center = new THREE.Vector3().fromArray(fx.center || [0, 0, 0]);
  camera.position.copy(center).add(new THREE.Vector3(10, 10, 10));
  camera.up.set(0, 1, 0);
  camera.lookAt(center);

  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(center);
  controls.screenSpacePanning = true;
  controls.update();

  const mat = pointsMaterial.clone();
  let mesh = null;
  let geo = null;

  function setZeroUV(g, n) {
    g.setAttribute('aUV', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
    g.setAttribute('aUVScale', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
    g.setAttribute('aUVAnim', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
    g.setAttribute('aUVTex', new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2));
    g.setAttribute('aUVMode', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
  }

  function applyParts(parts) {
    const n = parts.length;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 4);
    const sizes = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const p = parts[i];
      positions[i * 3] = p.pos[0] + center.x;
      positions[i * 3 + 1] = p.pos[1] + center.y;
      positions[i * 3 + 2] = p.pos[2] + center.z;
      colors[i * 4] = p.color[0]; colors[i * 4 + 1] = p.color[1]; colors[i * 4 + 2] = p.color[2]; colors[i * 4 + 3] = p.color[3];
      let sx = p.scale[0] * SZF, sy = p.scale[1] * SZF;
      if (sx < 0.02) sx = 0.02;
      if (sy < 0.02) sy = 0.02;
      sizes[i * 2] = sx; sizes[i * 2 + 1] = sy;
    }
    if (mesh && mesh.count === n && geo) {
      geo.attributes.aPosition.array.set(positions);
      geo.attributes.aPosition.needsUpdate = true;
      geo.attributes.aColor.array.set(colors);
      geo.attributes.aColor.needsUpdate = true;
      geo.attributes.aSize.array.set(sizes);
      geo.attributes.aSize.needsUpdate = true;
      return;
    }
    if (mesh) { scene.remove(mesh); geo.dispose(); geo = null; mesh = null; }
    if (n === 0) return;
    geo = makeParticleQuadGeometry();
    geo.setAttribute('aPosition', new THREE.InstancedBufferAttribute(positions, 3));
    geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 4));
    geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizes, 2));
    setZeroUV(geo, n);
    mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.frustumCulled = false;
    scene.add(mesh);
    if (current) { current.mesh = mesh; current.geo = geo; }
  }

  function renderPreview() {
    renderer.render(scene, camera);
  }

  function sizePreview() {
    const w = previewBox.clientWidth || 2;
    const h = previewBox.clientHeight || 2;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderPreview();
  }

  const resizeObs = new ResizeObserver(sizePreview);
  resizeObs.observe(previewBox);

  controls.addEventListener('change', renderPreview);

  let timer = 0;
  function scheduleRefresh() {
    clearTimeout(timer);
    timer = setTimeout(refreshPreview, 80);
  }

  function refreshPreview() {
    const code = buildPresetCode(preset, values);
    const source = applyPresetToSource(fx.source, preset.id, code, preset.target);
    const T = previewTick(fx);
    const { parts, error } = evalIsolated(fx, source, T);
    errHint.hidden = !error;
    errHint.textContent = error ? localizeScriptError(error) : '';
    applyParts(parts);
    renderPreview();
  }

  // —— 事件 ——
  resetBtn.addEventListener('click', () => {
    const defs = defaultPresetValues(preset);
    for (const p of preset.params) {
      values[p.key] = p.type === 'color' ? defs[p.key].slice() : defs[p.key];
      const el = inputs[p.key];
      if (!el) continue;
      if (p.type === 'bool') el.checked = !!values[p.key];
      else if (p.type === 'color') el.value = rgbaToHex(values[p.key][0], values[p.key][1], values[p.key][2], values[p.key][3]);
      else el.value = String(values[p.key]);
      if (el._cselRefresh) refreshCustomSelect(el);
    }
    scheduleRefresh();
  });

  cancelBtn.addEventListener('click', closePresetWindow);
  applyBtn.addEventListener('click', () => {
    const code = buildPresetCode(preset, values);
    pushUndo();
    fx.source = applyPresetToSource(fx.source, preset.id, code, preset.target);
    try {
      rebuildFunctionObject(fx);
    } catch (e) {
      fx._error = e.message;
    }
    if (fx._error) {
      const msg = localizeScriptError(fx._error);
      import('./ui.js').then((m) => m.modalAlert(t('fx.exprError'), msg));
    }
    refreshFunctionPanel();
    import('./timeline-tree.js').then((m) => { if (m.refreshTimelineTree) m.refreshTimelineTree(); }).catch(() => {});
    import('./preset-panel.js').then((m) => { if (m.refreshPresetPanel) m.refreshPresetPanel(); }).catch(() => {});
    closePresetWindow();
  });

  overlay.addEventListener('pointerdown', (ev) => { if (ev.target === overlay) closePresetWindow(); });
  const onKey = (ev) => {
    if (ev.key !== 'Escape') return;
    // 取色器打开时把 Esc 让给它，避免误关整个窗口。
    if (colorPickerOpen()) return;
    ev.stopPropagation();
    closePresetWindow();
  };
  window.addEventListener('keydown', onKey, true);

  current = {
    overlay, renderer, scene, camera, controls, mesh, geo, resizeObs, onKey,
  };

  sizePreview();
  refreshPreview();
}