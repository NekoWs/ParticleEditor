/* =========================================================================
 * 编辑：写入关键帧（分量级）
 * ======================================================================= */

// 修改基础值（完整向量）
function applyBaseValue(p, prop, values) {
  if (prop === 'pos') p.pos = values.slice(0, 3);
  else if (prop === 'col') p.color = values.slice(0, 4);
  else if (prop === 'vel') p.vel = values.slice(0, 3);
  else if (prop === 'scl') p.scale = values.slice(0, 3);
}

// 某 id（'p0' | 'g:g0' | 'f:fx0'）在某分量的基础值
function baseValueFor(id, prop, comp) {
  if (id.startsWith('g:')) {
    const gname = id.slice(2);
    if (prop === 'rot') return 0;
    return groupCentroidValue(gname, prop)[COMP_INDEX[comp]];
  }
  if (id.startsWith('f:')) {
    const fx = getFunction(id.slice(2));
    if (prop === 'pos') return fx ? fx.center[COMP_INDEX[comp]] : 0;
    if (prop === 'scl') return 1;
    return 0; // rot
  }
  const p = getParticle(id);
  return p ? baseComponent(p, prop, comp) : 0;
}

// 写某 id 在某分量的关键帧（标量值）
function setComponentKeyframe(id, prop, comp, time, value, mode) {
  const pr = compPr(prop, comp);
  let tr = findTrackByPr(pr, id);
  if (!tr) {
    const base = mode === 'op' ? 0 : baseValueFor(id, prop, comp);
    tr = { pr, m: mode, ids: [id], kf: [[0, base, state.defaultEasing]] };
    state.tracks.push(tr);
  } else {
    tr.m = mode;
  }
  // 始终捕获关键帧：但若 0t 到当前设置的值没有变化（新值等于 t=0 基线值），
  // 则不创建当前帧关键帧（并移除该 tick 上已有的冗余关键帧）
  const kf0 = tr.kf.find(k => k[0] === 0);
  if (time > 0 && kf0 && Math.abs(value - kf0[1]) < 1e-6) {
    tr.kf = tr.kf.filter(k => k[0] !== time);
    return;
  }
  let kf = tr.kf.find(k => k[0] === time);
  if (!kf) { kf = [time, value, state.defaultEasing]; tr.kf.push(kf); tr.kf.sort((a, b) => a[0] - b[0]); }
  else kf[1] = value;
}

// 为多个粒子在同一时间写统一值（每分量独立轨道）
function setValueAtTime(ids, prop, values) {
  const t = Math.round(state.time);
  const comps = TRACK_COMPS[prop];
  for (const id of ids) {
    const p = getParticle(id);
    if (!p) continue;
    comps.forEach((comp, i) => setComponentKeyframe(id, prop, comp, t, values[i], 'set'));
    if (t === 0 && !isDerivedParticle(p)) applyBaseValue(p, prop, values);
  }
  rebuildPoints();
  refreshParticleTree();
}

// 直接修改基础值（不创建关键帧），并同步 t=0 关键帧（若存在）
function editBaseValue(ids, prop, values) {
  const comps = TRACK_COMPS[prop];
  for (const id of ids) {
    const p = getParticle(id);
    if (!p) continue;
    if (isDerivedParticle(p)) continue;
    applyBaseValue(p, prop, values);
    comps.forEach((comp, i) => {
      const tr = findTrackByPr(compPr(prop, comp), id);
      if (tr) {
        const kf0 = tr.kf.find(k => k[0] === 0);
        if (kf0) kf0[1] = values[i];
      }
    });
  }
}

