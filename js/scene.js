/* =========================================================================
 * Three.js 场景
 * ======================================================================= */

const viewport = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x14161c, 1);
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
camera.position.set(12, 8, 14);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.update();
controls.mouseButtons = { LEFT: null, MIDDLE: null, RIGHT: THREE.MOUSE.PAN };

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

// 底部平面网格：距离无限（视觉上延伸至地平线），移除与世界轴重合的 x=0 / z=0 中心线
const grid = (function makeGrid() {
  const half = 500, step = 1;
  const pts = [];
  for (let i = -500; i <= 500; i++) {
    const v = i * step;
    if (Math.abs(v) < 1e-6) continue; // 跳过中心线（x=0 与 z=0，由世界轴线承担）
    pts.push(-half, 0, v, half, 0, v); // 沿 X 的线（z=v）
    pts.push(v, 0, -half, v, 0, half); // 沿 Z 的线（x=v）
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x2c3342, transparent: true, opacity: 0.9 }));
})();
grid.position.y = 0;
scene.add(grid);

// ---- 底部世界三轴指示器（无限长，双向） ----
// 默认只显示 X/Z（与底部网格同面）；操作 Y 轴（移动/旋转拖拽）时才显示 Y。
// 平时 depthTest:true 正常被遮挡（不穿透）；操作中由 setWorldAxisGlow 改为穿透显示。
const WORLD_AXIS_LEN = 3000; // 半长：轴向从 -3000 延伸到 +3000
const WORLD_AXIS_DEFS = {
  X: { dir: new THREE.Vector3(1, 0, 0), color: 0xff5555 },
  Y: { dir: new THREE.Vector3(0, 1, 0), color: 0x55ff55 },
  Z: { dir: new THREE.Vector3(0, 0, 1), color: 0x5588ff },
};
const worldAxes = {};
(function buildWorldAxes() {
  const up = new THREE.Vector3(0, 1, 0);
  for (const [key, def] of Object.entries(WORLD_AXIS_DEFS)) {
    // 无体积的线（THREE.Line，1px，与网格同细）：相机经过时不会看到体积
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, -WORLD_AXIS_LEN, 0),
      new THREE.Vector3(0, WORLD_AXIS_LEN, 0),
    ]);
    // 默认 depthTest:true：不穿透，被物体正常遮挡；操作中才由 setWorldAxisGlow 改为穿透
    const mat = new THREE.LineBasicMaterial({ color: def.color, transparent: true, opacity: 1.0, depthTest: true, depthWrite: false });
    const line = new THREE.Line(geo, mat);
    line.quaternion.setFromUnitVectors(up, def.dir);
    // 双向：中心位于原点（-LEN ~ +LEN），与地面网格同面（网格中心线已移除，不会重合）
    line.position.set(0, 0, 0);
    line.renderOrder = 20;
    line.visible = key !== 'Y'; // 默认只显示 X/Z
    line.scale.set(1, 1, 1);
    worldAxes[key] = { mesh: line, baseColor: new THREE.Color(def.color) };
    scene.add(line);
  }
})();

function setWorldAxisVisible(key, visible) { if (worldAxes[key]) worldAxes[key].mesh.visible = visible; }
// glow: 0~1，把轴色向白色混合（变亮），并略微提高透明度/置顶，使其透过遮挡显示
function setWorldAxisGlow(key, glow) {
  const w = worldAxes[key];
  if (!w) return;
  w.mesh.material.color.copy(w.baseColor).lerp(new THREE.Color(1, 1, 1), Math.max(0, Math.min(1, glow)));
  w.mesh.material.opacity = 0.85 + glow * 0.15;
  const active = glow > 0.01;
  // 操作中（active）：变亮 + 穿透遮挡显示；平时：正常深度测试（线无体积，粗细不变）
  w.mesh.material.depthTest = !active;
  w.mesh.renderOrder = active ? 21 : 20;
}
// 恢复默认状态：X/Z 常显、Y 隐藏、无高亮
function resetWorldAxisState() {
  for (const key of Object.keys(WORLD_AXIS_DEFS)) {
    setWorldAxisVisible(key, key !== 'Y');
    setWorldAxisGlow(key, 0);
  }
}

// 方形贴图（2D 广告牌，始终朝向摄像头）
function makeSquareTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 16, 16);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

