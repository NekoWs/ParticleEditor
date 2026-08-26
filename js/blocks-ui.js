/* =========================================================================
 * 拼图代码块 UI：全屏拼图模式 + 悬浮窗（场景/回显）+ 左侧调色板 + 代码链工作区
 * 依赖 blocks.js、float-window.js、easing.js、constants.js、undo.js、panels.js、generators.js
 * ======================================================================= */

/* —— 类型 → 标签（i18n 键 blk.type.*） —— */
const TYPE_LABEL = { scalar: 'blk.type.scalar', vec: 'blk.type.vec', mat: 'blk.type.mat', any: 'blk.type.any' };
/* —— 积木类别配色 —— */
const GROUP_COLOR = {
  pos: 'blk-pos', color: 'blk-color', appearance: 'blk-appearance',
  math: 'blk-math', vec: 'blk-vec', mat: 'blk-mat', var: 'blk-var', const: 'blk-const',
};

/* —— 语句块槽规格（ASCII 名原样显示；中文语义槽用 i18n 键 blk.slot.*） —— */
const STMT_SLOTS = {
  pos: [['X', T_SCALAR], ['Y', T_SCALAR], ['Z', T_SCALAR]],
  vel: [['vx', T_SCALAR], ['vy', T_SCALAR], ['vz', T_SCALAR]],
  col: [['R', T_SCALAR], ['G', T_SCALAR], ['B', T_SCALAR], ['A', T_SCALAR]],
  scl: [['blk.slot.scale', T_SCALAR]],
  light: [['blk.slot.light', T_SCALAR]],
};
const BIG_BLOCKS = { pos: true, vel: true };

const BUILTIN_VAR_INFO = {
  i: 'blk.var.i',
  n: 'blk.var.n',
  t: 'blk.var.t',
};
const BUILTIN_VAR_NAMES = ['i', 'n', 't'];

let bctx = null;
let bdrag = null;
let puzzleWin = null;
let viewportOrigin = null;

/* =========================================================================
 * 节点工具
 * ======================================================================= */

function cloneExprNode(n) {
  if (!n) return n;
  const o = { kind: n.kind };
  if (n.kind === 'num') o.value = n.value;
  else if (n.kind === 'var') o.name = n.name;
  else if (n.kind === 'func') { o.name = n.name; o.args = n.args.map(cloneExprNode); }
  else if (n.kind === 'op') { o.op = n.op; o.a = cloneExprNode(n.a); o.b = cloneExprNode(n.b); }
  else if (n.kind === 'comp') { o.axis = n.axis; o.target = cloneExprNode(n.target); }
  else if (n.kind === 'neg') { o.a = cloneExprNode(n.a); }
  else if (n.kind === 'chain') { o.terms = n.terms.map(cloneExprNode); o.ops = n.ops.slice(); }
  return o;
}
function cloneStmts(stmts) { return stmts.map(s => ({ ...s, slots: (s.slots || []).map(cloneExprNode), expr: cloneExprNode(s.expr) })); }

function nodeToBlockType(n) {
  switch (n.kind) {
    case 'num': return { cls: 'blk-const', label: fmtNum(n.value) };
    case 'var': return { cls: n.name === 'pi' || n.name === 'e' ? 'blk-const' : 'blk-var', label: n.name };
    case 'func': return { cls: GROUP_COLOR[funcGroup(n.name)], label: n.name };
    case 'op': return { cls: 'blk-math', label: n.op };
    case 'chain': return { cls: 'blk-math', label: t('blk.chain') };
    case 'comp': return { cls: 'blk-vec', label: '.' + n.axis };
    case 'neg': return { cls: 'blk-math', label: '−' };
    default: return { cls: 'blk-var', label: '?' };
  }
}
function funcGroup(name) {
  const r = FUNC_BLOCKS[name].ret;
  if (r === T_VEC) return 'vec';
  if (r === T_MAT) return 'mat';
  return 'math';
}
function blockVarTypeOf(name) {
  if (name === 'i' || name === 'n' || name === 't') return T_SCALAR;
  if (name === 'pi' || name === 'e') return T_SCALAR;
  if (ATTR_NAMES.includes(name)) return T_SCALAR; // 属性（x/y/z/…）是标量
  if (bctx && name in bctx.varExprs) return T_SCALAR;
  return T_ANY;
}
function availableVars() {
  const out = ['i', 'n', 't'];
  if (bctx) {
    for (const name of bctx.varOrder) if (name in bctx.varExprs && !out.includes(name)) out.push(name);
    const all = [...bctx.chain, ...bctx.frags.flatMap(f => f.stmts)];
    for (const t of collectTemps(all)) if (!out.includes(t)) out.push(t);
  }
  return out;
}

/* =========================================================================
 * 积木工厂
 * ======================================================================= */

function slotRef(get, set, type) { return { get, set, type }; }

function makeSlot(ref, label) {
  const el = document.createElement('span');
  el.className = 'blk-slot';
  el.dataset.slotType = ref.type;
  el._ref = ref;
  const cur = ref.get();
  if (cur) el.appendChild(makeExprBlock(cur));
  else {
    const ph = document.createElement('span');
    ph.className = 'blk-slot-empty';
    ph.textContent = (label || '') + (label ? ' ' : '') + t(TYPE_LABEL[ref.type]);
    el.appendChild(ph);
  }
  return el;
}

function makeExprBlock(n) {
  const bt = nodeToBlockType(n);
  const el = document.createElement('span');
  el.className = 'blk-expr ' + bt.cls + ' blk-drag';
  el._node = n;
  el._dragLabel = bt.label;
  el._info = nodeInfo(n);

  if (n.kind === 'num') {
    const inp = document.createElement('input');
    inp.className = 'blk-num';
    inp.type = 'number'; inp.step = 'any'; inp.value = n.value;
    const fitNumWidth = () => { inp.style.width = Math.max(26, Math.min(90, (String(inp.value).length + 1) * 8)) + 'px'; };
    fitNumWidth();
    inp.addEventListener('input', () => { const v = parseFloat(inp.value); if (Number.isFinite(v)) { n.value = v; refreshCodeEcho(); } fitNumWidth(); });
    inp.addEventListener('change', () => { bctxPushUndo(); });
    inp.addEventListener('pointerdown', e => e.stopPropagation());
    el.appendChild(inp);
    return el;
  }
  if (n.kind === 'neg') {
    el.appendChild(document.createTextNode('−'));
    el.appendChild(makeSlot(slotRef(() => n.a, v => { n.a = v; }, T_ANY), ''));
    return el;
  }
  if (n.kind === 'var') { el.appendChild(document.createTextNode(n.name)); return el; }
  if (n.kind === 'func') {
    el.appendChild(document.createTextNode(n.name + '('));
    const spec = FUNC_BLOCKS[n.name].args;
    spec.forEach((arg, i) => {
      if (i > 0) el.appendChild(document.createTextNode(', '));
      el.appendChild(makeSlot(slotRef(() => n.args[i], v => { n.args[i] = v; }, arg[1]), t(arg[0])));
    });
    el.appendChild(document.createTextNode(')'));
    return el;
  }
  if (n.kind === 'op') {
    el.appendChild(makeSlot(slotRef(() => n.a, v => { n.a = v; }, opSlotType(n.op, 'l')), ''));
    const opBtn = document.createElement('span');
    opBtn.className = 'blk-op-sym';
    opBtn.textContent = n.op;
    el.appendChild(opBtn);
    el.appendChild(makeSlot(slotRef(() => n.b, v => { n.b = v; }, opSlotType(n.op, 'r')), ''));
    return el;
  }
  if (n.kind === 'chain') {
    // 动态算式：term0 op0 term1 op1 term2 ...，运算符可拖出删除（连同其后数值）或拖入运算符拼图替换，末尾追加槽自动追加项
    el.classList.add('blk-chain');
    el.appendChild(makeSlot(slotRef(() => n.terms[0], v => { n.terms[0] = v; }, T_ANY), ''));
    n.ops.forEach((op, i) => {
      el.appendChild(makeOpSlot(n, i));
      el.appendChild(makeSlot(slotRef(() => n.terms[i + 1], v => { n.terms[i + 1] = v; }, T_ANY), ''));
    });
    // 追加槽：拖入数值或运算符自动追加
    el.appendChild(makeChainAppend(n));
    return el;
  }
  if (n.kind === 'comp') {
    el.appendChild(makeSlot(slotRef(() => n.target, v => { n.target = v; }, T_VEC), ''));
    const ax = document.createElement('span');
    ax.className = 'blk-comp-axis';
    ax.textContent = '.' + n.axis;
    ax.title = t('blk.clickSwapComp');
    ax.addEventListener('click', () => { bctxPushUndo(); n.axis = n.axis === 'x' ? 'y' : n.axis === 'y' ? 'z' : 'x'; renderChain(); });
    el.appendChild(ax);
    return el;
  }
  return el;
}

function opSlotType(op, side) {
  if (op === '^' || op === '%') return T_SCALAR;
  if (op === '/') return side === 'r' ? T_SCALAR : T_ANY;
  return T_ANY;
}

