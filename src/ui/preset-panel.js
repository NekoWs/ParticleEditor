// 「预设」面板（工作区选项卡内容）：选择目标函数对象，按类别列出预设修改卡片；
// 点击卡片打开预设窗口（preset-window.js）。已应用的预设在卡片上显示角标。

import { t } from '../core/i18n.js';
import { state, getFunction } from '../core/constants.js';
import { PRESET_CATEGORIES, appliedPresetIds } from '../core/presets.js';
import { customSelect } from './select.js';

let targetFxId = null;
let built = false;

function targetOptions() {
  if (!state.functions.some((f) => f.id === targetFxId)) {
    targetFxId = state.selectedFunction || (state.functions[0] && state.functions[0].id) || null;
  }
  return state.functions.map((f) => ({ id: f.id, name: f.name }));
}

export function refreshPresetPanel() {
  const host = document.getElementById('preset-panel');
  if (!host) return;
  host.textContent = '';

  // 目标函数对象选择
  const head = document.createElement('div');
  head.className = 'preset-target';
  const lab = document.createElement('span');
  lab.textContent = t('preset.panel.target');
  head.appendChild(lab);
  const sel = document.createElement('select');
  sel.id = 'preset-target-fx';
  const options = targetOptions();
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = o.name;
    sel.appendChild(opt);
  }
  sel.value = targetFxId || '';
  sel.addEventListener('change', () => { targetFxId = sel.value || null; });
  head.appendChild(sel);
  host.appendChild(head);
  customSelect(sel);

  if (options.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = t('preset.panel.noFx');
    host.appendChild(hint);
    return;
  }

  const applied = (() => {
    const fx = getFunction(targetFxId);
    return fx ? appliedPresetIds(fx.source) : new Set();
  })();

  const list = document.createElement('div');
  list.className = 'preset-list';
  for (const cat of PRESET_CATEGORIES) {
    const section = document.createElement('div');
    section.className = 'preset-cat';
    const title = document.createElement('div');
    title.className = 'preset-cat-title';
    title.textContent = t('preset.cat.' + cat.id);
    section.appendChild(title);
    const grid = document.createElement('div');
    grid.className = 'preset-grid';
    for (const id of cat.presetIds) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'preset-card';
      card.dataset.presetId = id;
      const name = document.createElement('div');
      name.className = 'preset-card-name';
      name.textContent = t('preset.' + id);
      const desc = document.createElement('div');
      desc.className = 'preset-card-desc';
      desc.textContent = t('preset.desc.' + id);
      card.appendChild(name);
      card.appendChild(desc);
      if (applied.has(id)) {
        const badge = document.createElement('span');
        badge.className = 'preset-card-badge';
        badge.textContent = t('preset.applied');
        card.appendChild(badge);
      }
      card.addEventListener('click', () => {
        const fxId = targetFxId;
        if (!fxId || !getFunction(fxId)) return;
        import('./preset-window.js').then((m) => m.openPresetWindow(fxId, id)).catch(() => {});
      });
      grid.appendChild(card);
    }
    section.appendChild(grid);
    list.appendChild(section);
  }
  host.appendChild(list);
}

export function initPresetPanel() {
  if (built) return;
  built = true;
  refreshPresetPanel();
}