// 选中描边用方框贴图（中心透明，露出粒子本色，形状与粒子一致）
function makeRingTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d');
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, 30, 30);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

function focalLengthPx() {
  const h = renderer.domElement.clientHeight || 1;
  return h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}

const pointsMaterial = new THREE.ShaderMaterial({
  uniforms: { uMap: { value: makeSquareTexture() }, uPixelScale: { value: focalLengthPx() }, uOpacity: { value: 1.0 }, uTime: { value: 0.0 } },
  vertexShader: `
    uniform float uPixelScale;
    attribute vec4 aColor;
    attribute vec2 aSize;
    attribute vec4 aUV;
    attribute vec4 aUVScale;
    attribute vec4 aUVAnim;
    attribute vec2 aUVTex;
    attribute float aUVMode;
    varying vec4 vColor;
    varying vec2 vAspect;
    varying vec4 vUV;
    varying vec4 vUVScale;
    varying vec4 vUVAnim;
    varying vec2 vUVTex;
    varying float vUVMode;
    void main() {
      vColor = aColor;
      vUV = aUV; vUVScale = aUVScale; vUVAnim = aUVAnim; vUVTex = aUVTex; vUVMode = aUVMode;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      float m = max(aSize.x, aSize.y);
      gl_PointSize = m * uPixelScale / max(0.1, -mvPosition.z);
      vAspect = aSize / max(0.0001, m);
      gl_Position = projectionMatrix * mvPosition;
    }
  `,
  fragmentShader: `
    uniform sampler2D uMap;
    uniform float uOpacity;
    uniform float uTime;
    varying vec4 vColor;
    varying vec2 vAspect;
    varying vec4 vUV;
    varying vec4 vUVScale;
    varying vec4 vUVAnim;
    varying vec2 vUVTex;
    varying float vUVMode;
    void main() {
      // gl_PointCoord 约定：(0,0)=左上角（ES 规范）。vAspect 把非正方形粒子裁剪回居中方块。
      vec2 uvLocal = (gl_PointCoord - 0.5) / vAspect + 0.5;
      if (uvLocal.x < 0.0 || uvLocal.x > 1.0 || uvLocal.y < 0.0 || uvLocal.y > 1.0) discard;
      if (vUVMode < 0.5) {
        gl_FragColor = vec4(vColor.rgb, vColor.a) * uOpacity;
      } else {
        vec2 start = vUVScale.xy;              // 贴图像素坐标（自顶向下）
        if (vUVMode > 2.5) {
          float maxF = max(1.0, vUVAnim.w);
          float frame = floor(uTime * vUVAnim.z);
          frame = (vUVMode > 3.5) ? min(frame, maxF - 1.0) : mod(frame, maxF);
          // 行主 flipbook（与游戏 currentUvStart 一致）：先横向填满一行再换行
          float cols = (vUVAnim.x > 0.0 && vUVScale.x < vUVTex.x)
            ? floor((vUVTex.x - 1.0 - vUVScale.x) / vUVAnim.x) + 1.0
            : 1.0;
          start.x += vUVAnim.x * mod(frame, cols);
          start.y += vUVAnim.y * floor(frame / cols);
        }
        vec2 sp = start / vUVTex;              // 归一化到贴图（0..1，自顶向下）
        vec2 ep = sp + vUVScale.zw / vUVTex;
        // 钳制到 [0,1]，避免越界采样到 atlas 相邻区/空白
        vec2 coef = clamp(mix(sp, ep, uvLocal), 0.0, 1.0);
        // vUV.xy=(u0,v0顶)、vUV.zw=(u1,v1底)：直接 mix，v 自顶向下，与 atlas 的 v=0=顶 一致
        vec2 atlasCoord = mix(vUV.xy, vUV.zw, coef);
        vec4 tex = texture2D(uMap, atlasCoord);
        gl_FragColor = vec4(vColor.rgb, vColor.a) * tex * uOpacity;
      }
      // 全透明像素直接丢弃：discard 的片元不写深度，
      // 否则 transparent+depthWrite 会让贴图的透明区域遮挡其后的粒子（透明部分看起来不透明）
      if (gl_FragColor.a < 0.003) discard;
    }
  `,
  transparent: true,
  depthWrite: true,
  blending: THREE.NormalBlending,
});

