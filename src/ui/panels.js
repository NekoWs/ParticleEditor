// 属性面板 / 底部时间轴标尺 / 函数对象属性面板：右侧属性面板回显与写入、
// 底部播放进度标尺与 scrub 自动平移、函数对象属性面板与变量关键帧编辑。


import { t } from '../core/i18n.js';
import { cssColor } from '../core/theme.js';
import { localizeScriptError } from '../core/script-error-i18n.js';
import { state, getFunction, isDerivedParticle } from '../core/constants.js';
import { currentVisual, rotVectorAt, spinVectorAt, orbitCenterAt } from '../core/animation.js';
import { currentSelected, selectedGroupName, fxPosDeltaAt, fxScaleValuesAt } from '../interaction/interaction.js';
import { groupCurrentCentroid } from './tree.js';
import { modalAlert, rgbToHex, hexToRgb, rgbaToHex, hexToRgba } from './ui.js';
import { varKfValue } from '../core/easing.js';
import { rebuildFunctionObject } from '../core/generators.js';
import { openBlockDrawer } from './blocks-ui.js';
import { createScriptEditor } from './script-editor.js';
import { pushUndo } from '../state/undo.js';
import { r3 } from '../io/io.js';
// 设置缩放 XYZ 三输入（vals 为 [x,y,z]；null 元素表示混合值显示空）
export function setScaleInputs(vals) {
  setRotTriple(['prop-scale-x', 'prop-scale-y', 'prop-scale-z'], vals);
}

// 旋转类 XYZ 三输入（vals 为 [x,y,z]；null 元素显示空占位）
function setRotTriple(ids, vals) {
  ids.forEach((id, i) => {
    const el = document.getElementById(id);
    if (!el) return;
    const v = vals == null ? null : vals[i];
    if (v == null) { el.value = ''; el.placeholder = '-'; }
    else { el.value = (typeof v === 'number' ? Math.round(v * 100) / 100 : v); el.placeholder = ''; }
  });
}

