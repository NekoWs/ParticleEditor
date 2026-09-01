/* =========================================================================
 * 动画状态查询（分量级数据模型）
 * 数据模型：分量级轨道（pr：pos.x / ... / col.a / scl），kf 值为标量。
 * 本模块只做求值与索引缓存，不接触 DOM / THREE 渲染对象；渲染缓冲见 render.js。
 * ======================================================================= */

import { COMP_INDEX, compPr, DEG2RAD, RAD2DEG, state, getParticle, getFunction, particleIndexCache, setParticleIndex, setFunctionIndex, setPlainParticles } from './constants.js';
import { easeVal, FUNC_IMPL, matMat, vec3 } from './easing.js';
import { evaluateParticleAt } from './generators.js';
export { getFxFrameAuto, evalFxParticleInto } from './generators.js';
import { groupCentroidValue } from '../ui/tree.js';
import { rotateVector } from '../interaction/interaction.js';


// 粒子基础分量值（无轨道）
export function baseComponent(p, prop, comp) {
  if (prop === 'pos') return p.pos[COMP_INDEX[comp]];
  if (prop === 'col') return p.color[COMP_INDEX[comp]];
  if (prop === 'vel') return (p.vel || [0, 0, 0])[COMP_INDEX[comp]];
  if (prop === 'scl') return (p.scale || [1, 1, 1])[COMP_INDEX[comp]];
  return 0;
}

// 粒子完整基础向量
export function baseValue(p, prop) {
  if (prop === 'pos') return p.pos.slice(0, 3);
  if (prop === 'col') return p.color.slice(0, 4);
  if (prop === 'vel') return (p.vel || [0, 0, 0]).slice(0, 3);
  if (prop === 'rot' || prop === 'spin' || prop === 'center') return [0, 0, 0];
  const s = p.scale || [1, 1, 1];
  return [s[0], s[1], s[2]];
}

// 零向量（按属性）
export function zeroArray(prop) {
  if (prop === 'pos' || prop === 'rot' || prop === 'spin' || prop === 'center' || prop === 'vel' || prop === 'scl') return [0, 0, 0];
  if (prop === 'col') return [0, 0, 0, 0];
  return [0];
}

// 轨道插值（标量）：b[2] 缓动语义（后一关键帧控制前一段）
// 带每轨道缓存：同一轨道在同一 T 下的值固定（组/函数轨道被多粒子共享时大幅加速）
export function trackValueAt(tr, T, fallback) {
  const kfs = tr.kf;
  if (!kfs || kfs.length === 0) return fallback;
  if (tr._t === T) return tr._v;
  let result;
  if (T <= kfs[0][0]) result = kfs[0][1];
  else if (T >= kfs[kfs.length - 1][0]) result = kfs[kfs.length - 1][1];
  else {
    for (let i = 0; i < kfs.length - 1; i++) {
      const a = kfs[i], b = kfs[i + 1];
      if (T >= a[0] && T <= b[0]) {
        const dur = b[0] - a[0];
        const e = easeVal(dur === 0 ? 1 : (T - a[0]) / dur, b[2]);
        result = a[1] + (b[1] - a[1]) * e;
        break;
      }
    }
    if (result === undefined) return fallback; // 异常（kf 无序）：不缓存
  }
  tr._t = T;
  tr._v = result;
  return result;
}

// ---- 求值索引缓存（rebuildPoints 每次重建，避免 O(N) / O(N·M) 线性扫描） ----
export let trackIndexCache = null;        // Map: pr -> Map(id -> track)
export let opTracksCache = null;          // Array<track>（op 模式轨道）
export let groupSetCache = null;          // Map: gname -> Set<id>
export let groupMemberIndexCache = null;  // Map: particleId -> Set<gname>
export let groupCentroidPosCache = null;  // Map: gname -> [x,y,z]
export let groupOpDeltaCache = null;      // Map: gname -> Map(pr -> delta)：op 增量预计算（per 组）
export let fxOpDeltaCache = null;         // Map: fxId -> Map(pr -> delta)：op 增量预计算（per 函数对象）
export let groupXformCache = null;        // Map: gname -> { rotTr, setTr, op, pivot }：组变换预计算（组-only 粒子快路径）
export let fxSclTrackCache = null;        // Map: fxId -> scl 轨道（函数对象整体缩放，pr='scl'）

// 10 个分量轨道 pr 顺序（组变换预计算用，与 positions/colors 写入一致）
export const TRACK_COMP_ORDER = ['pos.x', 'pos.y', 'pos.z', 'col.r', 'col.g', 'col.b', 'col.a', 'scl.x', 'scl.y', 'scl.z'];
// pr -> 粒子分量轨道槽下标（p._tr 数组，13 槽：10 分量 + vel 3）
export const PR_TO_IDX = {
  'pos.x': 0, 'pos.y': 1, 'pos.z': 2,
  'col.r': 3, 'col.g': 4, 'col.b': 5, 'col.a': 6,
  'scl.x': 7, 'scl.y': 8, 'scl.z': 9,
  'vel.x': 10, 'vel.y': 11, 'vel.z': 12,
};