/** 算式内的运算符槽：可拖出删除该运算符及其后的数值，也可拖入运算符拼图替换。 */
function makeOpSlot(chain, index) {
  const el = document.createElement('span');
  el.className = 'blk-op-sym blk-drag';
  el.textContent = chain.ops[index];
  el._opSlot = { chain, index };
  el._dragLabel = chain.ops[index];
  return el;
}

/** 算式末尾追加槽：拖入数值或运算符拼图自动追加一项。 */
function makeChainAppend(chain) {
  const el = document.createElement('span');
  el.className = 'blk-chain-append';
  el.textContent = t('blk.addTerm');
  el.title = t('blk.addTermHint');
  el._chainAppend = { chain };
  return el;
}

/* =========================================================================
 * 语句块工厂
 * ======================================================================= */

function makeStatementBlock(s, isChain, chainIndex) {
  const el = document.createElement('div');
  const cls = GROUP_COLOR[STMT_BLOCKS[s.kind].group] || 'blk-var';
  el.className = 'blk-stmt ' + cls + (BIG_BLOCKS[s.kind] ? ' big' : '') + ' blk-drag';
  el._stmt = s;
  el._dragLabel = t(STMT_BLOCKS[s.kind].label);
  el._info = t(STMT_BLOCKS[s.kind].desc);

  if (s.kind === 'set') {
    const name = document.createElement('input');
    name.className = 'blk-var-name';
    name.type = 'text'; name.value = s.name;
    name.spellcheck = false;
    name.dataset.orig = s.name;
    const fitNameWidth = () => { name.style.width = Math.max(24, Math.min(120, (String(name.value).length + 1) * 8)) + 'px'; };
    fitNameWidth();
    name.addEventListener('input', fitNameWidth);
    name.addEventListener('pointerdown', e => e.stopPropagation());
    name.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); name.blur(); }
      if (e.key === 'Escape') { name.value = name.dataset.orig; name.blur(); }
    });
    name.addEventListener('blur', () => {
      const nn = name.value.trim();
      if (nn === s.name) { name.value = s.name; fitNameWidth(); return; }
      if (!nn || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(nn) || ATTR_NAMES.includes(nn) || BUILTIN_VAR_NAMES.includes(nn)) { name.value = s.name; fitNameWidth(); return; }
      bctxPushUndo();
      renameRefsInAll(s.name, nn);
      s.name = nn;
      name.value = nn; fitNameWidth();
      renderChain(); renderPalette();
      refreshCodeEcho();
    });
    el.appendChild(name);
    el.appendChild(document.createTextNode(' = '));
    el.appendChild(makeSlot(slotRef(() => s.expr, v => { s.expr = v; }, T_ANY), ''));
  } else if (s.kind === 'attr') {
    // 属性名：可拖入变量（属性标签 x/y/z/…）设置，点击循环切换
    const attrs = ATTR_NAMES.filter(n => n !== 'glow');
    const attrRef = slotRef(
      () => ({ kind: 'var', name: s.name }),
      v => {
        if (v && v.kind === 'var' && attrs.includes(v.name)) {
          bctxPushUndo();
          s.name = v.name;
          renderChain();
          refreshCodeEcho();
        }
      },
      T_SCALAR
    );
    const attrSlot = makeSlot(attrRef, '');
    attrSlot.addEventListener('click', () => {
      const idx = attrs.indexOf(s.name);
      bctxPushUndo();
      s.name = attrs[(idx + 1) % attrs.length];
      renderChain();
      refreshCodeEcho();
    });
    el.appendChild(attrSlot);
    el.appendChild(document.createTextNode(' = '));
    el.appendChild(makeSlot(slotRef(() => s.expr, v => { s.expr = v; }, T_SCALAR), ''));
  } else if (s.kind === 'glow') {
    const sw = document.createElement('button');
    sw.className = 'blk-toggle' + (s.on ? ' on' : '');
    sw.textContent = s.on ? t('blk.glowOn') : t('blk.glowOff');
    sw.addEventListener('click', () => { bctxPushUndo(); s.on = !s.on; renderChain(); });
    el.appendChild(sw);
  } else if (s.kind === 'col') {
    // 颜色块：一行显示「颜色 [取色器] 透明度 (数值)」
    el.appendChild(document.createTextNode(t(STMT_BLOCKS[s.kind].label) + ' '));
    const colorIn = document.createElement('input');
    colorIn.type = 'color';
    colorIn.className = 'blk-color-input';
    colorIn.value = rgbToHexColor(s.slots[0], s.slots[1], s.slots[2]);
    colorIn.title = t('blk.colorPicker');
    colorIn.addEventListener('input', () => {
      const [r, g, b] = hexToRgbColor(colorIn.value);
      if (s.slots[0] && s.slots[0].kind === 'num') s.slots[0].value = r;
      else s.slots[0] = { kind: 'num', value: r };
      if (s.slots[1] && s.slots[1].kind === 'num') s.slots[1].value = g;
      else s.slots[1] = { kind: 'num', value: g };
      if (s.slots[2] && s.slots[2].kind === 'num') s.slots[2].value = b;
      else s.slots[2] = { kind: 'num', value: b };
      refreshCodeEcho();
    });
    colorIn.addEventListener('change', () => { bctxPushUndo(); });
    colorIn.addEventListener('pointerdown', e => e.stopPropagation());
    el.appendChild(colorIn);
    const aLabel = document.createElement('span');
    aLabel.className = 'row-label'; aLabel.textContent = t('props.opacity');
    el.appendChild(aLabel);
    el.appendChild(makeSlot(slotRef(() => s.slots[3], v => { s.slots[3] = v; }, T_SCALAR), ''));
  } else if (BIG_BLOCKS[s.kind]) {
    const head = document.createElement('div');
    head.className = 'big-head';
    head.textContent = t(STMT_BLOCKS[s.kind].label);
    el.appendChild(head);
    const spec = STMT_SLOTS[s.kind];
    spec.forEach((sl, i) => {
      const row = document.createElement('div');
      row.className = 'big-row';
      const lab = document.createElement('span');
      lab.className = 'row-label'; lab.textContent = t(sl[0]);
      row.appendChild(lab);
      row.appendChild(makeSlot(slotRef(() => s.slots[i], v => { s.slots[i] = v; }, sl[1]), ''));
      el.appendChild(row);
    });
  } else {
    el.appendChild(document.createTextNode(t(STMT_BLOCKS[s.kind].label) + ' '));
    if (s.kind === 'pos_vec' || s.kind === 'vel_vec') {
      el.appendChild(makeSlot(slotRef(() => s.expr, v => { s.expr = v; }, T_VEC), ''));
    } else {
      el.appendChild(makeSlot(slotRef(() => s.expr, v => { s.expr = v; }, T_SCALAR), ''));
    }
  }

  return el;
}

function renameRefsInAll(oldName, newName) {
  renameRefsInStmts([...bctx.chain, ...bctx.frags.flatMap(f => f.stmts)], oldName, newName);
}
function renameRefsInStmts(stmts, oldName, newName) {
  const walk = (n) => {
    if (!n) return;
    if (n.kind === 'var' && n.name === oldName) n.name = newName;
    if (n.kind === 'func') n.args.forEach(walk);
    if (n.kind === 'op') { walk(n.a); walk(n.b); }
    if (n.kind === 'comp') walk(n.target);
    if (n.kind === 'neg') walk(n.a);
    if (n.kind === 'chain') n.terms.forEach(walk);
  };
  for (const s of stmts) {
    if (s.kind === 'set' && s.name === oldName) s.name = newName;
    if (s.slots) s.slots.forEach(walk);
    if (s.expr) walk(s.expr);
  }
}
function rgbToHexColor(rNode, gNode, bNode) {
  const v = n => (n && n.kind === 'num') ? Math.round(Math.min(1, Math.max(0, n.value)) * 255) : 255;
  const c = x => x.toString(16).padStart(2, '0');
  return '#' + c(v(rNode)) + c(v(gNode)) + c(v(bNode));
}
function hexToRgbColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/* =========================================================================
 * 默认值 / 定位
 * ======================================================================= */

const N0 = () => ({ kind: 'num', value: 0 });
const NVEC = () => ({ kind: 'func', name: 'vec', args: [N0(), N0(), N0()] });

