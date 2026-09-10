// Tauri 桌面/安卓客户端与 Web 之间的文件读写桥接。
// 浏览器环境不存在 Tauri 运行时，isTauri() 为 false，相关分支不会被走到。

import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile, writeFile } from '@tauri-apps/plugin-fs';

let _lastPath = null;

export function isTauri() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
}

export function lastPath() { return _lastPath; }
export function setLastPath(path) { _lastPath = path; }
export function clearLastPath() { _lastPath = null; }

// 弹出系统文件选择器，读取 .pdraw/.json 工程文本。取消返回 null。
export async function openProjectPicker() {
  const picked = await open({
    multiple: false,
    filters: [{ name: 'ParticleDrawing', extensions: ['pdraw', 'json'] }],
  });
  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return null;
  const text = await readTextFile(path);
  const name = path.split(/[\\/]/).pop() || 'project.pdraw';
  return { name, text };
}

// 弹出系统保存对话框并写入 data（字符串或 Uint8Array）。取消返回 null。
export async function saveFilePicker(suggestedName, ext, data) {
  const cleanExt = ext.replace('.', '');
  const picked = await save({
    defaultPath: suggestedName,
    filters: [{ name: cleanExt.toUpperCase(), extensions: [cleanExt] }],
  });
  if (!picked) return null;
  if (typeof data === 'string') await writeTextFile(picked, data);
  else await writeFile(picked, data instanceof Uint8Array ? data : new Uint8Array(data));
  return picked;
}

// 直接覆盖写入已知路径（Ctrl+S 保存到上次选择的文件）。
export async function writeProjectText(path, text) {
  await writeTextFile(path, text);
}