export let trVersion = 0; // 每次 buildParticleIndex 递增，配合 p._trVersion 惰性失效 p._tr
export function buildParticleIndex() {
  const map = new Map();
  const plain = [];
  for (const p of state.particles) {
    map.set(p.id, p);
    if (!p.fx) plain.push(p);
  }
  setParticleIndex(map);
  setPlainParticles(plain);
  const fm = new Map();
  for (const f of state.functions) fm.set(f.id, f);
  setFunctionIndex(fm);
  trVersion++;
}

export function buildTrackIndex() {
  const opTracks = [];
  const pidx = particleIndexCache;
  const tracks = state.tracks;
  for (let i = 0; i < tracks.length; i++) {
    const tr = tracks[i];
    tr._t = undefined; // 清空每轨道求值缓存（轨道内容可能已变，见 trackValueAt）
    if (tr.ids.length === 1) {
      const id = tr.ids[0];
      const c0 = id.charCodeAt(0);
      if (c0 !== 103 && c0 !== 102 && c0 !== 99) { // 排除 'g:' 组 / 'f:' 函数 / 'c:' 摄像机轨道（普通/派生粒子轨道）
        let idx = tr._idx;
        if (idx === undefined) { idx = PR_TO_IDX[tr.pr]; tr._idx = (idx === undefined) ? -1 : idx; }
        if (idx >= 0) {
          const p = pidx.get(id);
          if (p) {
            if (p._trVersion !== trVersion) { p._tr = new Array(13); p._trVersion = trVersion; }
            p._tr[idx] = tr;
          }
        }
      }
    }
    if (tr.m === 'op') opTracks.push(tr);
  }
  trackIndexCache = null; // 失效：findTrackByPr 按需惰性重建（见 buildTrackIndexMap）
  opTracksCache = opTracks;
}

// 惰性重建 pr -> id -> track 两级索引（仅在编辑类操作调用 findTrackByPr 时按需构建）
export function buildTrackIndexMap() {
  const map = new Map();
  for (const tr of state.tracks) {
    if (tr.ids.length === 1) {
      let byId = map.get(tr.pr);
      if (!byId) { byId = new Map(); map.set(tr.pr, byId); }
      byId.set(tr.ids[0], tr);
    }
  }
  trackIndexCache = map;
}

// 组成员索引（particleId -> 所属组集合）+ 组 Set + 组质心缓存
export function buildGroupIndex() {
  const memberIdx = new Map();
  const sets = new Map();
  const centroids = new Map();
  for (const [gname, members] of Object.entries(state.groups)) {
    const s = new Set(members);
    sets.set(gname, s);
    for (const id of members) {
      let gs = memberIdx.get(id);
      if (!gs) { gs = new Set(); memberIdx.set(id, gs); }
      gs.add(gname);
    }
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const id of members) {
      const m = getParticle(id);
      if (!m) continue;
      sx += m.pos[0]; sy += m.pos[1]; sz += m.pos[2]; n++;
    }
    if (n > 0) centroids.set(gname, [sx / n, sy / n, sz / n]);
  }
  groupMemberIndexCache = memberIdx;
  groupSetCache = sets;
  groupCentroidPosCache = centroids;
}

// 按 pr + id 精确查找轨道（O(1)；索引失效时惰性重建）
export function findTrackByPr(pr, id) {
  if (!trackIndexCache) buildTrackIndexMap();
  const byId = trackIndexCache.get(pr);
  return byId ? (byId.get(id) || null) : null;
}

// 某 id 在某分量的 set 轨道（优先级：自身 > 组 > 函数对象）
export function findSetTrackFor(id, prop, comp) {
  const pr = compPr(prop, comp);
  const own = findTrackByPr(pr, id);
  if (own && own.m !== 'op') return own;
  const gs = groupMemberIndexCache && groupMemberIndexCache.get(id);
  if (gs && prop !== 'scl' && prop !== 'rot' && prop !== 'spin' && prop !== 'center') {
    // 组 scl 只做成员位置的整体缩放，不覆盖粒子大小（粒子 scl 仍可取函数对象/自身轨道）；
    // 旋转类（rot/spin/center）不继承组/函数对象轨道，粒子行只显示自身值。
    for (const gname of gs) {
      const tr = findTrackByPr(pr, 'g:' + gname);
      if (tr && tr.m !== 'op') return tr;
    }
  }
  const p = getParticle(id);
  if (p && p.fx && prop !== 'rot' && prop !== 'spin' && prop !== 'center') {
    const tr = findTrackByPr(pr, 'f:' + p.fx);
    if (tr && tr.m !== 'op') return tr;
  }
  return null;
}

