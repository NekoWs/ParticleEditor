/* =========================================================================
 * ParticleDrawing 粒子动画编辑器
 * 依赖全局 THREE（vendor/three.min.js）与 THREE.OrbitControls（vendor/OrbitControls.js）
 * ======================================================================= */

const OrbitControls = THREE.OrbitControls;

/* =========================================================================
 * 常量
 * ======================================================================= */

const EASINGS = [
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

const PLANES = {
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
const TRACK_COMPS = {
  pos: ['x', 'y', 'z'],
  rot: ['x', 'y', 'z'],
  vel: ['x', 'y', 'z'],
  col: ['r', 'g', 'b', 'a'],
  scl: ['x', 'y', 'z'],
};

// 分量键 → 在向量中的下标
const COMP_INDEX = { x: 0, y: 1, z: 2, r: 0, g: 1, b: 2, a: 3 };

// 属性 / 分量 显示标签
const PROP_LABELS = { pos: '位置', rot: '旋转', vel: '速度', col: '颜色', scl: '缩放' };
const COMP_LABELS = { x: 'X', y: 'Y', z: 'Z', r: 'R', g: 'G', b: 'B', a: 'A' };

// 各对象类型可动画的属性
const PARTICLE_TRACK_DEFS = ['pos', 'vel', 'col', 'scl'];
const GROUP_PROP_DEFS = ['pos', 'rot', 'vel', 'col', 'scl'];
const FUNCTION_PROP_DEFS = ['pos', 'rot', 'scl'];

// 分量轨道 pr 拼接 / 解析
function compPr(prop, comp) { return comp ? prop + '.' + comp : prop; }
function splitCompPr(pr) { const i = pr.indexOf('.'); return i < 0 ? [pr, null] : [pr.slice(0, i), pr.slice(i + 1)]; }

const DEFAULT_EASING = 3;

/* =========================================================================
 * 贴图 / UV（静态属性，非关键帧；作用域 f > g > p 继承覆盖）
 * UV 坐标一律使用贴图像素；贴图大小(texSize)为粒子贴图显示尺寸（像素），仅参与采样拉伸。
 * ======================================================================= */

const UV_MODES = { static: '静态', fill: '填充', animated: '动画' };

// 自动帧数：沿 x 方向能放几格 × 沿 y 方向能放几格（行末换行，flipbook 常见布局）。
// 有效格 = 格起点仍在贴图内：起点 sx 起、步进 step，满足 sx + k*step < texW 的 k 计数；
// 即 k = 0..floor((texW-1-sx)/step)。某方向 step 为 0（不移动）则该方向只算 1 格。
// 渲染（computeParticleUV）与贴图预览（currentUVFrame）共用，保证实际采样帧数与预览描边一致。
function autoFramesFor(uv, texW, texH) {
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
function effMaxFrame(uv, autoFrames) {
  const mf = (uv.maxFrame != null && uv.maxFrame > 1) ? uv.maxFrame : autoFrames;
  return Math.max(1, Math.min(mf, autoFrames));
}

// 默认 UV 参数（对象未单独设置时继承上级；根默认为「无贴图」）
// 贴图大小默认 = 贴图分辨率，其余数值字段（UV 起点/大小/步长）默认 0
function defaultUV(texWidth, texHeight) {
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

const SNAP_STEP = 1.0;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const ROT_SNAP = 45; // 按住 Shift 时旋转吸附的步长（角度）
const PARTICLE_SIZE_FACTOR = 0.5; // 编辑器渲染缩放（与游戏内 quad 的可见点大小一致）

/* =========================================================================
 * 状态
 * ======================================================================= */

const state = {
  name: 'my_animation',
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

function setDirty(v) {
  state.dirty = v;
  if (typeof updateTopbarTitle === 'function') updateTopbarTitle();
}

function nextId() {
  let n = 0;
  const pre = t('default.particleName');
  while (state.particles.some(p => p.id === pre + n)) n++;
  return pre + n;
}
function nextGroupName() {
  let n = 0;
  const pre = t('default.groupName');
  while ((pre + n) in state.groups) n++;
  return pre + n;
}
function nextFunctionId() {
  let n = 0;
  while (state.functions.some(f => f.id === 'fx' + n)) n++;
  return 'fx' + n;
}
function getFunction(id) { return functionIndexCache ? functionIndexCache.get(id) : state.functions.find(f => f.id === id); }
// 粒子是否由函数对象派生（基础属性只读）
function isDerivedParticle(p) { return p != null && !!p.fx; }
// 粒子索引（animation.js 的 buildParticleIndex 在 rebuildPoints 时重建，供 getParticle O(1) 查找）
let particleIndexCache = null;
let functionIndexCache = null; // 函数对象索引（buildParticleIndex 时重建，供 getFunction O(1) 查找）
function getParticle(id) { return particleIndexCache ? particleIndexCache.get(id) : state.particles.find(p => p.id === id); }
function findTrack(prop, id) { return state.tracks.find(tr => tr.pr === prop && tr.ids.length === 1 && tr.ids[0] === id); }

function nextFreeTime(tr, startTime) {
  let t = Math.max(0, Math.round(startTime));
  while (tr.kf.some(k => k[0] === t)) t += 5;
  return t;
}

/* =========================================================================
 * 函数对象：预设形状模板（参数面板 + 公式视图）
 * 内置变量：i=粒子序号、n=采样数、t=时间（vars 内不可重名）
 * ======================================================================= */

const FUNCTION_PRESETS = {
  blank: {
    label: '空',
    params: [],
    build: p => ({
      count: 30,
      vars: {},
      code: '',
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
      vars: { amp: { expr: String(p.amp), kf: [] }, freq: { expr: String(p.freq), kf: [] }, wid: { expr: String(p.wid), kf: [] } },
      code: 'xx = (i / n - 0.5) * wid;\n' +
          '[x,y,z] = [xx, amp * sin(freq * pi * xx / wid), 0]',
    }),
  },
  sphere: {
    label: '球体',
    params: [
      { key: 'rad', label: '半径', def: 3 },
    ],
    build: p => ({
      count: 200,
      vars: { rad: { expr: String(p.rad), kf: [] } },
      code: 'th = acos(1-2*(i+0.5)/n);\n' +
          'ph = i*pi*(3-sqrt(5));\n' +
          '[x,y,z] = [rad*sin(th)*cos(ph), rad*cos(th), rad*sin(th)*sin(ph)];\n' +
          '[r,g,b,a] = [1,1,1,1]',
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
      vars: { edge: { expr: String(p.edge), kf: [] }, sx: { expr: '8', kf: [] }, sy: { expr: '8', kf: [] }, sz: { expr: '8', kf: [] } },
      code: '[x,y,z] = [((floor(i/(sy*sz)))/(sx-1)-0.5)*edge, ((floor((i%(sy*sz))/sz))/(sy-1)-0.5)*edge, ((i%sz)/(sz-1)-0.5)*edge];\n' +
          '[r,g,b,a] = [1,1,1,1]',
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
      vars: { major: { expr: String(p.major), kf: [] }, minor: { expr: String(p.minor), kf: [] }, m: { expr: String(p.m), kf: [] }, k: { expr: String(p.k), kf: [] } },
      code: 'th = i%k/k*2*pi;\n' +
          'ph = floor(i/k)/m*2*pi;\n' +
          '[x,y,z] = [(major+minor*cos(th))*cos(ph), minor*sin(th), (major+minor*cos(th))*sin(ph)]',
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
      vars: { rad: { expr: String(p.rad), kf: [] }, h: { expr: String(p.h), kf: [] }, m: { expr: String(p.m), kf: [] }, k: { expr: String(p.k), kf: [] }, cr: { expr: String(p.cr), kf: [] } },
      code: 'L = k + 2*cr;\n' +
          'ly = floor(i/m);\n' +
          'aa = i%m/m*2*pi;\n' +
          'rr = rad*clamp(min(ly/(cr-1), (L-1-ly)/(cr-1)), 0, 1);\n' +
          'yy = (clamp(ly, cr, cr+k-1)-cr)/(k-1)*h - h/2;\n' +
          '[x,y,z] = [rr*cos(aa), yy, rr*sin(aa)]',
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
      vars: { rad: { expr: String(p.rad), kf: [] }, h: { expr: String(p.h), kf: [] }, m: { expr: '32', kf: [] }, k: { expr: '16', kf: [] } },
      code: 'aa = i%m/m*2*pi;\nyy = floor(i/m)/(k-1);\n[x,y,z] = [rad*(1-yy)*cos(aa), (yy-0.5)*h, rad*(1-yy)*sin(aa)];\n[r,g,b,a] = [1,1,1,1];\nglow = 0;\nlight = 0',
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
      vars: { rad: { expr: String(p.rad), kf: [] }, h: { expr: String(p.h), kf: [] }, turns: { expr: '3', kf: [] }, ppr: { expr: '40', kf: [] } },
      code: 'aa = i/ppr*2*pi;\n[x,y,z] = [rad*cos(aa), (i/n-0.5)*h, rad*sin(aa)];\n[r,g,b,a] = [1,1,1,1];\nglow = 1;\nlight = 8',
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
      vars: { w: { expr: String(p.w), kf: [] }, d: { expr: String(p.d), kf: [] }, cols: { expr: '16', kf: [] }, rows: { expr: '16', kf: [] } },
      code: '[x,y,z] = [((i%cols)/(cols-1)-0.5)*w, 0, (floor(i/cols)/(rows-1)-0.5)*d];\n[r,g,b,a] = [1,1,1,1];\nglow = 0;\nlight = 0',
    }),
  },
  circle: {
    label: '圆周',
    params: [
      { key: 'rad', label: '半径', def: 4 }
    ],
    build: p => ({
      count: 200,
      vars: { rad: { expr: String(p.rad), kf: [] } },
      code: 'ang = i / n * 2 * pi;\n' +
          '[x,y,z] = [rad * cos(ang), 0, rad * sin(ang)]',
    }),
  },
  disc: {
    label: '圆盘',
    params: [
      { key: 'diskR', label: '半径', def: 4 },
    ],
    build: p => ({
      count: 400,
      vars: { diskR: { expr: String(p.diskR), kf: [] } },
      code: 'rad = diskR * sqrt(i / n);\n' +
          'th = i * pi * (3 - sqrt(5));\n' +
          'x = rad * cos(th);\n' +
          'z = rad * sin(th)',
    }),
  },
  star: {
    label: '星形',
    params: [
      { key: 'rad', label: '半径', def: 20 },
    ],
    build: p => ({
      count: 2000,
      vars: { rad: { expr: String(p.rad), kf: [] } },
      code: 'm = floor(pow(n, 0.5));\nu = floor(i / m) * 2 * pi / m;\nv = i % m * pi / m - pi / 2;\nx = rad * pow(cos(u) * cos(v), 3);\ny = rad * pow(sin(u) * cos(v), 3);\nz = rad * pow(sin(v), 3)'
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
      vars: { rad: { expr: String(p.rad), kf: []}, spd: { expr: String(p.spd), kf: [] } },
      code: 'x = rand(i * 2) * 2 * rad - rad;\n' +
          'z = rand(i * 4) * 2 * rad - rad;\n' +
          '_y = rand(i * 6) * 2 * rad - rad; \n' +
          'y = -rad + (_y + rad + t * spd) % (2 * rad)'
    })
  },
};
