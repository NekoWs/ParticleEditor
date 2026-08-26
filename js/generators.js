/* =========================================================================
 * 函数对象：活源重算
 * ======================================================================= */

// 代码块编译缓存：fx.code 变化时重新编译（避免每粒子重复 split/tokenize）
function getCompiledCode(fx) {
  const code = fx.code || '';
  if (fx._compiledCode === undefined || fx._compiledSrc !== code) {
    fx._compiledCode = compileFunctionCode(code);
    fx._compiledSrc = code;
  }
  return fx._compiledCode;
}

// 变量名列表缓存（fx.vars 的 key 顺序；重建函数对象时失效）
function getVarNames(fx) {
  if (fx._varNames === undefined) fx._varNames = Object.keys(fx.vars || {});
  return fx._varNames;
}

// 常量变量值缓存：所有变量无关键帧且表达式无变量引用时，预计算一次共享（否则 null）
function getConstVarVals(fx) {
  if (fx._constVarVals !== undefined) return fx._constVarVals;
  const names = getVarNames(fx);
  let vals = (names.length === 0) ? [] : null;
  if (names.length > 0) {
    vals = new Array(names.length);
    for (let k = 0; k < names.length; k++) {
      const v = fx.vars[names[k]];
      if (!v || (v.kf && v.kf.length > 0)) { vals = null; break; }
      const rpn = getCompiledVarExpr(v);
      if (rpn.some(o => o && o.t === 'var')) { vals = null; break; }
      vals[k] = execRpn(rpn, {});
    }
  }
  fx._constVarVals = vals;
  return vals;
}

// 代码块原生编译缓存：fx.code 变化时重新编译（纯标量代码块可编译为原生 JS 函数，否则 null）
function getCompiledFn(fx) {
  const code = fx.code || '';
  if (fx._compiledFn === undefined || fx._compiledFnSrc !== code) {
    fx._compiledFn = tryCompileFunction(code, getVarNames(fx));
    fx._compiledFnSrc = code;
  }
  return fx._compiledFn;
}

// 解析变量值数组（按 getVarNames 顺序；含链式引用与关键帧），供原生编译函数调用
function resolveVarVals(fx, i, n, t) {
  const constVals = getConstVarVals(fx);
  if (constVals) return constVals;
  const vars = fx.vars || {};
  const names = getVarNames(fx);
  const out = new Array(names.length);
  if (names.length === 0) return out;
  const t0 = t || 0;
  const env = { i, n, t: t0 };
  const memo = {};
  const inStack = new Set();
  function resolve(name) {
    if (name in memo) return memo[name];
    if (name in env) return env[name];
    const v = vars[name];
    if (!v) throw new Error(_etf('err.unknownVar', name));
    if (inStack.has(name)) throw new Error(_etf('err.varCycle', name));
    inStack.add(name);
    const kf = v.kf || [];
    const val = (kf.length > 0) ? varKfValue(kf, t0) : execRpn(getCompiledVarExpr(v), resolve);
    inStack.delete(name);
    memo[name] = val;
    return val;
  }
  for (let k = 0; k < names.length; k++) {
    if (ATTR_NAMES.includes(names[k])) throw new Error(_etf('err.varReserved', names[k]));
    out[k] = resolve(names[k]);
  }
  return out;
}

// 变量表达式编译缓存
function getCompiledVarExpr(v) {
  const expr = v.expr || '0';
  if (v._compiled === undefined || v._compiledSrc !== expr) {
    v._compiled = compileExpr(expr);
    v._compiledSrc = expr;
  }
  return v._compiled;
}

