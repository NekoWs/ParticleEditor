// 交互：Blender 式操作。视口点选/框选、移动/旋转/缩放拖拽、绘制工具、剪贴板、
// 快捷键与绘制数量编辑。

import * as THREE from 'three';
import { t } from '../core/i18n.js';
import { hasTouch, addLongPress } from '../core/device.js';
import { state, getParticle, getFunction, getCamera, isDerivedParticle, RAD2DEG, ROT_SNAP, PLANES, DEG2RAD, nextGroupName, DEFAULT_CAMERA_ID } from '../core/constants.js';
import { shiftHeld } from './input-state.js';
import { camera, renderer, controls, raycaster, pointer, gizmoGroup, gizmoRotateGroup, gizmoRingSegs, gizmoRingSegDirs, gizmoViewRing, gizmoFaces, gizmoArrows, AXIS_RING_COLORS, GIZMO_FACE_DEFS, RING_NORMALS, RING_SEGMENTS, RING_SEG_ARC, resetWorldAxisState, focalLengthPx } from '../scene/scene.js';
import { currentVisual, rebuildPoints, setPreview, clearPreview, rotVectorAt, spinVectorAt, orbitCenterAt, trackValueAt, findTrackByPr, groupScaleAt, spinMatrix, mat3VecArray, applyLocalSpinRotation, applyLocalSpinRotationVec, applyLocalOrbitRotation, applyLocalOrbitRotationVec, eulerNearPrevDeg } from '../core/animation.js';
import { screenToNdc, planePointAt, worldToUV, computeShapePositions, snapGrid, snapValue, pickParticleAt, particleAt, projectToScreen, distToSegment, planeInfo, selectionCentroid, updateGizmo, updateGizmoFrame } from './gizmo.js';
import { groupCurrentCentroid, groupCentroidValue, deleteGroup, createGroup } from '../ui/tree.js';
import { refreshFunctionPanel } from '../ui/panels.js';
import { refreshTimelineTree, syncSelectionClasses } from '../ui/timeline-tree.js';
import { setFunctionTrackValue, setGroupTrackValue, setComponentKeyframe, editParticles, addParticle, autoGroup, removeGroupAndTracks } from '../core/edit.js';
import { pushUndo, restore, undoStack, undo, redo } from '../state/undo.js';
import { deleteFunctionObject } from '../core/generators.js';
import { texUndo, texRedo, texActive } from '../ui/texture-editor.js';
import { togglePlay, refreshCameraTabs } from '../main.js';
import { saveFile, openFile, newFile } from '../io/io.js';
import { nextCameraId, nextCameraName } from '../core/constants.js';
import { createCameraAt, lockCamera, camOrientationQuaternion, cameraPoseAt } from '../core/cameras.js';

export let drag = null;
export let modal = null;
export let boxSel = null;
export const lastMouse = { x: 0, y: 0 };

// —— 触屏手势协调 ——
// OrbitControls 在 renderer.domElement 上以 bubble 阶段监听 pointerdown，本模块的选择/绘制逻辑
// 也监听同一元素。为避免触屏上「编辑手势」与「OrbitControls 旋转」同时触发，这里在捕获阶段
// 预判：这次触控该由编辑器处理（点选/拖 gizmo/绘制）就先禁用 controls，再由 bubble 逻辑接管；
// 否则放行给 OrbitControls（单指旋转、双指平移缩放）。
const activeTouchIds = new Set();
const gatedTouchIds = new Set();
let touchPending = null; // 触屏选择工具：点中粒子后待命，拖动超过阈值才进入移动

function touchGizmoHit(ev) {
  const derived = selectionHasDerived() && !state.selectedFunction;
  if (state.tool === 'move') {
    if (derived) return false;
    return !!(hitGizmoAxis(ev.clientX, ev.clientY) || hitGizmoFace(ev.clientX, ev.clientY));
  }
  if (state.tool === 'rotate') {
    if (derived) return false;
    const viewDist = viewRingDistance(ev.clientX, ev.clientY);
    const ring = ringHitInfo(ev.clientX, ev.clientY);
    return (viewDist < 15 && (!ring || viewDist <= ring.dist)) || !!(ring && ring.dist < 15);
  }
  return false;
}

function shouldHandleTouch(ev) {
  if (['pencil', 'line', 'circle', 'rect', 'freehand', 'camera'].includes(state.tool)) return true;
  if (state.tool === 'select') return pickParticleAt(ev.clientX, ev.clientY) >= 0;
  if (state.tool === 'move' || state.tool === 'rotate') {
    if (touchGizmoHit(ev)) return true;
    return pickParticleAt(ev.clientX, ev.clientY) >= 0;
  }
  return false;
}

function releaseTouch(ev) {
  if (ev.pointerType !== 'touch') return;
  activeTouchIds.delete(ev.pointerId);
  gatedTouchIds.delete(ev.pointerId);
  if (activeTouchIds.size === 0 && !modal) controls.enabled = true;
}

export function currentSelected() { return state.particles.filter(p => state.selected.has(p.id)); }

export function selectedGroupName() {
  return state.selectedGroup && state.groups[state.selectedGroup] ? state.selectedGroup : null;
}

// 仅当「只选中摄像机（无粒子/组/函数对象选中）」时返回该摄像机；否则返回 null，
// 保证旋转 gizmo 在混合选择时优先服务粒子/组/函数对象。
export function selectedCameraForRotate() {
  const cam = getCamera(state.selectedCamera);
  if (!cam) return null;
  if (state.selected.size > 0 || state.selectedFunction || state.selectedGroup) return null;
  return cam;
}

// 当前旋转目标的自转空间（仅组/函数对象有自转）。
export function currentSpinTarget() {
  const fxId = state.selectedFunction;
  if (fxId) {
    const fx = getFunction(fxId);
    if (fx) return { prefix: 'f:' + fxId, space: fx.spinSpace === 'local' ? 'local' : 'world' };
  }
  const gname = selectedGroupName();
  if (gname) return { prefix: 'g:' + gname, space: (state.groupSpinSpace && state.groupSpinSpace[gname] === 'world') ? 'world' : 'local' };
  return null;
}

export function currentSpinSpace() {
  const t = currentSpinTarget();
  return t ? t.space : 'world';
}

// 当前旋转目标的公转空间（仅组/函数对象有公转）。
export function currentRotTarget() {
  const fxId = state.selectedFunction;
  if (fxId) {
    const fx = getFunction(fxId);
    if (fx) return { prefix: 'f:' + fxId, space: fx.rotSpace === 'local' ? 'local' : 'world' };
  }
  const gname = selectedGroupName();
  if (gname) return { prefix: 'g:' + gname, space: (state.groupRotSpace && state.groupRotSpace[gname] === 'world') ? 'world' : 'local' };
  return null;
}

