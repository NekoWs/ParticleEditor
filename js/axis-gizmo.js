/* =========================================================================
 * 右上角 Blender 风格视口操控器（3D 球体投影导航 gizmo）
 * 六轴球：正轴实心带字，负轴填充半透明轴色 + 描边；全局吸附最近球；
 * 点击切轴视图（连续同轴切反方向）；自由旋转与中键统一为 turntable
 * （水平绕相机 up、垂直绕相机右轴，刚体旋转 offset+up，可翻过极点，
 *   翻到对面后屏幕方向不反转）。
 * 透明度随深度渐变：正面不透明，背面最低降到 0.6。
 * ========================================================================= */

const gizmoCanvas = document.getElementById('axis-gizmo');
const gizmoCtx = gizmoCanvas.getContext('2d');

const GIZMO_SIZE = 112;
gizmoCanvas.width = GIZMO_SIZE; gizmoCanvas.height = GIZMO_SIZE;
const GIZMO_CENTER = GIZMO_SIZE / 2;
const SPHERE_R = 33;        // 球面半径（轴球中心到球心）
const BALL_R = 10;          // 轴球半径
const PI2 = Math.PI * 2;
const NEG_FILL_ALPHA = 0.22;// 负轴球填充透明度
const HOVER_ALPHA = 0.28;   // 悬停白圆透明度
const ROT_SPEED = 0.01;     // 旋转速度（弧度/像素）

// 正轴单位向量（用于计算目标视图方向）
const AXIS_DIRS = {
  X: new THREE.Vector3(1, 0, 0),
  Y: new THREE.Vector3(0, 1, 0),
  Z: new THREE.Vector3(0, 0, 1),
};

// 六轴球：正轴实心（红X/绿Y/蓝Z），负轴填充半透明 + 描边（同轴色）
const AXIS_DEFS = [
  { key: '+X', axis: 'X', dir: new THREE.Vector3(1, 0, 0), color: '#ff5555', sign: +1 },
  { key: '-X', axis: 'X', dir: new THREE.Vector3(-1, 0, 0), color: '#ff5555', sign: -1 },
  { key: '+Y', axis: 'Y', dir: new THREE.Vector3(0, 1, 0), color: '#55ff55', sign: +1 },
  { key: '-Y', axis: 'Y', dir: new THREE.Vector3(0, -1, 0), color: '#55ff55', sign: -1 },
  { key: '+Z', axis: 'Z', dir: new THREE.Vector3(0, 0, 1), color: '#5588ff', sign: +1 },
  { key: '-Z', axis: 'Z', dir: new THREE.Vector3(0, 0, -1), color: '#5588ff', sign: -1 },
];

let gizmoHovering = false;   // 鼠标是否悬停在 gizmo 上（决定白圆）
let snappedAxis = null;       // 当前吸附的轴球 key（'+X'/'-X'/...）
let navDrag = null;           // gizmo 拖拽 { x, y, moved }
let midDrag = null;           // 中键拖拽 { x, y }
let lastAxis = null;          // 上次点击 { axis:'X'|'Y'|'Z', sign:+1|-1 }
let navOriented = false;      // 切到轴视图后为 true，转动视角时恢复 XZ 并置 false

const _invQ = new THREE.Quaternion();
const _pv = new THREE.Vector3();
const _right = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _qEnd = new THREE.Quaternion();
const _qInterp = new THREE.Quaternion();

// 网格旋转映射：把底部网格转到 2D 视图对应的平面
const GRID_ROT = {
  XZ: [0, 0, 0],
  YZ: [0, 0, Math.PI / 2],
  XY: [Math.PI / 2, 0, 0],
};

// 每个 2D 平面内显示的世界轴（隐藏视线方向那条，避免投影退化/被网格遮挡）
const PLANE_AXES = {
  XZ: ['X', 'Z'],
  YZ: ['Y', 'Z'],
  XY: ['X', 'Y'],
};

// 世界方向 → 屏幕坐标（返回相机空间深度 z，范围约 [-1,1]，z 越小越靠前）
function projectDir(dir) {
  _invQ.copy(camera.quaternion).invert();
  _pv.copy(dir).applyQuaternion(_invQ);
  return {
    x: GIZMO_CENTER + _pv.x * SPHERE_R,
    y: GIZMO_CENTER - _pv.y * SPHERE_R,
    z: _pv.z,
  };
}

// 深度渐变：朝向相机一侧实(1)，背面渐淡到 0.45（z 越大越朝向相机）
function depthAlpha(z) {
  return 0.45 + 0.55 * ((z + 1) / 2);
}

