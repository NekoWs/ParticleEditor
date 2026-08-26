/* =========================================================================
 * 撤回 / 重做
 * ======================================================================= */

const undoStack = [];
const redoStack = [];

function cloneVars(vars) {
  const o = {};
  for (const [name, v] of Object.entries(vars || {})) {
    o[name] = { expr: v.expr, kf: (v.kf || []).map(k => [k[0], k[1], k[2]]) };
  }
  return o;
}
function cloneFunctions(fs) {
  return (fs || []).map(f => ({
    ...f,
    center: f.center.slice(),
    vars: cloneVars(f.vars),
    params: f.params ? { ...f.params } : null,
    ui: f.ui ? JSON.parse(JSON.stringify(f.ui)) : null,
  }));
}

function snapshot() {
  return {
    particles: state.particles.map(p => ({ ...p, color: p.color.slice(), pos: p.pos.slice(), vel: p.vel ? p.vel.slice() : [0, 0, 0] })),
    tracks: state.tracks.map(tr => ({ pr: tr.pr, m: tr.m, ids: tr.ids.slice(), kf: tr.kf.map(k => [k[0], k[1], k[2]]) })),
    groups: JSON.parse(JSON.stringify(state.groups)),
    functions: cloneFunctions(state.functions),
    name: state.name,
    loop: state.loop,
    selected: [...state.selected],
    selectedGroup: state.selectedGroup,
    selectedFunction: state.selectedFunction,
  };
}

function restore(s) {
  state.particles = s.particles.map(p => ({ ...p, color: p.color.slice(), pos: p.pos.slice(), vel: p.vel ? p.vel.slice() : [0, 0, 0] }));
  state.tracks = s.tracks.map(tr => ({ pr: tr.pr, m: tr.m, ids: tr.ids.slice(), kf: tr.kf.map(k => [k[0], k[1], k[2]]) }));
  state.groups = JSON.parse(JSON.stringify(s.groups));
  state.functions = cloneFunctions(s.functions);
  state.name = s.name;
  state.loop = s.loop;
  state.selected = new Set(s.selected);
  state.selectedGroup = s.selectedGroup;
  state.selectedFunction = s.selectedFunction;
  document.getElementById('tl-loop').checked = state.loop;
  updateLoopIndicator();
  rebuildPoints();
  refreshParticleTree();
  if (typeof refreshFunctionPanel === 'function') refreshFunctionPanel();
}

function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
  setDirty(true);
}

function popUndo() { undoStack.pop(); }

let continuousDirty = false;
function beginContinuous() { if (!continuousDirty) { pushUndo(); continuousDirty = true; } }
function endContinuous() { continuousDirty = false; }

function undo() {
  if (undoStack.length === 0) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  setDirty(true);
}

function redo() {
  if (redoStack.length === 0) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  setDirty(true);
}
