/* =========================================================================
 * ParticleDrawing 粒子动画编辑器
 * 依赖 npm three 与 three/examples 的 OrbitControls
 * ======================================================================= */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { t } from './i18n.js';
import { EASING_NONE } from './easing-constants.js';

export { OrbitControls };
export { EASING_NONE };

/* =========================================================================
 * 常量
 * ======================================================================= */

// 缓动预设：关键帧 kf[2] 可用 EASINGS 下标（0..13）、自定义贝塞尔数组，
// 或 EASING_NONE（无缓动 / 阶跃，见 easing-constants.js）。
export const EASINGS = [
  ['LINEAR', 0, 0, 1, 1],
  ['EASE_IN', 0.42, 0, 1, 1],
  ['EASE_OUT', 0, 0, 0.58, 1],
  ['EASE_IN_OUT', 0.42, 0, 0.58, 1],
  ['EASE_IN_QUAD', 0.55, 0.085, 0.68, 0.53],
  ['EASE_OUT_QUAD', 0.25, 0.46, 0.45, 0.94],
  ['EASE_IN_OUT_QUAD', 0.455, 0.03, 0.515, 0.955],
  ['EASE_IN_CUBIC', 0.55, 0.055, 0.675, 0.19],
  ['EASE_OUT_CUBIC', 0.215, 0.61, 0.355, 1.0],
  ['EASE_IN_OUT_CUBIC', 0.645, 0.045, 0.355, 1.0],
  ['EASE_IN_BOUNCE', 0.71, 0.01, 0.53, 1.61],
  ['EASE_OUT_BOUNCE', 0.29, -0.61, 0.47, 0.99],
  ['EASE_IN_ELASTIC', 0.56, 0.01, 0.73, 1.61],
  ['EASE_OUT_ELASTIC', 0.25, -0.61, 0.44, 0.99],
];

export const PLANES = {
  XZ: { axes: ['X', 'Z'], constant: 'Y', normal: new THREE.Vector3(0, 1, 0), toWorld: (u, v, o) => [u, o, v] },
  XY: { axes: ['X', 'Y'], constant: 'Z', normal: new THREE.Vector3(0, 0, 1), toWorld: (u, v, o) => [u, v, o] },
  YZ: { axes: ['Y', 'Z'], constant: 'X', normal: new THREE.Vector3(1, 0, 0), toWorld: (u, v, o) => [o, u, v] },
};

/* ========================================================================
 * 轨道属性与分量（分量级数据模型）
 * 轨道 pr 编码：多分量属性为「属性.分量」（如 pos.x / rot.y / col.a），
 * 单分量属性（scl）直接用「scl」。关键帧值（kf[1]）为标量。
 * ======================================================================== */

// 属性 → 分量键列表
export const TRACK_COMPS = {
  pos: ['x', 'y', 'z'],
  rot: ['x', 'y', 'z'],
  vel: ['x', 'y', 'z'],
  col: ['r', 'g', 'b', 'a'],
  scl: ['x', 'y', 'z'],
};

// 分量键 → 在向量中的下标
export const COMP_INDEX = { x: 0, y: 1, z: 2, r: 0, g: 1, b: 2, a: 3 };

// 粒子缩放只有 X/Y 两个有效分量（billboard 无 Z 缩放）；组/函数对象缩放仍为 XYZ 三分量
export const PARTICLE_SCALE_COMPS = ['x', 'y'];

// 按对象 id 取属性的可编辑分量列表：粒子 scl 仅 X/Y，其余按 TRACK_COMPS
export function propComps(id, prop) {
  if (prop === 'scl' && id && !id.startsWith('g:') && !id.startsWith('f:')) return PARTICLE_SCALE_COMPS;
  return TRACK_COMPS[prop];
}

// 属性 / 分量 显示标签
export const PROP_LABELS = { pos: '位置', rot: '旋转', vel: '速度', col: '颜色', scl: '缩放' };
export const COMP_LABELS = { x: 'X', y: 'Y', z: 'Z', r: 'R', g: 'G', b: 'B', a: 'A' };

