/* =========================================================================
 * 悬浮窗框架：Windows 式窗口（标题栏拖动、八向缩放、最小化、点击置顶）
 * 供拼图模式下的场景窗 / 代码链窗 / 代码回显窗复用。
 * ======================================================================= */

let fwinZTop = 1000;

/**
 * 创建悬浮窗。
 * @param {string} id 窗口 DOM id
 * @param {string} title 标题
 * @param {object} opts { x, y, w, h, minW, minH, resizable, minimizable, closable, onClose }
 * @returns { {el, body, titlebar, setPos, setSize, minimize, restore, isMinimized} }
 */
function makeFloatWindow(id, title, opts) {
  const o = opts || {};
  const el = document.createElement('div');
  el.className = 'fwin';
  el.id = id;
  const minW = o.minW != null ? o.minW : 240;
  const minH = o.minH != null ? o.minH : 160;
  if (o.x != null) { el.style.left = o.x + 'px'; el.style.top = o.y + 'px'; }
  if (o.w != null) el.style.width = o.w + 'px';
  if (o.h != null) el.style.height = o.h + 'px';

  // 标题栏
  const tb = document.createElement('div');
  tb.className = 'fwin-titlebar';
  const titleEl = document.createElement('span');
  titleEl.className = 'fwin-title';
  titleEl.textContent = title;
  tb.appendChild(titleEl);
  const btns = document.createElement('span');
  btns.className = 'fwin-btns';
  let minimized = false;

  if (o.minimizable !== false) {
    const minBtn = document.createElement('button');
    minBtn.className = 'fwin-btn'; minBtn.textContent = '─'; minBtn.title = t('fwin.minimize');
    minBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMin(); });
    btns.appendChild(minBtn);
  }
  if (o.closable !== false) {
    const closeBtn = document.createElement('button');
    closeBtn.className = 'fwin-btn fwin-close'; closeBtn.textContent = '×'; closeBtn.title = t('common.close');
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); if (o.onClose) o.onClose(); });
    btns.appendChild(closeBtn);
  }
  tb.appendChild(btns);
  el.appendChild(tb);

  const body = document.createElement('div');
  body.className = 'fwin-body';
  el.appendChild(body);

  // 八向缩放手柄
  if (o.resizable !== false) {
    ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].forEach(dir => {
      const h = document.createElement('div');
      h.className = 'fwin-rsz fwin-rsz-' + dir;
      h.dataset.dir = dir;
      h.addEventListener('pointerdown', (e) => beginResize(e, dir));
      el.appendChild(h);
    });
  }

  function raise() { el.style.zIndex = ++fwinZTop; }

  // 标题栏拖动
  tb.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.fwin-btn')) return;
    e.preventDefault();
    raise();
    const startX = e.clientX, startY = e.clientY;
    const origL = el.offsetLeft, origT = el.offsetTop;
    const move = (ev) => {
      el.style.left = (origL + ev.clientX - startX) + 'px';
      el.style.top = (origT + ev.clientY - startY) + 'px';
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  function beginResize(e, dir) {
    e.preventDefault(); e.stopPropagation();
    raise();
    const startX = e.clientX, startY = e.clientY;
    const origL = el.offsetLeft, origT = el.offsetTop, origW = el.offsetWidth, origH = el.offsetHeight;
    const move = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      let L = origL, T = origT, W = origW, H = origH;
      if (dir.includes('e')) W = origW + dx;
      if (dir.includes('s')) H = origH + dy;
      if (dir.includes('w')) { W = origW - dx; L = origL + dx; }
      if (dir.includes('n')) { H = origH - dy; T = origT + dy; }
      if (W < minW) { if (dir.includes('w')) L -= (minW - W); W = minW; }
      if (H < minH) { if (dir.includes('n')) T -= (minH - H); H = minH; }
      el.style.left = L + 'px'; el.style.top = T + 'px';
      el.style.width = W + 'px'; el.style.height = H + 'px';
      if (o.onResize) o.onResize();
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function toggleMin() {
    minimized = !minimized;
    el.classList.toggle('fwin-minimized', minimized);
  }
  function minimize() { if (!minimized) { minimized = true; el.classList.add('fwin-minimized'); } }
  function restore() { if (minimized) { minimized = false; el.classList.remove('fwin-minimized'); } }

  // 点击任意处置顶
  el.addEventListener('pointerdown', () => raise(), true);

  function setPos(x, y) { el.style.left = x + 'px'; el.style.top = y + 'px'; }
  function setSize(w, h) { el.style.width = w + 'px'; el.style.height = h + 'px'; }

  // 窗口 resize 后把悬浮窗拉回屏幕内（避免窗口移出屏幕无法拖动）
  function clampToScreen() {
    if (minimized) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    const margin = 40; // 至少留 40px（标题栏）可见
    let L = el.offsetLeft, T = el.offsetTop;
    L = Math.max(-w + margin, Math.min(L, window.innerWidth - margin));
    T = Math.max(-h + margin, Math.min(T, window.innerHeight - margin));
    el.style.left = L + 'px';
    el.style.top = T + 'px';
  }
  window.addEventListener('resize', clampToScreen);

  return {
    el, body, titlebar: tb,
    setPos, setSize, minimize, restore,
    get isMinimized() { return minimized; },
    get x() { return el.offsetLeft; },
    get y() { return el.offsetTop; },
    get w() { return el.offsetWidth; },
    get h() { return el.offsetHeight; },
    setTitle(s) { t.textContent = s; },
  };
}
