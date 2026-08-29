/* =========================================================================
 * 跨模块共享的输入状态
 * Shift 按下状态与树节点拖拽中的粒子 id 集合，被 main / gizmo / interaction / tree 共用。
 * 独立成模块以避免这些模块之间的循环依赖。
 * ======================================================================= */

export let shiftHeld = false;
export function setShiftHeld(value) { shiftHeld = value; }

let dragIds = null;
export function getDragIds() { return dragIds; }
export function setDragIds(value) { dragIds = value; }