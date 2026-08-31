/* =========================================================================
 * 导出 / 导入 / 文件
 * 职责：.pdraw/.json 序列化与解析、贴图 base64、File System Access 保存/打开、新建与导出流程。
 * ======================================================================= */

import { t } from '../core/i18n.js';
import { state, setDirty, DEFAULT_EASING, UV_MODES, PROP_LABELS, splitCompPr, nextId } from '../core/constants.js';
import { pushUndo } from '../state/undo.js';
import { rebuildPoints } from '../core/animation.js';
import { updateLoopIndicator, refreshFunctionPanel, refreshCameraPanel } from '../ui/panels.js';
import { updateTimeUI, refreshCameraTabs } from '../main.js';
import { rebuildFunctionObject } from '../core/generators.js';
import { markTextureChanged, refreshTexturePanel } from '../ui/texture-editor.js';
import { buildModal, modalPrompt, modalAlert } from '../ui/ui.js';
import { generateKeyPair, KEY_ALG, base64ToBytes, bytesToBase64 } from '../core/crypto.js';
import { buildPdrawc } from '../core/pdrawc.js';

export const r3 = x => Math.round(x * 1000) / 1000;
export const roundArr = a => a.map(r3);
export function encodeEasing(e) { return Array.isArray(e) ? e.map(r3) : e; }

/* 解析 .pdraw 工程中的密钥；无效/缺失返回 null。 */
export function parseProjectKey(k) {
  if (k && k.alg === KEY_ALG && typeof k.private === 'string' && typeof k.public === 'string') {
    return { alg: KEY_ALG, private: k.private, public: k.public };
  }
  return null;
}

/* 确保 state.key 存在：已有有效密钥直接返回 true；否则生成，失败返回 false。 */
export async function ensureProjectKey() {
  if (state.key && state.key.alg === KEY_ALG && state.key.private && state.key.public) return true;
  try {
    const pair = await generateKeyPair();
    state.key = { alg: KEY_ALG, private: pair.private, public: pair.public };
    return true;
  } catch (_) {
    return false; // 浏览器不支持：保持无密钥，保存仍可进行，导出时再提示
  }
}

/* 应用工程密钥：有则采用；无则自动生成并返回 true（调用方据此标记未保存）。 */
export async function applyProjectKey(obj) {
  const existing = parseProjectKey(obj.key);
  if (existing) { state.key = existing; return false; }
  state.key = null;
  return ensureProjectKey();
}

// 贴图 → base64 PNG（同步导出用；贴图变化时调用 refreshTexBase64Cache 预计算）
export async function textureToBase64(t) {
  const cnv = document.createElement('canvas'); cnv.width = t.width; cnv.height = t.height;
  const ctx = cnv.getContext('2d');
  ctx.putImageData(new ImageData(t.data.slice(), t.width, t.height), 0, 0);
  const blob = await new Promise(r => cnv.toBlob(r, 'image/png'));
  const buf = await blob.arrayBuffer();
  return bytesToBase64(new Uint8Array(buf));
}
export function base64ToTexture(name, b64) {
  return new Promise((resolve, reject) => {
    const bytes = base64ToBytes(b64);
    const blob = new Blob([bytes], { type: 'image/png' });
    createImageBitmap(blob).then(async bmp => {
      const w = bmp.width, h = bmp.height;
      const cnv = document.createElement('canvas'); cnv.width = w; cnv.height = h;
      const ctx = cnv.getContext('2d'); ctx.drawImage(bmp, 0, 0);
      const data = new Uint8ClampedArray(ctx.getImageData(0, 0, w, h).data);
      resolve({ name, width: w, height: h, data });
    }).catch(reject);
  });
}
// 预计算缓存：exportProject 同步读取（异步刷新，调用时机：贴图新建/上传/编辑/删除/重命名后）
export let _texBase64Cache = {};
export async function refreshTexBase64Cache() {
  const c = {};
  for (const [name, t] of Object.entries(state.textures)) {
    try { c[name] = await textureToBase64(t); } catch (e) { /* skip */ }
  }
  _texBase64Cache = c;
}

// 颜色是否为默认白色（省略导出）
export function isDefaultColor(c) {
  return !!c && Math.abs(c[0] - 1) < 1e-9 && Math.abs(c[1] - 1) < 1e-9 && Math.abs(c[2] - 1) < 1e-9 && Math.abs(c[3] - 1) < 1e-9;
}