/* ---- 贴图图集（atlas）：把所有贴图拼成一张大图，粒子用 per-point UV 采样 ---- */
let texAtlasMap = {};
let texAtlasTexture = null;

function rebuildAtlas() {
  const names = Object.keys(state.textures || {});
  if (names.length === 0) {
    texAtlasMap = {};
    return;
  }
  const cols = Math.ceil(Math.sqrt(names.length));
  let maxW = 0, maxH = 0;
  for (const n of names) { const t = state.textures[n]; maxW = Math.max(maxW, t.width); maxH = Math.max(maxH, t.height); }
  // 四周各留 1 像素透明护栏：让所有贴图内容严格落在 (0,1) 内部，
  // 避免 NearestFilter 在 v=0 / v=1 精确边界采样时取到错误行（「1」格误采到底部）。
  const gutter = 1;
  const cellW = maxW + gutter, cellH = maxH + gutter;
  const rows = Math.ceil(names.length / cols);
  const atlasW = Math.max(2, cols * cellW + gutter);
  const atlasH = Math.max(2, rows * cellH + gutter);

  // DataTexture：直接写 RGBA 像素数组，方向完全由我们掌控，不经过 CanvasTexture 隐式上传翻转。
  // 约定：data 行 0 = 贴图顶（与游戏端 MC 纹理 v=0=图顶 完全一致）；flipY=false。
  const data = new Uint8Array(atlasW * atlasH * 4); // 全 0 = 透明
  const map = {};
  names.forEach((name, i) => {
    const t = state.textures[name];
    const cx = gutter + (i % cols) * cellW;
    const cy = gutter + Math.floor(i / cols) * cellH;
    for (let y = 0; y < t.height; y++) {
      for (let x = 0; x < t.width; x++) {
        const s = (y * t.width + x) * 4;
        const d = ((cy + y) * atlasW + (cx + x)) * 4;
        data[d] = t.data[s];
        data[d + 1] = t.data[s + 1];
        data[d + 2] = t.data[s + 2];
        data[d + 3] = t.data[s + 3];
      }
    }
    // v0 = 区域顶、v1 = 区域底（自顶向下，v=0=顶）
    map[name] = {
      u0: cx / atlasW, v0: cy / atlasH,
      u1: (cx + t.width) / atlasW, v1: (cy + t.height) / atlasH,
      w: t.width, h: t.height,
    };
  });
  texAtlasMap = map;

  if (texAtlasTexture) { texAtlasTexture.dispose(); texAtlasTexture = null; }
  texAtlasTexture = new THREE.DataTexture(data, atlasW, atlasH, THREE.RGBAFormat);
  texAtlasTexture.flipY = false;      // v=0 = 数组行 0 = 贴图顶
  texAtlasTexture.minFilter = THREE.NearestFilter;
  texAtlasTexture.magFilter = THREE.NearestFilter;
  texAtlasTexture.generateMipmaps = false;   // 无 mipmap，避免 NPOT 边界伪影
  texAtlasTexture.wrapS = THREE.ClampToEdgeWrapping;
  texAtlasTexture.wrapT = THREE.ClampToEdgeWrapping;
  texAtlasTexture.needsUpdate = true;
  pointsMaterial.uniforms.uMap.value = texAtlasTexture;
}

// 选中描边（方形边框，中心透明露出粒子本色）
const selectedMaterial = new THREE.ShaderMaterial({
  uniforms: { uMap: { value: makeRingTexture() }, uPixelScale: { value: focalLengthPx() }, uOpacity: { value: 1.0 } },
  vertexShader: `
    uniform float uPixelScale;
    attribute vec2 aSize;
    varying vec2 vAspect;
    void main() {
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      float m = max(aSize.x, aSize.y);
      gl_PointSize = m * uPixelScale / max(0.1, -mvPosition.z) * 1.1;
      vAspect = aSize / max(0.0001, m);
      gl_Position = projectionMatrix * mvPosition;
    }
  `,
  fragmentShader: `
    uniform sampler2D uMap;
    uniform float uOpacity;
    varying vec2 vAspect;
    void main() {
      vec2 uv = (gl_PointCoord - 0.5) / vAspect + 0.5;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
      vec4 tex = texture2D(uMap, uv);
      gl_FragColor = vec4(1.0, 0.6, 0.25, 1.0) * tex.a * uOpacity;
    }
  `,
  transparent: true,
  depthWrite: false,
  blending: THREE.NormalBlending,
});