// 各对象类型可动画的属性
export const PARTICLE_TRACK_DEFS = ['pos', 'vel', 'col', 'scl'];
export const GROUP_PROP_DEFS = ['pos', 'rot', 'vel', 'col', 'scl'];
export const FUNCTION_PROP_DEFS = ['pos', 'rot', 'scl'];

// 分量轨道 pr 拼接 / 解析
export function compPr(prop, comp) { return comp ? prop + '.' + comp : prop; }
export function splitCompPr(pr) { const i = pr.indexOf('.'); return i < 0 ? [pr, null] : [pr.slice(0, i), pr.slice(i + 1)]; }

export const DEFAULT_EASING = 3;

/* =========================================================================
 * 贴图 / UV（静态属性，非关键帧；作用域 f > g > p 继承覆盖）
 * UV 坐标一律使用贴图像素；贴图大小(texSize)为粒子贴图显示尺寸（像素），仅参与采样拉伸。
 * ======================================================================= */

export const UV_MODES = { static: '静态', fill: '填充', animated: '动画' };

// 自动帧数：沿 x 方向能放几格 × 沿 y 方向能放几格（行末换行，flipbook 常见布局）。
// 有效格 = 格起点仍在贴图内：起点 sx 起、步进 step，满足 sx + k*step < texW 的 k 计数；
// 即 k = 0..floor((texW-1-sx)/step)。某方向 step 为 0（不移动）则该方向只算 1 格。
// 渲染（computeParticleUV）与贴图预览（currentUVFrame）共用，保证实际采样帧数与预览描边一致。
export function autoFramesFor(uv, texW, texH) {
  if (!uv) return 1;
  const w = texW || 1, h = texH || 1;
  const sx = uv.uvStart[0] || 0, sy = uv.uvStart[1] || 0;
  const stepx = uv.uvStep[0] || 0, stepy = uv.uvStep[1] || 0;
  const nx = (stepx > 0 && sx < w) ? (Math.floor((w - 1 - sx) / stepx) + 1) : 1;
  const ny = (stepy > 0 && sy < h) ? (Math.floor((h - 1 - sy) / stepy) + 1) : 1;
  return Math.max(1, nx * ny);
}

// 生效帧数 = min(自动帧数, 用户上限)。
// maxFrame 语义：0 / 未设置 / 等于旧默认 1 均视为「不限制 = 自动帧数」；
// >1 的显式值作为「小于实际帧数的最大上限」（用户可用它限制播放长度）。
export function effMaxFrame(uv, autoFrames) {
  const mf = (uv.maxFrame != null && uv.maxFrame > 1) ? uv.maxFrame : autoFrames;
  return Math.max(1, Math.min(mf, autoFrames));
}

// 默认 UV 参数（对象未单独设置时继承上级；根默认为「无贴图」）
// 贴图大小默认 = 贴图分辨率，其余数值字段（UV 起点/大小/步长）默认 0
export function defaultUV(texWidth, texHeight) {
  const w = texWidth || 16, h = texHeight || 16;
  return {
    texture: null,        // 贴图名（state.textures 的 key），null = 无贴图
    mode: 'static',       // static | fill | animated
    texSize: [w, h],      // 贴图大小（粒子贴图显示尺寸，像素）
    uvStart: [0, 0],      // UV 起点 [x, y]（像素）
    uvSize: [0, 0],       // UV 大小 [w, h]（像素）
    uvStep: [0, 0],       // UV 步长 [x, y]（像素，动画模式）
    fps: 1,               // 帧率（动画模式）
    maxFrame: 1,          // 最大帧数（动画模式）；1=自动（按 UV 步长算满，不限制），>1=用户上限
    loop: true,           // 循环
  };
}

