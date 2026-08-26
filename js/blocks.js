/* =========================================================================
 * 拼图代码块：积木树数据模型 + 代码文本 ↔ 积木树 双向转换 + 类型系统
 * 纯逻辑模块，无 DOM 依赖（可在 node 下测试）。
 *
 * 积木树：
 *   代码块 = 有序语句列表 [ statement, ... ]
 *   statement ：
 *     { kind:'pos'|'pos_vec'|'vel'|'vel_vec'|'col'|'scl'|'glow'|'light'|'set', ... }
 *   表达式节点 expr：
 *     { kind:'num', value }                    数字（可为负）
 *     { kind:'var', name }                     变量引用（i/n/t / 函数变量 / 临时变量）
 *     { kind:'func', name, args:[expr,...] }   函数调用
 *     { kind:'op', op:'+|-|*|/|%|^', a, b }    二元运算
 *     { kind:'chain', terms:[expr...], ops:[op...] } 动态算式（从左到右：t0 op0 t1 op1 t2 ...）
 *     { kind:'comp', axis:'x'|'y'|'z', target } 向量分量访问（后缀 .x/.y/.z）
 *     { kind:'neg', a }                        一元负号（仅用于 -x 等非数字；-数字合并进 num）
 * ======================================================================= */

/* —— 类型 —— */
const T_SCALAR = 'scalar';
const T_VEC = 'vec';
const T_MAT = 'mat';
const T_ANY = 'any'; // 临时变量（类型由赋值决定，放宽约束）

// PREC 复用 easing.js 的定义；ATOM_PREC 为原子表达式的虚拟优先级
const ATOM_PREC = 10;

/* —— 函数块定义：label 显示名，ret 返回类型，args 参数槽 [标签|i18n键, 类型]，desc|i18n键 —— */
/* 标签约定：以 "blk." 开头的为 i18n 键，其余（a/b/x/y/z/θ/φ/R/r 等）原样显示。 */
const FUNC_BLOCKS = {
  sin: { ret: T_SCALAR, args: [['blk.arg.angle', T_SCALAR]], desc: 'blk.func.sin.desc' },
  cos: { ret: T_SCALAR, args: [['blk.arg.angle', T_SCALAR]], desc: 'blk.func.cos.desc' },
  tan: { ret: T_SCALAR, args: [['blk.arg.angle', T_SCALAR]], desc: 'blk.func.tan.desc' },
  asin: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.asin.desc' },
  acos: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.acos.desc' },
  atan: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.atan.desc' },
  atan2: { ret: T_SCALAR, args: [['y', T_SCALAR], ['x', T_SCALAR]], desc: 'blk.func.atan2.desc' },
  sqrt: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.sqrt.desc' },
  abs: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.abs.desc' },
  sign: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.sign.desc' },
  exp: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.exp.desc' },
  log: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.log.desc' },
  ln: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.ln.desc' },
  floor: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.floor.desc' },
  ceil: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.ceil.desc' },
  round: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.round.desc' },
  fract: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR]], desc: 'blk.func.fract.desc' },
  pow: { ret: T_SCALAR, args: [['blk.arg.base', T_SCALAR], ['blk.arg.exp', T_SCALAR]], desc: 'blk.func.pow.desc' },
  min: { ret: T_SCALAR, args: [['a', T_SCALAR], ['b', T_SCALAR]], desc: 'blk.func.min.desc' },
  max: { ret: T_SCALAR, args: [['a', T_SCALAR], ['b', T_SCALAR]], desc: 'blk.func.max.desc' },
  clamp: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR], ['blk.arg.lo', T_SCALAR], ['blk.arg.hi', T_SCALAR]], desc: 'blk.func.clamp.desc' },
  lerp: { ret: T_SCALAR, args: [['a', T_SCALAR], ['b', T_SCALAR], ['t', T_SCALAR]], desc: 'blk.func.lerp.desc' },
  step: { ret: T_SCALAR, args: [['blk.arg.edge', T_SCALAR], ['blk.arg.value', T_SCALAR]], desc: 'blk.func.step.desc' },
  smoothstep: { ret: T_SCALAR, args: [['blk.arg.lo', T_SCALAR], ['blk.arg.hi', T_SCALAR], ['blk.arg.value', T_SCALAR]], desc: 'blk.func.smoothstep.desc' },
  mod: { ret: T_SCALAR, args: [['blk.arg.value', T_SCALAR], ['blk.arg.mod', T_SCALAR]], desc: 'blk.func.mod.desc' },
  random: { ret: T_SCALAR, args: [], desc: 'blk.func.random.desc' },
  rand: { ret: T_SCALAR, args: [['blk.arg.seed', T_SCALAR]], desc: 'blk.func.rand.desc' },
  vec: { ret: T_VEC, args: [['x', T_SCALAR], ['y', T_SCALAR], ['z', T_SCALAR]], desc: 'blk.func.vec.desc' },
  dot: { ret: T_SCALAR, args: [['a', T_VEC], ['b', T_VEC]], desc: 'blk.func.dot.desc' },
  cross: { ret: T_VEC, args: [['a', T_VEC], ['b', T_VEC]], desc: 'blk.func.cross.desc' },
  len: { ret: T_SCALAR, args: [['blk.arg.vec', T_ANY]], desc: 'blk.func.len.desc' },
  norm: { ret: T_VEC, args: [['blk.arg.vec', T_VEC]], desc: 'blk.func.norm.desc' },
  rotX: { ret: T_MAT, args: [['blk.arg.angle', T_SCALAR]], desc: 'blk.func.rotX.desc' },
  rotY: { ret: T_MAT, args: [['blk.arg.angle', T_SCALAR]], desc: 'blk.func.rotY.desc' },
  rotZ: { ret: T_MAT, args: [['blk.arg.angle', T_SCALAR]], desc: 'blk.func.rotZ.desc' },
  rotAxis: { ret: T_MAT, args: [['blk.arg.axis', T_VEC], ['blk.arg.angle', T_SCALAR]], desc: 'blk.func.rotAxis.desc' },
  polar: { ret: T_VEC, args: [['blk.arg.radius', T_SCALAR], ['blk.arg.angle', T_SCALAR]], desc: 'blk.func.polar.desc' },
  sphere: { ret: T_VEC, args: [['blk.arg.radius', T_SCALAR], ['θ', T_SCALAR], ['φ', T_SCALAR]], desc: 'blk.func.sphere.desc' },
  torus: { ret: T_VEC, args: [['R', T_SCALAR], ['r', T_SCALAR], ['θ', T_SCALAR], ['φ', T_SCALAR]], desc: 'blk.func.torus.desc' },
};

