// 脚本语言解析器：tokenizer + 递归下降 parser → AST。纯逻辑，无 DOM/THREE 依赖。
// 词法常量从 ./lexical.js 引入。

import { KEYWORDS, CTX_NAME, LIFECYCLE_FUNCS, CONSTANTS, COMP_NAMES, BUILTIN_FUNCTIONS, parseError } from './lexical.js';

// 复合赋值运算符 → 对应的二元运算符。
const COMPOUND_ASSIGN = { '+=': '+', '-=': '-', '*=': '*', '/=': '/', '%=': '%', '^=': '^' };

// 表达式/语句嵌套深度上限：递归下降解析在超深输入（如数万层括号）前主动报错，
// 避免浏览器端 RangeError 或 Kotlin 端 StackOverflowError。
const MAX_PARSE_DEPTH = 512;

// —— Tokenizer ——

function isDigit(c) { return c >= '0' && c <= '9'; }
function isIdentStart(c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'; }
function isIdentPart(c) { return isIdentStart(c) || isDigit(c); }

function tokenize(source) {
  const tokens = [];
  const src = String(source == null ? '' : source);
  const len = src.length;
  let i = 0;
  let line = 1;
  let col = 1;
  let nlSeen = false;

  const advance = () => {
    const c = src[i++];
    if (c === '\n') { line++; col = 1; nlSeen = true; } else { col++; }
    return c;
  };

  // 每个 token 记录「前一个 token 之后是否出现过换行」，供解析器做换行断句判定。
  const push = (tok) => {
    tok.nl = nlSeen;
    nlSeen = false;
    tokens.push(tok);
  };

  while (i < len) {
    const c = src[i];

    // 空白
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { advance(); continue; }

    // 行注释
    if (c === '/' && src[i + 1] === '/') {
      while (i < len && src[i] !== '\n') advance();
      continue;
    }

    // 块注释
    if (c === '/' && src[i + 1] === '*') {
      const startLine = line, startCol = col;
      advance(); advance();
      let closed = false;
      while (i < len) {
        if (src[i] === '*' && src[i + 1] === '/') { advance(); advance(); closed = true; break; }
        advance();
      }
      if (!closed) throw parseError('unterminated block comment', startLine, startCol);
      continue;
    }

    // 数字：123、1.5、.5、1e3（负号由一元 - 处理）
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      const startLine = line, startCol = col;
      const m = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i));
      const text = m[0];
      for (let k = 0; k < text.length; k++) advance();
      push({ type: 'num', value: parseFloat(text), line: startLine, col: startCol });
      continue;
    }

    // 字符串
    if (c === '"') {
      const startLine = line, startCol = col;
      advance();
      let out = '';
      let closed = false;
      while (i < len) {
        const ch = src[i];
        if (ch === '"') { advance(); closed = true; break; }
        if (ch === '\\') {
          advance();
          const esc = src[i];
          if (esc === 'n') { out += '\n'; advance(); }
          else if (esc === 'r') { out += '\r'; advance(); }
          else if (esc === 't') { out += '\t'; advance(); }
          else if (esc === '"') { out += '"'; advance(); }
          else if (esc === '\\') { out += '\\'; advance(); }
          else { out += esc; advance(); }
          continue;
        }
        out += ch;
        advance();
      }
      if (!closed) throw parseError('unterminated string literal', startLine, startCol);
      push({ type: 'str', value: out, line: startLine, col: startCol });
      continue;
    }

    // 标识符 / 关键字
    if (isIdentStart(c)) {
      const startLine = line, startCol = col;
      let name = '';
      while (i < len && isIdentPart(src[i])) name += advance();
      // PI / E 是数值字面量保留名（§13）
      if (name === 'PI') push({ type: 'num', value: Math.PI, line: startLine, col: startCol });
      else if (name === 'E') push({ type: 'num', value: Math.E, line: startLine, col: startCol });
      else push({ type: 'ident', value: name, line: startLine, col: startCol });
      continue;
    }

    // 两字符运算符
    if (c === '-' && src[i + 1] === '>') {
      const startLine = line, startCol = col;
      advance(); advance();
      push({ type: 'punct', value: '->', line: startLine, col: startCol });
      continue;
    }
    if ((c === '=' || c === '!' || c === '<' || c === '>') && src[i + 1] === '=') {
      const startLine = line, startCol = col;
      let op;
      if (c === '=') op = '==';
      else if (c === '!') op = '!=';
      else if (c === '<') op = '<=';
      else op = '>=';
      advance(); advance();
      push({ type: 'punct', value: op, line: startLine, col: startCol });
      continue;
    }
    if ((c === '&' && src[i + 1] === '&') || (c === '|' && src[i + 1] === '|')) {
      const startLine = line, startCol = col;
      const op = c === '&' ? '&&' : '||';
      advance(); advance();
      push({ type: 'punct', value: op, line: startLine, col: startCol });
      continue;
    }
    if ((c === '+' && src[i + 1] === '+') || (c === '-' && src[i + 1] === '-')) {
      const startLine = line, startCol = col;
      const op = c === '+' ? '++' : '--';
      advance(); advance();
      push({ type: 'punct', value: op, line: startLine, col: startCol });
      continue;
    }

    // 复合赋值运算符：+= -= *= /= %= ^=
    if ('+-*/%^'.includes(c) && src[i + 1] === '=') {
      const startLine = line, startCol = col;
      const op = c + '=';
      advance(); advance();
      push({ type: 'punct', value: op, line: startLine, col: startCol });
      continue;
    }

    // 单字符运算符 / 分隔符
    if ('+-*/%^!?:=<>()[]{},;.'.includes(c)) {
      const startLine = line, startCol = col;
      advance();
      push({ type: 'punct', value: c, line: startLine, col: startCol });
      continue;
    }

    throw parseError(`unexpected character '${c}'`, line, col);
  }

  push({ type: 'eof', value: '<eof>', line, col });
  return tokens;
}

