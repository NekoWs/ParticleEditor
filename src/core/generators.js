// 函数对象 spawn 运行时（fx.source 单一源码）：脚本编译缓存、运行时粒子列表（spawn/kill/寿命递减）、
// 帧调度（补跑 tick → 跑一次 process）、预设应用与函数对象增删改。

import { t } from './i18n.js';
import { FUNCTION_PRESETS, state, nextFunctionId, setDirty } from './constants.js';
import { varKfValue } from './easing.js';
import { modalAlert } from '../ui/ui.js';
import { pushUndo } from '../state/undo.js';
import { rebuildPoints, maxMs } from './animation.js';
import { refreshFunctionPanel } from '../ui/panels.js';
import { parseProgram, createObjectState, runSetup, runTick, runProcessFrame, runTopLevel } from './script-lang.js';
import { localizeScriptError } from './script-error-i18n.js';

// 把各代码段组装成完整源码（拼图关闭时写回 fx.source 使用）。
export function buildScriptSource(setup, process, tick, funcs, globals) {
  const parts = [];
  const st = (setup || '').trim();
  const tk = (tick || '').trim();
  const pr = (process || '').trim();
  const fn = (funcs || '').trim();
  const gl = (globals || '').trim();
  // 函数体整体缩进一层，与拼图生成的 func 语句保持一致。
  const indentBody = (text) => text ? text.split('\n').map(l => '  ' + l).join('\n') : '';
  if (gl) parts.push(gl);
  if (fn) parts.push(fn);
  if (st) parts.push('func setup() {\n' + indentBody(st) + '\n}');
  if (tk) parts.push('func tick() {\n' + indentBody(tk) + '\n}');
  if (pr) parts.push('func process() {\n' + indentBody(pr) + '\n}');
  return parts.join('\n');
}

// —— 脚本编译缓存 ——

export function getProgram(fx) {
  const src = (fx.source || '').trim();
  if (fx._program === undefined || fx._programSrc !== src) {
    fx._program = parseProgram(src);
    fx._programSrc = src;
  }
  return fx._program;
}

// —— 变量（fx.vars，时间轴动画变量，只读注入）——

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

// —— 终端输出 ——

export function fxTerminalClear(fx) {
  if (fx) fx._terminal = [];
}

// 终端输出：每条为一行 { kind:'info'|'error', text, count }。
// 连续相同的行在写入时即合并（count 递增），避免播放期无限增长，
// 渲染端据此显示 `[info] xxx (x2)` 形式的折叠行。
export function fxTerminalPush(fx, line, kind) {
  if (!fx) return;
  if (!Array.isArray(fx._terminal)) fx._terminal = [];
  const k = kind === 'error' ? 'error' : 'info';
  const text = String(line == null ? '' : line);
  for (const part of text.split('\n')) {
    const last = fx._terminal[fx._terminal.length - 1];
    if (last && last.kind === k && last.text === part) {
      last.count = (last.count || 1) + 1;
    } else {
      fx._terminal.push({ kind: k, text: part, count: 1 });
    }
  }
}

// —— 粒子存储与运行时 ——