export function currentRotSpace() {
  const t = currentRotTarget();
  return t ? t.space : 'world';
}

// 当前是否有任何选中（粒子 / 组 / 函数对象）
export function hasSelection() {
  return state.selected.size > 0 || state.selectedGroup != null || state.selectedFunction != null;
}

// 当前选中成员的粒子 id 数组（组/函数对象展开为其成员，否则为已选粒子）
export function selectedMemberIds() {
  if (state.selectedFunction) return state.particles.filter(p => p.fx === state.selectedFunction).map(p => p.id);
  const g = selectedGroupName();
  if (g) return state.groups[g] || [];
  return [...state.selected];
}

// 当前选中是否包含派生粒子（基础属性只读）
export function selectionHasDerived() {
  for (const id of state.selected) { const p = getParticle(id); if (isDerivedParticle(p)) return true; }
  return false;
}

// 从当前选中的派生粒子中推断所属函数对象 id（多个派生粒子必须属于同一函数对象）
export function derivedFxIdFromSelection() {
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

// 无组但选中了派生粒子时，把选择提升为所属函数对象；返回提升后的 fxId（不可提升返回 null）。
function promoteDerivedToFunction() {
  if (selectedGroupName() || !selectionHasDerived()) return null;
  const fxId = derivedFxIdFromSelection();
  if (!fxId || !getFunction(fxId)) return null;
  state.selectedFunction = fxId;
  state.selectedGroup = null;
  state.selectedCamera = null;
  state.selected.clear();
  return fxId;
}

// 变换入口共用：无选择或已提升为函数对象时返回 undefined（调用方中止）；
// 否则推进撤销并返回当前组名（无组为 null）。
function beginSelectionTransform(recurse) {
  if (!hasSelection()) return undefined;
  const gname = selectedGroupName();
  if (promoteDerivedToFunction()) { recurse(); return undefined; }
  if (gname && selectionHasDerived()) state.captureKeyframes = true;
  pushUndo();
  return gname;
}

// 变换入口共用：按 selectedMemberIds 快照每个粒子的指定值。
function snapshotSelection(getValue) {
  const origins = new Map();
  for (const id of selectedMemberIds()) {
    const p = getParticle(id);
    if (p) origins.set(id, getValue(p));
  }
  return origins;
}

// 旋转共用：把 origins 中的位置绕 centroid/axis 旋转后写回粒子。
function rotateOriginsAndCommit(m, axis, angle) {
  const c = m.centroid;
  const entries = [];
  for (const [id, orig] of m.origins) {
    const rel = [orig[0] - c[0], orig[1] - c[1], orig[2] - c[2]];
    const r = rotateVector(rel, axis, angle);
    entries.push([id, [c[0] + r[0], c[1] + r[1], c[2] + r[2]]]);
  }
  editParticles(entries, 'pos');
}

export function rotateVector(v, axis, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const dot = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
  return [
    v[0] * c + (axis[1] * v[2] - axis[2] * v[1]) * s + axis[0] * dot * (1 - c),
    v[1] * c + (axis[2] * v[0] - axis[0] * v[2]) * s + axis[1] * dot * (1 - c),
    v[2] * c + (axis[0] * v[1] - axis[1] * v[0]) * s + axis[2] * dot * (1 - c),
  ];
}

export function enterGrab(clientX, clientY, axis, face) {
  const fx = getFunction(state.selectedFunction);
  if (fx) {
    pushUndo();
    const startDelta = fxPosDeltaAt(fx.id, Math.round(state.time));
    const c = fxCurrentPos(fx.id, Math.round(state.time));
    const pt = planePointAt(clientX, clientY);
    modal = { type: 'fx-grab', fxId: fx.id, startDelta, centroid: c, axis: axis || null, axisKey: axis, face: face || null, startWorld: pt ? { x: pt.x, z: pt.z } : null, startClient: { x: clientX, y: clientY }, y: c[1], faceStart: null };
    setDragAxisHighlight(modal);
    controls.enabled = false;
    return;
  }
  const gname = beginSelectionTransform(() => enterGrab(clientX, clientY, axis, face));
  if (gname === undefined) return;
  const origins = snapshotSelection(p => currentVisual(p).pos.slice());
  const c = gname ? groupCurrentCentroid(gname, 'pos') : selectionCentroid();
  const pt = planePointAt(clientX, clientY);
  modal = { type: 'grab', groupName: gname, startDelta: gname ? groupPosDeltaAt(gname, Math.round(state.time)) : null, origins, axis: axis || null, axisKey: axis, face: face || null, startWorld: pt ? { x: pt.x, z: pt.z } : null, startClient: { x: clientX, y: clientY }, centroid: c, y: c ? c[1] : 0, faceStart: null };
  setDragAxisHighlight(modal);
  controls.enabled = false;
}

export function enterScale(clientX) {
  const fx = getFunction(state.selectedFunction);
  if (fx) {
    pushUndo();
    modal = { type: 'fx-scale', fxId: fx.id, startScale: fxScaleValueAt(fx.id, Math.round(state.time)), startClient: { x: clientX } };
    controls.enabled = false;
    return;
  }
  const gname = beginSelectionTransform(() => enterScale(clientX));
  if (gname === undefined) return;
  const origins = snapshotSelection(p => currentVisual(p).scale);
  modal = { type: 'scale', groupName: gname, origins, startScale: groupScaleAt(gname, Math.round(state.time)), startClient: { x: clientX } };
  controls.enabled = false;
}

export const AXIS_VECTORS = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
export const AXIS_INDEX = { X: 0, Y: 1, Z: 2 };

// 将鼠标射线与「过质心、法线为旋转轴」的平面求交，返回交点（世界坐标）
export function rayOnAxisPlane(clientX, clientY, axisVec, centroid) {
  screenToNdc(clientX, clientY);
  raycaster.setFromCamera(pointer, camera);
  const normal = new THREE.Vector3(axisVec[0], axisVec[1], axisVec[2]);
  const origin = new THREE.Vector3(centroid[0], centroid[1], centroid[2]);
  const plane = new THREE.Plane(normal, -normal.dot(origin));
  const hit = new THREE.Vector3();
  return raycaster.ray.intersectPlane(plane, hit) ? hit : null;
}

export function angleInBasis(point, centroid, u, v) {
  const rel = point.clone().sub(new THREE.Vector3(centroid[0], centroid[1], centroid[2]));
  return Math.atan2(rel.dot(v), rel.dot(u));
}

export function groupRotationValueAt(gname, T) { return rotVectorAt('g:' + gname, T); }

// 某 id 的自转向量（spin.x/y/z，度）—— 见 animation.js 的 spinVectorAt。

function posDeltaAt(prefix, T) {
  return ['x', 'y', 'z'].map(c => {
    const tr = findTrackByPr('pos.' + c, prefix);
    return (tr && tr.m === 'op' && tr.kf.length > 0) ? trackValueAt(tr, T, 0) : 0;
  });
}

export function groupPosDeltaAt(gname, T) { return posDeltaAt('g:' + gname, T); }
export function fxPosDeltaAt(fxId, T) { return posDeltaAt('f:' + fxId, T); }

export function fxRotationValueAt(fxId, T) { return rotVectorAt('f:' + fxId, T); }

export function fxScaleValueAt(fxId, T) { return fxScaleValuesAt(fxId, T)[0]; }

export function fxScaleValuesAt(fxId, T) {
  return ['x', 'y', 'z'].map(c => {
    const tr = findTrackByPr('scl.' + c, 'f:' + fxId);
    return (tr && tr.kf.length > 0) ? trackValueAt(tr, T, 1) : 1;
  });
}

// 函数对象当前整体位置 = center + 当前 pos 增量
export function fxCurrentPos(fxId, T) {
  const fx = getFunction(fxId);
  if (!fx) return null;
  const d = fxPosDeltaAt(fxId, T);
  return [fx.center[0] + d[0], fx.center[1] + d[1], fx.center[2] + d[2]];
}

// 旋转轴 → 正对相机平面的一组正交基（用于平面求交 + 角度测量）。
// axisVecOverride 可传入世界坐标下的轴向量（局部自转时局部轴已变换到世界）。
export function rotationBasis(axis, axisVecOverride) {
  const axArr = axisVecOverride || AXIS_VECTORS[axis] || AXIS_VECTORS.Y;
  const a = new THREE.Vector3(axArr[0], axArr[1], axArr[2]);
  let u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(a.dot(u)) > 0.9) u.set(0, 1, 0);
  u.crossVectors(a, u).normalize();
  const v = new THREE.Vector3().crossVectors(a, u).normalize();
  return { axArr, u, v };
}