// 链式求值变量：vars 为 { name: {expr, kf} }，关键帧优先按 t 插值，无帧用表达式
function buildEnv(vars, ctx) {
  const env = { i: ctx.i, n: ctx.n, t: ctx.t || 0 };
  const memo = {};
  const inStack = new Set();
  function resolve(name) {
    if (name in memo) return memo[name];
    if (name in env) return env[name];
    const v = vars[name];
    if (!v) throw new Error(_etf('err.unknownVar', name));
    if (inStack.has(name)) throw new Error(_etf('err.varCycle', name));
    inStack.add(name);
    const kf = v.kf || [];
    const val = (kf.length > 0) ? varKfValue(kf, ctx.t || 0) : execRpn(getCompiledVarExpr(v), resolve);
    inStack.delete(name);
    memo[name] = val;
    return val;
  }
  for (const name in vars) {
    if (ATTR_NAMES.includes(name)) throw new Error(_etf('err.varReserved', name));
    resolve(name);
  }
  for (const name in memo) env[name] = memo[name];
  return env;
}

function exprUsesT(expr) {
  const e = (expr || '').trim();
  if (!e) return false;
  try { return tokenize(e).some(tk => tk.t === 'var' && tk.name === 't'); }
  catch (err) { return false; }
}

// 求值单个粒子在某时刻的完整状态（执行公式代码块）
function evaluateParticleAt(fx, i, n, t) {
  const fn = getCompiledFn(fx);
  if (fn) {
    const center = fx.center || [0, 0, 0];
    return fn(i, n, t, center[0], center[1], center[2], ...resolveVarVals(fx, i, n, t), { pos: [0, 0, 0], color: [0, 0, 0, 0], vel: [0, 0, 0], scale: 1, glow: false, light: 0 });
  }
  const env = buildEnv(fx.vars || {}, { i, n, t });
  const out = execFunctionCode(getCompiledCode(fx), env);
  const center = fx.center || [0, 0, 0];
  const clamp01 = x => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
  return {
    pos: [out.pos[0] + center[0], out.pos[1] + center[1], out.pos[2] + center[2]],
    color: out.color.map(clamp01),
    vel: [out.vel[0], out.vel[1], out.vel[2]],
    scale: Number.isFinite(out.scale) ? out.scale : 1,
    glow: !!out.glow,
    light: Math.max(0, Math.min(15, Math.round(out.light))),
  };
}
function evaluateParticleBase(fx, i, n) { return evaluateParticleAt(fx, i, n, 0); }

const eq3 = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-9);

// 生成函数派生轨道（公式/变量随时间变化时按 duration/step 采样）
function buildDerivedTracks(fx) {
  const n = Math.max(1, Math.round(fx.count) || 1);
  const duration = Math.max(0, Math.round(fx.duration) || 0);
  const step = Math.max(1, Math.round(fx.step) || 1);
  if (duration <= 0) return;
  const hasVarAnim = Object.values(fx.vars || {}).some(v => (v.kf || []).length > 1 || exprUsesT(v.expr));
  if (!exprUsesT(fx.code) && !hasVarAnim) return;

  // 收集动画源关键帧（变量 kf + 整体轨道 kf）
  const sources = [];
  for (const v of Object.values(fx.vars || {})) {
    const kf = (v.kf || []).slice().sort((a, b) => a[0] - b[0]);
    if (kf.length > 1) sources.push(kf);
  }
  for (const tr of state.tracks) {
    if (tr.ids.some(id => id.startsWith('f:'))) {
      const kf = tr.kf.slice().sort((a, b) => a[0] - b[0]);
      if (kf.length > 1) sources.push(kf);
    }
  }

  // 关键帧 tick 对齐 + 各段缓动一致 → 用「关键帧 + 缓动」（连续、丝滑、体积小）；否则均匀采样 + LINEAR
  let uniform = !exprUsesT(fx.code) && sources.length > 0;
  if (uniform) {
    const baseTicks = sources[0].map(k => k[0]).join(',');
    for (const src of sources) {
      if (src.map(k => k[0]).join(',') !== baseTicks) { uniform = false; break; }
    }
  }
  if (uniform) {
    for (let i = 1; i < sources[0].length; i++) {
      const e = sources[0][i][2];
      for (const src of sources) {
        if (src[i][2] !== e) { uniform = false; break; }
      }
      if (!uniform) break;
    }
  }

  let times, easingAt;
  if (uniform) {
    times = sources[0].map(k => k[0]).filter(t => t <= duration);
    if (times.length < 2) times = [0, duration];
    // 编辑器 b[2] 语义：关键帧 idx 的 easing 控制 idx-1→idx 段
    easingAt = (idx) => (idx === 0 || idx >= sources[0].length) ? 0 : sources[0][idx][2];
  } else {
    times = [0];
    for (let t = step; t <= duration; t += step) times.push(t);
    easingAt = () => 0;
  }

  for (let i = 0; i < n; i++) {
    const pid = fx.id + ':p' + i;
    const samples = times.map(t => evaluateParticleAt(fx, i, n, t));
    const base = samples[0];
    const changed = (key) => samples.some(s => s !== base && !eq3(s[key], base[key]));
    const pushComp = (prop, comps, getVal) => {
      comps.forEach((comp, ci) => {
        const kfs = samples.map((_, idx) => [times[idx], getVal(idx, ci), easingAt(idx)]);
        if (kfs.some(k => Math.abs(k[1] - kfs[0][1]) > 1e-9)) {
          state.tracks.push({ pr: compPr(prop, comp), m: 'set', ids: [pid], kf: kfs, fx: fx.id });
        }
      });
    };
    if (changed('pos')) pushComp('pos', ['x', 'y', 'z'], (idx, ci) => samples[idx].pos[ci]);
    if (changed('color')) pushComp('col', ['r', 'g', 'b', 'a'], (idx, ci) => samples[idx].color[ci]);
    if (changed('vel')) pushComp('vel', ['x', 'y', 'z'], (idx, ci) => samples[idx].vel[ci]);
    if (samples.some(s => Math.abs(s.scale - base.scale) > 1e-9)) {
      const kfs = samples.map((_, idx) => [times[idx], samples[idx].scale, easingAt(idx)]);
      ['x', 'y', 'z'].forEach(comp => {
        state.tracks.push({ pr: 'scl.' + comp, m: 'set', ids: [pid], kf: kfs.map(k => k.slice()), fx: fx.id });
      });
    }
  }
}

