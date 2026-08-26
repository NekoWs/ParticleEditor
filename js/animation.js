/* =========================================================================
 * 动画状态查询与渲染缓冲区组装
 * 数据模型：分量级轨道（pr：pos.x / pos.y / ... / col.a / scl），kf 值为标量。
 * 职责：
 *   1) 分量级求值（trackValueAt / particleValueAt / currentVisual）
 *   2) 索引缓存（粒子 / 轨道 / 组 / 函数对象，rebuildPoints 时重建）
 *   3) 渲染缓冲组装（setPointsGeometry / rebuildPoints / setPreview）
 * ======================================================================= */

// 粒子基础分量值（无轨道）
function baseComponent(p, prop, comp) {
  if (prop === 'pos') return p.pos[COMP_INDEX[comp]];
  if (prop === 'col') return p.color[COMP_INDEX[comp]];
  if (prop === 'vel') return (p.vel || [0, 0, 0])[COMP_INDEX[comp]];
  if (prop === 'scl') return (p.scale || [1, 1, 1])[COMP_INDEX[comp]];
  return 0;
}

// 粒子完整基础向量
function baseValue(p, prop) {
  if (prop === 'pos') return p.pos.slice(0, 3);
  if (prop === 'col') return p.color.slice(0, 4);
  if (prop === 'vel') return (p.vel || [0, 0, 0]).slice(0, 3);
  if (prop === 'rot') return [0, 0, 0];
  const s = p.scale || [1, 1, 1];
  return [s[0], s[1], s[2]];
}

// 零向量（按属性）
function zeroArray(prop) {
  if (prop === 'pos' || prop === 'rot' || prop === 'vel' || prop === 'scl') return [0, 0, 0];
  if (prop === 'col') return [0, 0, 0, 0];
  return [0];
}