// 预计算 op 轨道在时间 T 的增量（按组/函数对象聚合到分量 pr），供 compOpDelta 直接查表，
// 避免每个粒子重复遍历 opTracksCache 与 trackValueAt。
export function buildOpDeltaCache(T) {
  const gMap = new Map();
  const fMap = new Map();
  for (const tr of opTracksCache) {
    if (tr.kf.length === 0) continue;
    const v = trackValueAt(tr, T, 0);
    for (const id of tr.ids) {
      if (id.startsWith('g:')) {
        const gn = id.slice(2);
        let m = gMap.get(gn);
        if (!m) { m = new Map(); gMap.set(gn, m); }
        m.set(tr.pr, (m.get(tr.pr) || 0) + v);
      } else if (id.startsWith('f:')) {
        const fid = id.slice(2);
        let m = fMap.get(fid);
        if (!m) { m = new Map(); fMap.set(fid, m); }
        m.set(tr.pr, (m.get(tr.pr) || 0) + v);
      }
    }
  }
  groupOpDeltaCache = gMap;
  fxOpDeltaCache = fMap;
}

// 预计算每个组的变换（rot 轨道引用 / set 轨道引用 / op 增量数组 / 质心），
// 供组-only 粒子（无自身轨道、单组）走快路径，绕过 findSetTrackFor 的重复 Map 查询。
export function buildGroupXforms(T) {
  const xforms = new Map();
  for (const gname of Object.keys(state.groups)) {
    const setTr = TRACK_COMP_ORDER.map(pr => {
      const tr = findTrackByPr(pr, 'g:' + gname);
      return (tr && tr.m !== 'op' && tr.kf.length) ? tr : null;
    });
    const velTr = ['vel.x', 'vel.y', 'vel.z'].map(pr => {
      const tr = findTrackByPr(pr, 'g:' + gname);
      return (tr && tr.kf.length) ? tr : null;
    });
    // 组自转/公转：预计算复合旋转矩阵。自转在前，局部公转时公转轴跟随自转姿态。
    const spin0 = (() => { const tr = findTrackByPr('spin.x', 'g:' + gname); return (tr && tr.m !== 'op' && tr.kf.length) ? trackValueAt(tr, T, 0) : 0; })();
    const spin1 = (() => { const tr = findTrackByPr('spin.y', 'g:' + gname); return (tr && tr.m !== 'op' && tr.kf.length) ? trackValueAt(tr, T, 0) : 0; })();
    const spin2 = (() => { const tr = findTrackByPr('spin.z', 'g:' + gname); return (tr && tr.m !== 'op' && tr.kf.length) ? trackValueAt(tr, T, 0) : 0; })();
    const spinSpace = (state.groupSpinSpace && state.groupSpinSpace[gname] === 'local') ? 'local' : 'world';
    let spinMat = null;
    if (spin0 !== 0 || spin1 !== 0 || spin2 !== 0) {
      const M = spinMatrix([spin0, spin1, spin2], spinSpace);
      spinMat = [M.m[0][0], M.m[0][1], M.m[0][2], M.m[1][0], M.m[1][1], M.m[1][2], M.m[2][0], M.m[2][1], M.m[2][2]];
    }
    const rot0 = (() => { const tr = findTrackByPr('rot.x', 'g:' + gname); return (tr && tr.m !== 'op' && tr.kf.length) ? trackValueAt(tr, T, 0) : 0; })();
    const rot1 = (() => { const tr = findTrackByPr('rot.y', 'g:' + gname); return (tr && tr.m !== 'op' && tr.kf.length) ? trackValueAt(tr, T, 0) : 0; })();
    const rot2 = (() => { const tr = findTrackByPr('rot.z', 'g:' + gname); return (tr && tr.m !== 'op' && tr.kf.length) ? trackValueAt(tr, T, 0) : 0; })();
    const rotSpace = (state.groupRotSpace && state.groupRotSpace[gname] === 'local') ? 'local' : 'world';
    let orbitMat = null;
    if (rot0 !== 0 || rot1 !== 0 || rot2 !== 0) {
      const M = rotSpace === 'local'
        ? orbitLocalMatrix([rot0, rot1, rot2], [spin0, spin1, spin2], spinSpace)
        : spinMatrix([rot0, rot1, rot2], 'world');
      orbitMat = [M.m[0][0], M.m[0][1], M.m[0][2], M.m[1][0], M.m[1][1], M.m[1][2], M.m[2][0], M.m[2][1], M.m[2][2]];
    }
    const orbitCenter = [
      (() => { const tr = findTrackByPr('center.x', 'g:' + gname); return (tr && tr.m !== 'op' && tr.kf.length) ? trackValueAt(tr, T, 0) : 0; })(),
      (() => { const tr = findTrackByPr('center.y', 'g:' + gname); return (tr && tr.m !== 'op' && tr.kf.length) ? trackValueAt(tr, T, 0) : 0; })(),
      (() => { const tr = findTrackByPr('center.z', 'g:' + gname); return (tr && tr.m !== 'op' && tr.kf.length) ? trackValueAt(tr, T, 0) : 0; })(),
    ];
    const opMap = groupOpDeltaCache ? groupOpDeltaCache.get(gname) : null;
    const op = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    if (opMap) for (let i = 0; i < 10; i++) op[i] = opMap.get(TRACK_COMP_ORDER[i]) || 0;
    // 组整体缩放（位置级）：set scl 覆盖默认 1，op scl 在 1 上叠加增量。
    const scale = [
      setTr[7] ? trackValueAt(setTr[7], T, 1) : 1,
      setTr[8] ? trackValueAt(setTr[8], T, 1) : 1,
      setTr[9] ? trackValueAt(setTr[9], T, 1) : 1,
    ];
    if (opMap) {
      scale[0] += opMap.get('scl.x') || 0;
      scale[1] += opMap.get('scl.y') || 0;
      scale[2] += opMap.get('scl.z') || 0;
    }
    xforms.set(gname, {
      setTr, velTr, op, spinMat, orbitMat, orbitCenter, pivot: groupCentroidPosCache.get(gname),
      scale, hasScale: scale[0] !== 1 || scale[1] !== 1 || scale[2] !== 1,
      hasSet: setTr.some(t => t !== null), hasSpin: spinMat !== null, hasRot: orbitMat !== null,
      hasOp: op.some(v => v !== 0), hasVel: velTr.some(t => t !== null),
    });
  }
  groupXformCache = xforms;
}

