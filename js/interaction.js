/* =========================================================================
 * 交互：Blender 式操作
 * ======================================================================= */

let drag = null;
let modal = null;
let boxSel = null;
let dragIds = null;
const lastMouse = { x: 0, y: 0 };

function currentSelected() { return state.particles.filter(p => state.selected.has(p.id)); }

function selectedGroupName() {
  return state.selectedGroup && state.groups[state.selectedGroup] ? state.selectedGroup : null;
}

// 当前是否有任何选中（粒子 / 组 / 函数对象）
function hasSelection() {
  return state.selected.size > 0 || state.selectedGroup != null || state.selectedFunction != null;
}

// 当前选中成员的粒子 id 数组（组/函数对象展开为其成员，否则为已选粒子）
function selectedMemberIds() {
  if (state.selectedFunction) return state.particles.filter(p => p.fx === state.selectedFunction).map(p => p.id);
  const g = selectedGroupName();
  if (g) return state.groups[g] || [];
  return [...state.selected];
}

// 当前选中是否包含派生粒子（基础属性只读）
function selectionHasDerived() {
  for (const id of state.selected) { const p = getParticle(id); if (isDerivedParticle(p)) return true; }
  return false;
}

// 从当前选中的派生粒子中推断所属函数对象 id（多个派生粒子必须属于同一函数对象）
function derivedFxIdFromSelection() {
  let fxId = null;
  for (const id of state.selected) {
    const p = getParticle(id);
    if (p && p.fx) {
      if (fxId && fxId !== p.fx) return null; // 分属不同函数对象，无法统一处理
      fxId = p.fx;
    }
  }
  return fxId;
}

function rotateVector(v, axis, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const dot = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
  return [
    v[0] * c + (axis[1] * v[2] - axis[2] * v[1]) * s + axis[0] * dot * (1 - c),
    v[1] * c + (axis[2] * v[0] - axis[0] * v[2]) * s + axis[1] * dot * (1 - c),
    v[2] * c + (axis[0] * v[1] - axis[1] * v[0]) * s + axis[2] * dot * (1 - c),
  ];
}

function enterGrab(clientX, clientY, axis, face) {
  const fx = getFunction(state.selectedFunction);
  if (fx) {
    pushUndo();
    const startDelta = fxPosDeltaAt(fx.id, Math.round(state.time));
    const c = [fx.center[0] + startDelta[0], fx.center[1] + startDelta[1], fx.center[2] + startDelta[2]];
    const pt = planePointAt(clientX, clientY);
    modal = { type: 'fx-grab', fxId: fx.id, startDelta, centroid: c, axis: axis || null, axisKey: axis, face: face || null, startWorld: pt ? { x: pt.x, z: pt.z } : null, startClient: { x: clientX, y: clientY }, y: c[1], faceStart: null };
    setDragAxisHighlight(modal);
    controls.enabled = false;
    return;
  }
  if (!hasSelection()) return;
  const gname = selectedGroupName();
  // 无组但选中了派生粒子 → 提升为函数对象位移
  if (!gname && selectionHasDerived()) {
    const fxId = derivedFxIdFromSelection();
    if (!fxId) return;
    const fx2 = getFunction(fxId);
    if (!fx2) return;
    state.selectedFunction = fxId; state.selectedGroup = null; state.selected.clear();
    enterGrab(clientX, clientY, axis, face);
    return;
  }
  if (gname && selectionHasDerived()) state.captureKeyframes = true;
  pushUndo();
  const origins = new Map();
  for (const id of selectedMemberIds()) {
    const p = getParticle(id);
    if (p) origins.set(id, currentVisual(p).pos.slice());
  }
  const c = gname ? groupCurrentCentroid(gname, 'pos') : selectionCentroid();
  const pt = planePointAt(clientX, clientY);
  modal = { type: 'grab', groupName: gname, startDelta: gname ? groupPosDeltaAt(gname, Math.round(state.time)) : null, origins, axis: axis || null, axisKey: axis, face: face || null, startWorld: pt ? { x: pt.x, z: pt.z } : null, startClient: { x: clientX, y: clientY }, centroid: c, y: c ? c[1] : 0, faceStart: null };
  setDragAxisHighlight(modal);
  controls.enabled = false;
}

function enterScale(clientX) {
  const fx = getFunction(state.selectedFunction);
  if (fx) {
    pushUndo();
    modal = { type: 'fx-scale', fxId: fx.id, startScale: fxScaleValueAt(fx.id, Math.round(state.time)), startClient: { x: clientX } };
    controls.enabled = false;
    return;
  }
  if (!hasSelection()) return;
  const gname = selectedGroupName();
  // 无组但选中了派生粒子 → 提升为函数对象缩放
  if (!gname && selectionHasDerived()) {
    const fxId = derivedFxIdFromSelection();
    if (!fxId) return;
    const fx2 = getFunction(fxId);
    if (!fx2) return;
    state.selectedFunction = fxId; state.selectedGroup = null; state.selected.clear();
    enterScale(clientX);
    return;
  }
  if (gname && selectionHasDerived()) state.captureKeyframes = true;
  pushUndo();
  const origins = new Map();
  for (const id of selectedMemberIds()) {
    const p = getParticle(id);
    if (p) origins.set(id, currentVisual(p).scale);
  }
  modal = { type: 'scale', groupName: gname, origins, startClient: { x: clientX } };
  controls.enabled = false;
}

const AXIS_VECTORS = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
const AXIS_INDEX = { X: 0, Y: 1, Z: 2 };

// 将鼠标射线与「过质心、法线为旋转轴」的平面求交，返回交点（世界坐标）
function rayOnAxisPlane(clientX, clientY, axisVec, centroid) {
  screenToNdc(clientX, clientY);
  raycaster.setFromCamera(pointer, camera);
  const normal = new THREE.Vector3(axisVec[0], axisVec[1], axisVec[2]);
  const origin = new THREE.Vector3(centroid[0], centroid[1], centroid[2]);
  const plane = new THREE.Plane(normal, -normal.dot(origin));
  const hit = new THREE.Vector3();
  return raycaster.ray.intersectPlane(plane, hit) ? hit : null;
}

function angleInBasis(point, centroid, u, v) {
  const rel = point.clone().sub(new THREE.Vector3(centroid[0], centroid[1], centroid[2]));
  return Math.atan2(rel.dot(v), rel.dot(u));
}

function groupRotationValueAt(gname, T) { return rotVectorAt('g:' + gname, T); }

function groupPosDeltaAt(gname, T) {
  return ['x', 'y', 'z'].map(c => {
    const tr = findTrackByPr('pos.' + c, 'g:' + gname);
    return (tr && tr.m === 'op' && tr.kf.length > 0) ? trackValueAt(tr, T, 0) : 0;
  });
}

