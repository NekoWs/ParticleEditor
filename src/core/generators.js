/* =========================================================================
 * 函数对象：spawn 运行时（v12，fx.source 单一源码）
 * 职责：
 *   1) 脚本编译缓存（fx.source → AST）
 *   2) 运行时粒子列表管理（spawn / kill / 寿命递减）
 *   3) 帧调度：补跑 tick() → 跑一次 process(deltaMs)
 *   4) 预设应用与函数对象增删改
 * ======================================================================= */

import { t } from './i18n.js';
import { FUNCTION_PRESETS, state, nextFunctionId, setDirty } from './constants.js';
import { varKfValue } from './easing.js';
import { modalAlert } from '../ui/ui.js';
import { pushUndo } from '../state/undo.js';
import { rebuildPoints, maxTick } from './animation.js';
import { refreshFunctionPanel } from '../ui/panels.js';
import { parseProgram, createObjectState, runSetup, runTick, runProcessFrame } from './script-lang.js';

// 主循环中 1 秒 = 20 tick（见 main.js）。
const TICKS_PER_SEC = 20;
const DT_PER_TICK = 1 / TICKS_PER_SEC;

// 把各代码段组装成完整源码（拼图关闭时写回 fx.source 使用）。
export function buildScriptSource(setup, process, tick, funcs, processParam) {
  const parts = [];
  const st = (setup || '').trim();
  const tk = (tick || '').trim();
  const pr = (process || '').trim();
  const fn = (funcs || '').trim();
  if (fn) parts.push(fn);
  if (st) parts.push('func setup() {\n' + st + '\n}');
  if (tk) parts.push('func tick() {\n' + tk + '\n}');
  if (pr) parts.push('func process(' + (processParam || 'delta') + ') {\n' + pr + '\n}');
  return parts.join('\n');
}

/* -------------------------------------------------------------------------
 * 脚本编译缓存
 * ---------------------------------------------------------------------- */

