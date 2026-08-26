/* =========================================================================
 * 属性面板
 * ======================================================================= */

// 设置缩放 XYZ 三输入（vals 为 [x,y,z]；null 元素表示混合值显示空）
function setScaleInputs(vals) {
  ['prop-scale-x', 'prop-scale-y', 'prop-scale-z'].forEach((id, i) => {
    const el = document.getElementById(id);
    if (!el) return;
    const v = vals == null ? null : vals[i];
    if (v == null) { el.value = ''; el.placeholder = '-'; }
    else { el.value = (typeof v === 'number' ? Math.round(v * 100) / 100 : v); el.placeholder = ''; }
  });
}

function updatePropPanel() {
  const sel = currentSelected();
  const fxId = state.selectedFunction;
  const isFx = !!fxId;
  const gname = selectedGroupName();
  if (sel.length === 0 && !isFx && !gname) return;
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
  const szSame = same(q => q.scale && q.scale[2]);
  setScaleInputs([sxSame ? first.scale[0] : null, sySame ? first.scale[1] : null, szSame ? first.scale[2] : null]);

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

function rgbToHex(r, g, b) {
  const c = v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

/* =========================================================================
 * 时间轴（底部：仅播放进度）
 * ======================================================================= */

const TL_PX_PER_TICK = 4;
let timelineViewStart = -25;
// 组件时间轴左侧负轴（负几个 tick）：tick 0 不贴画布左缘，
// 配合钉边缘余量让播放头/关键帧能真正停在 0t 上
const COMP_TL_MIN_VIEW_START = -5;
let compTimelineViewStart = COMP_TL_MIN_VIEW_START;

function drawTimeline() {
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
  // 每 5 tick 一条刻度线；每 10 tick 显示一次数字（图层区只画线不标数，避免重复）
  const step = 5;
  ctx.fillStyle = '#9aa0ad'; ctx.font = '10px sans-serif'; ctx.textBaseline = 'top';
  for (let t = Math.floor(timelineViewStart / step) * step; t <= viewEnd; t += step) {
    if (t < 0) continue;
    const x = (t - timelineViewStart) * pxPerTick;
    if (((t % 10) + 10) % 10 === 0) ctx.fillText(String(t), x + 2, 2);
    ctx.strokeStyle = '#3a3f4b'; ctx.beginPath(); ctx.moveTo(x, h / 2 - 6); ctx.lineTo(x, h / 2 + 6); ctx.stroke();
  }
  const phx = (state.time - timelineViewStart) * pxPerTick;
  ctx.strokeStyle = '#ffcc55'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(phx, 0); ctx.lineTo(phx, h); ctx.stroke();
  ctx.fillStyle = '#ffcc55'; ctx.beginPath(); ctx.moveTo(phx - 5, 0); ctx.lineTo(phx + 5, 0); ctx.lineTo(phx, 8); ctx.closePath(); ctx.fill();
}

function niceStep(range) {
  const rough = Math.max(1, range / 10);
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow;
  return (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * pow;
}

function timelineXToTick(clientX) {
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
function scrubAutoPan(drag, clientX, rect, viewStart, time, pxPerTick, minStart, pinMarginPx) {
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

function refreshFunctionPanel() {
  const box = document.getElementById('fx-panel');
  if (!box) return;
  const fx = getFunction(state.selectedFunction);
  if (!fx) { box.innerHTML = '<p class="hint">' + t('fx.noSelection') + '</p>'; return; }
  box.innerHTML = '';
  box.appendChild(buildFunctionPanel(fx));
}

function commitFunctionRebuild(fx) {
  try { rebuildFunctionObject(fx); }
  catch (e) { modalAlert(t('fx.exprError'), e.message); }
}

function buildFunctionPanel(fx) {
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
    inp.onchange = () => { fx.center[idx] = parseFloat(inp.value) || 0; pushUndo(); commitFunctionRebuild(fx); };
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

  // 公式代码块
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
  const codeArea = document.createElement('textarea');
  codeArea.className = 'fx-code';
  codeArea.rows = 7;
  codeArea.value = fx.code;
  codeArea.onchange = () => { pushUndo(); fx.code = codeArea.value; commitFunctionRebuild(fx); };
  wrap.appendChild(codeArea);

  // 变量表
  const vhead = document.createElement('div');
  vhead.className = 'vars-head';
  vhead.innerHTML = '<span>' + t('fx.varList') + '</span>';
  const vadd = document.createElement('button');
  vadd.className = 'mini'; vadd.textContent = '+';
  vadd.onclick = () => {
    pushUndo();
    let k = 0; while (('v' + k) in fx.vars) k++;
    fx.vars['v' + k] = { expr: '0', kf: [] };
    commitFunctionRebuild(fx); refreshFunctionPanel();
  };
  vhead.appendChild(vadd);
  wrap.appendChild(vhead);
  const vlist = document.createElement('div');
  vlist.className = 'fx-vars';
  for (const name of Object.keys(fx.vars)) vlist.appendChild(buildVarRow(fx, name));
  wrap.appendChild(vlist);

  return wrap;
}

function nextFreeTimeVar(kf, startTime) {
  let t = Math.max(0, Math.round(startTime));
  while (kf.some(k => k[0] === t)) t += 5;
  return t;
}

// 变量关键帧区展开状态（fx.id|name → bool，默认折叠）
const varExpandState = {};
// 每个变量一个色调（按变量顺序循环），关键帧列表背景色区分归属变量
const VAR_KF_PALETTE = ['#5b9dff', '#ffa94d', '#6bd489', '#e57fae', '#9d7bff', '#4fc3c9', '#e0c35b', '#ff7d6b'];
function varKfHue(fx, name) {
  const keys = Object.keys(fx.vars);
  return VAR_KF_PALETTE[Math.max(0, keys.indexOf(name)) % VAR_KF_PALETTE.length];
}

function buildVarRow(fx, name) {
  const v = fx.vars[name];
  const wrap = document.createElement('div');
  wrap.className = 'fx-var';
  const key = fx.id + '|' + name;
  const expanded = !!varExpandState[key];
  const kfs = v.kf || [];
  const hasKf = kfs.length > 0;

  const row = document.createElement('div');
  row.className = 'var-row';
  // 下拉按钮：只在展开时显示该变量的关键帧列表
  const fold = document.createElement('button');
  fold.className = 'var-fold' + (expanded ? ' open' : '');
  fold.textContent = expanded ? '▾' : '▸';
  fold.title = expanded ? t('fx.collapseKf') : t('fx.expandKf');
  fold.onclick = () => { varExpandState[key] = !expanded; refreshFunctionPanel(); };
  row.appendChild(fold);

  const nIn = document.createElement('input');
  nIn.className = 'var-name'; nIn.type = 'text'; nIn.value = name;
  const vIn = document.createElement('input');
  vIn.className = 'var-value'; vIn.type = 'text';
  vIn.disabled = hasKf;
  if (hasKf) {
    vIn.value = r3(varKfValue(kfs, state.time)).toFixed(2);
    vIn.dataset.fxKf = fx.id + '|' + name;
    vIn.classList.add('kf-synced');
    vIn.title = t('fx.kfSyncedHint');
  } else {
    vIn.value = v.expr || '0';
  }
  nIn.onchange = () => {
    pushUndo();
    const nn = nIn.value.trim();
    if (nn && nn !== name) {
      if (ATTR_NAMES.includes(nn)) { modalAlert(t('fx.varNameError'), tf('fx.varNameReserved', nn)); nIn.value = name; refreshFunctionPanel(); return; }
      fx.vars[nn] = fx.vars[name]; delete fx.vars[name];
    }
    commitFunctionRebuild(fx); refreshFunctionPanel();
  };
  vIn.onchange = () => { pushUndo(); fx.vars[name].expr = vIn.value.trim() || '0'; syncPresetCount(fx); commitFunctionRebuild(fx); };
  const del = document.createElement('button');
  del.className = 'del-x'; del.textContent = '×';
  del.onclick = () => { pushUndo(); delete fx.vars[name]; commitFunctionRebuild(fx); refreshFunctionPanel(); };
  row.appendChild(nIn); row.appendChild(vIn);
  if (hasKf && !expanded) {
    // 折叠时显示关键帧数量徽标（同变量色调）
    const badge = document.createElement('span');
    badge.className = 'kf-count';
    badge.textContent = '◇ ' + kfs.length;
    badge.title = t('fx.kfCountHint');
    badge.style.color = varKfHue(fx, name);
    row.appendChild(badge);
  }
  row.appendChild(del);
  wrap.appendChild(row);

  if (expanded) {
    const kfWrap = document.createElement('div');
    kfWrap.className = 'fx-kf';
    const hue = varKfHue(fx, name);
    kfWrap.style.background = hue + '1c';          // 低透明度背景
    kfWrap.style.borderLeft = '3px solid ' + hue;  // 色调左边线，区分归属变量
    kfs.forEach((k, idx) => kfWrap.appendChild(buildVarKfRow(fx, name, k, idx === 0)));
    const addBtn = document.createElement('button');
    addBtn.className = 'mini'; addBtn.textContent = t('fx.addKf');
    addBtn.onclick = () => {
      pushUndo();
      const v = fx.vars[name];
      if (!v.kf) v.kf = [];
      const kf = v.kf;
      const t = nextFreeTimeVar(kf, Math.round(state.time));
      let val = 0;
      if (kf.length === 0) {
        try {
          val = evaluate(v.expr || '0', { i: 0, n: fx.count, t: state.time });
        } catch (e) { val = 0; }
        if (typeof val !== 'number' || !isFinite(val)) val = 0;
      }
      kf.push([t, val, state.defaultEasing]);
      kf.sort((a, b) => a[0] - b[0]);
      commitFunctionRebuild(fx); refreshFunctionPanel();
    };
    kfWrap.appendChild(addBtn);
    wrap.appendChild(kfWrap);
  }
  return wrap;
}

function buildVarKfRow(fx, name, k, isFirst) {
  const row = document.createElement('div');
  row.className = 'kf-row';
  const tIn = document.createElement('input');
  tIn.className = 'kf-t'; tIn.type = 'number'; tIn.value = k[0];
  tIn.onchange = () => { pushUndo(); k[0] = Math.max(0, parseInt(tIn.value) || 0); fx.vars[name].kf.sort((a, b) => a[0] - b[0]); commitFunctionRebuild(fx); refreshFunctionPanel(); };
  row.appendChild(tIn);
  const vIn = document.createElement('input');
  vIn.className = 'kf-v'; vIn.type = 'number'; vIn.step = '0.01'; vIn.value = r3(k[1]);
  vIn.onchange = () => { pushUndo(); k[1] = parseFloat(vIn.value) || 0; commitFunctionRebuild(fx); };
  row.appendChild(vIn);
  if (!isFirst) {
    const easeBtn = makeEasingBtn(k[2], (easing) => { pushUndo(); k[2] = easing; commitFunctionRebuild(fx); });
    row.appendChild(easeBtn);
  }
  const del = document.createElement('button');
  del.className = 'del-x'; del.textContent = '×';
  del.onclick = () => { pushUndo(); fx.vars[name].kf = fx.vars[name].kf.filter(x => x !== k); commitFunctionRebuild(fx); refreshFunctionPanel(); };
  row.appendChild(del);
  return row;
}

// 实时同步「有关键帧」变量输入框显示的当前帧插值值（不重建面板）
function syncFunctionVarValues() {
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
