/* =========================================================================
 * 贴图编辑器 + 取色板 + 贴图文件管理 + UV 面板
 * 贴图数据：state.textures = { name: { width, height, data(Uint8ClampedArray RGBA) } }
 * UV 参数：继承覆盖（函数对象 fx.uv > 组 state.groupUV[gname] > 粒子 p.uv）
 * ======================================================================= */

const TEX_UV_COLOR = '#5b9dff'; // UV 预览描边（实线，与选中态 --accent 一致）
const TEX_SEL_COLOR = '#5b9dff'; // 选区描边（虚线，固定显示）
const TEX_CELL_COLOR = '#20242c'; // 动画帧范围线框（比像素网格更深的颜色）

const texState = {
  tool: 'select',           // select | pencil | eraser | bucket | picker
  color: [255, 255, 255, 255], // RGBA 0-255（当前颜色，含透明度）
  brushSize: 1,             // 铅笔/橡皮大小，1~128
  zoom: 8,                  // 显示缩放，0.1~32
  panX: 0, panY: 0,         // 平移（CSS px）
  selection: null,          // { x0, y0, x1, y1 } 像素，未归一化
  selecting: null,          // 正在拖选区的起始点
  hover: null,              // 当前悬停像素 { x, y }（铅笔/橡皮悬停描边用）
  undoStack: [], redoStack: [],
};

let texActive = false; // 鼠标是否在贴图编辑器区域内（用于 Ctrl+Z/Y 分流到贴图撤销）

// 实时时间（秒），驱动 flipbook 帧（与 shader uTime 一致）
function texAnimTime() { return performance.now() / 1000; }

/* =========================================================================
 * 贴图数据访问
 * ======================================================================= */

function getTexture(name) { return state.textures ? state.textures[name] : null; }
function getCurrentTexture() {
  return state.currentTexture ? getTexture(state.currentTexture) : null;
}

// 贴图数据变化时：重建 atlas 并刷新粒子渲染
function markTextureChanged() {
  if (typeof rebuildAtlas === 'function') rebuildAtlas();
  if (typeof rebuildPoints === 'function') rebuildPoints();
  setDirty(true);
}

// 当前空/新贴图尺寸（无贴图时 16×16）
function currentTexSize() {
  const t = getCurrentTexture();
  return t ? { w: t.width, h: t.height } : { w: 16, h: 16 };
}

// 规范化 UV 参数（贴图大小默认贴图分辨率，其余数值字段默认 0）
function normalizeUV(uv) {
  if (!uv) uv = {};
  const t = getTexture(uv.texture);
  const w = t ? t.width : ((uv.texSize && uv.texSize[0]) || 16);
  const h = t ? t.height : ((uv.texSize && uv.texSize[1]) || 16);
  const d = defaultUV(w, h);
  return {
    texture: uv.texture || null,
    mode: UV_MODES[uv.mode] ? uv.mode : d.mode,
    texSize: (uv.texSize || d.texSize).slice(0, 2),
    uvStart: (uv.uvStart || d.uvStart).slice(0, 2),
    uvSize: (uv.uvSize || d.uvSize).slice(0, 2),
    uvStep: (uv.uvStep || d.uvStep).slice(0, 2),
    fps: uv.fps != null ? uv.fps : d.fps,
    maxFrame: uv.maxFrame != null ? uv.maxFrame : d.maxFrame,
    loop: uv.loop != null ? !!uv.loop : d.loop,
  };
}

// UV 继承查询（f > g > p）；返回「生效的 UV 参数」与「来源」
function resolveUV(p) {
  if (p.uv && p.uv.texture) return { uv: normalizeUV(p.uv), src: p.id };
  const gs = groupMemberIndexCache && groupMemberIndexCache.get(p.id);
  if (gs) {
    for (const gname of gs) {
      const guv = state.groupUV && state.groupUV[gname];
      if (guv && guv.texture) return { uv: normalizeUV(guv), src: 'g:' + gname };
    }
  }
  if (p.fx) {
    const fx = getFunction(p.fx);
    if (fx && fx.uv && fx.uv.texture) return { uv: normalizeUV(fx.uv), src: 'f:' + fx.id };
  }
  return { uv: defaultUV(16, 16), src: null };
}

// 当前编辑作用域（函数对象 > 组 > 粒子多选）
function currentUVTarget() {
  if (state.selectedFunction) return { kind: 'fx', key: state.selectedFunction };
  const g = selectedGroupName();
  if (g) return { kind: 'group', key: g };
  if (state.selected.size > 0) return { kind: 'particle', key: [...state.selected] };
  return null;
}

function readTargetUV(t) {
  if (!t) return null;
  if (t.kind === 'fx') { const fx = getFunction(t.key); return fx ? normalizeUV(fx.uv) : null; }
  if (t.kind === 'group') { return state.groupUV[t.key] ? normalizeUV(state.groupUV[t.key]) : null; }
  const p = getParticle(t.key[0]); return p ? normalizeUV(p.uv) : null;
}

function writeTargetUV(t, uv) {
  if (!t) return;
  pushUndo();
  if (t.kind === 'fx') { const fx = getFunction(t.key); if (fx) fx.uv = uv; }
  else if (t.kind === 'group') { state.groupUV[t.key] = uv; }
  else { for (const id of t.key) { const p = getParticle(id); if (p && !isDerivedParticle(p)) p.uv = uv; } }
  setDirty(true);
  if (typeof rebuildPoints === 'function') rebuildPoints(false);
}

/* =========================================================================
 * 画布渲染
 * ======================================================================= */

const texCanvas = () => document.getElementById('tex-canvas');
const texCanvasWrap = () => document.getElementById('tex-canvas-wrap');

// 只在尺寸变化时设置 canvas 内尺寸（设置 width/height 会清空内容，避免无谓重置）
function ensureCanvasSize() {
  const c = texCanvas();
  const { w, h } = currentTexSize();
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
}

// 仅更新 CSS 尺寸/平移（不清空像素内容）
function applyTexView() {
  const c = texCanvas();
  const { w, h } = currentTexSize();
  c.style.width = Math.round(w * texState.zoom) + 'px';
  c.style.height = Math.round(h * texState.zoom) + 'px';
  c.style.transform = 'translate(' + texState.panX + 'px, ' + texState.panY + 'px)';
  // canvas 的视口位置变化后，预览描边 overlay 需重新定位对齐像素
  updateTexOverlay();
}

function renderTexCanvas() {
  const c = texCanvas();
  if (!c) return;
  ensureCanvasSize();
  applyTexView();
  const ctx = c.getContext('2d');
  const { w, h } = currentTexSize();
  ctx.clearRect(0, 0, w, h);
  const img = ctx.createImageData(w, h);
  const t = getCurrentTexture();
  if (t && t.data) img.data.set(t.data.slice(0, w * h * 4));
  ctx.putImageData(img, 0, 0);
  updateTexOverlay();
  updateTexMeta();
}