function drawAxisGizmo() {
  const c = gizmoCtx;
  const cx = GIZMO_CENTER, cy = GIZMO_CENTER;
  c.clearRect(0, 0, GIZMO_SIZE, GIZMO_SIZE);

  // 悬停白圆（覆盖 gizmo，底层）
  if (gizmoHovering) {
    c.fillStyle = 'rgba(255,255,255,' + HOVER_ALPHA + ')';
    c.beginPath(); c.arc(cx, cy, SPHERE_R + BALL_R, 0, PI2); c.fill();
  }

  // 投影 + 按深度排序（背面 z 大先画，正面 z 小后画覆盖）
  const proj = AXIS_DEFS
    .map(def => ({ def, p: projectDir(def.dir) }))
    .sort((a, b) => a.p.z - b.p.z);

  // 正轴球与中心的颜色连线
  c.lineWidth = 2;
  for (const it of proj) {
    if (it.def.sign < 0) continue;
    c.globalAlpha = depthAlpha(it.p.z);
    c.strokeStyle = it.def.color;
    c.beginPath(); c.moveTo(cx, cy); c.lineTo(it.p.x, it.p.y); c.stroke();
  }
  c.globalAlpha = 1;

  // 球 + 文字（按深度排序，球与文字成对绘制）
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.font = 'bold 10px "Segoe UI", "Microsoft YaHei", sans-serif';
  for (const it of proj) {
    drawAxisBall(it.def, it.p);
    drawAxisLabel(it.def, it.p);
  }
  c.globalAlpha = 1;
}

function drawAxisBall(def, p) {
  const c = gizmoCtx;
  const base = depthAlpha(p.z);
  const r = BALL_R;
  if (def.sign > 0) {
    c.globalAlpha = base;
    c.fillStyle = def.color;
    c.beginPath(); c.arc(p.x, p.y, r, 0, PI2); c.fill();
    c.lineWidth = 1.5;
    c.strokeStyle = 'rgba(0,0,0,0.35)';
    c.stroke();
  } else {
    // 负轴球：填充半透明轴色 + 不透明描边
    c.globalAlpha = base * NEG_FILL_ALPHA;
    c.fillStyle = def.color;
    c.beginPath(); c.arc(p.x, p.y, r, 0, PI2); c.fill();
    c.globalAlpha = base;
    c.lineWidth = 2;
    c.strokeStyle = def.color;
    c.stroke();
  }
}

function drawAxisLabel(def, p) {
  const c = gizmoCtx;
  const base = depthAlpha(p.z);
  const isSnap = snappedAxis === def.key;
  if (def.sign > 0) {
    // 正轴球：默认黑字，吸附变白（文字在球内）
    c.globalAlpha = base;
    c.fillStyle = isSnap ? '#ffffff' : '#0c0e12';
    c.fillText(def.axis, p.x, p.y + 0.5);
  } else if (isSnap) {
    // 负轴球：吸附时在球内显示白色 -X/-Y/-Z
    c.globalAlpha = base;
    c.fillStyle = '#ffffff';
    c.fillText('-' + def.axis, p.x, p.y + 0.5);
  }
}

function canvasPoint(ev) {
  const rect = gizmoCanvas.getBoundingClientRect();
  return {
    x: (ev.clientX - rect.left) * (GIZMO_SIZE / rect.width),
    y: (ev.clientY - rect.top) * (GIZMO_SIZE / rect.height),
  };
}

// 全局吸附：取距鼠标最近的轴球（不设半径限制）
function nearestBall(pt) {
  let best = null, bestD = Infinity;
  for (const def of AXIS_DEFS) {
    const p = projectDir(def.dir);
    const d = Math.hypot(pt.x - p.x, pt.y - p.y);
    if (d < bestD) { bestD = d; best = def.key; }
  }
  return best;
}

// 统一的自由旋转（turntable）：水平绕世界 Y，垂直绕相机右轴，
// 刚体旋转 offset 与 up，可翻过极点，手感与中键一致。
function turntableRotate(dx, dy) {
  const target = controls.target;
  const offset = camera.position.clone().sub(target);
  const up = camera.up.clone();

  if (dx !== 0) {
    offset.applyAxisAngle(_yAxis, -dx * ROT_SPEED);
    up.applyAxisAngle(_yAxis, -dx * ROT_SPEED);
  }
  if (dy !== 0) {
    _forward.copy(offset).negate().normalize();
    _right.crossVectors(_forward, up).normalize();
    offset.applyAxisAngle(_right, -dy * ROT_SPEED);
    up.applyAxisAngle(_right, -dy * ROT_SPEED);
  }

  camera.position.copy(target).add(offset);
  camera.up.copy(up).normalize();
  camera.lookAt(target);
}

// gizmo 拖动自由旋转：打断过渡动画、恢复 XZ 后走 turntable
function orbitCamera(dx, dy) {
  if (camTransition) camTransition = null;
  if (navOriented) { setDrawPlane('XZ'); setWorldAxesOccluded(true); navOriented = false; }
  turntableRotate(dx, dy);
}

// 点击轴球切视图：首次（或跨轴后回来）→ 该轴正视图；连续再点同轴 → 反方向视图
function clickAxis(def) {
  let sign;
  if (lastAxis && lastAxis.axis === def.axis) sign = -lastAxis.sign;
  else sign = +1;
  lastAxis = { axis: def.axis, sign };
  orientToAxis(AXIS_DIRS[def.axis].clone().multiplyScalar(sign));
}