function fxPosDeltaAt(fxId, T) {
  return ['x', 'y', 'z'].map(c => {
    const tr = findTrackByPr('pos.' + c, 'f:' + fxId);
    return (tr && tr.m === 'op' && tr.kf.length > 0) ? trackValueAt(tr, T, 0) : 0;
  });
}

function fxRotationValueAt(fxId, T) { return rotVectorAt('f:' + fxId, T); }

function fxScaleValueAt(fxId, T) {
  const tr = findTrackByPr('scl.x', 'f:' + fxId);
  return (tr && tr.kf.length > 0) ? trackValueAt(tr, T, 1) : 1;
}

function fxScaleValuesAt(fxId, T) {
  return ['x', 'y', 'z'].map(c => {
    const tr = findTrackByPr('scl.' + c, 'f:' + fxId);
    return (tr && tr.kf.length > 0) ? trackValueAt(tr, T, 1) : 1;
  });
}

function enterRotate(clientX, clientY, axis) {
  const fx = getFunction(state.selectedFunction);
  if (fx) {
    pushUndo();
    const d = fxPosDeltaAt(fx.id, Math.round(state.time));
    const c = [fx.center[0] + d[0], fx.center[1] + d[1], fx.center[2] + d[2]];
    const axArr = AXIS_VECTORS[axis] || AXIS_VECTORS.Y;
    const a = new THREE.Vector3(axArr[0], axArr[1], axArr[2]);
    let u = new THREE.Vector3(1, 0, 0);
    if (Math.abs(a.dot(u)) > 0.9) u.set(0, 1, 0);
    u.crossVectors(a, u).normalize();
    const v = new THREE.Vector3().crossVectors(a, u).normalize();
    const p0 = rayOnAxisPlane(clientX, clientY, axArr, c);
    const startAngle = p0 ? angleInBasis(p0, c, u, v) : 0;
    const startRot = fxRotationValueAt(fx.id, Math.round(state.time));
    modal = { type: 'fx-rotate', fxId: fx.id, centroid: c, axis: axArr, axisKey: axis, axisIndex: AXIS_INDEX[axis] ?? 1, startRot, u, v, startAngle };
    setDragAxisHighlight(modal);
    controls.enabled = false;
    return;
  }
  if (!hasSelection()) return;
  const gname = selectedGroupName();
  // 无组但选中了派生粒子 → 提升为函数对象旋转
  if (!gname && selectionHasDerived()) {
    const fxId = derivedFxIdFromSelection();
    if (!fxId) return;
    const fx2 = getFunction(fxId);
    if (!fx2) return;
    state.selectedFunction = fxId; state.selectedGroup = null; state.selected.clear();
    enterRotate(clientX, clientY, axis);
    return;
  }
  if (gname && selectionHasDerived()) state.captureKeyframes = true;
  pushUndo();
  const c = gname ? groupCurrentCentroid(gname, 'pos') : selectionCentroid();
  const axArr = AXIS_VECTORS[axis] || AXIS_VECTORS.Y;
  const a = new THREE.Vector3(axArr[0], axArr[1], axArr[2]);
  let u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(a.dot(u)) > 0.9) u.set(0, 1, 0);
  u.crossVectors(a, u).normalize();
  const v = new THREE.Vector3().crossVectors(a, u).normalize();
  const p0 = rayOnAxisPlane(clientX, clientY, axArr, c);
  const startAngle = p0 ? angleInBasis(p0, c, u, v) : 0;
  const origins = new Map();
  for (const id of selectedMemberIds()) {
    const p = getParticle(id);
    if (p) origins.set(id, currentVisual(p).pos.slice());
  }
  if (gname) {
    const startRot = groupRotationValueAt(gname, Math.round(state.time));
    modal = {
      type: 'group-rotate', gname, centroid: c, axis: axArr, axisKey: axis,
      axisIndex: AXIS_INDEX[axis] ?? 1, startRot,
      origins, u, v, startAngle,
    };
  } else {
    modal = {
      type: 'rotate', origins, centroid: c, axis: axArr, axisKey: axis, u, v, startAngle,
    };
  }
  setDragAxisHighlight(modal);
  controls.enabled = false;
}

/* ---------------- 视图旋转（外部白色圆环：绕视线方向旋转） ---------------- */

function viewAxisOf(c) {
  // 视线轴：从选中对象指向摄像头（摄像头相对于选中对象的轴），白圈绕该轴旋转
  const v = [camera.position.x - c[0], camera.position.y - c[1], camera.position.z - c[2]];
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function screenAngleAt(clientX, clientY, centroid) {
  const s = projectToScreen(centroid[0], centroid[1], centroid[2]);
  const rect = renderer.domElement.getBoundingClientRect();
  // 统一到画布本地坐标（projectToScreen 返回相对 rect 的坐标，client 是页面坐标）
  return Math.atan2(clientY - rect.top - s.y, clientX - rect.left - s.x);
}

// 绕世界轴 axis（单位向量）旋转 angle（弧度），复合到 startRot（度）。
// 使用四元数增量累积，避免欧拉 gimbal lock 导致 Y=90° 附近值跳变。
// rot 轨道为 extrinsic XYZ（先绕 X、再绕 Y、再绕 Z，等价 THREE.Euler 'ZYX'）。
function applyWorldRotation(startRot, axis, angle) {
  const qBase = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(startRot[0] * DEG2RAD, startRot[1] * DEG2RAD, startRot[2] * DEG2RAD, 'ZYX'));
  const qDelta = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(axis[0], axis[1], axis[2]), angle);
  const qNew = qDelta.multiply(qBase); // 世界轴旋转在左侧乘
  const eNew = new THREE.Euler().setFromQuaternion(qNew, 'ZYX');
  return [eNew.x * RAD2DEG, eNew.y * RAD2DEG, eNew.z * RAD2DEG];
}

// 从四元数中提取 Euler，被拖拽的轴使用用户的累积角度（无 ±90° 限幅）。
// 其余两轴从旋转矩阵的独立列用 atan2 提取（对 Y=90° 万向锁免疫）。
// dragAxisIdx: 0=X, 1=Y, 2=Z; -1=不用替换（视图旋转）。
function eulerFromQuatDragAxis(q, dragAxisIdx, cumAngle) {
  const me = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;
  // atan2 从矩阵独立列提取，不依赖 cos(Y) ≠ 0（无万向锁分支）
  const x = Math.atan2(me[9], me[10]) * RAD2DEG;     // atan2(R21, R22)
  const y = Math.asin(Math.max(-1, Math.min(1, -me[8]))) * RAD2DEG; // asin(-R20)
  const z = Math.atan2(me[4], me[0]) * RAD2DEG;      // atan2(R10, R00)
  const arr = [x, y, z];
  if (dragAxisIdx >= 0) arr[dragAxisIdx] = cumAngle * RAD2DEG;
  return arr;
}

