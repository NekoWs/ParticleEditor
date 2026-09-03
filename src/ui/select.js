/* =========================================================================
 * 触屏自定义下拉框：替换原生 <select>（移动端会弹全屏滚轮/系统面板）。
 * - 仅在 (pointer: coarse) 下启用；桌面仍用原生 select。
 * - 保留原生 select 在 DOM 中（隐藏），选项选择后写回 select.value 并派发 change，
 *   因此已有代码读取 .value / 监听 change 的路径全部保持不变。
 * ======================================================================= */

import { hasCoarsePointer } from '../core/device.js';

// 单例：所有自定义下拉共用一个外部点击关闭监听，避免每次包裹 select 都新增监听。
let outsideBound = false;
function closeAllOpen() {
  document.querySelectorAll('.csel.csel-open').forEach(w => w.classList.remove('csel-open'));
}
function ensureOutsideClose() {
  if (outsideBound) return;
  outsideBound = true;
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest || !e.target.closest('.csel')) closeAllOpen();
  }, true);
}

export function customSelect(selectEl) {
  if (!selectEl || selectEl.dataset.cselApplied || !hasCoarsePointer()) return selectEl;
  selectEl.dataset.cselApplied = '1';
  selectEl.style.display = 'none';
  ensureOutsideClose();

  const wrap = document.createElement('span');
  wrap.className = 'csel';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'csel-btn';
  const list = document.createElement('div');
  list.className = 'csel-list';
  wrap.appendChild(btn);
  wrap.appendChild(list);

  const label = () => {
    const o = selectEl.options[selectEl.selectedIndex];
    btn.textContent = o ? (o.textContent || o.value) : (selectEl.value || '');
  };
  label();
  selectEl._cselRefresh = label;
  selectEl.parentNode.insertBefore(wrap, selectEl.nextSibling);

  const close = () => wrap.classList.remove('csel-open');

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
        close();
      });
      list.appendChild(item);
    }
    closeAllOpen();
    wrap.classList.add('csel-open');
    position();
  };

  function position() {
    const r = btn.getBoundingClientRect();
    list.style.visibility = 'hidden';
    list.style.display = 'block';
    const lw = list.offsetWidth;
    const lh = list.offsetHeight;
    let x = Math.max(8, Math.min(r.left, window.innerWidth - lw - 8));
    let y = r.bottom + 4;
    if (y + lh > window.innerHeight - 8) y = Math.max(8, r.top - lh - 4);
    list.style.left = x + 'px';
    list.style.top = y + 'px';
    list.style.visibility = '';
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (wrap.classList.contains('csel-open')) close();
    else open();
  });

  return { el: wrap, refresh: label };
}

// 选项变化后刷新按钮文本（如语言切换后重建 #fx-preset-add 的 option 列表）。
export function refreshCustomSelect(selectEl) {
  if (selectEl && typeof selectEl._cselRefresh === 'function') selectEl._cselRefresh();
}