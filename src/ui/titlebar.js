// Windows 桌面端自定义标题栏：无边框窗口下显示最小化/最大化/关闭按钮，
// 并同步最大化/还原图标与提示文字。浏览器或非 Windows 平台不显示。
// 拖动由 index.html 中顶栏的 data-tauri-drag-region 处理（Tauri 注入脚本）。
import { t } from '../core/i18n.js';

function isWindows() {
  if (navigator.userAgentData && navigator.userAgentData.platform) {
    return navigator.userAgentData.platform === 'Windows';
  }
  return /Win/.test(navigator.platform || '');
}

export async function initTitleBar() {
  if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return;
  if (!isWindows()) return;

  const controls = document.getElementById('titlebar-controls');
  const minimizeBtn = document.getElementById('tb-minimize');
  const maximizeBtn = document.getElementById('tb-maximize');
  const closeBtn = document.getElementById('tb-close');
  if (!controls || !minimizeBtn || !maximizeBtn || !closeBtn) return;

  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const appWindow = getCurrentWindow();

  controls.hidden = false;

  let lastMaximized = null;
  const updateMaximizeBtn = async () => {
    const maximized = await appWindow.isMaximized();
    if (maximized === lastMaximized) return;
    lastMaximized = maximized;
    maximizeBtn.classList.toggle('restored', maximized);
    const key = maximized ? 'titlebar.restore' : 'titlebar.maximize';
    maximizeBtn.title = t(key);
    maximizeBtn.dataset.i18nTitle = key;
  };

  minimizeBtn.addEventListener('click', () => appWindow.minimize());
  closeBtn.addEventListener('click', () => appWindow.close());
  maximizeBtn.addEventListener('click', async () => {
    await appWindow.toggleMaximize();
    await updateMaximizeBtn();
  });

  try {
    await appWindow.onResized(() => updateMaximizeBtn());
  } catch (e) { /* 忽略：窗口 API 不可用时保持默认图标 */ }

  await updateMaximizeBtn();
}