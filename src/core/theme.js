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

/** 读取主题 CSS 变量（canvas 绘制等 JS 侧取色用）。 */
export function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch (e) { return fallback; }
}

/** 读取主题颜色变量，保证返回一个十六进制颜色（变量缺省时用 fallback）。 */
export function cssColor(name, fallbackHex) {
  return cssVar(name, fallbackHex);
}

/** 读取主题颜色变量并叠加透明度，返回 rgba() 字符串。 */
export function cssColorAlpha(name, fallbackHex, alpha) {
  const c = cssColor(name, fallbackHex);
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return c;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}