// UV 参数序列化 / 解析（外部 PNG 贴图只存名，像素存 textures/<name>.png）
export function serializeUV(uv) {
  if (!uv) return undefined;
  return {
    texture: uv.texture || null,
    mode: uv.mode || 'static',
    texSize: (uv.texSize || [16, 16]).slice(0, 2),
    uvStart: (uv.uvStart || [0, 0]).slice(0, 2),
    uvSize: (uv.uvSize || [16, 16]).slice(0, 2),
    uvStep: (uv.uvStep || [16, 0]).slice(0, 2),
    fps: uv.fps != null ? uv.fps : 1,
    maxFrame: uv.maxFrame != null ? uv.maxFrame : 1,
    loop: uv.loop != null ? !!uv.loop : true,
  };
}
export function parseUV(o) {
  if (!o) return undefined;
  const w = (o.texSize && o.texSize[0]) || 16, h = (o.texSize && o.texSize[1]) || 16;
  return {
    texture: o.texture || null,
    mode: UV_MODES[o.mode] ? o.mode : 'static',
    texSize: (o.texSize || [w, h]).slice(0, 2),
    uvStart: (o.uvStart || [0, 0]).slice(0, 2),
    uvSize: (o.uvSize || [0, 0]).slice(0, 2),
    uvStep: (o.uvStep || [0, 0]).slice(0, 2),
    fps: o.fps != null ? o.fps : 1,
    maxFrame: o.maxFrame != null ? o.maxFrame : 1,
    loop: o.loop != null ? !!o.loop : true,
  };
}

// 粒子序列化：省略等于默认值的字段，减小工程文件体积（解析侧均有默认回退）
export function serializeParticle(pt) {
  const o = { id: pt.id, pos: roundArr(pt.pos) };
  if (!isDefaultColor(pt.color)) o.c = roundArr(pt.color);
  const s = pt.scale || [1, 1, 1];
  if (s[0] !== 1 || s[1] !== 1 || s[2] !== 1) o.sc = roundArr([s[0], s[1], s[2]]);
  if (pt.glow) o.g = 1;
  if (pt.lightLevel) o.l = pt.lightLevel;
  const v = pt.vel || [0, 0, 0];
  if (v[0] || v[1] || v[2]) o.vel = roundArr(v);
  if (pt.uv && pt.uv.texture) o.uv = serializeUV(pt.uv);
  if (pt.st) o.st = pt.st;
  if (pt.ent) o.ent = { p: pt.ent.p, d: pt.ent.d != null ? pt.ent.d : 5 };
  if (pt.life != null && pt.life >= 0) o.life = pt.life;   // -1=无限，省略字段
  return o;
}

/* —— 函数对象 序列化 —— */
export function serializeVars(vars) {
  const o = {};
  for (const [name, v] of Object.entries(vars || {})) {
    o[name] = { b: Number.isFinite(v.base) ? v.base : 0, kf: (v.kf || []).map(k => [k[0], k[1], k[2]]) };
  }
  return o;
}
export function parseVars(vars) {
  const o = {};
  for (const [name, v] of Object.entries(vars || {})) {
    if (typeof v === 'string') { o[name] = { base: Number(v) || 0, kf: [] }; continue; } // 旧格式纯字符串
    const legacy = (v.expr != null && v.expr !== '') ? Number(v.expr) : NaN;
    o[name] = {
      base: Number.isFinite(v.b) ? v.b : (Number.isFinite(v.base) ? v.base : (Number.isFinite(legacy) ? legacy : 0)),
      kf: (v.kf || []).map(k => [k[0], k[1], Array.isArray(k[2]) ? k[2].slice() : (Number.isInteger(k[2]) ? k[2] : DEFAULT_EASING)]),
    };
  }
  return o;
}
export function serializeFunction(fx) {
  const o = {
    id: fx.id, name: fx.name, center: fx.center.slice(), count: fx.count,
    setup: fx.setup || '',
    process: fx.process || '',
    seed: Number.isInteger(fx.seed) ? fx.seed : 0,
    vars: serializeVars(fx.vars),
    duration: fx.duration, step: fx.step,
  };
  if (fx.funcs) o.funcs = fx.funcs;
  if (fx.st) o.st = fx.st;
  if (fx.ent) o.ent = { p: fx.ent.p, d: fx.ent.d != null ? fx.ent.d : 5 };
  if (fx.preset) o.preset = fx.preset;
  if (fx.params) o.params = { ...fx.params };
  if (fx.ui) o.ui = JSON.parse(JSON.stringify(fx.ui));
  if (fx.uv && fx.uv.texture) o.uv = serializeUV(fx.uv);
  if (fx.fastMath) o.fm = 1;
  if (fx.spinSpace === 'local') o.ss = 1;
  if (fx.rotSpace === 'local') o.rs = 1;
  return o;
}
export function parseFunction(o) {
  return {
    id: o.id, name: o.name || '函数对象', center: (o.center || [0, 0, 0]).slice(0, 3), count: o.count || 30,
    setup: o.setup != null ? String(o.setup) : '',
    process: o.process != null ? String(o.process) : '',
    funcs: o.funcs != null ? String(o.funcs) : '',
    seed: Number.isInteger(o.seed) ? o.seed : 0,
    vars: parseVars(o.vars),
    duration: o.duration || 0, step: o.step || 5,
    st: o.st || 0,
    ent: o.ent && o.ent.p ? { p: String(o.ent.p), d: o.ent.d != null ? o.ent.d : 5 } : null,
    preset: o.preset || null, params: o.params ? { ...o.params } : null,
    ui: o.ui || null,
    uv: parseUV(o.uv),
    fastMath: !!o.fm,
    spinSpace: o.ss === 1 ? 'local' : 'world',
    rotSpace: o.rs === 1 ? 'local' : 'world',
  };
}

