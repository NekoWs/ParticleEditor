/* =========================================================================
 * 多语言支持（i18n）—— 薄加载器
 * 所有文本以固定键存储在语言文件 js/langs.js（window.LANGS = { zh: {...}, en: {...} }），
 * 加载时只读该语言文件；缺失键回退中文，再回退键名本身。
 * t(key)：取当前语言文本；tf(key, ...args)：支持 {0} {1} 占位符。
 * HTML 静态文本用 data-i18n / data-i18n-title / data-i18n-placeholder 标注固定键。
 * 语言持久化在 localStorage('pdraw-lang')，切换后原地重渲染。
 * ======================================================================= */

const I18N_LANGS = (typeof LANGS !== 'undefined') ? LANGS : { zh: {}, en: {} };

let LANG = 'zh';
try {
  const s = localStorage.getItem('pdraw-lang');
  if (s === 'en' || s === 'zh') LANG = s;
} catch (e) { /* 无 localStorage（隐私模式等）时忽略 */ }

// 取当前语言文本（固定键）
function t(key) {
  const zh = I18N_LANGS.zh || {};
  if (LANG === 'en') {
    const en = I18N_LANGS.en || {};
    if (en[key] != null) return en[key];
  }
  if (zh[key] != null) return zh[key];
  return key;
}

// 带占位符的翻译：tf('alert.text', a, b) → 替换 {0} {1}
function tf(key) {
  let s = t(key);
  for (let i = 1; i < arguments.length; i++) {
    s = s.replace('{' + (i - 1) + '}', String(arguments[i]));
  }
  return s;
}

// 错误消息翻译（公式/拼图解析报错展示用）
function _et(key) { return t(key); }
function _etf(key, a) { return tf(key, a); }

// 把 data-i18n* 属性（固定键）应用到 DOM
function applyI18nDom() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
}

// 语言切换：更新所有静态文本 + 重渲染各面板
function setLanguage(lang) {
  if (lang !== 'zh' && lang !== 'en') return;
  LANG = lang;
  try { localStorage.setItem('pdraw-lang', lang); } catch (e) { }
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  applyI18nDom();
  // 动态 UI 就地重渲染
  if (typeof refreshFxPresetOptions === 'function') refreshFxPresetOptions();
  if (typeof refreshParticleTree === 'function') refreshParticleTree();
  if (typeof refreshFunctionPanel === 'function') refreshFunctionPanel();
  if (typeof refreshTexturePanel === 'function') refreshTexturePanel();
  if (typeof updatePropPanel === 'function') updatePropPanel();
  if (typeof updateTimeUI === 'function') updateTimeUI();
  if (typeof updateTopbarTitle === 'function') updateTopbarTitle();
  if (typeof syncPlayButton === 'function') syncPlayButton();
  if (typeof drawTimeline === 'function') drawTimeline();
  if (typeof drawTimelineLayers === 'function') drawTimelineLayers();
  if (typeof refreshCompTimelines === 'function') refreshCompTimelines();
  if (typeof closeContextMenu === 'function') closeContextMenu();
  // 拼图模式打开时：重渲染调色板与代码链
  if (document.body.classList.contains('puzzle-mode')) {
    if (typeof renderPalette === 'function') renderPalette();
    if (typeof renderChain === 'function') renderChain();
    if (typeof refreshCodeEcho === 'function') refreshCodeEcho();
  }
}
