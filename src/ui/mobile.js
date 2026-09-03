/* =========================================================================
 * 移动端 / 平板布局控制
 * 职责：小屏时切换「视口优先 + 抽屉式面板」布局，管理面板/时间轴抽屉开关，
 *       在断点变化时同步 body 状态与时间轴行高。
 * ======================================================================= */

import { isNarrowLayout, NARROW_MQ } from '../core/device.js';
import { TL_TREE_ROW_H, updateTLTreeRowH, refreshTimelineTree } from './timeline-tree.js';

let inited = false;

export function mobileLayoutActive() {
  return isNarrowLayout();
}

export function openDrawer(which) {
  if (!document.body || !isNarrowLayout()) return;
  // 小屏同时只显示一个抽屉，减少遮挡；大屏抽屉类不影响布局。
  closeDrawers();
  document.body.classList.add('drawer-' + which + '-open');
}

export function closeDrawer(which) {
  if (document.body) document.body.classList.remove('drawer-' + which + '-open');
}

export function closeDrawers() {
  closeDrawer('panel');
  closeDrawer('timeline');
}

export function toggleDrawer(which) {
  if (!document.body) return;
  const cls = 'drawer-' + which + '-open';
  const wasOpen = document.body.classList.contains(cls);
  closeDrawers();
  if (!wasOpen) document.body.classList.add(cls);
}

function syncLayout() {
  const narrow = isNarrowLayout();
  if (document.body) {
    document.body.classList.toggle('mobile-layout', narrow);
    if (!narrow) closeDrawers();
  }
  const prevRowH = TL_TREE_ROW_H;
  updateTLTreeRowH();
  // 行高变化会同时影响 HTML 标签轨与 lane 画布，必须重建左轨 DOM。
  if (TL_TREE_ROW_H !== prevRowH) refreshTimelineTree(true);
}

export function initMobileUI() {
  if (inited) return;
  inited = true;

  syncLayout();
  try {
    if (typeof NARROW_MQ.addEventListener === 'function') NARROW_MQ.addEventListener('change', syncLayout);
    else if (typeof NARROW_MQ.addListener === 'function') NARROW_MQ.addListener(syncLayout);
  } catch (e) { /* 旧浏览器/测试桩忽略 */ }

  const panelBtn = document.getElementById('mobile-panel-btn');
  const timelineBtn = document.getElementById('mobile-timeline-btn');
  const backdrop = document.getElementById('drawer-backdrop');

  if (panelBtn) panelBtn.addEventListener('click', () => toggleDrawer('panel'));
  if (timelineBtn) timelineBtn.addEventListener('click', () => toggleDrawer('timeline'));
  if (backdrop) backdrop.addEventListener('click', () => closeDrawers());
}