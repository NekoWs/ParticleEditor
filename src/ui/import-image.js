// 「导入」菜单：导入图片 / 导入动图，按像素生成粒子并自动建组。
// 选中文件后先读图片尺寸，弹窗询问横向/纵向粒子数（默认=图片像素分辨率）；缩放采样按目标网格
// 做面积平均（box filter），避免最近邻抽点丢细节。静态图用 createImageBitmap 解码、透明像素跳过；
// GIF 用 WebCodecs ImageDecoder 逐帧解析，复用 col.r/g/b/a 颜色关键帧驱动粒子变色，某像素从某帧
// 起永久透明时把粒子寿命截止到该帧；所有生成粒子归入新组。

import { t, tf } from '../core/i18n.js';
import { state, EASING_NONE, PARTICLE_SIZE_FACTOR } from '../core/constants.js';
import { resampleRGBA } from '../core/resample.js';
import { addParticle, autoGroup } from '../core/edit.js';
import { pushUndo } from '../state/undo.js';
import { rebuildPoints } from '../core/animation.js';
import { buildModal, modalAlert } from './ui.js';
import { refreshTimelineTree } from './timeline-tree.js';
import { refreshAllPanelsLight } from './timeline-layers.js';

const MAX_PARTICLES = 100000;
const MAX_CHANGES = 300000;    // GIF 颜色关键帧变化总量上限
const MAX_DIMENSION = 4096;    // 单边粒子数上限
const ALPHA_THRESHOLD = 10;          // alpha < 10/255 视为透明并跳过
const ALPHA_THRESHOLD_N = ALPHA_THRESHOLD / 255;  // 归一化 0..1 阈值（GIF 采样值已 /255）
const COLOR_COMPS = ['r', 'g', 'b', 'a'];

export function initImportMenu() {
  const fileEl = document.getElementById('import-file');
  const btnImage = document.getElementById('btn-import-image');
  const btnGif = document.getElementById('btn-import-gif');
  if (!fileEl || !btnImage || !btnGif) return;

  let pendingKind = null;
  const closeMenus = () => document.querySelectorAll('.menu').forEach(m => m.classList.remove('open'));
  const pick = (kind) => {
    pendingKind = kind;
    fileEl.accept = kind === 'gif' ? 'image/gif,.gif' : 'image/*';
    closeMenus();
    fileEl.click();
  };
  btnImage.addEventListener('click', () => pick('image'));
  btnGif.addEventListener('click', () => pick('gif'));

  fileEl.addEventListener('change', async () => {
    const file = fileEl.files && fileEl.files[0];
    const kind = pendingKind;
    pendingKind = null;
    fileEl.value = '';
    if (!file) return;
    try {
      const prepared = await (kind === 'gif' ? prepareGif(file) : prepareStatic(file));
      const vals = await askResolution(prepared.w, prepared.h);
      if (!vals) {
        cleanupPrepared(prepared);
        return;
      }
      const cols = clampDim(vals.cols, prepared.w);
      const rows = clampDim(vals.rows, prepared.h);
      if (prepared.kind === 'gif') await importGifPrepared(prepared, cols, rows);
      else await importStaticPrepared(prepared, cols, rows);
    } catch (e) {
      modalAlert(t('alert.importFailed'), e.message || String(e));
    }
  });
}

function clampDim(v, fallback) {
  const n = parseInt(v, 10);
  if (!isFinite(n) || n <= 0) return Math.max(1, Math.min(MAX_DIMENSION, fallback));
  return Math.max(1, Math.min(MAX_DIMENSION, n));
}

async function prepareStatic(file) {
  const bitmap = await createImageBitmap(file);
  return { kind: 'image', bitmap, w: bitmap.width, h: bitmap.height };
}

async function prepareGif(file) {
  if (typeof ImageDecoder === 'undefined') {
    throw new Error(t('import.gifUnsupported'));
  }
  const decoder = new ImageDecoder({ data: await file.arrayBuffer(), type: 'image/gif' });
  await decoder.tracks.ready;
  if (!decoder.tracks.selectedTrack.frameCount) throw new Error(t('import.empty'));
  const firstRes = await decoder.decode({ frameIndex: 0 });
  const firstFrame = firstRes.image;
  return {
    kind: 'gif',
    decoder,
    firstFrame,
    w: firstFrame.displayWidth || firstFrame.codedWidth,
    h: firstFrame.displayHeight || firstFrame.codedHeight,
  };
}