export function updatePropPanel() {
  const sel = currentSelected();
  const fxId = state.selectedFunction;
  const isFx = !!fxId;
  const gname = selectedGroupName();
  if (sel.length === 0 && !isFx && !gname) return;
  // 用户正在属性面板/函数面板的输入框上编辑时，跳过回显以免覆盖其 .value 丢失选区/光标
  const ae = document.activeElement;
  if (ae && ae.matches && ae.matches(
    '#pane-props input, #pane-props select, #pane-props textarea, #fx-panel input, #fx-panel select, #fx-panel textarea')) {
    return;
  }
  // 粒子缩放无 Z 分量：Z 段仅在函数对象（整体缩放）时显示
  const scaleZSeg = document.getElementById('prop-scale-z-seg');
  if (scaleZSeg) scaleZSeg.style.display = isFx ? '' : 'none';
  // 派生粒子基础属性只读；函数对象 pos/scl 可编辑（写整体轨道）
  const readOnly = !isFx && !gname && sel.some(isDerivedParticle);
  ['prop-color', 'prop-glow', 'prop-light'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = readOnly || isFx || gname;
  });
  const colorBtn = document.getElementById('prop-color-btn');
  if (colorBtn) colorBtn.disabled = readOnly || isFx || gname;
  // 寿命：组也可统一设置（应用到全体成员），函数对象无寿命属性保持禁用
  const lifeEl0 = document.getElementById('prop-life');
  if (lifeEl0) lifeEl0.disabled = readOnly || isFx;
  ['prop-scale-x', 'prop-scale-y', 'prop-scale-z', 'prop-posx', 'prop-posy', 'prop-posz'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = readOnly;
  });
  // 自转仅组/函数对象有；普通粒子隐藏自转行。旋转类输入在派生粒子只读。
  const spinRow = document.getElementById('prop-spin-row');
  if (spinRow) spinRow.style.display = (isFx || gname) ? '' : 'none';
  const spinSpaceBtn = document.getElementById('prop-spin-space');
  if (spinSpaceBtn) spinSpaceBtn.disabled = readOnly;
  const rotSpaceBtn = document.getElementById('prop-rot-space');
  if (rotSpaceBtn) rotSpaceBtn.disabled = readOnly || (!isFx && !gname);
  ['prop-spin-x', 'prop-spin-y', 'prop-spin-z', 'prop-rot-x', 'prop-rot-y', 'prop-rot-z', 'prop-center-x', 'prop-center-y', 'prop-center-z'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = readOnly;
  });
  // 函数对象：显示/编辑整体位置与缩放
  if (isFx) {
    const fx = getFunction(fxId);
    if (!fx) return;
    const d = fxPosDeltaAt(fxId, state.time);
    document.getElementById('prop-posx').value = (fx.center[0] + d[0]).toFixed(2);
    document.getElementById('prop-posy').value = (fx.center[1] + d[1]).toFixed(2);
    document.getElementById('prop-posz').value = (fx.center[2] + d[2]).toFixed(2);
    setScaleInputs(fxScaleValuesAt(fxId, state.time));
    const fpre = 'f:' + fxId;
    if (spinSpaceBtn) spinSpaceBtn.textContent = t(fx.spinSpace === 'local' ? 'spinSpace.local' : 'spinSpace.world');
    if (rotSpaceBtn) rotSpaceBtn.textContent = t(fx.rotSpace === 'local' ? 'rotSpace.local' : 'rotSpace.world');
    setRotTriple(['prop-spin-x', 'prop-spin-y', 'prop-spin-z'], spinVectorAt(fpre, state.time));
    setRotTriple(['prop-rot-x', 'prop-rot-y', 'prop-rot-z'], rotVectorAt(fpre, state.time));
    setRotTriple(['prop-center-x', 'prop-center-y', 'prop-center-z'], orbitCenterAt(fpre, state.time));
    return;
  }
  // 组：显示整体质心位置（缩放无独立显示）；寿命留空占位，填入即应用到全体成员
  if (gname) {
    const c = groupCurrentCentroid(gname, 'pos');
    document.getElementById('prop-posx').value = c[0].toFixed(2);
    document.getElementById('prop-posy').value = c[1].toFixed(2);
    document.getElementById('prop-posz').value = c[2].toFixed(2);
    setScaleInputs(null);
    const gpre = 'g:' + gname;
    if (spinSpaceBtn) spinSpaceBtn.textContent = t((state.groupSpinSpace && state.groupSpinSpace[gname] === 'world') ? 'spinSpace.world' : 'spinSpace.local');
    if (rotSpaceBtn) rotSpaceBtn.textContent = t((state.groupRotSpace && state.groupRotSpace[gname] === 'world') ? 'rotSpace.world' : 'rotSpace.local');
    setRotTriple(['prop-spin-x', 'prop-spin-y', 'prop-spin-z'], spinVectorAt(gpre, state.time));
    setRotTriple(['prop-rot-x', 'prop-rot-y', 'prop-rot-z'], rotVectorAt(gpre, state.time));
    setRotTriple(['prop-center-x', 'prop-center-y', 'prop-center-z'], orbitCenterAt(gpre, state.time));
    const lifeElG = document.getElementById('prop-life');
    if (lifeElG) { lifeElG.value = ''; lifeElG.placeholder = '-'; }
    return;
  }
  const first = sel[0];
  const same = (fn) => sel.every(q => fn(q) === fn(first));

  const colorSame = same(q => q.color[0] + ',' + q.color[1] + ',' + q.color[2]);
  const aSame = same(q => q.color[3]);
  const cInput = document.getElementById('prop-color');
  if (colorSame && aSame) {
    cInput.value = rgbaToHex(first.color[0], first.color[1], first.color[2], first.color[3]);
    cInput.placeholder = '';
  } else {
    cInput.value = '';
    cInput.placeholder = '-';
  }
  const swatchBtn = document.getElementById('prop-color-btn');
  if (swatchBtn) {
    const bg = colorSame && aSame
      ? rgbaToHex(first.color[0], first.color[1], first.color[2], first.color[3])
      : null;
    swatchBtn.style.background = bg
      ? 'linear-gradient(' + bg + ', ' + bg + '), repeating-conic-gradient(#777 0 25%, #bbb 0 50%) 0 0 / 10px 10px'
      : 'repeating-conic-gradient(#777 0 25%, #bbb 0 50%) 0 0 / 10px 10px';
  }

  const sxSame = same(q => q.scale && q.scale[0]);
  const sySame = same(q => q.scale && q.scale[1]);
  setScaleInputs([sxSame ? first.scale[0] : null, sySame ? first.scale[1] : null]);

  const gSame = same(q => q.glow);
  const gInput = document.getElementById('prop-glow');
  gInput.checked = gSame ? first.glow : false;
  gInput.indeterminate = !gSame;

  const lSame = same(q => q.lightLevel);
  const lInput = document.getElementById('prop-light');
  if (lSame) { lInput.value = first.lightLevel; document.getElementById('light-val').textContent = first.lightLevel; }
  else { lInput.value = 0; document.getElementById('light-val').textContent = '-'; }

  // 寿命（毫秒；-1=无限）
  const lifeEl = document.getElementById('prop-life');
  if (lifeEl) {
    const lifeSame = same(q => (typeof q.life === 'number' ? q.life : -1));
    if (lifeSame) {
      lifeEl.value = (typeof first.life === 'number' ? first.life : -1);
      lifeEl.placeholder = '';
    } else { lifeEl.value = ''; lifeEl.placeholder = '-'; }
  }

  const pos = currentVisual(first).pos;
  const setPos = (id, val, sameVal) => { const el = document.getElementById(id); el.value = sameVal ? val : ''; el.placeholder = sameVal ? '' : '-'; };
  const xSame = same(q => currentVisual(q).pos[0].toFixed(2) === pos[0].toFixed(2));
  const ySame = same(q => currentVisual(q).pos[1].toFixed(2) === pos[1].toFixed(2));
  const zSame = same(q => currentVisual(q).pos[2].toFixed(2) === pos[2].toFixed(2));
  setPos('prop-posx', pos[0].toFixed(2), xSame);
  setPos('prop-posy', pos[1].toFixed(2), ySame);
  setPos('prop-posz', pos[2].toFixed(2), zSame);

  // 普通粒子：只有公转与公转中心；混合选择时用空占位表示不一致。
  const rotBase = rotVectorAt(first.id, state.time);
  const centerBase = orbitCenterAt(first.id, state.time);
  const rotVals = ['x', 'y', 'z'].map((_, i) => same(q => rotVectorAt(q.id, state.time)[i]) ? rotBase[i] : null);
  const centerVals = ['x', 'y', 'z'].map((_, i) => same(q => orbitCenterAt(q.id, state.time)[i]) ? centerBase[i] : null);
  setRotTriple(['prop-rot-x', 'prop-rot-y', 'prop-rot-z'], rotVals);
  setRotTriple(['prop-center-x', 'prop-center-y', 'prop-center-z'], centerVals);
  setRotTriple(['prop-spin-x', 'prop-spin-y', 'prop-spin-z'], null);
}