// 黑白对比描边颜色：采样矩形外圈像素亮度判断
function contrastColorAt(x0, y0, w, h) {
  const t = getCurrentTexture();
  if (!t) return '#ffffff';
  let sum = 0, n = 0;
  const sample = (px, py) => {
    if (px < 0 || py < 0 || px >= t.width || py >= t.height) return;
    const i = (py * t.width + px) * 4;
    sum += 0.299 * t.data[i] + 0.587 * t.data[i + 1] + 0.114 * t.data[i + 2];
    n++;
  };
  for (let px = x0; px < x0 + w; px++) { sample(px, y0 - 1); sample(px, y0 + h); }
  for (let py = y0; py < y0 + h; py++) { sample(x0 - 1, py); sample(x0 + w, py); }
  const avg = n ? sum / n : 128;
  return avg > 128 ? '#000000' : '#ffffff';
}

// UV 预览当前帧（动画模式按墙钟计算；与 shader uTime 一致）。
// 帧数 = 常量层共享的自动帧数（按 UV 步长+贴图尺寸）∩ 用户上限，与渲染 render 完全一致。
function currentUVFrame(uv) {
  if (!uv) return 0;
  const t = getTexture(uv.texture);
  const autoFrames = autoFramesFor(uv, t ? t.width : 16, t ? t.height : 16);
  const maxF = effMaxFrame(uv, autoFrames);
  const frame = Math.floor(texAnimTime() * (uv.fps || 1));
  return uv.loop ? ((frame % maxF) + maxF) % maxF : Math.min(frame, maxF - 1);
}

// 预览描边统一走 CSS overlay（.tex-overlay）层：
// 在贴图像素边缘绘制屏幕 1px 的细线，不写入像素数据，放大后依旧是细线
function updateTexOverlay() {
  const wrap = texCanvasWrap();
  const c = texCanvas();
  const frame = document.getElementById('tex-overlay-frame');
  const uv = document.getElementById('tex-overlay-uv');
  const sel = document.getElementById('tex-overlay-sel');
  const cells = document.getElementById('tex-overlay-cells');
  const grid = document.getElementById('tex-grid');
  if (!wrap || !c || !frame || !uv || !sel || !cells || !grid) return;
  const wr = wrap.getBoundingClientRect();
  const cr = c.getBoundingClientRect();
  const ox = cr.left - wr.left, oy = cr.top - wr.top; // canvas 相对 wrap 的偏移（已含居中与 pan 平移）
  const z = texState.zoom;
  const { w: texWpx, h: texHpx } = currentTexSize();

  // 像素网格层：与画布完全对齐，每像素一条网格线（颜色与画布边框 var(--border) 一致）
  grid.style.display = 'block';
  grid.style.left = ox + 'px';
  grid.style.top = oy + 'px';
  grid.style.width = Math.round(texWpx * z) + 'px';
  grid.style.height = Math.round(texHpx * z) + 'px';
  grid.style.setProperty('--cell', z + 'px');

  const setBox = (el, x, y, w, h, color, dashed) => {
    if (w <= 0 || h <= 0) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.style.left = (ox + x * z) + 'px';
    el.style.top = (oy + y * z) + 'px';
    el.style.width = Math.max(1, Math.round(w * z)) + 'px';
    el.style.height = Math.max(1, Math.round(h * z)) + 'px';
    el.style.borderColor = color;
    el.style.borderStyle = dashed ? 'dashed' : 'solid';
  };

  // UV 预览框（浅蓝实线；fill 全图；静态/动画显示当前采样区域）。
  // 仅当目标 UV 引用的贴图 == 当前打开的贴图时才显示：预览框的像素坐标是相对贴图自身的，
  // 若画布打开的是另一张贴图会绘制到错误位置/尺寸（表现为「显示另一个贴图/错误的 UV 大小预览」）。
  const t = currentUVTarget();
  const u = t ? readTargetUV(t) : null;
  const uvMatches = !!(u && u.texture && u.texture === state.currentTexture);
  const ttex = u && u.texture ? getTexture(u.texture) : null;
  // uvSize 为 0 表示铺满整张贴图（与 computeParticleUV 的 out.sw = uvSize || tex.w 一致）
  const effFw = u && ttex ? (u.uvSize[0] || ttex.width) : 0;
  const effFh = u && ttex ? (u.uvSize[1] || ttex.height) : 0;
  if (uvMatches) {
    if (u.mode === 'fill') {
      const s = currentTexSize();
      setBox(uv, 0, 0, s.w, s.h, TEX_UV_COLOR, false);
    } else {
      let sx = u.uvStart[0], sy = u.uvStart[1];
      if (u.mode === 'animated') {
        const f = currentUVFrame(u);
        // 行主 flipbook，与 Kotlin currentUvStart / shader 完全一致：
        // 先沿 x 步进填满一行，再换行沿 y 步进；单列（stepx=0）退化为纯竖向。
        const texW = ttex ? ttex.width : 16;
        const stepx = u.uvStep[0] || 0;
        const startX = u.uvStart[0] || 0;
        const cols = (stepx > 0 && startX < texW) ? Math.floor((texW - 1 - startX) / stepx) + 1 : 1;
        sx += stepx * (f % cols);
        sy += (u.uvStep[1] || 0) * Math.floor(f / cols);
      }
      setBox(uv, sx, sy, effFw, effFh, TEX_UV_COLOR, false);
    }
  } else {
    setBox(uv, 0, 0, 0, 0, '', false);
  }

  // 动画模式：帧覆盖范围线框（比网格深一些），提示 UV 步进后每帧的实际范围；
  // 内部按 uvStep 分格，逐帧可对齐
  if (uvMatches && u.mode === 'animated' && ttex && effFw > 0 && effFh > 0) {
    const stepx = u.uvStep[0] || 0, stepy = u.uvStep[1] || 0;
    const startX = u.uvStart[0] || 0, startY = u.uvStart[1] || 0;
    const cols = (stepx > 0 && startX < ttex.width) ? Math.floor((ttex.width - 1 - startX) / stepx) + 1 : 1;
    const maxF = effMaxFrame(u, autoFramesFor(u, ttex.width, ttex.height));
    const lastCol = (maxF - 1) % cols, lastRow = Math.floor((maxF - 1) / cols);
    const spanW = stepx * lastCol + effFw, spanH = stepy * lastRow + effFh;
    setBox(cells, startX, startY, spanW, spanH, TEX_CELL_COLOR, false);
    if (stepx > 0 || stepy > 0) {
      const gx = stepx > 0 ? 'repeating-linear-gradient(to right, ' + TEX_CELL_COLOR + ' 0, ' + TEX_CELL_COLOR + ' 1px, transparent 1px, transparent ' + (stepx * z) + 'px)' : '';
      const gy = stepy > 0 ? 'repeating-linear-gradient(to bottom, ' + TEX_CELL_COLOR + ' 0, ' + TEX_CELL_COLOR + ' 1px, transparent 1px, transparent ' + (stepy * z) + 'px)' : '';
      cells.style.backgroundImage = gx + (gx && gy ? ', ' : '') + gy;
    } else {
      cells.style.backgroundImage = 'none';
    }
  } else {
    setBox(cells, 0, 0, 0, 0, '', false);
  }

  // 选区描边：固定显示（不受工具/悬停影响）
  const sr = selectionRect();
  if (sr) {
    setBox(sel, sr.x, sr.y, sr.w, sr.h, TEX_SEL_COLOR, true);
  } else {
    setBox(sel, 0, 0, 0, 0, '', false);
  }

  // 悬停描边（铅笔：显示将绘制的刷子范围）
  const hov = texState.hover;
  if (hov && texState.tool === 'pencil') {
    const r = Math.floor(texState.brushSize / 2);
    setBox(frame, hov.x - r, hov.y - r, texState.brushSize, texState.brushSize,
      contrastColorAt(hov.x - r, hov.y - r, texState.brushSize, texState.brushSize), false);
  } else {
    setBox(frame, 0, 0, 0, 0, '', false);
  }
}