// 预计算函数对象的整体 scl 轨道（pr 为 scl.x/scl.y/scl.z），供 currentVisualDerived 快速路径查询
export function buildFxSclTrackCache() {
  const map = new Map();
  for (const tr of state.tracks) {
    if (tr.ids.length === 1 && tr.ids[0].charCodeAt(0) === 102 && tr.m !== 'op' && tr.kf.length) {
      const fid = tr.ids[0].slice(2);
      let arr = map.get(fid);
      if (!arr) { arr = [null, null, null]; map.set(fid, arr); }
      if (tr.pr === 'scl.x') arr[0] = tr;
      else if (tr.pr === 'scl.y') arr[1] = tr;
      else if (tr.pr === 'scl.z') arr[2] = tr;
    }
  }
  fxSclTrackCache = map;
}

// 组/函数对象在某分量的 op 增量（标量累加）
export function compOpDelta(p, prop, comp, T) {
  const pr = compPr(prop, comp);
  let delta = 0;
  if (groupOpDeltaCache) {
    const gs = groupMemberIndexCache && groupMemberIndexCache.get(p.id);
    if (gs) {
      for (const gname of gs) {
        const m = groupOpDeltaCache.get(gname);
        if (m) { const v = m.get(pr); if (v) delta += v; }
      }
    }
    if (p.fx) {
      const m = fxOpDeltaCache.get(p.fx);
      if (m) { const v = m.get(pr); if (v) delta += v; }
    }
    return delta;
  }
  for (const tr of opTracksCache) {
    if (tr.pr !== pr || tr.kf.length === 0) continue;
    for (const id of tr.ids) {
      if (id.startsWith('g:')) {
        const members = groupSetCache.get(id.slice(2));
        if (members && members.has(p.id)) delta += trackValueAt(tr, T, 0);
      } else if (id.startsWith('f:') && p.fx === id.slice(2)) {
        delta += trackValueAt(tr, T, 0);
      }
    }
  }
  return delta;
}

// 仅组 op 增量（标量累加；与 compOpDelta 的组部分一致）
export function compGroupOpDelta(p, prop, comp, T) {
  const pr = compPr(prop, comp);
  let delta = 0;
  if (groupOpDeltaCache) {
    const gs = groupMemberIndexCache && groupMemberIndexCache.get(p.id);
    if (gs) {
      for (const gname of gs) {
        const m = groupOpDeltaCache.get(gname);
        if (m) { const v = m.get(pr); if (v) delta += v; }
      }
    }
    return delta;
  }
  for (const tr of opTracksCache) {
    if (tr.pr !== pr || tr.kf.length === 0) continue;
    for (const id of tr.ids) {
      if (!id.startsWith('g:')) continue;
      const members = groupSetCache.get(id.slice(2));
      if (members && members.has(p.id)) delta += trackValueAt(tr, T, 0);
    }
  }
  return delta;
}