/* —— 语句块定义：label/desc 为 i18n 键（blk.stmt.<kind>.*），group 调色板分组 —— */
const STMT_BLOCKS = {
  pos: { label: 'blk.stmt.pos.label', group: 'pos', slotCount: 3, desc: 'blk.stmt.pos.desc' },
  pos_vec: { label: 'blk.stmt.pos_vec.label', group: 'pos', slotCount: 1, desc: 'blk.stmt.pos_vec.desc' },
  vel: { label: 'blk.stmt.vel.label', group: 'pos', slotCount: 3, desc: 'blk.stmt.vel.desc' },
  vel_vec: { label: 'blk.stmt.vel_vec.label', group: 'pos', slotCount: 1, desc: 'blk.stmt.vel_vec.desc' },
  col: { label: 'blk.stmt.col.label', group: 'color', slotCount: 4, desc: 'blk.stmt.col.desc' },
  scl: { label: 'blk.stmt.scl.label', group: 'appearance', slotCount: 1, desc: 'blk.stmt.scl.desc' },
  glow: { label: 'blk.stmt.glow.label', group: 'appearance', toggle: true, desc: 'blk.stmt.glow.desc' },
  light: { label: 'blk.stmt.light.label', group: 'appearance', slotCount: 1, desc: 'blk.stmt.light.desc' },
  attr: { label: 'blk.stmt.attr.label', group: 'pos', named: true, desc: 'blk.stmt.attr.desc' },
  set: { label: 'blk.stmt.set.label', group: 'var', named: true, desc: 'blk.stmt.set.desc' },
};