function updateTexMeta() {
  const el = document.getElementById('tex-meta');
  if (el) { const { w, h } = currentTexSize(); el.textContent = w + ' × ' + h; }
}

function texPixelAt(ev) {
  const c = texCanvas();
  const rect = c.getBoundingClientRect();
  return {
    x: Math.floor((ev.clientX - rect.left) / texState.zoom),
    y: Math.floor((ev.clientY - rect.top) / texState.zoom),
  };
}

// 在像素 (x,y) 画一块（画笔大小范围；绘制不再被选区限制），返回是否修改
function paintArea(x, y, apply) {
  const { w, h } = currentTexSize();
  const r = Math.floor(texState.brushSize / 2);
  const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
  const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
  let changed = false;
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      if (apply(px, py)) changed = true;
    }
  }
  return changed;
}

function pushTexUndo() {
  const t = getCurrentTexture();
  const { w, h } = currentTexSize();
  const snap = t && t.data ? t.data.slice(0, w * h * 4) : null;
  texState.undoStack.push(snap);
  if (texState.undoStack.length > 100) texState.undoStack.shift();
  texState.redoStack.length = 0;
}
function texUndo() {
  const t = getCurrentTexture();
  if (!t || texState.undoStack.length === 0) return;
  texState.redoStack.push(t.data.slice());
  t.data = texState.undoStack.pop();
  renderTexCanvas();
  if (typeof rebuildAtlas === 'function') rebuildAtlas();
  setDirty(true);
}
function texRedo() {
  const t = getCurrentTexture();
  if (!t || texState.redoStack.length === 0) return;
  texState.undoStack.push(t.data.slice());
  t.data = texState.redoStack.pop();
  renderTexCanvas();
  if (typeof rebuildAtlas === 'function') rebuildAtlas();
  setDirty(true);
}

function texSetPixel(px, py) {
  const t = getCurrentTexture();
  if (!t) return;
  const i = (py * t.width + px) * 4;
  t.data[i] = texState.color[0];
  t.data[i + 1] = texState.color[1];
  t.data[i + 2] = texState.color[2];
  t.data[i + 3] = texState.color[3];
}
function texGetPixel(px, py) {
  const t = getCurrentTexture();
  if (!t || px < 0 || py < 0 || px >= t.width || py >= t.height) return null;
  const i = (py * t.width + px) * 4;
  return [t.data[i], t.data[i + 1], t.data[i + 2], t.data[i + 3]];
}
function texErasePixel(px, py) {
  const t = getCurrentTexture();
  if (!t) return;
  const i = (py * t.width + px) * 4;
  t.data[i] = 0; t.data[i + 1] = 0; t.data[i + 2] = 0; t.data[i + 3] = 0;
}
function floodFill(px, py, target, apply) {
  const { w, h } = currentTexSize();
  const key = (x, y) => y * w + x;
  const start = texGetPixel(px, py);
  if (!start) return 0;
  const eq = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
  if (eq(start, target)) return 0;
  const stack = [[px, py]];
  const seen = new Uint8Array(w * h);
  let n = 0;
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    if (seen[key(x, y)]) continue;
    seen[key(x, y)] = 1;
    const cur = texGetPixel(x, y);
    if (!eq(cur, start)) continue;
    apply(x, y);
    n++;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return n;
}

/* =========================================================================
 * 编辑器交互（事件挂到 wrap，兼容灰色区域平移/缩放）
 * ======================================================================= */

let texDrag = null; // { mode: 'draw'|'pan'|'select'|'selmove'|'erase', last }

// 选区像素矩形（取整归一化）；无选区/宽高为 0 返回 null
function selectionRect() {
  const s = texState.selection;
  if (!s) return null;
  const x = Math.floor(Math.min(s.x0, s.x1)), y = Math.floor(Math.min(s.y0, s.y1));
  const w = Math.floor(Math.abs(s.x1 - s.x0)), h = Math.floor(Math.abs(s.y1 - s.y0));
  return w < 1 || h < 1 ? null : { x, y, w, h };
}
function clearRegion(x, y, w, h) {
  const t = getCurrentTexture(); if (!t) return;
  const x0 = Math.max(0, x), y0 = Math.max(0, y);
  const x1 = Math.min(t.width, x + w), y1 = Math.min(t.height, y + h);
  for (let yy = y0; yy < y1; yy++) {
    const i0 = yy * t.width * 4 + x0 * 4;
    t.data.fill(0, i0, i0 + (x1 - x0) * 4);
  }
}
function stampRegion(t, snap, x, y, w, h) {
  // 允许目标位置在贴图外：仅盖章贴图内的部分（溢出舍弃）
  const x0 = Math.max(0, x), y0 = Math.max(0, y);
  const x1 = Math.min(t.width, x + w), y1 = Math.min(t.height, y + h);
  for (let yy = y0; yy < y1; yy++) {
    const srcOff = ((yy - y) * w + (x0 - x)) * 4;
    t.data.set(snap.subarray(srcOff, srcOff + (x1 - x0) * 4), (yy * t.width + x0) * 4);
  }
}

// Alt 临时吸管：按住切到 picker，松开切回上一个工具（仅鼠标在贴图编辑器内时生效）
let texAltPreviewOn = false;
let texPreAltTool = null;
function texAltPreview(on) {
  if (on) {
    if (texState.tool === 'picker') return;
    texPreAltTool = texState.tool;
    texState.tool = 'picker';
    texAltPreviewOn = true;
  } else {
    if (!texAltPreviewOn) return;
    texAltPreviewOn = false;
    texState.tool = texPreAltTool || 'pencil';
    texPreAltTool = null;
  }
  document.querySelectorAll('.tex-tool[data-ttool]').forEach(b => b.classList.toggle('active', b.dataset.ttool === texState.tool));
  toggleColorButton(texState.tool === 'pencil' || texState.tool === 'bucket');
  texState.hover = null;
  renderTexCanvas();
}
window.addEventListener('keydown', (e) => { if (e.key === 'Alt' && texActive) { e.preventDefault(); texAltPreview(true); } });
window.addEventListener('keyup', (e) => { if (e.key === 'Alt') { e.preventDefault(); texAltPreview(false); } });
window.addEventListener('blur', () => texAltPreview(false));

