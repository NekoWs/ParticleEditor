/* =========================================================================
 * 属性面板 / 底部时间轴标尺 / 函数对象属性面板
 * 职责：
 *   1) 右侧属性面板回显与写入（updatePropPanel / setScaleInputs）
 *   2) 底部播放进度标尺与 scrub 自动平移（drawTimeline / scrubAutoPan）
 *   3) 函数对象属性面板与变量关键帧编辑（buildFunctionPanel / syncFunctionVarValues）
 * ======================================================================= */


import { t } from '../core/i18n.js';
import { state, FUNCTION_PRESETS, getFunction, isDerivedParticle } from '../core/constants.js';
import { currentVisual, rotVectorAt, spinVectorAt, orbitCenterAt } from '../core/animation.js';
import { currentSelected, selectedGroupName, fxPosDeltaAt, fxScaleValuesAt } from '../interaction/interaction.js';
import { groupCurrentCentroid } from './tree.js';
import { modalAlert, rgbToHex, hexToRgb, rgbaToHex, hexToRgba } from './ui.js';
import { varKfValue } from '../core/easing.js';
import { applyPresetBuild, rebuildFunctionObject } from '../core/generators.js';
import { openBlockDrawer } from './blocks-ui.js';
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
  // 粒子缩放无 Z 分量：Z 输入仅在函数对象（整体缩放）时显示
  const scaleZ = document.getElementById('prop-scale-z');
  if (scaleZ) scaleZ.style.display = isFx ? '' : 'none';
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

  // 寿命（tick；-1=无限）
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

/* =========================================================================
 * 时间轴（底部：仅播放进度）
 * ======================================================================= */

export let TL_PX_PER_TICK = 4;   // 每 tick 像素（可缩放，见 setTLPxPerTick）
export function setTLPxPerTick(v) { TL_PX_PER_TICK = Math.max(0.25, Math.min(128, v)); }
export let timelineViewStart = 0;
// 组件时间轴左侧负轴（负几个 tick）：tick 0 不贴画布左缘，
// 配合钉边缘余量让播放头/关键帧能真正停在 0t 上
export const COMP_TL_MIN_VIEW_START = -5;
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
  const pxPerTick = TL_PX_PER_TICK;
  const viewEnd = timelineViewStart + w / pxPerTick;
  ctx.fillStyle = '#1f222a'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#3a3f4b'; ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();

  // 缩放自适应的刻度：主刻度带数字（放大后自动细分到 0.5/0.2/0.1 tick）。
  const major = tlNiceStep(pxPerTick, 40);
  const minor = major / 5;
  const start = Math.max(0, Math.floor(timelineViewStart / minor) * minor);
  const count = Math.ceil((viewEnd - start) / minor) + 1;
  ctx.fillStyle = '#9aa0ad'; ctx.font = '10px sans-serif'; ctx.textBaseline = 'top';
  for (let i = 0; i < count; i++) {
    const t = start + i * minor;
    if (t < 0 || t > viewEnd + minor) continue;
    const x = (t - timelineViewStart) * pxPerTick;
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    ctx.strokeStyle = '#3a3f4b';
    ctx.beginPath();
    ctx.moveTo(x, h / 2 - (isMajor ? 8 : 4));
    ctx.lineTo(x, h / 2 + (isMajor ? 8 : 4));
    ctx.stroke();
    if (isMajor) ctx.fillText(tlFormatTick(t), x + 2, 2);
  }

  const phx = Math.max(0, Math.min(w, (state.time - timelineViewStart) * pxPerTick));
  ctx.strokeStyle = '#ffcc55'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(phx, 0); ctx.lineTo(phx, h); ctx.stroke();
  ctx.fillStyle = '#ffcc55'; ctx.beginPath();
  ctx.moveTo(Math.max(0, phx - 5), 0); ctx.lineTo(Math.min(w, phx + 5), 0); ctx.lineTo(phx, 8);
  ctx.closePath(); ctx.fill();
}

/** 根据缩放选出「好看」的主刻度间隔（tick）。targetPx 为主刻度目标像素间距。 */
export function tlNiceStep(pxPerTick, targetPx = 64) {
  const rough = Math.max(0.001, targetPx / pxPerTick);
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  for (const s of steps) if (s >= rough - 1e-9) return s;
  return 2000;
}

export function tlFormatTick(v) {
  if (Math.abs(v - Math.round(v)) < 1e-9) return String(Math.round(v));
  return String(Math.round(v * 100) / 100);
}