// 仅函数对象 op 增量（标量累加；与 compOpDelta 的 fx 部分一致）
export function compFxOpDelta(p, prop, comp, T) {
  const pr = compPr(prop, comp);
  if (!p.fx) return 0;
  let delta = 0;
  if (fxOpDeltaCache) {
    const m = fxOpDeltaCache.get(p.fx);
    if (m) { const v = m.get(pr); if (v) delta += v; }
    return delta;
  }
  for (const tr of opTracksCache) {
    if (tr.pr !== pr || tr.kf.length === 0) continue;
    for (const id of tr.ids) {
      if (id.startsWith('f:') && p.fx === id.slice(2)) delta += trackValueAt(tr, T, 0);
    }
  }
  return delta;
}

// 某 id（'g:name' | 'f:fxId' | 'c:camId'）某三分量属性在 T 时刻的向量（无轨道分量取 0）。
function trackVec3At(prop, id, T) {
  return ['x', 'y', 'z'].map(c => {
    const tr = findTrackByPr(prop + '.' + c, id);
    return tr ? trackValueAt(tr, T, 0) : 0;
  });
}

// 某 id 的 rot（公转）向量（三个分量，度）
export function rotVectorAt(id, T) { return trackVec3At('rot', id, T); }

// 某 id 的自转向量（三个分量，度）
export function spinVectorAt(id, T) { return trackVec3At('spin', id, T); }

// 某 id 的公转中心（世界坐标；无 center 轨道时默认世界原点）
export function orbitCenterAt(id, T) { return trackVec3At('center', id, T); }

// 绕 pivot 按欧拉角 XYZ（度）旋转一个点。
export function rotatePointAround(value, pivot, rotDeg) {
  let r = [value[0] - pivot[0], value[1] - pivot[1], value[2] - pivot[2]];
  r = rotateVector(r, [1, 0, 0], rotDeg[0] * DEG2RAD);
  r = rotateVector(r, [0, 1, 0], rotDeg[1] * DEG2RAD);
  r = rotateVector(r, [0, 0, 1], rotDeg[2] * DEG2RAD);
  return [pivot[0] + r[0], pivot[1] + r[1], pivot[2] + r[2]];
}

