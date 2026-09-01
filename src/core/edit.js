/* =========================================================================
 * 编辑：分量级关键帧写入与粒子/组增删改
 * 职责：
 *   1) 关键帧创建/更新/删除（setComponentKeyframe / editComponentValue / removeKeyframe）
 *   2) 批量编辑热路径（setValuesAtTime / editParticles / editSelectionUniform）
 *   3) 粒子与组的基础操作（addParticle / autoGroup / rename / move / remove）
 * ======================================================================= */


import { TRACK_COMPS, PARTICLE_SCALE_COMPS, COMP_INDEX, compPr, state, getParticle, getFunction, getCamera, isDerivedParticle, nextId, nextGroupName, indexParticle } from './constants.js';
import { baseComponent, findTrackByPr, PR_TO_IDX, trVersion, rebuildPoints } from './animation.js';
import { groupCentroidValue } from '../ui/tree.js';
import { pushUndo } from '../state/undo.js';
import { commitFunctionRebuild } from '../ui/panels.js';
import { selectedGroupName } from '../interaction/interaction.js';

// 普通粒子某属性的可编辑分量列表（粒子 scl 仅 X/Y，无 Z）。
function particleComps(prop) { return prop === 'scl' ? PARTICLE_SCALE_COMPS : TRACK_COMPS[prop]; }

// 修改基础值（完整向量）
export function applyBaseValue(p, prop, values) {
  if (prop === 'pos') p.pos = values.slice(0, 3);
  else if (prop === 'col') p.color = values.slice(0, 4);
  else if (prop === 'vel') p.vel = values.slice(0, 3);
  else if (prop === 'scl') p.scale = [values[0], values[1], 1]; // 粒子缩放无 Z 分量
}

// 某 id（'p0' | 'g:g0' | 'f:fx0' | 'c:cam1'）在某分量的基础值
export function baseValueFor(id, prop, comp) {
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
  if (id.startsWith('c:')) {
    const cam = getCamera(id.slice(2));
    if (!cam) return 0;
    if (prop === 'fov') return cam.fov;
    if (prop === 'pos') return cam.pos[COMP_INDEX[comp]];
    if (prop === 'target') return (cam.target || [0, 0, 0])[COMP_INDEX[comp]];
    return 0;
  }
  const p = getParticle(id);
  return p ? baseComponent(p, prop, comp) : 0;
}

// 在关键帧数组中按 tick 插入/更新，保持按时间排序（返回该关键帧）。
export function upsertKeyframe(kfArr, tick, value, easing) {
  const kf = kfArr.find(k => k[0] === tick);
  if (kf) { kf[1] = value; return kf; }
  const nk = [tick, value, easing];
  kfArr.push(nk);
  kfArr.sort((a, b) => a[0] - b[0]);
  return nk;
}

// 写某 id 在某分量的关键帧（标量值）
export function setComponentKeyframe(id, prop, comp, time, value, mode) {
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
  upsertKeyframe(tr.kf, time, value, state.defaultEasing);
}

// 为多个粒子在同一时间写统一值（每分量独立轨道）
export function setValueAtTime(ids, prop, values) {
  const t = Math.round(state.time);
  const comps = particleComps(prop);
  for (const id of ids) {
    const p = getParticle(id);
    if (!p) continue;
    comps.forEach((comp, i) => setComponentKeyframe(id, prop, comp, t, values[i], 'set'));
    if (t === 0 && !isDerivedParticle(p)) applyBaseValue(p, prop, values);
  }
  rebuildPoints();

}

// 直接修改基础值（不创建关键帧），并同步 t=0 关键帧（若存在）
export function editBaseValue(ids, prop, values) {
  const comps = particleComps(prop);
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
export function setValuesAtTime(entries, prop) {
  const t = Math.round(state.time);
  const comps = particleComps(prop);
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

}

// 逐粒子编辑：捕获时写当前帧关键帧，否则改基础值
export function editParticles(entries, prop) {
  if (state.captureKeyframes) setValuesAtTime(entries, prop);
  else {
    for (const [id, values] of entries) editBaseValue([id], prop, values);
    rebuildPoints();
  }
}

// 统一值编辑（属性面板）：捕获关键帧时按 函数对象 > 组 > 粒子 优先级
export function editSelectionUniform(prop, values) {
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
      else if (prop === 'scl') { comps.forEach((comp, i) => setComponentKeyframe('f:' + fxId, 'scl', comp, 0, values[i], 'set')); rebuildPoints(); }
      return;
    }
    if (prop === 'pos') {
      comps.forEach((comp, i) => setComponentKeyframe('f:' + fxId, 'pos', comp, t, values[i] - fx.center[COMP_INDEX[comp]], 'op'));
    } else if (prop === 'scl') {
      comps.forEach((comp, i) => setComponentKeyframe('f:' + fxId, 'scl', comp, t, values[i], 'set'));
    }
    rebuildPoints();
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
    rebuildPoints();
    return;
  }

  // 3. 单个粒子
  const ids = [...state.selected];
  if (ids.length === 0) return;
  if (ids.some(id => isDerivedParticle(getParticle(id)))) return; // 派生粒子基础属性只读
  if (!state.captureKeyframes) { editBaseValue(ids, prop, values); rebuildPoints(); return; }
  setValueAtTime(ids, prop, values);
}