// 导出工程（.pdraw）：独立粒子 + 非派生轨道 + 函数对象定义
export function exportProject() {
  const p = state.particles.filter(pt => !pt.fx).map(serializeParticle);
  const t = state.tracks.filter(tr => !tr.fx).map(tr => {
    const o = { pr: tr.pr, ids: tr.ids.slice(), kf: tr.kf.map(k => [k[0], r3(k[1]), encodeEasing(k[2])]) };
    if (tr.m === 'op') o.m = 'op';
    return o;
  });
  // 组：剔除函数对象派生粒子成员（id 形如 fxId:p<i>，由客户端播放时实时生成，不烘焙进工程文件）
  const fxPrefixes = state.functions.map(fx => fx.id + ':p');
  const isDerived = id => fxPrefixes.some(pre => id.startsWith(pre));
  const g = {};
  for (const [name, members] of Object.entries(state.groups)) {
    const kept = members.filter(id => !isDerived(id));
    if (kept.length) g[name] = kept;
  }
  const f = state.functions.map(serializeFunction);
  const tex = Object.keys(state.textures);
  // 内嵌贴图数据（base64 PNG）；使用预计算缓存（同步可用）
  const texData = {};
  for (const name of tex) {
    if (_texBase64Cache[name]) texData[name] = _texBase64Cache[name];
  }
  const guv = {};
  for (const [name, uv] of Object.entries(state.groupUV || {})) if (uv && uv.texture) guv[name] = serializeUV(uv);
  const gss = {};
  for (const [name, space] of Object.entries(state.groupSpinSpace || {})) if (space === 'local') gss[name] = 1;
  const grs = {};
  for (const [name, space] of Object.entries(state.groupRotSpace || {})) if (space === 'local') grs[name] = 1;
  const result = { v: 8, loop: state.loop, g, p, t, f, tex, guv };
  if (Object.keys(gss).length > 0) result.gss = gss;
  if (Object.keys(grs).length > 0) result.grs = grs;
  // 摄像机对象（v8 新增；默认摄像机不持久化，仅存用户新建的摄像机）
  if (state.cameras.length > 0) {
    result.cam = state.cameras.map(c => ({
      id: c.id, name: c.name,
      pos: c.pos.map(r3), rot: c.rot.map(r3), fov: r3(c.fov),
    }));
  }
  if (state.key) result.key = { alg: KEY_ALG, private: state.key.private, public: state.key.public };
  if (Object.keys(texData).length > 0) result.texData = texData;
  return result;
}