// 把 3x3 矩阵（{m:[[...]]}）应用到数组向量 [x,y,z]。
export function mat3VecArray(M, v) {
  const m = M.m;
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

// 自转旋转矩阵。world = extrinsic XYZ（Rz·Ry·Rx）；local = intrinsic XYZ（Rx·Ry·Rz）。
export function spinMatrix(rotDeg, space) {
  const rx = FUNC_IMPL.rotX(rotDeg[0] * DEG2RAD);
  const ry = FUNC_IMPL.rotY(rotDeg[1] * DEG2RAD);
  const rz = FUNC_IMPL.rotZ(rotDeg[2] * DEG2RAD);
  return space === 'local' ? matMat(matMat(rx, ry), rz) : matMat(matMat(rz, ry), rx);
}

// 用矩阵绕 pivot 旋转一个点。
export function rotatePointByMatrix(value, pivot, M) {
  const r = [value[0] - pivot[0], value[1] - pivot[1], value[2] - pivot[2]];
  const q = mat3VecArray(M, r);
  return [pivot[0] + q[0], pivot[1] + q[1], pivot[2] + q[2]];
}

// intrinsic XYZ 旋转矩阵 → 欧拉角（度）。
export function eulerFromSpinMatrix(M) {
  const m = M.m;
  const b = Math.asin(Math.max(-1, Math.min(1, m[0][2])));
  const cb = Math.cos(b);
  let a, c;
  if (Math.abs(cb) > 1e-6) {
    a = Math.atan2(-m[1][2], m[2][2]);
    c = Math.atan2(-m[0][1], m[0][0]);
  } else {
    // gimbal lock：b = ±90°，令 a = 0，从矩阵反解 c
    a = 0;
    c = Math.atan2(m[1][0], m[1][1]);
  }
  return [a * RAD2DEG, b * RAD2DEG, c * RAD2DEG];
}

// 在现有局部自转基础上绕局部轴 axis（'X'|'Y'|'Z'）旋转 angle（弧度），返回新欧拉（度）。
export function applyLocalSpinRotation(baseDeg, axis, angle) {
  const M = spinMatrix(baseDeg, 'local');
  const R = axis === 'X' ? FUNC_IMPL.rotX(angle) : axis === 'Y' ? FUNC_IMPL.rotY(angle) : FUNC_IMPL.rotZ(angle);
  return eulerFromSpinMatrix(matMat(M, R));
}

// 绕任意局部轴（数组单位向量）旋转 angle（弧度）的局部自转合成。
export function applyLocalSpinRotationVec(baseDeg, axisVec, angle) {
  const M = spinMatrix(baseDeg, 'local');
  const R = FUNC_IMPL.rotAxis(vec3(axisVec[0], axisVec[1], axisVec[2]), angle);
  return eulerFromSpinMatrix(matMat(M, R));
}

// 3x3 矩阵转置。
function mat3Transpose(M) {
  const m = M.m;
  return { m: [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ] };
}

// 局部公转的世界旋转矩阵：M = M_spin · M_localOrbit · M_spinᵀ。
// 即公转轴跟随对象自转后的姿态（局部轴）。
export function orbitLocalMatrix(rotDeg, spinDeg, spinSpace) {
  const Ms = spinMatrix(spinDeg, spinSpace);
  const Mo = spinMatrix(rotDeg, 'local');
  return matMat(matMat(Ms, Mo), mat3Transpose(Ms));
}

// 局部公转合成：在现有局部公转基础上绕局部轴 axis 旋转 angle（弧度）。
// 与自转不同，公转拖拽是在局部帧左乘增量（等价世界轴旋转后写回局部公转欧拉）。
export function applyLocalOrbitRotation(baseRot, axis, angle) {
  const M = spinMatrix(baseRot, 'local');
  const R = axis === 'X' ? FUNC_IMPL.rotX(angle) : axis === 'Y' ? FUNC_IMPL.rotY(angle) : FUNC_IMPL.rotZ(angle);
  return eulerFromSpinMatrix(matMat(R, M));
}

export function applyLocalOrbitRotationVec(baseRot, axisVec, angle) {
  const M = spinMatrix(baseRot, 'local');
  const R = FUNC_IMPL.rotAxis(vec3(axisVec[0], axisVec[1], axisVec[2]), angle);
  return eulerFromSpinMatrix(matMat(R, M));
}

// 组变换 pivot（优先索引缓存，回退到质心重算）
export function groupPivot(gname) {
  return (groupCentroidPosCache && groupCentroidPosCache.get(gname)) || groupCentroidValue(gname, 'pos');
}

// 普通粒子的自身公转（只有 rot，无自转）：绕粒子自己的 center 轨道旋转。
export function applyParticleOrbit(p, value, T) {
  if (p.fx) return value; // 派生粒子没有独立公转轨道
  const rot = rotVectorAt(p.id, T);
  if (rot[0] === 0 && rot[1] === 0 && rot[2] === 0) return value;
  return rotatePointAround(value, orbitCenterAt(p.id, T), rot);
}

// 自转：组绕自身质心、函数对象绕自身 center 旋转（spin 轨道）。
// 空间：'world'（世界轴，缺省）或 'local'（局部轴，intrinsic XYZ）。
export function applySelfRotation(p, value, T) {
  const gs = groupMemberIndexCache && groupMemberIndexCache.get(p.id);
  if (gs) {
    for (const gname of gs) {
      const spin = spinVectorAt('g:' + gname, T);
      if (spin[0] === 0 && spin[1] === 0 && spin[2] === 0) continue;
      const space = (state.groupSpinSpace && state.groupSpinSpace[gname] === 'local') ? 'local' : 'world';
      return rotatePointByMatrix(value, groupPivot(gname), spinMatrix(spin, space));
    }
  }
  if (p.fx) {
    const spin = spinVectorAt('f:' + p.fx, T);
    if (spin[0] === 0 && spin[1] === 0 && spin[2] === 0) return value;
    const fx = getFunction(p.fx);
    const space = (fx && fx.spinSpace === 'local') ? 'local' : 'world';
    return rotatePointByMatrix(value, fx ? fx.center.slice() : [0, 0, 0], spinMatrix(spin, space));
  }
  return value;
}

// 公转：组/函数对象绕各自 center 轨道旋转（rot 轨道）。
export function applyOrbitRotation(p, value, T) {
  const gs = groupMemberIndexCache && groupMemberIndexCache.get(p.id);
  if (gs) {
    for (const gname of gs) {
      const rot = rotVectorAt('g:' + gname, T);
      if (rot[0] === 0 && rot[1] === 0 && rot[2] === 0) continue;
      const pivot = orbitCenterAt('g:' + gname, T);
      const space = (state.groupRotSpace && state.groupRotSpace[gname] === 'local') ? 'local' : 'world';
      if (space === 'local') {
        const spin = spinVectorAt('g:' + gname, T);
        const spinSpace = (state.groupSpinSpace && state.groupSpinSpace[gname] === 'local') ? 'local' : 'world';
        return rotatePointByMatrix(value, pivot, orbitLocalMatrix(rot, spin, spinSpace));
      }
      return rotatePointAround(value, pivot, rot);
    }
  }
  if (p.fx) {
    const rot = rotVectorAt('f:' + p.fx, T);
    if (rot[0] === 0 && rot[1] === 0 && rot[2] === 0) return value;
    const fx = getFunction(p.fx);
    const pivot = orbitCenterAt('f:' + p.fx, T);
    const space = (fx && fx.rotSpace === 'local') ? 'local' : 'world';
    if (space === 'local') {
      const spin = spinVectorAt('f:' + p.fx, T);
      const spinSpace = (fx && fx.spinSpace === 'local') ? 'local' : 'world';
      return rotatePointByMatrix(value, pivot, orbitLocalMatrix(rot, spin, spinSpace));
    }
    return rotatePointAround(value, pivot, rot);
  }
  return value;
}

// 组整体缩放向量（作用于成员相对组中心的偏移，而非粒子大小）。默认 [1,1,1]。
export function groupScaleAt(gname, T) {
  return ['x', 'y', 'z'].map(c => {
    const tr = findTrackByPr('scl.' + c, 'g:' + gname);
    if (tr && tr.kf.length > 0) {
      if (tr.m === 'op') return 1 + trackValueAt(tr, T, 0);
      return trackValueAt(tr, T, 1);
    }
    return 1;
  });
}

// 把粒子位置按所属组的整体缩放变换（围绕组质心，使用相对坐标）。
export function applyGroupScale(p, value, T) {
  const gs = groupMemberIndexCache && groupMemberIndexCache.get(p.id);
  if (gs) {
    for (const gname of gs) {
      const s = groupScaleAt(gname, T);
      if (s[0] === 1 && s[1] === 1 && s[2] === 1) continue;
      const pivot = groupPivot(gname);
      return [
        pivot[0] + (value[0] - pivot[0]) * s[0],
        pivot[1] + (value[1] - pivot[1]) * s[1],
        pivot[2] + (value[2] - pivot[2]) * s[2],
      ];
    }
  }
  return value;
}

// 粒子位置：set 覆盖 → 组整体缩放 → 粒子公转 → 自转 → 公转 → op 增量
export function particlePosition(p, T) {
  let pos = ['x', 'y', 'z'].map(c => {
    let v = baseComponent(p, 'pos', c);
    const tr = findSetTrackFor(p.id, 'pos', c);
    if (tr && tr.kf.length > 0) v = trackValueAt(tr, T, v);
    return v;
  });
  pos = applyGroupScale(p, pos, T);
  pos = applyParticleOrbit(p, pos, T);
  pos = applySelfRotation(p, pos, T);
  pos = applyOrbitRotation(p, pos, T);
  pos = pos.map((v, i) => v + compOpDelta(p, 'pos', ['x', 'y', 'z'][i], T));
  return pos;
}

// 粒子某分量值：基础 → set 覆盖 → op 增量
// 注意：scl 不走 compOpDelta——组 scl op 只作用于成员位置的整体缩放，不缩放粒子大小。
export function componentValueAt(p, prop, comp, T) {
  let v = baseComponent(p, prop, comp);
  const tr = findSetTrackFor(p.id, prop, comp);
  if (tr && tr.kf.length > 0) v = trackValueAt(tr, T, v);
  if (prop !== 'scl') v += compOpDelta(p, prop, comp, T);
  return v;
}

// 粒子某属性完整向量（分量级拼装）
export function particleValueAt(p, prop, T) {
  if (prop === 'pos') return particlePosition(p, T);
  if (prop === 'col') return ['r', 'g', 'b', 'a'].map(c => componentValueAt(p, 'col', c, T));
  if (prop === 'vel') return ['x', 'y', 'z'].map(c => componentValueAt(p, 'vel', c, T));
  if (prop === 'rot') return [0, 0, 0]; // 粒子无自身 rot
  return ['x', 'y', 'z'].map(c => componentValueAt(p, 'scl', c, T));
}

export function currentVisual(p) {
  if (p.fx) return currentVisualDerived(p, state.time);
  return {
    pos: particleValueAt(p, 'pos', state.time),
    color: particleValueAt(p, 'col', state.time),
    scale: particleValueAt(p, 'scl', state.time),
  };
}

// 派生粒子活源求值：每帧执行公式代码块（random 每帧变化，实现星光闪闪预览），
// 再按「自转 → 函数对象 pos op → 公转 → 组 op」顺序叠加整体变换，与游戏端活源语义一致。
// 返回的 scale 为三分量数组 [sx,sy,sz]（函数对象整体缩放可独立分轴）。
export function currentVisualDerived(p, T) {
  const fx = getFunction(p.fx);
  if (!fx) return { pos: [0, 0, 0], color: [1, 1, 1, 1], scale: [1, 1, 1] };
  const i = (p._fxIdx !== undefined) ? p._fxIdx : parseInt(p.id.slice(fx.id.length + 2), 10);
  const r = evaluateParticleAt(fx, i, fx.count, T);
  const base = r.scale;
  const sclTrs = (fxSclTrackCache && fxSclTrackCache.get(p.fx)) || null;
  const scaleVec = sclTrs
    ? [sclTrs[0] ? trackValueAt(sclTrs[0], T, base) : base,
       sclTrs[1] ? trackValueAt(sclTrs[1], T, base) : base,
       sclTrs[2] ? trackValueAt(sclTrs[2], T, base) : base]
    : [base, base, base];
  const gs = groupMemberIndexCache && groupMemberIndexCache.get(p.id);
  const hasFxOp = fxOpDeltaCache && fxOpDeltaCache.has(p.fx);
  const hasFxSpin = spinVectorAt('f:' + p.fx, T).some(v => v !== 0);
  const hasFxRot = rotVectorAt('f:' + p.fx, T).some(v => v !== 0);
  if (!gs && !hasFxOp && !hasFxSpin && !hasFxRot) {
    // 快速路径：无组关联、无函数 op / 自转 / 公转
    return { pos: r.pos, color: r.color, scale: scaleVec };
  }
  let pos = applyGroupScale(p, r.pos.slice(), T);
  pos = applySelfRotation(p, pos, T);
  // 函数对象整体 pos op 位移必须在公转之前生效：对象实际世界位置应绕公转中心旋转。
  // 组 op 位移仍保持公转之后（与组变换顺序一致）。
  pos = pos.map((v, ci) => v + compFxOpDelta(p, 'pos', ['x', 'y', 'z'][ci], T));
  pos = applyOrbitRotation(p, pos, T);
  pos = pos.map((v, ci) => v + compGroupOpDelta(p, 'pos', ['x', 'y', 'z'][ci], T));
  return { pos, color: r.color, scale: scaleVec };
}

// 结构变化（轨道/粒子/函数对象）时由 rebuildIndexes 失效；播放/拖动期间不失效。
let _maxTickCache = 0;
let _maxTickValid = false;

export function invalidateMaxTickCache() {
  _maxTickValid = false;
}

export function maxTick() {
  if (_maxTickValid) return _maxTickCache;
  let m = 0;
  for (const tr of state.tracks) for (const k of tr.kf) m = Math.max(m, k[0]);
  // 粒子起始时间与有限寿命计入时长；函数对象跨度 = st + extent（变量关键帧 或 依赖 t 时的 duration）
  for (const p of state.particles) {
    if (p.fx) continue;
    const s = p.st || 0;
    if (s > m) m = s;
    const life = typeof p.life === 'number' ? p.life : -1;
    if (life >= 0 && s + life > m) m = s + life;
  }
  for (const fx of state.functions) {
    // 函数对象跨度 = st + extent；extent = max(时长, 变量关键帧最大 tick)（与图层区 rowSpan 一致）
    let extent = fx.duration || 0;
    for (const v of Object.values(fx.vars)) for (const k of (v.kf || [])) if (k[0] > extent) extent = k[0];
    const end = (fx.st || 0) + extent;
    if (end > m) m = end;
  }
  _maxTickCache = Math.ceil(m);
  _maxTickValid = true;
  return _maxTickCache;
}

// 轨道分段积分（线性近似，忽略缓动）：trackValueAt 的常数段 + 线性段面积
export function trackIntegral(tr, time) {
  const kfs = tr.kf;
  if (!kfs || kfs.length === 0) return 0;
  const first = kfs[0], last = kfs[kfs.length - 1];
  if (time <= first[0]) return first[1] * time;
  let acc = first[1] * Math.max(0, first[0]); // [0, first.tick] 常数段
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i], b = kfs[i + 1];
    if (a[0] >= time) break;
    const ts = Math.max(a[0], 0);
    const te = Math.min(b[0], time);
    if (te <= ts) continue;
    const dur = b[0] - a[0];
    if (dur <= 0) continue;
    const f0 = (ts - a[0]) / dur;
    const f1 = (te - a[0]) / dur;
    const v0 = a[1] + (b[1] - a[1]) * f0;
    const v1 = a[1] + (b[1] - a[1]) * f1;
    acc += (v0 + v1) * 0.5 * (te - ts);
  }
  if (time > last[0]) acc += last[1] * (time - last[0]);
  return acc;
}

// 速度从 0 到 time 的位移积分（恒定速度解析，轨道分段线性近似）
export function velOffsetAt(p, time) {
  if (time <= 0) return [0, 0, 0];
  if (p.fx) {
    // 派生粒子：活源初速（t=0 的 p.vel）恒定积分（散开等恒定速度效果精确）
    return ['x', 'y', 'z'].map(c => baseComponent(p, 'vel', c) * time);
  }
  return ['x', 'y', 'z'].map(c => {
    const tr = findSetTrackFor(p.id, 'vel', c);
    if (!tr || tr.kf.length === 0) return baseComponent(p, 'vel', c) * time;
    return trackIntegral(tr, time);
  });
}