export function timelineXToTick(clientX) {
  const canvas = document.getElementById('timeline');
  const rect = canvas.getBoundingClientRect();
  return timelineViewStart + (clientX - rect.left) / TL_PX_PER_TICK;
}

/**
 * scrub 播放头拖动：AE 式「滞后自动平移」。
 * 入参 drag 为拖动状态对象（本函数读写 drag.edge/edgeVs/peakOut，用于跨帧记忆追赶方向与峰值）；
 * clientX 为当前指针 screenX；rect 为时间轴 canvas 的 getBoundingClientRect() 结果；
 * pinMarginPx 为钉边缘时播放头留在可视区内的距离（像素），保证游标不被边缘裁掉/因亚像素宽度差而消失。
 * 返回 { viewStart, time }，调用方写回 viewStart 变量与 state.time。
 *
 * 语义：
 *  - 指针在可视区内：播放头 1:1 跟随指针，视图不动。
 *  - 指针越出右缘/左缘：视图单向往外追赶（播放头钉在边缘内侧 pinMarginPx 处）。
 *  - 滞后：指针反向但仍停留在可视区外时，视图不回缩（播放头继续钉边缘）；
 *    只有指针重新进入可视区后，才恢复 1:1 跟随。
 */
export function scrubAutoPan(drag, clientX, rect, viewStart, time, pxPerTick, minStart, pinMarginPx) {
  const W = rect.width;
  const x = clientX - rect.left;         // 相对画布左缘（可 <0 或 >W）
  const m = Math.max(0, pinMarginPx || 0); // 钉边缘的可见余量（像素）
  if (drag.edge === undefined) drag.edge = 0;

  if (drag.edge === 0) {
    if (x >= W) {                        // 越过右缘 → 进入右追赶
      drag.edge = 1;
      drag.edgeVs = viewStart;
      drag.peakOut = x - W;
      return { viewStart, time: viewStart + (W - m) / pxPerTick };  // 钉右缘内侧
    }
    if (x <= 0) {                        // 越过左缘 → 进入左追赶
      drag.edge = -1;
      drag.edgeVs = viewStart;
      drag.peakOut = -x;
      return { viewStart, time: Math.max(0, viewStart + m / pxPerTick) };   // 钉左缘内侧
    }
    return { viewStart, time: Math.max(0, viewStart + x / pxPerTick) }; // 可视区内：跟随指针
  }

  if (drag.edge === 1) {
    if (x >= W) {                        // 仍在右缘外：单调右追，反向不回缩
      drag.peakOut = Math.max(drag.peakOut, x - W);
      const vs = drag.edgeVs + drag.peakOut / pxPerTick;
      return { viewStart: vs, time: vs + (W - m) / pxPerTick };     // 钉右缘内侧
    }
    drag.edge = 0;                       // 指针回到可视区 → 恢复跟随
    return { viewStart, time: Math.max(0, viewStart + x / pxPerTick) };
  }

  // drag.edge === -1
  if (x <= 0) {                          // 仍在左缘外：单调左追，反向不回缩
    drag.peakOut = Math.max(drag.peakOut, -x);
    const vs = Math.max(minStart, drag.edgeVs - drag.peakOut / pxPerTick);
    return { viewStart: vs, time: Math.max(0, vs + m / pxPerTick) };          // 钉左缘内侧
  }
  drag.edge = 0;                         // 指针回到可视区 → 恢复跟随
  return { viewStart, time: Math.max(0, viewStart + x / pxPerTick) };
}

/* =========================================================================
 * 函数对象属性面板
 * ======================================================================= */

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
    fx._error = null;
  } catch (e) {
    fx._error = e.message;
    if (!(opts && opts.silent)) modalAlert(t('fx.exprError'), e.message);
  }
}

// 函数面板的代码块（setup/process/funcs）：标题 + textarea，onchange 写回 fx[field] 并重建。
function buildCodeBlock(fx, codeBody, field, labelKey, rows) {
  const group = document.createElement('label');
  group.className = 'fx-code-group';
  const label = document.createElement('span');
  label.className = 'fx-code-headline';
  label.textContent = t(labelKey);
  group.appendChild(label);
  const area = document.createElement('textarea');
  area.className = 'fx-code';
  area.rows = rows;
  area.value = fx[field] || '';
  area.onchange = () => { pushUndo(); fx[field] = area.value; commitFunctionRebuild(fx); };
  group.appendChild(area);
  codeBody.appendChild(group);
}

