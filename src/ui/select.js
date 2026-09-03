/* =========================================================================
 * 触屏自定义下拉框：替换原生 <select>（移动端会弹全屏滚轮/系统面板）。
 * - 仅在 (pointer: coarse) 下启用；桌面仍用原生 select。
 * - 保留原生 select 在 DOM 中（隐藏），选项选择后写回 select.value 并派发 change，
 *   因此已有代码读取 .value / 监听 change 的路径全部保持不变。
 * - 下拉列表是单例并挂在 body 下（避免侧栏/抽屉的 transform 或 overflow 裁剪，
 *   同时保证 fixed 定位相对视口）。
 * ======================================================================= */

import { hasCoarsePointer } from '../core/device.js';

let sharedList = null;   // 单例下拉列表
let activeWrap = null;   // 当前打开的下拉所属 .csel
let outsideBound = false;

function ensureList() {
  if (!sharedList) {
    sharedList = document.createElement('div');
    sharedList.className = 'csel-list';
    document.body.appendChild(sharedList);
  }
  return sharedList;
}

function closeActive() {
  if (activeWrap) {
    activeWrap.classList.remove('csel-open');
    activeWrap = null;
  }
  if (sharedList) sharedList.style.display = 'none';
}

function ensureOutsideClose() {
  if (outsideBound) return;
  outsideBound = true;
  document.addEventListener('pointerdown', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('.csel') || t.closest('.csel-list')) return;
    closeActive();
  }, true);
}

function position(btn, list) {
  const r = btn.getBoundingClientRect();
  list.style.visibility = 'hidden';
  list.style.display = 'block'; // 临时显示以测量尺寸
  const lw = list.offsetWidth;
  const lh = list.offsetHeight;
  let x = Math.max(8, Math.min(r.left, window.innerWidth - lw - 8));
  let y = r.bottom + 4;
  if (y + lh > window.innerHeight - 8) y = Math.max(8, r.top - lh - 4);
  list.style.left = x + 'px';
  list.style.top = y + 'px';
  list.style.visibility = '';
}

export function customSelect(selectEl) {
  if (!selectEl || selectEl.dataset.cselApplied || !hasCoarsePointer()) return selectEl;
  selectEl.dataset.cselApplied = '1';
  selectEl.style.display = 'none';
  ensureOutsideClose();
  const list = ensureList();

  const wrap = document.createElement('span');
  wrap.className = 'csel';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'csel-btn';
  wrap.appendChild(btn);

  const label = () => {
    const o = selectEl.options[selectEl.selectedIndex];
    btn.textContent = o ? (o.textContent || o.value) : (selectEl.value || '');
  };
  label();
  selectEl._cselRefresh = label;
  selectEl.parentNode.insertBefore(wrap, selectEl.nextSibling);

  const open = () => {
    label();
    list.innerHTML = '';
    for (const o of selectEl.options) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'csel-item' + (o.selected ? ' csel-sel' : '');
      item.textContent = o.textContent || o.value;
      item.addEventListener('click', () => {
        selectEl.value = o.value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        label();
        closeActive();
      });
      list.appendChild(item);
    }
    closeActive();
    activeWrap = wrap;
    wrap.classList.add('csel-open');
    position(btn, list);
    list.style.display = 'block';
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (activeWrap === wrap && list.style.display === 'block') closeActive();
    else open();
  });

  return { el: wrap, refresh: label };
}

// 选项变化后刷新按钮文本（如语言切换后重建 #fx-preset-add 的 option 列表）。
export function refreshCustomSelect(selectEl) {
  if (selectEl && typeof selectEl._cselRefresh === 'function') selectEl._cselRefresh();
}