export function parseParticlesTracks(obj) {
  state.particles = (obj.p || []).map(pt => {
    let sc;
    if (Array.isArray(pt.sc)) sc = pt.sc.slice(0, 3);
    else { const v = pt.sc != null ? pt.sc : 1; sc = [v, v, v]; }
    return {
      id: pt.id || nextId(),
      color: (pt.c || [1, 1, 1, 1]).slice(0, 4), scale: sc,
      glow: !!pt.g, lightLevel: pt.l || 0, pos: (pt.pos || [0, 0, 0]).slice(0, 3),
      vel: (pt.vel || [0, 0, 0]).slice(0, 3),
      uv: parseUV(pt.uv),
      st: pt.st || 0,
      ent: pt.ent && pt.ent.p ? { p: String(pt.ent.p), d: pt.ent.d != null ? pt.ent.d : 5 } : null,
      life: (pt.life != null && pt.life >= 0) ? pt.life : -1,
    };
  });
  state.groups = {};
  for (const [name, members] of Object.entries(obj.g || {})) state.groups[name] = members.slice();
  state.groupUV = {};
  for (const [name, uv] of Object.entries(obj.guv || {})) state.groupUV[name] = parseUV(uv);
  state.groupSpinSpace = {};
  for (const [name, v] of Object.entries(obj.gss || {})) state.groupSpinSpace[name] = v === 1 ? 'local' : 'world';
  state.groupRotSpace = {};
  for (const [name, v] of Object.entries(obj.grs || {})) state.groupRotSpace[name] = v === 1 ? 'local' : 'world';
  state.tracks = (obj.t || []).map(tr => {
    const [prop] = splitCompPr(tr.pr);
    return {
      pr: PROP_LABELS[prop] ? tr.pr : 'pos.x',
      m: tr.m === 'op' ? 'op' : 'set',
      ids: (tr.ids || []).slice(),
      kf: (tr.kf || []).map(k => [k[0], k[1], Array.isArray(k[2]) ? k[2].slice() : (Number.isInteger(k[2]) ? k[2] : DEFAULT_EASING)]),
    };
  });
  state.loop = !!obj.loop;
  state.cameras = (obj.cam || []).map(c => ({
    id: String(c.id || ''),
    name: c.name || '',
    pos: (c.pos || [0, 0, 0]).map(Number).slice(0, 3),
    rot: (c.rot || [0, 0, 0]).map(Number).slice(0, 3),
    fov: Number.isFinite(Number(c.fov)) ? Number(c.fov) : 50,
  })).filter(c => c.id);
}

export async function importProject(obj) {
  pushUndo();
  parseParticlesTracks(obj);
  const keyGenerated = await applyProjectKey(obj);
  state.functions = (obj.f || []).map(parseFunction);
  state.textures = {};
  state.currentTexture = null;
  state.selectedFunction = null;
  document.getElementById('tl-loop').checked = state.loop;
  updateLoopIndicator();
  state.selected.clear(); state.selectedGroup = null; state.time = 0;
  state.expandedParticles.clear(); state.expandedProps.clear();
  state.activeCamera = null;
  for (const fx of state.functions) {
    try { rebuildFunctionObject(fx); } catch (e) { console.warn('函数对象求值失败：' + fx.id + ' ' + e.message); }
  }
  // 内嵌贴图（v4+）
  if (obj.texData && typeof obj.texData === 'object') {
    const pending = [];
    for (const [name, b64] of Object.entries(obj.texData)) {
      if (typeof b64 === 'string') pending.push(base64ToTexture(name, b64));
    }
    Promise.all(pending).then(results => {
      for (const t of results) state.textures[t.name] = t;
      refreshTexBase64Cache();
      markTextureChanged(); refreshTexturePanel();
    });
  }
  updateTimeUI(); rebuildPoints();
  refreshCameraTabs(); refreshCameraPanel();
  setDirty(keyGenerated);
}

function downloadBlob(data, mime, filename) {
  const blob = new Blob([data], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function download(json, filename) {
  downloadBlob(json, 'application/json', filename);
}

// 从 File 对象载入（文件选择与拖拽打开）
export async function loadFile(file) {
  const text = await file.text();
  const obj = JSON.parse(text);
  if (file.name.toLowerCase().endsWith('.pdraw') || obj.f || obj.v >= 2) {
    if (obj.v !== 7 && obj.v !== 8) {
      modalAlert(t('filePicker.oldVersionTitle'), t('filePicker.oldVersionMsg'));
      return;
    }
    await importProject(obj);
  } else {
    modalAlert(t('filePicker.oldVersionTitle'), t('filePicker.oldVersionMsg'));
    return;
  }
  state.name = file.name.replace(/\.(json|pdraw)$/i, '');
  setDirty(state.dirty); // 刷新标题，保留导入阶段「自动生成密钥」的未保存标记
}

export async function openFile() {
  if ((await confirmDiscardChanges(t('common.open'))) === 'cancel') return;
  if (window.showOpenFilePicker) {
    try {
      const [h] = await window.showOpenFilePicker({
        types: [{ description: t('filePicker.project'), accept: { 'application/json': ['.pdraw'] } }],
        multiple: false,
      });
      state.fileHandle = h;
      await loadFile(await h.getFile());
      refreshTexBase64Cache();
      markTextureChanged();
      refreshTexturePanel();
    } catch (e) { /* 取消则忽略 */ }
    return;
  }
  document.getElementById('file-import').click();
}


export async function saveFile() {
  if (!state.fileHandle || !state.fileHandle.createWritable) {
    await saveFileAs();
    return;
  }
  await ensureProjectKey();
  await refreshTexBase64Cache();
  const json = JSON.stringify(exportProject());
  await writeProjectText(state.fileHandle, json);
}

export async function writeProjectText(handle, json) {
  try {
    const w = await handle.createWritable();
    await w.write(json); await w.close();
    setDirty(false);
  } catch (e) {
    await saveFileAs();
  }
}

// 通过系统保存选择器写文件，或在不支持 File System Access API 时回退为下载。
// keepHandle=true 会更新 state.fileHandle（另存为）；markSaved=true 会在成功后清除 dirty。
async function writeWithPicker(data, { suggestedName, description, mime, ext, keepHandle, markSaved }) {
  if (window.showSaveFilePicker) {
    try {
      const h = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description, accept: { [mime]: [ext] } }],
      });
      if (keepHandle) state.fileHandle = h;
      const w = await h.createWritable();
      await w.write(data); await w.close();
      if (markSaved) setDirty(false);
    } catch (e) {
      // 用户取消选择器：不下载，也不改变当前状态
    }
    return;
  }
  downloadBlob(data, mime, suggestedName);
  if (markSaved) setDirty(false);
}

