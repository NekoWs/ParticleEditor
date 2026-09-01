/* =========================================================================
 * 摄像机对象运行时
 * 职责：
 *   1) 摄像机对象（位置/看向目标/翻滚角/FOV）与应用/读回换算
 *   2) 摄像机属性关键帧求值（pos/target/fov 走轨道，id 前缀 c:camId）
 *   3) 切换摄像机：把某时刻的摄像机姿态应用到视口相机
 *
 * 朝向模型（v9 起）：摄像机不再直接存欧拉角 rot，而是存「看向目标点」 target。
 *   pitch/yaw 由 lookAt(pos, target) 自动计算，roll 单独存（绕视线方向的翻滚角）。
 * ======================================================================= */


import * as THREE from 'three';
import { state, DEFAULT_CAMERA_ID, getCamera } from './constants.js';
import { camera } from '../scene/scene.js';
import { findTrackByPr, trackValueAt } from './animation-eval.js';

// 弧度 -> 度
const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

// 摄像机对象默认 FOV
export const DEFAULT_FOV = 50;

// 从自由视角切到摄像机前的自由视角快照（切回默认时恢复）。
// 仅当当前不在摄像机锁定态（activeCamera 为 null）时在 lockCamera 内保存。
let savedFreePose = null;

// 摄像机 id 前缀（轨道 ids 用 'c:cam1'）
export function camTrackId(id) { return 'c:' + id; }

// 合成「看向目标点」：沿视线方向取前方 1 单位点（自由视角无明确 target，用于快照）。
function synthTarget(pos, dir) {
  return [pos[0] + dir.x, pos[1] + dir.y, pos[2] + dir.z];
}

// 从 THREE 相机读回姿态快照 { pos:[x,y,z], target:[x,y,z], roll:度, fov:度 }
// 自由视角无明确 target，按视线方向合成（前方 1 单位）；roll 从欧拉角 Z 读回。
export function snapshotCamera() {
  const dir = camera.getWorldDirection(new THREE.Vector3());
  const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'XYZ');
  return {
    pos: [camera.position.x, camera.position.y, camera.position.z],
    target: synthTarget([camera.position.x, camera.position.y, camera.position.z], dir),
    roll: e.z * RAD2DEG,
    fov: camera.fov,
  };
}

// 将摄像机姿态对象应用到相机（不改变 controls.target）
// pose: { pos:[x,y,z], target:[x,y,z], roll:度, fov:度 }
export function applyPose(pose) {
  camera.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
  camera.up.set(0, 1, 0);
  if (pose.target) {
    camera.lookAt(pose.target[0], pose.target[1], pose.target[2]);
  }
  // 绕视线方向（局部 Z）翻滚 roll；lookAt 只决定 pitch/yaw
  if (pose.roll) camera.rotateZ(pose.roll * DEG2RAD);
  camera.fov = pose.fov;
  camera.updateProjectionMatrix();
}

// 将摄像机对象（cam）应用到相机
export function applyCamera(cam) {
  applyPose({ pos: cam.pos, target: cam.target, roll: cam.roll, fov: cam.fov });
}

// 在世界某点新建摄像机：位置 = point，朝向看向世界原点，FOV = 默认
export function createCameraAt(point, id, name) {
  return {
    id: id,
    name: name,
    pos: [point.x, point.y, point.z],
    target: [0, 0, 0],
    roll: 0,
    fov: DEFAULT_FOV,
  };
}

// 摄像机某属性基础值（无关键帧时）
// prop: 'pos' → [x,y,z]；'target' → [x,y,z]；'fov' → 标量
export function cameraBaseValue(cam, prop) {
  if (prop === 'pos') return cam.pos.slice(0, 3);
  if (prop === 'target') return cam.target.slice(0, 3);
  if (prop === 'fov') return cam.fov;
  return 0;
}

// 摄像机某分量在 T 时刻的值（pos/target 分量级，fov 标量）
export function cameraValueAt(camId, prop, comp, T) {
  const cam = getCamera(camId);
  if (!cam) return 0;
  const pr = comp ? prop + '.' + comp : prop;
  const tr = findTrackByPr(pr, camTrackId(camId));
  if (prop === 'fov') {
    if (!tr || tr.kf.length === 0) return cam.fov;
    return trackValueAt(tr, T, cam.fov);
  }
  const base = cameraBaseValue(cam, prop);
  const idx = { x: 0, y: 1, z: 2 }[comp];
  if (!tr || tr.kf.length === 0) return base[idx];
  return tr.m === 'op' ? base[idx] + trackValueAt(tr, T, 0) : trackValueAt(tr, T, base[idx]);
}

// 摄像机在 T 时刻的完整姿态 { pos:[x,y,z], target:[x,y,z], roll:度, fov:度 }
export function cameraPoseAt(camId, T) {
  const cam = getCamera(camId);
  if (!cam) return null;
  const pose = {
    pos: [0, 0, 0],
    target: [0, 0, 0],
    roll: cam.roll != null ? cam.roll : 0,
    fov: cam.fov,
  };
  const comps = ['x', 'y', 'z'];
  for (let i = 0; i < 3; i++) {
    pose.pos[i] = cameraValueAt(camId, 'pos', comps[i], T);
    pose.target[i] = cameraValueAt(camId, 'target', comps[i], T);
  }
  pose.fov = cameraValueAt(camId, 'fov', null, T);
  return pose;
}

// 把某摄像机在 T 时刻的姿态应用到视口相机
export function applyCameraPose(camId, T) {
  const pose = cameraPoseAt(camId, T);
  if (pose) applyPose(pose);
}

// 锁定某摄像机（切换视角到该摄像机当前时刻姿态）；id = DEFAULT_CAMERA_ID 表示解锁回默认
export function lockCamera(id) {
  if (id == null || id === DEFAULT_CAMERA_ID) {
    unlockCamera();
    return;
  }
  const cam = getCamera(id);
  if (!cam) return;
  // 从自由视角切入时保存自由视角，切回默认（unlockCamera）时恢复
  if (!state.activeCamera) savedFreePose = snapshotCamera();
  state.activeCamera = id;
  applyCameraPose(id, state.time);
}

export function unlockCamera() {
  state.activeCamera = null;
  // 恢复切走前的自由视角（若曾从自由视角切入摄像机）
  if (savedFreePose) {
    applyPose(savedFreePose);
    savedFreePose = null;
  }
}

// 默认摄像机实时镜像：直接返回当前相机快照（无需存储）
export function defaultCameraSnapshot() {
  return snapshotCamera();
}

// 旧格式 rot→target 换算在 cam-math.js（纯数学模块，供 io.js 等无 DOM 环境引入）
export { rotToTarget } from './cam-math.js';