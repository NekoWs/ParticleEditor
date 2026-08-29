/* =========================================================================
 * 函数对象：活源重算
 * 职责：
 *   1) 脚本编译缓存（setup / process → AST）
 *   2) setup（对象级）与 process（粒子级）求值
 *   3) 派生粒子与派生轨道的重建（rebuildFunctionObject / buildDerivedTracks）
 *   4) 预设应用与采样数联动（applyPreset / syncPresetCount / createFunctionObject）
 * ======================================================================= */

import { _etf, t } from './i18n.js';
import { FUNCTION_PRESETS, state, nextFunctionId, setDirty, compPr, getParticle } from './constants.js';
import { varKfValue, evaluate, ATTR_NAMES } from './easing.js';
import { modalAlert } from '../ui/ui.js';
import { pushUndo } from '../state/undo.js';
import { rebuildPoints } from './animation.js';
import { refreshFunctionPanel } from '../ui/panels.js';
import { parseProgram, createObjectState, runSetup, createStatics, evalProcess, runUniformPrelude } from './script-lang.js';

// 主循环中 1 秒 = 20 tick（见 main.js 的 `state.time += dt * 20`）。
const TICKS_PER_SEC = 20;
const DT_PER_TICK = 1 / TICKS_PER_SEC;

/* -------------------------------------------------------------------------
 * 脚本编译缓存
 * ---------------------------------------------------------------------- */

export function getProgram(fx) {
  // 只比较两端源码，避免每次调用拼接整段字符串（getProgram 处于每粒子热路径）。
  const setup = (fx.setup || '').trim();
  const process = (fx.process || '').trim();
  if (fx._program === undefined || fx._programSrcSetup !== setup || fx._programSrcProcess !== process) {
    fx._program = parseProgram('setup {\n' + setup + '\n}\nprocess {\n' + process + '\n}\n');
    fx._programSrcSetup = setup;
    fx._programSrcProcess = process;
  }
  return fx._program;
}

/* -------------------------------------------------------------------------
 * 变量（fx.vars，时间轴动画变量，只读注入）
 * ---------------------------------------------------------------------- */

export function varValueAt(v, t) {
  const kf = v && v.kf ? v.kf : [];
  return (kf.length > 0) ? varKfValue(kf, t || 0) : (v && Number.isFinite(v.base) ? v.base : 0);
}

function varsAt(fx, t) {
  const env = {};
  for (const name in (fx.vars || {})) env[name] = varValueAt(fx.vars[name], t || 0);
  return env;
}

// 旧 API 兼容：构造变量环境（仅测试/外部调用使用）。
export function buildEnv(vars, ctx) {
  const env = { i: ctx.i, n: ctx.n, t: ctx.t || 0 };
  for (const name in (vars || {})) {
    if (ATTR_NAMES.includes(name)) throw new Error(_etf('err.varReserved', name));
    env[name] = varValueAt(vars[name], ctx.t);
  }
  return env;
}

/* -------------------------------------------------------------------------
 * setup / process 求值
 * ---------------------------------------------------------------------- */

function gridCols(fx, n) {
  const v = fx.vars && fx.vars['grid_cols'];
  if (v && Number.isFinite(v.base)) return Math.max(1, Math.round(v.base));
  return Math.max(1, Math.ceil(Math.sqrt(n)));
}

function uvFor(fx, n, i) {
  const C = gridCols(fx, n);
  const R = Math.max(1, Math.ceil(n / C));
  const col = i % C;
  const row = Math.floor(i / C);
  return {
    uv_x: (C === 1) ? 0 : col / (C - 1),
    uv_y: (R === 1) ? 0 : row / (R - 1),
  };
}

function lifeAt(fx, t) {
  const dur = fx.duration || 0;
  if (dur <= 0) return 0;
  const st = fx.st || 0;
  return Math.min(1, Math.max(0, (t - st) / dur));
}

function getObjectState(fx) {
  if (fx._objState !== undefined) return fx._objState;
  const program = getProgram(fx);
  const n = Math.max(1, Math.round(fx.count) || 1);
  const st = fx.st || 0;
  const objState = createObjectState(fx.seed | 0);
  runSetup(program, objState, { n, t: st, vars: varsAt(fx, st) });
  fx._objState = objState;
  return objState;
}