export function enterRotate(clientX, clientY, axis) {
  // 摄像机：旋转 = 绕「看向目标点」公转（逻辑与粒子公转一致）。
  // 局部空间时环轴 = 摄像机看向目标后的自身朝向；世界空间时环轴 = 世界轴。
  const cam = selectedCameraForRotate();
  if (cam && state.tool === 'rotate') {
    pushUndo();
    const T = Math.round(state.time);
    const pose = cameraPoseAt(cam.id, T);
    if (!pose) return;
    const pivot = pose.target;
    const startRot = rotVectorAt('c:' + cam.id, T);
    const rotSpace = cam.rotSpace === 'world' ? 'world' : 'local';
    // 拖动期间冻结朝向与环半径：记录按下瞬间的朝向四元数与「相机到目标」距离
    const startQ = camOrientationQuaternion(cam.id, T) || new THREE.Quaternion();
    const startDist = Math.hypot(pose.pos[0] - pivot[0], pose.pos[1] - pivot[1], pose.pos[2] - pivot[2]);
    let axisWorld = AXIS_VECTORS[axis];
    if (rotSpace === 'local') {
      const v = new THREE.Vector3(axisWorld[0], axisWorld[1], axisWorld[2]).applyQuaternion(startQ);
      axisWorld = [v.x, v.y, v.z];
    }
    const { axArr, u, v } = rotationBasis(axis, axisWorld);
    const p0 = rayOnAxisPlane(clientX, clientY, axArr, pivot);
    const startAngle = p0 ? angleInBasis(p0, pivot, u, v) : 0;
    modal = { type: 'camera-rotate', camId: cam.id, centroid: pivot, axis: axArr, axisKey: axis, axisIndex: AXIS_INDEX[axis] ?? 1, startRot, rotSpace, startQ, startDist, u, v, startAngle };
    setDragAxisHighlight(modal);
    controls.enabled = false;
    return;
  }
  const fx = getFunction(state.selectedFunction);
  if (fx) {
    pushUndo();
    const T = Math.round(state.time);
    const startRot = fxRotationValueAt(fx.id, T);
    const startSpin = spinVectorAt('f:' + fx.id, T);
    const spinSpace = state.rotMode === 'spin' ? (fx.spinSpace === 'local' ? 'local' : 'world') : 'world';
    const rotSpace = state.rotMode === 'orbit' ? (fx.rotSpace === 'local' ? 'local' : 'world') : 'world';
    const c = state.rotMode === 'orbit'
      ? orbitCenterAt('f:' + fx.id, state.time)
      : fxCurrentPos(fx.id, T);
    const localAxis = (state.rotMode === 'spin' && spinSpace === 'local') || (state.rotMode === 'orbit' && rotSpace === 'local');
    const axisWorld = localAxis
      ? mat3VecArray(spinMatrix(startSpin, spinSpace), AXIS_VECTORS[axis])
      : AXIS_VECTORS[axis];
    const { axArr, u, v } = rotationBasis(axis, axisWorld);
    const p0 = rayOnAxisPlane(clientX, clientY, axArr, c);
    const startAngle = p0 ? angleInBasis(p0, c, u, v) : 0;
    modal = { type: 'fx-rotate', fxId: fx.id, centroid: c, axis: axArr, axisKey: axis, axisIndex: AXIS_INDEX[axis] ?? 1, startRot, startSpin, rotMode: state.rotMode, spinSpace, rotSpace, u, v, startAngle };
    setDragAxisHighlight(modal);
    controls.enabled = false;
    return;
  }
  const gname = beginSelectionTransform(() => enterRotate(clientX, clientY, axis));
  if (gname === undefined) return;
  const selParticles = state.particles.filter(p => state.selected.has(p.id));
  const T = Math.round(state.time);
  const startSpin = gname ? spinVectorAt('g:' + gname, T) : [0, 0, 0];
  const spinSpace = (gname && state.rotMode === 'spin')
    ? ((state.groupSpinSpace && state.groupSpinSpace[gname] === 'world') ? 'world' : 'local')
    : 'world';
  const rotSpace = (gname && state.rotMode === 'orbit')
    ? ((state.groupRotSpace && state.groupRotSpace[gname] === 'world') ? 'world' : 'local')
    : 'world';
  const c = gname
    ? (state.rotMode === 'orbit' ? orbitCenterAt('g:' + gname, state.time) : groupCurrentCentroid(gname, 'pos'))
    : (state.rotMode === 'orbit' && selParticles.length === 1 ? orbitCenterAt(selParticles[0].id, state.time) : selectionCentroid());
  const localAxis = (gname && state.rotMode === 'spin' && spinSpace === 'local') || (gname && state.rotMode === 'orbit' && rotSpace === 'local');
  const axisWorld = localAxis
    ? mat3VecArray(spinMatrix(startSpin, spinSpace), AXIS_VECTORS[axis])
    : AXIS_VECTORS[axis];
  const { axArr, u, v } = rotationBasis(axis, axisWorld);
  const p0 = rayOnAxisPlane(clientX, clientY, axArr, c);
  const startAngle = p0 ? angleInBasis(p0, c, u, v) : 0;
  const origins = snapshotSelection(p => currentVisual(p).pos.slice());
  if (gname) {
    const startRot = groupRotationValueAt(gname, T);
    modal = {
      type: 'group-rotate', gname, centroid: c, axis: axArr, axisKey: axis,
      axisIndex: AXIS_INDEX[axis] ?? 1, startRot, startSpin, rotMode: state.rotMode, spinSpace, rotSpace,
      origins, u, v, startAngle,
    };
  } else {
    const startRots = new Map();
    for (const id of selectedMemberIds()) startRots.set(id, rotVectorAt(id, Math.round(state.time)));
    modal = {
      type: 'rotate', origins, centroid: c, axis: axArr, axisKey: axis,
      axisIndex: AXIS_INDEX[axis] ?? 1, rotMode: state.rotMode, u, v, startAngle, startRots,
    };
  }
  setDragAxisHighlight(modal);
  controls.enabled = false;
}