function newStmtNode(kind) {
  switch (kind) {
    case 'pos': return { kind, slots: [N0(), N0(), N0()] };
    case 'vel': return { kind, slots: [N0(), N0(), N0()] };
    case 'col': return { kind, slots: [N0(), N0(), N0(), N0()] };
    case 'scl': return { kind, expr: N0() };
    case 'light': return { kind, expr: N0() };
    case 'glow': return { kind, on: true };
    case 'set': return { kind, name: freshTempName(), expr: N0() };
    case 'attr': return { kind, name: 'x', expr: N0() };
    case 'pos_vec': case 'vel_vec': return { kind, expr: NVEC() };
    default: throw new Error(_etf('err.unknownStmt', kind));
  }
}
function freshTempName() {
  let k = 0;
  const all = bctx ? [...bctx.chain, ...bctx.frags.flatMap(f => f.stmts)] : [];
  const names = new Set(collectTemps(all));
  while (names.has('v' + k)) k++;
  return 'v' + k;
}
function newExprNodeFromTemplate(template) {
  if (template.kind === 'num') return { kind: 'num', value: 1 };
  if (template.kind === 'var') return { kind: 'var', name: template.name };
  if (template.kind === 'comp') return { kind: 'comp', axis: 'x', target: NVEC() };
  if (template.kind === 'func') {
    const n = FUNC_BLOCKS[template.name].args.length;
    return { kind: 'func', name: template.name, args: Array.from({ length: n }, () => N0()) };
  }
  if (template.kind === 'op') return { kind: 'op', op: template.op, a: N0(), b: N0() };
  if (template.kind === 'chain') return { kind: 'chain', terms: [N0(), N0()], ops: ['+'] };
  return N0();
}
function defaultExprFor(type) {
  if (type === T_VEC) return NVEC();
  if (type === T_MAT) return { kind: 'func', name: 'rotZ', args: [N0()] };
  return N0();
}
function stmtExprSlotType(s) {
  if (s.kind === 'pos_vec' || s.kind === 'vel_vec') return T_VEC;
  return T_SCALAR;
}
function findAllStmts() { return bctx ? [...bctx.chain, ...bctx.frags.flatMap(f => f.stmts)] : []; }
function findSlotRefByNode(stmts, node) {
  let result = null;
  const walkStmt = (s) => {
    if (result) return;
    if (s.slots) {
      const spec = STMT_SLOTS[s.kind];
      for (let i = 0; i < s.slots.length; i++) {
        const slotType = (spec && spec[i]) ? spec[i][1] : T_ANY;
        if (s.slots[i] === node) { result = slotRef(() => s.slots[i], v => { s.slots[i] = v; }, slotType); return; }
        if (s.slots[i]) walkExpr(s.slots[i], () => s.slots[i], v => { s.slots[i] = v; });
      }
    }
    if (s.expr) {
      const slotType = stmtExprSlotType(s);
      if (s.expr === node) { result = slotRef(() => s.expr, v => { s.expr = v; }, slotType); return; }
      walkExpr(s.expr, () => s.expr, v => { s.expr = v; });
    }
  };
  const walkExpr = (n, get, set) => {
    if (result) return;
    if (n.kind === 'func') {
      const spec = FUNC_BLOCKS[n.name].args;
      for (let i = 0; i < n.args.length; i++) {
        const slotType = spec[i] ? spec[i][1] : T_ANY;
        if (n.args[i] === node) { result = slotRef(() => n.args[i], v => { n.args[i] = v; }, slotType); return; }
        walkExpr(n.args[i], () => n.args[i], v => { n.args[i] = v; });
      }
    } else if (n.kind === 'op') {
      const lt = opSlotType(n.op, 'l'), rt = opSlotType(n.op, 'r');
      if (n.a === node) { result = slotRef(() => n.a, v => { n.a = v; }, lt); return; }
      if (n.b === node) { result = slotRef(() => n.b, v => { n.b = v; }, rt); return; }
      walkExpr(n.a, () => n.a, v => { n.a = v; });
      walkExpr(n.b, () => n.b, v => { n.b = v; });
    } else if (n.kind === 'comp') {
      if (n.target === node) { result = slotRef(() => n.target, v => { n.target = v; }, T_VEC); return; }
      walkExpr(n.target, () => n.target, v => { n.target = v; });
    } else if (n.kind === 'neg') {
      if (n.a === node) { result = slotRef(() => n.a, v => { n.a = v; }, T_ANY); return; }
      walkExpr(n.a, () => n.a, v => { n.a = v; });
    } else if (n.kind === 'chain') {
      for (let i = 0; i < n.terms.length; i++) {
        if (n.terms[i] === node) { result = slotRef(() => n.terms[i], v => { n.terms[i] = v; }, T_ANY); return; }
        walkExpr(n.terms[i], () => n.terms[i], v => { n.terms[i] = v; });
      }
    }
  };
  stmts.forEach(walkStmt);
  return result;
}
function findExprDetach(node) {
  const found = findSlotRefByNode(findAllStmts(), node);
  if (found) return () => { found.set(defaultExprFor(found.type)); return node; };
  return null;
}

/** 删除算式内 index 处的运算符及其后的数值；若只剩一项则退化为该项。 */
function removeChainOp(chain, index) {
  chain.ops.splice(index, 1);
  chain.terms.splice(index + 1, 1);
  if (chain.ops.length === 0) {
    const ref = findSlotRefByNode(findAllStmts(), chain);
    if (ref) ref.set(chain.terms[0]);
  }
}

/* =========================================================================
 * 调色板渲染（左侧固定栏，紧凑列表）
 * ======================================================================= */

function renderPalette() {
  const list = document.getElementById('pal-list');
  if (!list) return;
  list.innerHTML = '';
  for (const g of PALETTE_GROUPS) {
    const sec = document.createElement('div');
    sec.className = 'pal-group';
    const title = document.createElement('div');
    title.className = 'pal-title';
    title.textContent = t(g.label);
    sec.appendChild(title);
    const items = document.createElement('div');
    items.className = 'pal-items';
    for (const item of buildPaletteGroup(g)) items.appendChild(makePaletteItemEl(item));
    sec.appendChild(items);
    list.appendChild(sec);
  }
}

/** 函数积木注解：用途（参数含义…）。 */
function funcInfo(name) {
  const f = FUNC_BLOCKS[name];
  const args = (f.args || []).map(a => t(a[0])).join(', ');
  return t(f.desc) + (args ? '（' + args + '）' : '');
}

/** 积木节点含义（供放大镜查看）。 */
function nodeInfo(n) {
  switch (n.kind) {
    case 'num': return t('blk.constNum');
    case 'var': return (BUILTIN_VAR_INFO[n.name] && t(BUILTIN_VAR_INFO[n.name])) || t('blk.var');
    case 'func': return funcInfo(n.name);
    case 'op': return (OP_LABELS[n.op] && t(OP_LABELS[n.op])) || t('blk.op');
    case 'chain': return t('blk.chainDesc');
    case 'comp': return t('blk.compDesc');
    case 'neg': return t('blk.neg');
    default: return '';
  }
}

function buildPaletteGroup(g) {
  const items = [];
  if (g.id === 'pos') {
    ['pos', 'pos_vec', 'vel', 'vel_vec'].forEach(k => items.push({ key: 'stmt:' + k, type: 'stmt', kind: k, label: t(STMT_BLOCKS[k].label), info: t(STMT_BLOCKS[k].desc) }));
    items.push({ key: 'stmt:attr', type: 'stmt', kind: 'attr', label: t(STMT_BLOCKS.attr.label), info: t(STMT_BLOCKS.attr.desc) });
  } else if (g.id === 'color') {
    items.push({ key: 'stmt:col', type: 'stmt', kind: 'col', label: t(STMT_BLOCKS.col.label), info: t(STMT_BLOCKS.col.desc) });
  } else if (g.id === 'appearance') {
    ['scl', 'glow', 'light'].forEach(k => items.push({ key: 'stmt:' + k, type: 'stmt', kind: k, label: t(STMT_BLOCKS[k].label), info: t(STMT_BLOCKS[k].desc) }));
  } else if (g.id === 'var') {
    items.push({ key: 'stmt:set', type: 'stmt', kind: 'set', label: t(STMT_BLOCKS.set.label), info: t(STMT_BLOCKS.set.desc) });
    for (const name of availableVars()) items.push({ key: 'var:' + name, type: 'expr', template: { kind: 'var', name }, label: name, info: (BUILTIN_VAR_INFO[name] && t(BUILTIN_VAR_INFO[name])) || t('blk.var') });
  } else if (g.id === 'const') {
    items.push({ key: 'expr:num', type: 'expr', template: { kind: 'num', value: 1 }, label: t('blk.type.scalar'), info: t('blk.constNum') });
    items.push({ key: 'expr:pi', type: 'expr', template: { kind: 'var', name: 'pi' }, label: 'pi', info: t('blk.piInfo') });
    items.push({ key: 'expr:e', type: 'expr', template: { kind: 'var', name: 'e' }, label: 'e', info: t('blk.eInfo') });
  } else if (g.id === 'math') {
    // 动态算式 + 独立运算符拼图
    items.push({ key: 'expr:chain', type: 'expr', template: { kind: 'chain', terms: [{ kind: 'num', value: 0 }, { kind: 'num', value: 0 }], ops: ['+'] }, label: t('blk.chain'), info: t('blk.chainDesc') });
    for (const op of OP_SYMBOLS) items.push({ key: 'opval:' + op, type: 'opval', op, label: op, info: (OP_LABELS[op] && t(OP_LABELS[op])) || op });
    for (const name in FUNC_BLOCKS) {
      const r = FUNC_BLOCKS[name].ret;
      if (r === T_SCALAR && !['vec', 'dot', 'cross', 'len', 'norm'].includes(name)) items.push({ key: 'func:' + name, type: 'expr', template: { kind: 'func', name, args: [] }, label: name, info: funcInfo(name) });
    }
  } else if (g.id === 'vec') {
    ['vec', 'cross', 'norm', 'polar', 'sphere', 'torus', 'dot', 'len'].forEach(name => {
      if (FUNC_BLOCKS[name]) items.push({ key: 'func:' + name, type: 'expr', template: { kind: 'func', name, args: [] }, label: name, info: funcInfo(name) });
    });
    items.push({ key: 'expr:comp', type: 'expr', template: { kind: 'comp', axis: 'x', target: null }, label: t('blk.comp'), info: t('blk.compDesc') });
  } else if (g.id === 'mat') {
    ['rotX', 'rotY', 'rotZ', 'rotAxis'].forEach(name => items.push({ key: 'func:' + name, type: 'expr', template: { kind: 'func', name, args: [] }, label: name, info: funcInfo(name) }));
  }
  return items;
}