export { rgbToHex, hexToRgb };

// —— 时间轴（底部：仅播放进度） ——

export let TL_PX_PER_MS = 0.04;   // 每毫秒像素（可缩放，见 setTLPxPerMs）
export function setTLPxPerMs(v) { TL_PX_PER_MS = Math.max(0.001, Math.min(4, v)); }
export let timelineViewStart = 0;
// 组件时间轴左侧负轴（负毫秒）：0ms 不贴画布左缘，
// 配合钉边缘余量让播放头/关键帧能真正停在 0 上
export const COMP_TL_MIN_VIEW_START = -250;
export let compTimelineViewStart = COMP_TL_MIN_VIEW_START;
// 跨模块写入（main / tree / timeline-layers 的平移与自动追赶）。
export function setTimelineViewStart(v) { timelineViewStart = v; }
export function setCompTimelineViewStart(v) { compTimelineViewStart = v; }

export function updateLoopIndicator() {
  const el = document.getElementById('loop-indicator');
  if (el) el.style.opacity = state.loop ? '1' : '0.25';
}

export function drawTimeline() {
  const canvas = document.getElementById('timeline');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const pxPerMs = TL_PX_PER_MS;
  const viewEnd = timelineViewStart + w / pxPerMs;
  ctx.fillStyle = cssColor('--panel-2', '#1f222a'); ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = cssColor('--border-soft', '#3a3f4b'); ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();

  // 缩放自适应的刻度：主刻度带数字；主刻度 ≥ 100ms 时按秒显示，更细（50ms 档）时按毫秒显示。
  const major = tlNiceStep(pxPerMs, 40);
  const unit = major >= 100 ? 's' : 'ms';
  const minor = major / 5;
  const start = Math.max(0, Math.floor(timelineViewStart / minor) * minor);
  const count = Math.ceil((viewEnd - start) / minor) + 1;
  ctx.fillStyle = cssColor('--muted', '#9aa0ad'); ctx.font = '10px sans-serif'; ctx.textBaseline = 'top';
  for (let i = 0; i < count; i++) {
    const t = start + i * minor;
    if (t < 0 || t > viewEnd + minor) continue;
    const x = (t - timelineViewStart) * pxPerMs;
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    ctx.strokeStyle = cssColor('--border-soft', '#3a3f4b');
    ctx.beginPath();
    ctx.moveTo(x, h / 2 - (isMajor ? 8 : 4));
    ctx.lineTo(x, h / 2 + (isMajor ? 8 : 4));
    ctx.stroke();
    if (isMajor) ctx.fillText(tlFormatMs(t, unit), x + 2, 2);
  }

  const phx = Math.max(0, Math.min(w, (state.time - timelineViewStart) * pxPerMs));
  ctx.strokeStyle = '#ffcc55'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(phx, 0); ctx.lineTo(phx, h); ctx.stroke();
  ctx.fillStyle = '#ffcc55'; ctx.beginPath();
  ctx.moveTo(Math.max(0, phx - 5), 0); ctx.lineTo(Math.min(w, phx + 5), 0); ctx.lineTo(phx, 8);
  ctx.closePath(); ctx.fill();
}