// —— 视图旋转（外部白色圆环：绕视线方向旋转） ——

export function viewAxisOf(c) {
  // 视线轴：从选中对象指向摄像头（摄像头相对于选中对象的轴），白圈绕该轴旋转
  const v = [camera.position.x - c[0], camera.position.y - c[1], camera.position.z - c[2]];
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

export function screenAngleAt(clientX, clientY, centroid) {
  const s = projectToScreen(centroid[0], centroid[1], centroid[2]);
  const rect = renderer.domElement.getBoundingClientRect();
  // 统一到画布本地坐标（projectToScreen 返回相对 rect 的坐标，client 是页面坐标）
  return Math.atan2(clientY - rect.top - s.y, clientX - rect.left - s.x);
}

// 绕世界轴 axis（单位向量）旋转 angle（弧度），复合到 startRot（度）。
// 使用四元数增量累积，避免欧拉 gimbal lock 导致 Y=90° 附近值跳变。
// rot 轨道为 extrinsic XYZ（先绕 X、再绕 Y、再绕 Z，等价 THREE.Euler 'ZYX'）。
// 提取欧拉后选与 startRot 数值连续的等价表示：越过 ±90° 时其它分量不再翻转 ±180。
export function applyWorldRotation(startRot, axis, angle) {
  const qBase = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(startRot[0] * DEG2RAD, startRot[1] * DEG2RAD, startRot[2] * DEG2RAD, 'ZYX'));
  const qDelta = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(axis[0], axis[1], axis[2]), angle);
  const qNew = qDelta.multiply(qBase); // 世界轴旋转在左侧乘
  const eNew = new THREE.Euler().setFromQuaternion(qNew, 'ZYX');
  return eulerNearPrevDeg([eNew.x * RAD2DEG, eNew.y * RAD2DEG, eNew.z * RAD2DEG], startRot);
}

// 自转欧拉角（度）→ THREE.Quaternion（space: 'world' | 'local'）。
export function spinQuaternion(deg, space) {
  const M = spinMatrix(deg, space);
  const m4 = new THREE.Matrix4().set(
    M.m[0][0], M.m[0][1], M.m[0][2], 0,
    M.m[1][0], M.m[1][1], M.m[1][2], 0,
    M.m[2][0], M.m[2][1], M.m[2][2], 0,
    0, 0, 0, 1,
  );
  return new THREE.Quaternion().setFromRotationMatrix(m4);
}

export function enterViewRotate(clientX, clientY) {
  // 摄像机：白环绕「目标 → 摄像机」视线方向公转（与普通对象一致）
  const cam = selectedCameraForRotate();
  if (cam && state.tool === 'rotate') {
    pushUndo();
    const pose = cameraPoseAt(cam.id, state.time);
    if (!pose) return;
    const c = pose.target;
    const T = Math.round(state.time);
    const startRot = rotVectorAt('c:' + cam.id, T);
    const rotSpace = cam.rotSpace === 'world' ? 'world' : 'local';
    // 拖动期间冻结朝向与环半径（与轴环拖拽一致）
    const startQ = camOrientationQuaternion(cam.id, state.time) || new THREE.Quaternion();
    const startDist = Math.hypot(pose.pos[0] - c[0], pose.pos[1] - c[1], pose.pos[2] - c[2]);
    modal = { type: 'camera-view-rotate', camId: cam.id, centroid: c, view: true, lookAxis: viewAxisOf(c), startRot, rotSpace, startQ, startDist, angle: 0, lastAngle: screenAngleAt(clientX, clientY, c) };
    controls.enabled = false;
    return;
  }
  const fx = getFunction(state.selectedFunction);
  if (fx) {
    pushUndo();
    const c = state.rotMode === 'orbit'
      ? orbitCenterAt('f:' + fx.id, state.time)
      : fxCurrentPos(fx.id, Math.round(state.time));
    const T = Math.round(state.time);
    const startRot = fxRotationValueAt(fx.id, T);
    const startSpin = spinVectorAt('f:' + fx.id, T);
    const spinSpace = state.rotMode === 'spin' ? (fx.spinSpace === 'local' ? 'local' : 'world') : 'world';
    const rotSpace = state.rotMode === 'orbit' ? (fx.rotSpace === 'local' ? 'local' : 'world') : 'world';
    modal = { type: 'fx-view-rotate', fxId: fx.id, centroid: c, view: true, lookAxis: viewAxisOf(c), startRot, startSpin, rotMode: state.rotMode, spinSpace, rotSpace, angle: 0, lastAngle: screenAngleAt(clientX, clientY, c) };
    controls.enabled = false;
    return;
  }
  const gname = beginSelectionTransform(() => enterViewRotate(clientX, clientY));
  if (gname === undefined) return;
  const selParticles = state.particles.filter(p => state.selected.has(p.id));
  const c = gname
    ? (state.rotMode === 'orbit' ? orbitCenterAt('g:' + gname, state.time) : groupCurrentCentroid(gname, 'pos'))
    : (state.rotMode === 'orbit' && selParticles.length === 1 ? orbitCenterAt(selParticles[0].id, state.time) : selectionCentroid());
  const origins = snapshotSelection(p => currentVisual(p).pos.slice());
  if (gname) {
    const T = Math.round(state.time);
    const startRot = groupRotationValueAt(gname, T);
    const startSpin = spinVectorAt('g:' + gname, T);
    const spinSpace = state.rotMode === 'spin' ? ((state.groupSpinSpace && state.groupSpinSpace[gname] === 'world') ? 'world' : 'local') : 'world';
    const rotSpace = state.rotMode === 'orbit' ? ((state.groupRotSpace && state.groupRotSpace[gname] === 'world') ? 'world' : 'local') : 'world';
    modal = { type: 'group-view-rotate', gname, centroid: c, view: true, lookAxis: viewAxisOf(c), startRot, startSpin, rotMode: state.rotMode, spinSpace, rotSpace, origins, angle: 0, lastAngle: screenAngleAt(clientX, clientY, c) };
  } else {
    const startRots = new Map();
    for (const id of selectedMemberIds()) startRots.set(id, rotVectorAt(id, Math.round(state.time)));
    modal = { type: 'view-rotate', origins, centroid: c, view: true, lookAxis: viewAxisOf(c), startRots, rotMode: state.rotMode, angle: 0, lastAngle: screenAngleAt(clientX, clientY, c) };
  }
  controls.enabled = false;
}

