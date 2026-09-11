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
import { invalidateMaxMsCache, maxMs } from '../core/animation.js';
import { cssVar } from '../core/theme.js';
import { rgbaToHex, hexToRgba } from './ui.js';
import { openColorPicker, closeColorPicker, colorPickerOpen } from './color-picker.js';
import { customSelect, refreshCustomSelect } from './select.js';
import { pushUndo } from '../state/undo.js';
import { refreshFunctionPanel } from './panels.js';
import { localizeScriptError } from '../core/script-error-i18n.js';
import { buildPresetCode, applyPresetToSource, defaultPresetValues, getPreset, extractGradientStops } from '../core/presets.js';
import { createGradientBar } from './gradient-bar.js';
import { createAngleControl, closeAngleDial, angleDialOpen } from './angle-dial.js';

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
  if (w.rafId) cancelAnimationFrame(w.rafId);
  window.removeEventListener('keydown', w.onKey, true);
  if (w.resizeObs) w.resizeObs.disconnect();
  if (w.seekObs) w.seekObs.disconnect();
  if (w.controls) w.controls.dispose();
  closeColorPicker();
  closeAngleDial();
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
  // 已应用过该预设时，从源码块注释还原色标，让色条延续上次设置
  for (const p of preset.params) {
    if (p.type === 'gradient') {
      const applied = extractGradientStops(fx.source, preset.id);
      if (applied && applied.length >= 2) values[p.key] = applied;
    }
  }
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
  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'preset-canvas-wrap';
  const canvas = document.createElement('canvas');
  canvasWrap.appendChild(canvas);
  const errHint = document.createElement('div');
  errHint.className = 'preset-preview-error';
  errHint.hidden = true;
  canvasWrap.appendChild(errHint);
  previewBox.appendChild(canvasWrap);

  // —— 播放条（PR 式）：左侧 时间/长度、中间按钮、右侧悬停时间，下方细进度条 + 每秒标尺 ——
  const playbar = document.createElement('div');
  playbar.className = 'preset-playbar';
  const playRow = document.createElement('div');
  playRow.className = 'preset-playrow';
  const timeLabel = document.createElement('span');
  timeLabel.className = 'preset-time';
  const btnsRow = document.createElement('div');
  btnsRow.className = 'preset-btns';
  const hoverLabel = document.createElement('span');
  hoverLabel.className = 'preset-hover-time';
  playRow.appendChild(timeLabel);
  playRow.appendChild(btnsRow);
  playRow.appendChild(hoverLabel);
  playbar.appendChild(playRow);
  const seekCanvas = document.createElement('canvas');
  seekCanvas.className = 'preset-seek';
  playbar.appendChild(seekCanvas);
  previewBox.appendChild(playbar);
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
      inputs[param.key] = { chk };
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
      inputs[param.key] = { sel };
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
      inputs[param.key] = { inp, paint };
      row.appendChild(inp);
      row.appendChild(sw);
    } else if (param.type === 'gradient') {
      // PS 式渐变条：点击加色标、拖动移动（可越位换序）、双击/右键菜单删除；颜色一律走右键菜单「编辑颜色」取色器
      row.classList.add('preset-grad-row');
      const block = document.createElement('div');
      block.className = 'preset-grad';
      const bar = createGradientBar({
        stops: val,
        onChange: (stops) => { values[param.key] = stops; scheduleRefresh(); },
        onEditColor: (i, x, y) => {
          const stops = bar.getStops();
          if (!stops[i]) return;
          openColorPicker({
            x, y,
            rgba: stops[i].color,
            onInput: (out) => bar.setColorAt(i, out),
          });
        },
      });
      block.appendChild(bar.host);
      row.appendChild(block);
      inputs[param.key] = { bar };
    } else if (param.type === 'angle') {
      // 三个角度拨盘（X/Y/Z）：图标+数值°，点击弹出圆形表盘
      const wrap = document.createElement('span');
      wrap.className = 'preset-angle';
      const dials = {};
      ['x', 'y', 'z'].forEach((axis) => {
        const seg = document.createElement('span');
        seg.className = 'preset-angle-seg';
        const name = document.createElement('span');
        name.className = 'preset-angle-name';
        name.textContent = axis.toUpperCase();
        seg.appendChild(name);
        const ctl = createAngleControl({
          value: val ? val[axis] : 0,
          onChange: (n) => {
            values[param.key][axis] = n;
            scheduleRefresh();
          },
        });
        seg.appendChild(ctl.host);
        wrap.appendChild(seg);
        dials[axis] = ctl;
      });
      inputs[param.key] = { dials };
      row.appendChild(wrap);
    } else {
      // 数值参数：滑块拖动为主，紧凑数字框做精确输入
      const wrap = document.createElement('span');
      wrap.className = 'preset-num';
      const range = document.createElement('input');
      range.type = 'range';
      if (param.min != null) range.min = param.min;
      if (param.max != null) range.max = param.max;
      range.step = param.step != null ? param.step : 'any';
      range.value = String(val);
      const num = document.createElement('input');
      num.type = 'number';
      if (param.min != null) num.min = param.min;
      if (param.max != null) num.max = param.max;
      num.step = param.step != null ? param.step : 'any';
      num.value = String(val);
      const clampNum = (n) => {
        let v = n;
        if (param.min != null && v < param.min) v = param.min;
        if (param.max != null && v > param.max) v = param.max;
        return v;
      };
      range.addEventListener('input', () => {
        const n = parseFloat(range.value);
        if (Number.isFinite(n)) { values[param.key] = n; num.value = String(n); scheduleRefresh(); }
      });
      num.addEventListener('input', () => {
        const n = clampNum(parseFloat(num.value));
        if (Number.isFinite(n)) { values[param.key] = n; range.value = String(n); scheduleRefresh(); }
      });
      wrap.appendChild(range);
      wrap.appendChild(num);
      inputs[param.key] = { range, num };
      row.appendChild(wrap);
    }
    // 依据其它参数决定显示与否（如角度只在依据为空间轴时出现）
    if (typeof param.visibleIf === 'function') {
      const syncVis = () => { row.hidden = !param.visibleIf(values); };
      row._syncVis = syncVis;
      syncVis();
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
    const w = canvasWrap.clientWidth || 2;
    const h = canvasWrap.clientHeight || 2;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderPreview();
  }

  const resizeObs = new ResizeObserver(sizePreview);
  resizeObs.observe(previewBox);

  controls.addEventListener('change', renderPreview);

  // —— 播放条：时间/长度 + 按钮 + 悬停时间 + 细进度条（每秒标尺） ——
  const st = fx.st || 0;
  const durMs = fx.duration > 0 ? fx.duration : (maxMs() || 5000);
  const endT = st + Math.max(0, durMs - 1);
  const FRAME_STEP = 50; // 一帧 = 50ms（脚本 tick 周期）
  let previewT = Math.max(st, Math.min(endT, Math.round(previewTick(fx))));
  let playing = false;
  let lastNow = 0;
  let seeking = false;

  const fmtT = (ms) => ((Math.max(0, ms)) / 1000).toFixed(2) + 's';
  const clampT = (t) => Math.max(st, Math.min(endT, Math.round(t)));

  function updateTimeUI() {
    timeLabel.textContent = fmtT(previewT - st) + ' / ' + fmtT(durMs);
  }

  const mkPlayBtn = (glyph, titleKey, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preset-pbtn';
    b.title = t(titleKey);
    b.textContent = glyph;
    b.addEventListener('click', fn);
    btnsRow.appendChild(b);
    return b;
  };
  const playBtn = mkPlayBtn('▶', 'preset.play.play', () => {
    playing = !playing;
    lastNow = 0;
    playBtn.textContent = playing ? '❚❚' : '▶';
    if (playing && previewT >= endT) { previewT = st; refreshPreview(); updateTimeUI(); drawSeek(); }
  });
  // 上一秒、上一帧 | 播放/暂停 | 下一帧、下一秒（播放键居中）
  mkPlayBtn('«', 'preset.play.prevSec', () => seekBy(-1000));
  mkPlayBtn('‹', 'preset.play.prevFrame', () => seekBy(-FRAME_STEP));
  btnsRow.appendChild(playBtn);
  mkPlayBtn('›', 'preset.play.nextFrame', () => seekBy(FRAME_STEP));
  mkPlayBtn('»', 'preset.play.nextSec', () => seekBy(1000));

  function seekBy(dt) {
    previewT = clampT(previewT + dt);
    refreshPreview();
    updateTimeUI();
    drawSeek();
  }

  function seekFromEvent(ev) {
    const rect = seekCanvas.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(1, rect.width)));
    previewT = clampT(st + Math.round(t * durMs));
    refreshPreview();
    updateTimeUI();
    drawSeek();
  }
  seekCanvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    seeking = true;
    try { seekCanvas.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
    seekFromEvent(ev);
  });
  seekCanvas.addEventListener('pointermove', (ev) => {
    const rect = seekCanvas.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(1, rect.width)));
    hoverLabel.textContent = fmtT(Math.round(t * durMs));
    if (seeking) seekFromEvent(ev);
  });
  const endSeek = () => { seeking = false; };
  seekCanvas.addEventListener('pointerup', endSeek);
  seekCanvas.addEventListener('pointercancel', endSeek);
  seekCanvas.addEventListener('pointerleave', () => { if (!seeking) hoverLabel.textContent = ''; });

  function drawSeek() {
    const w = Math.max(2, Math.round(seekCanvas.clientWidth));
    const h = Math.max(2, Math.round(seekCanvas.clientHeight));
    if (seekCanvas.width !== w || seekCanvas.height !== h) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      seekCanvas.width = Math.round(w * dpr);
      seekCanvas.height = Math.round(h * dpr);
    }
    const dpr = seekCanvas.width / w;
    const ctx = seekCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cy = h / 2;
    const bh = 4;
    let accent = '#5b9dff', track = '#29303c', tick = '#3a4250';
    try {
      accent = cssVar('--accent', '#5b9dff').trim() || accent;
      track = cssVar('--panel-3', '#29303c').trim() || track;
      tick = cssVar('--border-soft', '#3a4250').trim() || tick;
    } catch (e) { /* 用默认 */ }
    // 轨道
    ctx.fillStyle = track;
    ctx.beginPath();
    ctx.roundRect(0, cy - bh / 2, w, bh, 2);
    ctx.fill();
    // 每秒刻度
    const pxPerSec = durMs > 0 ? w / (durMs / 1000) : 0;
    if (Number.isFinite(pxPerSec) && pxPerSec >= 5) {
      ctx.strokeStyle = tick;
      ctx.lineWidth = 1;
      for (let i = 1; i * pxPerSec < w; i++) {
        const x = Math.round(i * pxPerSec) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, cy - 4);
        ctx.lineTo(x, cy + 4);
        ctx.stroke();
      }
    }
    // 进度填充
    const px = (previewT - st) / Math.max(1, durMs) * w;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.roundRect(0, cy - bh / 2, Math.max(bh, px), bh, 2);
    ctx.fill();
    // 播放头
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(px - 1, cy - 6, 2, 12);
  }
  const seekObs = new ResizeObserver(drawSeek);
  seekObs.observe(seekCanvas);

  // 参数改动即时生成预览（不再防抖，拖动丝滑）
  function scheduleRefresh() {
    // 依据联动显隐（如角度行只在依据为空间轴时显示）
    document.querySelectorAll('.preset-modal .preset-param-row').forEach((r) => {
      if (typeof r._syncVis === 'function') r._syncVis();
    });
    refreshPreview();
  }

  function refreshPreview() {
    const code = buildPresetCode(preset, values);
    const source = applyPresetToSource(fx.source, preset.id, code, preset.target);
    const { parts, error } = evalIsolated(fx, source, previewT);
    errHint.hidden = !error;
    errHint.textContent = error ? localizeScriptError(error) : '';
    applyParts(parts);
    renderPreview();
    drawSeek();
  }

  function loop(now) {
    if (current !== win) return;
    if (playing) {
      if (lastNow) {
        previewT = clampT(previewT + (now - lastNow));
        refreshPreview();
        updateTimeUI();
        if (previewT >= endT) {
          playing = false;
          playBtn.textContent = '▶';
        }
      }
      lastNow = now;
    }
    win.rafId = requestAnimationFrame(loop);
  }

  // —— 事件 ——
  resetBtn.addEventListener('click', () => {
    const defs = defaultPresetValues(preset);
    for (const p of preset.params) {
      values[p.key] = p.type === 'color' ? defs[p.key].slice()
        : p.type === 'gradient' ? defs[p.key].map((s) => ({ pos: s.pos, color: s.color.slice() }))
          : p.type === 'angle' ? { x: defs[p.key].x, y: defs[p.key].y, z: defs[p.key].z }
            : defs[p.key];
      const ctl = inputs[p.key];
      if (!ctl) continue;
      if (p.type === 'bool') ctl.chk.checked = !!values[p.key];
      else if (p.type === 'color') {
        ctl.inp.value = rgbaToHex(values[p.key][0], values[p.key][1], values[p.key][2], values[p.key][3]);
        ctl.paint();
      } else if (p.type === 'enum') {
        ctl.sel.value = String(values[p.key]);
        if (ctl.sel._cselRefresh) refreshCustomSelect(ctl.sel);
      } else if (p.type === 'gradient') {
        ctl.bar.setStops(values[p.key]);
      } else if (p.type === 'angle') {
        ctl.dials.x.setValue(values[p.key].x);
        ctl.dials.y.setValue(values[p.key].y);
        ctl.dials.z.setValue(values[p.key].z);
      } else {
        ctl.range.value = String(values[p.key]);
        ctl.num.value = String(values[p.key]);
      }
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
    // 取色器/角度表盘打开时把 Esc 让给它们，避免误关整个窗口。
    if (colorPickerOpen() || angleDialOpen()) return;
    ev.stopPropagation();
    closePresetWindow();
  };
  window.addEventListener('keydown', onKey, true);

  const win = {
    overlay, renderer, scene, camera, controls, mesh, geo, resizeObs, seekObs, onKey, rafId: 0,
  };
  current = win;

  sizePreview();
  updateTimeUI();
  refreshPreview();
  win.rafId = requestAnimationFrame(loop);
}