gizmoCanvas.addEventListener('pointerdown', (ev) => {
  gizmoCanvas.setPointerCapture(ev.pointerId);
  navDrag = { x: ev.clientX, y: ev.clientY, startX: ev.clientX, startY: ev.clientY, moved: false };
  snappedAxis = nearestBall(canvasPoint(ev));
  gizmoCanvas.style.cursor = 'grabbing';
});

gizmoCanvas.addEventListener('pointermove', (ev) => {
  if (navDrag) {
    const dx = ev.clientX - navDrag.x, dy = ev.clientY - navDrag.y;
    navDrag.x = ev.clientX; navDrag.y = ev.clientY;
    if (!navDrag.moved && Math.abs(ev.clientX - navDrag.startX) + Math.abs(ev.clientY - navDrag.startY) > 4) navDrag.moved = true;
    if (navDrag.moved) orbitCamera(dx, dy);
  } else {
    gizmoHovering = true;
    snappedAxis = nearestBall(canvasPoint(ev));
    gizmoCanvas.style.cursor = 'pointer';
  }
});

gizmoCanvas.addEventListener('pointerleave', () => {
  if (!navDrag) { gizmoHovering = false; snappedAxis = null; }
});

gizmoCanvas.addEventListener('pointerup', (ev) => {
  if (!navDrag) return;
  const wasClick = !navDrag.moved;
  navDrag = null;
  if (wasClick && snappedAxis) {
    const def = AXIS_DEFS.find(d => d.key === snappedAxis);
    if (def) clickAxis(def);
  }
  const pt = canvasPoint(ev);
  const inside = pt.x >= 0 && pt.x <= GIZMO_SIZE && pt.y >= 0 && pt.y <= GIZMO_SIZE;
  gizmoHovering = inside;
  snappedAxis = inside ? nearestBall(pt) : null;
  gizmoCanvas.style.cursor = inside ? 'pointer' : 'default';
});

// 中键自由旋转（与 gizmo 共用 turntable，方向一致）
renderer.domElement.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 1) return;
  if (camTransition) camTransition = null;
  if (navOriented) { setDrawPlane('XZ'); setWorldAxesOccluded(true); navOriented = false; }
  midDrag = { x: ev.clientX, y: ev.clientY };
  renderer.domElement.setPointerCapture(ev.pointerId);
});

renderer.domElement.addEventListener('pointermove', (ev) => {
  if (!midDrag) return;
  const dx = ev.clientX - midDrag.x, dy = ev.clientY - midDrag.y;
  midDrag.x = ev.clientX; midDrag.y = ev.clientY;
  turntableRotate(dx, dy);
});

renderer.domElement.addEventListener('pointerup', (ev) => {
  if (midDrag && ev.button === 1) midDrag = null;
});

renderer.domElement.addEventListener('pointercancel', () => { midDrag = null; });

function setDrawPlane(p) {
  state.drawPlane = p;
  // 同步底部网格到 2D 视图对应的平面
  if (typeof grid !== 'undefined' && grid) {
    const r = GRID_ROT[p] || GRID_ROT.XZ;
    grid.rotation.set(r[0], r[1], r[2]);
  }
  // 世界轴可见性：显示该平面内的两个轴，隐藏视线方向的轴
  const axes = PLANE_AXES[p] || PLANE_AXES.XZ;
  if (typeof setWorldAxisVisible === 'function') {
    setWorldAxisVisible('X', axes.indexOf('X') >= 0);
    setWorldAxisVisible('Y', axes.indexOf('Y') >= 0);
    setWorldAxisVisible('Z', axes.indexOf('Z') >= 0);
  }
}

// 世界轴遮挡开关：切 2D 视图时穿透显示（避免被网格遮挡），移动视角后恢复遮挡
function setWorldAxesOccluded(occluded) {
  if (typeof worldAxes === 'undefined') return;
  for (const key of Object.keys(worldAxes)) {
    worldAxes[key].mesh.material.depthTest = occluded;
  }
}

// 四元数球面插值（main.js 相机过渡动画使用）——处理方向反向时不发散的稳健版
function slerp(a, b, t) {
  _qEnd.setFromUnitVectors(a, b);
  _qInterp.set(0, 0, 0, 1);
  _qInterp.slerp(_qEnd, t);
  return a.clone().applyQuaternion(_qInterp);
}

// 平滑切到 dir 方向的正交视图：保持当前距离、绕 target 旋转过去、更新绘制平面
function orientToAxis(dir) {
  const dist = camera.position.distanceTo(controls.target);
  const target = controls.target.clone();
  const startDir = camera.position.clone().sub(target).normalize();
  const endPos = target.clone().sub(dir.clone().normalize().multiplyScalar(dist));
  const endDir = endPos.clone().sub(target).normalize();
  const endUp = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  camTransition = { startDir, endDir, startUp: camera.up.clone(), endUp, target, dist, t0: performance.now(), dur: 320 };
  if (Math.abs(dir.x) > 0.5) setDrawPlane('YZ');
  else if (Math.abs(dir.y) > 0.5) setDrawPlane('XZ');
  else setDrawPlane('XY');
  setWorldAxesOccluded(false); // 2D 视图穿透显示世界轴
  navOriented = true;
}