/** 调色板项：与代码链积木同款渲染（复用 makeStatementBlock / makeExprBlock），内部禁用交互。 */
let paletteTipEl = null;
function showPaletteTip(anchor, text) {
  hidePaletteTip();
  const tip = document.createElement('div');
  tip.className = 'qtip';
  tip.textContent = text;
  document.body.appendChild(tip);
  const qr = anchor.getBoundingClientRect();
  const tr = tip.getBoundingClientRect();
  let left = qr.left + qr.width / 2 - tr.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
  let top = qr.top - tr.height - 6;
  if (top < 8) top = qr.bottom + 6;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
  paletteTipEl = tip;
}
function hidePaletteTip() {
  if (paletteTipEl) { paletteTipEl.remove(); paletteTipEl = null; }
}
function makePaletteItemEl(item) {
  const wrap = document.createElement('div');
  wrap.className = 'pal-item blk-drag';
  wrap._palette = { type: item.type, kind: item.kind, template: item.template, op: item.op };
  wrap._dragLabel = item.label;
  if (item.info) wrap._info = item.info;

  if (item.type === 'opval') {
    // 运算符拼图：独立小块
    const opEl = document.createElement('span');
    opEl.className = 'blk-expr blk-math blk-opval';
    opEl.textContent = item.op;
    wrap.appendChild(opEl);
  } else if (item.type === 'stmt') {
    const tmp = newStmtNode(item.kind);
    wrap.appendChild(makeStatementBlock(tmp));
  } else {
    wrap.appendChild(makeExprBlock(newExprNodeFromTemplate(item.template)));
  }
  return wrap;
}

/* =========================================================================
 * 代码链渲染（工作区）
 * ======================================================================= */

function renderChain() {
  const canvas = document.getElementById('chain-canvas');
  if (!canvas) return;
  canvas.innerHTML = '';
  const layout = bctx.layout;
  // 平移缩放层：所有链/碎片放在 plane 里，画布空白拖动平移、滚轮缩放
  const plane = document.createElement('div');
  plane.className = 'chain-plane';
  plane.style.transform = 'translate(' + layout.view.x + 'px,' + layout.view.y + 'px) scale(' + layout.view.scale + ')';
  canvas.appendChild(plane);

  const chainStack = document.createElement('div');
  chainStack.className = 'chain-stack';
  chainStack.style.left = layout.chain.x + 'px';
  chainStack.style.top = layout.chain.y + 'px';
  const start = document.createElement('div');
  start.className = 'blk-start blk-drag';
  start.textContent = t('blk.start');
  start._chainHead = true;
  start._dragLabel = t('blk.start');
  chainStack.appendChild(start);
  chainStack.appendChild(makeStmtDropZone(0));
  bctx.chain.forEach((s, i) => {
    chainStack.appendChild(makeStatementBlock(s, true, i));
    chainStack.appendChild(makeStmtDropZone(i + 1));
  });
  plane.appendChild(chainStack);

  bctx.frags.forEach((f) => {
    const fragStack = document.createElement('div');
    fragStack.className = 'chain-stack';
    fragStack.style.left = f.x + 'px';
    fragStack.style.top = f.y + 'px';
    fragStack._frag = f;
    const fragHead = document.createElement('div');
    fragHead.className = 'blk-start frag blk-drag';
    fragHead.textContent = t('blk.fragment');
    fragHead._fragHead = f;
    fragHead._dragLabel = t('blk.fragment');
    fragStack.appendChild(fragHead);
    fragStack.appendChild(makeStmtDropZone(0));
    f.stmts.forEach((s, i) => {
      fragStack.appendChild(makeStatementBlock(s, false, i));
      fragStack.appendChild(makeStmtDropZone(i + 1));
    });
    plane.appendChild(fragStack);
  });

  const varBox = document.getElementById('chain-vars');
  if (varBox) {
    varBox.innerHTML = '';
    varBox.appendChild(makeCountBlock());
    for (const name of bctx.varOrder) {
      if (!(name in bctx.varExprs)) continue;
      varBox.appendChild(makeVarBlock(name));
    }
    // 可设置的属性（x/y/z/…）：可拖入表达式 slot 作为变量引用
    for (const name of ATTR_NAMES) {
      if (name === 'glow') continue;
      varBox.appendChild(makeAttrBlock(name));
    }
  }
  refreshCodeEcho();
}

function makeStmtDropZone(index) {
  const el = document.createElement('div');
  el.className = 'blk-stmt-drop';
  el._dropIndex = index;
  return el;
}

function makeVarBlock(name) {
  const fx = getFunction(bctx.fxId);
  const v = fx && fx.vars[name];
  const hasKf = v && (v.kf || []).length > 0;
  const wrap = document.createElement('div');
  wrap.className = 'blk-var-row' + (hasKf ? ' disabled' : '');
  if (hasKf) {
    const hint = document.createElement('span');
    hint.textContent = tf('blk.varHasKf', name);
    wrap.appendChild(hint);
    return wrap;
  }
  const nameIn = document.createElement('input');
  nameIn.className = 'blk-var-name';
  nameIn.type = 'text'; nameIn.value = name;
  nameIn.spellcheck = false;
  const fitVarWidth = () => { nameIn.style.width = Math.max(24, Math.min(120, (String(nameIn.value).length + 1) * 8)) + 'px'; };
  fitVarWidth();
  nameIn.addEventListener('input', fitVarWidth);
  nameIn.addEventListener('change', () => {
    const nn = nameIn.value.trim();
    if (!nn || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(nn) || ATTR_NAMES.includes(nn) || BUILTIN_VAR_NAMES.includes(nn) || nn === name) { nameIn.value = name; fitVarWidth(); return; }
    if (nn in bctx.varExprs) { nameIn.value = name; fitVarWidth(); return; }
    bctxPushUndo();
    renameVarGlobal(name, nn);
    nameIn.value = nn; fitVarWidth();
  });
  nameIn.addEventListener('pointerdown', e => e.stopPropagation());
  wrap.appendChild(nameIn);
  wrap.appendChild(document.createTextNode(' = '));
  wrap.appendChild(makeSlot(slotRef(() => bctx.varExprs[name], val => { bctx.varExprs[name] = val; }, T_SCALAR), ''));
  return wrap;
}
/** 可设置属性标签（x/y/z/…）：可拖入表达式 slot 作为变量引用。 */
function makeAttrBlock(name) {
  const wrap = document.createElement('div');
  wrap.className = 'blk-var-row';
  const tag = document.createElement('span');
  tag.className = 'blk-attr-tag blk-drag';
  tag.textContent = name;
  tag.title = tf('blk.attrRefHint', name);
  tag._attrVar = name;
  tag._dragLabel = name;
  wrap.appendChild(tag);
  return wrap;
}
/** 采样数 n：内置只读变量，直接在拼图变量区编辑总数（实时写入 fx.count）。 */
function makeCountBlock() {
  const fx = getFunction(bctx.fxId);
  const wrap = document.createElement('div');
  wrap.className = 'blk-var-row';
  const tag = document.createElement('span');
  tag.className = 'blk-attr-tag';
  tag.style.cursor = 'default';
  tag.textContent = t('blk.sampleCount');
  tag.title = t(BUILTIN_VAR_INFO.n);
  wrap.appendChild(tag);
  wrap.appendChild(document.createTextNode(' = '));
  const inp = document.createElement('input');
  inp.className = 'blk-num';
  inp.type = 'number'; inp.min = '1'; inp.step = '1'; inp.value = fx.count;
  const fitWidth = () => { inp.style.width = Math.max(26, Math.min(120, (String(inp.value).length + 1) * 8)) + 'px'; };
  fitWidth();
  inp.addEventListener('input', fitWidth);
  inp.addEventListener('change', () => {
    fx.count = Math.max(1, Math.round(parseInt(inp.value) || 1));
    inp.value = fx.count;
    commitFunctionRebuild(fx);
  });
  inp.addEventListener('pointerdown', e => e.stopPropagation());
  wrap.appendChild(inp);
  return wrap;
}
function renameVarGlobal(oldName, newName) {
  if (oldName in bctx.varExprs) {
    bctx.varExprs[newName] = bctx.varExprs[oldName];
    delete bctx.varExprs[oldName];
    const idx = bctx.varOrder.indexOf(oldName);
    if (idx >= 0) bctx.varOrder[idx] = newName;
  }
  renameRefsInAll(oldName, newName);
  renderChain(); renderPalette();
}