function initTextureEditor() {
  const wrap = texCanvasWrap();
  const c = texCanvas();
  if (!wrap || !c) return;
  refreshTexturePanel();

  wrap.addEventListener('pointerenter', () => { texActive = true; });
  wrap.addEventListener('pointerleave', () => { texActive = false; });

  wrap.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    if (ev.button === 1) { // 中键拖动：平移（灰色区域亦有效）
      texDrag = { mode: 'pan', x: ev.clientX, y: ev.clientY, panX: texState.panX, panY: texState.panY };
      wrap.setPointerCapture(ev.pointerId);
      return;
    }
    if (ev.button === 2) { // 右键按住：临时橡皮擦（松开回到原工具）
      if (!getCurrentTexture()) createNewTexture(); // 无贴图时自动创建
      texDrag = { mode: 'erase', last: texPixelAt(ev) };
      pushTexUndo();
      wrap.setPointerCapture(ev.pointerId);
      applyStroke(texDrag.last, 'erase');
      return;
    }
    if (ev.button !== 0) return;
    const p = texPixelAt(ev);
    if (ev.altKey) { // Alt 临时吸管（指针处取色）
      const col = texGetPixel(p.x, p.y);
      if (col) { texState.color = col.slice(); updateColorButton(); }
      return;
    }
    const selRect = selectionRect();
    const insideSel = texState.tool === 'selmove' && selRect && p.x >= selRect.x && p.x < selRect.x + selRect.w && p.y >= selRect.y && p.y < selRect.y + selRect.h;
    // 已有选区时：任意工具点击（selmove 选区内部除外）先去掉当前选区
    if (texState.selection && !insideSel) {
      texState.selection = null;
      texState.selecting = null;
      renderTexCanvas();
    }
    if (texState.tool === 'select' || (texState.tool === 'selmove' && !insideSel)) {
      // 拖出新矩形选区
      texDrag = { mode: 'select', x0: p.x, y0: p.y };
      texState.selecting = { x0: p.x, y0: p.y };
      wrap.setPointerCapture(ev.pointerId);
      return;
    }
    if (texState.tool === 'selmove' && insideSel) {
      // 在选区内按下：移动选区内容（剪下 + 贴到新位置）
      const t = getCurrentTexture();
      if (t) {
        const snap = new Uint8ClampedArray(selRect.w * selRect.h * 4);
        for (let y = 0; y < selRect.h; y++) snap.set(t.data.subarray(((selRect.y + y) * t.width + selRect.x) * 4, ((selRect.y + y) * t.width + selRect.x + selRect.w) * 4), y * selRect.w * 4);
        pushTexUndo();
        clearRegion(selRect.x, selRect.y, selRect.w, selRect.h);
        texDrag = { mode: 'selmove', snap, w: selRect.w, h: selRect.h, grabX: p.x - selRect.x, grabY: p.y - selRect.y, prevX: selRect.x, prevY: selRect.y };
        wrap.setPointerCapture(ev.pointerId);
        renderTexCanvas();
        return;
      }
    }
    const { w, h } = currentTexSize();
    if (p.x < 0 || p.y < 0 || p.x >= w || p.y >= h) return; // 画布外不绘制
    if (texState.tool === 'picker') {
      const col = texGetPixel(p.x, p.y);
      if (col) { texState.color = col.slice(); updateColorButton(); }
      return;
    }
    if (texState.tool === 'bucket') {
      if (!getCurrentTexture()) createNewTexture(); // 无贴图时自动创建
      pushTexUndo();
      floodFill(p.x, p.y, texState.color, texSetPixel);
      renderTexCanvas();
      if (typeof rebuildAtlas === 'function') rebuildAtlas();
      setDirty(true);
      return;
    }
    // 铅笔等绘制工具：无贴图时自动创建一个 16×16 贴图再绘制
    if (!getCurrentTexture()) createNewTexture();
    texDrag = { mode: texState.tool, last: p };
    pushTexUndo();
    applyStroke(p, texDrag.mode);
  });

  wrap.addEventListener('pointermove', (ev) => {
    if (texDrag) {
      if (texDrag.mode === 'pan') {
        texState.panX = texDrag.panX + (ev.clientX - texDrag.x);
        texState.panY = texDrag.panY + (ev.clientY - texDrag.y);
        applyTexView();
        return;
      }
      if (texDrag.mode === 'select') {
        const p = texPixelAt(ev);
        texState.selection = { x0: texDrag.x0, y0: texDrag.y0, x1: p.x, y1: p.y };
        renderTexCanvas();
        return;
      }
      if (texDrag.mode === 'selmove') {
        const p = texPixelAt(ev);
        const t = getCurrentTexture();
        if (t) {
          // 允许移动到贴图外：不 clamp，越界部分由 clear/stamp 裁剪舍弃
          const nx = p.x - texDrag.grabX;
          const ny = p.y - texDrag.grabY;
          if (nx !== texDrag.prevX || ny !== texDrag.prevY) {
            clearRegion(texDrag.prevX, texDrag.prevY, texDrag.w, texDrag.h); // 清除上一盖章位置残影（边界内部分）
            stampRegion(t, texDrag.snap, nx, ny, texDrag.w, texDrag.h);     // 贴图内部分才盖章
            texDrag.prevX = nx; texDrag.prevY = ny;
            texState.selection = { x0: nx, y0: ny, x1: nx + texDrag.w, y1: ny + texDrag.h };
            renderTexCanvas();
          }
        }
        return;
      }
      const p = texPixelAt(ev);
      applyStroke(p, texDrag.mode);
      return;
    }
    // 悬停描边（铅笔）
    if (texState.tool === 'pencil') {
      const p = texPixelAt(ev);
      if (!texState.hover || texState.hover.x !== p.x || texState.hover.y !== p.y) {
        texState.hover = p;
        renderTexCanvas();
      }
    }
  });

  wrap.addEventListener('pointerup', () => {
    if (texDrag && texDrag.mode === 'select') {
      const s = texState.selection;
      if (s && Math.abs(s.x1 - s.x0) < 1 && Math.abs(s.y1 - s.y0) < 1) texState.selection = null;
      renderTexCanvas();
    }
    const suppressCtx = texDrag && (texDrag.mode === 'pan' || texDrag.mode === 'erase' || texDrag.mode === 'selmove');
    if (texDrag && texDrag.mode === 'selmove') {
      if (typeof rebuildAtlas === 'function') rebuildAtlas();
      setDirty(true);
    }
    texDrag = null;
    texState.selecting = null;
    // 中键平移/右键橡皮擦松开瞬间，浏览器可能在外部元素上补发 contextmenu（此时 texDrag 已置空，
    // 靠短暂时间窗口抑制）。捕获保证 pointerup 仍落回 wrap。
    if (suppressCtx) texCtxSuppressUntil = performance.now() + 400;
  });

  wrap.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    if (ev.altKey) {
      const d = ev.deltaY < 0 ? 1 : -1;
      texState.brushSize = Math.max(1, Math.min(128, texState.brushSize + d));
      renderTexCanvas();
      return;
    }
    const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
    texState.zoom = Math.max(0.1, Math.min(32, texState.zoom * factor));
    applyTexView();
  }, { passive: false });

  wrap.addEventListener('contextmenu', (ev) => ev.preventDefault());

  // 右键/中键拖拽时，指针可能离开编辑器页面并在外部释放——window 级抑制浏览器右键菜单。
  // 用「时间窗口」而非 texDrag 现场判断：contextmenu 事件普遍在 pointerup 之后派发，
  // 此时 texDrag 已复位，故松开时打一个 400ms 抑制标记。
  let texCtxSuppressUntil = 0;
  window.addEventListener('contextmenu', (ev) => {
    if ((texDrag && (texDrag.mode === 'pan' || texDrag.mode === 'erase')) || performance.now() < texCtxSuppressUntil) ev.preventDefault();
  });

  // 工具切换
  document.getElementById('tex-tools').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.tex-tool');
    if (!btn) return;
    if (btn.id === 'tex-undo') { texUndo(); return; }
    if (btn.id === 'tex-redo') { texRedo(); return; }
    texAltPreviewOn = false; texPreAltTool = null; // 手动切工具时退出 Alt 预览
    texState.tool = btn.dataset.ttool;
    document.querySelectorAll('.tex-tool[data-ttool]').forEach(b => b.classList.toggle('active', b === btn));
    toggleColorButton(texState.tool === 'pencil' || texState.tool === 'bucket');
    if (texState.tool !== 'pencil' && texState.tool !== 'eraser') texState.hover = null;
    renderTexCanvas();
  });

  // 颜色按钮 → 取色板
  document.getElementById('tex-color-btn').addEventListener('click', (ev) => {
    openColorPicker(ev.clientX, ev.clientY, texState.color, (rgba) => {
      texState.color = rgba;
      updateColorButton();
    });
  });

  // 文件操作
  document.getElementById('btn-tex-upload').addEventListener('click', () => document.getElementById('tex-upload').click());
  document.getElementById('tex-upload').addEventListener('change', async (ev) => { const f = ev.target.files[0]; if (f) await uploadTextureFile(f); ev.target.value = ''; });
  document.getElementById('btn-tex-new').addEventListener('click', createNewTexture);
  document.getElementById('btn-tex-export').addEventListener('click', exportTexture);

  updateColorButton();
}