// —— Parser（递归下降）——

function toLValue(expr, tok) {
  switch (expr.type) {
    case 'var':
      return { type: 'var', name: expr.name, line: expr.line, col: expr.col };
    case 'index':
      return { type: 'index', target: expr.target, index: expr.index, line: expr.line, col: expr.col };
    case 'comp':
      return { type: 'comp', target: expr.target, comp: expr.comp, line: expr.line, col: expr.col };
    case 'member':
      return { type: 'member', object: expr.object, field: expr.field, line: expr.line, col: expr.col };
    case 'array': {
      const names = [];
      for (const item of expr.items) {
        if (item.type !== 'var') {
          throw parseError('destructuring assignment names must be identifiers', item.line, item.col);
        }
        names.push(item.name);
      }
      return { type: 'unpack', names, line: expr.line, col: expr.col };
    }
    default:
      throw parseError('invalid assignment target', tok.line, tok.col);
  }
}

class Parser {
  constructor(source) {
    this.tokens = tokenize(source);
    this.pos = 0;
    this.phase = null;     // 'setup' | 'process' | 'func'（当前顶层区块）
    this.loopDepth = 0;
    this.allowBareExpr = 0; // >0：lambda 体内允许裸表达式语句
    this.lambdaDepth = 0;   // >0：lambda 体内允许 return
    this.nestDepth = 0;     // 当前表达式/语句嵌套深度
  }