/* =========================================================================
 * 拖拽
 * ======================================================================= */

const DRAG_THRESHOLD = 5; // 移动超过该距离才真正断开/开始拖拽

function beginBlockDrag(el, clientX, clientY) {
  bdrag = { ghost: null, source: null, target: null, valid: false, startX: clientX, startY: clientY, started: false, grabDx: 0, grabDy: 0 };

  // 调色板项优先（内部积木也命中 wrapper）
  const palEl = el.closest && el.closest('.pal-item');
  if (palEl && palEl._palette) {
    const p = palEl._palette;
    if (p.type === 'opval') {
      bdrag.source = { type: 'opval', op: p.op };
    } else {
      bdrag.source = { type: 'palette', make: () => (p.type === 'stmt' ? newStmtNode(p.kind) : newExprNodeFromTemplate(p.template)), stmt: p.type === 'stmt' };
    }
    computeGrab(palEl, clientX, clientY);
    makeGhost(palEl, clientX, clientY);
    return;
  }
  if (el._opSlot) {
    const { chain, index } = el._opSlot;
    bdrag.source = { type: 'op-remove', chain, index };
    computeGrab(el, clientX, clientY);
    makeGhost(el, clientX, clientY);
    return;
  }
  if (el._attrVar) {
    const name = el._attrVar;
    bdrag.source = { type: 'palette', make: () => ({ kind: 'var', name }), stmt: false };
    computeGrab(el, clientX, clientY);
    makeGhost(el, clientX, clientY);
    return;
  }
  if (el._node) {
    const node = el._node;
    bdrag.source = { type: 'expr', node, detach: findExprDetach(node) };
    computeGrab(el, clientX, clientY);
    makeGhost(el, clientX, clientY);
    return;
  }
  if (el._chainHead) {
    bdrag.source = { type: 'chain-move', stack: el.parentElement, startX: clientX, startY: clientY, lx: bctx.layout.chain.x, ly: bctx.layout.chain.y };
    return; // 链移动无 ghost，直接移动
  }
  if (el._fragHead) {
    const f = el._fragHead;
    bdrag.source = { type: 'frag-move', frag: f, stack: el.parentElement, startX: clientX, startY: clientY, lx: f.x, ly: f.y };
    return;
  }
  if (el._stmt) {
    const s = el._stmt;
    const loc = stmtGroupLocation(s);
    if (!loc) return;
    // 暂不 detach，等移动超过阈值才断开
    bdrag.source = { type: 'stmt-group-pending', stmt: s, loc, el };
    computeGrab(el, clientX, clientY);
    return;
  }
}

/** 记录鼠标按下时相对积木左上角的偏移，使 ghost 位置贴合。 */
function computeGrab(el, clientX, clientY) {
  const r = el.getBoundingClientRect();
  bdrag.grabDx = clientX - r.left;
  bdrag.grabDy = clientY - r.top;
}

function makeGhost(el, clientX, clientY) {
  const ghost = document.createElement('div');
  ghost.className = 'blk-ghost';
  // 克隆积木真实外观（语句块/表达式块/起点块），内部控件只读
  const src = el.classList && el.classList.contains('pal-item') ? el.firstElementChild : el;
  if (src) {
    const clone = src.cloneNode(true);
    clone.querySelectorAll('input, button').forEach(x => { x.disabled = true; });
    if (el.classList.contains('pal-item')) {
      // 调色板拼图有放大，克隆也应用相同缩放，保持拖拽前后大小一致
      clone.style.zoom = '1.5';
    } else if (el.closest && el.closest('#chain-canvas')) {
      // 工作区拼图随视图缩放，克隆也应用相同缩放，保持拖拽前后大小一致
      const s = bctx ? bctx.layout.view.scale : 1;
      if (s !== 1) {
        clone.style.transform = 'scale(' + s + ')';
        clone.style.transformOrigin = 'top left';
      }
    }
    ghost.appendChild(clone);
  } else {
    ghost.textContent = el._dragLabel || t('blk.block');
  }
  ghost.style.left = (clientX - bdrag.grabDx) + 'px';
  ghost.style.top = (clientY - bdrag.grabDy) + 'px';
  document.body.appendChild(ghost);
  bdrag.ghost = ghost;
  document.body.classList.add('blk-dragging');
}

/** 语句组 ghost：渲染整组积木（该块及下方所有块），跟随鼠标。 */
function makeGroupGhost(group, clientX, clientY) {
  const ghost = document.createElement('div');
  ghost.className = 'blk-ghost';
  const stack = document.createElement('div');
  stack.className = 'chain-stack';
  stack.style.position = 'static';
  group.forEach((s, i) => {
    const blk = makeStatementBlock(s, false, i);
    blk.querySelectorAll('input, button, .blk-op-sym, .blk-comp-axis').forEach(x => { x.disabled = true; x.style.pointerEvents = 'none'; });
    stack.appendChild(blk);
  });
  ghost.appendChild(stack);
  // 语句组随工作区缩放，ghost 也应用相同缩放
  const vs = bctx ? bctx.layout.view.scale : 1;
  if (vs !== 1) {
    stack.style.transform = 'scale(' + vs + ')';
    stack.style.transformOrigin = 'top left';
  }
  ghost.style.left = (clientX - bdrag.grabDx) + 'px';
  ghost.style.top = (clientY - bdrag.grabDy) + 'px';
  document.body.appendChild(ghost);
  bdrag.ghost = ghost;
  document.body.classList.add('blk-dragging');
}

function stmtGroupLocation(s) {
  const ci = bctx.chain.indexOf(s);
  if (ci >= 0) return { where: 'chain', index: ci };
  for (const f of bctx.frags) {
    const fi = f.stmts.indexOf(s);
    if (fi >= 0) return { where: 'frag', frag: f, index: fi };
  }
  return null;
}
function detachStmtGroupNow(s) {
  const loc = stmtGroupLocation(s);
  if (loc.where === 'chain') return bctx.chain.splice(loc.index);
  const group = loc.frag.stmts.splice(loc.index);
  if (loc.frag.stmts.length === 0) bctx.frags.splice(bctx.frags.indexOf(loc.frag), 1);
  return group;
}
function restoreStmtGroup(loc, group) {
  if (loc.where === 'chain') {
    bctx.chain.splice(loc.index, 0, ...group);
  } else {
    let f = loc.frag;
    if (!bctx.frags.includes(f)) {
      f = { stmts: [], x: loc.frag.x, y: loc.frag.y };
      bctx.frags.push(f);
    }
    f.stmts.splice(loc.index, 0, ...group);
  }
}

