/* =========================================================================
 * 摄像机朝向纯数学（无 DOM/场景依赖，Node 测试环境可安全引入）
 * ======================================================================= */

import * as THREE from 'three';

const DEG2RAD = Math.PI / 180;

// 旧格式兼容：把欧拉角 rot:[pitch,yaw,roll](度,XYZ) 反推为 lookAt 的 target 点。
// 前向 = 相机 -Z 方向经 pitch/yaw 旋转（roll 绕视线不影响前向）；target = pos + forward。
export function rotToTarget(pos, rot) {
  const e = new THREE.Euler(rot[0] * DEG2RAD, rot[1] * DEG2RAD, 0, 'XYZ');
  const q = new THREE.Quaternion().setFromEuler(e);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  return [pos[0] + forward.x, pos[1] + forward.y, pos[2] + forward.z];
}