// 批量：为多个粒子在同一时间写关键帧（每个粒子独立值）
// 性能优化：直接用 p._tr 分量轨道数组访问轨道（跳过 findTrackByPr 的 Map 查询与 compPr 拼接），
// 供拖动 5w 粒子等热点路径使用。语义与 setComponentKeyframe 完全一致。
function setValuesAtTime(entries, prop) {
  const t = Math.round(state.time);
  const comps = TRACK_COMPS[prop];
  const prs = comps.map(c => prop + '.' + c);
  const idxs = prs.map(pr => PR_TO_IDX[pr]);
  for (const [id, values] of entries) {
    const p = getParticle(id);
    if (!p) continue;
    for (let i = 0; i < comps.length; i++) {
      const value = values[i];
      let tr = (p._trVersion === trVersion && p._tr) ? p._tr[idxs[i]] : null;
      if (!tr) {
        const base = baseValueFor(id, prop, comps[i]);
        tr = { pr: prs[i], m: 'set', ids: [id], kf: [[0, base, state.defaultEasing]] };
        state.tracks.push(tr);
        if (p._trVersion !== trVersion) { p._tr = new Array(13); p._trVersion = trVersion; }
        p._tr[idxs[i]] = tr;
      }
      const kf = tr.kf;
      const kf0 = kf[0];
      if (t > 0 && kf0 && Math.abs(value - kf0[1]) < 1e-6) {
        for (let k = kf.length - 1; k >= 0; k--) if (kf[k][0] === t) kf.splice(k, 1);
        continue;
      }
      let kfT = null;
      for (let k = 0; k < kf.length; k++) if (kf[k][0] === t) { kfT = kf[k]; break; }
      if (!kfT) {
        kfT = [t, value, state.defaultEasing];
        kf.push(kfT);
        kf.sort((a, b) => a[0] - b[0]);
      } else kfT[1] = value;
    }
    if (t === 0 && !isDerivedParticle(p)) applyBaseValue(p, prop, values);
  }
  rebuildPoints();
  refreshParticleTree();
}

// 逐粒子编辑：捕获时写当前帧关键帧，否则改基础值
function editParticles(entries, prop) {
  if (state.captureKeyframes) setValuesAtTime(entries, prop);
  else {
    for (const [id, values] of entries) editBaseValue([id], prop, values);
    rebuildPoints();
  }
}

// 统一值编辑（属性面板）：捕获关键帧时按 函数对象 > 组 > 粒子 优先级
function editSelectionUniform(prop, values) {
  const t = Math.round(state.time);
  const comps = TRACK_COMPS[prop];
  const fxId = state.selectedFunction;
  const gname = selectedGroupName();

  // 1. 函数对象优先
  if (fxId) {
    const fx = getFunction(fxId);
    if (!fx || prop === 'col' || prop === 'vel') return; // 无整体颜色/速度轨道
    if (!state.captureKeyframes) {
      if (prop === 'pos') { fx.center = values.slice(0, 3); commitFunctionRebuild(fx); }
      else if (prop === 'scl') { comps.forEach((comp, i) => setComponentKeyframe('f:' + fxId, 'scl', comp, 0, values[i], 'set')); rebuildPoints(); refreshParticleTree(); }
      return;
    }
    if (prop === 'pos') {
      comps.forEach((comp, i) => setComponentKeyframe('f:' + fxId, 'pos', comp, t, values[i] - fx.center[COMP_INDEX[comp]], 'op'));
    } else if (prop === 'scl') {
      comps.forEach((comp, i) => setComponentKeyframe('f:' + fxId, 'scl', comp, t, values[i], 'set'));
    }
    rebuildPoints(); refreshParticleTree();
    return;
  }

  // 2. 组
  if (gname) {
    if (!state.captureKeyframes) {
      editBaseValue(state.groups[gname] || [], prop, values);
      rebuildPoints();
      return;
    }
    const mode = prop === 'pos' ? 'op' : 'set';
    comps.forEach((comp, i) => {
      let v = values[i];
      if (mode === 'op') v = values[i] - groupCentroidValue(gname, 'pos')[COMP_INDEX[comp]];
      setComponentKeyframe('g:' + gname, prop, comp, t, v, mode);
    });
    rebuildPoints(); refreshParticleTree();
    return;
  }

  // 3. 单个粒子
  const ids = [...state.selected];
  if (ids.length === 0) return;
  if (ids.some(id => isDerivedParticle(getParticle(id)))) return; // 派生粒子基础属性只读
  if (!state.captureKeyframes) { editBaseValue(ids, prop, values); rebuildPoints(); return; }
  setValueAtTime(ids, prop, values);
}