// 统一写旋转类属性（rot 公转 / spin 自转 / center 公转中心）到当前选中目标。
// 与 gizmo 旋转一致：开启捕获关键帧时写当前 tick，否则写 0t（基线）。
export function editSelectionRotationUniform(prop, values) {
  const t = state.captureKeyframes ? Math.round(state.time) : 0;
  const comps = TRACK_COMPS[prop] || ['x', 'y', 'z'];
  const fxId = state.selectedFunction;
  const gname = selectedGroupName();
  const targets = fxId ? ['f:' + fxId] : gname ? ['g:' + gname] : [...state.selected];
  for (const id of targets) {
    comps.forEach((comp, i) => setComponentKeyframe(id, prop, comp, t, values[i], 'set'));
  }
  rebuildPoints();
}

// 通用分量值编辑（时间轴 [值] 输入框用）：按 id 前缀分发到粒子/组/函数对象/摄像机，
// 在当前 tick 创建/更新关键帧（op 模式把绝对值换算为增量）
export function editComponentValue(id, prop, comp, time, value) {
  pushUndo();
  const pr = compPr(prop, comp);
  let tr = findTrackByPr(pr, id);
  const defaultMode = ((id.startsWith('g:') || id.startsWith('f:')) && prop === 'pos') ? 'op' : 'set';
  if (!tr) {
    const base = defaultMode === 'op' ? 0 : baseValueFor(id, prop, comp);
    tr = { pr, m: defaultMode, ids: [id], kf: [[0, base, state.defaultEasing]] };
    state.tracks.push(tr);
  }
  upsertKeyframe(tr.kf, time, tr.m === 'op' ? (value - baseValueFor(id, prop, comp)) : value, state.defaultEasing);
  const p = getParticle(id);
  if (p && time === 0 && !isDerivedParticle(p)) {
    if (prop === 'pos') p.pos[COMP_INDEX[comp]] = value;
    else if (prop === 'col') p.color[COMP_INDEX[comp]] = value;
    else if (prop === 'vel') (p.vel || (p.vel = [0, 0, 0]))[COMP_INDEX[comp]] = value;
    else p.scale[COMP_INDEX[comp]] = value;
  } else if (id.startsWith('c:') && time === 0) {
    const cam = getCamera(id.slice(2));
    if (cam) {
      if (prop === 'pos') cam.pos[COMP_INDEX[comp]] = value;
      else if (prop === 'target') (cam.target || (cam.target = [0, 0, 0]))[COMP_INDEX[comp]] = value;
      else if (prop === 'fov') cam.fov = value;
    }
  }
  rebuildPoints();

}

export function removeKeyframe(id, pr, t) {
  const tr = findTrackByPr(pr, id);
  if (!tr) return;
  pushUndo();
  tr.kf = tr.kf.filter(k => k[0] !== t);
  if (tr.kf.length === 0) state.tracks = state.tracks.filter(x => x !== tr);
  rebuildPoints();

}

/* =========================================================================
 * 组 / 函数对象：向量级便捷写入（内部拆分量）
 * ======================================================================= */

function setTrackValues(prefix, prop, mode, time, values) {
  const comps = TRACK_COMPS[prop];
  comps.forEach((comp, i) => setComponentKeyframe(prefix, prop, comp, time, values[i], mode));
  rebuildPoints();

}

export function setGroupTrackValue(groupName, prop, mode, time, values) {
  setTrackValues('g:' + groupName, prop, mode, time, values);
}

export function setFunctionTrackValue(fxId, prop, mode, time, values) {
  setTrackValues('f:' + fxId, prop, mode, time, values);
}

/* =========================================================================
 * 粒子 / 组 操作
 * ======================================================================= */

export function addParticle(base) {
  const p = Object.assign({ id: nextId(), color: [1, 1, 1, 1], scale: [1, 1, 1], glow: false, lightLevel: 0, pos: [0, 0, 0], vel: [0, 0, 0], life: 20 }, base);
  if (!Array.isArray(p.scale)) p.scale = [p.scale, p.scale, p.scale];
  state.particles.push(p);
  indexParticle(p);
  return p;
}

export function autoGroup(ids) {
  if (!ids || ids.length === 0) return null;
  const name = nextGroupName();
  state.groups[name] = ids.slice();
  state.expandedParticles.delete('g:' + name); // 新建组默认折叠
  return name;
}

export function removeGroupAndTracks(name) {
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

export function renameParticle(oldId, newId) {
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

  return true;
}

export function renameGroup(oldName, newName) {
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
  // 组名键控的附属状态一并迁移（组级贴图/自转空间/公转空间）
  if (oldName in state.groupUV) { state.groupUV[newName] = state.groupUV[oldName]; delete state.groupUV[oldName]; }
  if (oldName in state.groupSpinSpace) { state.groupSpinSpace[newName] = state.groupSpinSpace[oldName]; delete state.groupSpinSpace[oldName]; }
  if (oldName in state.groupRotSpace) { state.groupRotSpace[newName] = state.groupRotSpace[oldName]; delete state.groupRotSpace[oldName]; }
  rebuildPoints();
  return true;
}

export function moveParticlesToGroup(ids, groupName) {
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

}

export function removeParticlesFromGroups(ids) {
  if (ids.length === 0) return;
  pushUndo();
  for (const g in state.groups) {
    state.groups[g] = state.groups[g].filter(id => !ids.includes(id));
    if (state.groups[g].length === 0) delete state.groups[g];
  }
  rebuildPoints();

}
