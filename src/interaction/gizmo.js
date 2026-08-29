/* =========================================================================
 * 变换控制器（gizmo）与坐标工具
 * 职责：吸附、选中质心、移动/旋转 gizmo 的显示与命中检测、屏幕/世界坐标换算、
 *       形状绘制（line/circle/rect）。
 * 说明：gizmo 网格几何体在 scene.js 构建；本文件负责其显示更新与交互判定。
 * ======================================================================= */


import * as THREE from 'three';
import { state, PLANES, SNAP_STEP, getFunction } from '../core/constants.js';
import { shiftHeld } from './input-state.js';
import { camera, renderer, raycaster, pointer, points, gizmoGroup, gizmoRotateGroup, gizmoRingSegs, gizmoRingSegDirs, gizmoViewRing, gizmoFaces, gizmoArrows, gizmoAxisHint, AXIS_RING_COLORS, RING_NORMALS, GIZMO_FACE_DEFS, setWorldAxisVisible, setWorldAxisGlow, resetWorldAxisState } from '../scene/scene.js';
import { AXIS_COLORS, AXIS_VECTORS, modal, setGizmoHover, selectedGroupName, selectionHasDerived, derivedFxIdFromSelection, fxCurrentPos, hoverColor } from './interaction.js';
import { currentVisual } from '../core/animation.js';
import { groupCurrentCentroid } from '../ui/tree.js';
export function snapValue(v) {
  return Math.round(v / SNAP_STEP) * SNAP_STEP;
}

export function snapGrid(v) {
  return shiftHeld ? snapValue(v) : v;
}

/* =========================================================================
 * 变换方向轴
 * ======================================================================= */

export function selectionCentroid() {
  const sel = state.particles.filter(p => state.selected.has(p.id));
  if (sel.length === 0) return null;
  const c = [0, 0, 0];
  for (const p of sel) { const v = currentVisual(p).pos; c[0] += v[0]; c[1] += v[1]; c[2] += v[2]; }
  return [c[0] / sel.length, c[1] / sel.length, c[2] / sel.length];
}

/* =========================================================================
 * 变换控制器（gizmo）：移动工具 = 三轴箭头 + 面移动器；旋转工具 = 三轴环 + 视图环
 * 使用世界坐标系（不随选中对象旋转）
 * ======================================================================= */
export const GIZMO_SCREEN_SCALE = 0.14; // 屏幕恒定大小系数：世界缩放 = 视线深度 × 系数
export const TRANSFORM_TOOLS = ['move', 'rotate']; // 仅移动/旋转工具显示 gizmo
export const _gizmoTmp = new THREE.Vector3();
// 拖拽中选中的控制器高亮：向白色混合 30%
export function gizmoHl(c) { return hoverColor(c); }


export function updateGizmo() {
  // 拼图模式 / 非移动、旋转工具：隐藏控制器
  if (document.body.classList.contains('puzzle-mode') || !TRANSFORM_TOOLS.includes(state.tool)) {
    gizmoGroup.visible = false;
    resetWorldAxisState();
    return;
  }
  let c = null;
  const fx = getFunction(state.selectedFunction);
  if (fx) {
    // 函数对象：gizmo 跟随整体位置（center + 当前 pos 增量），随拖动/时间轴移动
    c = fxCurrentPos(fx.id, state.time);
  } else {
    const gname = selectedGroupName();
    if (gname) c = groupCurrentCentroid(gname, 'pos');
    else if (selectionHasDerived()) {
      // 派生粒子选中：gizmo 显示在所属函数对象中心
      const fxId = derivedFxIdFromSelection();
      if (fxId) c = fxCurrentPos(fxId, state.time);
    } else c = selectionCentroid();
  }
  if (!c) { gizmoGroup.visible = false; return; }
  gizmoGroup.visible = true;
  gizmoGroup.position.set(c[0], c[1], c[2]);
  gizmoGroup.rotation.set(0, 0, 0); // 移动控制器：世界朝向
  gizmoRotateGroup.rotation.set(0, 0, 0); // 旋转控制器：世界坐标系（不随对象旋转）
  updateGizmoFrame();
  setGizmoHover(null, null, null, false);
}

