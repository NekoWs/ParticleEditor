// 主题加载器：亮/暗配色切换。主题变量定义在 css/themes/{dark,light}.css，
// 这里只负责读取/持久化选择并把 data-theme 写到 <html>，CSS 变量随之切换。

export let THEME = 'dark';
try {
  const s = localStorage.getItem('pdraw-theme');
  if (s === 'light' || s === 'dark') THEME = s;
} catch (e) { /* 无 localStorage（隐私模式等）时忽略 */ }

export function getTheme() { return THEME; }

export function applyThemeDom() {
  document.documentElement.dataset.theme = THEME;
}

export function setTheme(theme) {
  if (theme !== 'light' && theme !== 'dark') return;
  THEME = theme;
  try { localStorage.setItem('pdraw-theme', theme); } catch (e) { }
  applyThemeDom();
}