function moveGhost(clientX, clientY) {
  if (!bdrag) return;
  const src = bdrag.source;

  // 语句组：移动超过阈值才断开
  if (src.type === 'stmt-group-pending') {
    const dx = clientX - bdrag.startX, dy = clientY - bdrag.startY;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    // 正式断开
    bctxPushUndo();
    const group = detachStmtGroupNow(src.stmt);
    src.type = 'stmt-group';
    src.group = group;
    renderChain(); renderPalette();
    makeGroupGhost(group, clientX, clientY);
    return;
  }

  if (src.type === 'chain-move') {
    bctx.layout.chain.x = src.lx + (clientX - src.startX);
    bctx.layout.chain.y = src.ly + (clientY - src.startY);
    if (src.stack) { src.stack.style.left = bctx.layout.chain.x + 'px'; src.stack.style.top = bctx.layout.chain.y + 'px'; }
    return;
  }
  if (src.type === 'frag-move') {
    src.frag.x = src.lx + (clientX - src.startX);
    src.frag.y = src.ly + (clientY - src.startY);
    if (src.stack) { src.stack.style.left = src.frag.x + 'px'; src.stack.style.top = src.frag.y + 'px'; }
    return;
  }

  if (!bdrag.ghost) return;
  bdrag.ghost.style.left = (clientX - bdrag.grabDx) + 'px';
  bdrag.ghost.style.top = (clientY - bdrag.grabDy) + 'px';

  const el = document.elementFromPoint(clientX, clientY);
  bdrag.target = null;
  bdrag.valid = false;
  if (!el) return;
  const slot = el.closest('.blk-slot');
  const opSlot = el.closest('.blk-op-sym');
  const chainAppend = el.closest('.blk-chain-append');
  const palette = el.closest('#puzzle-palette');
  document.querySelectorAll('.blk-slot.hover, .blk-slot.invalid, .blk-stmt-drop.hover, .blk-stmt-drop.invalid, #puzzle-palette.del-target, .blk-op-sym.hover, .blk-op-sym.invalid, .blk-chain-append.hover, .blk-chain-append.invalid').forEach(x => x.classList.remove('hover', 'invalid', 'del-target'));

  if (palette) {
    bdrag.target = { kind: 'delete' };
    bdrag.valid = true;
    palette.classList.add('del-target');
    return;
  }
  // 运算符槽（chain 内）：接受运算符拼图
  if (opSlot && opSlot._opSlot) {
    bdrag.target = { kind: 'op-slot', ref: opSlot._opSlot };
    bdrag.valid = src.type === 'opval';
    opSlot.classList.add(bdrag.valid ? 'hover' : 'invalid');
    return;
  }
  // 算式追加槽：接受数值或运算符拼图
  if (chainAppend) {
    bdrag.target = { kind: 'chain-append', ref: chainAppend._chainAppend };
    bdrag.valid = (src.type === 'opval' || src.type === 'palette' || src.type === 'expr');
    chainAppend.classList.add(bdrag.valid ? 'hover' : 'invalid');
    return;
  }
  if (slot) {
    bdrag.target = { kind: 'slot', ref: slot._ref, slotType: slot.dataset.slotType };
    bdrag.valid = canPlaceIntoTarget(slot.dataset.slotType);
    slot.classList.add(bdrag.valid ? 'hover' : 'invalid');
    return;
  }
  // 语句块：用几何位置找最近的插入点（drop zone 太窄，用垂直距离吸附）
  if (src.stmt) {
    const drop = nearestStmtDrop(clientX, clientY);
    if (drop) {
      bdrag.target = { kind: 'stmt-drop', index: drop.index, frag: drop.frag };
      bdrag.valid = true;
      drop.el.classList.add('hover');
      return;
    }
  }
  if (el.closest('#chain-canvas')) {
    const rect = document.getElementById('chain-canvas').getBoundingClientRect();
    // 换算到 plane 坐标系（抵消 view 平移缩放）
    const v = bctx.layout.view;
    // 用 ghost 左上角定位碎片，避免出现位置偏移
    const gx = clientX - (bdrag.grabDx || 0);
    const gy = clientY - (bdrag.grabDy || 0);
    bdrag.target = { kind: 'blank', x: (gx - rect.left - v.x) / v.scale, y: (gy - rect.top - v.y) / v.scale };
    bdrag.valid = src.stmt;
    return;
  }
}

/** 找鼠标位置最近的语句插入点（drop zone）。 */
function nearestStmtDrop(clientX, clientY) {
  // 用拼图实际位置（ghost 左边缘），纳入 grab 偏移，使从某处拖走能精确拖回
  let cx = clientX, cy = clientY;
  if (bdrag && bdrag.ghost) {
    const gr = bdrag.ghost.getBoundingClientRect();
    cx = gr.left; // 左边缘对齐，使左侧也能吸附
    // 用 ghost 顶边：拖拽语句组时插入点由组顶边决定，
    // 中心点会使插入位置向下偏移半个 ghost 高度（组越长偏移越大）。
    cy = gr.top;
  }
  const drops = Array.from(document.querySelectorAll('#chain-canvas .blk-stmt-drop'));
  let best = null, bestD = 28; // 阈值 28px
  for (const d of drops) {
    const r = d.getBoundingClientRect();
    const dy = Math.abs(cy - (r.top + r.height / 2));
    const dx = Math.abs(cx - r.left); // 左边缘对齐
    if (dy < bestD && dx < 160) { bestD = dy; best = d; }
  }
  if (!best) return null;
  const frag = best.closest('.chain-stack')._frag || null;
  return { index: best._dropIndex, frag, el: best };
}

function canPlaceIntoTarget(slotType) {
  if (!bdrag || !bdrag.source) return false;
  if (bdrag.source.stmt) return false;
  if (bdrag.source.type === 'palette') return typeAccepts(slotType, exprType(bdrag.source.make(), blockVarTypeOf));
  if (bdrag.source.type === 'expr') return typeAccepts(slotType, exprType(bdrag.source.node, blockVarTypeOf));
  return false;
}

function endBlockDrag() {
  if (!bdrag) return;
  const { source, target, valid } = bdrag;
  document.querySelectorAll('.blk-slot.hover, .blk-slot.invalid, .blk-stmt-drop.hover, .blk-stmt-drop.invalid, #puzzle-palette.del-target, .blk-op-sym.hover, .blk-op-sym.invalid, .blk-chain-append.hover, .blk-chain-append.invalid').forEach(x => x.classList.remove('hover', 'invalid', 'del-target'));
  if (bdrag.ghost) bdrag.ghost.remove();
  document.body.classList.remove('blk-dragging');
  bdrag = null;

  if (source.type === 'chain-move' || source.type === 'frag-move') return;
  if (source.type === 'stmt-group-pending') return; // 未超过阈值，未断开

  if (source.type === 'stmt-group') {
    if (!valid || !target) {
      // 取消：放回原位
      restoreStmtGroup(source.loc, source.group);
    } else if (target.kind === 'delete') {
      // 拖回调色板：丢弃该组
    } else if (target.kind === 'stmt-drop') {
      if (target.frag) target.frag.stmts.splice(target.index, 0, ...source.group);
      else bctx.chain.splice(target.index, 0, ...source.group);
    } else if (target.kind === 'blank') {
      // 放到空白处：成为新碎片
      bctx.frags.push({ stmts: source.group, x: target.x, y: target.y });
    }
    renderChain(); renderPalette();
    return;
  }

  if (!valid || !target) return;

  if (target.kind === 'delete') {
    if (source.type === 'expr') { bctxPushUndo(); if (source.detach) source.detach(); }
    else if (source.type === 'op-remove') { bctxPushUndo(); removeChainOp(source.chain, source.index); }
    renderChain(); renderPalette();
    return;
  }
  if (target.kind === 'op-slot') {
    // 运算符拼图替换算式运算符
    if (source.type !== 'opval') return;
    bctxPushUndo();
    target.ref.chain.ops[target.ref.index] = source.op;
    renderChain();
    return;
  }
  if (target.kind === 'chain-append') {
    const chain = target.ref.chain;
    if (source.type === 'opval') {
      // 追加运算符 + 默认数值
      bctxPushUndo();
      chain.ops.push(source.op);
      chain.terms.push(N0());
    } else {
      // 追加数值项 + 默认运算符
      let node;
      if (source.type === 'palette') {
        node = source.make();
        bctxPushUndo();
      } else if (source.type === 'expr') {
        if (!source.detach) return;
        bctxPushUndo(); // 先快照 detach 前状态
        node = source.detach();
      } else return;
      chain.ops.push('+');
      chain.terms.push(node);
    }
    renderChain();
    return;
  }
  if (target.kind === 'slot') {
    let node;
    if (source.type === 'palette') {
      node = source.make();
      bctxPushUndo();
    } else if (source.type === 'expr') {
      if (!source.detach) return;
      bctxPushUndo(); // 先快照 detach 前状态，否则撤销后原值会丢成 0
      node = source.detach();
    } else return;
    target.ref.set(node);
    renderChain();
    return;
  }
  if (target.kind === 'stmt-drop') {
    if (source.type !== 'palette') return;
    bctxPushUndo();
    const stmt = source.make();
    if (target.frag) target.frag.stmts.splice(target.index, 0, stmt);
    else bctx.chain.splice(target.index, 0, stmt);
    renderChain(); renderPalette();
    return;
  }
  if (target.kind === 'blank') {
    if (source.type !== 'palette' || !source.stmt) return;
    bctxPushUndo();
    bctx.frags.push({ stmts: [source.make()], x: target.x, y: target.y });
    renderChain(); renderPalette();
    return;
  }
}

/* =========================================================================
 * 生命周期
 * ======================================================================= */