// 每帧调用：恒定屏幕大小 + 白环正对相机 + 轴环半圆环可见性（alpha 渐变防突变）
// 拖拽某个环时：隐藏其他圆环与视图环，选中环整环显示
export function updateGizmoFrame() {
  if (!gizmoGroup.visible) return;
  const c = gizmoGroup.position;
  const showMove = state.tool === 'move';
  const showRotate = state.tool === 'rotate';
  // 恒定屏幕大小：用「沿视线方向的深度」补偿，抵消透视下 gizmo 偏离
  // 屏幕中心时的误差，使缩放/移动视角时 gizmo 屏幕尺寸真正不变。
  // toGizmo：相机 -> gizmo 中心；depth：gizmo 沿视线方向的深度（正数）
  const toGizmo = _gizmoTmp.set(c.x - camera.position.x, c.y - camera.position.y, c.z - camera.position.z);
  const viewDir = camera.getWorldDirection(new THREE.Vector3());
  const depth = Math.max(0.5, toGizmo.dot(viewDir));
  gizmoGroup.scale.setScalar(depth * GIZMO_SCREEN_SCALE);
  // 外部白色视图环：始终正对摄像头（环面垂直于视线）
  gizmoViewRing.lookAt(camera.position);
  // 面移动器：固定朝向该面（构建时已设定），不做 billboard

  const m = modal;
  const isGrab = m && (m.type === 'grab' || m.type === 'fx-grab');
  const rotDragging = m && (m.type === 'rotate' || m.type === 'group-rotate' || m.type === 'fx-rotate'
    || m.type === 'view-rotate' || m.type === 'group-view-rotate' || m.type === 'fx-view-rotate');
  const viewDragging = rotDragging && (m.type === 'view-rotate' || m.type === 'group-view-rotate' || m.type === 'fx-view-rotate');
  const camDir = toGizmo.clone().negate().normalize(); // gizmo -> 相机方向（环可见性判据）

  // 面移动器 / 箭头显隐（按工具）
  for (const f of Object.values(gizmoFaces)) f.visible = showMove;
  for (const ax of ['X', 'Y', 'Z']) gizmoArrows[ax].group.visible = showMove;

  if (rotDragging) {
    // 旋转拖拽：选中轴环整环显示并高亮；其他环与白环隐藏
    for (const ax of ['X', 'Y', 'Z']) {
      const active = showRotate && !viewDragging && m.axisKey === ax;
      for (const seg of gizmoRingSegs[ax]) {
        seg.visible = active;
        seg.material.opacity = 1;
        seg.material.color.set(active ? gizmoHl(AXIS_RING_COLORS[ax]) : AXIS_RING_COLORS[ax]);
      }
    }
    gizmoViewRing.visible = showRotate && viewDragging;
    gizmoViewRing.material.color.set(viewDragging ? 0xffffff : 0xe4e8f2);
  } else if (isGrab) {
    // 移动拖拽：选中箭头/面高亮；环与白环隐藏
    for (const ax of ['X', 'Y', 'Z']) for (const seg of gizmoRingSegs[ax]) seg.visible = false;
    gizmoViewRing.visible = false;
    for (const ax of ['X', 'Y', 'Z']) {
      const a = gizmoArrows[ax];
      const col = m.axis === ax ? gizmoHl(AXIS_COLORS[ax]) : AXIS_COLORS[ax];
      a.shaft.material.color.set(col);
      a.head.material.color.set(col);
    }
    for (const [name, f] of Object.entries(gizmoFaces)) {
      f.material.color.set(m.face === name ? gizmoHl(GIZMO_FACE_DEFS[name].color) : GIZMO_FACE_DEFS[name].color);
    }
  } else {
    // 非拖拽：只显示「从相机能看到」的半圆环（本地坐标轴，应用对象旋转）。
    // 仅当视角位于该坐标轴上（视线沿轴，|n·camDir| 接近 1）才整环显示；
    // 否则按角度隐藏位于「球体」后方的半边弧线（径向朝向相机一侧显示）。
    const rotQ = gizmoRotateGroup.quaternion;
    for (const ax of ['X', 'Y', 'Z']) {
      const n = new THREE.Vector3(...RING_NORMALS[ax]).applyQuaternion(rotQ);
      const align = Math.abs(n.dot(camDir));
      const faceOn = align > 0.999; // 只有几乎正对该轴（视线沿轴）才整环显示
      const segs = gizmoRingSegs[ax], dirs = gizmoRingSegDirs[ax];
      for (let i = 0; i < segs.length; i++) {
        const d = dirs[i].clone().applyQuaternion(rotQ).dot(camDir);
        const t = THREE.MathUtils.clamp(d / 0.03, 0, 1); // 更窄的过渡带，后半弧线严格隐藏
        const half = t * t * (3 - 2 * t); // 平滑半边
        const op = showRotate ? (faceOn ? 1 : half) : 0;
        segs[i].visible = op > 0.02;
        segs[i].material.opacity = op;
      }
    }
    gizmoViewRing.visible = showRotate;
  }

  // 操作轴提示线：拖拽移动/旋转的某个轴时，在 gizmo 中心画一条高亮轴线（与移动线同粗）
  const hintAxis = m && m.axisKey;
  if (hintAxis && (isGrab || rotDragging)) {
    gizmoAxisHint.visible = true;
    const baseDir = new THREE.Vector3(...AXIS_VECTORS[hintAxis]);
    // 旋转时提示线沿本地轴；移动时沿世界轴
    const dir = rotDragging ? baseDir.applyQuaternion(gizmoRotateGroup.quaternion) : baseDir;
    gizmoAxisHint.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    gizmoAxisHint.material.color.set(gizmoHl(AXIS_COLORS[hintAxis]));
  } else {
    gizmoAxisHint.visible = false;
  }
}