// 增量四元数累乘 + 被拖拽轴用累积角度。
// modal.curQuat: 四元数, modal.cumAngle: 累积角度(弧度), modal.dragAxisIdx: 轴索引。
function applyWorldRotationQ(modal, axis, dAngle) {
  const qDelta = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(axis[0], axis[1], axis[2]), dAngle);
  // 世界轴旋转：delta 在左侧乘 → curQuat = qDelta * curQuat
  // premultiply(q) 是 this = q * this，即 qDelta 左乘到 curQuat 上
  modal.curQuat.premultiply(qDelta).normalize();
  modal.cumAngle = (modal.cumAngle || 0) + dAngle;
  return eulerFromQuatDragAxis(modal.curQuat, modal.dragAxisIdx, modal.cumAngle);
}

function enterViewRotate(clientX, clientY) {
  const fx = getFunction(state.selectedFunction);
  if (fx) {
    pushUndo();
    const d = fxPosDeltaAt(fx.id, Math.round(state.time));
    const c = [fx.center[0] + d[0], fx.center[1] + d[1], fx.center[2] + d[2]];
    const startRot = fxRotationValueAt(fx.id, Math.round(state.time));
    modal = { type: 'fx-view-rotate', fxId: fx.id, centroid: c, view: true, lookAxis: viewAxisOf(c), startRot, angle: 0, lastAngle: screenAngleAt(clientX, clientY, c) };
    controls.enabled = false;
    return;
  }
  if (!hasSelection()) return;
  const gname = selectedGroupName();
  // 无组但选中了派生粒子 → 提升为函数对象视图旋转
  if (!gname && selectionHasDerived()) {
    const fxId = derivedFxIdFromSelection();
    if (!fxId) return;
    const fx2 = getFunction(fxId);
    if (!fx2) return;
    state.selectedFunction = fxId; state.selectedGroup = null; state.selected.clear();
    enterViewRotate(clientX, clientY);
    return;
  }
  if (gname && selectionHasDerived()) state.captureKeyframes = true;
  pushUndo();
  const c = gname ? groupCurrentCentroid(gname, 'pos') : selectionCentroid();
  const origins = new Map();
  for (const id of selectedMemberIds()) {
    const p = getParticle(id);
    if (p) origins.set(id, currentVisual(p).pos.slice());
  }
  if (gname) {
    const startRot = groupRotationValueAt(gname, Math.round(state.time));
    modal = { type: 'group-view-rotate', gname, centroid: c, view: true, lookAxis: viewAxisOf(c), startRot, origins, angle: 0, lastAngle: screenAngleAt(clientX, clientY, c) };
  } else {
    modal = { type: 'view-rotate', origins, centroid: c, view: true, lookAxis: viewAxisOf(c), angle: 0, lastAngle: screenAngleAt(clientX, clientY, c) };
  }
  controls.enabled = false;
}

function updateViewRotate(clientX, clientY) {
  const m = modal;
  if (!m) return;
  // Blender trackball：增量累加角度，处理 atan2 的 ±π 跳变，支持连续多圈旋转
  const cur = screenAngleAt(clientX, clientY, m.centroid);
  let delta = cur - m.lastAngle;
  if (delta > Math.PI) delta -= Math.PI * 2;
  else if (delta < -Math.PI) delta += Math.PI * 2;
  m.lastAngle = cur;
  m.angle += delta;
  let angle = -m.angle; // 绕「对象→相机」轴，负角度使对象与拖拽方向一致（顺时针拖 → 顺时针转）
  if (shiftHeld) angle = Math.round(angle * RAD2DEG / ROT_SNAP) * ROT_SNAP * DEG2RAD;
  const a = m.lookAxis;
  if (m.type === 'fx-view-rotate' || (m.type === 'group-view-rotate' && state.captureKeyframes)) {
    const newRot = applyWorldRotation(m.startRot, a, angle);
    if (m.type === 'fx-view-rotate') {
      const t = state.captureKeyframes ? Math.round(state.time) : 0;
      setFunctionTrackValue(m.fxId, 'rot', 'set', t, newRot);
    } else {
      setGroupTrackValue(m.gname, 'rot', 'set', Math.round(state.time), newRot);
    }
    return;
  }
  // 普通粒子：直接绕质心、绕视线轴旋转位置（精确）
  const c = m.centroid;
  const entries = [];
  for (const [id, orig] of m.origins) {
    const rel = [orig[0] - c[0], orig[1] - c[1], orig[2] - c[2]];
    const r = rotateVector(rel, a, angle);
    entries.push([id, [c[0] + r[0], c[1] + r[1], c[2] + r[2]]]);
  }
  editParticles(entries, 'pos');
}

function cancelModal() {
  if (!modal) return;
  modal = null;
  controls.enabled = true;
  resetWorldAxisState();
  if (undoStack.length > 0) restore(undoStack.pop());
  updateGizmoFrame(); // 恢复圆环/视图环显示
  setGizmoHover(null, null, null, false); // 恢复拖拽高亮为基色
}

function confirmModal() {
  modal = null;
  controls.enabled = true;
  resetWorldAxisState();
  updateGizmoFrame();
  setGizmoHover(null, null, null, false); // 恢复拖拽高亮为基色
}