function cleanupPrepared(prepared) {
  if (prepared && prepared.kind === 'gif') {
    if (prepared.firstFrame) { try { prepared.firstFrame.close(); } catch (_) {} }
    try { prepared.decoder.close(); } catch (_) {}
  } else if (prepared && prepared.bitmap && prepared.bitmap.close) {
    try { prepared.bitmap.close(); } catch (_) {}
  }
}

async function askResolution(defCols, defRows) {
  const parseVals = (vals) => {
    const c = parseInt(vals.cols, 10);
    const r = parseInt(vals.rows, 10);
    return { c, r };
  };
  return buildModal({
    title: t('import.resolutionTitle'),
    fields: [
      { id: 'cols', label: t('import.cols'), value: defCols, min: 1, max: MAX_DIMENSION, step: 1, type: 'number' },
      { id: 'rows', label: t('import.rows'), value: defRows, min: 1, max: MAX_DIMENSION, step: 1, type: 'number' },
    ],
    status: (vals) => {
      const { c, r } = parseVals(vals);
      if (!isFinite(c) || !isFinite(r) || c <= 0 || r <= 0) return '';
      return tf('import.particleCount', c * r);
    },
    validate: (vals) => {
      const { c, r } = parseVals(vals);
      if (isFinite(c) && isFinite(r) && c > 0 && r > 0 && c * r > MAX_PARTICLES) {
        return { ok: false, message: tf('import.tooMany', MAX_PARTICLES) };
      }
      return { ok: true, message: '' };
    },
    buttons: [
      { label: t('common.cancel'), value: null },
      { label: t('common.ok'), value: null, primary: true, inputValue: true },
    ],
  });
}

// 由源像素尺寸与目标网格计算粒子间距/缩放/居中偏移（静态图与 GIF 共用）。
function importGridMetrics(w, h, cols, rows) {
  const scaleX = w / cols, scaleY = h / rows;
  const cellW = PARTICLE_SIZE_FACTOR * scaleX;
  const cellH = PARTICLE_SIZE_FACTOR * scaleY;
  return { scaleX, scaleY, cellW, cellH, offX: (cols - 1) / 2 * cellW, offZ: (rows - 1) / 2 * cellH };
}

async function importStaticPrepared(prepared, cols, rows) {
  const bitmap = prepared.bitmap;
  const w = prepared.w, h = prepared.h;
  if (cols * rows > MAX_PARTICLES) throw new Error(tf('import.tooMany', MAX_PARTICLES));

  const cnv = document.createElement('canvas');
  cnv.width = w; cnv.height = h;
  const ctx = cnv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  const rgba = resampleRGBA(data, w, h, cols, rows);
  // 粒子间距 = 粒子实际显示大小；缩小时每个粒子代表多个源像素，按比例放大粒子与间距，
  // 使导入后的整体尺寸不随目标分辨率变化，且相邻粒子互相贴合。
  const g = importGridMetrics(w, h, cols, rows);

  pushUndo();
  const ids = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const o = (r * cols + c) * 4;
      if (rgba[o + 3] < ALPHA_THRESHOLD_N) continue;
      const p = addParticle({
        // 源图行 0 = 顶部；世界 Z 越小离相机越远，故 row 0 放最远处（屏幕上方），避免上下镜像
        pos: [c * g.cellW - g.offX, 0, r * g.cellH - g.offZ],
        color: [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]],
        scale: [g.scaleX, g.scaleY, 1],
        glow: false,
        lightLevel: 0,
        life: 20,
      });
      ids.push(p.id);
    }
  }

  if (ids.length === 0) throw new Error(t('import.empty'));
  return finishImport(ids, cols, rows);
}