export function getProgram(fx) {
  const src = (fx.source || '').trim();
  if (fx._program === undefined || fx._programSrc !== src) {
    fx._program = parseProgram(src);
    fx._programSrc = src;
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
  for (const name in (vars || {})) env[name] = varValueAt(vars[name], ctx.t);
  return env;
}

/* -------------------------------------------------------------------------
 * 终端输出
 * ---------------------------------------------------------------------- */

export function fxTerminalClear(fx) {
  if (fx) fx._terminal = [];
}

export function fxTerminalPush(fx, line) {
  if (!fx) return;
  if (!Array.isArray(fx._terminal)) fx._terminal = [];
  fx._terminal.push(String(line));
}

/* -------------------------------------------------------------------------
 * 粒子存储与运行时
 * ---------------------------------------------------------------------- */

function markFxError(fx, e) {
  if (fx) {
    fx._error = (e && e.message) ? e.message : String(e);
    fxTerminalPush(fx, '[error] ' + fx._error);
  }
}

function newParticleWrapper(fx, runtime) {
  const serial = runtime.spawnSerial++;
  return {
    pos: [0, 0, 0],
    color: [1, 1, 1, 1],
    vel: [0, 0, 0],
    scale: 1,
    glow: false,
    light: 0,
    life: -1,
    index: serial,
    fields: new Map(),
    alive: true,
    _spawnTick: runtime.curTick,
    _p: null,
    kill() { killParticle(fx, runtime, this); },
  };
}

function syncParticleState(p) {
  const w = p._w;
  if (!w) return;
  const s = Number.isFinite(w.scale) ? w.scale : 1;
  p.scale[0] = s; p.scale[1] = s; p.scale[2] = 1;
  p.glow = !!w.glow;
  p.lightLevel = Math.max(0, Math.min(15, Math.round(w.light)));
  p.life = Number.isFinite(w.life) ? w.life : -1;
}

function attachParticle(fx, w) {
  const p = {
    id: fx.id + ':p' + w.index,
    fx: fx.id,
    pos: w.pos,
    color: w.color,
    vel: w.vel,
    scale: [1, 1, 1],
    glow: false,
    lightLevel: 0,
    life: -1,
    _fxIdx: w.index,
    _w: w,
  };
  w._p = p;
  state.particles.push(p);
  syncParticleState(p);
  return p;
}

function spawnFor(fx, runtime) {
  const w = newParticleWrapper(fx, runtime);
  runtime.particles.push(w);
  attachParticle(fx, w);
  return w;
}

function removeStateParticle(p) {
  const si = state.particles.indexOf(p);
  if (si >= 0) state.particles.splice(si, 1);
  state.tracks = state.tracks.filter(tr => !tr.ids.includes(p.id));
  state.selected.delete(p.id);
}

function killParticle(fx, runtime, w) {
  if (!w.alive) return;
  w.alive = false;
  const li = runtime.particles.indexOf(w);
  if (li >= 0) runtime.particles.splice(li, 1);
  if (w._p) removeStateParticle(w._p);
}

function dropAllParticles(fx) {
  for (const p of [...state.particles]) {
    if (p.fx === fx.id) removeStateParticle(p);
  }
  if (fx._runtime) {
    fx._runtime.particles.length = 0;
    fx._runtime.spawnSerial = 0;
  }
}

// 每个 tick 开始前递减剩余寿命；到期（或 life 已为 0）立即移除。
// entry = max(spawnTick, fx.st)：setup 中 spawn 的粒子从 st 开始倒计时。
function decrementLife(fx, runtime, tick) {
  const st = fx.st || 0;
  for (let i = runtime.particles.length - 1; i >= 0; i--) {
    const w = runtime.particles[i];
    const entry = Math.max(w._spawnTick, st);
    if (w.life >= 0 && tick > entry) {
      if (w.life <= 1) {
        killParticle(fx, runtime, w);
      } else {
        w.life -= 1;
      }
    }
  }
}

function ensureRuntime(fx) {
  if (fx._runtime) return fx._runtime;
  const program = getProgram(fx);
  const objState = createObjectState(fx.seed | 0);
  const st = fx.st || 0;
  const runtime = {
    particles: [],
    spawnSerial: 0,
    tickCursor: Math.floor(st) - 1,
    curTick: st,
    objState,
    program,
  };
  fx._runtime = runtime;
  const spawn = () => spawnFor(fx, runtime);
  runSetup(program, objState, {
    t: st,
    duration: maxTick(),
    vars: varsAt(fx, st),
    particles: runtime.particles,
    spawn,
    print: line => fxTerminalPush(fx, line),
  });
  for (const w of runtime.particles) {
    if (w._p) syncParticleState(w._p);
  }
  return runtime;
}

function makeCtx(fx, runtime, T, deltaMs) {
  return {
    t: T,
    duration: maxTick(),
    vars: varsAt(fx, T),
    particles: runtime.particles,
    spawn: () => spawnFor(fx, runtime),
    deltaMs: deltaMs || 0,
    fastMath: !!fx.fastMath,
    print: line => fxTerminalPush(fx, line),
  };
}

/* -------------------------------------------------------------------------
 * 帧调度：把函数对象推进到时间 T。
 *  - T < st：仅保证 setup 已执行（初始粒子存在但由渲染层按 st 隐藏）
 *  - 超过 duration：不再运行 tick/process（粒子保留、渲染层隐藏）
 *  - 正常：补跑 (lastTick, floor(T)] 的 tick()，再跑一次 process(deltaMs)
 *  - 向后 seek：重建运行时（清空粒子、重跑 setup、重置 tick 游标）
 * ---------------------------------------------------------------------- */

export function evaluateFxFrame(fx, T, deltaMs) {
  const st = fx.st || 0;
  const dur = fx.duration || 0;
  if (T < st) {
    try { ensureRuntime(fx); } catch (e) { markFxError(fx, e); }
    return;
  }
  if (dur > 0 && T >= st + dur) {
    try { ensureRuntime(fx); } catch (e) { markFxError(fx, e); }
    return;
  }

  let runtime;
  try {
    runtime = ensureRuntime(fx);
  } catch (e) {
    markFxError(fx, e);
    return;
  }

  // 向后 seek：确定性重算。
  if (T < runtime.tickCursor) {
    dropAllParticles(fx);
    fx._runtime = null;
    try {
      runtime = ensureRuntime(fx);
    } catch (e) {
      markFxError(fx, e);
      return;
    }
  }

  const floorT = Math.floor(T);
  while (runtime.tickCursor < floorT) {
    runtime.tickCursor += 1;
    runtime.curTick = runtime.tickCursor;
    decrementLife(fx, runtime, runtime.tickCursor);
    if (runtime.program.tick) {
      try {
        runTick(runtime.program, runtime.objState, makeCtx(fx, runtime, runtime.tickCursor, deltaMs));
      } catch (e) {
        markFxError(fx, e);
        break;
      }
    }
  }

  runtime.curTick = T;
  if (runtime.program.process) {
    try {
      runProcessFrame(runtime.program, runtime.objState, makeCtx(fx, runtime, T, deltaMs));
    } catch (e) {
      markFxError(fx, e);
    }
  }
  for (const w of runtime.particles) {
    if (w._p) syncParticleState(w._p);
  }
}

/* -------------------------------------------------------------------------
 * 函数对象重建
 * ---------------------------------------------------------------------- */

export function rebuildFunctionObject(fx) {
  fx._program = undefined;
  fx._programSrc = undefined;
  fx._error = null;
  fxTerminalClear(fx);
  dropAllParticles(fx);
  fx._runtime = null;
  try {
    ensureRuntime(fx);
  } catch (e) {
    markFxError(fx, e);
    dropAllParticles(fx);
    fx._runtime = null;
  }
  rebuildPoints();
  setDirty(true);
}

/* 校验源码但不改动任何粒子/轨道状态；成功返回 null，失败返回 Error。 */
export function validateFunctionScript(fx, sourceOverride) {
  const src = (sourceOverride != null ? sourceOverride : (fx.source || '')).trim();
  const program = parseProgram(src);
  const objState = createObjectState(fx.seed | 0);
  const st = fx.st || 0;
  const particles = [];
  let serial = 0;
  const spawn = () => {
    const w = {
      pos: [0, 0, 0], color: [1, 1, 1, 1], vel: [0, 0, 0],
      scale: 1, glow: false, light: 0, life: -1,
      index: serial++, fields: new Map(), alive: true, _spawnTick: st,
      kill() { this.alive = false; },
    };
    particles.push(w);
    return w;
  };
  const env = { t: st, duration: maxTick(), vars: varsAt(fx, st), particles, spawn, print: () => {} };
  runSetup(program, objState, env);
  if (program.tick) runTick(program, objState, env);
  if (program.process) runProcessFrame(program, objState, { ...env, deltaMs: 0 });
  return null;
}

/* -------------------------------------------------------------------------
 * 预设
 * ---------------------------------------------------------------------- */

export function applyPresetBuild(fx) {
  const preset = FUNCTION_PRESETS[fx.preset];
  if (!preset) return;
  const built = preset.build(fx.params || {});
  fx.vars = { ...built.vars };
  fx.source = built.source || '';
}

export function applyPreset(fx, presetId) {
  const preset = FUNCTION_PRESETS[presetId];
  if (!preset) return;
  fx.preset = presetId;
  fx.params = {};
  for (const p of preset.params) fx.params[p.key] = p.def;
  applyPresetBuild(fx);
}

export function createFunctionObject(presetId) {
  pushUndo();
  const fx = {
    id: nextFunctionId(), name: presetId ? t('fx.preset.' + presetId) : t('fx.defaultName'),
    center: [0, 0, 0],
    source: '',
    seed: 0,
    vars: {},
    duration: 100,
    preset: null,
    params: null,
    fastMath: false,
    spinSpace: 'local',
    rotSpace: 'local',
  };
  state.functions.push(fx);
  if (presetId) applyPreset(fx, presetId);
  state.selectedFunction = fx.id;
  state.selected = new Set();
  state.selectedGroup = null;
  state.selectedCamera = null; // 新建函数对象即选中它，取消摄像机选中
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
  const fx = state.functions.find(f => f.id === fxId);
  if (fx) dropAllParticles(fx);
  state.functions = state.functions.filter(f => f.id !== fxId);
  state.tracks = state.tracks.filter(tr => !tr.ids.includes('f:' + fxId)); // 移除整体变换轨道
  if (state.selectedFunction === fxId) state.selectedFunction = null;
  state.expandedParticles.delete('f:' + fxId);
  rebuildPoints();
  refreshFunctionPanel();
}