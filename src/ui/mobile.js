// 移动端 / 平板布局控制：窄屏同样使用左右图标栏模型，仅做断点行高与状态同步。

import { isNarrowLayout, NARROW_MQ } from '../core/device.js';
import { TL_TREE_ROW_H, updateTLTreeRowH, refreshTimelineTree } from './timeline-tree.js';

let inited = false;

export function mobileLayoutActive() {
  return isNarrowLayout();
}

function syncLayout() {
  const narrow = isNarrowLayout();
  if (document.body) document.body.classList.toggle('mobile-layout', narrow);
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
}