/* —— 调色板分组（顺序即显示顺序；label 为 i18n 键 blk.pal.<id>） —— */
const PALETTE_GROUPS = [
  { id: 'pos', label: 'blk.pal.pos' },
  { id: 'color', label: 'blk.pal.color' },
  { id: 'appearance', label: 'blk.pal.appearance' },
  { id: 'math', label: 'blk.pal.math' },
  { id: 'vec', label: 'blk.pal.vec' },
  { id: 'mat', label: 'blk.pal.mat' },
  { id: 'var', label: 'blk.pal.var' },
  { id: 'const', label: 'blk.pal.const' },
];

/* —— 运算符块（组内 math；值为 i18n 键 blk.op.*） —— */
const OP_SYMBOLS = ['+', '-', '*', '/', '%', '^'];
const OP_LABELS = { '+': 'blk.op.add', '-': 'blk.op.sub', '*': 'blk.op.mul', '/': 'blk.op.div', '%': 'blk.op.mod', '^': 'blk.op.pow' };

/* =========================================================================
 * 类型
 * ======================================================================= */

function typeAccepts(slotType, blockType) {
  if (slotType === T_ANY || blockType === T_ANY) return true;
  return slotType === blockType;
}

function opResultType(op, ta, tb) {
  if (op === '^' || op === '%') return T_SCALAR;
  if (op === '/') return (ta === T_VEC && (tb === T_SCALAR || tb === T_ANY)) ? T_VEC : T_SCALAR;
  if (op === '+' || op === '-') {
    if ((ta === T_VEC || ta === T_ANY) && (tb === T_VEC || tb === T_ANY)) return T_VEC;
    if ((ta === T_MAT || ta === T_ANY) && (tb === T_MAT || tb === T_ANY)) return T_MAT;
    return T_SCALAR;
  }
  if (op === '*') {
    if (ta === T_MAT && tb === T_VEC) return T_VEC;
    if (ta === T_MAT && tb === T_MAT) return T_MAT;
    if (ta === T_MAT) return T_MAT;
    if (ta === T_VEC && (tb === T_SCALAR || tb === T_ANY)) return T_VEC;
    if (ta === T_VEC && tb === T_VEC) return T_VEC;
    if ((ta === T_SCALAR || ta === T_ANY) && tb === T_VEC) return T_VEC;
    if ((ta === T_SCALAR || ta === T_ANY) && tb === T_MAT) return T_MAT;
    return T_SCALAR;
  }
  return T_ANY;
}

/** 推断表达式节点类型。varTypeOf(name) 返回该变量的类型（标量/向量/矩阵/any）。 */
function exprType(node, varTypeOf) {
  const vt = varTypeOf || (() => T_ANY);
  switch (node.kind) {
    case 'num': return T_SCALAR;
    case 'var': return (node.name === 'pi' || node.name === 'e') ? T_SCALAR : vt(node.name);
    case 'func': return FUNC_BLOCKS[node.name].ret;
    case 'comp': return T_SCALAR;
    case 'neg': return exprType(node.a, vt);
    case 'chain': {
      // 按运算符优先级求类型（* / % 优先于 + -），与 exprToCode 生成代码的求值语义一致
      const tt = node.terms.map(t => exprType(t, vt));
      const oo = node.ops.slice();
      for (let i = 0; i < oo.length;) {
        if (oo[i] === '*' || oo[i] === '/' || oo[i] === '%') {
          tt[i] = opResultType(oo[i], tt[i], tt[i + 1]);
          tt.splice(i + 1, 1);
          oo.splice(i, 1);
        } else {
          i++;
        }
      }
      let t = tt[0];
      for (let j = 0; j < oo.length; j++) t = opResultType(oo[j], t, tt[j + 1]);
      return t;
    }
    case 'op': return opResultType(node.op, exprType(node.a, vt), exprType(node.b, vt));
    default: return T_ANY;
  }
}

/* =========================================================================
 * 代码生成（积木树 → 文本）
 * ======================================================================= */

function fmtNum(v) {
  if (!Number.isFinite(v)) return '0';
  const neg = v < 0;
  const a = Math.abs(v);
  let s = String(a);
  if (s.includes('e') || s.includes('E')) s = a.toFixed(15).replace(/\.?0+$/, '');
  s = (s === '-0' || s === '') ? '0' : s;
  return neg ? '-' + s : s;
}