let points = new THREE.Points(new THREE.BufferGeometry(), pointsMaterial);
let selectedPoints = new THREE.Points(new THREE.BufferGeometry(), selectedMaterial);
let previewPoints = new THREE.Points(new THREE.BufferGeometry(), pointsMaterial);
points.renderOrder = 0;
selectedPoints.renderOrder = 1;
previewPoints.renderOrder = 0;
scene.add(points);
scene.add(selectedPoints);
scene.add(previewPoints);

const gizmoGroup = new THREE.Group();
scene.add(gizmoGroup);
gizmoGroup.visible = false;

// 旋转控制器子组：跟随本地坐标轴（对象 rot 轨道），移动控制器保持世界朝向
const gizmoRotateGroup = new THREE.Group();
gizmoGroup.add(gizmoRotateGroup);

// gizmo 渲染顺序最高：无视遮挡关系，始终绘制在最上层
const GIZMO_RING_RENDER_ORDER = 50;
const GIZMO_FACE_RENDER_ORDER = 51;
const GIZMO_ARROW_RENDER_ORDER = 52;

/* =========================================================================
 * 旋转控制器（Blender 风格，世界朝向，移除局部坐标系）
 * - 三个轴的圆环由分段弧组成，仅显示「从相机能看到」的一半（半圆环，
 *   渲染效果类似在此处放了一个球体，环是球面上的可见部分）
 * - 外部白色圆环：绕视线方向旋转
 * ======================================================================= */
const AXIS_RING_COLORS = { X: 0xff5555, Y: 0x55ff55, Z: 0x5588ff };
// 各轴环的环面法线 = 旋转轴方向（世界朝向）
const RING_NORMALS = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
const RING_SEGMENTS = 72;                       // 每环分段数（提高弧线精度）
const RING_SEG_ARC = (Math.PI * 2) / RING_SEGMENTS;
const gizmoRingSegs = {};                        // { X: [mesh...], Y: [...], Z: [...] }
const gizmoRingSegDirs = {};                     // 各段中点方向（局部坐标，gizmo 无旋转即世界方向）
(function buildRotateRings() {
  const zAxis = new THREE.Vector3(0, 0, 1);
  for (const axis of ['X', 'Y', 'Z']) {
    const align = new THREE.Quaternion().setFromUnitVectors(zAxis, new THREE.Vector3(...RING_NORMALS[axis]));
    const segs = [], dirs = [];
    for (let i = 0; i < RING_SEGMENTS; i++) {
      // 圆环管（有粗细，管径 0.014）
      const geo = new THREE.TorusGeometry(0.5, 0.014, 6, 6, RING_SEG_ARC);
      geo.rotateZ(i * RING_SEG_ARC);            // 段起点角度
      geo.applyQuaternion(align);               // 环面法线 Z -> 轴方向
      const mat = new THREE.MeshBasicMaterial({ color: AXIS_RING_COLORS[axis], depthWrite: false, depthTest: false, transparent: true });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.axis = axis;
      mesh.userData.seg = i;
      mesh.renderOrder = GIZMO_RING_RENDER_ORDER;
      segs.push(mesh);
      gizmoRotateGroup.add(mesh); // 环跟随本地坐标轴
      // 段中点方向（环平面内），用于判定「是否面向相机」
      const mid = (i + 0.5) * RING_SEG_ARC;
      dirs.push(new THREE.Vector3(Math.cos(mid), Math.sin(mid), 0).applyQuaternion(align).normalize());
    }
    gizmoRingSegs[axis] = segs;
    gizmoRingSegDirs[axis] = dirs;
  }
})();
// 外部白色视图环（绕视线方向旋转）
const gizmoViewRing = new THREE.Mesh(
  new THREE.TorusGeometry(0.62, 0.016, 10, 96),
  new THREE.MeshBasicMaterial({ color: 0xe4e8f2, depthWrite: false, depthTest: false, transparent: true, side: THREE.DoubleSide })
);
gizmoViewRing.renderOrder = GIZMO_RING_RENDER_ORDER - 1;
gizmoViewRing.userData.view = true;
gizmoGroup.add(gizmoViewRing);

