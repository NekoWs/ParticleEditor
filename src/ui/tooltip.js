// 自定义悬停气泡提示（替代浏览器原生 title 提示）。悬停 50ms 后显示黑色气泡，跟随目标元素
// 而非鼠标；定位按「右 → 上 → 下 → 左」依次回退，放不下的方向会裁进视口；气泡与目标元素保持
// 边距；显示期间临时移除目标的 title 来压住浏览器原生提示，离开时还原。

const DELAY = 50;         // 悬停延迟（ms）
const MARGIN = 8;         // 气泡与目标元素的边距（px）

let tipEl = null;
let hoverEl = null;       // 当前触发提示的元素
let pendingTitle = null;  // 等待显示的文案
let timer = null;

function ensureTip() {
  if (tipEl) return;
  tipEl = document.createElement('div');
  tipEl.id = 'app-tooltip';
  tipEl.className = 'app-tooltip';
  tipEl.setAttribute('role', 'tooltip');
  tipEl.style.display = 'none';
  document.body.appendChild(tipEl);
}

// 从触发点向上找最近一个带非空 title（或 alt）的元素
function findTipTarget(node) {
  let el = node;
  while (el && el.nodeType === 1 && el !== document.body) {
    const t = el.getAttribute && el.getAttribute('title');
    if (t && t.trim()) return { el, title: t.trim() };
    el = el.parentElement;
  }
  return null;
}

function restoreTitle(el) {
  const orig = el.getAttribute('data-orig-title');
  if (orig != null) {
    el.setAttribute('title', orig);
    el.removeAttribute('data-orig-title');
  }
}

function positionFor(el) {
  const rect = el.getBoundingClientRect();
  const tw = tipEl.offsetWidth;
  const th = tipEl.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const m = MARGIN;

  // 四个候选，优先级：右 → 上 → 下 → 左
  const candidates = [
    { x: rect.right + m,                                  y: rect.top + rect.height / 2 - th / 2 }, // 右·上下居中
    { x: rect.left + rect.width / 2 - tw / 2,             y: rect.top - th - m },                      // 上·左右居中
    { x: rect.left + rect.width / 2 - tw / 2,             y: rect.bottom + m },                        // 下·左右居中
    { x: rect.left - tw - m,                              y: rect.top + rect.height / 2 - th / 2 }, // 左·上下居中
  ];

  for (const c of candidates) {
    if (c.x >= 4 && c.y >= 4 && c.x + tw <= vw - 4 && c.y + th <= vh - 4) {
      return c;
    }
  }
  // 都放不下：回退到右侧并把坐标裁进视口
  const c = candidates[0];
  return {
    x: Math.max(4, Math.min(c.x, vw - tw - 4)),
    y: Math.max(4, Math.min(c.y, vh - th - 4)),
  };
}

function show(el, title) {
  // 目标已被移除则不显示
  if (!el.isConnected) return;
  el.setAttribute('data-orig-title', title);
  el.removeAttribute('title');
  tipEl.textContent = title;
  tipEl.style.display = '';
  const p = positionFor(el);
  tipEl.style.left = Math.round(p.x) + 'px';
  tipEl.style.top = Math.round(p.y) + 'px';
}

function hide() {
  if (hoverEl) restoreTitle(hoverEl);
  hoverEl = null;
  pendingTitle = null;
  if (tipEl) tipEl.style.display = 'none';
}

function arm(target) {
  if (hoverEl === target.el) return; // 已在等待或显示同一元素，不重置计时
  clearTimeout(timer);
  if (hoverEl) restoreTitle(hoverEl);
  hoverEl = target.el;
  pendingTitle = target.title;
  if (tipEl) tipEl.style.display = 'none';
  timer = setTimeout(() => {
    if (hoverEl === target.el) show(target.el, pendingTitle);
  }, DELAY);
}

export function initTooltip() {
  // 触屏没有可靠的 hover，原生 title 也不会出现；自定义气泡在触屏反而会误触/残留，直接关闭。
  try {
    if (typeof window !== 'undefined' && window.matchMedia && !window.matchMedia('(hover: hover)').matches) return;
  } catch (e) { /* 测试桩忽略 */ }
  ensureTip();

  document.addEventListener('mouseover', (e) => {
    const t = findTipTarget(e.target);
    if (!t) return;
    arm(t);
  });

  document.addEventListener('mouseout', (e) => {
    if (!hoverEl) return;
    const rel = e.relatedTarget;
    // 仍停留在目标元素子树内则保留
    if (rel && rel.nodeType === 1 && hoverEl.contains && hoverEl.contains(rel)) return;
    hide();
  });

  // 目标随滚动/缩放移动或视图尺寸变化时，隐藏以免错位
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  // 视野外的目标（如滚出时间轴）不显示
  document.addEventListener('scroll', () => {
    if (hoverEl && !hoverEl.isConnected) hide();
  }, true);
}