// 单分量值编辑（树/时间轴用）
function setComponentValue(id, prop, comp, time, value) {
  const p = getParticle(id);
  if (!p) return;
  pushUndo();
  const pr = compPr(prop, comp);
  let tr = findTrackByPr(pr, id);
  if (!tr) {
    tr = { pr, m: 'set', ids: [id], kf: [[0, baseValueFor(id, prop, comp), state.defaultEasing]] };
    state.tracks.push(tr);
  }
  let kf = tr.kf.find(k => k[0] === time);
  if (!kf) {
    const cur = componentValueAt(p, prop, comp, time);
    kf = [time, cur, state.defaultEasing];
    tr.kf.push(kf);
    tr.kf.sort((a, b) => a[0] - b[0]);
  }
  kf[1] = value;
  if (time === 0 && !isDerivedParticle(p)) {
    if (prop === 'pos') p.pos[COMP_INDEX[comp]] = value;
    else if (prop === 'col') p.color[COMP_INDEX[comp]] = value;
    else if (prop === 'vel') (p.vel || (p.vel = [0, 0, 0]))[COMP_INDEX[comp]] = value;
    else p.scale[COMP_INDEX[comp]] = value;
  }
  rebuildPoints();
  refreshParticleTree();
}

// 通用分量值编辑（时间轴 [值] 输入框用）：按 id 前缀分发到粒子/组/函数对象，
// 在当前 tick 创建/更新关键帧（op 模式把绝对值换算为增量）
function editComponentValue(id, prop, comp, time, value) {
  pushUndo();
  const pr = compPr(prop, comp);
  let tr = findTrackByPr(pr, id);
  const defaultMode = ((id.startsWith('g:') || id.startsWith('f:')) && prop === 'pos') ? 'op' : 'set';
  if (!tr) {
    const base = defaultMode === 'op' ? 0 : baseValueFor(id, prop, comp);
    tr = { pr, m: defaultMode, ids: [id], kf: [[0, base, state.defaultEasing]] };
    state.tracks.push(tr);
  }
  let kf = tr.kf.find(k => k[0] === time);
  if (!kf) {
    const cur = targetComponentValue(id, prop, comp, time);
    kf = [time, cur, state.defaultEasing];
    tr.kf.push(kf);
    tr.kf.sort((a, b) => a[0] - b[0]);
  }
  kf[1] = tr.m === 'op' ? (value - baseValueFor(id, prop, comp)) : value;
  const p = getParticle(id);
  if (p && time === 0 && !isDerivedParticle(p)) {
    if (prop === 'pos') p.pos[COMP_INDEX[comp]] = value;
    else if (prop === 'col') p.color[COMP_INDEX[comp]] = value;
    else if (prop === 'vel') (p.vel || (p.vel = [0, 0, 0]))[COMP_INDEX[comp]] = value;
    else p.scale[COMP_INDEX[comp]] = value;
  }
  rebuildPoints();
  refreshParticleTree();
}

function updateKeyframeTime(id, pr, oldT, newT) {
  const tr = findTrackByPr(pr, id);
  const kf = tr && tr.kf.find(k => k[0] === oldT);
  if (!kf) return;
  pushUndo();
  kf[0] = Math.max(0, newT);
  tr.kf.sort((a, b) => a[0] - b[0]);
  rebuildPoints();
  refreshParticleTree();
}

function updateKeyframeEasing(id, pr, t, easing) {
  const tr = findTrackByPr(pr, id);
  const kf = tr && tr.kf.find(k => k[0] === t);
  if (!kf) return;
  pushUndo();
  kf[2] = easing;
  rebuildPoints();
}

function removeKeyframe(id, pr, t) {
  const tr = findTrackByPr(pr, id);
  if (!tr) return;
  pushUndo();
  tr.kf = tr.kf.filter(k => k[0] !== t);
  if (tr.kf.length === 0) state.tracks = state.tracks.filter(x => x !== tr);
  rebuildPoints();
  refreshParticleTree();
}

/* =========================================================================
 * 组 / 函数对象：向量级便捷写入（内部拆分量）
 * ======================================================================= */

function setGroupTrackValue(groupName, prop, mode, time, values) {
  const comps = TRACK_COMPS[prop];
  comps.forEach((comp, i) => setComponentKeyframe('g:' + groupName, prop, comp, time, values[i], mode));
  rebuildPoints();
  refreshParticleTree();
}

function setGroupTrackMode(groupName, prop, mode) {
  pushUndo();
  const comps = TRACK_COMPS[prop];
  for (const comp of comps) {
    const tr = findTrackByPr(compPr(prop, comp), 'g:' + groupName);
    if (tr) tr.m = mode;
  }
  rebuildPoints();
  refreshParticleTree();
}