export function updateViewRotate(clientX, clientY) {
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
  const prop = (m.rotMode === 'spin' && m.type !== 'view-rotate') ? 'spin' : 'rot';
  if (m.type === 'camera-view-rotate') {
    const t = state.captureKeyframes ? Math.round(state.time) : 0;
    let newRot;
    if (m.rotSpace === 'local') {
      // 拖动期间轴冻结：视线轴变换用按下瞬间的朝向（m.startQ）
      const q = m.startQ || camOrientationQuaternion(m.camId, state.time) || new THREE.Quaternion();
      const localAxis = new THREE.Vector3(a[0], a[1], a[2]).applyQuaternion(q.clone().conjugate());
      newRot = applyLocalOrbitRotationVec(m.startRot, [localAxis.x, localAxis.y, localAxis.z], angle);
    } else {
      newRot = applyWorldRotation(m.startRot, a, angle);
    }
    ['x', 'y', 'z'].forEach((comp, i) => setComponentKeyframe('c:' + m.camId, 'rot', comp, t, newRot[i], 'set'));
    rebuildPoints();
    refreshTimelineTree();
    return;
  }
  if (m.type === 'fx-view-rotate') {
    const base = prop === 'spin' ? m.startSpin : m.startRot;
    const t = state.captureKeyframes ? Math.round(state.time) : 0;
    if (prop === 'spin' && m.spinSpace === 'local') {
      const q = spinQuaternion(base, 'local');
      const localAxis = new THREE.Vector3(a[0], a[1], a[2]).applyQuaternion(q.clone().conjugate());
      setFunctionTrackValue(m.fxId, 'spin', 'set', t, applyLocalSpinRotationVec(base, [localAxis.x, localAxis.y, localAxis.z], angle));
    } else if (prop === 'rot' && m.rotSpace === 'local') {
      const spinBase = m.startSpin;
      const q = spinQuaternion(spinBase, m.spinSpace || 'local');
      const localAxis = new THREE.Vector3(a[0], a[1], a[2]).applyQuaternion(q.clone().conjugate());
      setFunctionTrackValue(m.fxId, 'rot', 'set', t, applyLocalOrbitRotationVec(base, [localAxis.x, localAxis.y, localAxis.z], angle));
    } else {
      setFunctionTrackValue(m.fxId, prop, 'set', t, applyWorldRotation(base, a, angle));
    }
    return;
  }
  if (m.type === 'group-view-rotate') {
    const base = prop === 'spin' ? m.startSpin : m.startRot;
    if (prop === 'spin' && m.spinSpace === 'local') {
      const q = spinQuaternion(base, 'local');
      const localAxis = new THREE.Vector3(a[0], a[1], a[2]).applyQuaternion(q.clone().conjugate());
      setGroupTrackValue(m.gname, 'spin', 'set', Math.round(state.time), applyLocalSpinRotationVec(base, [localAxis.x, localAxis.y, localAxis.z], angle));
    } else if (prop === 'rot' && m.rotSpace === 'local') {
      const spinBase = m.startSpin;
      const q = spinQuaternion(spinBase, m.spinSpace || 'local');
      const localAxis = new THREE.Vector3(a[0], a[1], a[2]).applyQuaternion(q.clone().conjugate());
      setGroupTrackValue(m.gname, 'rot', 'set', Math.round(state.time), applyLocalOrbitRotationVec(base, [localAxis.x, localAxis.y, localAxis.z], angle));
    } else {
      setGroupTrackValue(m.gname, prop, 'set', Math.round(state.time), applyWorldRotation(base, a, angle));
    }
    return;
  }
  // 普通粒子：写各自的公转轨道（绕各自 center、绕视线轴旋转）。
  const t = state.captureKeyframes ? Math.round(state.time) : 0;
  for (const [id, startRot] of m.startRots) {
    const newRot = applyWorldRotation(startRot, a, angle);
    ['x', 'y', 'z'].forEach((comp, i) => setComponentKeyframe(id, 'rot', comp, t, newRot[i], 'set'));
  }
  rebuildPoints();
}

export function cancelModal() {
  if (!modal) return;
  modal = null;
  controls.enabled = true;
  resetWorldAxisState();
  if (undoStack.length > 0) restore(undoStack.pop());
  updateGizmoFrame(); // 恢复圆环/视图环显示
  setGizmoHover(null, null, null, false); // 恢复拖拽高亮为基色
}

export function confirmModal() {
  modal = null;
  controls.enabled = true;
  resetWorldAxisState();
  updateGizmoFrame();
  setGizmoHover(null, null, null, false); // 恢复拖拽高亮为基色
}