/** 表达式节点 → 代码。parentPrec 为父级要求的优先级（低于则加括号）。 */
function exprToCode(node, parentPrec) {
  let s, p;
  switch (node.kind) {
    case 'num':
      // 负数字面量作为操作数时需加括号（如 2 * -3 → 2 * (-3)），优先级降到最低
      s = fmtNum(node.value);
      p = (node.value < 0) ? 0.5 : ATOM_PREC;
      break;
    case 'var':
      s = node.name; p = ATOM_PREC; break;
    case 'func':
      s = node.name + '(' + node.args.map(a => exprToCode(a, 0)).join(', ') + ')'; p = ATOM_PREC; break;
    case 'comp':
      s = exprToCode(node.target, ATOM_PREC) + '.' + node.axis; p = ATOM_PREC; break;
    case 'neg':
      s = '-' + exprToCode(node.a, NEG_PREC); p = NEG_PREC; break;
    case 'op': {
      const prec = PREC[node.op];
      const rightAssoc = node.op === '^';
      // 左结合：左操作数用 prec、右操作数用 prec+1；右结合(^)：左操作数用 prec+1、右操作数用 prec
      const left = exprToCode(node.a, prec + (rightAssoc ? 1 : 0));
      const right = exprToCode(node.b, rightAssoc ? prec : prec + 1);
      s = left + ' ' + node.op + ' ' + right;
      p = prec;
      break;
    }
    case 'chain': {
      // 动态算式：从左到右 t0 op0 t1 op1 t2 ...，按标准优先级加括号
      // 首项作为第一个 op 的左操作数；中间项作为前一个 op 的右操作数；末项作为最后一个 op 的右操作数
      const n = node.ops.length;
      s = exprToCode(node.terms[0], n > 0 ? PREC[node.ops[0]] : 0);
      for (let i = 0; i < n; i++) {
        const op = node.ops[i];
        const prec = PREC[op];
        s += ' ' + op + ' ' + exprToCode(node.terms[i + 1], prec + 1);
      }
      // 整体优先级取所有运算符的最低（混合优先级 chain 下首个不一定最低），用于父级加括号判断
      p = ATOM_PREC;
      for (let i = 0; i < n; i++) { const pr = PREC[node.ops[i]]; if (pr < p) p = pr; }
      break;
    }
    default: throw new Error(_etf('err.unknownExprNode', node.kind));
  }
  return (p < parentPrec) ? '(' + s + ')' : s;
}

/** 变量表达式（标量）→ 代码。 */
function varExprToCode(node) { return exprToCode(node, 0); }

function stmtToCode(s) {
  switch (s.kind) {
    case 'pos': return '[x,y,z] = [' + s.slots.map(x => exprToCode(x, 0)).join(', ') + ']';
    case 'pos_vec': return '[x,y,z] = ' + exprToCode(s.expr, 0);
    case 'vel': return '[vx,vy,vz] = [' + s.slots.map(x => exprToCode(x, 0)).join(', ') + ']';
    case 'vel_vec': return '[vx,vy,vz] = ' + exprToCode(s.expr, 0);
    case 'col': return '[r,g,b,a] = [' + s.slots.map(x => exprToCode(x, 0)).join(', ') + ']';
    case 'scl': return 'sc = ' + exprToCode(s.expr, 0);
    case 'glow': return 'glow = ' + (s.on ? '1' : '0');
    case 'light': return 'light = ' + exprToCode(s.expr, 0);
    case 'attr': return s.name + ' = ' + exprToCode(s.expr, 0);
    case 'set': return s.name + ' = ' + exprToCode(s.expr, 0);
    default: throw new Error(_etf('err.unknownStmt', s.kind));
  }
}

function statementsToCode(stmts) {
  return stmts.map(stmtToCode).join(';\n');
}

/* =========================================================================
 * 代码解析（文本 → 积木树）
 * ======================================================================= */

/**
 * 拼图专用分词：与 easing.js 的 tokenize 等价，但 pi/e 保留为标识符
 * 使往返序列化保持 `pi`/`e` 原样、不损失精度。
 */