function toggleColorButton(show) {
  document.getElementById('tex-color-btn').style.display = show ? 'block' : 'none';
}
function updateColorButton() {
  const btn = document.getElementById('tex-color-btn');
  if (btn) btn.style.background = rgbaToCss(texState.color);
}

// 铅笔/橡皮一笔（连线补间）
function applyStroke(p, mode) {
  if (!texDrag || !texDrag.last) { paintAt(p, mode); texDrag.last = p; return; }
  const a = texDrag.last, b = p;
  const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(a.x + (b.x - a.x) * i / Math.max(1, steps));
    const y = Math.round(a.y + (b.y - a.y) * i / Math.max(1, steps));
    paintAt({ x, y }, mode);
  }
  texDrag.last = p;
}
function paintAt(p, mode) {
  const t = getCurrentTexture();
  if (!t) return;
  if (mode === 'eraser' || mode === 'erase') paintArea(p.x, p.y, (x, y) => { texErasePixel(x, y); return true; });
  else paintArea(p.x, p.y, (x, y) => { texSetPixel(x, y); return true; });
  renderTexCanvas();
  if (typeof rebuildAtlas === 'function') rebuildAtlas();
  setDirty(true);
}

/* =========================================================================
 * 取色板（HSV + alpha）
 * ======================================================================= */

function rgbaToCss(rgba) {
  return 'rgba(' + rgba[0] + ',' + rgba[1] + ',' + rgba[2] + ',' + (rgba[3] / 255).toFixed(3) + ')';
}

function openColorPicker(x, y, rgba, onCommit) {
  closeColorPicker();
  const box = document.createElement('div');
  box.className = 'color-picker';
  box.id = 'color-picker-pop';

  const sv = document.createElement('div'); sv.className = 'cp-sv';
  const svThumb = document.createElement('div'); svThumb.className = 'cp-sv-thumb';
  sv.appendChild(svThumb);
  const hue = document.createElement('div'); hue.className = 'cp-hue';
  const alpha = document.createElement('div'); alpha.className = 'cp-alpha';
  const row = document.createElement('div'); row.className = 'cp-row';
  const hex = document.createElement('input'); hex.className = 'cp-hex'; hex.type = 'text'; hex.maxLength = 9;
  const okBtn = document.createElement('button');
  okBtn.className = 'mini'; okBtn.textContent = t('common.ok');
  row.appendChild(hex); row.appendChild(okBtn);

  let hsv = rgbToHsv(rgba);
  let a = rgba[3] / 255;

  const paintSV = () => { sv.style.background = 'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(' + hsv[0] + ',100%,50%))'; };
  const paintHue = () => { hue.style.background = 'linear-gradient(to right, #f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)'; };
  const paintAlpha = () => { const c = hsvToRgb([hsv[0], hsv[1], hsv[2]]); alpha.style.background = 'linear-gradient(to right, transparent, rgb(' + c[0] + ',' + c[1] + ',' + c[2] + '))'; };
  const sync = () => {
    svThumb.style.left = (hsv[1] * 100) + '%';
    svThumb.style.top = ((1 - hsv[2]) * 100) + '%';
    const c = hsvToRgb([hsv[0], hsv[1], hsv[2]]);
    hex.value = '#' + c.map(v => v.toString(16).padStart(2, '0')).join('') + (a < 1 ? Math.round(a * 255).toString(16).padStart(2, '0') : '');
    paintAlpha();
    // 实时同步编辑器颜色：拖动/输入即时生效，无需点确定
    texState.color = [c[0], c[1], c[2], Math.round(a * 255)];
    updateColorButton();
  };
  paintSV(); paintHue(); sync();

  sv.addEventListener('pointerdown', (ev) => {
    sv.setPointerCapture(ev.pointerId);
    const move = (e) => {
      const r = sv.getBoundingClientRect();
      hsv[1] = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      hsv[2] = 1 - Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
      sync();
    };
    move(ev);
    sv.addEventListener('pointermove', move);
    sv.addEventListener('pointerup', () => sv.removeEventListener('pointermove', move), { once: true });
  });
  hue.addEventListener('pointerdown', (ev) => {
    hue.setPointerCapture(ev.pointerId);
    const move = (e) => {
      const r = hue.getBoundingClientRect();
      hsv[0] = Math.max(0, Math.min(360, (e.clientX - r.left) / r.width * 360));
      paintSV(); sync();
    };
    move(ev);
    hue.addEventListener('pointermove', move);
    hue.addEventListener('pointerup', () => hue.removeEventListener('pointermove', move), { once: true });
  });
  alpha.addEventListener('pointerdown', (ev) => {
    alpha.setPointerCapture(ev.pointerId);
    const move = (e) => {
      const r = alpha.getBoundingClientRect();
      a = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      sync();
    };
    move(ev);
    alpha.addEventListener('pointermove', move);
    alpha.addEventListener('pointerup', () => alpha.removeEventListener('pointermove', move), { once: true });
  });

  const commit = () => {
    const c = hsvToRgb([hsv[0], hsv[1], hsv[2]]);
    const out = [c[0], c[1], c[2], Math.round(a * 255)];
    texState.color = out;
    updateColorButton();
    closeColorPicker();
    if (onCommit) onCommit(out);
  };
  hex.addEventListener('change', () => {
    const v = hex.value.replace('#', '');
    if (/^[0-9a-fA-F]{6}$/.test(v)) {
      hsv = rgbToHsv([parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]);
      paintSV(); sync();
    } else if (/^[0-9a-fA-F]{8}$/.test(v)) {
      hsv = rgbToHsv([parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]);
      a = parseInt(v.slice(6, 8), 16) / 255;
      paintSV(); sync();
    }
  });
  okBtn.onclick = commit;

  box.appendChild(sv); box.appendChild(hue); box.appendChild(alpha); box.appendChild(row);
  document.body.appendChild(box);
  box.style.left = Math.min(x, window.innerWidth - 240) + 'px';
  box.style.top = Math.min(y, window.innerHeight - 250) + 'px';
}
function closeColorPicker() { const b = document.getElementById('color-picker-pop'); if (b) b.remove(); }
window.addEventListener('pointerdown', (e) => { if (!e.target.closest('#color-picker-pop') && !e.target.closest('#tex-color-btn')) closeColorPicker(); });