// 面移动器：面法线方向 + 面内两轴
export const FACE_PLANES = {
  XY: { dir: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  XZ: { dir: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  YZ: { dir: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
};

// 按 modal 计算世界位移 delta（x/y/z），面移动器 / XZ 轴 / Y 轴 共用
export function grabDelta(clientX, clientY, m) {
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

export function updateGrab(clientX, clientY) {
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

export function updateScale(clientX) {
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
    const base = m.startScale || [1, 1, 1];
    const ns = base.map(v => Math.max(0.02, v * factor));
    setGroupTrackValue(m.groupName, 'scl', 'set', Math.round(state.time), ns);
    return;
  }
  editParticles([...m.origins].map(([id, orig]) => [id, [orig[0] * factor, orig[1] * factor, orig[2] * factor]]), 'scl');
}

export function updateRotate(clientX, clientY) {
  const m = modal;
  if (!m || (m.type !== 'rotate' && m.type !== 'group-rotate' && m.type !== 'fx-rotate' && m.type !== 'camera-rotate')) return;
  const p1 = rayOnAxisPlane(clientX, clientY, m.axis, m.centroid);
  if (!p1) return;
  let angle = angleInBasis(p1, m.centroid, m.u, m.v) - m.startAngle;
  if (shiftHeld) angle = Math.round(angle * RAD2DEG / ROT_SNAP) * ROT_SNAP * DEG2RAD;
  const prop = (m.rotMode === 'spin' && m.type !== 'rotate') ? 'spin' : 'rot'; // 普通粒子只有公转
  if (m.type === 'camera-rotate') {
    // 摄像机公转：写 rot 轨道（局部=绕自身朝向轴合成；世界=对应分量累加）
    const t = state.captureKeyframes ? Math.round(state.time) : 0;
    const newRot = m.rotSpace === 'local'
      ? applyLocalOrbitRotation(m.startRot, m.axisKey, angle)
      : (() => { const r = m.startRot.slice(); r[m.axisIndex] += angle * RAD2DEG; return r; })();
    ['x', 'y', 'z'].forEach((comp, i) => setComponentKeyframe('c:' + m.camId, 'rot', comp, t, newRot[i], 'set'));
    rebuildPoints();
    refreshTimelineTree();
    return;
  }
  if (m.type === 'fx-rotate') {
    const base = prop === 'spin' ? m.startSpin : m.startRot;
    const t = state.captureKeyframes ? Math.round(state.time) : 0;
    if (prop === 'spin' && m.spinSpace === 'local') {
      setFunctionTrackValue(m.fxId, 'spin', 'set', t, applyLocalSpinRotation(base, m.axisKey, angle));
    } else if (prop === 'rot' && m.rotSpace === 'local') {
      setFunctionTrackValue(m.fxId, 'rot', 'set', t, applyLocalOrbitRotation(base, m.axisKey, angle));
    } else {
      const newRot = base.slice();
      newRot[m.axisIndex] += angle * RAD2DEG;
      setFunctionTrackValue(m.fxId, prop, 'set', t, newRot);
    }
    return;
  }
  if (m.type === 'group-rotate') {
    const base = prop === 'spin' ? m.startSpin : m.startRot;
    if (prop === 'spin' && m.spinSpace === 'local') {
      setGroupTrackValue(m.gname, 'spin', 'set', Math.round(state.time), applyLocalSpinRotation(base, m.axisKey, angle));
    } else if (prop === 'rot' && m.rotSpace === 'local') {
      setGroupTrackValue(m.gname, 'rot', 'set', Math.round(state.time), applyLocalOrbitRotation(base, m.axisKey, angle));
    } else {
      const newRot = base.slice();
      newRot[m.axisIndex] += angle * RAD2DEG;
      setGroupTrackValue(m.gname, prop, 'set', Math.round(state.time), newRot);
    }
    return;
  }
  // 普通粒子：写各自的公转轨道（绕各自 center 旋转），不再直接改位置。
  const t = state.captureKeyframes ? Math.round(state.time) : 0;
  for (const [id, startRot] of m.startRots) {
    const newRot = startRot.slice();
    newRot[m.axisIndex] += angle * RAD2DEG;
    ['x', 'y', 'z'].forEach((comp, i) => setComponentKeyframe(id, 'rot', comp, t, newRot[i], 'set'));
  }
  rebuildPoints();
}

export function deleteSelected() {
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
}

export function selectAll() {
  if (state.selected.size === state.particles.length && state.particles.length > 0) state.selected.clear();
  else state.selected = new Set(state.particles.map(p => p.id));
  state.selectedGroup = null;
  state.selectedFunction = null;
  state.selectedCamera = null; // 选中其他对象即取消摄像机选中
  rebuildPoints();
  syncSelectionClasses();
}

export let clipboard = null;
export function copySelected() {
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
export function pasteClipboard() {
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
    state.selectedCamera = null; // 粘贴后选中新对象，取消摄像机选中
  } else {
    state.selectedGroup = null;
    state.selectedFunction = null;
    state.selectedCamera = null;
  }
  state.selected = new Set(newIds);
  rebuildPoints();
  syncSelectionClasses();
}

export function raycastGizmoMeshes(clientX, clientY, meshes) {
  if (!meshes || meshes.length === 0) return [];
  screenToNdc(clientX, clientY);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects(meshes, false);
}

export function hitGizmoAxis(clientX, clientY) {
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

// 鼠标到轴环的最小距离 + 命中的轴（null 表示未命中）。
// 解析法：把鼠标射线与「过中心、法线为轴」的平面求交，取交点到中心距离与环半径的差，
// 换算成屏幕像素；命中须落在当前可见的环段上。比「逐段取中点」更精确，
// 摄像机公转的大半径环（段中点屏幕间距远大于命中阈值）也能稳定命中。
export function ringHitInfo(clientX, clientY) {
  if (!gizmoGroup.visible) return null;
  screenToNdc(clientX, clientY);
  raycaster.setFromCamera(pointer, camera);
  const c = gizmoGroup.position;
  const scale = gizmoGroup.scale.x || 1;
  const radius = 0.5 * scale;
  const rotQ = gizmoRotateGroup.quaternion;
  const invQ = new THREE.Quaternion().copy(rotQ).invert();
  const viewDir = camera.getWorldDirection(new THREE.Vector3());
  let bestAxis = null, bestDist = Infinity;
  for (const ax of ['X', 'Y', 'Z']) {
    const n = new THREE.Vector3(...RING_NORMALS[ax]).applyQuaternion(rotQ);
    const plane = new THREE.Plane(n, -n.dot(c));
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, hit)) continue;
    const d = hit.sub(c);
    const worldDist = Math.abs(d.length() - radius);
    const hitDepth = Math.max(0.5, hit.clone().sub(camera.position).dot(viewDir));
    const screenDist = worldDist * focalLengthPx() / hitDepth;
    if (screenDist >= bestDist) continue;
    // 最近环段方向（环局部坐标）：用段 0 中点方向 + 轴法线构造平面内正交基
    const dLocal = d.clone().applyQuaternion(invQ).normalize();
    const nLocal = new THREE.Vector3(...RING_NORMALS[ax]);
    const e1 = gizmoRingSegDirs[ax][0];
    const e2 = new THREE.Vector3().crossVectors(nLocal, e1);
    let ang = Math.atan2(dLocal.dot(e2), dLocal.dot(e1));
    if (ang < 0) ang += Math.PI * 2;
    const idx = Math.floor(ang / RING_SEG_ARC) % RING_SEGMENTS;
    const seg = gizmoRingSegs[ax][idx];
    if (!seg || !seg.visible) continue;
    bestDist = screenDist;
    bestAxis = ax;
  }
  return bestAxis ? { axis: bestAxis, dist: bestDist } : null;
}

// 命中面移动器（三轴之间的矩形）
export function hitGizmoFace(clientX, clientY) {
  if (!gizmoGroup.visible) return null;
  const targets = Object.values(gizmoFaces).filter(f => f.visible);
  if (targets.length === 0) return null;
  const hits = raycastGizmoMeshes(clientX, clientY, targets);
  return hits.length ? hits[0].object.userData.face : null;
}

// 鼠标到白圈投影圆的距离（Infinity 表示未命中）
export function viewRingDistance(clientX, clientY) {
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

export const AXIS_COLORS = { X: 0xff5555, Y: 0x55ff55, Z: 0x5588ff };
// 悬停时变亮，使用白色 30% 混合
export function hoverColor(c) { return new THREE.Color(c).lerp(new THREE.Color(1, 1, 1), 0.3); }
export function setGizmoHover(arrowAxis, ringAxis, faceKey, viewRingHover) {
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
export function setDragAxisHighlight(m) {
  // 操作轴提示线由 updateGizmoFrame 在中心显示
  resetWorldAxisState();
}

// 捕获阶段预判触屏手势：先于 OrbitControls 的 bubble 监听执行。
window.addEventListener('pointerdown', (ev) => {
  if (ev.pointerType !== 'touch' || ev.target !== renderer.domElement) return;
  const multiTouch = activeTouchIds.size > 0;
  const lockedCamera = !!state.activeCamera && state.activeCamera !== DEFAULT_CAMERA_ID;
  activeTouchIds.add(ev.pointerId);
  // 锁定摄像机时视角由关键帧驱动，禁用触屏 OrbitControls；编辑器手势同样不处理。
  const gate = lockedCamera || (!multiTouch && shouldHandleTouch(ev));
  if (gate) {
    gatedTouchIds.add(ev.pointerId);
    controls.enabled = false;
  }
}, true);
window.addEventListener('pointerup', releaseTouch, true);
window.addEventListener('pointercancel', releaseTouch, true);

renderer.domElement.addEventListener('pointerdown', (ev) => {
  lastMouse.x = ev.clientX; lastMouse.y = ev.clientY;
  const touch = ev.pointerType === 'touch';
  if (touch) {
    // 未标记的触控交给 OrbitControls（旋转/双指平移缩放），本模块不参与。
    if (!gatedTouchIds.has(ev.pointerId)) return;
    ev.preventDefault();
  }
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
          state.selectedCamera = null; // 视口选中粒子即取消摄像机选中
          promoteGroupSelection();
          rebuildPoints();
          syncSelectionClasses();
          // 选择工具：鼠标点选后立即进入拖动；触屏先待命，拖动超过阈值再进入移动。
          if (state.tool === 'select') {
            if (touch) touchPending = { x0: ev.clientX, y0: ev.clientY };
            else enterGrab(ev.clientX, ev.clientY);
          }
          handled = true;
        }
      }
    }
    // 空白：框选（三种变换工具共用）
    if (!handled) {
      boxSel = { x0: ev.clientX, y0: ev.clientY, x1: ev.clientX, y1: ev.clientY, shift: ev.shiftKey };
      renderer.domElement.setPointerCapture(ev.pointerId); // 左键在画布外松开也要能结束框选
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
      rebuildPoints();
    }
    return;
  }
  if (state.tool === 'camera') {
    const pt = planePointAt(ev.clientX, ev.clientY);
    if (pt) {
      pushUndo();
      const cam = createCameraAt(pt, nextCameraId(), nextCameraName());
      state.cameras.push(cam);
      lockCamera(cam.id);
      refreshCameraTabs();
      refreshTimelineTree();
      state.tool = 'select';
      document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === 'select'));
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
      rebuildPoints();
    }
  }
});