// 轨道插值（标量）：b[2] 缓动语义（后一关键帧控制前一段）
// 带每轨道缓存：同一轨道在同一 T 下的值固定（组/函数轨道被多粒子共享时大幅加速）
function trackValueAt(tr, T, fallback) {
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
let trackIndexCache = null;        // Map: pr -> Map(id -> track)
let opTracksCache = null;          // Array<track>（op 模式轨道）
let groupSetCache = null;          // Map: gname -> Set<id>
let groupMemberIndexCache = null;  // Map: particleId -> Set<gname>
let groupCentroidPosCache = null;  // Map: gname -> [x,y,z]
let groupOpDeltaCache = null;      // Map: gname -> Map(pr -> delta)：op 增量预计算（per 组）
let fxOpDeltaCache = null;         // Map: fxId -> Map(pr -> delta)：op 增量预计算（per 函数对象）
let groupXformCache = null;        // Map: gname -> { rotTr, setTr, op, pivot }：组变换预计算（组-only 粒子快路径）
let fxSclTrackCache = null;        // Map: fxId -> scl 轨道（函数对象整体缩放，pr='scl'）

// 10 个分量轨道 pr 顺序（组变换预计算用，与 positions/colors 写入一致）
const TRACK_COMP_ORDER = ['pos.x', 'pos.y', 'pos.z', 'col.r', 'col.g', 'col.b', 'col.a', 'scl.x', 'scl.y', 'scl.z'];
// pr -> 粒子分量轨道槽下标（p._tr 数组，13 槽：10 分量 + vel 3）
const PR_TO_IDX = {
  'pos.x': 0, 'pos.y': 1, 'pos.z': 2,
  'col.r': 3, 'col.g': 4, 'col.b': 5, 'col.a': 6,
  'scl.x': 7, 'scl.y': 8, 'scl.z': 9,
  'vel.x': 10, 'vel.y': 11, 'vel.z': 12,
};

let trVersion = 0; // 每次 buildParticleIndex 递增，配合 p._trVersion 惰性失效 p._tr
function buildParticleIndex() {
  const map = new Map();
  for (const p of state.particles) map.set(p.id, p);
  particleIndexCache = map;
  const fm = new Map();
  for (const f of state.functions) fm.set(f.id, f);
  functionIndexCache = fm;
  trVersion++;
}

function buildTrackIndex() {
  const opTracks = [];
  const pidx = particleIndexCache;
  const tracks = state.tracks;
  for (let i = 0; i < tracks.length; i++) {
    const tr = tracks[i];
    tr._t = undefined; // 清空每轨道求值缓存（轨道内容可能已变，见 trackValueAt）
    if (tr.ids.length === 1) {
      const id = tr.ids[0];
      const c0 = id.charCodeAt(0);
      if (c0 !== 103 && c0 !== 102) { // 排除 'g:' 组 / 'f:' 函数轨道（普通/派生粒子轨道）
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
function buildTrackIndexMap() {
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
function buildGroupIndex() {
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
function findTrackByPr(pr, id) {
  if (!trackIndexCache) buildTrackIndexMap();
  const byId = trackIndexCache.get(pr);
  return byId ? (byId.get(id) || null) : null;
}

// 某 id 在某分量的 set 轨道（优先级：自身 > 组 > 函数对象）
function findSetTrackFor(id, prop, comp) {
  const pr = compPr(prop, comp);
  const own = findTrackByPr(pr, id);
  if (own && own.m !== 'op') return own;
  const gs = groupMemberIndexCache && groupMemberIndexCache.get(id);
  if (gs) {
    for (const gname of gs) {
      const tr = findTrackByPr(pr, 'g:' + gname);
      if (tr && tr.m !== 'op') return tr;
    }
  }
  const p = getParticle(id);
  if (p && p.fx) {
    const tr = findTrackByPr(pr, 'f:' + p.fx);
    if (tr && tr.m !== 'op') return tr;
  }
  return null;
}

// 预计算 op 轨道在时间 T 的增量（按组/函数对象聚合到分量 pr），供 compOpDelta 直接查表，
// 避免每个粒子重复遍历 opTracksCache 与 trackValueAt。
function buildOpDeltaCache(T) {
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
function buildGroupXforms(T) {
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
    // 组旋转：预计算复合旋转矩阵（M = Mz·My·Mx，与 applyGroupRotation 的 rotateVector 顺序一致）
    const r0 = (() => { const tr = findTrackByPr('rot.x', 'g:' + gname); return (tr && tr.m !== 'op' && tr.kf.length) ? trackValueAt(tr, T, 0) : 0; })();
    const r1 = (() => { const tr = findTrackByPr('rot.y', 'g:' + gname); return (tr && tr.m !== 'op' && tr.kf.length) ? trackValueAt(tr, T, 0) : 0; })();
    const r2 = (() => { const tr = findTrackByPr('rot.z', 'g:' + gname); return (tr && tr.m !== 'op' && tr.kf.length) ? trackValueAt(tr, T, 0) : 0; })();
    let rotMat = null;
    if (r0 !== 0 || r1 !== 0 || r2 !== 0) {
      const M = matMat(matMat(FUNC_IMPL.rotZ(r2 * DEG2RAD), FUNC_IMPL.rotY(r1 * DEG2RAD)), FUNC_IMPL.rotX(r0 * DEG2RAD));
      rotMat = [M.m[0][0], M.m[0][1], M.m[0][2], M.m[1][0], M.m[1][1], M.m[1][2], M.m[2][0], M.m[2][1], M.m[2][2]];
    }
    const opMap = groupOpDeltaCache ? groupOpDeltaCache.get(gname) : null;
    const op = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    if (opMap) for (let i = 0; i < 10; i++) op[i] = opMap.get(TRACK_COMP_ORDER[i]) || 0;
    xforms.set(gname, {
      setTr, velTr, op, rotMat, pivot: groupCentroidPosCache.get(gname),
      hasSet: setTr.some(t => t !== null), hasRot: rotMat !== null,
      hasOp: op.some(v => v !== 0), hasVel: velTr.some(t => t !== null),
    });
  }
  groupXformCache = xforms;
}

// 预计算函数对象的整体 scl 轨道（pr 为 scl.x/scl.y/scl.z），供 currentVisualDerived 快速路径查询
function buildFxSclTrackCache() {
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
function compOpDelta(p, prop, comp, T) {
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

// 某 id（'g:name' 或 'f:fxId'）的 rot 向量（三个分量）
function rotVectorAt(id, T) {
  return ['x', 'y', 'z'].map(c => {
    const tr = findTrackByPr('rot.' + c, id);
    return tr ? trackValueAt(tr, T, 0) : 0;
  });
}

// 组旋转信息（组件/函数对象的 rot + pivot）
function groupRotationInfo(p, T) {
  const gs = groupMemberIndexCache && groupMemberIndexCache.get(p.id);
  if (gs) {
    for (const gname of gs) {
      const rot = rotVectorAt('g:' + gname, T);
      if (rot[0] === 0 && rot[1] === 0 && rot[2] === 0) continue;
      const pivot = (groupCentroidPosCache && groupCentroidPosCache.get(gname)) || groupCentroidValue(gname, 'pos');
      return { rot, pivot };
    }
  }
  if (p.fx) {
    const rot = rotVectorAt('f:' + p.fx, T);
    if (rot[0] === 0 && rot[1] === 0 && rot[2] === 0) return null;
    const fx = getFunction(p.fx);
    return { rot, pivot: fx ? fx.center.slice() : [0, 0, 0] };
  }
  return null;
}

function applyGroupRotation(p, value, T) {
  const info = groupRotationInfo(p, T);
  if (!info) return value;
  const rot = info.rot;
  const pivot = info.pivot;
  let r = [value[0] - pivot[0], value[1] - pivot[1], value[2] - pivot[2]];
  r = rotateVector(r, [1, 0, 0], rot[0] * DEG2RAD);
  r = rotateVector(r, [0, 1, 0], rot[1] * DEG2RAD);
  r = rotateVector(r, [0, 0, 1], rot[2] * DEG2RAD);
  return [pivot[0] + r[0], pivot[1] + r[1], pivot[2] + r[2]];
}

// 粒子位置：set 覆盖 → 组旋转 → op 增量
function particlePosition(p, T) {
  let pos = ['x', 'y', 'z'].map(c => {
    let v = baseComponent(p, 'pos', c);
    const tr = findSetTrackFor(p.id, 'pos', c);
    if (tr && tr.kf.length > 0) v = trackValueAt(tr, T, v);
    return v;
  });
  pos = applyGroupRotation(p, pos, T);
  pos = pos.map((v, i) => v + compOpDelta(p, 'pos', ['x', 'y', 'z'][i], T));
  return pos;
}

// 粒子某分量值：基础 → set 覆盖 → op 增量
function componentValueAt(p, prop, comp, T) {
  let v = baseComponent(p, prop, comp);
  const tr = findSetTrackFor(p.id, prop, comp);
  if (tr && tr.kf.length > 0) v = trackValueAt(tr, T, v);
  v += compOpDelta(p, prop, comp, T);
  return v;
}

// 粒子某属性完整向量（分量级拼装）
function particleValueAt(p, prop, T) {
  if (prop === 'pos') return particlePosition(p, T);
  if (prop === 'col') return ['r', 'g', 'b', 'a'].map(c => componentValueAt(p, 'col', c, T));
  if (prop === 'vel') return ['x', 'y', 'z'].map(c => componentValueAt(p, 'vel', c, T));
  if (prop === 'rot') return [0, 0, 0]; // 粒子无自身 rot
  return ['x', 'y', 'z'].map(c => componentValueAt(p, 'scl', c, T));
}

function currentVisual(p) {
  if (p.fx) return currentVisualDerived(p, state.time);
  return {
    pos: particleValueAt(p, 'pos', state.time),
    color: particleValueAt(p, 'col', state.time),
    scale: particleValueAt(p, 'scl', state.time),
  };
}

// 派生粒子活源求值：每帧执行公式代码块（random 每帧变化，实现星光闪闪预览），
// 再叠加函数对象整体旋转（rot）与位移增量（op），与游戏端活源语义一致。
// 返回的 scale 为三分量数组 [sx,sy,sz]（函数对象整体缩放可独立分轴）。
function currentVisualDerived(p, T) {
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
  const hasFxRot = rotVectorAt('f:' + p.fx, T).some(v => v !== 0);
  if (!gs && !hasFxOp && !hasFxRot) {
    // 快速路径：无组关联、无函数 op、无函数旋转
    return { pos: r.pos, color: r.color, scale: scaleVec };
  }
  let pos = applyGroupRotation(p, r.pos.slice(), T);
  pos = pos.map((v, ci) => v + compOpDelta(p, 'pos', ['x', 'y', 'z'][ci], T));
  return { pos, color: r.color, scale: scaleVec };
}

function maxTick() {
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
  return Math.ceil(m);
}

// 速度位移积分：按时间计算（任何时刻都生效，含非播放/拖动时间轴），渲染期叠加不改数据。
// 兼容旧调用：速度积分已改为按 time 计算，无需重置状态。
function resetVelOffsets() {}

// 轨道分段积分（线性近似，忽略缓动）：trackValueAt 的常数段 + 线性段面积
function trackIntegral(tr, time) {
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
function velOffsetAt(p, time) {
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

/* =========================================================================
 * 渲染
 * ======================================================================= */

// 复用几何体与缓冲：仅顶点数量变化时重建，否则只更新数组内容（避免每帧 new/dispose 造成 GC 卡顿）
// sizes 为每粒子 2 分量（sx, sy，非均匀 billboard 尺寸）
function setPointsGeometry(pts, positions, colors, sizes) {
  let geo = pts.geometry;
  const posAttr = geo && geo.getAttribute('position');
  if (!geo || !posAttr || posAttr.array.length !== positions.length) {
    geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions.length), 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(colors.length), 4));
    geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(sizes.length), 2));
    const old = pts.geometry;
    pts.geometry = geo;
    if (old) old.dispose();
  }
  geo.getAttribute('position').array.set(positions);
  geo.getAttribute('aColor').array.set(colors);
  geo.getAttribute('aSize').array.set(sizes);
  geo.getAttribute('position').needsUpdate = true;
  geo.getAttribute('aColor').needsUpdate = true;
  geo.getAttribute('aSize').needsUpdate = true;
  geo.setDrawRange(0, positions.length / 3);
}

let rpPos = null, rpCol = null, rpSize = null, rpSelPos = null, rpSelCol = null, rpSelSize = null;
let rpUV = null, rpUVScale = null, rpUVAnim = null, rpUVTex = null, rpUVMode = null;
// 派生粒子求值的复用输出对象（主循环顺序执行、立即读走，单线程安全，避免每粒子分配）
const FX_OUT = { pos: [0, 0, 0], color: [0, 0, 0, 0], vel: [0, 0, 0], scale: 1, glow: false, light: 0 };
// 粒子 UV 求值的复用输出（fill 模式下强制全图采样）
const UVOUT = { mode: 0, au0: 0, av0: 0, au1: 0, av1: 0, sx: 0, sy: 0, sw: 16, sh: 16, stepx: 16, stepy: 0, fps: 1, maxFrame: 1, tw: 16, th: 16 };

// 计算单个粒子的 uv 渲染参数（写入复用 out），无贴图时 mode=0
// UV 坐标为像素坐标，在 shader 中除以 vUVTex 归一化；texSize 仅影响粒子显示大小，不影响 UV
function computeParticleUV(p, out) {
  out.mode = 0;
  if (typeof resolveUV !== 'function') return;
  const uv = resolveUV(p).uv;
  if (!uv || !uv.texture) return;
  const tex = texAtlasMap[uv.texture];
  if (!tex) return;
  out.au0 = tex.u0; out.av0 = tex.v0; out.au1 = tex.u1; out.av1 = tex.v1;
  out.tw = tex.w; out.th = tex.h;
  if (uv.mode === 'fill') {
    out.sx = 0; out.sy = 0; out.sw = tex.w; out.sh = tex.h;
    out.mode = 2;
  } else if (uv.mode === 'animated') {
    const off = animatedUVOffsetAt(uv, tex.w, tex.h);
    out.sx = off[0]; out.sy = off[1];
    // uvSize 为 0 时使用贴图大小（铺满整张贴图）
    out.sw = uv.uvSize[0] || tex.w; out.sh = uv.uvSize[1] || tex.h;
    out.stepx = 0; out.stepy = 0;   // 帧已计入偏移，shader 不再动画
    out.fps = uv.fps;
    out.maxFrame = effMaxFrame(uv, autoFramesFor(uv, tex.w, tex.h));
    out.mode = 1;                    // 按静态矩形采样（偏移已含帧）
  } else {
    out.sx = uv.uvStart[0]; out.sy = uv.uvStart[1];
    // uvSize 为 0 时使用贴图大小（铺满整张贴图）
    out.sw = uv.uvSize[0] || tex.w; out.sh = uv.uvSize[1] || tex.h;
    out.mode = 1;
  }
}

/**
 * 动画贴图 UV 帧的时间驱动源（秒）。
 * 播放或拖动时间轴时，帧应由当前时间轴刻度决定（所有粒子同步到时间轴，供预览整体动画流程）；
 * 暂停空闲时，则退回墙钟循环播放，供单独预览贴图动画。
 * state.time 为「刻度」单位（20 刻度 = 1 秒），故除以 20 换算成秒。
 */
function uvDriveSeconds() {
  if (state.playing || state.scrubbing) return state.time / 20;
  return performance.now() / 1000;
}

/**
 * 动画贴图当前帧的行主 flipbook 偏移 [sx, sy]（帧号按 uvDriveSeconds 的 float64 确定性计算，
 * 与贴图预览 currentUVFrame、游戏端 currentUvStart 完全同源）。
 */
function animatedUVOffsetAt(uv, texW, texH) {
  const maxF = effMaxFrame(uv, autoFramesFor(uv, texW, texH));
  const raw = Math.floor(uvDriveSeconds() * (uv.fps || 1));
  const frame = uv.loop ? ((raw % maxF) + maxF) % maxF : Math.min(raw, maxF - 1);
  const stepx = uv.uvStep[0] || 0, stepy = uv.uvStep[1] || 0;
  const cols = (stepx > 0 && uv.uvStart[0] < texW) ? Math.floor((texW - 1 - uv.uvStart[0]) / stepx) + 1 : 1;
  return [uv.uvStart[0] + stepx * (frame % cols), uv.uvStart[1] + stepy * Math.floor(frame / cols)];
}

/** 是否存在动画贴图粒子（决定是否需要每帧轻量推进 UV 帧）。 */
let hasAnimatedTex = false;

/** 每帧只推进动画贴图粒子的 sx/sy（轻量，不重建位置/颜色/整段缓冲区）。 */
function updateAnimatedUV() {
  if (!hasAnimatedTex) return;
  if (typeof resolveUV !== 'function') return;
  const attr = points.geometry.getAttribute('aUVScale');
  if (!attr) return;
  const arr = attr.array;
  let changed = false;
  for (let i = 0; i < state.particles.length; i++) {
    const p = state.particles[i];
    const uv = resolveUV(p).uv;
    if (!uv || uv.mode !== 'animated' || !uv.texture) continue;
    const tex = texAtlasMap[uv.texture];
    if (!tex) continue;
    const off = animatedUVOffsetAt(uv, tex.w, tex.h);
    arr[i * 4] = off[0];
    arr[i * 4 + 1] = off[1];
    changed = true;
  }
  if (changed) attr.needsUpdate = true;
}

// 设置 UV 相关 attribute（在 geometry 重建后调用）
function setPointUVAttributes(geo, uvs) {
  const defs = [
    ['aUV', uvs.uv, 4],
    ['aUVScale', uvs.uvScale, 4],
    ['aUVAnim', uvs.uvAnim, 4],
    ['aUVTex', uvs.uvTex, 2],
    ['aUVMode', uvs.uvMode, 1],
  ];
  for (const [name, arr, itemSize] of defs) {
    let attr = geo.getAttribute(name);
    if (!attr || attr.array.length !== arr.length) {
      attr = new THREE.BufferAttribute(new Float32Array(arr.length), itemSize);
      geo.setAttribute(name, attr);
    }
    attr.array.set(arr);
    attr.needsUpdate = true;
  }
}

function rebuildPoints(full) {
  buildParticleIndex();
  buildTrackIndex();
  buildGroupIndex();
  buildOpDeltaCache(state.time);
  buildGroupXforms(state.time);
  buildFxSclTrackCache();
  // 预编译所有函数对象（code 变化时惰性重编译），主循环直接取 fx._compiledFn/_constVarVals
  for (let fi = 0; fi < state.functions.length; fi++) { getCompiledFn(state.functions[fi]); getConstVarVals(state.functions[fi]); }
  const n = state.particles.length;
  if (!rpPos || rpPos.length !== n * 3) rpPos = new Float32Array(n * 3);
  if (!rpCol || rpCol.length !== n * 4) rpCol = new Float32Array(n * 4);
  if (!rpSize || rpSize.length !== n * 2) rpSize = new Float32Array(n * 2);
  if (!rpUV || rpUV.length !== n * 4) rpUV = new Float32Array(n * 4);
  if (!rpUVScale || rpUVScale.length !== n * 4) rpUVScale = new Float32Array(n * 4);
  if (!rpUVAnim || rpUVAnim.length !== n * 4) rpUVAnim = new Float32Array(n * 4);
  if (!rpUVTex || rpUVTex.length !== n * 2) rpUVTex = new Float32Array(n * 2);
  if (!rpUVMode || rpUVMode.length !== n) rpUVMode = new Float32Array(n);
  const positions = rpPos, colors = rpCol, sizes = rpSize;
  const T = state.time;
  const memberIdx = groupMemberIndexCache;
  const hasGroups = memberIdx.size > 0;
  const xforms = groupXformCache;
  const SZF = PARTICLE_SIZE_FACTOR;
  // 函数对象"干净"标志：无组、无 op 轨道、无函数 scl 轨道、无函数 rot 轨道 → 派生粒子走最简快速路径
  const hasFxRotTracks = state.tracks.some(tr => tr.pr.startsWith('rot.') && tr.ids.some(id => id.startsWith('f:')));
  const fxClean = !hasGroups && opTracksCache.length === 0 && (fxSclTrackCache ? fxSclTrackCache.size === 0 : true) && !hasFxRotTracks;
  for (let i = 0; i < n; i++) {
    const p = state.particles[i];
    let px, py, pz, cr, cg, cb, ca, ssx, ssy;
    if (p.fx) {
      const fx = functionIndexCache.get(p.fx);
      const fn = fx._compiledFn;
      if (fn && fxClean) {
        // 最简快速路径：直接调用原生编译函数写进复用输出对象
        const vals = fx._constVarVals || resolveVarVals(fx, p._fxIdx, fx.count, T);
        const r = fn(p._fxIdx, fx.count, T, fx.center[0], fx.center[1], fx.center[2], ...vals, FX_OUT);
        const vel = p.vel;
        px = r.pos[0] + vel[0] * T; py = r.pos[1] + vel[1] * T; pz = r.pos[2] + vel[2] * T;
        cr = r.color[0]; cg = r.color[1]; cb = r.color[2]; ca = r.color[3];
        ssx = r.scale; ssy = r.scale;
      } else {
        const gs = hasGroups ? memberIdx.get(p.id) : undefined;
        const hasFxOp = fxOpDeltaCache && fxOpDeltaCache.has(p.fx);
        const hasFxRot = rotVectorAt('f:' + p.fx, T).some(v => v !== 0);
        const sclTrs = (fxSclTrackCache && fxSclTrackCache.get(p.fx)) || null;
        if (fn && !gs && !hasFxOp && !hasFxRot) {
          const vals = fx._constVarVals || resolveVarVals(fx, p._fxIdx, fx.count, T);
          const r = fn(p._fxIdx, fx.count, T, fx.center[0], fx.center[1], fx.center[2], ...vals, FX_OUT);
          const vel = p.vel;
          px = r.pos[0] + vel[0] * T; py = r.pos[1] + vel[1] * T; pz = r.pos[2] + vel[2] * T;
          cr = r.color[0]; cg = r.color[1]; cb = r.color[2]; ca = r.color[3];
          ssx = (sclTrs && sclTrs[0]) ? trackValueAt(sclTrs[0], T, r.scale) : r.scale;
          ssy = (sclTrs && sclTrs[1]) ? trackValueAt(sclTrs[1], T, r.scale) : r.scale;
        } else {
          const v = currentVisual(p);
          const off = velOffsetAt(p, T);
          px = v.pos[0] + off[0]; py = v.pos[1] + off[1]; pz = v.pos[2] + off[2];
          cr = v.color[0]; cg = v.color[1]; cb = v.color[2]; ca = v.color[3];
          ssx = v.scale[0]; ssy = v.scale[1];
        }
      }
    } else {
      const inGroup = hasGroups && memberIdx.has(p.id);
      const tr = (p._trVersion === trVersion) ? p._tr : null;
      if (tr && !inGroup) {
        // 自身 set 轨道快路径（无组无 fx）
        px = tr[0] ? trackValueAt(tr[0], T, p.pos[0]) : p.pos[0];
        py = tr[1] ? trackValueAt(tr[1], T, p.pos[1]) : p.pos[1];
        pz = tr[2] ? trackValueAt(tr[2], T, p.pos[2]) : p.pos[2];
        cr = tr[3] ? trackValueAt(tr[3], T, p.color[0]) : p.color[0];
        cg = tr[4] ? trackValueAt(tr[4], T, p.color[1]) : p.color[1];
        cb = tr[5] ? trackValueAt(tr[5], T, p.color[2]) : p.color[2];
        ca = tr[6] ? trackValueAt(tr[6], T, p.color[3]) : p.color[3];
        ssx = tr[7] ? trackValueAt(tr[7], T, p.scale[0]) : p.scale[0];
        ssy = tr[8] ? trackValueAt(tr[8], T, p.scale[1]) : p.scale[1];
        px += tr[10] ? trackIntegral(tr[10], T) : p.vel[0] * T;
        py += tr[11] ? trackIntegral(tr[11], T) : p.vel[1] * T;
        pz += tr[12] ? trackIntegral(tr[12], T) : p.vel[2] * T;
      } else if (!tr && inGroup) {
        const gs = memberIdx.get(p.id);
        let xf = null;
        if (gs.size === 1) xf = xforms.get(gs.values().next().value);
        if (xf) {
          // 单组快路径：set 覆盖 → 组旋转 → op 增量 → vel 积分
          if (xf.hasSet) {
            px = xf.setTr[0] ? trackValueAt(xf.setTr[0], T, p.pos[0]) : p.pos[0];
            py = xf.setTr[1] ? trackValueAt(xf.setTr[1], T, p.pos[1]) : p.pos[1];
            pz = xf.setTr[2] ? trackValueAt(xf.setTr[2], T, p.pos[2]) : p.pos[2];
            cr = xf.setTr[3] ? trackValueAt(xf.setTr[3], T, p.color[0]) : p.color[0];
            cg = xf.setTr[4] ? trackValueAt(xf.setTr[4], T, p.color[1]) : p.color[1];
            cb = xf.setTr[5] ? trackValueAt(xf.setTr[5], T, p.color[2]) : p.color[2];
            ca = xf.setTr[6] ? trackValueAt(xf.setTr[6], T, p.color[3]) : p.color[3];
            ssx = xf.setTr[7] ? trackValueAt(xf.setTr[7], T, p.scale[0]) : p.scale[0];
            ssy = xf.setTr[8] ? trackValueAt(xf.setTr[8], T, p.scale[1]) : p.scale[1];
          } else {
            px = p.pos[0]; py = p.pos[1]; pz = p.pos[2];
            cr = p.color[0]; cg = p.color[1]; cb = p.color[2]; ca = p.color[3];
            ssx = p.scale[0]; ssy = p.scale[1];
          }
          if (xf.rotMat) {
            const m = xf.rotMat;
            const pivot = xf.pivot || [0, 0, 0];
            const rx = px - pivot[0], ry = py - pivot[1], rz = pz - pivot[2];
            px = pivot[0] + m[0] * rx + m[1] * ry + m[2] * rz;
            py = pivot[1] + m[3] * rx + m[4] * ry + m[5] * rz;
            pz = pivot[2] + m[6] * rx + m[7] * ry + m[8] * rz;
          }
          if (xf.hasOp) {
            px += xf.op[0]; py += xf.op[1]; pz += xf.op[2];
            cr += xf.op[3]; cg += xf.op[4]; cb += xf.op[5]; ca += xf.op[6];
            ssx += xf.op[7]; ssy += xf.op[8];
          }
          if (xf.hasVel) {
            px += xf.velTr[0] ? trackIntegral(xf.velTr[0], T) : p.vel[0] * T;
            py += xf.velTr[1] ? trackIntegral(xf.velTr[1], T) : p.vel[1] * T;
            pz += xf.velTr[2] ? trackIntegral(xf.velTr[2], T) : p.vel[2] * T;
          } else {
            px += p.vel[0] * T; py += p.vel[1] * T; pz += p.vel[2] * T;
          }
        } else {
          const v = currentVisual(p);
          const off = velOffsetAt(p, T);
          px = v.pos[0] + off[0]; py = v.pos[1] + off[1]; pz = v.pos[2] + off[2];
          cr = v.color[0]; cg = v.color[1]; cb = v.color[2]; ca = v.color[3];
          ssx = v.scale[0]; ssy = v.scale[1];
        }
      } else if (!tr && !inGroup) {
        const vel = p.vel;
        px = p.pos[0] + vel[0] * T; py = p.pos[1] + vel[1] * T; pz = p.pos[2] + vel[2] * T;
        cr = p.color[0]; cg = p.color[1]; cb = p.color[2]; ca = p.color[3];
        ssx = p.scale[0]; ssy = p.scale[1];
      } else {
        // 自身轨道 + 组：走完整求值
        const v = currentVisual(p);
        const off = velOffsetAt(p, T);
        px = v.pos[0] + off[0]; py = v.pos[1] + off[1]; pz = v.pos[2] + off[2];
        cr = v.color[0]; cg = v.color[1]; cb = v.color[2]; ca = v.color[3];
        ssx = v.scale[0]; ssy = v.scale[1];
      }
    }
    // 入场/寿命门控：t < st 隐藏；有限 life 到期后隐藏。fade 预设在出场窗口内做 alpha 渐显
    const gate = p.fx ? (functionIndexCache.get(p.fx) || {}) : p;
    const gst = gate.st || 0;
    let vis = T >= gst ? 1 : 0;
    const glife = typeof gate.life === 'number' ? gate.life : -1;
    if (vis > 0 && glife >= 0 && T - gst >= glife) vis = 0;
    if (vis > 0 && gate.ent && gate.ent.p === 'fade') {
      const fd = gate.ent.d || 5;
      if (T - gst < fd) vis *= Math.max(0, (T - gst) / fd);
    }
    ca *= vis;
    positions[i * 3] = px; positions[i * 3 + 1] = py; positions[i * 3 + 2] = pz;
    colors[i * 4] = cr; colors[i * 4 + 1] = cg; colors[i * 4 + 2] = cb; colors[i * 4 + 3] = ca;
    computeParticleUV(p, UVOUT);
    // 贴图大小缩放：使用用户设置的 texSize（控制粒子显示大小），基准 16px
    const uvForSize = (typeof resolveUV === 'function') ? resolveUV(p).uv : null;
    const texW = uvForSize ? (uvForSize.texSize[0] || 16) : 16;
    const texH = uvForSize ? (uvForSize.texSize[1] || 16) : 16;
    const texScaleX = Math.max(1, texW) / 16;
    const texScaleY = Math.max(1, texH) / 16;
    let sx = ssx * SZF * texScaleX, sy = ssy * SZF * texScaleY;
    if (vis === 0) {
      sizes[i * 2] = 0; sizes[i * 2 + 1] = 0;   // 尺寸归零 → 无片段光栅化，预览层完全隐藏
    } else {
      sizes[i * 2] = sx > 0.02 ? sx : 0.02;
      sizes[i * 2 + 1] = sy > 0.02 ? sy : 0.02;
    }
    const i4 = i * 4, i2 = i * 2;
    rpUV[i4] = UVOUT.au0; rpUV[i4 + 1] = UVOUT.av0; rpUV[i4 + 2] = UVOUT.au1; rpUV[i4 + 3] = UVOUT.av1;
    rpUVScale[i4] = UVOUT.sx; rpUVScale[i4 + 1] = UVOUT.sy; rpUVScale[i4 + 2] = UVOUT.sw; rpUVScale[i4 + 3] = UVOUT.sh;
    rpUVAnim[i4] = UVOUT.stepx; rpUVAnim[i4 + 1] = UVOUT.stepy; rpUVAnim[i4 + 2] = UVOUT.fps; rpUVAnim[i4 + 3] = UVOUT.maxFrame;
    rpUVTex[i2] = UVOUT.tw; rpUVTex[i2 + 1] = UVOUT.th;
    rpUVMode[i] = UVOUT.mode;
  }
  setPointsGeometry(points, positions, colors, sizes);
  setPointUVAttributes(points.geometry, { uv: rpUV, uvScale: rpUVScale, uvAnim: rpUVAnim, uvTex: rpUVTex, uvMode: rpUVMode });

  const sel = state.particles.filter(p => state.selected.has(p.id));
  if (!rpSelPos || rpSelPos.length !== sel.length * 3) rpSelPos = new Float32Array(sel.length * 3);
  if (!rpSelCol || rpSelCol.length !== sel.length * 4) rpSelCol = new Float32Array(sel.length * 4);
  if (!rpSelSize || rpSelSize.length !== sel.length * 2) rpSelSize = new Float32Array(sel.length * 2);
  const spos = rpSelPos, ssiz = rpSelSize;
  for (let i = 0; i < sel.length; i++) {
    const v = currentVisual(sel[i]);
    const off = velOffsetAt(sel[i], state.time);
    spos[i * 3] = v.pos[0] + off[0]; spos[i * 3 + 1] = v.pos[1] + off[1]; spos[i * 3 + 2] = v.pos[2] + off[2];
    // 与主循环一致：使用用户设置的 texSize 计算粒子尺寸
    computeParticleUV(sel[i], UVOUT);
    const uvForSize = (typeof resolveUV === 'function') ? resolveUV(sel[i]).uv : null;
    const texW = uvForSize ? (uvForSize.texSize[0] || 16) : 16;
    const texH = uvForSize ? (uvForSize.texSize[1] || 16) : 16;
    const texScaleX = Math.max(1, texW) / 16;
    const texScaleY = Math.max(1, texH) / 16;
    const sx = v.scale[0] * PARTICLE_SIZE_FACTOR * texScaleX, sy = v.scale[1] * PARTICLE_SIZE_FACTOR * texScaleY;
    ssiz[i * 2] = Math.max(0.02, sx);
    ssiz[i * 2 + 1] = Math.max(0.02, sy);
  }
  setPointsGeometry(selectedPoints, spos, rpSelCol, ssiz);

  // 是否存在动画贴图粒子——决定主循环是否每帧轻量推进 UV 帧（updateAnimatedUV）
  hasAnimatedTex = state.particles.some(p => {
    if (typeof resolveUV !== 'function') return false;
    const uv = resolveUV(p).uv;
    return !!(uv && uv.mode === 'animated' && uv.texture);
  });

  updateGizmo();
  drawTimeline();
  if (full !== false) {
    updatePropPanel();
    refreshTreeSelection();
    if (typeof refreshCompTimelines === 'function') refreshCompTimelines();
    if (typeof refreshUVPanel === 'function' && document.getElementById('pane-texture') && document.getElementById('pane-texture').classList.contains('active')) refreshUVPanel();
  }
}

function setPreview(positions) {
  const n = positions.length;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 4), siz = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = positions[i][0]; pos[i * 3 + 1] = positions[i][1]; pos[i * 3 + 2] = positions[i][2];
    col[i * 4] = 1; col[i * 4 + 1] = 1; col[i * 4 + 2] = 1; col[i * 4 + 3] = 0.6;
    siz[i * 2] = 1 * PARTICLE_SIZE_FACTOR; siz[i * 2 + 1] = 1 * PARTICLE_SIZE_FACTOR;
  }
  setPointsGeometry(previewPoints, pos, col, siz);
  // 预览点复用 pointsMaterial（shader 声明了 UV attributes）：补齐全 0 的 UV 数据，
  // 避免 attribute 缺失时被 shader 读到垃圾值而随机采样贴图（表现为透明/花屏）
  setPointUVAttributes(previewPoints.geometry, {
    uv: new Float32Array(n * 4), uvScale: new Float32Array(n * 4), uvAnim: new Float32Array(n * 4),
    uvTex: new Float32Array(n * 2), uvMode: new Float32Array(n),
  });
}

function clearPreview() { setPointsGeometry(previewPoints, new Float32Array(0), new Float32Array(0), new Float32Array(0)); }