/** 根据缩放选出「好看」的主刻度间隔（毫秒）。targetPx 为主刻度目标像素间距。 */
export function tlNiceStep(pxPerMs, targetPx = 64) {
  const rough = Math.max(0.001, targetPx / pxPerMs);
  const steps = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000];
  for (const s of steps) if (s >= rough - 1e-9) return s;
  return 1200000;
}

export function tlFormatMs(v, unit) {
  const ms = Math.round(v);
  if (unit === 's') {
    const s = ms / 1000;
    return (Number.isInteger(s) ? s : Math.round(s * 100) / 100) + 's';
  }
  return ms + 'ms';
}

export function timelineXToMs(clientX) {
  const canvas = document.getElementById('timeline');
  const rect = canvas.getBoundingClientRect();
  return timelineViewStart + (clientX - rect.left) / TL_PX_PER_MS;
}

// scrub 播放头拖动：AE 式「滞后自动平移」。
// drag 是拖动状态对象（本函数读写 drag.edge/edgeVs/peakOut，跨帧记住追赶方向与峰值）；
// clientX 是当前指针 screenX；rect 是时间轴 canvas 的 getBoundingClientRect() 结果；
// pinMarginPx 是钉边缘时播放头留在可视区内的距离（像素），免得游标被边缘裁掉。
// 返回 { viewStart, time }，调用方写回 viewStart 变量与 state.time。
//
// 指针在可视区内时播放头 1:1 跟随、视图不动；越过右/左缘后视图单向往外追赶（播放头钉在
// 边缘内侧 pinMarginPx 处）；指针反向但仍停在可视区外时视图不回缩，只有重新进入可视区才恢复跟随。
export function scrubAutoPan(drag, clientX, rect, viewStart, time, pxPerMs, minStart, pinMarginPx) {
  const W = rect.width;
  const x = clientX - rect.left;         // 相对画布左缘（可 <0 或 >W）
  const m = Math.max(0, pinMarginPx || 0); // 钉边缘的可见余量（像素）
  if (drag.edge === undefined) drag.edge = 0;

  if (drag.edge === 0) {
    if (x >= W) {                        // 越过右缘 → 进入右追赶
      drag.edge = 1;
      drag.edgeVs = viewStart;
      drag.peakOut = x - W;
      return { viewStart, time: viewStart + (W - m) / pxPerMs };  // 钉右缘内侧
    }
    if (x <= 0) {                        // 越过左缘 → 进入左追赶
      drag.edge = -1;
      drag.edgeVs = viewStart;
      drag.peakOut = -x;
      return { viewStart, time: Math.max(0, viewStart + m / pxPerMs) };   // 钉左缘内侧
    }
    return { viewStart, time: Math.max(0, viewStart + x / pxPerMs) }; // 可视区内：跟随指针
  }

  if (drag.edge === 1) {
    if (x >= W) {                        // 仍在右缘外：单调右追，反向不回缩
      drag.peakOut = Math.max(drag.peakOut, x - W);
      const vs = drag.edgeVs + drag.peakOut / pxPerMs;
      return { viewStart: vs, time: vs + (W - m) / pxPerMs };     // 钉右缘内侧
    }
    drag.edge = 0;                       // 指针回到可视区 → 恢复跟随
    return { viewStart, time: Math.max(0, viewStart + x / pxPerMs) };
  }

  // drag.edge === -1
  if (x <= 0) {                          // 仍在左缘外：单调左追，反向不回缩
    drag.peakOut = Math.max(drag.peakOut, -x);
    const vs = Math.max(minStart, drag.edgeVs - drag.peakOut / pxPerMs);
    return { viewStart: vs, time: Math.max(0, vs + m / pxPerMs) };          // 钉左缘内侧
  }
  drag.edge = 0;                         // 指针回到可视区 → 恢复跟随
  return { viewStart, time: Math.max(0, viewStart + x / pxPerMs) };
}