  peek(offset = 0) {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  next() {
    const tok = this.tokens[this.pos];
    if (tok.type !== 'eof') this.pos++;
    return tok;
  }

  check(value) {
    const tok = this.peek();
    return tok.value === value;
  }

  match(value) {
    if (this.check(value)) { this.next(); return true; }
    return false;
  }

  matchKw(kw) {
    const tok = this.peek();
    if (tok.type === 'ident' && tok.value === kw) { this.next(); return true; }
    return false;
  }

  atEnd() { return this.peek().type === 'eof'; }

  // 当前待消费 token 之前是否有换行：行首运算符不续接上一行，语句在换行处结束。
  nlBefore() { return this.peek().nl === true; }

  // 语句结尾：`;`、换行、`}` 或 EOF 均可结束语句；`;` 用于同行写多条语句。
  statementEnd() {
    const tok = this.peek();
    if (tok.type === 'eof' || tok.value === ';' || tok.value === '}' || tok.nl) {
      if (tok.value === ';') this.next();
      return;
    }
    throw parseError(`expected ';' or newline after statement, got '${tok.value}'`, tok.line, tok.col);
  }

  errorAt(tok, msg) { throw parseError(msg, tok.line, tok.col); }

  expect(value, what) {
    const tok = this.peek();
    if (tok.value !== value) {
      throw parseError(`expected '${value}'${what ? ' ' + what : ''}, got '${tok.value}'`, tok.line, tok.col);
    }
    return this.next();
  }

  expectIdent() {
    const tok = this.peek();
    if (tok.type !== 'ident') {
      throw parseError(`expected identifier, got '${tok.value}'`, tok.line, tok.col);
    }
    return this.next();
  }

  expectKw(kw) {
    const tok = this.peek();
    if (tok.type !== 'ident' || tok.value !== kw) {
      throw parseError(`expected '${kw}', got '${tok.value}'`, tok.line, tok.col);
    }
    return this.next();
  }

  /* -- 顶层 -- */

  parseProgram() {
    const lifecycle = { setup: null, tick: null, process: null };
    const functions = new Map();
    const globals = [];

    while (!this.atEnd()) {
      const tok = this.peek();
      if (tok.type === 'ident' && (tok.value === 'let' || tok.value === 'const')) {
        globals.push(this.parseDeclare(tok, tok.value));
        continue;
      }

      this.expectKw('func');
      const nameTok = this.expectIdent();
      this.expect('(');
      const params = this.parseParamList();
      this.expect(')');
      this.phase = LIFECYCLE_FUNCS.has(nameTok.value) ? nameTok.value : 'func';
      const body = this.parseBlock();
      this.phase = null;

      const fn = {
        type: 'func', name: nameTok.value, params, body,
        line: nameTok.line, col: nameTok.col,
      };

      if (LIFECYCLE_FUNCS.has(fn.name)) {
        if (lifecycle[fn.name]) {
          this.errorAt(nameTok, `duplicate lifecycle function '${fn.name}'`);
        }
        this.validateLifecycleSignature(nameTok, fn);
        lifecycle[fn.name] = fn;
      } else {
        this.validateFuncName(nameTok);
        if (functions.has(fn.name)) {
          this.errorAt(nameTok, `duplicate function name '${fn.name}'`);
        }
        functions.set(fn.name, fn);
      }
    }

    return { setup: lifecycle.setup, tick: lifecycle.tick, process: lifecycle.process, functions, globals };
  }

  validateLifecycleSignature(tok, fn) {
    if (fn.name === 'setup' || fn.name === 'tick') {
      if (fn.params.length !== 0) {
        this.errorAt(tok, `'${fn.name}' must not take parameters`);
      }
    } else if (fn.name === 'process') {
      if (fn.params.length !== 0) {
        this.errorAt(tok, `'process' must not take parameters`);
      }
    }
  }

  validateFuncName(tok) {
    const name = tok.value;
    if (KEYWORDS.has(name) || name === CTX_NAME || CONSTANTS.has(name) || BUILTIN_FUNCTIONS.has(name)) {
      this.errorAt(tok, `reserved name cannot be used as function name: '${name}'`);
    }
  }

  parseParamList() {
    const params = [];
    if (!this.check(')')) {
      const tok = this.expectIdent();
      this.validateParamName(tok);
      params.push(tok.value);
      while (this.match(',')) {
        const t2 = this.expectIdent();
        this.validateParamName(t2);
        params.push(t2.value);
      }
    }
    return params;
  }

  validateParamName(tok) {
    const name = tok.value;
    if (KEYWORDS.has(name) || name === CTX_NAME || CONSTANTS.has(name)) {
      this.errorAt(tok, `reserved name cannot be used as parameter: '${name}'`);
    }
  }

  parseBlock() {
    const open = this.expect('{');
    const block = this.parseBlockBodyAfterOpen(open);
    this.expect('}');
    return block;
  }

  // 解析已消费 `{` 后的语句序列，不消费 `}`。
  parseBlockBodyAfterOpen(open) {
    const body = [];
    while (!this.check('}') && !this.atEnd()) body.push(this.parseStatement());
    return { type: 'block', body, line: open.line, col: open.col };
  }

  /* -- 语句 -- */

  parseStatement() {
    this.nestDepth++;
    if (this.nestDepth > MAX_PARSE_DEPTH) {
      this.nestDepth--;
      this.errorAt(this.peek(), 'expression nesting too deep');
    }
    try {
      const tok = this.peek();

      if (tok.type === 'punct' && tok.value === '{') return this.parseBlock();

      if (tok.type === 'ident') {
        switch (tok.value) {
          case 'if': return this.parseIf();
          case 'while': return this.parseWhile();
          case 'do': return this.parseDoWhile();
          case 'for': return this.parseFor();
          case 'break': return this.parseBreak(tok);
          case 'continue': return this.parseContinue(tok);
          case 'return': return this.parseReturn(tok);
          case 'let': return this.parseDeclare(tok, 'let');
          case 'const': return this.parseDeclare(tok, 'const');
          case 'when': return this.parseWhenStmt();
          default: break;
        }
      }

      return this.parseAssignOrExprStatement();
    } finally {
      this.nestDepth--;
    }
  }

  parseIf() {
    const start = this.next(); // 'if'
    this.expect('(');
    const cond = this.parseTernary();
    this.expect(')');
    const then = this.parseStatement();
    let els = null;
    if (this.matchKw('else')) els = this.parseStatement();
    return { type: 'if', cond, then, els, line: start.line, col: start.col };
  }

  parseWhile() {
    const start = this.next();
    this.expect('(');
    const cond = this.parseTernary();
    this.expect(')');
    this.loopDepth++;
    const body = this.parseStatement();
    this.loopDepth--;
    return { type: 'while', cond, body, line: start.line, col: start.col };
  }

  parseDoWhile() {
    const start = this.next();
    this.loopDepth++;
    const body = this.parseStatement();
    this.loopDepth--;
    this.expectKw('while');
    this.expect('(');
    const cond = this.parseTernary();
    this.expect(')');
    this.statementEnd();
    return { type: 'do', body, cond, line: start.line, col: start.col };
  }

  parseFor() {
    const start = this.next();
    this.expect('(');

    // for-of：for (const x of expr) / for (let x of expr) / for (x of expr)
    const saved = this.pos;
    let ofKind = null;
    const looksLikeOf = () => this.peek().type === 'ident' && this.peek(1).type === 'ident' && this.peek(1).value === 'of';
    if (this.matchKw('const')) {
      ofKind = looksLikeOf() ? 'const' : null;
      if (ofKind == null) this.pos = saved;
    } else if (this.matchKw('let')) {
      ofKind = looksLikeOf() ? 'let' : null;
      if (ofKind == null) this.pos = saved;
    } else if (looksLikeOf()) {
      ofKind = 'let';
    }
    if (ofKind !== null) {
      const nameTok = this.expectIdent();
      this.validateForVarName(nameTok);
      this.expectKw('of');
      const iter = this.parseTernary();
      this.expect(')');
      this.loopDepth++;
      const body = this.parseStatement();
      this.loopDepth--;
      return { type: 'forof', name: nameTok.value, kind: ofKind, iter, body, line: start.line, col: start.col };
    }
    this.pos = saved;

    let init = null;
    if (!this.check(';')) {
      if (this.check('let')) init = this.parseDeclare(this.peek(), 'let', true);
      else init = this.parseAssignExpr();
    }
    this.expect(';');
    let cond = null;
    if (!this.check(';')) cond = this.parseTernary();
    this.expect(';');
    let inc = null;
    if (!this.check(')')) inc = this.parseAssignExpr();
    this.expect(')');
    this.loopDepth++;
    const body = this.parseStatement();
    this.loopDepth--;
    return { type: 'for', init, cond, inc, body, line: start.line, col: start.col };
  }

  validateForVarName(tok) {
    if (KEYWORDS.has(tok.value) || tok.value === CTX_NAME || CONSTANTS.has(tok.value)) {
      this.errorAt(tok, `reserved name cannot be used as loop variable: '${tok.value}'`);
    }
  }

  parseBreak(tok) {
    if (this.loopDepth === 0) this.errorAt(tok, "'break' outside loop");
    this.next();
    this.statementEnd();
    return { type: 'break', line: tok.line, col: tok.col };
  }

  parseContinue(tok) {
    if (this.loopDepth === 0) this.errorAt(tok, "'continue' outside loop");
    this.next();
    this.statementEnd();
    return { type: 'continue', line: tok.line, col: tok.col };
  }

  parseReturn(tok) {
    if (!this.phase && this.lambdaDepth === 0) this.errorAt(tok, "'return' only allowed inside a function");
    this.next();
    let expr = null;
    if (!this.check(';') && !this.atEnd() && !this.nlBefore()) expr = this.parseTernary();
    this.statementEnd();
    return { type: 'return', expr, line: tok.line, col: tok.col };
  }

  parseDeclare(tok, kind, noStatementEnd) {
    this.next(); // let / const
    if (this.check('{')) {
      const node = this.parseDestructure(tok, kind);
      if (!noStatementEnd) this.statementEnd();
      return node;
    }
    const decls = [];
    for (;;) {
      const nameTok = this.expectIdent();
      this.validateDeclName(nameTok);
      let init = null;
      if (!this.nlBefore() && this.match('=')) init = this.parseTernary();
      else if (kind === 'const') this.errorAt(nameTok, "'const' must have an initializer");
      decls.push({ name: nameTok.value, init, line: nameTok.line, col: nameTok.col });
      if (this.check(',') && !this.nlBefore()) { this.next(); continue; }
      break;
    }
    if (!noStatementEnd) this.statementEnd();
    return { type: 'declare', kind, decls, line: tok.line, col: tok.col };
  }

  // let { a, b } = expr（同名取键，不支持重命名/默认值/嵌套）。
  parseDestructure(tok, kind) {
    this.expect('{');
    const names = [];
    if (!this.check('}')) {
      const n0 = this.expectIdent();
      this.validateDeclName(n0);
      names.push(n0.value);
      while (this.match(',')) {
        if (this.check('}')) break;
        const nt = this.expectIdent();
        this.validateDeclName(nt);
        names.push(nt.value);
      }
    }
    this.expect('}');
    if (!this.match('=')) {
      const t = this.peek();
      throw parseError('object destructuring requires an initializer', t.line, t.col);
    }
    const value = this.parseTernary();
    return { type: 'destructure', kind, names, value, line: tok.line, col: tok.col };
  }

  validateDeclName(tok) {
    const name = tok.value;
    if (KEYWORDS.has(name) || name === CTX_NAME || CONSTANTS.has(name)) {
      this.errorAt(tok, `reserved name cannot be declared: '${name}'`);
    }
  }

  parseAssignOrExprStatement() {
    const start = this.peek();
    const expr = this.parseAssignExpr();
    if (expr.type === 'assign') {
      this.statementEnd();
      return expr;
    }
    this.statementEnd();
    const allowed = expr.type === 'call' || expr.type === 'method' || expr.type === 'preinc' ||
      expr.type === 'postinc' || expr.type === 'apply';
    if (!allowed && this.allowBareExpr === 0) {
      this.errorAt(start, 'expression statement must be a function call');
    }
    return { type: 'expr', expr, line: start.line, col: start.col };
  }

  // 语句层赋值：= 右结合，且只在此处出现（§5 优先级 1）。
  // 复合赋值 a += b 等价于 a = a + b（左侧表达式作为读取值参与二元运算）。
  parseAssignExpr() {
    const start = this.peek();
    const left = this.parseTernary();
    if (!this.nlBefore()) {
      const opTok = this.peek();
      const binOp = COMPOUND_ASSIGN[opTok.value];
      if (binOp) {
        this.next();
        const target = toLValue(left, start);
        const value = this.parseTernary();
        return {
          type: 'assign', target,
          value: { type: 'binary', op: binOp, left, right: value, line: opTok.line, col: opTok.col },
          line: start.line, col: start.col,
        };
      }
      if (opTok.value === '=') {
        this.next();
        const target = toLValue(left, start);
        const value = this.parseAssignExpr();
        return { type: 'assign', target, value, line: start.line, col: start.col };
      }
    }
    return left;
  }

  /* -- 表达式 -- */

  parseTernary() {
    this.nestDepth++;
    if (this.nestDepth > MAX_PARSE_DEPTH) {
      this.nestDepth--;
      this.errorAt(this.peek(), 'expression nesting too deep');
    }
    try {
      const cond = this.parseOr();
      if (this.match('?')) {
        const qTok = this.tokens[this.pos - 1];
        const thenExpr = this.parseTernary();
        this.expect(':');
        const elseExpr = this.parseTernary();
        return { type: 'ternary', cond, thenExpr, elseExpr, line: qTok.line, col: qTok.col };
      }
      return cond;
    } finally {
      this.nestDepth--;
    }
  }

  parseOr() {
    let left = this.parseAnd();
    while (!this.nlBefore() && this.match('||')) {
      const opTok = this.tokens[this.pos - 1];
      const right = this.parseAnd();
      left = { type: 'binary', op: '||', left, right, line: opTok.line, col: opTok.col };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseEquality();
    while (!this.nlBefore() && this.match('&&')) {
      const opTok = this.tokens[this.pos - 1];
      const right = this.parseEquality();
      left = { type: 'binary', op: '&&', left, right, line: opTok.line, col: opTok.col };
    }
    return left;
  }

  parseEquality() {
    let left = this.parseComparison();
    while (!this.nlBefore() && (this.check('==') || this.check('!='))) {
      const opTok = this.next();
      const right = this.parseComparison();
      left = { type: 'binary', op: opTok.value, left, right, line: opTok.line, col: opTok.col };
    }
    return left;
  }

  parseComparison() {
    let left = this.parseAdditive();
    while (!this.nlBefore() && (this.check('<') || this.check('<=') || this.check('>') || this.check('>='))) {
      const opTok = this.next();
      const right = this.parseAdditive();
      left = { type: 'binary', op: opTok.value, left, right, line: opTok.line, col: opTok.col };
    }
    return left;
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (!this.nlBefore() && (this.check('+') || this.check('-'))) {
      const opTok = this.next();
      const right = this.parseMultiplicative();
      left = { type: 'binary', op: opTok.value, left, right, line: opTok.line, col: opTok.col };
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parsePower();
    while (!this.nlBefore() && (this.check('*') || this.check('/') || this.check('%'))) {
      const opTok = this.next();
      const right = this.parsePower();
      left = { type: 'binary', op: opTok.value, left, right, line: opTok.line, col: opTok.col };
    }
    return left;
  }

  // 幂：优先级高于一元（§5），右结合。
  parsePower() {
    let left = this.parseUnary();
    while (!this.nlBefore() && this.match('^')) {
      const opTok = this.tokens[this.pos - 1];
      const right = this.parsePower();
      left = { type: 'binary', op: '^', left, right, line: opTok.line, col: opTok.col };
    }
    return left;
  }

  parseUnary() {
    if (this.check('-') || this.check('!')) {
      const opTok = this.next();
      const operand = this.parseUnary();
      return { type: 'unary', op: opTok.value, operand, line: opTok.line, col: opTok.col };
    }
    if (this.check('++') || this.check('--')) {
      const opTok = this.next();
      const target = this.parseUnary();
      toLValue(target, opTok); // 校验为可赋值目标
      return { type: 'preinc', op: opTok.value, target, line: opTok.line, col: opTok.col };
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    let expr = this.parsePrimary();
    while (true) {
      if (!this.nlBefore() && this.match('(')) {
        const args = this.parseArgs();
        expr = { type: 'call', callee: expr, args, line: expr.line, col: expr.col };
        // 尾随 lambda：f(args) { λ } ≡ f(args, λ)
        if (!this.nlBefore() && this.check('{')) {
          const open = this.next();
          expr.args.push(this.parseLambdaAfterOpen(open));
        }
      } else if (!this.nlBefore() && this.match('[')) {
        const idx = this.parseTernary();
        this.expect(']');
        expr = { type: 'index', target: expr, index: idx, line: expr.line, col: expr.col };
      } else if (this.match('.')) {
        const nameTok = this.expectIdent();
        if (this.match('(')) {
          const args = this.parseArgs();
          expr = { type: 'method', object: expr, method: nameTok.value, args, line: expr.line, col: expr.col };
          if (!this.nlBefore() && this.check('{')) {
            const open = this.next();
            expr.args.push(this.parseLambdaAfterOpen(open));
          }
        } else if (nameTok.value === 'apply' && !this.nlBefore() && this.check('{')) {
          const open = this.next();
          const body = this.parseLambdaAfterOpen(open);
          expr = { type: 'apply', target: expr, body, line: nameTok.line, col: nameTok.col };
        } else if (COMP_NAMES.has(nameTok.value)) {
          expr = { type: 'comp', target: expr, comp: nameTok.value, line: expr.line, col: expr.col };
        } else {
          expr = { type: 'member', object: expr, field: nameTok.value, line: nameTok.line, col: nameTok.col };
        }
      } else if (!this.nlBefore() && (this.check('++') || this.check('--'))) {
        const opTok = this.next();
        toLValue(expr, opTok); // 校验为可赋值目标
        expr = { type: 'postinc', op: opTok.value, target: expr, line: opTok.line, col: opTok.col };
      } else {
        break;
      }
    }
    return expr;
  }

  parseArgs() {
    const args = [];
    if (!this.check(')')) {
      args.push(this.parseTernary());
      while (this.match(',')) args.push(this.parseTernary());
    }
    this.expect(')');
    return args;
  }

  parsePrimary() {
    const tok = this.peek();

    if (tok.type === 'num') { this.next(); return { type: 'num', value: tok.value, line: tok.line, col: tok.col }; }
    if (tok.type === 'str') { this.next(); return { type: 'str', value: tok.value, line: tok.line, col: tok.col }; }

    if (tok.type === 'ident') {
      this.next();
      if (tok.value === 'true' || tok.value === 'false') {
        return { type: 'bool', value: tok.value === 'true', line: tok.line, col: tok.col };
      }
      if (tok.value === 'undefined') {
        return { type: 'undefined', line: tok.line, col: tok.col };
      }
      if (tok.value === 'when') {
        return this.parseWhenExpr(tok);
      }
      return { type: 'var', name: tok.value, line: tok.line, col: tok.col };
    }

    if (tok.type === 'punct' && tok.value === '(') {
      this.next();
      const expr = this.parseTernary();
      this.expect(')');
      return expr;
    }

    if (tok.type === 'punct' && tok.value === '[') {
      this.next();
      const items = [];
      if (!this.check(']')) {
        items.push(this.parseTernary());
        while (this.match(',')) items.push(this.parseTernary());
      }
      this.expect(']');
      return { type: 'array', items, line: tok.line, col: tok.col };
    }

    if (tok.type === 'punct' && tok.value === '{') {
      this.next();
      return this.parseBraceExpr(tok);
    }

    this.errorAt(tok, `unexpected token '${tok.value}'`);
  }

  // 表达式位置的 `{`：按首 token 消歧为 lambda 或对象字面量。
  parseBraceExpr(openTok) {
    const tok = this.peek();
    if (tok.type === 'punct' && tok.value === '}') return this.parseLambdaAfterOpen(openTok);
    if (tok.type === 'ident') {
      const next = this.peek(1);
      if (next.value === ':') return this.parseObjAfterOpen(openTok);
      return this.parseLambdaAfterOpen(openTok);
    }
    if (tok.type === 'str' && this.peek(1).value === ':') return this.parseObjAfterOpen(openTok);
    return this.parseLambdaAfterOpen(openTok);
  }

  // lambda 字面量：{ [ident (, ident)* ->] body }。`{` 已消费。
  parseLambdaAfterOpen(openTok) {
    const params = [];
    const t0 = this.peek();
    if (t0.type === 'ident' && (this.peek(1).value === '->' || this.peek(1).value === ',')) {
      for (;;) {
        const pt = this.expectIdent();
        this.validateParamName(pt);
        params.push(pt.value);
        if (this.match(',')) continue;
        break;
      }
      this.expect('->');
    }
    this.allowBareExpr++;
    this.lambdaDepth++;
    let body;
    try {
      body = this.parseBlockBodyAfterOpen(openTok);
    } finally {
      this.lambdaDepth--;
      this.allowBareExpr--;
    }
    this.expect('}');
    return { type: 'lambda', params, body, line: openTok.line, col: openTok.col };
  }

  // 对象字面量：{ key: value, ... }。`{` 已消费。
  parseObjAfterOpen(openTok) {
    const fields = new Map();
    if (this.check('}')) {
      this.next();
      return { type: 'obj', fields, line: openTok.line, col: openTok.col };
    }
    for (;;) {
      const keyTok = this.peek();
      let key;
      if (keyTok.type === 'ident') { this.next(); key = keyTok.value; }
      else if (keyTok.type === 'str') { this.next(); key = keyTok.value; }
      else this.errorAt(keyTok, 'object key must be an identifier or string');
      this.expect(':');
      const val = this.parseTernary();
      fields.set(key, val);
      if (this.match(',')) {
        if (this.check('}')) { this.next(); break; }
        continue;
      }
      break;
    }
    this.expect('}');
    return { type: 'obj', fields, line: openTok.line, col: openTok.col };
  }

  parseWhenStmt() {
    const start = this.next(); // 'when'
    return this.parseWhenBody(start, true);
  }

  parseWhenExpr(whenTok) {
    return this.parseWhenBody(whenTok, false);
  }

  parseWhenBody(start, isStmt) {
    this.expect('(');
    const subject = this.parseTernary();
    this.expect(')');
    this.expect('{');
    const cases = [];
    let els = null;
    while (true) {
      if (this.check('}')) break;
      if (this.matchKw('else')) {
        this.expect('->');
        els = isStmt ? this.parseStatement() : this.parseTernary();
        break;
      }
      const label = this.parseTernary();
      this.expect('->');
      const body = isStmt ? this.parseStatement() : this.parseTernary();
      if (isStmt) {
        cases.push({ label, body });
        // 简单语句体已由 statementEnd 消费 ';'；块体后可能还有 ';'，这里兜底跳过。
        this.match(';');
        continue;
      }
      cases.push({ label, expr: body });
      if (this.match(';')) continue;
      if (this.check('}')) continue;
      if (this.peek().type === 'ident' && this.peek().value === 'else') continue;
      if (!this.nlBefore()) {
        this.errorAt(this.peek(), `expected ';', newline or '}' in when`);
      }
    }
    this.expect('}');
    if (!isStmt && els === null) {
      throw parseError('when expression requires an else branch', start.line, start.col);
    }
    return { type: isStmt ? 'whenstmt' : 'whenexpr', subject, cases, els, line: start.line, col: start.col };
  }
}

export function parseProgram(source) {
  return new Parser(source).parseProgram();
}
export function parseExpression(source) {
  const p = new Parser(source);
  const node = p.parseTernary();
  const extra = p.peek();
  if (extra.type !== 'eof') {
    throw parseError(`unexpected '${extra.value}' after expression`, extra.line, extra.col);
  }
  return node;
}