export const SNAP_STEP = 1.0;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const ROT_SNAP = 45; // 按住 Shift 时旋转吸附的步长（角度）
export const PARTICLE_SIZE_FACTOR = 0.2; // 编辑器点整宽因子；游戏端 quad 半宽因子为其一半（EDITOR_TO_MC_SCALE=0.1）

/* =========================================================================
 * 状态
 * ======================================================================= */

/**
 * 全局状态（单一数据源）。
 * 数据模型约定：
 * - particle: { id, color:[r,g,b,a], scale:[sx,sy,sz], glow, lightLevel,
 *              pos:[x,y,z], vel:[vx,vy,vz], life, st, ent, uv, fx? }
 *   派生粒子 id 固定为 `${fxId}:p${i}`，其基础属性由函数对象公式计算（只读）。
 * - track: { pr:'pos.x'|'scl'|..., m:'set'|'op', ids:[...], kf:[[tick,value,easing],...], fx? }
 * - group: state.groups[组名] = [粒子id...]；组级 UV 在 state.groupUV[组名]。
 * - function object: { id:'fxN', name, center:[x,y,z], count, code,
 *                      vars:{name:{expr,kf}}, duration, step, preset, params, st, ent, ui, uv }
 */
export const state = {
  name: 'my_animation',
  key: null,              // Ed25519 密钥对 { alg:'Ed25519', private, public }（base64）；旧工程打开时自动生成
  loop: true,
  particles: [],
  groups: {},
  tracks: [],
  functions: [],
  selectedFunction: null,
  tool: 'select',
  drawPlane: 'XZ',
  drawCount: 30,
  selected: new Set(),
  selectedGroup: null,
  expandedParticles: new Set(),
  expandedProps: new Set(),
  snap: false,
  fileHandle: null,
  time: 0,
  playing: false,
  scrubbing: false,   // 正在拖动/输入时间轴：动画贴图帧改由 state.time 驱动
  playSpeed: 1,
  defaultEasing: DEFAULT_EASING,
  captureKeyframes: true, // 始终开启「捕获关键帧」（按钮已移除）
  dirty: false,
  textures: {},          // { name: { width, height, data(Uint8Array RGBA), fileHandle? } }
  currentTexture: null,  // 当前贴图编辑器正在编辑的贴图名
  groupUV: {},           // 组级 UV/贴图设置（继承 f > g > p）
};

export function setDirty(v) {
  state.dirty = v;
  updateTopbarTitle();
}

// 顶栏标题：工程名 + 未保存标记（setDirty / 打开 / 保存后调用）。
export function updateTopbarTitle() {
  const el = document.getElementById('topbar-title');
  if (el) el.textContent = state.name + '.pdraw' + (state.dirty ? ' *' : '');
}

export function nextId() {
  const idx = ensureParticleIndex();
  const pre = t('default.particleName');
  let n = 0;
  while (idx.has(pre + n)) n++;
  return pre + n;
}
export function nextGroupName() {
  let n = 0;
  const pre = t('default.groupName');
  while ((pre + n) in state.groups) n++;
  return pre + n;
}
export function nextFunctionId() {
  let n = 0;
  while (state.functions.some(f => f.id === 'fx' + n)) n++;
  return 'fx' + n;
}
export function getFunction(id) { return functionIndexCache ? functionIndexCache.get(id) : state.functions.find(f => f.id === id); }
// 粒子是否由函数对象派生（基础属性只读）
export function isDerivedParticle(p) { return p != null && !!p.fx; }
// 粒子索引（animation.js 的 buildParticleIndex 在 rebuildPoints 时重建，供 getParticle O(1) 查找）
export let particleIndexCache = null;
export let functionIndexCache = null; // 函数对象索引（buildParticleIndex 时重建，供 getFunction O(1) 查找）
// 索引缓存由 animation.js 的 buildParticleIndex 重建；这里提供 setter 供其写入（ESM 导入绑定不可重新赋值）。
export function setParticleIndex(map) { particleIndexCache = map; }
export function setFunctionIndex(map) { functionIndexCache = map; }
// 供 nextId / addParticle 在批量添加期间维护索引，避免 nextId 退化为 O(N²)。
function ensureParticleIndex() {
  if (!particleIndexCache) {
    const map = new Map();
    for (const p of state.particles) map.set(p.id, p);
    setParticleIndex(map);
  }
  return particleIndexCache;
}
export function indexParticle(p) { if (particleIndexCache) particleIndexCache.set(p.id, p); }
export function getParticle(id) { return particleIndexCache ? particleIndexCache.get(id) : state.particles.find(p => p.id === id); }