/* =========================================================================
 * 面移动器：三轴之间的矩形，悬浮于该面上，始终正对相机（billboard）
 * ======================================================================= */
// 面移动器：三轴之间的矩形，固定朝向该面（法线沿该面正对的轴），
// 颜色 = 该面正对的轴的颜色（如 XZ 面正对 Y 轴 → 绿色）
const GIZMO_FACE_DEFS = {
  XY: { pos: [0.38, 0.38, 0], normal: [0, 0, 1], color: 0x5588ff },    // 正对 Z → 蓝，位于 XY 面（z=0）
  XZ: { pos: [0.38, 0, 0.38], normal: [0, 1, 0], color: 0x55ff55 },    // 正对 Y → 绿，位于 XZ 面（y=0）
  YZ: { pos: [0, 0.38, 0.38], normal: [1, 0, 0], color: 0xff5555 },    // 正对 X → 红，位于 YZ 面（x=0）
};
const FACE_AXES = { XY: ['X', 'Y'], XZ: ['X', 'Z'], YZ: ['Y', 'Z'] };
const gizmoFaces = {};
(function buildFacePlanes() {
  const zAxis = new THREE.Vector3(0, 0, 1);
  for (const [name, def] of Object.entries(GIZMO_FACE_DEFS)) {
    // 半透明填充 + 白色描边；提高不透明度、缩小尺寸
    const mat = new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.8, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
    const geo = new THREE.PlaneGeometry(0.15, 0.15);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(def.pos[0], def.pos[1], def.pos[2]);
    // 固定朝向：法线从 +Z 转到该面正对的轴方向（面始终平行于该面，不做 billboard）
    mesh.quaternion.setFromUnitVectors(zAxis, new THREE.Vector3(...def.normal));
    mesh.userData.face = name;
    mesh.renderOrder = GIZMO_FACE_RENDER_ORDER;
    // 描边（跟随 mesh 的变换）
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false })
    );
    edge.renderOrder = GIZMO_FACE_RENDER_ORDER + 1;
    mesh.add(edge);
    gizmoFaces[name] = mesh;
    gizmoGroup.add(mesh);
  }
})();
// 移动控制器：柱身 + 锥头
const gizmoArrows = {};
(function buildMoveArrows() {
  const defs = { X: [1, 0, 0, 0xff5555], Y: [0, 1, 0, 0x55ff55], Z: [0, 0, 1, 0x5588ff] };
  const up = new THREE.Vector3(0, 1, 0);
  const shaftLen = 0.9, shaftR = 0.008, headH = 0.16, headR = 0.05;
  for (const [axis, [x, y, z, color]] of Object.entries(defs)) {
    const dir = new THREE.Vector3(x, y, z);
    const group = new THREE.Group();
    group.name = axis;
    // 柱身（有粗细）+ 实心锥头（箭头加回来）
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(shaftR, shaftR, shaftLen, 10), new THREE.MeshBasicMaterial({ color, depthWrite: false, depthTest: false, transparent: true }));
    shaft.position.y = shaftLen / 2;
    const head = new THREE.Mesh(new THREE.ConeGeometry(headR, headH, 14), new THREE.MeshBasicMaterial({ color, depthWrite: false, depthTest: false, transparent: true }));
    head.position.y = shaftLen + headH / 2;
    group.add(shaft); group.add(head);
    group.quaternion.setFromUnitVectors(up, dir);
    shaft.renderOrder = GIZMO_ARROW_RENDER_ORDER;
    head.renderOrder = GIZMO_ARROW_RENDER_ORDER;
    gizmoArrows[axis] = { group, shaft, head };
    gizmoGroup.add(group);
  }
})();

// 操作轴提示线：拖拽移动/旋转的某个轴时，在 gizmo 中心画一条高亮轴线（与移动线同粗）
const gizmoAxisHint = new THREE.Mesh(
  new THREE.CylinderGeometry(0.008, 0.008, 100.0, 6, 1, true), // 无限长（双向 ±50，乘 gizmo scale 后远超屏幕）
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false, depthTest: false })
);
gizmoAxisHint.renderOrder = GIZMO_ARROW_RENDER_ORDER + 1;
gizmoAxisHint.visible = false;
gizmoGroup.add(gizmoAxisHint);

let camTransition = null;
let planePulse = null; // 绘制平面切换时的轴线发光动画 { axis, t0, dur }
