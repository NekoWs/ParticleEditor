/* =========================================================================
 * 属性面板 / 底部时间轴标尺 / 函数对象属性面板
 * 职责：
 *   1) 右侧属性面板回显与写入（updatePropPanel / setScaleInputs）
 *   2) 底部播放进度标尺与 scrub 自动平移（drawTimeline / scrubAutoPan）
 *   3) 函数对象属性面板与变量关键帧编辑（buildFunctionPanel / syncFunctionVarValues）
 * ======================================================================= */


import { t, tf } from '../core/i18n.js';
import { state, FUNCTION_PRESETS, getFunction, isDerivedParticle } from '../core/constants.js';
import { currentVisual } from '../core/animation.js';
import { currentSelected, selectedGroupName, fxPosDeltaAt, fxScaleValuesAt } from '../interaction/interaction.js';
import { groupCurrentCentroid, refreshParticleTree } from './tree.js';
import { modalAlert, rgbToHex, hexToRgb } from './ui.js';
import { varKfValue } from '../core/easing.js';
import { applyPresetBuild, rebuildFunctionObject } from '../core/generators.js';
import { openBlockDrawer } from './blocks-ui.js';
import { pushUndo } from '../state/undo.js';
import { r3 } from '../io/io.js';
// 设置缩放 XYZ 三输入（vals 为 [x,y,z]；null 元素表示混合值显示空）
export function setScaleInputs(vals) {
  ['prop-scale-x', 'prop-scale-y', 'prop-scale-z'].forEach((id, i) => {
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
  // 粒子缩放无 Z 分量：Z 输入仅在函数对象（整体缩放）时显示
  const scaleZ = document.getElementById('prop-scale-z');
  if (scaleZ) scaleZ.style.display = isFx ? '' : 'none';
  // 派生粒子基础属性只读；函数对象 pos/scl 可编辑（写整体轨道）
  const readOnly = !isFx && !gname && sel.some(isDerivedParticle);
  ['prop-color', 'prop-alpha', 'prop-glow', 'prop-light'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = readOnly || isFx || gname;
  });
  // 寿命：组也可统一设置（应用到全体成员），函数对象无寿命属性保持禁用
  const lifeEl0 = document.getElementById('prop-life');
  if (lifeEl0) lifeEl0.disabled = readOnly || isFx;
  ['prop-scale-x', 'prop-scale-y', 'prop-scale-z', 'prop-posx', 'prop-posy', 'prop-posz'].forEach(id => {
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
    return;
  }
  // 组：显示整体质心位置（缩放无独立显示）；寿命留空占位，填入即应用到全体成员
  if (gname) {
    const c = groupCurrentCentroid(gname, 'pos');
    document.getElementById('prop-posx').value = c[0].toFixed(2);
    document.getElementById('prop-posy').value = c[1].toFixed(2);
    document.getElementById('prop-posz').value = c[2].toFixed(2);
    setScaleInputs(null);
    const lifeElG = document.getElementById('prop-life');
    if (lifeElG) { lifeElG.value = ''; lifeElG.placeholder = '-'; }
    return;
  }
  const first = sel[0];
  const same = (fn) => sel.every(q => fn(q) === fn(first));

  const colorSame = same(q => q.color[0] + ',' + q.color[1] + ',' + q.color[2]);
  document.getElementById('prop-color').value = colorSame ? rgbToHex(first.color[0], first.color[1], first.color[2]) : '#808080';

  const aSame = same(q => q.color[3]);
  const aInput = document.getElementById('prop-alpha');
  if (aSame) { aInput.value = first.color[3]; document.getElementById('alpha-val').textContent = first.color[3].toFixed(2); }
  else { aInput.value = 0.5; document.getElementById('alpha-val').textContent = '-'; }

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

export function niceStep(range) {
  const rough = Math.max(1, range / 10);
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow;
  return (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * pow;
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

export function commitFunctionRebuild(fx) {
  try { rebuildFunctionObject(fx); }
  catch (e) { modalAlert(t('fx.exprError'), e.message); }
}

export function buildFunctionPanel(fx) {
  const wrap = document.createElement('div');
  wrap.className = 'fx-panel';

  const nameRow = document.createElement('label');
  nameRow.className = 'row';
  nameRow.textContent = t('fx.name');
  const nameIn = document.createElement('input');
  nameIn.type = 'text'; nameIn.value = fx.name;
  nameIn.onchange = () => { pushUndo(); fx.name = nameIn.value.trim() || fx.name; refreshParticleTree(); };
  nameRow.appendChild(nameIn);
  wrap.appendChild(nameRow);

  // 采样数（紧跟在名称下方）
  const countRow = document.createElement('label');
  countRow.className = 'row';
  countRow.textContent = t('fx.sampleCount');
  const countIn = document.createElement('input');
  countIn.type = 'number'; countIn.min = '1'; countIn.value = fx.count;
  countIn.onchange = () => { pushUndo(); fx.count = Math.max(1, Math.round(parseInt(countIn.value) || 1)); commitFunctionRebuild(fx); };
  countRow.appendChild(countIn);
  wrap.appendChild(countRow);

  // 中心点
  const centerRow = document.createElement('div');
  centerRow.className = 'row';
  const centerLabel = document.createElement('span');
  centerLabel.textContent = t('fx.center');
  centerRow.appendChild(centerLabel);
  ['X', 'Y', 'Z'].forEach((axis, idx) => {
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = '0.1'; inp.value = fx.center[idx];
    inp.style.width = '46px';
    inp.title = axis;
    inp.onchange = () => { pushUndo(); fx.center[idx] = parseFloat(inp.value) || 0; commitFunctionRebuild(fx); };
    centerRow.appendChild(document.createTextNode(axis));
    centerRow.appendChild(inp);
  });
  wrap.appendChild(centerRow);

  // 预设参数
  if (fx.preset && FUNCTION_PRESETS[fx.preset]) {
    const preset = FUNCTION_PRESETS[fx.preset];
    const pbox = document.createElement('div');
    pbox.className = 'fx-params';
    for (const prm of preset.params) {
      const row = document.createElement('label');
      row.className = 'row';
      row.textContent = t('fx.param.' + prm.key) + ' ';
      const inp = document.createElement('input');
      inp.type = 'number'; inp.step = '0.1'; inp.value = fx.params[prm.key] != null ? fx.params[prm.key] : prm.def;
      inp.onchange = () => {
        pushUndo();
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
  durIn.type = 'number'; durIn.min = '0'; durIn.value = fx.duration; durIn.style.width = '52px';
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

  // 拼图入口
  const codeLabel = document.createElement('div');
  codeLabel.className = 'row';
  codeLabel.textContent = t('fx.codeBlock');
  const puzzleBtn = document.createElement('button');
  puzzleBtn.className = 'mini';
  puzzleBtn.textContent = t('fx.puzzle');
  puzzleBtn.title = t('fx.puzzleHint');
  puzzleBtn.onclick = () => openBlockDrawer(fx);
  codeLabel.appendChild(puzzleBtn);
  wrap.appendChild(codeLabel);

  // Setup（对象初始化一次）
  const setupLabel = document.createElement('div');
  setupLabel.className = 'row';
  setupLabel.textContent = t('fx.setupBlock');
  wrap.appendChild(setupLabel);
  const setupArea = document.createElement('textarea');
  setupArea.className = 'fx-code';
  setupArea.rows = 4;
  setupArea.value = fx.setup || '';
  setupArea.onchange = () => { pushUndo(); fx.setup = setupArea.value; commitFunctionRebuild(fx); };
  wrap.appendChild(setupArea);

  // Process（每粒子每帧）
  const processLabel = document.createElement('div');
  processLabel.className = 'row';
  processLabel.textContent = t('fx.processBlock');
  wrap.appendChild(processLabel);
  const processArea = document.createElement('textarea');
  processArea.className = 'fx-code';
  processArea.rows = 7;
  processArea.value = fx.process || '';
  processArea.onchange = () => { pushUndo(); fx.process = processArea.value; commitFunctionRebuild(fx); };
  wrap.appendChild(processArea);

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