/* =========================================================================
 * 函数对象：预设形状模板（参数面板 + 公式视图）
 * 内置变量：i=粒子序号、n=采样数、t=时间（vars 内不可重名）
 * ======================================================================= */

export const FUNCTION_PRESETS = {
  blank: {
    label: '空',
    params: [],
    build: p => ({
      count: 30,
      vars: {},
      setup: '',
      process: '',
    }),
  },
  sin: {
    label: 'SIN 函数',
    params: [
      { key: 'amp', label: '振幅', def: 2 },
      { key: 'freq', label: '频率', def: 2 },
      { key: 'wid', label: '宽度', def: 8 },
    ],
    build: p => ({
      count: 200,
      vars: { amp: { base: Number(p.amp), kf: [] }, freq: { base: Number(p.freq), kf: [] }, wid: { base: Number(p.wid), kf: [] } },
      setup: `global _gx = [];
for (_k = 0; _k < n; _k = _k + 1) {
  _gx.push(_k / n - 0.5);
}`,
      process: `xx = _gx[i] * wid;
[x,y,z] = [xx, amp * sin(freq * pi * _gx[i]), 0];`,
    }),
  },
  sphere: {
    label: '球体',
    params: [
      { key: 'rad', label: '半径', def: 3 },
    ],
    build: p => ({
      count: 200,
      vars: { rad: { base: Number(p.rad), kf: [] } },
      setup: `global _th = [];
global _ph = [];
for (_k = 0; _k < n; _k = _k + 1) {
  _th.push(acos(1 - 2 * (_k + 0.5) / n));
  _ph.push(_k * pi * (3 - sqrt(5)));
}`,
      process: `[x,y,z] = [rad * sin(_th[i]) * cos(_ph[i]), rad * cos(_th[i]), rad * sin(_th[i]) * sin(_ph[i])];
[r,g,b,a] = [1,1,1,1];`,
    }),
  },
  cube: {
    label: '立方体',
    countVars: ['sx', 'sy', 'sz'],
    params: [
      { key: 'edge', label: '边长', def: 4 },
    ],
    build: p => ({
      count: 512,
      vars: { edge: { base: Number(p.edge), kf: [] }, sx: { base: 8, kf: [] }, sy: { base: 8, kf: [] }, sz: { base: 8, kf: [] } },
      setup: `global _cx = [];
global _cy = [];
global _cz = [];
for (_k = 0; _k < n; _k = _k + 1) {
  _cx.push(floor(_k / (sy * sz)) / (sx - 1) - 0.5);
  _cy.push(floor((_k % (sy * sz)) / sz) / (sy - 1) - 0.5);
  _cz.push((_k % sz) / (sz - 1) - 0.5);
}`,
      process: `[x,y,z] = [_cx[i] * edge, _cy[i] * edge, _cz[i] * edge];
[r,g,b,a] = [1,1,1,1];`,
    }),
  },
  torus: {
    label: '甜甜圈',
    countVars: ['m', 'k'],
    params: [
      { key: 'major', label: '大半径', def: 3 },
      { key: 'minor', label: '管半径', def: 1 },
      { key: 'm', label: '密度', def: 45 },
      { key: 'k', label: '圆环密度', def: 16 },
    ],
    build: p => ({
      count: 717,
      vars: { major: { base: Number(p.major), kf: [] }, minor: { base: Number(p.minor), kf: [] }, m: { base: Number(p.m), kf: [] }, k: { base: Number(p.k), kf: [] } },
      setup: `global _th = [];
global _ph = [];
for (_k = 0; _k < n; _k = _k + 1) {
  _th.push((_k % k) / k * 2 * pi);
  _ph.push(floor(_k / k) / m * 2 * pi);
}`,
      process: `[x,y,z] = [(major + minor * cos(_th[i])) * cos(_ph[i]), minor * sin(_th[i]), (major + minor * cos(_th[i])) * sin(_ph[i])];`,
    }),
  },
  cylinder: {
    label: '圆柱',
    countExpr: 'm*(k+2*cr)',
    params: [
      { key: 'rad', label: '半径', def: 2 },
      { key: 'h', label: '高度', def: 4 },
      { key: 'm', label: '密度', def: 45 },
      { key: 'k', label: '圆环密度', def: 12 },
      { key: 'cr', label: '顶/底密度', def: 8 },
    ],
    build: p => ({
      count: 512,
      vars: { rad: { base: Number(p.rad), kf: [] }, h: { base: Number(p.h), kf: [] }, m: { base: Number(p.m), kf: [] }, k: { base: Number(p.k), kf: [] }, cr: { base: Number(p.cr), kf: [] } },
      setup: `global _ly = [];
global _aa = [];
global _rf = [];
global _yf = [];
for (_k = 0; _k < n; _k = _k + 1) {
  _ly.push(floor(_k / m));
  _aa.push((_k % m) / m * 2 * pi);
  _rf.push(clamp(min(_ly[_k] / (cr - 1), (k + 2 * cr - 1 - _ly[_k]) / (cr - 1)), 0, 1));
  _yf.push((clamp(_ly[_k], cr, cr + k - 1) - cr) / (k - 1));
}`,
      process: `rr = rad * _rf[i];
yy = _yf[i] * h - h / 2;
[x,y,z] = [rr * cos(_aa[i]), yy, rr * sin(_aa[i])];`,
    }),
  },
  cone: {
    label: '圆锥',
    countVars: ['m', 'k'],
    params: [
      { key: 'rad', label: '底面半径', def: 2 },
      { key: 'h', label: '高度', def: 4 },
    ],
    build: p => ({
      count: 512,
      vars: { rad: { base: Number(p.rad), kf: [] }, h: { base: Number(p.h), kf: [] }, m: { base: 32, kf: [] }, k: { base: 16, kf: [] } },
      setup: `global _aa = [];
global _yy = [];
for (_k = 0; _k < n; _k = _k + 1) {
  _aa.push((_k % m) / m * 2 * pi);
  _yy.push(floor(_k / m) / (k - 1));
}`,
      process: `[x,y,z] = [rad * (1 - _yy[i]) * cos(_aa[i]), (_yy[i] - 0.5) * h, rad * (1 - _yy[i]) * sin(_aa[i])];
[r,g,b,a] = [1,1,1,1];
glow = 0;
light = 0;`,
    }),
  },
  helix: {
    label: '螺旋线',
    countVars: ['turns', 'ppr'],
    params: [
      { key: 'rad', label: '半径', def: 2 },
      { key: 'h', label: '总高度', def: 6 },
    ],
    build: p => ({
      count: 120,
      vars: { rad: { base: Number(p.rad), kf: [] }, h: { base: Number(p.h), kf: [] }, turns: { base: 3, kf: [] }, ppr: { base: 40, kf: [] } },
      setup: `global _aa = [];
global _yf = [];
for (_k = 0; _k < n; _k = _k + 1) {
  _aa.push(_k / ppr * 2 * pi);
  _yf.push(_k / n - 0.5);
}`,
      process: `[x,y,z] = [rad * cos(_aa[i]), _yf[i] * h, rad * sin(_aa[i])];
[r,g,b,a] = [1,1,1,1];
glow = 1;
light = 8;`,
    }),
  },
  plane: {
    label: '平面网格',
    countVars: ['cols', 'rows'],
    params: [
      { key: 'w', label: '宽', def: 8 },
      { key: 'd', label: '深', def: 8 },
    ],
    build: p => ({
      count: 256,
      vars: { w: { base: Number(p.w), kf: [] }, d: { base: Number(p.d), kf: [] }, cols: { base: 16, kf: [] }, rows: { base: 16, kf: [] } },
      setup: `global _xf = [];
global _zf = [];
for (_k = 0; _k < n; _k = _k + 1) {
  _xf.push((_k % cols) / (cols - 1) - 0.5);
  _zf.push(floor(_k / cols) / (rows - 1) - 0.5);
}`,
      process: `[x,y,z] = [_xf[i] * w, 0, _zf[i] * d];
[r,g,b,a] = [1,1,1,1];
glow = 0;
light = 0;`,
    }),
  },
  circle: {
    label: '圆周',
    params: [
      { key: 'rad', label: '半径', def: 4 }
    ],
    build: p => ({
      count: 200,
      vars: { rad: { base: Number(p.rad), kf: [] } },
      setup: `global _ang = [];
for (_k = 0; _k < n; _k = _k + 1) {
  _ang.push(_k / n * 2 * pi);
}`,
      process: `[x,y,z] = [rad * cos(_ang[i]), 0, rad * sin(_ang[i])];`,
    }),
  },
  disc: {
    label: '圆盘',
    params: [
      { key: 'diskR', label: '半径', def: 4 },
    ],
    build: p => ({
      count: 400,
      vars: { diskR: { base: Number(p.diskR), kf: [] } },
      setup: `global _rf = [];
global _th = [];
for (_k = 0; _k < n; _k = _k + 1) {
  _rf.push(sqrt(_k / n));
  _th.push(_k * pi * (3 - sqrt(5)));
}`,
      process: `rad = diskR * _rf[i];
x = rad * cos(_th[i]);
z = rad * sin(_th[i]);`,
    }),
  },
  star: {
    label: '星形',
    params: [
      { key: 'rad', label: '半径', def: 20 },
    ],
    build: p => ({
      count: 2000,
      vars: { rad: { base: Number(p.rad), kf: [] } },
      setup: `global _m = floor(pow(n, 0.5));
global _cx = [];
global _cy = [];
global _cz = [];
for (_k = 0; _k < n; _k = _k + 1) {
  _cx.push(pow(cos(floor(_k / _m) * 2 * pi / _m) * cos((_k % _m) * pi / _m - pi / 2), 3));
  _cy.push(pow(sin(floor(_k / _m) * 2 * pi / _m) * cos((_k % _m) * pi / _m - pi / 2), 3));
  _cz.push(pow(sin((_k % _m) * pi / _m - pi / 2), 3));
}`,
      process: `x = rad * _cx[i];
y = rad * _cy[i];
z = rad * _cz[i];`
    })
  },
  rising_smoke: {
    label: '循环上升烟雾',
    params: [
      { key: 'rad', label: '半径', def: 50 },
      { key: 'spd', label: '上升速度', def: 0.5 },
    ],
    build: p => ({
      count: 2000,
      vars: { rad: { base: Number(p.rad), kf: []}, spd: { base: Number(p.spd), kf: [] } },
      setup: `global _rx = [];
global _rz = [];
global _ry = [];
for (_k = 0; _k < n; _k = _k + 1) {
  _rx.push(rand(_k * 2));
  _rz.push(rand(_k * 4));
  _ry.push(rand(_k * 6));
}`,
      process: `x = (_rx[i] * 2 - 1) * rad;
z = (_rz[i] * 2 - 1) * rad;
_y = (_ry[i] * 2 - 1) * rad;
y = -rad + (_y + rad + t * spd) % (2 * rad);`
    })
  },
};