function setFunctionTrackValue(fxId, prop, mode, time, values) {
  const comps = TRACK_COMPS[prop];
  comps.forEach((comp, i) => setComponentKeyframe('f:' + fxId, prop, comp, time, values[i], mode));
  rebuildPoints();
  refreshParticleTree();
}

function setFunctionTrackMode(fxId, prop, mode) {
  pushUndo();
  const comps = TRACK_COMPS[prop];
  for (const comp of comps) {
    const tr = findTrackByPr(compPr(prop, comp), 'f:' + fxId);
    if (tr) tr.m = mode;
  }
  rebuildPoints();
  refreshParticleTree();
}

/* =========================================================================
 * 粒子 / 组 操作
 * ======================================================================= */

function addParticle(base) {
  const p = Object.assign({ id: nextId(), color: [1, 1, 1, 1], scale: [1, 1, 1], glow: false, lightLevel: 0, pos: [0, 0, 0], vel: [0, 0, 0], life: 20 }, base);
  if (!Array.isArray(p.scale)) p.scale = [p.scale, p.scale, p.scale];
  state.particles.push(p);
  return p;
}

function autoGroup(ids) {
  if (!ids || ids.length === 0) return null;
  const name = nextGroupName();
  state.groups[name] = ids.slice();
  state.expandedParticles.delete('g:' + name); // 新建组默认折叠
  return name;
}

function removeGroupAndTracks(name) {
  const members = state.groups[name] || [];
  for (const id of members) {
    const idx = state.particles.findIndex(p => p.id === id);
    if (idx >= 0) state.particles.splice(idx, 1);
    state.tracks = state.tracks.filter(tr => !tr.ids.includes(id));
  }
  delete state.groups[name];
  delete state.groupUV[name];
  state.tracks = state.tracks.filter(tr => !tr.ids.includes('g:' + name));
  if (state.selectedGroup === name) state.selectedGroup = null;
  state.expandedParticles.delete('g:' + name);
  state.expandedProps.delete('g:' + name + '|@members');
  state.expandedProps.delete('g:' + name + '|@props');
}

function renameParticle(oldId, newId) {
  newId = (newId || '').trim();
  if (!newId || newId === oldId || getParticle(newId)) return false;
  pushUndo();
  const p = getParticle(oldId);
  p.id = newId;
  for (const g in state.groups) {
    const m = state.groups[g];
    const idx = m.indexOf(oldId);
    if (idx >= 0) m[idx] = newId;
  }
  for (const tr of state.tracks) {
    const idx = tr.ids.indexOf(oldId);
    if (idx >= 0) tr.ids[idx] = newId;
  }
  if (state.selected.has(oldId)) { state.selected.delete(oldId); state.selected.add(newId); }
  if (state.expandedParticles.has(oldId)) { state.expandedParticles.delete(oldId); state.expandedParticles.add(newId); }
  rebuildPoints();
  refreshParticleTree();
  return true;
}

function renameGroup(oldName, newName) {
  newName = (newName || '').trim();
  if (!newName || newName === oldName || newName in state.groups) return false;
  pushUndo();
  state.groups[newName] = state.groups[oldName];
  delete state.groups[oldName];
  for (const tr of state.tracks) {
    const idx = tr.ids.indexOf('g:' + oldName);
    if (idx >= 0) tr.ids[idx] = 'g:' + newName;
  }
  if (state.selectedGroup === oldName) state.selectedGroup = newName;
  if (state.expandedParticles.has('g:' + oldName)) { state.expandedParticles.delete('g:' + oldName); state.expandedParticles.add('g:' + newName); }
  refreshParticleTree();
  return true;
}

function moveParticlesToGroup(ids, groupName) {
  if (ids.length === 0) return;
  pushUndo();
  const idSet = new Set(ids);
  for (const g in state.groups) {
    if (g === groupName) continue;
    state.groups[g] = state.groups[g].filter(id => !idSet.has(id));
    if (state.groups[g].length === 0) delete state.groups[g];
  }
  const set = new Set(state.groups[groupName] || []);
  for (const id of ids) set.add(id);
  state.groups[groupName] = [...set];
  rebuildPoints();
  refreshParticleTree();
}

function removeParticlesFromGroups(ids) {
  if (ids.length === 0) return;
  pushUndo();
  for (const g in state.groups) {
    state.groups[g] = state.groups[g].filter(id => !ids.includes(id));
    if (state.groups[g].length === 0) delete state.groups[g];
  }
  rebuildPoints();
  refreshParticleTree();
}