function blockTokenize(expr) {
  const tokens = [];
  let i = 0;
  let expectOperand = true;
  while (i < expr.length) {
    const c = expr[i];
    if (c === ' ' || c === '\t' || c === '\n') { i++; continue; }
    if (c === '.' && (expr[i + 1] === 'x' || expr[i + 1] === 'y' || expr[i + 1] === 'z')) {
      tokens.push({ t: 'comp', axis: expr[i + 1] }); i += 2; expectOperand = false; continue;
    }
    if ((c >= '0' && c <= '9') || c === '.') {
      let j = i; while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
      tokens.push({ t: 'num', v: parseFloat(expr.slice(i, j)) }); i = j; expectOperand = false; continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i; while (j < expr.length && /[a-zA-Z0-9_]/.test(expr[j])) j++;
      const name = expr.slice(i, j);
      if (name in FUNCS) tokens.push({ t: 'func', name });
      else tokens.push({ t: 'var', name }); // pi/e 归为 var，序列化时原样输出
      i = j; expectOperand = false; continue;
    }
    if (c === '-' && expectOperand) { tokens.push({ t: 'neg' }); i++; continue; } // 一元负号
    if ('+-*/%^(),'.includes(c)) { tokens.push({ t: c }); i++; expectOperand = (c === '(' || c === ',' || '+-*/%^'.includes(c)); continue; }
    i++;
  }
  return tokens;
}

/** 表达式字符串 → 表达式节点（递归下降，基于 blockTokenize）。 */
function parseExpr(str) {
  const toks = blockTokenize(str);
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const expect = (t) => { const tk = next(); if (!tk || tk.t !== t) throw new Error(_etf('err.exprNeed', t, str)); return tk; };

  function parsePrimary() {
    const tk = next();
    if (!tk) throw new Error(_et('err.exprEnd'));
    let node;
    if (tk.t === 'num') node = { kind: 'num', value: tk.v };
    else if (tk.t === 'var') node = { kind: 'var', name: tk.name };
    else if (tk.t === 'neg') {
      // 一元负号：-数字 合并为负 num；其余包成 neg 节点（优先级 NEG_PREC，低于 ^）
      const inner = parsePower();
      if (inner.kind === 'num') node = { kind: 'num', value: -inner.value };
      else node = { kind: 'neg', a: inner };
    } else if (tk.t === 'func') {
      if (!peek() || peek().t !== '(') throw new Error(_etf('err.funcNoParen', tk.name));
      next(); // '('
      const args = [];
      if (peek() && peek().t !== ')') {
        args.push(parseAddSub());
        while (peek() && peek().t === ',') { next(); args.push(parseAddSub()); }
      }
      expect(')');
      node = { kind: 'func', name: tk.name, args };
    } else if (tk.t === '(') {
      node = parseAddSub();
      expect(')');
    } else {
      throw new Error(_etf('err.unexpectedTok', tk.t || JSON.stringify(tk)));
    }
    while (peek() && peek().t === 'comp') {
      const c = next();
      node = { kind: 'comp', axis: c.axis, target: node };
    }
    return node;
  }

  function parsePower() {
    let node = parsePrimary();
    if (peek() && peek().t === '^') { next(); node = { kind: 'op', op: '^', a: node, b: parsePower() }; }
    return node;
  }
  function parseMulDiv() {
    const terms = [parsePower()];
    const ops = [];
    while (peek() && (peek().t === '*' || peek().t === '/' || peek().t === '%')) {
      ops.push(next().t);
      terms.push(parsePower());
    }
    // 扁平化冗余括号：首项（无前置运算符的左操作数）若为同优先级二元运算（如 (i%m) 或 (a*b)），
    // 左结合下括号冗余，展开进算式以得到扁平 chain（避免 { [i] % [m] } / ... 的嵌套）
    const first = terms[0];
    if (first.kind === 'op' && (first.op === '*' || first.op === '/' || first.op === '%')) {
      terms.splice(0, 1, first.a, first.b);
      ops.unshift(first.op);
    }
    return (terms.length === 1) ? terms[0] : (terms.length === 2) ? { kind: 'op', op: ops[0], a: terms[0], b: terms[1] } : { kind: 'chain', terms, ops };
  }
  function parseAddSub() {
    const terms = [parseMulDiv()];
    const ops = [];
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      ops.push(next().t);
      terms.push(parseMulDiv());
    }
    if (terms.length === 1) return terms[0];
    // 扁平化：吸收「首运算符优先级高于 + -」的子 chain（如 1 - 2*x/n → chain([1,2,x,n],['-','*','/'])），
    // 嵌套最少且语义不变。此类子 chain 来自无括号的 * / % 折叠（或冗余括号），可安全拍平；
    // 若子 chain 首运算符仍是 + -（括号必要，如 3-(1-2*x/n)），则不吸收、保留括号。
    const absorbable = (t) => t.kind === 'chain' && PREC[t.ops[0]] > 1;
    if (terms.some(absorbable)) {
      const ft = [];
      const fo = [];
      for (let i = 0; i < terms.length; i++) {
        if (i > 0) fo.push(ops[i - 1]);
        const t = terms[i];
        if (absorbable(t)) {
          ft.push(t.terms[0]);
          for (let j = 0; j < t.ops.length; j++) { fo.push(t.ops[j]); ft.push(t.terms[j + 1]); }
        } else {
          ft.push(t);
        }
      }
      return { kind: 'chain', terms: ft, ops: fo };
    }
    return (terms.length === 2) ? { kind: 'op', op: ops[0], a: terms[0], b: terms[1] } : { kind: 'chain', terms, ops };
  }

  const node = parseAddSub();
  if (pos < toks.length) throw new Error(_etf('err.exprExtra', str));
  return node;
}

