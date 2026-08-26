/* =========================================================================
 * 底部时间轴 · 图层区（AE 式）
 *
 * - 行模型：组聚合行（成员 st 跨度，可展开为成员行）+ 未分组粒子行 + 函数对象行；
 * - 拖拽条形起点改 st（整数 tick 吸附）；组条拖拽整体平移全部成员；
 * - 粒子寿命 life（tick，-1=无限）：有限时条长=st~st+life，右端手柄拖拽调整；
 *   双击右端手柄在 无限⇄有限（取当前指针位置） 之间切换；
 * - 视口横向与标尺共享 timelineViewStart / TL_PX_PER_TICK（panels.js）；
 * - undo：拖拽开始前 pushUndo 一次（undo.js 的 snapshot 经字段展开天然覆盖 st/life/ent）。
 * ======================================================================= */

const TL_LAYER_ROW_H = 18;
const tlLayerState = { expanded: new Set(), scroll: 0, drag: null, hit: [] };

function tlLayerRows() {
  const rows = [];
  const grouped = new Set();
  for (const [gname, members] of Object.entries(state.groups)) {
    for (const id of members) grouped.add(id);
    rows.push({ kind: 'group', name: gname, members: members.slice() });
  }
  for (const p of state.particles) {
    if (p.fx || grouped.has(p.id)) continue;
    rows.push({ kind: 'particle', p });
  }
  for (const fx of state.functions) rows.push({ kind: 'fx', fx });
  return rows;
}

function rowLabel(r) {
  if (r.kind === 'group') return r.name + ' (' + r.members.length + ')';
  if (r.kind === 'fx') return r.fx.name;
  return r.p.id;
}

function particleLifeEnd(p) {
  const life = typeof p.life === 'number' ? p.life : -1;
  const s = p.st || 0;
  return life < 0 ? Infinity : s + life;
}

/** 行的可见性跨度 [start, end]；end 可为 Infinity（无限寿命）。 */
function rowSpan(r) {
  if (r.kind === 'group') {
    let lo = Infinity, hi = -Infinity, anyInf = false;
    for (const id of r.members) {
      const p = state.particles.find(q => q.id === id);
      if (!p) continue;
      const e = particleLifeEnd(p), s = p.st || 0;
      lo = Math.min(lo, s);
      if (e === Infinity) anyInf = true; else hi = Math.max(hi, e);
    }
    if (lo === Infinity) { lo = 0; }
    return [lo, anyInf ? Infinity : Math.max(hi, lo)];
  }
  if (r.kind === 'fx') {
    // 与 maxTick 一致：extent = max(时长, 变量关键帧最大 tick)
    const fx = r.fx;
    let extent = fx.duration || 0;
    for (const v of Object.values(fx.vars)) for (const k of (v.kf || [])) if (k[0] > extent) extent = k[0];
    return [fx.st || 0, (fx.st || 0) + extent];
  }
  const s = r.p.st || 0, e = particleLifeEnd(r.p);
  return [s, e];
}

function drawTimelineLayers() {
  const canvas = document.getElementById('tl-layers-canvas');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#181b22';
  ctx.fillRect(0, 0, w, h);

  // 刻度行：每 5 tick 一条线（与标尺对齐）；数字只在上方标尺显示
  const pxPerTick = TL_PX_PER_TICK;
  ctx.strokeStyle = '#262b34';
  const viewEnd = timelineViewStart + w / pxPerTick;
  for (let t = Math.max(0, Math.floor(timelineViewStart / 5) * 5); t <= viewEnd; t += 5) {
    ctx.beginPath(); ctx.moveTo(X_of(t), 0); ctx.lineTo(X_of(t), h); ctx.stroke();
  }

  const rowH = TL_LAYER_ROW_H;
  const headerH = 12;
  const X = t => (t - timelineViewStart) * pxPerTick;

  // 展开组的成员行插入到组行之后
  const flat = [];
  for (const r of tlLayerRows()) {
    flat.push(r);
    if (r.kind === 'group' && tlLayerState.expanded.has(r.name)) {
      for (const id of r.members) {
        const p = state.particles.find(q => q.id === id);
        if (p) flat.push({ kind: 'member', p, group: r.name });
      }
    }
  }

  tlLayerState.hit = [];
  let y = headerH - tlLayerState.scroll;
  for (const r of flat) {
    if (y + rowH >= headerH && y <= h) {
      const [s, e] = rowSpan(r);
      ctx.fillStyle = '#8a92a3'; ctx.font = '10px sans-serif'; ctx.textBaseline = 'middle';
      const arrow = r.kind === 'group' ? (tlLayerState.expanded.has(r.name) ? '▾ ' : '▸ ') : '';
      ctx.fillText(arrow + rowLabel(r), 4, y + rowH / 2);
      const bx = X(s);
      const inf = e === Infinity;
      const bw = inf ? Math.max(4, w - bx) : Math.max(4, X(e) - X(s));
      ctx.fillStyle = r.kind === 'group' ? '#c9a24b' : r.kind === 'fx' ? '#7e6bc9' : '#4b7ec9';
      ctx.fillRect(bx, y + 3, bw, rowH - 6);
      if (inf) {
        // 无限寿命：右端渐隐 + ∞ 标记
        const grad = ctx.createLinearGradient(w - 60, 0, w, 0);
        grad.addColorStop(0, 'rgba(24,27,34,0)');
        grad.addColorStop(1, '#181b22');
        ctx.fillStyle = grad;
        ctx.fillRect(Math.max(bx, w - 60), y + 3, w - Math.max(bx, w - 60), rowH - 6);
        if (bw > 26) { ctx.fillStyle = '#aab3c5'; ctx.fillText('∞', Math.min(w - 14, bx + bw - 12), y + rowH / 2); }
      } else {
        ctx.fillStyle = '#dfe6f2';
        ctx.fillRect(X(e) - 1.5, y + 2, 3, rowH - 4);   // 寿命终点手柄
      }
      ctx.fillStyle = '#e8ecf5';
      ctx.fillRect(bx - 1.5, y + 2, 3, rowH - 4);       // 起点(入场)手柄
      // 播放头之前（未出场）画遮罩
      if (state.time < s) { ctx.fillStyle = 'rgba(24,27,34,0.55)'; ctx.fillRect(bx, y + 3, Math.max(0, w - bx), rowH - 6); }
      tlLayerState.hit.push({ y, rowH, r, s, e, inf, bx, bw });
    }
    y += rowH;
  }

  const phx = (state.time - timelineViewStart) * pxPerTick;
  ctx.strokeStyle = 'rgba(255,204,85,0.5)';
  ctx.beginPath(); ctx.moveTo(phx, headerH); ctx.lineTo(phx, h); ctx.stroke();
}