async function importGifPrepared(prepared, cols, rows) {
  const decoder = prepared.decoder;
  const firstFrame = prepared.firstFrame;
  const w = prepared.w, h = prepared.h;
  const frameCount = decoder.tracks.selectedTrack.frameCount;
  if (cols * rows > MAX_PARTICLES) throw new Error(tf('import.tooMany', MAX_PARTICLES));

  const cnv = document.createElement('canvas');
  cnv.width = w; cnv.height = h;
  const ctx = cnv.getContext('2d', { willReadFrequently: true });
  const gridCount = cols * rows;

  const firstColor = new Float32Array(gridCount * 4);
  const prev = new Float32Array(gridCount * 4);
  const lastVisible = new Int32Array(gridCount).fill(-1);
  const frameDurTicks = new Int32Array(frameCount);
  const changes = []; // [gridIndex, comp, frameIndex, value]
  const sampleBuf = new Float32Array(gridCount * 4); // 逐帧采样复用缓冲

  const sampleFrame = (videoFrame, frameIndex) => {
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(videoFrame, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;
    frameDurTicks[frameIndex] = Math.max(1, Math.round((videoFrame.duration || 0) / 1000 / 50));
    resampleRGBA(d, w, h, cols, rows, sampleBuf);
    for (let gi = 0; gi < gridCount; gi++) {
      const base = gi * 4;
      const R = sampleBuf[base], G = sampleBuf[base + 1], B = sampleBuf[base + 2], A = sampleBuf[base + 3];
      if (frameIndex === 0) {
        firstColor[base] = R; firstColor[base + 1] = G; firstColor[base + 2] = B; firstColor[base + 3] = A;
        prev[base] = R; prev[base + 1] = G; prev[base + 2] = B; prev[base + 3] = A;
        if (A >= ALPHA_THRESHOLD_N) lastVisible[gi] = 0;
      } else if (A >= ALPHA_THRESHOLD_N) {
        lastVisible[gi] = frameIndex;
        const vals = [R, G, B, A];
        for (let comp = 0; comp < 4; comp++) {
          const v = vals[comp];
          if (Math.abs(v - prev[base + comp]) > 1e-6) {
            changes.push([gi, comp, frameIndex, v]);
            prev[base + comp] = v;
            if (changes.length > MAX_CHANGES) throw new Error(tf('import.tooComplex', MAX_CHANGES));
          }
        }
      }
    }
  };

  sampleFrame(firstFrame, 0);
  firstFrame.close();
  for (let i = 1; i < frameCount; i++) {
    const res = await decoder.decode({ frameIndex: i });
    sampleFrame(res.image, i);
    res.image.close();
  }

  // 帧起始 tick（20 tick/s）
  const tickOf = new Int32Array(frameCount);
  let acc = 0;
  for (let i = 0; i < frameCount; i++) { tickOf[i] = acc; acc += frameDurTicks[i]; }
  const totalTicks = acc;

  // 按粒子/分量归组颜色关键帧
  const changeMap = new Map();
  for (const [gi, comp, fi, value] of changes) {
    let m = changeMap.get(gi);
    if (!m) { m = new Map(); changeMap.set(gi, m); }
    let arr = m.get(comp);
    if (!arr) { arr = []; m.set(comp, arr); }
    arr.push([tickOf[fi], value, EASING_NONE]);
  }

  const g = importGridMetrics(w, h, cols, rows);

  pushUndo();
  const ids = [];
  for (let gi = 0; gi < gridCount; gi++) {
    if (lastVisible[gi] < 0) continue;   // 全程透明 → 不生成
    const r = Math.floor(gi / cols), c = gi % cols;
    const base = gi * 4;
    const p = addParticle({
      // 源图行 0 = 顶部；世界 Z 越小离相机越远，故 row 0 放最远处（屏幕上方），避免上下镜像
      pos: [c * g.cellW - g.offX, 0, r * g.cellH - g.offZ],
      color: [firstColor[base], firstColor[base + 1], firstColor[base + 2], firstColor[base + 3]],
      scale: [g.scaleX, g.scaleY, 1],
      glow: false,
      lightLevel: 0,
      life: lastVisible[gi] === frameCount - 1 ? Math.max(1, totalTicks) : Math.max(1, tickOf[lastVisible[gi] + 1]),
    });
    ids.push(p.id);

    const m = changeMap.get(gi);
    if (!m) continue;
    for (let comp = 0; comp < 4; comp++) {
      const arr = m.get(comp);
      if (arr && arr.length) {
        const kf = [[0, firstColor[base + comp], EASING_NONE], ...arr];
        state.tracks.push({ pr: 'col.' + COLOR_COMPS[comp], m: 'set', ids: [p.id], kf });
      }
    }
  }

  if (ids.length === 0) throw new Error(t('import.empty'));
  return finishImport(ids, cols, rows);
}

function finishImport(ids, cols, rows) {
  const groupName = autoGroup(ids);
  state.selected.clear();
  state.selectedGroup = groupName;
  state.selectedFunction = null;
  state.selectedCamera = null; // 导入后选中新组，取消摄像机选中
  rebuildPoints();
  refreshTimelineTree();
  refreshAllPanelsLight();
  return { group: groupName, particles: ids.length, cols, rows };
}