// 活源重算：按当前函数定义重建派生粒子与派生轨道。
// 派生粒子 id 约定为 `fxId:p<i>`，据此清理旧格式（无 fx 标记）残留的派生粒子与派生轨道。
function rebuildFunctionObject(fx) {
  // 失效编译缓存（code/vars/count 可能已变）
  fx._compiledFn = undefined;
  fx._compiledCode = undefined;
  fx._varNames = undefined;
  fx._constVarVals = undefined;
  const n = Math.max(1, Math.round(fx.count) || 1);
  const prefix = fx.id + ':p';
  // 移除函数派生轨道：新格式（带 fx 标记）+ 旧格式（ids 命中 fxId:p 前缀）一并清除
  state.tracks = state.tracks.filter(tr => tr.fx !== fx.id && !tr.ids.some(id => id.startsWith(prefix)));
  const existing = new Map();
  // 复用带 fx 标记的派生粒子；旧格式残留（无 fx 标记但 id 命中前缀）直接移除
  for (const p of [...state.particles]) {
    if (!p.id.startsWith(prefix)) continue;
    if (p.fx === fx.id) existing.set(p.id, p);
    else {
      state.particles = state.particles.filter(x => x !== p);
      state.tracks = state.tracks.filter(tr => !tr.ids.includes(p.id));
      state.selected.delete(p.id);
    }
  }
  const kept = new Set();
  for (let i = 0; i < n; i++) {
    const id = fx.id + ':p' + i;
    kept.add(id);
    const base = evaluateParticleBase(fx, i, n);
    let p = existing.get(id);
    if (!p) {
      p = { id, fx: fx.id, color: [1, 1, 1, 1], scale: [1, 1, 1], glow: false, lightLevel: 0, pos: [0, 0, 0], vel: [0, 0, 0] };
      state.particles.push(p);
    }
    p._fxIdx = i; // 缓存粒子序号，避免 currentVisualDerived 里 parse id
    p.color = base.color.slice();
    p.scale = [base.scale, base.scale, base.scale];
    p.glow = base.glow;
    p.lightLevel = base.light;
    p.pos = base.pos.slice();
    p.vel = base.vel.slice();
  }
  for (const p of [...state.particles]) {
    if (p.fx === fx.id && !kept.has(p.id)) {
      state.particles = state.particles.filter(x => x !== p);
      state.tracks = state.tracks.filter(tr => !tr.ids.includes(p.id));
      state.selected.delete(p.id);
    }
  }
  buildDerivedTracks(fx);
  rebuildPoints();
  refreshParticleTree();
  setDirty(true);
}