export function buildFunctionPanel(fx) {
  const wrap = document.createElement('div');
  wrap.className = 'fx-panel';

  // 「名称」不再在此编辑：函数对象重命名走底部时间轴列表的名字行双击（行内编辑框）。

  // 采样数（面板首行）
  const countRow = document.createElement('label');
  countRow.className = 'row';
  countRow.textContent = t('fx.sampleCount');
  const countIn = document.createElement('input');
  countIn.type = 'number'; countIn.min = '1'; countIn.value = fx.count;
  countIn.onchange = () => { pushUndo(); fx.count = Math.max(1, Math.round(parseInt(countIn.value) || 1)); commitFunctionRebuild(fx); };
  countRow.appendChild(countIn);
  wrap.appendChild(countRow);

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

  // 预设参数（无参数时不渲染空容器，避免中心点与时长之间出现多余的空 .fx-params 区块）
  if (fx.preset && FUNCTION_PRESETS[fx.preset] && (FUNCTION_PRESETS[fx.preset].params || []).length > 0) {
    const preset = FUNCTION_PRESETS[fx.preset];
    const pbox = document.createElement('div');
    pbox.className = 'fx-params';
    for (const prm of preset.params) {
      const row = document.createElement('label');
      row.className = 'row';
      row.textContent = t('fx.param.' + prm.key) + ' ';
      const inp = document.createElement('input');
      inp.type = 'number'; inp.step = '0.1'; inp.value = fx.params && fx.params[prm.key] != null ? fx.params[prm.key] : prm.def;
      inp.onchange = () => {
        pushUndo();
        if (!fx.params) fx.params = {};
        fx.params[prm.key] = parseFloat(inp.value) || 0;
        applyPresetBuild(fx);
        commitFunctionRebuild(fx);
        refreshFunctionPanel();
      };
      row.appendChild(inp);
      pbox.appendChild(row);
    }
    wrap.appendChild(pbox);
  }

  // 时长 / 采样间隔
  const durRow = document.createElement('div');
  durRow.className = 'row';
  const durLabel = document.createElement('span'); durLabel.textContent = t('fx.duration');
  durRow.appendChild(durLabel);
  const durIn = document.createElement('input');
  durIn.type = 'number'; durIn.min = '0'; durIn.id = 'fx-duration'; durIn.value = fx.duration; durIn.style.width = '52px';
  durIn.onchange = () => { pushUndo(); fx.duration = Math.max(0, parseInt(durIn.value) || 0); commitFunctionRebuild(fx); };
  durRow.appendChild(durIn);
  const stepLabel = document.createElement('span'); stepLabel.textContent = t('fx.interval');
  durRow.appendChild(stepLabel);
  const stepIn = document.createElement('input');
  stepIn.type = 'number'; stepIn.min = '1'; stepIn.value = fx.step; stepIn.style.width = '52px';
  stepIn.onchange = () => { pushUndo(); fx.step = Math.max(1, parseInt(stepIn.value) || 1); commitFunctionRebuild(fx); };
  durRow.appendChild(stepIn);
  wrap.appendChild(durRow);

  // 随机种子
  const seedRow = document.createElement('label');
  seedRow.className = 'row';
  seedRow.textContent = t('fx.seed');
  const seedIn = document.createElement('input');
  seedIn.type = 'number'; seedIn.step = '1'; seedIn.value = fx.seed | 0;
  seedIn.onchange = () => { pushUndo(); fx.seed = parseInt(seedIn.value) || 0; commitFunctionRebuild(fx); };
  seedRow.appendChild(seedIn);
  wrap.appendChild(seedRow);

  // 公式代码块（默认折叠；文本代码与快速数学放在折叠区内）
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

  // Setup / Process / 顶层函数：标题与输入框合并在同一组内
  buildCodeBlock(fx, codeBody, 'setup', 'fx.setupBlock', 4);
  buildCodeBlock(fx, codeBody, 'process', 'fx.processBlock', 7);
  buildCodeBlock(fx, codeBody, 'funcs', 'fx.funcsBlock', 4);

  // 快速数学近似（放在文本代码下方）：左侧 label，右侧勾选框
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
  };
  fmRow.appendChild(fmLabel);
  fmRow.appendChild(fmChk);
  codeBody.appendChild(fmRow);

  wrap.appendChild(codeWrap);

  return wrap;
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