// —— 函数对象属性面板 ——

export function refreshFunctionPanel() {
  const box = document.getElementById('fx-panel');
  if (!box) return;
  const fx = getFunction(state.selectedFunction);
  if (!fx) { box.innerHTML = '<p class="hint">' + t('fx.noSelection') + '</p>'; return; }
  box.innerHTML = '';
  box.appendChild(buildFunctionPanel(fx));
}

export function commitFunctionRebuild(fx, opts) {
  try {
    rebuildFunctionObject(fx);
  } catch (e) {
    fx._error = e.message;
    if (!(opts && opts.silent)) modalAlert(t('fx.exprError'), localizeScriptError(e.message));
  }
  refreshFxTerminal(fx);
}

// 函数面板的代码块（setup/process/funcs）：标题 + CodeMirror 编辑器，
// 首次编辑推撤销、实时写回 fx[field]、失焦时重建函数对象。
function buildCodeBlock(fx, codeBody, field, labelKey, rows) {
  const group = document.createElement('label');
  group.className = 'fx-code-group';
  const label = document.createElement('span');
  label.className = 'fx-code-headline';
  label.textContent = t(labelKey);
  group.appendChild(label);

  const container = document.createElement('div');
  container.className = 'fx-code';
  group.appendChild(container);

  let editing = false;
  const view = createScriptEditor(container, {
    fx,
    field,
    rows,
    onChange: (value) => {
      if (!editing) { editing = true; pushUndo(); }
      fx[field] = value;
    },
  });

  // 点击代码组任意位置（含 .fx-code 下方空白）都进入编辑。
  group.addEventListener('mousedown', (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest('.cm-content')) return;
    event.preventDefault();
    view.focus();
  });

  container.addEventListener('focusout', () => {
    if (!editing) return;
    editing = false;
    commitFunctionRebuild(fx);
  });

  codeBody.appendChild(group);
}