function X_of(t) { return (t - timelineViewStart) * TL_PX_PER_TICK; }

/** 命中检测：返回 {hit, zone}；zone ∈ 'start'|'life'|'body'。 */
function tlLayerHitAt(clientX, clientY) {
  const canvas = document.getElementById('tl-layers-canvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const lx = clientX - rect.left;
  const ly = clientY - rect.top + tlLayerState.scroll;
  for (const hsp of tlLayerState.hit) {
    if (ly < hsp.y || ly >= hsp.y + hsp.rowH) continue;
    if (lx < hsp.bx - 5 || lx > hsp.bx + hsp.bw + 5) continue;
    let zone = 'body';
    if (lx <= hsp.bx + 4) zone = 'start';
    else if (!hsp.inf && lx >= hsp.bx + hsp.bw - 4) zone = 'life';
    return { hit: hsp, zone };
  }
  return null;
}

function setRowStart(r, v) {
  if (r.kind === 'particle' || r.kind === 'member') r.p.st = v;
  else if (r.kind === 'fx') r.fx.st = v;
}

function setParticleLife(p, v) {
  p.life = Math.max(1, v);   // 拖拽调整的最小寿命 1 tick
}

function shiftGroup(r, delta) {
  if (!delta) return;
  for (const id of r.members) {
    const p = state.particles.find(q => q.id === id);
    if (p) p.st = Math.max(0, (p.st || 0) + delta);
  }
}

function timelineXToTickL(clientX) {
  const canvas = document.getElementById('tl-layers-canvas');
  const rect = canvas.getBoundingClientRect();
  return timelineViewStart + (clientX - rect.left) / TL_PX_PER_TICK;
}

/** 轻刷新：st/life 改动后同步时长显示、标尺、图层区与预览。 */
function refreshAllPanelsLight() {
  const maxEl = document.getElementById('tl-max');
  if (maxEl) maxEl.textContent = maxTick();
  if (typeof drawTimeline === 'function') drawTimeline();
  drawTimelineLayers();
  rebuildPoints(false);
}

function tlInitLayerEvents() {
  const canvas = document.getElementById('tl-layers-canvas');
  const grip = document.getElementById('tl-module-resize');
  if (!canvas) return;

  canvas.addEventListener('pointerdown', ev => {
    const res = tlLayerHitAt(ev.clientX, ev.clientY);
    if (!res) return;
    const { hit, zone } = res;
    // 组行行首 14px 是展开箭头，交给 click 处理
    if (hit.r.kind === 'group' && (ev.clientX - canvas.getBoundingClientRect().left) < 14) return;
    pushUndo();
    canvas.setPointerCapture(ev.pointerId);
    const ptrTick = Math.round(timelineXToTickL(ev.clientX));
    if (hit.r.kind === 'group') {
      tlLayerState.drag = { kind: 'shift', r: hit.r, lastTick: ptrTick };
      return;
    }
    // 点击瞬间不跳位：记录「指针-当前值」抓取偏移，拖动后按偏移平移
    if (zone === 'life') {
      if (hit.r.kind === 'fx') {
        // 函数对象右端手柄：拖拽调整时长（此前会因 hit.r.p 不存在而报错无法拖动）
        const fx = hit.r.fx;
        const [s, e] = rowSpan(hit.r);
        tlLayerState.drag = { kind: 'fxdur', fx, grabOff: ptrTick - Math.max(1, e - s) };
      } else {
        const p = hit.r.p;
        const end = particleLifeEnd(p);
        const curLife = end === Infinity ? -1 : Math.max(1, end - (p.st || 0));
        tlLayerState.drag = { kind: 'life', p, grabOff: ptrTick - curLife };
      }
    } else {
      const cur = hit.r.kind === 'fx' ? (hit.r.fx.st || 0) : (hit.r.p.st || 0);
      tlLayerState.drag = { kind: 'start', r: hit.r, grabOff: ptrTick - cur };
    }
  });

  canvas.addEventListener('pointermove', ev => {
    const d = tlLayerState.drag;
    if (!d) {
      // 悬停光标反馈
      const res = tlLayerHitAt(ev.clientX, ev.clientY);
      canvas.style.cursor = res && res.zone !== 'body' ? 'ew-resize' : 'grab';
      return;
    }
    const ptrTick = timelineXToTickL(ev.clientX);
    if (d.kind === 'start') {
      setRowStart(d.r, Math.max(0, Math.round(ptrTick - d.grabOff)));
    } else if (d.kind === 'life') {
      setParticleLife(d.p, Math.max(1, Math.round(ptrTick - d.grabOff)));
    } else if (d.kind === 'fxdur') {
      d.fx.duration = Math.max(1, Math.round(ptrTick - d.grabOff));
    } else {
      const t = Math.round(ptrTick);
      const delta = t - d.lastTick;
      if (delta) { shiftGroup(d.r, delta); d.lastTick += delta; }
    }
    refreshAllPanelsLight();
  });

  const endDrag = () => { tlLayerState.drag = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // 双击寿命终点手柄：无限 ⇄ 有限（取双击处 tick 与 st 的距离）
  canvas.addEventListener('dblclick', ev => {
    const res = tlLayerHitAt(ev.clientX, ev.clientY);
    if (!res || res.hit.r.kind === 'group' || res.hit.r.kind === 'fx') return;
    if (res.zone !== 'life' && !(res.hit.inf && res.zone === 'body')) return;
    const p = res.hit.r.p;
    pushUndo();
    if (particleLifeEnd(p) === Infinity) {
      setParticleLife(p, Math.max(1, Math.round(timelineXToTickL(ev.clientX)) - (p.st || 0)));
    } else {
      p.life = -1; // 无限
    }
    refreshAllPanelsLight();
  });

  canvas.addEventListener('wheel', ev => {
    ev.preventDefault();
    tlLayerState.scroll = Math.max(0, tlLayerState.scroll + (ev.deltaY > 0 ? TL_LAYER_ROW_H * 2 : -TL_LAYER_ROW_H * 2));
    drawTimelineLayers();
  }, { passive: false });

  canvas.addEventListener('click', ev => {
    const hit = tlLayerHitAt(ev.clientX, ev.clientY);
    if (hit && hit.hit.r.kind === 'group') {
      const rect = canvas.getBoundingClientRect();
      if (ev.clientX - rect.left < 14) {
        const name = hit.hit.r.name;
        if (tlLayerState.expanded.has(name)) tlLayerState.expanded.delete(name);
        else tlLayerState.expanded.add(name);
        drawTimelineLayers();
      }
    }
  });

  // 时间轴模块整体高度拖拽（模块顶边）：clientY 差分驱动，方向=向上拖增高。
  // 高度写入 body 的 --tl-h（body 网格第三行轨道），图层画布 flex:1 自动填满剩余空间。
  const moduleGrip = document.getElementById('tl-module-resize');
  if (moduleGrip) {
    let resizing = false, lastY = 0;
    moduleGrip.addEventListener('pointerdown', (e) => {
      resizing = true;
      lastY = e.clientY;
      moduleGrip.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    moduleGrip.addEventListener('pointermove', (e) => {
      if (!resizing) return;
      const dy = e.clientY - lastY;
      lastY = e.clientY;
      const cur = parseFloat(getComputedStyle(document.body).getPropertyValue('--tl-h')) || 360;
      const nh = Math.min(window.innerHeight * 0.75, Math.max(160, cur - dy));
      document.body.style.setProperty('--tl-h', nh + 'px');
      resize();               // .layout 1fr 行随之收缩，会影响 3D 视口
      drawTimelineLayers();
    });
    const stopResize = () => {
      if (!resizing) return;
      resizing = false;
      resize();
      if (typeof saveWorkspaceState === 'function') saveWorkspaceState();
    };
    moduleGrip.addEventListener('pointerup', stopResize);
    moduleGrip.addEventListener('pointercancel', stopResize);
  }
}