function ensurePuzzleDom() {
  if (document.getElementById('puzzle-overlay')) return;
  const vp = document.getElementById('viewport');
  viewportOrigin = { parent: vp.parentElement, next: vp.nextSibling };

  const overlay = document.createElement('div');
  overlay.id = 'puzzle-overlay';

  // 主区：左调色板 + 分隔条 + 右工作区
  const main = document.createElement('div');
  main.className = 'puzzle-main';
  const palette = document.createElement('div');
  palette.id = 'puzzle-palette';
  const palList = document.createElement('div');
  palList.id = 'pal-list';
  palette.appendChild(palList);
  const palResize = document.createElement('div');
  palResize.id = 'pal-resize';
  const workspace = document.createElement('div');
  workspace.id = 'puzzle-workspace';
  const chainCanvas = document.createElement('div');
  chainCanvas.className = 'chain-canvas';
  chainCanvas.id = 'chain-canvas';
  const chainVars = document.createElement('div');
  chainVars.className = 'chain-vars';
  chainVars.id = 'chain-vars';
  workspace.appendChild(chainCanvas);
  workspace.appendChild(chainVars);
  main.appendChild(palette);
  main.appendChild(palResize);
  main.appendChild(workspace);
  overlay.appendChild(main);

  document.body.appendChild(overlay);

  // 顶部工具栏
  const toolbar = document.createElement('div');
  toolbar.id = 'puzzle-toolbar';
  const mkBtn = (id, text, cls) => { const b = document.createElement('button'); b.id = id; b.textContent = text; b.className = cls || 'btn'; return b; };
  const title = document.createElement('span'); title.className = 'pz-title'; title.textContent = t('blk.title');
  const fxName = document.createElement('span'); fxName.className = 'pz-fx'; fxName.id = 'puzzle-fx-name';
  const spacer = document.createElement('span'); spacer.className = 'pz-spacer';
  toolbar.appendChild(title); toolbar.appendChild(fxName); toolbar.appendChild(spacer);
  const lensBtn = document.createElement('button');
  lensBtn.id = 'puzzle-lens';
  lensBtn.className = 'pz-lens';
  lensBtn.textContent = '🔍';
  lensBtn.title = t('blk.lensHint');
  lensBtn.addEventListener('pointerdown', beginLensDrag);
  toolbar.appendChild(lensBtn);
  toolbar.appendChild(mkBtn('puzzle-ok', t('common.ok'), 'btn bd-ok'));
  toolbar.appendChild(mkBtn('puzzle-cancel', t('common.cancel')));
  document.body.appendChild(toolbar);

  // 场景悬浮窗（右下角）
  const vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
  const sceneWin = makeFloatWindow('fwin-scene', t('blk.scene'), { x: vw - 440, y: vh - 320, w: 420, h: 300, minW: 240, minH: 160, onResize: () => { if (typeof resize === 'function') resize(); } });
  document.body.appendChild(sceneWin.el);

  // 代码回显悬浮窗（默认在场景上方）
  const echoWin = makeFloatWindow('fwin-echo', t('blk.code'), { x: vw - 440, y: vh - 560, w: 340, h: 200, minW: 200, minH: 120 });
  const echoText = document.createElement('div');
  echoText.className = 'echo-text'; echoText.id = 'echo-text';
  echoWin.body.appendChild(echoText);
  document.body.appendChild(echoWin.el);

  puzzleWin = { scene: sceneWin, echo: echoWin };

  document.getElementById('puzzle-ok').addEventListener('click', () => closeBlockDrawer(true));
  document.getElementById('puzzle-cancel').addEventListener('click', () => closeBlockDrawer(false));

  // 调色盘宽度拖动
  (function setupPalResize() {
    const handle = document.getElementById('pal-resize');
    const mainEl = document.querySelector('.puzzle-main');
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.classList.add('dragging');
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!handle.classList.contains('dragging')) return;
      const rect = mainEl.getBoundingClientRect();
      let w = e.clientX - rect.left;
      w = Math.max(180, Math.min(500, w));
      mainEl.style.setProperty('--pal-w', w + 'px');
      saveWorkspaceState();
    });
    handle.addEventListener('pointerup', () => { handle.classList.remove('dragging'); saveWorkspaceState(); });
  })();

  // 工作区平移 + 缩放
  (function setupCanvasPanZoom() {
    const canvas = document.getElementById('chain-canvas');
    let pan = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.blk-drag') || e.target.closest('.blk-slot') || e.target.closest('.blk-stmt-drop')) return;
      pan = { x: e.clientX, y: e.clientY, lx: bctx.layout.view.x, ly: bctx.layout.view.y };
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add('panning');
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!pan) return;
      bctx.layout.view.x = pan.lx + (e.clientX - pan.x);
      bctx.layout.view.y = pan.ly + (e.clientY - pan.y);
      applyChainView();
    });
    canvas.addEventListener('pointerup', () => { pan = null; canvas.classList.remove('panning'); });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const s = bctx.layout.view.scale * (e.deltaY < 0 ? 1.1 : 0.9);
      bctx.layout.view.scale = Math.min(2.5, Math.max(0.4, s));
      applyChainView();
    }, { passive: false });
  })();
}

function applyChainView() {
  if (!bctx) return;
  const plane = document.querySelector('#chain-canvas .chain-plane');
  if (plane) {
    plane.style.transform = 'translate(' + bctx.layout.view.x + 'px,' + bctx.layout.view.y + 'px) scale(' + bctx.layout.view.scale + ')';
  }
  // 点阵背景跟随视图平移/缩放，实现无限延伸
  const canvas = document.getElementById('chain-canvas');
  if (canvas) {
    const s = 22 * bctx.layout.view.scale;
    canvas.style.backgroundSize = s + 'px ' + s + 'px';
    canvas.style.backgroundPosition = bctx.layout.view.x + 'px ' + bctx.layout.view.y + 'px';
  }
}

function openBlockDrawer(fx) {
  ensurePuzzleDom();
  let chain;
  try { chain = codeToStatements(fx.code); }
  catch (e) { modalAlert(t('blk.openFailTitle'), tf('blk.parseFail', e.message)); return; }
  const varExprs = {};
  const varOrder = [];
  for (const name of Object.keys(fx.vars)) {
    const v = fx.vars[name];
    if ((v.kf || []).length > 0) continue;
    try { varExprs[name] = parseVarExpr(v.expr || '0'); varOrder.push(name); }
    catch (e) { modalAlert(t('blk.varExprErrTitle'), tf('blk.varExprErr', name, e.message)); return; }
  }
  const saved = fx.ui || {};
  bctx = {
    fxId: fx.id,
    chain,
    frags: (saved.frags || []).map(f => ({ stmts: codeToStatements(f.code || ''), x: f.x, y: f.y })),
    varExprs, varOrder,
    snapshot: { code: fx.code, vars: cloneVars(fx.vars), preset: fx.preset, params: fx.params },
    undoStack: [], redoStack: [],
    layout: {
      chain: saved.chain || { x: 40, y: 40 },
      view: saved.view || { x: 0, y: 0, scale: 1 },
    },
  };
  // 窗口位置状态从 localStorage 工作区恢复
  applyWorkspaceState();

  // 先进入拼图模式（窗口显示），再移动 viewport 并 resize，否则 viewport 尺寸为 0 导致场景不可见
  document.getElementById('puzzle-fx-name').textContent = fx.name || fx.id;
  document.body.classList.add('puzzle-mode');

  const vp = document.getElementById('viewport');
  puzzleWin.scene.body.appendChild(vp);
  if (typeof resize === 'function') resize();

  // 清除选中，隐藏 gizmo
  state.selected.clear();
  state.selectedGroup = null;
  state.selectedFunction = null;
  if (typeof gizmoGroup !== 'undefined') gizmoGroup.visible = false;

  renderPalette();
  renderChain();
}

function closeBlockDrawer(commit) {
  if (!bctx) return;
  const fx = getFunction(bctx.fxId);
  if (commit && fx) {
    const newCode = statementsToCode(bctx.chain);
    fx.code = newCode;
    for (const name of bctx.varOrder) {
      if (name in bctx.varExprs) {
        const v = fx.vars[name];
        if (v && (v.kf || []).length === 0) v.expr = varExprToCode(bctx.varExprs[name]);
      }
    }
    if (newCode !== bctx.snapshot.code) { fx.preset = null; fx.params = null; }
    pushUndo();
    commitFunctionRebuild(fx);
  } else if (fx) {
    fx.code = bctx.snapshot.code;
    fx.vars = cloneVars(bctx.snapshot.vars);
    fx.preset = bctx.snapshot.preset;
    fx.params = bctx.snapshot.params;
    commitFunctionRebuild(fx);
  }
  if (fx) {
    fx.ui = {
      chain: bctx.layout.chain,
      view: bctx.layout.view,
      frags: bctx.frags.map(f => ({ code: statementsToCode(f.stmts), x: f.x, y: f.y })),
    };
  }
  // 窗口位置状态保存到 localStorage 工作区
  saveWorkspaceState();

  const vp = document.getElementById('viewport');
  if (viewportOrigin && viewportOrigin.parent) {
    if (viewportOrigin.next) viewportOrigin.parent.insertBefore(vp, viewportOrigin.next);
    else viewportOrigin.parent.appendChild(vp);
  }

  document.body.classList.remove('puzzle-mode');
  if (typeof resize === 'function') resize();
  if (typeof drawTimeline === 'function') drawTimeline();

  // 重新选中该函数对象（确定/取消后保持一致选中反馈）
  if (fx) {
    state.selectedFunction = fx.id;
    state.selected.clear();
    state.selectedGroup = null;
    if (typeof rebuildPoints === 'function') rebuildPoints();
    if (typeof refreshParticleTree === 'function') refreshParticleTree();
  }
  bctx = null;
  refreshFunctionPanel();
}

function refreshCodeEcho() {
  const el = document.getElementById('echo-text');
  if (!el || !bctx) return;
  el.textContent = statementsToCode(bctx.chain);
  // 实时生效：每次拼图变化后自动预览
  blockPreview();
}

function blockPreview() {
  if (!bctx) return;
  const fx = getFunction(bctx.fxId);
  if (!fx) return;
  fx.code = statementsToCode(bctx.chain);
  for (const name of bctx.varOrder) {
    if (name in bctx.varExprs) {
      const v = fx.vars[name];
      if (v && (v.kf || []).length === 0) v.expr = varExprToCode(bctx.varExprs[name]);
    }
  }
  commitFunctionRebuild(fx);
}