function rgbToHsv(rgb) {
  const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return [h, s, max];
}
function hsvToRgb(hsv) {
  const h = hsv[0], s = hsv[1], v = hsv[2];
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/* =========================================================================
 * 文件：上传 / 新建 / 保存
 * ======================================================================= */

function makeTexture(name, w, h, data) {
  const t = { name, width: w, height: h, data: data || new Uint8ClampedArray(w * h * 4) };
  state.textures[name] = t;
  state.currentTexture = name;
  texState.selection = null;
  texState.zoom = 8; texState.panX = 0; texState.panY = 0;
  texState.undoStack.length = 0; texState.redoStack.length = 0;
  return t;
}

async function uploadTextureFile(file) {
  if (file.size > 5 * 1024 * 1024) { await modalAlert(t('alert.uploadFailed'), t('alert.texTooBig')); return; }
  if (!file.name.toLowerCase().endsWith('.png')) { await modalAlert(t('alert.uploadFailed'), t('alert.pngOnly')); return; }
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch (e) { await modalAlert(t('alert.uploadFailed'), t('alert.pngParseFail')); return; }
  const w = bmp.width, h = bmp.height;
  const cnv = document.createElement('canvas'); cnv.width = w; cnv.height = h;
  const ctx = cnv.getContext('2d'); ctx.drawImage(bmp, 0, 0);
  const data = new Uint8ClampedArray(ctx.getImageData(0, 0, w, h).data);
  const base = file.name.replace(/\.png$/i, '') || 'tex';
  const name = await modalPrompt(t('tex.upload'), base, t('tex.namePrompt'));
  if (!name || !name.trim()) return;
  let n = name.trim(), k = 1;
  while (getTexture(n)) n = name.trim() + '_' + (k++);
  makeTexture(n, w, h, data);
  renderTexCanvas();
  if (typeof refreshTexBase64Cache === 'function') refreshTexBase64Cache();
  markTextureChanged();
  refreshUVPanel();
  refreshTexList();
}

// 新建：直接在列表中创建一个默认 16×16 的贴图并打开（大小可随后用右键「修改大小」调整）
function createNewTexture() {
  let k = 1;
  while (getTexture('tex_' + k)) k++;
  const name = 'tex_' + k;
  makeTexture(name, 16, 16);
  renderTexCanvas();
  if (typeof refreshTexBase64Cache === 'function') refreshTexBase64Cache();
  markTextureChanged();
  refreshUVPanel();
  refreshTexList();
}

// 导出：把当前贴图以 PNG 格式下载（贴图本身随工程 Ctrl+S 实时保存，无需单独保存）
async function exportTexture() {
  const tex = getCurrentTexture();
  if (!tex) { await modalAlert(t('alert.exportFailed'), t('alert.noTexture')); return; }
  const cnv = document.createElement('canvas');
  cnv.width = tex.width; cnv.height = tex.height;
  cnv.getContext('2d').putImageData(new ImageData(tex.data.slice(), tex.width, tex.height), 0, 0);
  const blob = await new Promise(r => cnv.toBlob(r, 'image/png'));
  if (!blob) { await modalAlert(t('alert.exportFailed'), t('alert.pngGenFail')); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = tex.name + '.png';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// 修改贴图大小：保持左上对齐复制原有像素，新区域透明
function resizeTexture(name, w, h) {
  const t = getTexture(name);
  if (!t) return;
  pushTexUndo();
  const nw = Math.max(1, Math.min(4096, Math.round(w) || 16));
  const nh = Math.max(1, Math.min(4096, Math.round(h) || 16));
  const nd = new Uint8ClampedArray(nw * nh * 4);
  const copyW = Math.min(t.width, nw), copyH = Math.min(t.height, nh);
  for (let y = 0; y < copyH; y++) {
    nd.set(t.data.subarray(y * t.width * 4, y * t.width * 4 + copyW * 4), y * nw * 4);
  }
  t.data = nd; t.width = nw; t.height = nh;
  if (state.currentTexture === name) texState.selection = null;
  renderTexCanvas();
  if (typeof refreshTexBase64Cache === 'function') refreshTexBase64Cache();
  markTextureChanged();
  refreshTexList();
  refreshUVPanel();
}

/* =========================================================================
 * 贴图改名 / 删除（右键菜单，复用 tree.js 的 showContextMenu）
 * ======================================================================= */

// 把全部对象 UV 里对 oldName 的贴图引用改为 newName（newName 为 null = 清空为无贴图）
function replaceTextureRef(oldName, newName) {
  const set = uv => {
    if (uv && uv.texture === oldName) {
      uv.texture = newName;
      // 清除贴图时重置 uvSize/texSize，避免残留被删除贴图的尺寸导致渲染异常
      if (!newName) {
        uv.uvSize = [0, 0];
        uv.uvStart = [0, 0];
        uv.texSize = [16, 16];
      }
    }
  };
  for (const p of state.particles) set(p.uv);
  for (const fx of state.functions) set(fx.uv);
  for (const gname of Object.keys(state.groupUV)) set(state.groupUV[gname]);
  if (state.currentTexture === oldName) state.currentTexture = newName;
}

async function renameTextureItem(oldName) {
  const tex = getTexture(oldName);
  if (!tex) return;
  const res = await modalPrompt(t('tex.renameTitle'), oldName, t('tex.newName'));
  if (!res) return;
  const name = res.trim();
  if (!name) { await modalAlert(t('alert.renameFailed'), t('alert.nameEmpty')); return; }
  if (name === oldName) return;
  if (getTexture(name)) { await modalAlert(t('alert.renameFailed'), tf('alert.texExists', name)); return; }
  // 内存态改名 + 同步全部引用
  const nt = { name, width: tex.width, height: tex.height, data: tex.data };
  delete state.textures[oldName];
  state.textures[name] = nt;
  replaceTextureRef(oldName, name);
  renderTexCanvas();
  if (typeof refreshTexBase64Cache === 'function') refreshTexBase64Cache();
  markTextureChanged();
  refreshTexList();
  refreshUVPanel();
}

async function deleteTextureItem(name) {
  const ok = await modalConfirm(t('tex.deleteTitle'), tf('alert.deleteTexConfirm', name));
  if (!ok) return;
  delete state.textures[name];
  if (state.currentTexture === name) state.currentTexture = null;
  replaceTextureRef(name, null);
  texState.selection = null;
  renderTexCanvas();
  if (typeof refreshTexBase64Cache === 'function') refreshTexBase64Cache();
  markTextureChanged();
  refreshTexList();
  refreshUVPanel();
}

/* =========================================================================
 * 贴图列表（文件管理器预留区域）
 * ======================================================================= */

function refreshTexList() {
  const box = document.getElementById('tex-list');
  if (!box) return;
  box.innerHTML = '';
  const names = Object.keys(state.textures);
  if (names.length === 0) return;
  for (const name of names) {
    const tex = state.textures[name];
    const item = document.createElement('button');
    item.className = 'tex-item' + (name === state.currentTexture ? ' active' : '');
    item.title = name;
    const cnv = document.createElement('canvas');
    cnv.width = tex.width; cnv.height = tex.height;
    const ctx = cnv.getContext('2d');
    ctx.putImageData(new ImageData(tex.data.slice(), tex.width, tex.height), 0, 0);
    cnv.classList.add('tex-item-thumb');
    const label = document.createElement('span');
    label.className = 'tex-item-name';
    label.textContent = name;
    item.appendChild(cnv); item.appendChild(label);
    item.onclick = () => {
      state.currentTexture = name;
      texState.selection = null;
      texState.zoom = 8; texState.panX = 0; texState.panY = 0;
      renderTexCanvas();
      refreshTexList();
      refreshUVPanel();
    };
    item.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, [
        { label: t('common.rename'), action: () => renameTextureItem(name) },
        { label: t('tex.resize'), action: () => openTexResizePop(item, name) },
        { label: t('common.delete'), danger: true, action: () => deleteTextureItem(name) },
      ]);
    };
    box.appendChild(item);
  }
}

/* ---- 修改大小悬浮框：悬停在贴图条目下方（同曲线编辑器风格），外部点击关闭 ---- */
let texResizePop = null;
function closeTexResizePop() {
  if (texResizePop) { texResizePop.remove(); texResizePop = null; }
}
function openTexResizePop(item, name) {
  closeTexResizePop();
  const tex = getTexture(name);
  if (!tex) return;
  const box = document.createElement('div');
  box.className = 'tex-resize-pop';
  const title = document.createElement('div');
  title.className = 'trp-title';
  title.textContent = tf('tex.resizeTitle', name);
  box.appendChild(title);
  const row = document.createElement('div');
  row.className = 'trp-row';
  const mk = (label, val) => {
    const lab = document.createElement('span'); lab.className = 'trp-label'; lab.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.min = '1'; inp.max = '4096'; inp.step = '1'; inp.value = val;
    row.appendChild(lab); row.appendChild(inp);
    return inp;
  };
  const wIn = mk(t('tex.width'), tex.width), hIn = mk(t('tex.height'), tex.height);
  box.appendChild(row);
  const btns = document.createElement('div');
  btns.className = 'trp-btns';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'mini'; cancelBtn.textContent = t('common.cancel');
  cancelBtn.onclick = () => closeTexResizePop();
  const okBtn = document.createElement('button');
  okBtn.className = 'mini'; okBtn.textContent = t('common.ok');
  okBtn.onclick = () => {
    const w = parseInt(wIn.value), h = parseInt(hIn.value);
    if (!isFinite(w) || !isFinite(h) || w < 1 || h < 1) return;
    closeTexResizePop();
    resizeTexture(name, w, h);
  };
  btns.appendChild(cancelBtn); btns.appendChild(okBtn);
  box.appendChild(btns);
  box.addEventListener('pointerdown', (e) => e.stopPropagation());
  document.body.appendChild(box);
  // 悬停在贴图条目下方（同曲线编辑器定位方式）
  const r = item.getBoundingClientRect();
  box.style.left = Math.min(Math.max(8, r.left), window.innerWidth - 220) + 'px';
  box.style.top = Math.min(r.bottom + 6, window.innerHeight - 120) + 'px';
  texResizePop = box;
  setTimeout(() => { wIn.focus(); wIn.select(); }, 0);
  setTimeout(() => document.addEventListener('pointerdown', (e) => { if (!box.contains(e.target)) closeTexResizePop(); }), 0);
}

/* =========================================================================
 * UV 面板
 * ======================================================================= */

function refreshTexturePanel() {
  // 自动选中当前对象使用的贴图
  const target = currentUVTarget();
  if (target) {
    const uv = readTargetUV(target);
    if (uv && uv.texture && state.textures[uv.texture]) {
      state.currentTexture = uv.texture;
    }
  }
  renderTexCanvas();
  refreshUVPanel();
  refreshTexList();
}

// 选中对象变化时自动把贴图编辑器切换到该对象使用的贴图。
// 在主循环中每帧调用（内部按目标签名去重，几乎零开销）。
let _uvTargetSig = null;
function syncTextureSelection() {
  const t = currentUVTarget();
  const sig = t ? t.kind + ':' + (t.kind === 'particle' ? [...t.key].sort().join(',') : t.key) : '';
  if (sig === _uvTargetSig) return;
  _uvTargetSig = sig;
  if (!t) return;
  const uv = readTargetUV(t);
  if (!uv || !uv.texture || !state.textures[uv.texture]) return;
  if (state.currentTexture === uv.texture) return;
  state.currentTexture = uv.texture;
  texState.selection = null;
  texState.zoom = 8; texState.panX = 0; texState.panY = 0;
  renderTexCanvas();
  refreshTexList();
  refreshUVPanel();
}

function refreshUVPanel() {
  const box = document.getElementById('uv-panel');
  if (!box) return;
  box.innerHTML = '';
  const target = currentUVTarget();
  if (!target) { box.innerHTML = '<p class="hint">' + t('tex.selectHint') + '</p>'; return; }
  const uv = readTargetUV(target) || defaultUV(16, 16);

  // 贴图引用下拉
  const texRow = document.createElement('label'); texRow.className = 'row';
  texRow.appendChild(document.createTextNode(t('tex.texLabel')));
  const texSel = document.createElement('select');
  texSel.appendChild(new Option(t('tex.none'), ''));
  for (const name of Object.keys(state.textures)) texSel.appendChild(new Option(name, name));
  texSel.value = uv.texture || '';
  texSel.onchange = () => {
    const name = texSel.value || null;
    const before = readTargetUV(target);
    const nu = normalizeUV(before || {});
    // 只更新贴图引用，保留用户设置的 texSize、uvStart、uvSize 等参数
    nu.texture = name;
    writeTargetUV(target, nu);
    refreshUVPanel();
    renderTexCanvas();
  };
  texRow.appendChild(texSel);
  box.appendChild(texRow);

  // UV 模式
  const modeRow = document.createElement('label'); modeRow.className = 'row';
  modeRow.appendChild(document.createTextNode(t('tex.uvMode')));
  const modeSel = document.createElement('select');
  for (const m of Object.keys(UV_MODES)) modeSel.appendChild(new Option(t('uv.mode.' + m), m));
  modeSel.value = uv.mode;
  modeSel.onchange = () => {
    const nu = normalizeUV({ ...readTargetUV(target), mode: modeSel.value });
    writeTargetUV(target, nu);
    refreshUVPanel();
    renderTexCanvas();
  };
  modeRow.appendChild(modeSel);
  box.appendChild(modeRow);

  if (uv.mode !== 'fill') {
    box.appendChild(uvVecField('tex.texSize', nu => nu.texSize, (nu, v) => nu.texSize = v, uv, false, 'x'));
    box.appendChild(uvVecField('tex.uvStart', nu => nu.uvStart, (nu, v) => nu.uvStart = v, uv, true, '|'));
    box.appendChild(uvVecField('tex.uvSize', nu => nu.uvSize, (nu, v) => nu.uvSize = v, uv, false, 'x'));
  }
  if (uv.mode === 'animated') {
    box.appendChild(uvVecField('tex.uvStep', nu => nu.uvStep, (nu, v) => nu.uvStep = v, uv, true, '|'));
    box.appendChild(uvNumField('tex.fps', nu => nu.fps, (nu, v) => nu.fps = v, uv));
    box.appendChild(uvFrameField(uv));
    box.appendChild(uvChkField('timeline.loop', nu => nu.loop, (nu, v) => nu.loop = v, uv));
  }
}

// 轻量更新「自动 N」提示文本（不重建面板、不失焦）：重算当前 target 的自动帧数并写进所有 .uv-auto-count。
// 用于 UV 步长/起点等会改变自动帧数的字段 change 后即时刷新。
function refreshAutoFrameHint() {
  const t = currentUVTarget();
  if (!t) return;
  const uv = readTargetUV(t);
  if (!uv) return;
  const tex = getTexture(uv.texture);
  const auto = autoFramesFor(uv, tex ? tex.width : 16, tex ? tex.height : 16);
  document.querySelectorAll('.uv-auto-count').forEach(el => { el.textContent = String(auto); });
}

// 是否需要在主渲染循环中逐帧刷新贴图编辑器 overlay（UV 动画预览跟随帧移动）。
// 仅当贴图 tab 激活、当前编辑目标的 UV 为动画模式、且其贴图 == 当前打开的贴图时才逐帧刷新
// （与 updateTexOverlay 的显示条件一致，避免画布打开其它贴图时无谓逐帧重算与错误显示）。
function texAnimOverlayActive() {
  const pane = document.getElementById('pane-texture');
  if (!pane || !pane.classList.contains('active')) return false;
  const t = currentUVTarget();
  if (!t) return false;
  const uv = readTargetUV(t);
  return !!(uv && uv.texture && uv.texture === state.currentTexture && uv.mode === 'animated');
}

// 二维像素字段（[x, y] 或 [w, h]），时间轴分组风格；affectsAuto=true 表示该字段变化会改变自动帧数（即时刷新提示）
// sep：两框间分隔符——'x' 显示乘号（贴图大小/UV 大小），'|' 显示细竖线（UV 起点/UV 步长），null 不显示
function uvVecField(labelText, get, set, uv, affectsAuto, sep) {
  const row = document.createElement('div'); row.className = 'row';
  const lab = document.createElement('span'); lab.textContent = t(labelText);
  row.appendChild(lab);
  const group = document.createElement('span'); group.className = 'uv-field';
  const mk = (i, axis) => {
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = '1';
    inp.value = get(uv)[i];
    inp.title = axis;
    inp.addEventListener('change', () => {
      const nu = normalizeUV({ ...readTargetUV(currentUVTarget()) });
      const arr = get(nu).slice();
      arr[i] = Math.max(0, parseInt(inp.value) || 0);
      set(nu, arr);
      writeTargetUV(currentUVTarget(), nu);
      renderTexCanvas();
      if (affectsAuto) refreshAutoFrameHint();
    });
    return inp;
  };
  group.appendChild(mk(0, 'X'));
  if (sep) {
    const s = document.createElement('span');
    s.className = 'uv-sep' + (sep === 'x' ? ' uv-sep-mul' : '');
    s.textContent = sep === 'x' ? '×' : '';
    if (sep === 'x') s.title = t('tex.multiply'); 
    group.appendChild(s);
  }
  group.appendChild(mk(1, 'Y'));
  const suffix = document.createElement('span'); suffix.className = 'uv-suffix';
  suffix.textContent = labelText === 'tex.uvStep' ? t('tex.px') : (labelText === 'tex.texSize' ? 'px' : '');
  if (suffix.textContent) group.appendChild(suffix);
  row.appendChild(group);
  return row;
}
function uvNumField(labelText, get, set, uv) {
  const row = document.createElement('div'); row.className = 'row';
  const lab = document.createElement('span'); lab.textContent = t(labelText);
  row.appendChild(lab);
  const group = document.createElement('span'); group.className = 'uv-field';
  const inp = document.createElement('input');
  inp.type = 'number'; inp.min = '1'; inp.value = get(uv);
  inp.addEventListener('change', () => {
    const nu = normalizeUV({ ...readTargetUV(currentUVTarget()) });
    set(nu, Math.max(1, parseInt(inp.value) || 1));
    writeTargetUV(currentUVTarget(), nu);
    renderTexCanvas();
  });
  group.appendChild(inp);
  const suffix = document.createElement('span'); suffix.className = 'uv-suffix';
  suffix.textContent = t('tex.perSec'); group.appendChild(suffix);
  row.appendChild(group);
  return row;
}
// 「最大帧数」专用字段：0 / 1 / 未设置为「自动」（不限制，按 UV 步长自动算满）；
// >1 的输入作为「小于实际帧数的上限」。时间轴风格「输入 / 自动 N」。
function uvFrameField(uv) {
  const row = document.createElement('div'); row.className = 'row';
  const lab = document.createElement('span'); lab.textContent = t('tex.maxFrames');
  row.appendChild(lab);
  const group = document.createElement('span'); group.className = 'uv-field';
  const inp = document.createElement('input');
  inp.type = 'number'; inp.min = '0'; inp.title = t('tex.maxFramesHint');
  const shown = (uv.maxFrame != null && uv.maxFrame > 1) ? uv.maxFrame : 1; // 1 表示自动
  inp.value = shown;
  const t = getTexture(uv.texture);
  const autoFrames = autoFramesFor(uv, t ? t.width : 16, t ? t.height : 16);
  const suffix = document.createElement('span'); suffix.className = 'uv-suffix';
  suffix.innerHTML = '/ <em class="uv-auto-count">' + autoFrames + '</em>';
  inp.addEventListener('change', () => {
    const nu = normalizeUV({ ...readTargetUV(currentUVTarget()) });
    const v = parseInt(inp.value);
    // 0 / 1 → 自动（1 表示为自动的上限值，实际不限制）；否则为上限
    nu.maxFrame = (isNaN(v) || v <= 1) ? 1 : v;
    writeTargetUV(currentUVTarget(), nu);
    renderTexCanvas();
    refreshAutoFrameHint();
  });
  group.appendChild(inp); group.appendChild(suffix);
  row.appendChild(group);
  return row;
}
function uvChkField(labelText, get, set, uv) {
  const row = document.createElement('label'); row.className = 'chk';
  const inp = document.createElement('input'); inp.type = 'checkbox';
  inp.checked = get(uv);
  inp.addEventListener('change', () => {
    const nu = normalizeUV({ ...readTargetUV(currentUVTarget()) });
    set(nu, inp.checked);
    writeTargetUV(currentUVTarget(), nu);
  });
  row.appendChild(inp); row.appendChild(document.createTextNode(t(labelText)));
  return row;
}