/** 变量表达式字符串 → 表达式节点。 */
function parseVarExpr(str) { return parseExpr(str); }

const isNames = (names, expect) => names.length === expect.length && names.every((n, i) => n === expect[i]);

function stmtToNode(stmt) {
  const eq = stmt.indexOf('=');
  if (eq < 0) throw new Error(_etf('err.stmtMissingEq', stmt));
  const lhs = stmt.slice(0, eq).trim();
  const rhs = stmt.slice(eq + 1).trim();
  if (lhs.startsWith('[')) {
    const names = parseNameList(lhs);
    if (rhs.startsWith('[')) {
      const exprs = parseExprList(rhs).map(e => parseExpr(e));
      if (names.length !== exprs.length) throw new Error(_etf('err.assignCount2', stmt));
      if (isNames(names, ['x', 'y', 'z'])) return { kind: 'pos', slots: exprs };
      if (isNames(names, ['vx', 'vy', 'vz'])) return { kind: 'vel', slots: exprs };
      if (isNames(names, ['r', 'g', 'b', 'a'])) return { kind: 'col', slots: exprs };
      throw new Error(_etf('err.unknownPack', stmt));
    }
    const e = parseExpr(rhs);
    if (isNames(names, ['x', 'y', 'z'])) return { kind: 'pos_vec', expr: e };
    if (isNames(names, ['vx', 'vy', 'vz'])) return { kind: 'vel_vec', expr: e };
    throw new Error(_etf('err.unknownUnpack', stmt));
  }
  if (lhs === 'sc') return { kind: 'scl', expr: parseExpr(rhs) };
  if (lhs === 'glow') {
    const e = parseExpr(rhs);
    if (e.kind === 'num' && (e.value === 1 || e.value === 0)) return { kind: 'glow', on: e.value === 1 };
    throw new Error(_etf('err.glowBinary', stmt));
  }
  if (lhs === 'light') return { kind: 'light', expr: parseExpr(rhs) };
  if (ATTR_NAMES.includes(lhs)) return { kind: 'attr', name: lhs, expr: parseExpr(rhs) };
  return { kind: 'set', name: lhs, expr: parseExpr(rhs) };
}

/** 代码文本 → 语句列表。解析失败抛错（调用方按 q24 提示并禁止打开）。 */
function codeToStatements(code) {
  return (code || '').split(';').map(s => s.trim()).filter(Boolean).map(stmtToNode);
}

/** 收集语句列表里的临时变量名（set 块）。 */
function collectTemps(stmts) {
  const out = [];
  const seen = new Set();
  for (const s of stmts) {
    if (s.kind === 'set' && !seen.has(s.name)) { seen.add(s.name); out.push(s.name); }
  }
  return out;
}