renderer.domElement.addEventListener('pointermove', (ev) => {
  lastMouse.x = ev.clientX; lastMouse.y = ev.clientY;

  if (ev.pointerType === 'touch') {
    // 触屏选择工具：点中粒子后先待命，超过阈值才进入移动（避免点选误拖）。
    if (touchPending) {
      if (Math.hypot(ev.clientX - touchPending.x0, ev.clientY - touchPending.y0) > 8) {
        touchPending = null;
        enterGrab(ev.clientX, ev.clientY);
      }
      return;
    }
    // OrbitControls 正在旋转/缩放的触控不参与编辑器悬停/预览逻辑。
    if (!gatedTouchIds.has(ev.pointerId)) return;
  }

  if (modal) {
    if (modal.type === 'grab' || modal.type === 'fx-grab') updateGrab(ev.clientX, ev.clientY);
    else if (modal.type === 'scale' || modal.type === 'fx-scale') updateScale(ev.clientX);
    else if (modal.type === 'rotate' || modal.type === 'group-rotate' || modal.type === 'fx-rotate' || modal.type === 'camera-rotate') updateRotate(ev.clientX, ev.clientY);
    else if (modal.type === 'view-rotate' || modal.type === 'group-view-rotate' || modal.type === 'fx-view-rotate' || modal.type === 'camera-view-rotate') updateViewRotate(ev.clientX, ev.clientY);
    return;
  }
  if (boxSel) { boxSel.x1 = ev.clientX; boxSel.y1 = ev.clientY; updateBoxOverlay(); return; }
  if (!drag) {
    // 悬停高亮：移动控制器（轴/面）与旋转控制器（环/视图环）；仅选中摄像机也算有目标
    if ((state.tool === 'move' || state.tool === 'rotate') && (hasSelection() || !!getCamera(state.selectedCamera))) {
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
      rebuildPoints();
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
  if (ev.pointerType === 'touch') touchPending = null;
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
});

renderer.domElement.addEventListener('contextmenu', (ev) => { ev.preventDefault(); if (modal) cancelModal(); });
renderer.domElement.addEventListener('pointercancel', () => {
  if (boxSel) {
    boxSel = null;
    document.getElementById('box-overlay').style.display = 'none';
  }
});
window.addEventListener('pointerup', () => { renderer.domElement.style.cursor = ''; });

window.addEventListener('keydown', (ev) => {
  const k = ev.key.toLowerCase();
  const el = ev.target;
  const isTextInput = el instanceof Element && (
    el.matches('input, textarea, select') ||
    !!el.closest('.cm-content, [contenteditable="true"]')
  );
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
  if (ev.ctrlKey && k === 'd') { ev.preventDefault(); state.selected.clear(); state.selectedGroup = null; state.selectedFunction = null; state.selectedCamera = null; rebuildPoints(); syncSelectionClasses(); return; }
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
  if (k === 'r' && state.tool === 'rotate') {
    state.rotMode = 'orbit'; // 按住 R 期间为公转
    updateGizmo();
    return;
  }
  if (k === 's') enterScale(lastMouse.x);
  else if (k === 'delete') deleteSelected();
  else if (k === 'escape') { state.selected.clear(); state.selectedGroup = null; state.selectedFunction = null; state.selectedCamera = null; rebuildPoints(); syncSelectionClasses(); }
});

window.addEventListener('keyup', (ev) => {
  if (ev.key.toLowerCase() === 'r') {
    state.rotMode = 'spin'; // 松开 R 恢复自转
    if (state.tool === 'rotate') updateGizmo();
  }
});

export function updateBoxOverlay() {
  const ov = document.getElementById('box-overlay');
  const rect = renderer.domElement.getBoundingClientRect();
  const x = Math.min(boxSel.x0, boxSel.x1) - rect.left;
  const y = Math.min(boxSel.y0, boxSel.y1) - rect.top;
  ov.style.left = x + 'px'; ov.style.top = y + 'px';
  ov.style.width = Math.abs(boxSel.x1 - boxSel.x0) + 'px';
  ov.style.height = Math.abs(boxSel.y1 - boxSel.y0) + 'px';
}

// 选中集合恰好等于某组全部成员时，自动提升为选中该组
export function promoteGroupSelection() {
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
export function resolveSelectionPriority() {
  state.selectedFunction = null;
  state.selectedGroup = null;
  // 先看函数对象：选中集合覆盖某函数对象的全部派生粒子 → 选中该函数对象
  for (const fx of state.functions) {
    const ids = state.particles.filter(p => p.fx === fx.id).map(p => p.id);
    if (ids.length > 0 && ids.every(id => state.selected.has(id))) {
      state.selectedFunction = fx.id;
      return;
    }
  }
  // 再看组：选中集合恰好等于某组全部成员 → 提升为选中该组
  promoteGroupSelection();
}

export function applyBoxSelection() {
  const rect = renderer.domElement.getBoundingClientRect();
  const x0 = Math.min(boxSel.x0, boxSel.x1) - rect.left, y0 = Math.min(boxSel.y0, boxSel.y1) - rect.top;
  const x1 = Math.max(boxSel.x0, boxSel.x1) - rect.left, y1 = Math.max(boxSel.y0, boxSel.y1) - rect.top;
  const sel = new Set();
  const derivedFx = new Set();
  for (const p of state.particles) {
    const v = currentVisual(p).pos;
    const s = projectToScreen(v[0], v[1], v[2]);
    if (s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1) {
      sel.add(p.id);
      if (p.fx) derivedFx.add(p.fx);
    }
  }
  if (derivedFx.size > 0) {
    // 框选命中派生粒子时，直接选中其函数对象（整组派生粒子），不再单独选中部分派生粒子
    const ids = new Set(state.particles.filter(p => derivedFx.has(p.fx)).map(p => p.id));
    if (boxSel.shift) for (const id of ids) state.selected.add(id);
    else state.selected = ids;
    state.selectedFunction = derivedFx.values().next().value;
    state.selectedGroup = null;
  } else {
    if (boxSel.shift) for (const id of sel) state.selected.add(id);
    else state.selected = sel;
    resolveSelectionPriority();
  }
  state.selectedCamera = null; // 框选其他对象即取消摄像机选中
  syncSelectionClasses();
  if (state.selectedFunction) refreshFunctionPanel(); // 选中函数对象时刷新其属性面板
}

// —— 绘制粒子数量交互：右键短按弹编辑框 + range，拖动时滚轮增减数量 ——

export const DRAW_TOOLS = ['pencil', 'line', 'circle', 'rect', 'freehand'];
export const DRAW_COUNT_MAX = 1000;

export function isDrawTool() { return DRAW_TOOLS.includes(state.tool); }

export let rightDownPos = null;
export let drawCountEditor = null;
export let drawCountDismiss = null; // document pointerdown 关闭监听器

export function closeDrawCountEditor() {
  if (drawCountDismiss) { document.removeEventListener('pointerdown', drawCountDismiss); drawCountDismiss = null; }
  if (drawCountEditor) { drawCountEditor.remove(); drawCountEditor = null; }
}

// 右键短按：悬浮粒子数量编辑框 + range 编辑条
export function showDrawCountEditor(cx, cy) {
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
  // 延迟注册，免得这次右键的 pointerup 立刻触发关闭
  setTimeout(() => document.addEventListener('pointerdown', drawCountDismiss), 0);
}
export function clampCount(v) { return Math.max(2, Math.min(DRAW_COUNT_MAX, Math.round(parseInt(v) || 30))); }

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

// 触屏替代右键：绘制工具下长按视口空白处弹出粒子数量编辑框。
if (hasTouch()) {
  addLongPress(renderer.domElement, (ev) => {
    if (!modal && !drag && !boxSel && isDrawTool()) showDrawCountEditor(ev.clientX, ev.clientY);
  }, { delay: 550, tolerance: 12 });
}

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

export function syncDrawCountEditorValues() {
  if (!drawCountEditor) return;
  const inputs = drawCountEditor.querySelectorAll('input');
  if (inputs.length === 2) { inputs[0].value = state.drawCount; inputs[1].value = state.drawCount; }
}