// 面移动器：面法线方向 + 面内两轴
const FACE_PLANES = {
  XY: { dir: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  XZ: { dir: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  YZ: { dir: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
};

// 按 modal 计算世界位移 delta（x/y/z），面移动器 / XZ 轴 / Y 轴 共用
function grabDelta(clientX, clientY, m) {
  if (m.face) {
    // 面移动器：在「过质心、法线=面法线」的平面上求交，取面内两轴的位移
    const def = FACE_PLANES[m.face];
    const p = rayOnAxisPlane(clientX, clientY, def.dir, m.centroid);
    if (!p) return null;
    if (!m.faceStart) m.faceStart = { x: p.x, y: p.y, z: p.z };
    const rx = p.x - m.faceStart.x, ry = p.y - m.faceStart.y, rz = p.z - m.faceStart.z;
    const du = rx * def.u[0] + ry * def.u[1] + rz * def.u[2];
    const dv = rx * def.v[0] + ry * def.v[1] + rz * def.v[2];
    return [
      du * def.u[0] + dv * def.v[0],
      du * def.u[1] + dv * def.v[1],
      du * def.u[2] + dv * def.v[2],
    ];
  }
  // Y 轴移动：仅依赖鼠标 Y 位移（避免镜头水平时求交失败产生“空气墙”）
  if (m.axis === 'Y') {
    const dy = -(clientY - m.startClient.y) * 0.02;
    return [0, dy, 0];
  }
  if (!m.startWorld) {
    const pt = planePointAt(clientX, clientY);
    if (!pt) return null;
    m.startWorld = { x: pt.x, z: pt.z };
    m.startClient = { x: clientX, y: clientY };
  }
  // 普通轴：绘制平面（默认 XZ）上求交，取对应轴分量（位移，不吸附）
  const pt = planePointAt(clientX, clientY);
  if (!pt) return null;
  let dx = pt.x - m.startWorld.x, dz = pt.z - m.startWorld.z;
  if (m.axis === 'X') dz = 0;
  else if (m.axis === 'Z') dx = 0;
  return [dx, 0, dz];
}

function updateGrab(clientX, clientY) {
  const m = modal;
  if (!m || (m.type !== 'grab' && m.type !== 'fx-grab')) return;
  const fxMode = m.type === 'fx-grab';
  const delta = grabDelta(clientX, clientY, m);
  if (!delta) return;
  if (fxMode) {
    const fx = getFunction(m.fxId);
    const d = m.startDelta || [0, 0, 0];
    let nd = [d[0] + delta[0], d[1] + delta[1], d[2] + delta[2]];
    // Shift：绝对位置吸附到世界网格（center + 增量 → snap → 减 center）
    if (shiftHeld && fx) nd = nd.map((v, i) => snapValue(fx.center[i] + v) - fx.center[i]);
    const t = state.captureKeyframes ? Math.round(state.time) : 0;
    setFunctionTrackValue(m.fxId, 'pos', 'op', t, nd);
  } else if (m.groupName && state.captureKeyframes) {
    const d = m.startDelta || [0, 0, 0];
    let nd = [d[0] + delta[0], d[1] + delta[1], d[2] + delta[2]];
    if (shiftHeld) {
      const base = groupCentroidValue(m.groupName, 'pos');
      nd = nd.map((v, i) => snapValue(base[i] + v) - base[i]);
    }
    setGroupTrackValue(m.groupName, 'pos', 'op', Math.round(state.time), nd);
  } else {
    // 粒子：Shift 时把每个粒子的绝对位置吸附到世界网格
    editParticles([...m.origins].map(([id, orig]) => {
      const nx = shiftHeld ? snapValue(orig[0] + delta[0]) : orig[0] + delta[0];
      const ny = shiftHeld ? snapValue(orig[1] + delta[1]) : orig[1] + delta[1];
      const nz = shiftHeld ? snapValue(orig[2] + delta[2]) : orig[2] + delta[2];
      return [id, [nx, ny, nz]];
    }), 'pos');
  }
}

function updateScale(clientX) {
  const m = modal;
  if (!m || (m.type !== 'scale' && m.type !== 'fx-scale')) return;
  const factor = Math.max(0.02, 1 + (clientX - m.startClient.x) * 0.01);
  if (m.type === 'fx-scale') {
    const s = Math.max(0.02, m.startScale * factor);
    const t = state.captureKeyframes ? Math.round(state.time) : 0;
    setFunctionTrackValue(m.fxId, 'scl', 'set', t, [s, s, s]);
    return;
  }
  if (m.groupName && state.captureKeyframes) {
    const base = groupCentroidValue(m.groupName, 'scl');
    const ns = base.map(v => Math.max(0.02, v * factor));
    setGroupTrackValue(m.groupName, 'scl', 'set', Math.round(state.time), ns);
    return;
  }
  editParticles([...m.origins].map(([id, orig]) => [id, [orig[0] * factor, orig[1] * factor, orig[2] * factor]]), 'scl');
}

function updateRotate(clientX, clientY) {
  const m = modal;
  if (!m || (m.type !== 'rotate' && m.type !== 'group-rotate' && m.type !== 'fx-rotate')) return;
  const p1 = rayOnAxisPlane(clientX, clientY, m.axis, m.centroid);
  if (!p1) return;
  let angle = angleInBasis(p1, m.centroid, m.u, m.v) - m.startAngle;
  if (shiftHeld) angle = Math.round(angle * RAD2DEG / ROT_SNAP) * ROT_SNAP * DEG2RAD;
  if (m.type === 'fx-rotate') {
    const newRot = m.startRot.slice();
    newRot[m.axisIndex] += angle * RAD2DEG;
    const t = state.captureKeyframes ? Math.round(state.time) : 0;
    setFunctionTrackValue(m.fxId, 'rot', 'set', t, newRot);
    return;
  }
  if (m.type === 'group-rotate') {
    const newRot = m.startRot.slice();
    newRot[m.axisIndex] += angle * RAD2DEG;
    if (state.captureKeyframes) {
      setGroupTrackValue(m.gname, 'rot', 'set', Math.round(state.time), newRot);
    } else {
      const entries = [];
      for (const [id, orig] of m.origins) {
        const rel = [orig[0] - m.centroid[0], orig[1] - m.centroid[1], orig[2] - m.centroid[2]];
        const r = rotateVector(rel, m.axis, angle);
        entries.push([id, [m.centroid[0] + r[0], m.centroid[1] + r[1], m.centroid[2] + r[2]]]);
      }
      editParticles(entries, 'pos');
    }
    return;
  }
  const c = m.centroid;
  const entries = [];
  for (const [id, orig] of m.origins) {
    const rel = [orig[0] - c[0], orig[1] - c[1], orig[2] - c[2]];
    const r = rotateVector(rel, m.axis, angle);
    entries.push([id, [c[0] + r[0], c[1] + r[1], c[2] + r[2]]]);
  }
  editParticles(entries, 'pos');
}

function deleteSelected() {
  // 函数对象优先：直接删除整个函数对象及其派生粒子
  if (state.selectedFunction) {
    deleteFunctionObject(state.selectedFunction);
    return;
  }
  if (state.selectedGroup) {
    deleteGroup(state.selectedGroup);
    return;
  }
  if (state.selected.size === 0) return;
  pushUndo();
  for (const id of state.selected) {
    const p = getParticle(id);
    if (isDerivedParticle(p)) continue; // 派生粒子不可单独删除
    const idx = state.particles.findIndex(x => x.id === id);
    if (idx >= 0) state.particles.splice(idx, 1);
    state.tracks = state.tracks.filter(tr => !tr.ids.includes(id));
  }
  for (const g in state.groups) {
    state.groups[g] = state.groups[g].filter(id => state.particles.some(p => p.id === id));
    if (state.groups[g].length === 0) removeGroupAndTracks(g);
  }
  state.selected.clear();
  state.selectedGroup = null;
  state.selectedFunction = null;
  rebuildPoints();
  refreshParticleTree();
}

function selectAll() {
  if (state.selected.size === state.particles.length && state.particles.length > 0) state.selected.clear();
  else state.selected = new Set(state.particles.map(p => p.id));
  state.selectedGroup = null;
  state.selectedFunction = null;
  rebuildPoints();
}

let clipboard = null;
function copySelected() {
  const gname = selectedGroupName();
  if (gname) {
    const members = (state.groups[gname] || []).map(getParticle).filter(Boolean);
    if (members.length === 0) return;
    const memberIds = new Set(members.map(m => m.id));
    const items = members.map(p => ({
      id: p.id, color: p.color.slice(), scale: (p.scale || [1, 1, 1]).slice(), glow: p.glow,
      lightLevel: p.lightLevel, pos: currentVisual(p).pos.slice(), vel: (p.vel || [0, 0, 0]).slice(),
    }));
    const tracks = state.tracks
      .filter(tr => tr.ids.some(id => id === 'g:' + gname || memberIds.has(id)))
      .map(tr => ({ pr: tr.pr, m: tr.m, ids: tr.ids.slice(), kf: tr.kf.map(k => [k[0], k[1], k[2]]) }));
    clipboard = { type: 'group', groupName: gname, items, tracks };
    return;
  }
  const sel = currentSelected();
  if (sel.length === 0) return;
  clipboard = {
    type: 'particles',
    items: sel.map(p => ({
      id: p.id, color: p.color.slice(), scale: (p.scale || [1, 1, 1]).slice(), glow: p.glow,
      lightLevel: p.lightLevel, pos: currentVisual(p).pos.slice(), vel: (p.vel || [0, 0, 0]).slice(),
    })),
  };
}
function pasteClipboard() {
  if (!clipboard || !clipboard.items || clipboard.items.length === 0) return;
  pushUndo();
  const idMap = {};
  const newIds = [];
  for (const item of clipboard.items) {
    const p = addParticle({
      color: item.color.slice(), scale: item.scale.slice(), glow: item.glow,
      lightLevel: item.lightLevel, pos: [item.pos[0] + 1, item.pos[1], item.pos[2] + 1], vel: item.vel.slice(),
    });
    idMap[item.id] = p.id;
    newIds.push(p.id);
  }
  if (clipboard.type === 'group') {
    const newGroupName = nextGroupName();
    state.groups[newGroupName] = newIds.slice();
    for (const tr of clipboard.tracks) {
      state.tracks.push({
        pr: tr.pr, m: tr.m,
        ids: tr.ids.map(id => id.startsWith('g:') ? 'g:' + newGroupName : (idMap[id] || id)),
        kf: tr.kf.map(k => [k[0], k[1], k[2]]),
      });
    }
    state.selectedGroup = newGroupName;
    state.selectedFunction = null;
  } else {
    state.selectedGroup = null;
    state.selectedFunction = null;
  }
  state.selected = new Set(newIds);
  rebuildPoints();
  refreshParticleTree();
}

function raycastGizmoMeshes(clientX, clientY, meshes) {
  if (!meshes || meshes.length === 0) return [];
  screenToNdc(clientX, clientY);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects(meshes, false);
}

function hitGizmoAxis(clientX, clientY) {
  if (!gizmoGroup.visible) return null;
  // 使用 gizmo 实际显示位置（函数对象在 center，粒子/组在质心），与 updateGizmo 一致
  const c = [gizmoGroup.position.x, gizmoGroup.position.y, gizmoGroup.position.z];
  const rect = renderer.domElement.getBoundingClientRect();
  const px = clientX - rect.left, py = clientY - rect.top;
  const scale = gizmoGroup.scale.x || 1;
  for (const [axis, v] of Object.entries(AXIS_VECTORS)) {
    // 世界坐标系（局部坐标系已移除）：直接用世界轴向量做命中检测
    const s = projectToScreen(c[0], c[1], c[2]);
    const e = projectToScreen(c[0] + v[0] * 1.5 * scale, c[1] + v[1] * 1.5 * scale, c[2] + v[2] * 1.5 * scale);
    if (distToSegment(px, py, s.x, s.y, e.x, e.y) < 20) return axis;
  }
  return null;
}

// 鼠标到轴环的最小距离 + 命中的轴（null 表示未命中）
function ringHitInfo(clientX, clientY) {
  if (!gizmoGroup.visible) return null;
  const c = [gizmoGroup.position.x, gizmoGroup.position.y, gizmoGroup.position.z];
  const rect = renderer.domElement.getBoundingClientRect();
  const px = clientX - rect.left, py = clientY - rect.top;
  const scale = gizmoGroup.scale.x || 1;
  const rotQ = gizmoRotateGroup.quaternion;
  let bestAxis = null, bestDist = Infinity;
  for (const ax of ['X', 'Y', 'Z']) {
    const segs = gizmoRingSegs[ax], dirs = gizmoRingSegDirs[ax];
    for (let i = 0; i < segs.length; i++) {
      if (!segs[i].visible) continue;
      const d = dirs[i].clone().applyQuaternion(rotQ); // 本地 -> 世界
      const p = projectToScreen(c[0] + d.x * 0.5 * scale, c[1] + d.y * 0.5 * scale, c[2] + d.z * 0.5 * scale);
      const dist = Math.hypot(px - p.x, py - p.y);
      if (dist < bestDist) { bestDist = dist; bestAxis = ax; }
    }
  }
  return bestAxis ? { axis: bestAxis, dist: bestDist } : null;
}

// 命中旋转控制器的轴圆环（仅返回轴）
function hitGizmoRotate(clientX, clientY) {
  const info = ringHitInfo(clientX, clientY);
  return info && info.dist < 15 ? info.axis : null;
}

// 命中面移动器（三轴之间的矩形）
function hitGizmoFace(clientX, clientY) {
  if (!gizmoGroup.visible) return null;
  const targets = Object.values(gizmoFaces).filter(f => f.visible);
  if (targets.length === 0) return null;
  const hits = raycastGizmoMeshes(clientX, clientY, targets);
  return hits.length ? hits[0].object.userData.face : null;
}

// 鼠标到白圈投影圆的距离（Infinity 表示未命中）
function viewRingDistance(clientX, clientY) {
  if (!gizmoGroup.visible || !gizmoViewRing.visible) return Infinity;
  const c = gizmoGroup.position;
  const rect = renderer.domElement.getBoundingClientRect();
  const px = clientX - rect.left, py = clientY - rect.top;
  const scale = gizmoGroup.scale.x || 1;
  const center = projectToScreen(c.x, c.y, c.z);
  // 白圈正对相机，屏幕半径 = 0.62 * scale * focal / depth（精确，不随视角漂移）
  const viewDir = camera.getWorldDirection(new THREE.Vector3());
  const toCam = new THREE.Vector3(c.x - camera.position.x, c.y - camera.position.y, c.z - camera.position.z);
  const depth = Math.max(0.5, toCam.dot(viewDir));
  const r = 0.62 * scale * focalLengthPx() / depth;
  return Math.abs(Math.hypot(px - center.x, py - center.y) - r);
}

// 命中外部白色视图环
function hitGizmoViewRing(clientX, clientY) {
  return viewRingDistance(clientX, clientY) < 15;
}

const AXIS_COLORS = { X: 0xff5555, Y: 0x55ff55, Z: 0x5588ff };
// 悬停时变亮，使用白色 30% 混合
function hoverColor(c) { return new THREE.Color(c).lerp(new THREE.Color(1, 1, 1), 0.3); }
function setGizmoHover(arrowAxis, ringAxis, faceKey, viewRingHover) {
  if (!gizmoGroup.visible) return;
  for (const ax of ['X', 'Y', 'Z']) {
    const col = ringAxis === ax ? hoverColor(AXIS_RING_COLORS[ax]) : AXIS_RING_COLORS[ax];
    for (const seg of gizmoRingSegs[ax]) if (seg.visible) seg.material.color.set(col);
  }
  gizmoViewRing.material.color.set(viewRingHover ? 0xffffff : 0xe4e8f2);
  for (const [ax, a] of Object.entries(gizmoArrows)) {
    const col = arrowAxis === ax ? hoverColor(AXIS_COLORS[ax]) : AXIS_COLORS[ax];
    a.shaft.material.color.set(col);
    a.head.material.color.set(col);
  }
  for (const [name, f] of Object.entries(gizmoFaces)) {
    f.material.color.set(faceKey === name ? hoverColor(GIZMO_FACE_DEFS[name].color) : GIZMO_FACE_DEFS[name].color);
    f.material.opacity = faceKey === name ? 0.95 : 0.8;
  }
}

// 拖拽时：底部世界三轴中对应的轴显示并高亮（Y 轴默认隐藏，操作 Y 时才显示）
function setDragAxisHighlight(m) {
  // 操作轴提示线由 updateGizmoFrame 在中心显示
  resetWorldAxisState();
}

renderer.domElement.addEventListener('pointerdown', (ev) => {
  lastMouse.x = ev.clientX; lastMouse.y = ev.clientY;
  if (ev.button === 1 || ev.button === 2) { renderer.domElement.style.cursor = 'grabbing'; return; }
  if (ev.button !== 0) return;
  if (modal) { confirmModal(); return; }

  if (['select', 'move', 'rotate'].includes(state.tool)) {
    const derived = selectionHasDerived() && !state.selectedFunction;
    let handled = false;
    // 移动控制器：仅在移动工具下命中轴箭头 / 面移动器
    if (state.tool === 'move') {
      const axis = derived ? null : hitGizmoAxis(ev.clientX, ev.clientY);
      if (axis) { enterGrab(ev.clientX, ev.clientY, axis, null); handled = true; }
      else {
        const face = derived ? null : hitGizmoFace(ev.clientX, ev.clientY);
        if (face) { enterGrab(ev.clientX, ev.clientY, null, face); handled = true; }
      }
    }
    // 旋转控制器：仅旋转工具下命中；白圈（外圈）与轴环（内圈）就近判定，避免互相误命中
    if (!handled && state.tool === 'rotate') {
      const viewDist = derived ? Infinity : viewRingDistance(ev.clientX, ev.clientY);
      const ring = derived ? null : ringHitInfo(ev.clientX, ev.clientY);
      if (viewDist < 15 && (!ring || viewDist <= ring.dist)) {
        enterViewRotate(ev.clientX, ev.clientY); handled = true;
      } else if (ring && ring.dist < 15) {
        enterRotate(ev.clientX, ev.clientY, ring.axis); handled = true;
      }
    }
    // 点选粒子
    if (!handled) {
      const idx = pickParticleAt(ev.clientX, ev.clientY);
      if (idx >= 0) {
        const p = particleAt(idx);
        if (p) {
          if (ev.shiftKey) { state.selected.has(p.id) ? state.selected.delete(p.id) : state.selected.add(p.id); }
          else if (!state.selected.has(p.id)) { state.selected.clear(); state.selected.add(p.id); }
          state.selectedFunction = null;
          promoteGroupSelection();
          rebuildPoints();
          // 选择工具：点选后立即进入拖动；移动/旋转工具仅选中
          if (state.tool === 'select') enterGrab(ev.clientX, ev.clientY);
          handled = true;
        }
      }
    }
    // 空白：框选（三种变换工具共用）
    if (!handled) {
      boxSel = { x0: ev.clientX, y0: ev.clientY, x1: ev.clientX, y1: ev.clientY, shift: ev.shiftKey };
      document.getElementById('box-overlay').style.display = 'block';
      updateBoxOverlay();
    }
    return;
  }

  if (state.tool === 'pencil') {
    const pt = planePointAt(ev.clientX, ev.clientY);
    if (pt) {
      pushUndo();
      const [u, v] = worldToUV(pt);
      const [x, y, z] = PLANES[state.drawPlane].toWorld(snapGrid(u), snapGrid(v), planeInfo().off);
      addParticle({ pos: [x, y, z] });
      rebuildPoints(); refreshParticleTree();
    }
    return;
  }
  if (['line', 'circle', 'rect', 'freehand'].includes(state.tool)) {
    const pt = planePointAt(ev.clientX, ev.clientY);
    if (!pt) return;
    const [u, v] = worldToUV(pt);
    controls.enabled = false;
    const su = shiftHeld ? snapValue(u) : u, sv = shiftHeld ? snapValue(v) : v;
    drag = { mode: state.tool, start: { u, v }, off: planeInfo().off, last: { u: su, v: sv }, startIndex: state.particles.length, snapU: su - u, snapV: sv - v };
    if (state.tool === 'freehand') {
      pushUndo();
      const [x, y, z] = PLANES[state.drawPlane].toWorld(su, sv, drag.off);
      addParticle({ pos: [x, y, z] });
      rebuildPoints(); refreshParticleTree();
    }
    return;
  }
});

renderer.domElement.addEventListener('pointermove', (ev) => {
  lastMouse.x = ev.clientX; lastMouse.y = ev.clientY;

  if (modal) {
    if (modal.type === 'grab' || modal.type === 'fx-grab') updateGrab(ev.clientX, ev.clientY);
    else if (modal.type === 'scale' || modal.type === 'fx-scale') updateScale(ev.clientX);
    else if (modal.type === 'rotate' || modal.type === 'group-rotate' || modal.type === 'fx-rotate') updateRotate(ev.clientX, ev.clientY);
    else if (modal.type === 'view-rotate' || modal.type === 'group-view-rotate' || modal.type === 'fx-view-rotate') updateViewRotate(ev.clientX, ev.clientY);
    return;
  }
  if (boxSel) { boxSel.x1 = ev.clientX; boxSel.y1 = ev.clientY; updateBoxOverlay(); return; }
  if (!drag) {
    // 悬停高亮：移动控制器（轴/面）与旋转控制器（环/视图环）
    if ((state.tool === 'move' || state.tool === 'rotate') && hasSelection()) {
      let ah = null, fh = null, rh = null, vh = false;
      if (state.tool === 'move') {
        ah = hitGizmoAxis(ev.clientX, ev.clientY);
        if (!ah) fh = hitGizmoFace(ev.clientX, ev.clientY);
      } else {
        // 白圈（外圈）与轴环（内圈）就近判定
        const viewDist = viewRingDistance(ev.clientX, ev.clientY);
        const ring = ringHitInfo(ev.clientX, ev.clientY);
        if (viewDist < 15 && (!ring || viewDist <= ring.dist)) { vh = true; }
        else if (ring && ring.dist < 15) { rh = ring.axis; }
      }
      setGizmoHover(ah, rh, fh, vh);
    } else {
      setGizmoHover(null, null, null, false);
    }
    // 铅笔工具：按住 Shift 显示吸附预览落点
    if (state.tool === 'pencil' && shiftHeld) {
      const pt = planePointAt(ev.clientX, ev.clientY);
      if (pt) {
        const [u, v] = worldToUV(pt);
        const [x, y, z] = PLANES[state.drawPlane].toWorld(snapValue(u), snapValue(v), planeInfo().off);
        setPreview([[x, y, z]]);
      } else {
        clearPreview();
      }
    } else {
      clearPreview();
    }
    return;
  }

  if (drag.mode === 'freehand') {
    const pt = planePointAt(ev.clientX, ev.clientY);
    if (!pt) return;
    const [u, v] = worldToUV(pt);
    const du = u + drag.snapU, dv = v + drag.snapV;
    const d = Math.hypot(du - drag.last.u, dv - drag.last.v);
    if (d >= 0.25) {
      const [x, y, z] = PLANES[state.drawPlane].toWorld(du, dv, drag.off);
      addParticle({ pos: [x, y, z] });
      drag.last = { u: du, v: dv };
      rebuildPoints(); refreshParticleTree();
    }
    return;
  }

  // 形状预览
  const pt = planePointAt(ev.clientX, ev.clientY);
  if (pt) {
    const [u, v] = worldToUV(pt);
    setPreview(computeShapePositions(drag.mode, drag.start.u, drag.start.v, u, v, drag.off));
  }
});

renderer.domElement.addEventListener('pointerup', (ev) => {
  if (ev.button !== 0) return;
  if (modal) { confirmModal(); return; }
  if (boxSel) {
    boxSel.x1 = ev.clientX; boxSel.y1 = ev.clientY;
    applyBoxSelection();
    boxSel = null;
    document.getElementById('box-overlay').style.display = 'none';
    rebuildPoints();
    return;
  }
  if (!drag) return;
  if (['line', 'circle', 'rect'].includes(drag.mode)) {
    const pt = planePointAt(ev.clientX, ev.clientY);
    if (pt) {
      const [u, v] = worldToUV(pt);
      const positions = computeShapePositions(drag.mode, drag.start.u, drag.start.v, u, v, drag.off);
      pushUndo();
      const startIndex = state.particles.length;
      for (const pos of positions) addParticle({ pos });
      autoGroup(state.particles.slice(startIndex).map(p => p.id));
    }
  } else if (drag.mode === 'freehand') {
    autoGroup(state.particles.slice(drag.startIndex).map(p => p.id));
  }
  drag = null;
  controls.enabled = true;
  clearPreview();
  rebuildPoints();
  refreshParticleTree();
});

renderer.domElement.addEventListener('contextmenu', (ev) => { ev.preventDefault(); if (modal) cancelModal(); });
window.addEventListener('pointerup', () => { renderer.domElement.style.cursor = ''; });

window.addEventListener('keydown', (ev) => {
  const k = ev.key.toLowerCase();
  const isTextInput = ev.target && ev.target.matches && ev.target.matches('input, textarea, select');
  // 文本框内：文件级快捷键（保存/打开）依然生效，避免 Ctrl+S 触发浏览器保存对话框
  if (isTextInput) {
    if (ev.ctrlKey && k === 's') { ev.preventDefault(); saveFile(); return; }
    if (ev.ctrlKey && k === 'o') { ev.preventDefault(); openFile(); return; }
    return; // 其余保留默认文本操作（Ctrl+A/C/V/Z/Y 等）
  }
  if (ev.ctrlKey && k === 'z') { ev.preventDefault(); if (typeof texActive !== 'undefined' && texActive) { texUndo(); return; } if (ev.shiftKey) redo(); else undo(); return; }
  if (ev.ctrlKey && k === 'y') { ev.preventDefault(); if (typeof texActive !== 'undefined' && texActive) { texRedo(); return; } redo(); return; }
  if (ev.ctrlKey && k === 'n') { ev.preventDefault(); newFile(); return; }
  if (ev.ctrlKey && k === 's') { ev.preventDefault(); saveFile(); return; }
  if (ev.ctrlKey && k === 'o') { ev.preventDefault(); openFile(); return; }
  if (ev.ctrlKey && k === 'g') { ev.preventDefault(); createGroup(); return; }
  if (ev.ctrlKey && k === 'a') { ev.preventDefault(); selectAll(); return; }
  if (ev.ctrlKey && k === 'd') { ev.preventDefault(); state.selected.clear(); state.selectedGroup = null; state.selectedFunction = null; rebuildPoints(); return; }
  if (ev.ctrlKey && k === 'c') { ev.preventDefault(); copySelected(); return; }
  if (ev.ctrlKey && k === 'v') { ev.preventDefault(); pasteClipboard(); return; }
  if (k === ' ') { ev.preventDefault(); togglePlay(); return; }
  if (modal) {
    if (k === 'escape') cancelModal();
    else if (k === 'enter') confirmModal();
    else if ((modal.type === 'grab' || modal.type === 'fx-grab') && (k === 'x' || k === 'y' || k === 'z')) {
      modal.axis = modal.axis === k.toUpperCase() ? null : k.toUpperCase();
      if (modal.axis) modal.face = null; // 切换为单轴约束时放弃面移动
      setDragAxisHighlight(modal);
    }
    return;
  }
  if (k === 's') enterScale(lastMouse.x);
  else if (k === 'delete') deleteSelected();
  else if (k === 'escape') { state.selected.clear(); state.selectedGroup = null; state.selectedFunction = null; rebuildPoints(); }
});

function updateBoxOverlay() {
  const ov = document.getElementById('box-overlay');
  const rect = renderer.domElement.getBoundingClientRect();
  const x = Math.min(boxSel.x0, boxSel.x1) - rect.left;
  const y = Math.min(boxSel.y0, boxSel.y1) - rect.top;
  ov.style.left = x + 'px'; ov.style.top = y + 'px';
  ov.style.width = Math.abs(boxSel.x1 - boxSel.x0) + 'px';
  ov.style.height = Math.abs(boxSel.y1 - boxSel.y0) + 'px';
}

// 选中集合恰好等于某组全部成员时，自动提升为选中该组
function promoteGroupSelection() {
  for (const [gname, members] of Object.entries(state.groups)) {
    if (members.length === 0) continue;
    if (state.selected.size === members.length && members.every(id => state.selected.has(id))) {
      state.selectedGroup = gname;
      state.selectedFunction = null;
      return;
    }
  }
  state.selectedGroup = null;
}

// 按优先级解析选中：函数对象 > 组 > 单个粒子
function resolveSelectionPriority() {
  state.selectedFunction = null;
  state.selectedGroup = null;
  // 1. 函数对象：选中集合覆盖某函数对象的全部派生粒子 → 选中该函数对象
  for (const fx of state.functions) {
    const ids = state.particles.filter(p => p.fx === fx.id).map(p => p.id);
    if (ids.length > 0 && ids.every(id => state.selected.has(id))) {
      state.selectedFunction = fx.id;
      return;
    }
  }
  // 2. 组：选中集合恰好等于某组全部成员 → 提升为选中该组
  promoteGroupSelection();
}

function applyBoxSelection() {
  const rect = renderer.domElement.getBoundingClientRect();
  const x0 = Math.min(boxSel.x0, boxSel.x1) - rect.left, y0 = Math.min(boxSel.y0, boxSel.y1) - rect.top;
  const x1 = Math.max(boxSel.x0, boxSel.x1) - rect.left, y1 = Math.max(boxSel.y0, boxSel.y1) - rect.top;
  const sel = new Set();
  for (const p of state.particles) {
    const v = currentVisual(p).pos;
    const s = projectToScreen(v[0], v[1], v[2]);
    if (s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1) sel.add(p.id);
  }
  if (boxSel.shift) for (const id of sel) state.selected.add(id);
  else state.selected = sel;
  resolveSelectionPriority();
  if (state.selectedFunction) refreshFunctionPanel(); // 选中函数对象时刷新其属性面板
}

/* =========================================================================
 * 绘制粒子数量交互：右键短按弹编辑框 + range，拖动时滚轮增减数量
 * ======================================================================= */

const DRAW_TOOLS = ['pencil', 'line', 'circle', 'rect', 'freehand'];
const DRAW_COUNT_MAX = 1000;

function isDrawTool() { return DRAW_TOOLS.includes(state.tool); }

let rightDownPos = null;
let drawCountEditor = null;
let drawCountDismiss = null; // document pointerdown 关闭监听器

function closeDrawCountEditor() {
  if (drawCountDismiss) { document.removeEventListener('pointerdown', drawCountDismiss); drawCountDismiss = null; }
  if (drawCountEditor) { drawCountEditor.remove(); drawCountEditor = null; }
}

// 右键短按：悬浮粒子数量编辑框 + range 编辑条
function showDrawCountEditor(cx, cy) {
  closeDrawCountEditor();
  const box = document.createElement('div');
  box.className = 'draw-count-editor';
  box.innerHTML = '<span class="dce-label">' + t('draw.countLabel') + '</span>';
  const num = document.createElement('input');
  num.type = 'number'; num.min = '2'; num.max = DRAW_COUNT_MAX; num.value = state.drawCount;
  box.appendChild(num);
  const range = document.createElement('input');
  range.type = 'range'; range.min = '2'; range.max = DRAW_COUNT_MAX; range.value = state.drawCount;
  box.appendChild(range);
  num.addEventListener('input', () => { state.drawCount = clampCount(num.value); range.value = state.drawCount; });
  num.addEventListener('change', () => { state.drawCount = clampCount(num.value); range.value = state.drawCount; });
  range.addEventListener('input', () => { state.drawCount = clampCount(range.value); num.value = state.drawCount; });
  // 框内点击不关闭
  box.addEventListener('pointerdown', (e) => e.stopPropagation());
  document.body.appendChild(box);
  box.style.left = Math.min(cx, window.innerWidth - 260) + 'px';
  box.style.top = Math.min(cy, window.innerHeight - 60) + 'px';
  drawCountEditor = box;
  setTimeout(() => num.focus(), 0);
  // 点击外部关闭
  drawCountDismiss = (e) => {
    if (!box.contains(e.target)) closeDrawCountEditor();
  };
  // 延迟注册，避免本次右键 pointerup 事件立即触发关闭
  setTimeout(() => document.addEventListener('pointerdown', drawCountDismiss), 0);
}
function clampCount(v) { return Math.max(2, Math.min(DRAW_COUNT_MAX, Math.round(parseInt(v) || 30))); }

renderer.domElement.addEventListener('pointerdown', (ev) => {
  if (ev.button === 2) rightDownPos = { x: ev.clientX, y: ev.clientY };
});
window.addEventListener('pointerup', (ev) => {
  if (ev.button === 2 && rightDownPos) {
    const dx = ev.clientX - rightDownPos.x, dy = ev.clientY - rightDownPos.y;
    rightDownPos = null;
    if (Math.hypot(dx, dy) < 5 && isDrawTool()) showDrawCountEditor(ev.clientX, ev.clientY);
  }
});

// 拖动绘制时滚轮：动态增减粒子数量（实时更新形状预览）
renderer.domElement.addEventListener('wheel', (ev) => {
  if (!isDrawTool() || (!drag && !boxSel)) return;
  const d = ev.deltaY < 0 ? 1 : -1;
  state.drawCount = clampCount(state.drawCount + d * (ev.shiftKey ? 10 : 1));
  syncDrawCountEditorValues();
  // 实时刷新当前形状预览
  if (drag && ['line', 'circle', 'rect', 'freehand'].includes(drag.mode)) {
    const pt = planePointAt(lastMouse.x, lastMouse.y);
    if (pt) {
      const [u, v] = worldToUV(pt);
      setPreview(computeShapePositions(drag.mode, drag.start.u, drag.start.v, u, v, drag.off));
    }
  }
}, { passive: true });

function syncDrawCountEditorValues() {
  if (!drawCountEditor) return;
  const inputs = drawCountEditor.querySelectorAll('input');
  if (inputs.length === 2) { inputs[0].value = state.drawCount; inputs[1].value = state.drawCount; }
}