// 每 (fx, n, t, dt) 求值上下文：vars 对象与 uniform 值只算一次，同帧所有粒子广播。
function getEvalContext(fx, objState, n, t, dt) {
  const key = (t || 0) + '|' + n + '|' + (dt || 0);
  if (fx._evalCtx && fx._evalCtx.key === key) return fx._evalCtx;
  const varsObj = varsAt(fx, t || 0);
  const life = lifeAt(fx, t || 0);
  const program = getProgram(fx);
  const preCtx = {
    i: 0, n, t: t || 0, dt: dt || 0,
    life, uv_x: 0, uv_y: 0,
    vars: varsObj, fastMath: !!fx.fastMath,
    out: { pos: [0, 0, 0], color: [1, 1, 1, 1], vel: [0, 0, 0], scale: 1, glow: false, light: 0 },
  };
  const uniforms = runUniformPrelude(program, objState, null, preCtx);
  const ctx = { key, varsObj, life, uniforms };
  fx._evalCtx = ctx;
  return ctx;
}

function evalParticleFor(fx, objState, statics, i, n, t, dt) {
  const program = getProgram(fx);
  const evalCtx = getEvalContext(fx, objState, n, t || 0, dt || 0);
  const uv = uvFor(fx, n, i);
  const ctx = {
    i, n, t: t || 0, dt: dt || 0,
    life: evalCtx.life,
    uv_x: uv.uv_x, uv_y: uv.uv_y,
    vars: evalCtx.varsObj,
    fastMath: !!fx.fastMath,
    uniforms: evalCtx.uniforms,
    out: { pos: [0, 0, 0], color: [1, 1, 1, 1], vel: [0, 0, 0], scale: 1, glow: false, light: 0 },
  };
  evalProcess(program, objState, statics, ctx);
  const out = ctx.out;
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

// 求值单个粒子在某时刻的完整状态（供 currentVisualDerived 等外部调用）。
export function evaluateParticleAt(fx, i, n, t) {
  const objState = getObjectState(fx);
  const p = getParticle(fx.id + ':p' + i);
  const statics = (p && p._statics) || createStatics();
  return evalParticleFor(fx, objState, statics, i, Math.max(1, Math.round(n) || 1), t || 0, 0);
}

export function evaluateParticleBase(fx, i, n) {
  return evaluateParticleAt(fx, i, n, 0);
}

/* 校验脚本但不改动任何粒子/轨道状态；成功返回 null，失败返回 Error（含行列号）。 */
export function validateFunctionScript(fx, setupOverride, processOverride) {
  const setup = (setupOverride != null ? setupOverride : (fx.setup || '')).trim();
  const process = (processOverride != null ? processOverride : (fx.process || '')).trim();
  const program = parseProgram('setup {\n' + setup + '\n}\nprocess {\n' + process + '\n}\n');
  const n = Math.max(1, Math.round(fx.count) || 1);
  const objState = createObjectState(fx.seed | 0);
  runSetup(program, objState, { n, t: fx.st || 0, vars: varsAt(fx, fx.st || 0) });
  const statics = createStatics();
  const t = 0;
  const uv = uvFor(fx, n, 0);
  const ctx = {
    i: 0, n, t, dt: 0,
    life: lifeAt(fx, t),
    uv_x: uv.uv_x, uv_y: uv.uv_y,
    vars: varsAt(fx, t),
    fastMath: !!fx.fastMath,
    uniforms: null,
    out: { pos: [0, 0, 0], color: [1, 1, 1, 1], vel: [0, 0, 0], scale: 1, glow: false, light: 0 },
  };
  evalProcess(program, objState, statics, ctx);
  return null;
}

export const eq3 = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-9);

/* -------------------------------------------------------------------------
 * 派生轨道采样
 * ---------------------------------------------------------------------- */

