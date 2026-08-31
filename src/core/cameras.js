/* =========================================================================
 * 摄像机对象运行时
 * 职责：
 *   1) 摄像机对象（位置/旋转/欧拉角/FOV）与应用/读回换算
 *   2) 默认摄像机实时镜像当前视角
 *   3) 锁定状态 + 待确认（pending）编辑：旋转/平移/缩放产生差异并高亮，应用/取消提交
 * ======================================================================= */


import * as THREE from 'three';
import { state, DEFAULT_CAMERA_ID, getCamera } from './constants.js';
import { camera } from '../scene/scene.js';

// 弧度 -> 度
const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

// 摄像机对象默认 FOV
export const DEFAULT_FOV = 50;

// 当前锁定的摄像机 id（冗余镜像 state.activeCamera，避免频繁读 state）
// 待确认编辑：{ id, base:{pos,rot,fov}, cur:{pos,rot,fov} }
export const camEdit = {
  id: null,
  base: null,   // 摄像机原始值（应用/取消的基准）
  cur: null,    // 当前预览值（由相机实时读回）
};

// 从 THREE 相机读回位置 + 欧拉角（XYZ，度）+ FOV
export function snapshotCamera() {
  const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'XYZ');
  return {
    pos: [camera.position.x, camera.position.y, camera.position.z],
    rot: [e.x * RAD2DEG, e.y * RAD2DEG, e.z * RAD2DEG],
    fov: camera.fov,
  };
}

// 将摄像机对象应用到相机（不改变 controls.target）
export function applyCamera(cam) {
  camera.position.set(cam.pos[0], cam.pos[1], cam.pos[2]);
  camera.rotation.set(
    cam.rot[0] * DEG2RAD,
    cam.rot[1] * DEG2RAD,
    cam.rot[2] * DEG2RAD,
    'XYZ'
  );
  camera.fov = cam.fov;
  camera.updateProjectionMatrix();
}

// 计算「看向世界原点」的欧拉角（度，XYZ 顺序），位置给定
function lookAtOriginEuler(pos) {
  const target = new THREE.Vector3(0, 0, 0);
  const m = new THREE.Matrix4().lookAt(
    new THREE.Vector3(pos[0], pos[1], pos[2]),
    target,
    new THREE.Vector3(0, 1, 0)
  );
  const e = new THREE.Euler().setFromRotationMatrix(m, 'XYZ');
  return [e.x * RAD2DEG, e.y * RAD2DEG, e.z * RAD2DEG];
}

// 在世界某点新建摄像机：位置 = point，朝向看向世界原点，FOV = 默认
export function createCameraAt(point, id, name) {
  return {
    id: id,
    name: name,
    pos: [point.x, point.y, point.z],
    rot: lookAtOriginEuler([point.x, point.y, point.z]),
    fov: DEFAULT_FOV,
  };
}

// 锁定某摄像机（进入待确认预览）；id = DEFAULT_CAMERA_ID 表示解锁回默认
export function lockCamera(id) {
  if (id == null || id === DEFAULT_CAMERA_ID) {
    unlockCamera();
    return;
  }
  const cam = getCamera(id);
  if (!cam) return;
  state.activeCamera = id;
  camEdit.id = id;
  camEdit.base = { pos: cam.pos.slice(), rot: cam.rot.slice(), fov: cam.fov };
  camEdit.cur = { pos: cam.pos.slice(), rot: cam.rot.slice(), fov: cam.fov };
  applyCamera(cam);
}

export function unlockCamera() {
  state.activeCamera = null;
  camEdit.id = null;
  camEdit.base = null;
  camEdit.cur = null;
}

// 锁定状态下：相机被 OrbitControls 自由操作后，读回当前值作为待确认 cur
export function refreshPending() {
  if (camEdit.id == null) return;
  camEdit.cur = snapshotCamera();
}

// 判断 cur 相对 base 是否有差异
export function hasPendingChange() {
  if (camEdit.id == null || !camEdit.base || !camEdit.cur) return false;
  const b = camEdit.base, c = camEdit.cur;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(c.pos[i] - b.pos[i]) > 1e-6) return true;
    if (Math.abs(c.rot[i] - b.rot[i]) > 1e-6) return true;
  }
  return Math.abs(c.fov - b.fov) > 1e-6;
}

// 提交待确认值到摄像机对象；返回是否发生实际变化
export function commitPending() {
  if (camEdit.id == null) return false;
  const cam = getCamera(camEdit.id);
  if (!cam) return false;
  const c = camEdit.cur;
  cam.pos = c.pos.slice();
  cam.rot = c.rot.slice();
  cam.fov = c.fov;
  camEdit.base = { pos: c.pos.slice(), rot: c.rot.slice(), fov: c.fov };
  return true;
}

// 取消待确认：还原为摄像机原值，保持锁定
export function cancelPending() {
  if (camEdit.id == null) return;
  const cam = getCamera(camEdit.id);
  if (!cam) return;
  applyCamera(cam);
  camEdit.cur = { pos: cam.pos.slice(), rot: cam.rot.slice(), fov: cam.fov };
}

// 默认摄像机实时镜像：直接返回当前相机快照（无需存储）
export function defaultCameraSnapshot() {
  return snapshotCamera();
}