export function buildFunctionPanel(fx) {
  const wrap = document.createElement('div');
  wrap.className = 'fx-panel';

  // 「名称」不再在此编辑：函数对象重命名走底部时间轴列表的名字行双击（行内编辑框）。

  // 中心点（合并为单个紧凑组合输入框）
  const centerRow = document.createElement('div');
  centerRow.className = 'row';
  const centerLabel = document.createElement('span');
  centerLabel.textContent = t('fx.center');
  centerRow.appendChild(centerLabel);
  const centerGroup = document.createElement('div');
  centerGroup.className = 'vec3';
  ['X', 'Y', 'Z'].forEach((axis, idx) => {
    const seg = document.createElement('div');
    seg.className = 'vec3-seg';
    const axisLabel = document.createElement('span');
    axisLabel.textContent = axis;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = '0.1'; inp.value = fx.center[idx];
    inp.title = axis;
    inp.onchange = () => { pushUndo(); fx.center[idx] = parseFloat(inp.value) || 0; commitFunctionRebuild(fx); };
    seg.appendChild(axisLabel);
    seg.appendChild(inp);
    centerGroup.appendChild(seg);
  });
  centerRow.appendChild(centerGroup);
  wrap.appendChild(centerRow);

  // 时长
  const durRow = document.createElement('div');
  durRow.className = 'row';
  const durLabel = document.createElement('span'); durLabel.textContent = t('fx.duration');
  durRow.appendChild(durLabel);
  const durIn = document.createElement('input');
  durIn.type = 'number'; durIn.min = '0'; durIn.step = '0.001'; durIn.id = 'fx-duration'; durIn.value = (fx.duration / 1000).toFixed(3); durIn.style.width = '52px';
  durIn.onchange = () => { pushUndo(); fx.duration = Math.max(0, Math.round((parseFloat(durIn.value) || 0) * 1000)); commitFunctionRebuild(fx); };
  durRow.appendChild(durIn);
  wrap.appendChild(durRow);

  // 随机种子
  const seedRow = document.createElement('label');
  seedRow.className = 'row';
  const seedLabel = document.createElement('span');
  seedLabel.textContent = t('fx.seed');
  seedRow.appendChild(seedLabel);
  const seedIn = document.createElement('input');
  seedIn.type = 'number'; seedIn.step = '1'; seedIn.value = fx.seed | 0;
  seedIn.onchange = () => { pushUndo(); fx.seed = parseInt(seedIn.value) || 0; commitFunctionRebuild(fx); };
  seedRow.appendChild(seedIn);
  wrap.appendChild(seedRow);

  // 帧级同步：导出后在播放器里是否每渲染帧精确同步派生粒子（默认关闭＝与普通粒子一致，带约 50ms 渲染延迟）
  const fsRow = document.createElement('label');
  fsRow.className = 'row fx-framesync-row';
  fsRow.title = t('fx.frameSyncHint');
  const fsLabel = document.createElement('span');
  fsLabel.textContent = t('fx.frameSync');
  const fsChk = document.createElement('input');
  fsChk.type = 'checkbox';
  fsChk.checked = !!fx.frameSync;
  fsChk.onchange = () => {
    pushUndo();
    fx.frameSync = fsChk.checked;
  };
  fsRow.appendChild(fsLabel);
  fsRow.appendChild(fsChk);
  wrap.appendChild(fsRow);

  // 公式代码块（默认折叠；完整源码 + 终端 + 快速数学放在折叠区内）
  const codeWrap = document.createElement('div');
  codeWrap.className = 'fx-code-wrap';
  const codeHead = document.createElement('div');
  codeHead.className = 'fx-code-head';
  const codeToggle = document.createElement('button');
  codeToggle.type = 'button';
  codeToggle.className = 'mini fx-code-toggle';
  codeToggle.textContent = t('fx.codeBlock') + ' ▸';
  codeHead.appendChild(codeToggle);
  const puzzleBtn = document.createElement('button');
  puzzleBtn.className = 'mini';
  puzzleBtn.textContent = t('fx.puzzle');
  puzzleBtn.title = t('fx.puzzleHint');
  puzzleBtn.onclick = () => openBlockDrawer(fx);
  codeHead.appendChild(puzzleBtn);
  codeWrap.appendChild(codeHead);

  const codeBody = document.createElement('div');
  codeBody.className = 'fx-code-body';
  codeBody.style.display = 'none';
  codeToggle.onclick = () => {
    const opening = codeBody.style.display === 'none';
    codeBody.style.display = opening ? 'block' : 'none';
    codeToggle.textContent = t('fx.codeBlock') + (opening ? ' ▾' : ' ▸');
  };
  codeWrap.appendChild(codeBody);

  // 完整源码编辑器（直接显示 func setup()/tick()/process(...) 与自定义函数）
  const sourceContainer = document.createElement('div');
  sourceContainer.className = 'fx-code';
  codeBody.appendChild(sourceContainer);

  const terminal = document.createElement('div');
  terminal.className = 'fx-terminal';
  codeBody.appendChild(terminal);

  let editing = false;
  const view = createScriptEditor(sourceContainer, {
    fx,
    rows: 12,
    onChange: (value) => {
      if (!editing) { editing = true; pushUndo(); }
      fx.source = value;
      refreshFxTerminal(fx);
    },
  });

  sourceContainer.addEventListener('focusout', () => {
    if (!editing) return;
    editing = false;
    commitFunctionRebuild(fx);
    refreshFxTerminal(fx);
  });

  // 快速数学近似
  const fmRow = document.createElement('label');
  fmRow.className = 'row fx-fastmath-row';
  const fmLabel = document.createElement('span');
  fmLabel.textContent = t('fx.fastMath');
  const fmChk = document.createElement('input');
  fmChk.type = 'checkbox';
  fmChk.checked = !!fx.fastMath;
  fmChk.onchange = () => {
    pushUndo();
    fx.fastMath = fmChk.checked;
    commitFunctionRebuild(fx);
    refreshFxTerminal(fx);
  };
  fmRow.appendChild(fmLabel);
  fmRow.appendChild(fmChk);
  codeBody.appendChild(fmRow);

  wrap.appendChild(codeWrap);

  refreshFxTerminal(fx);

  return wrap;
}