export async function saveFileAs() {
  await ensureProjectKey();
  await refreshTexBase64Cache();
  await writeWithPicker(JSON.stringify(exportProject()), {
    suggestedName: (state.name || 'my_animation') + '.pdraw',
    description: t('filePicker.projectFile'),
    mime: 'application/json',
    ext: '.pdraw',
    keepHandle: true,
    markSaved: true,
  });
}

// 导出动画（.pdrawc 二进制，供模组 /pdraw play 播放），不改变当前工程 fileHandle
export async function exportAnimation() {
  const hasKey = await ensureProjectKey();
  if (!hasKey) {
    modalAlert(t('alert.exportFailed'), t('alert.cryptoUnsupported'));
    return;
  }
  await refreshTexBase64Cache();
  const bytes = await buildPdrawc(state, name => {
    const b64 = _texBase64Cache[name];
    return b64 ? base64ToBytes(b64) : null;
  });
  await writeWithPicker(bytes, {
    suggestedName: (state.name || 'my_animation') + '.pdrawc',
    description: t('filePicker.playback'),
    mime: 'application/octet-stream',
    ext: '.pdrawc',
    keepHandle: false,
    markSaved: false,
  });
}

// 新建空白动画
export async function newFile() {
  const r = await confirmDiscardChanges(t('common.new'));
  if (r === 'cancel') return;
  const name = await modalPrompt(t('newProject.title'), 'my_animation', t('newProject.name'));
  if (!name || !name.trim()) return;
  pushUndo();
  state.particles = []; state.tracks = []; state.groups = {}; state.functions = [];
  state.textures = {}; state.currentTexture = null; state.groupUV = {}; state.groupSpinSpace = {}; state.groupRotSpace = {};
  state.cameras = []; state.activeCamera = null;
  state.selected.clear(); state.selectedGroup = null; state.selectedFunction = null;
  state.expandedParticles.clear(); state.expandedProps.clear();
  state.time = 0;
  state.name = name.trim() || 'my_animation';
  state.fileHandle = null;
  state.loop = true;
  state.key = null;
  try {
    const pair = await generateKeyPair();
    state.key = { alg: KEY_ALG, private: pair.private, public: pair.public };
  } catch (_) { /* 浏览器不支持：导出时再提示 */ }
  document.getElementById('tl-loop').checked = true;
  updateTimeUI(); rebuildPoints();
  if (typeof refreshTexturePanel === 'function') refreshTexturePanel();
  if (typeof refreshFunctionPanel === 'function') refreshFunctionPanel();
  try {
    const { refreshTimelineTree } = await import('../ui/timeline-tree.js');
    if (typeof refreshTimelineTree === 'function') refreshTimelineTree();
  } catch (_) { /* 动态加载失败不影响新建流程 */ }
  setDirty(false);
}

// 若有未保存更改，弹出三键确认（按钮名即操作，不在正文里解释）：
// 取消 = 中止本次操作；不保存 = 丢弃更改继续；保存并<动作> = 保存后继续。
// 返回 'cancel' | 'discard' | 'save'。
export async function confirmDiscardChanges(actionLabel) {
  if (!state.dirty) return 'discard';
  const r = await buildModal({
    title: t('confirm.unsavedTitle'),
    message: t('confirm.unsavedMsg'),
    buttons: [
      { label: t('common.cancel'), value: 'cancel' },
      { label: t('confirm.discard'), value: 'discard', danger: true },
      { label: t('confirm.saveAnd') + actionLabel, value: 'save', primary: true },
    ],
  });
  if (r === 'save') await saveFile();
  return r;
}
