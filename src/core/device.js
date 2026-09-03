/* =========================================================================
 * 设备 / 断点检测与触控辅助（移动端适配）
 * 纯 DOM 事件辅助，不依赖项目其它模块；所有 matchMedia 访问均已做测试桩保护。
 * ======================================================================= */

function mq(query) {
  try {
    if (typeof window !== 'undefined' && window.matchMedia) return window.matchMedia(query);
  } catch (e) { /* ignore */ }
  return { matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
}

export const NARROW_MQ = mq('(max-width: 1024px)');
export const COARSE_MQ = mq('(pointer: coarse)');
export const HOVER_MQ = mq('(hover: hover)');

export function isNarrowLayout() { return NARROW_MQ.matches; }
export function hasCoarsePointer() { return COARSE_MQ.matches; }
export function hasTouch() {
  if (hasCoarsePointer()) return true;
  try { if (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) return true; } catch (e) { /* ignore */ }
  return false;
}

/**
 * 长按检测：按住超过 delay 且移动不超过 tolerance 时触发 handler。
 * 适用于触屏替代右键菜单；鼠标右键/左键也会按同一规则触发。
 */
export function addLongPress(el, handler, opts) {
  if (!el) return () => {};
  const o = opts || {};
  const delay = o.delay || 480;
  const tolerance = o.tolerance || 10;
  let timer = null;
  let start = null;

  const clear = () => { if (timer) clearTimeout(timer); timer = null; start = null; };

  const down = (ev) => {
    // 鼠标只响应左/右键；触屏 pointerType 为 touch
    if (ev.pointerType === 'mouse' && ev.button !== 0 && ev.button !== 2) return;
    clear();
    start = { x: ev.clientX, y: ev.clientY };
    timer = setTimeout(() => {
      if (!start) return;
      start = null;
      handler(ev);
    }, delay);
  };
  const move = (ev) => {
    if (!start) return;
    if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > tolerance) clear();
  };

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', clear);
  el.addEventListener('pointercancel', clear);
  el.addEventListener('pointerleave', clear);
  return clear;
}