/** 把 fx._terminal（print 输出与错误）渲染到函数面板的终端区域。
 *  用 fx._terminalRev 判断是否真的变化：播放期每帧都会调用，未产生新输出时跳过 DOM 重建。 */
export function refreshFxTerminal(fx) {
  const wrap = document.querySelector('.fx-panel');
  if (!wrap) return;
  const term = wrap.querySelector('.fx-terminal');
  if (!term) return;
  const entries = Array.isArray(fx && fx._terminal) ? fx._terminal : [];
  const rev = (fx && fx._terminalRev) || 0;
  if (term._renderedRev === rev && term._renderedCount === entries.length) return;
  term.textContent = '';
  term.style.display = entries.length ? 'block' : 'none';
  term._renderedRev = rev;
  term._renderedCount = entries.length;
  if (!entries.length) return;

  for (const e of entries) {
    const kind = e && e.kind === 'error' ? 'error' : 'info';
    const text = String(e && e.text != null ? e.text : e);
    const count = e && e.count > 1 ? ` (x${e.count})` : '';
    const line = document.createElement('div');
    line.className = kind === 'error' ? 'fx-terminal-line fx-terminal-err' : 'fx-terminal-line';
    line.textContent = (kind === 'error' ? '[error] ' : '[info] ') + text + count;
    term.appendChild(line);
  }
  // 有新输出时自动滚到底部，始终显示最新一行。
  term.scrollTop = term.scrollHeight;
}

// 实时同步「有关键帧」变量输入框显示的当前帧插值值（不重建面板）
export function syncFunctionVarValues() {
  document.querySelectorAll('input.kf-synced').forEach(inp => {
    const sep = inp.dataset.fxKf.indexOf('|');
    const fxId = inp.dataset.fxKf.slice(0, sep);
    const name = inp.dataset.fxKf.slice(sep + 1);
    const fx = getFunction(fxId);
    const v = fx && fx.vars && fx.vars[name];
    const kf = v && v.kf;
    if (kf && kf.length > 0) inp.value = r3(varKfValue(kf, state.time)).toFixed(2);
  });
}