function markFxError(fx, e) {
  if (fx) {
    const msg = (e && e.message) ? e.message : String(e);
    fx._error = msg;
    // 同一错误只上报一次：rebuild 与后续帧调度可能对同一损坏状态重复求值，
    // 避免终端把同一个 setup/process 错误合并成误导性的 (xN)。
    if (fx._lastError !== msg) {
      fx._lastError = msg;
      fxTerminalPush(fx, localizeScriptError(msg), 'error');
    }
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
    cf: Object.create(null),
    alive: true,
    _spawnMs: runtime.curMs,
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

// 按真实经过毫秒递减剩余寿命；到期（或 life 已为 0）立即移除。
// entry = max(spawnMs, fx.st)：setup 中 spawn 的粒子从 st 开始倒计时。
function decrementLifeMs(fx, runtime, fromMs, toMs) {
  const st = fx.st || 0;
  if (!(toMs > fromMs)) return;
  for (let i = runtime.particles.length - 1; i >= 0; i--) {
    const w = runtime.particles[i];
    const entry = Math.max(w._spawnMs, st);
    if (w.life >= 0 && toMs > entry) {
      const elapsed = toMs - Math.max(entry, fromMs);
      if (elapsed > 0) {
        if (w.life <= elapsed) {
          killParticle(fx, runtime, w);
        } else {
          w.life -= elapsed;
        }
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
    // 上一次已处理到的 50ms tick 边界（下一个边界 = cursorMs + 50）
    cursorMs: Math.ceil(st / 50) * 50 - 50,
    curMs: st,
    objState,
    program,
  };
  fx._runtime = runtime;
  const spawn = () => spawnFor(fx, runtime);
  const setupEnv = {
    t: st,
    st,
    duration: fx.duration || 0,
    maxMs: maxMs(),
    vars: varsAt(fx, st),
    particles: runtime.particles,
    spawn,
    print: line => fxTerminalPush(fx, line, 'info'),
  };
  runTopLevel(program, objState, setupEnv);
  runSetup(program, objState, setupEnv);
  for (const w of runtime.particles) {
    if (w._p) syncParticleState(w._p);
  }
  return runtime;
}

function makeCtx(fx, runtime, T) {
  return {
    t: T,
    st: fx.st || 0,
    duration: fx.duration || 0,
    maxMs: maxMs(),
    vars: varsAt(fx, T),
    particles: runtime.particles,
    spawn: () => spawnFor(fx, runtime),
    fastMath: !!fx.fastMath,
    print: line => fxTerminalPush(fx, line, 'info'),
  };
}

// —— 帧调度：把函数对象推进到时间 T（毫秒） ——
// T < st：只保证 setup 已执行（初始粒子存在，渲染层按 st 隐藏）。
// 超过 duration：不再跑 tick/process（粒子保留，渲染层隐藏）。
// 正常：先按经过毫秒连续递减寿命，再补跑 (cursorMs, T] 内每个 50ms 边界的 tick()，最后跑一次 process()。
// 向后 seek：重建运行时（清空粒子、重跑 setup、重置游标）。

export function evaluateFxFrame(fx, T) {
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
  if (T < runtime.curMs) {
    dropAllParticles(fx);
    fx._runtime = null;
    try {
      runtime = ensureRuntime(fx);
    } catch (e) {
      markFxError(fx, e);
      return;
    }
  }

  // 连续寿命递减 + 50ms 边界 tick()（先递减后 tick，与旧每 tick 顺序一致）。
  let b = runtime.cursorMs + 50;
  while (b <= T) {
    decrementLifeMs(fx, runtime, runtime.curMs, b);
    runtime.curMs = b;
    runtime.cursorMs = b;
    if (runtime.program.tick) {
      try {
        runTick(runtime.program, runtime.objState, makeCtx(fx, runtime, b));
      } catch (e) {
        markFxError(fx, e);
        break;
      }
    }
    b += 50;
  }

  decrementLifeMs(fx, runtime, runtime.curMs, T);
  runtime.curMs = T;
  if (runtime.program.process) {
    try {
      runProcessFrame(runtime.program, runtime.objState, makeCtx(fx, runtime, T));
    } catch (e) {
      markFxError(fx, e);
    }
  }
  for (const w of runtime.particles) {
    if (w._p) syncParticleState(w._p);
  }
}

// —— 函数对象重建 ——

export function rebuildFunctionObject(fx) {
  fx._program = undefined;
  fx._programSrc = undefined;
  fx._error = null;
  fx._lastError = null;
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
      index: serial++, cf: Object.create(null), alive: true, _spawnMs: st,
      kill() { this.alive = false; },
    };
    particles.push(w);
    return w;
  };
  const env = { t: st, st, duration: fx.duration || 0, maxMs: maxMs(), vars: varsAt(fx, st), particles, spawn, print: () => {} };
  runTopLevel(program, objState, env);
  runSetup(program, objState, env);
  if (program.tick) runTick(program, objState, env);
  if (program.process) runProcessFrame(program, objState, env);
  return null;
}

// —— 预设 ——

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
    duration: 5000,
    preset: null,
    params: null,
    fastMath: false,
    frameSync: false,
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