// 预设：按参数生成代码块 + 变量（改参数时不重置 count）
function applyPresetBuild(fx) {
  const preset = FUNCTION_PRESETS[fx.preset];
  if (!preset) return;
  const built = preset.build(fx.params || {});
  fx.vars = { ...built.vars };
  fx.code = built.code;
}

// 分辨率变量联动 count：改 m/k/cols/rows/turns/ppr 时重算 count=乘积
function syncPresetCount(fx) {
  const preset = FUNCTION_PRESETS[fx.preset];
  if (!preset) return;
  // 先把所有变量求值为 scope（供 countExpr 或 countVars 使用）
  const scope = { i: 0, n: 1, t: 0 };
  for (const name in fx.vars) {
    try { scope[name] = evaluate(fx.vars[name].expr || '0', scope); } catch (e) { return; }
  }
  let count;
  if (preset.countExpr) {
    try { count = evaluate(preset.countExpr, scope); } catch (e) { return; }
  } else if (preset.countVars && preset.countVars.length) {
    count = 1;
    for (const name of preset.countVars) {
      const val = scope[name];
      if (!Number.isFinite(val) || val <= 0) return;
      count *= Math.round(val);
    }
  } else {
    return;
  }
  if (!Number.isFinite(count) || count <= 0) return;
  fx.count = Math.max(1, Math.round(count));
}

function applyPreset(fx, presetId) {
  const preset = FUNCTION_PRESETS[presetId];
  if (!preset) return;
  fx.preset = presetId;
  fx.params = {};
  for (const p of preset.params) fx.params[p.key] = p.def;
  const built = preset.build(fx.params);
  fx.vars = { ...built.vars };
  fx.code = built.code;
  // 声明了 countVars/countExpr 的预设：采样数按变量联动求值；否则用模板默认值
  if (preset.countExpr || (preset.countVars && preset.countVars.length)) syncPresetCount(fx);
  else fx.count = built.count;
}

function createFunctionObject(presetId) {
  pushUndo();
  const fx = {
    id: nextFunctionId(), name: presetId ? t('fx.preset.' + presetId) : t('fx.defaultName'),
    center: [0, 0, 0], count: 30,
    code: '[x,y,z] = [0, 0, 0];\n[r,g,b,a] = [1,1,1,1];\nglow = 0;\nlight = 0',
    vars: {}, duration: 100, step: 5, preset: null, params: null,
  };
  state.functions.push(fx);
  if (presetId) applyPreset(fx, presetId);
  state.selectedFunction = fx.id;
  state.selected = new Set();
  state.selectedGroup = null;
  try {
    rebuildFunctionObject(fx);
  } catch (e) {
    modalAlert(t('fx.exprError'), e.message);
  }
  refreshParticleTree();
  refreshFunctionPanel();
  return fx;
}

function deleteFunctionObject(fxId) {
  pushUndo();
  state.functions = state.functions.filter(f => f.id !== fxId);
  for (const p of [...state.particles]) {
    if (p.fx === fxId) {
      state.particles = state.particles.filter(x => x !== p);
      state.tracks = state.tracks.filter(tr => !tr.ids.includes(p.id));
      state.selected.delete(p.id);
    }
  }
  state.tracks = state.tracks.filter(tr => !tr.ids.includes('f:' + fxId)); // 移除整体变换轨道
  if (state.selectedFunction === fxId) state.selectedFunction = null;
  state.expandedParticles.delete('f:' + fxId);
  rebuildPoints();
  refreshParticleTree();
  refreshFunctionPanel();
}
