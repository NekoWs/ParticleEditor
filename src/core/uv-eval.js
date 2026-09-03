/* =========================================================================
 * UV 字段表达式求值（纯逻辑，无 DOM / THREE）
 * -------------------------------------------------------------------------
 * UV 对象的 uvStart / uvSize / uvStep / fps / maxFrame 可分别配置 script-lang
 * 裸表达式（如 `this.index % 4`）。本模块负责：
 *   - 编译缓存（表达式字符串 → createExpressionRunner）
 *   - 逐粒子求值并回退：解析/运行错误或非有限数时，回退到 UV 对象中的数值字段
 *   - 记录错误消息供 UI 红字提示（uvExprError）
 * ======================================================================= */

import { createExpressionRunner } from './script-lang.js';

const runnerCache = new Map();   // expr -> { runner } | { error }
const errorCache = new Map();    // expr -> 错误消息（供面板显示）

export function uvExprError(expr) {
  return expr ? (errorCache.get(expr) || null) : null;
}

// 编译（解析）校验：返回错误消息或 null。供 UV 面板即时红字提示。
export function validateUvExpression(expr) {
  if (!expr) return null;
  const entry = runnerFor(expr);
  return entry.error || null;
}

export function clearUvExprError(expr) {
  if (expr) errorCache.delete(expr);
}

// UV 对象是否含任一表达式字段。
export function hasUvExpressions(uv) {
  if (!uv) return false;
  if (uv.uvStartExpr && (uv.uvStartExpr[0] || uv.uvStartExpr[1])) return true;
  if (uv.uvSizeExpr && (uv.uvSizeExpr[0] || uv.uvSizeExpr[1])) return true;
  if (uv.uvStepExpr && (uv.uvStepExpr[0] || uv.uvStepExpr[1])) return true;
  return !!(uv.fpsExpr || uv.maxFrameExpr);
}

function runnerFor(expr) {
  if (runnerCache.has(expr)) return runnerCache.get(expr);
  let entry;
  try {
    entry = { runner: createExpressionRunner(expr) };
  } catch (e) {
    entry = { error: (e && e.message) ? e.message : String(e) };
    errorCache.set(expr, entry.error);
  }
  runnerCache.set(expr, entry);
  return entry;
}

function evalField(expr, ctx, fallback) {
  if (!expr) return fallback;
  const entry = runnerFor(expr);
  if (entry.error) return fallback;
  let v;
  try {
    v = entry.runner.eval(ctx);
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    errorCache.set(expr, msg);
    return fallback;
  }
  if (!Number.isFinite(v)) {
    errorCache.set(expr, 'result is not a finite number');
    return fallback;
  }
  clearUvExprError(expr);
  return v;
}

// 把 UV 对象的表达式逐字段求值进 out（{ uvStart:[x,y], uvSize:[x,y], uvStep:[x,y], fps, maxFrame }）。
// ctx 需含 script-lang process 上下文：{ i,n,t,dt,duration,life,uv_x,uv_y,vars,out }。
// 无表达式字段直接复制对应数值字段；出错字段回退到数值字段。
export function evalUVInto(uv, ctx, out) {
  out.uvStart[0] = evalField(uv.uvStartExpr && uv.uvStartExpr[0], ctx, uv.uvStart[0]);
  out.uvStart[1] = evalField(uv.uvStartExpr && uv.uvStartExpr[1], ctx, uv.uvStart[1]);
  out.uvSize[0] = evalField(uv.uvSizeExpr && uv.uvSizeExpr[0], ctx, uv.uvSize[0]);
  out.uvSize[1] = evalField(uv.uvSizeExpr && uv.uvSizeExpr[1], ctx, uv.uvSize[1]);
  out.uvStep[0] = evalField(uv.uvStepExpr && uv.uvStepExpr[0], ctx, uv.uvStep[0]);
  out.uvStep[1] = evalField(uv.uvStepExpr && uv.uvStepExpr[1], ctx, uv.uvStep[1]);
  out.fps = evalField(uv.fpsExpr, ctx, uv.fps);
  out.maxFrame = evalField(uv.maxFrameExpr, ctx, uv.maxFrame);
  return out;
}

// 用已求值字段计算自动帧数（与 constants.js autoFramesFor 同语义，但读取 evaled 字段）。
export function evaledAutoFrames(evaled, texW, texH) {
  const w = texW || 1, h = texH || 1;
  const sx = evaled.uvStart[0] || 0, sy = evaled.uvStart[1] || 0;
  const stepx = evaled.uvStep[0] || 0, stepy = evaled.uvStep[1] || 0;
  const nx = (stepx > 0 && sx < w) ? (Math.floor((w - 1 - sx) / stepx) + 1) : 1;
  const ny = (stepy > 0 && sy < h) ? (Math.floor((h - 1 - sy) / stepy) + 1) : 1;
  return Math.max(1, nx * ny);
}

// 用已求值字段计算生效帧数（与 constants.js effMaxFrame 同语义）。
export function evaledEffMaxFrame(evaled, autoFrames) {
  const mf = (evaled.maxFrame != null && evaled.maxFrame > 1) ? evaled.maxFrame : autoFrames;
  return Math.max(1, Math.min(mf, autoFrames));
}