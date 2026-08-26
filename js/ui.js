/* =========================================================================
 * UI 弹窗：替代浏览器原生 prompt / alert / confirm，符合主题风格
 * ======================================================================= */

let uiModalOverlay = null;
let uiModalClosePromise = Promise.resolve();

// 关闭当前弹窗：播放消失动画，动画结束后再移除 DOM。
// 返回的 Promise 在移除后 resolve（供 buildModal 等待，避免新弹窗与旧弹窗动画重叠）。
function closeUIModal() {
  if (!uiModalOverlay) return Promise.resolve();
  const ov = uiModalOverlay;
  uiModalOverlay = null;
  ov.classList.add('closing');
  uiModalClosePromise = new Promise((res) => {
    setTimeout(() => { ov.remove(); res(); }, 230); // 迟于动画时长（0.18s/0.16s）再移除
  });
  return uiModalClosePromise;
}

// 底层：构建弹窗，返回 { box, input, resolve }
async function buildModal({ title, message, input, buttons, content }) {
  closeUIModal();          // 触发旧弹窗关闭动画
  await uiModalClosePromise; // 等旧弹窗动画结束再显示新弹窗（避免重叠）
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'ui-modal-overlay';
    const box = document.createElement('div');
    box.className = 'ui-modal';
    if (title) {
      const t = document.createElement('div'); t.className = 'ui-modal-title'; t.textContent = title;
      box.appendChild(t);
    }
    if (message) {
      const m = document.createElement('div'); m.className = 'ui-modal-msg'; m.textContent = message;
      box.appendChild(m);
    }
    if (content) box.appendChild(content);
    let inp = null;
    if (input) {
      inp = document.createElement('input');
      inp.className = 'ui-modal-input';
      inp.type = 'text';
      inp.value = input.value != null ? String(input.value) : '';
      if (input.placeholder) inp.placeholder = input.placeholder;
      box.appendChild(inp);
    }
    const btns = document.createElement('div');
    btns.className = 'ui-modal-btns';
    let settled = false;
    const close = (v) => { if (settled) return; settled = true; resolve(v); closeUIModal(); };
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.className = 'ui-modal-btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '');
      btn.textContent = b.label;
      btn.onclick = () => close(b.inputValue ? inp.value : b.value);
      btns.appendChild(btn);
    }
    box.appendChild(btns);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    uiModalOverlay = overlay;
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(null); });
    const onKey = (e) => {
      if (e.key === 'Escape') { close(null); return; }
      if (e.key === 'Enter' && inp) {
        const primary = buttons.find(b => b.primary);
        if (primary && primary.inputValue) close(inp.value);
      }
    };
    overlay.addEventListener('keydown', onKey);
    if (inp) setTimeout(() => { inp.focus(); inp.select(); }, 0);
    invisibleFocus(overlay);
  });
}
// 让无输入框的弹窗也能响应键盘（Esc）
function invisibleFocus(el) {
  el.tabIndex = -1;
  el.focus();
}

function modalPrompt(title, def, placeholder) {
  return buildModal({
    title,
    input: { value: def, placeholder },
    buttons: [{ label: t('common.cancel'), value: null }, { label: t('common.ok'), value: null, primary: true, inputValue: true }],
  });
}
function modalAlert(title, message) {
  return buildModal({
    title, message,
    buttons: [{ label: t('common.ok'), value: undefined, primary: true }],
  });
}
function modalConfirm(title, message) {
  return buildModal({
    title, message,
    buttons: [{ label: t('common.cancel'), value: false }, { label: t('common.ok'), value: true, primary: true }],
  });
}

// 关于弹窗（替代顶部悬停展示）
function showAboutModal() {
  const content = document.createElement('div');
  content.className = 'about-body';
  const desc = document.createElement('div');
  desc.className = 'about-desc';
  desc.textContent = t('about.desc');
  content.appendChild(desc);
  const mkRow = (label, href) => {
    const row = document.createElement('div');
    row.className = 'about-row';
    const lab = document.createElement('span');
    lab.className = 'about-label';
    lab.textContent = t(label);
    row.appendChild(lab);
    if (href) {
      const a = document.createElement('a');
      a.className = 'about-link';
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = href;
      row.appendChild(a);
    } else {
      const v = document.createElement('span');
      v.className = 'about-value';
      v.textContent = 'NekoW';
      row.appendChild(v);
    }
    content.appendChild(row);
  };
  mkRow('about.developer', null);
  mkRow('GitHub', 'https://github.com/NekoWs/ParticleDrawing/');
  mkRow('BiliBili', 'https://space.bilibili.com/593877814');
  buildModal({
    title: t('about.title'),
    content,
    buttons: [{ label: t('common.ok'), value: undefined, primary: true }],
  });
}