/* =========================================================================
 * 撤销
 * ======================================================================= */

function bctxPushUndo() {
  if (!bctx) return;
  bctx.undoStack.push(snapBctx());
  if (bctx.undoStack.length > 100) bctx.undoStack.shift();
  bctx.redoStack.length = 0;
}
function snapBctx() {
  return {
    chain: cloneStmts(bctx.chain),
    frags: bctx.frags.map(f => ({ stmts: cloneStmts(f.stmts), x: f.x, y: f.y })),
    varExprs: deepCloneVarExprs(bctx.varExprs),
    chainPos: { x: bctx.layout.chain.x, y: bctx.layout.chain.y },
  };
}
function restoreBctx(s) {
  bctx.chain = cloneStmts(s.chain);
  bctx.frags = s.frags.map(f => ({ stmts: cloneStmts(f.stmts), x: f.x, y: f.y }));
  bctx.varExprs = deepCloneVarExprs(s.varExprs);
  bctx.layout.chain = { x: s.chainPos.x, y: s.chainPos.y };
}
function deepCloneVarExprs(o) { const r = {}; for (const k in o) r[k] = cloneExprNode(o[k]); return r; }
function bctxUndo() {
  if (!bctx || bctx.undoStack.length === 0) return;
  bctx.redoStack.push(snapBctx());
  restoreBctx(bctx.undoStack.pop());
  renderChain(); renderPalette();
}
function bctxRedo() {
  if (!bctx || bctx.redoStack.length === 0) return;
  bctx.undoStack.push(snapBctx());
  restoreBctx(bctx.redoStack.pop());
  renderChain(); renderPalette();
}

/* =========================================================================
 * 工作区持久化（localStorage）：窗口位置状态、调色盘宽、粒子列表宽、上次路径
 * ======================================================================= */

const WS_KEY = 'particledrawing.workspace';

function loadWorkspaceState() {
  try {
    const s = JSON.parse(localStorage.getItem(WS_KEY) || '{}');
    return s || {};
  } catch (e) { return {}; }
}
function saveWorkspaceState() {
  const s = loadWorkspaceState();
  // 窗口位置状态
  if (puzzleWin && puzzleWin.scene) {
    s.sceneWin = { x: puzzleWin.scene.x, y: puzzleWin.scene.y, w: puzzleWin.scene.w, h: puzzleWin.scene.h, min: puzzleWin.scene.isMinimized };
    s.echoWin = { x: puzzleWin.echo.x, y: puzzleWin.echo.y, w: puzzleWin.echo.w, h: puzzleWin.echo.h, min: puzzleWin.echo.isMinimized };
  }
  // 调色盘宽
  const mainEl = document.querySelector('.puzzle-main');
  if (mainEl) s.paletteWidth = mainEl.style.getPropertyValue('--pal-w') || null;
  // 粒子列表宽
  const layout = document.querySelector('.layout');
  if (layout) s.particleListWidth = layout.style.getPropertyValue('--left-w') || null;
  // 右侧栏宽
  if (layout) s.rightPanelWidth = layout.style.getPropertyValue('--right-w') || null;
  // 时间轴模块高度（body 网格第三行变量）：优先读内联值；无头测试环境的极简 style 桩会被 try/能力检查跳过
  let curTlH = '';
  try {
    const bs = document.body && document.body.style;
    if (bs && typeof bs.getPropertyValue === 'function') curTlH = bs.getPropertyValue('--tl-h').trim();
    else if (typeof getComputedStyle === 'function') curTlH = getComputedStyle(document.body).getPropertyValue('--tl-h').trim();
  } catch (_) {}
  if (curTlH) s.tlModuleH = curTlH;
  try { localStorage.setItem(WS_KEY, JSON.stringify(s)); } catch (e) {}
}
function applyWorkspaceState() {
  const s = loadWorkspaceState();
  // 粒子列表宽
  const layout = document.querySelector('.layout');
  if (layout && s.particleListWidth) layout.style.setProperty('--left-w', s.particleListWidth);
  // 右侧栏宽
  if (layout && s.rightPanelWidth) layout.style.setProperty('--right-w', s.rightPanelWidth);
  // 调色盘宽
  const mainEl = document.querySelector('.puzzle-main');
  if (mainEl && s.paletteWidth) mainEl.style.setProperty('--pal-w', s.paletteWidth);
  // 时间轴模块高度（body 网格第三行变量）
  try {
    const bs = document.body && document.body.style;
    if (s.tlModuleH && bs && typeof bs.setProperty === 'function') bs.setProperty('--tl-h', s.tlModuleH);
  } catch (_) {}
  // 窗口状态（在 ensurePuzzleDom 后应用）
  if (puzzleWin && s.sceneWin) {
    puzzleWin.scene.setPos(s.sceneWin.x, s.sceneWin.y);
    puzzleWin.scene.setSize(s.sceneWin.w, s.sceneWin.h);
    if (s.sceneWin.min) puzzleWin.scene.minimize();
  }
  if (puzzleWin && s.echoWin) {
    puzzleWin.echo.setPos(s.echoWin.x, s.echoWin.y);
    puzzleWin.echo.setSize(s.echoWin.w, s.echoWin.h);
    if (s.echoWin.min) puzzleWin.echo.minimize();
  }
}

/* =========================================================================
 * 放大镜（拖到拼图上查看含义）
 * ======================================================================= */

let lensDrag = null;

function beginLensDrag(e) {
  e.preventDefault();
  e.stopPropagation();
  lensDrag = { startX: e.clientX, startY: e.clientY, moved: false, ghost: null, shownInfo: null };
  const ghost = document.createElement('div');
  ghost.className = 'lens-ghost';
  ghost.textContent = '🔍';
  ghost.style.left = e.clientX + 'px';
  ghost.style.top = e.clientY + 'px';
  document.body.appendChild(ghost);
  lensDrag.ghost = ghost;
}

function moveLensGhost(clientX, clientY) {
  if (!lensDrag) return;
  if (Math.hypot(clientX - lensDrag.startX, clientY - lensDrag.startY) > 3) lensDrag.moved = true;
  lensDrag.ghost.style.left = clientX + 'px';
  lensDrag.ghost.style.top = clientY + 'px';
  const infoEl = findInfoEl(document.elementFromPoint(clientX, clientY));
  const info = (infoEl && infoEl._info) || '';
  if (info !== lensDrag.shownInfo) {
    lensDrag.shownInfo = info;
    if (info) showPaletteTip(infoEl, info);
    else hidePaletteTip();
  }
}

function findInfoEl(el) {
  let cur = el;
  while (cur && cur !== document.body) {
    if (cur._info) return cur;
    cur = cur.parentElement;
  }
  return null;
}

function endLensDrag(clientX, clientY) {
  if (!lensDrag) return;
  if (lensDrag.ghost) lensDrag.ghost.remove();
  lensDrag = null;
  hidePaletteTip();
}

/* =========================================================================
 * 事件绑定
 * ======================================================================= */

(function initBlockDrag() {
  window.addEventListener('pointerdown', (ev) => {
    if (!bctx) return;
    if (ev.button !== 0) return; // 仅左键拖拽，中键/右键不移动拼图
    hidePaletteTip();
    const t = ev.target;
    if (t.closest && (t.closest('input') || t.closest('button') || t.closest('select') || t.closest('.fwin-titlebar') || t.closest('.fwin-rsz'))) return;
    const dragEl = t.closest && t.closest('.blk-drag');
    if (dragEl && t.closest('#puzzle-overlay, #fwin-scene')) {
      ev.preventDefault();
      beginBlockDrag(dragEl, ev.clientX, ev.clientY);
    }
  }, true);

  window.addEventListener('pointermove', (ev) => { if (bdrag) moveGhost(ev.clientX, ev.clientY); else if (lensDrag) moveLensGhost(ev.clientX, ev.clientY); });
  window.addEventListener('pointerup', (ev) => { if (bdrag) endBlockDrag(); else if (lensDrag) endLensDrag(ev.clientX, ev.clientY); });

  window.addEventListener('keydown', (ev) => {
    if (!bctx) return;
    const t = ev.target;
    const inTextInput = t && t.matches && t.matches('input, textarea');
    if (ev.ctrlKey && (ev.key === 'z' || ev.key === 'Z')) {
      if (inTextInput) return;
      ev.preventDefault(); ev.stopImmediatePropagation();
      if (ev.shiftKey) bctxRedo(); else bctxUndo();
    } else if (ev.ctrlKey && (ev.key === 'y' || ev.key === 'Y')) {
      if (inTextInput) return;
      ev.preventDefault(); ev.stopImmediatePropagation();
      bctxRedo();
    } else if (ev.key === 'Escape') {
      ev.preventDefault(); ev.stopImmediatePropagation();
      closeBlockDrawer(false);
    }
  }, true);
})();