/* =========================================================================
 * 坐标工具
 * ======================================================================= */

export function screenToNdc(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
}

export function planeInfo() {
  const def = PLANES[state.drawPlane] || PLANES.XZ;
  return { def, plane: new THREE.Plane(def.normal, 0), off: 0 };
}

// 让指定轴发光（绘制平面脉冲用）：显示并变亮（透过网格线也能看到）
export function setAxisGlow(axes, glow) {
  for (const axis of axes) {
    setWorldAxisVisible(axis, true);
    setWorldAxisGlow(axis, glow);
  }
}

export function restoreAxisColors() { resetWorldAxisState(); }

export function planePointAt(clientX, clientY) {
  screenToNdc(clientX, clientY);
  raycaster.setFromCamera(pointer, camera);
  const hit = new THREE.Vector3();
  return raycaster.ray.intersectPlane(planeInfo().plane, hit) ? hit : null;
}

export function pickParticleAt(clientX, clientY) {
  screenToNdc(clientX, clientY);
  raycaster.setFromCamera(pointer, camera);
  raycaster.params.Points.threshold = 0.5;
  const hits = raycaster.intersectObject(points);
  return hits.length ? hits[0].index : -1;
}

export function particleAt(index) { return state.particles[index] || null; }

export function projectToScreen(x, y, z) {
  const v = new THREE.Vector3(x, y, z).project(camera);
  const rect = renderer.domElement.getBoundingClientRect();
  return { x: (v.x + 1) / 2 * rect.width, y: (1 - v.y) / 2 * rect.height };
}

export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function worldToUV(p) {
  if (state.drawPlane === 'XZ') return [p.x, p.z];
  if (state.drawPlane === 'XY') return [p.x, p.y];
  return [p.y, p.z];
}

export const shapeCount = () => Math.max(2, state.drawCount || 30);

export function computeShapePositions(mode, u0, v0, u1, v1, off) {
  const toWorld = PLANES[state.drawPlane].toWorld;
  const out = [];
  const su0 = shiftHeld ? snapValue(u0) : u0;
  const sv0 = shiftHeld ? snapValue(v0) : v0;
  const sU0 = su0, sV0 = sv0;
  const sU1 = u1 + (su0 - u0), sV1 = v1 + (sv0 - v0);
  const push = (u, v) => { const [x, y, z] = toWorld(u, v, off); out.push([x, y, z]); };
  if (mode === 'line') {
    const n = shapeCount();
    for (let i = 0; i < n; i++) { const t = n === 1 ? 0.5 : i / (n - 1); push(sU0 + (sU1 - sU0) * t, sV0 + (sV1 - sV0) * t); }
  } else if (mode === 'circle') {
    const r = Math.hypot(sU1 - sU0, sV1 - sV0);
    const n = shapeCount();
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; push(sU0 + Math.cos(a) * r, sV0 + Math.sin(a) * r); }
  } else if (mode === 'rect') {
    const n = Math.max(2, Math.round(Math.sqrt(shapeCount())));
    const uMin = Math.min(sU0, sU1), uMax = Math.max(sU0, sU1), vMin = Math.min(sV0, sV1), vMax = Math.max(sV0, sV1);
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) push(uMin + (uMax - uMin) * i / n, vMin + (vMax - vMin) * j / n);
  }
  return out;
}