export function buildDerivedTracks(fx) {
  const n = Math.max(1, Math.round(fx.count) || 1);
  const duration = Math.max(0, Math.round(fx.duration) || 0);
  const step = Math.max(1, Math.round(fx.step) || 1);
  if (duration <= 0) return;
  const hasAnim = Object.values(fx.vars || {}).some(v => (v.kf || []).length > 1) ||
    (fx.setup || '').trim() !== '' || (fx.process || '').trim() !== '';
  if (!hasAnim) return;

  const objState = getObjectState(fx);
  const times = [0];
  for (let t = step; t <= duration; t += step) times.push(t);

  for (let i = 0; i < n; i++) {
    const pid = fx.id + ':p' + i;
    const p = getParticle(pid);
    if (!p) continue;
    const statics = createStatics();
    p._statics = statics;

    const samples = [];
    for (let si = 0; si < times.length; si++) {
      const t = times[si];
      const dt = si === 0 ? 0 : (times[si] - times[si - 1]) * DT_PER_TICK;
      samples.push(evalParticleFor(fx, objState, statics, i, n, t, dt));
    }

    const base = samples[0];
    const changed = (key) => samples.some(s => s !== base && !eq3(s[key], base[key]));
    const pushComp = (prop, comps, getVal) => {
      comps.forEach((comp, ci) => {
        const kfs = samples.map((_, idx) => [times[idx], getVal(idx, ci), 0]);
        if (kfs.some(k => Math.abs(k[1] - kfs[0][1]) > 1e-9)) {
          state.tracks.push({ pr: compPr(prop, comp), m: 'set', ids: [pid], kf: kfs, fx: fx.id });
        }
      });
    };
    if (changed('pos')) pushComp('pos', ['x', 'y', 'z'], (idx, ci) => samples[idx].pos[ci]);
    if (changed('color')) pushComp('col', ['r', 'g', 'b', 'a'], (idx, ci) => samples[idx].color[ci]);
    if (changed('vel')) pushComp('vel', ['x', 'y', 'z'], (idx, ci) => samples[idx].vel[ci]);
    if (samples.some(s => Math.abs(s.scale - base.scale) > 1e-9)) {
      const kfs = samples.map((_, idx) => [times[idx], samples[idx].scale, 0]);
      ['x', 'y', 'z'].forEach(comp => {
        state.tracks.push({ pr: 'scl.' + comp, m: 'set', ids: [pid], kf: kfs.map(k => k.slice()), fx: fx.id });
      });
    }
  }
}

/* -------------------------------------------------------------------------
 * 函数对象重建
 * ---------------------------------------------------------------------- */

export function rebuildFunctionObject(fx) {
  // 失效脚本与对象级缓存
  fx._program = undefined;
  fx._programSrcSetup = undefined;
  fx._programSrcProcess = undefined;
  fx._objState = undefined;
  fx._evalCtx = undefined;

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

  // setup 执行一次得到对象级环境（含 global、数组、PRNG 状态）。
  const objState = getObjectState(fx);

  const kept = new Set();
  for (let i = 0; i < n; i++) {
    const id = fx.id + ':p' + i;
    kept.add(id);
    let p = existing.get(id);
    if (!p) {
      p = { id, fx: fx.id, color: [1, 1, 1, 1], scale: [1, 1, 1], glow: false, lightLevel: 0, pos: [0, 0, 0], vel: [0, 0, 0] };
      state.particles.push(p);
    }
    p._fxIdx = i;
    const statics = createStatics();
    const base = evalParticleFor(fx, objState, statics, i, n, 0, 0);
    p._statics = statics;
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
  setDirty(true);
}

/* -------------------------------------------------------------------------
 * 预设
 * ---------------------------------------------------------------------- */

// 预设：按参数生成 setup/process + 变量（改参数时不重置 count）
export function applyPresetBuild(fx) {
  const preset = FUNCTION_PRESETS[fx.preset];
  if (!preset) return;
  const built = preset.build(fx.params || {});
  fx.vars = { ...built.vars };
  fx.setup = built.setup || '';
  fx.process = built.process || '';
}

// 分辨率变量联动 count：改 m/k/cols/rows/turns/ppr 时重算 count=乘积
export function syncPresetCount(fx) {
  const preset = FUNCTION_PRESETS[fx.preset];
  if (!preset) return;
  // 先把所有变量求值为 scope（供 countExpr 或 countVars 使用）
  const scope = { i: 0, n: 1, t: 0 };
  for (const name in fx.vars) {
    const v = fx.vars[name];
    scope[name] = varValueAt(v, 0);
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

export function applyPreset(fx, presetId) {
  const preset = FUNCTION_PRESETS[presetId];
  if (!preset) return;
  fx.preset = presetId;
  fx.params = {};
  for (const p of preset.params) fx.params[p.key] = p.def;
  const built = preset.build(fx.params);
  fx.vars = { ...built.vars };
  fx.setup = built.setup || '';
  fx.process = built.process || '';
  // 声明了 countVars/countExpr 的预设：采样数按变量联动求值；否则用模板默认值
  if (preset.countExpr || (preset.countVars && preset.countVars.length)) syncPresetCount(fx);
  else fx.count = built.count;
}

export function createFunctionObject(presetId) {
  pushUndo();
  const fx = {
    id: nextFunctionId(), name: presetId ? t('fx.preset.' + presetId) : t('fx.defaultName'),
    center: [0, 0, 0], count: 30,
    setup: '',
    process: '[x,y,z] = [0, 0, 0];\n[r,g,b,a] = [1,1,1,1];\nglow = 0;\nlight = 0',
    seed: 0,
    vars: {}, duration: 100, step: 5, preset: null, params: null,
    fastMath: false,
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
  refreshFunctionPanel();
  return fx;
}

export function deleteFunctionObject(fxId) {
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
  refreshFunctionPanel();
}