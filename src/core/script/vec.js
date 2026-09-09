// 向量纯函数与 vec 实例方法实现。无 Runtime 依赖，供 script-lang.js 的 Runtime 与 BUILTIN_TABLE 复用。
// 错误一律抛英文 Error，由调用方补行列号。

export const vec2 = (x, y) => ({ t: 'vec2', x, y });
export const vec3 = (x, y, z) => ({ t: 'vec3', x, y, z });
export const vec4 = (x, y, z, w) => ({ t: 'vec4', x, y, z, w });
export const mat3 = (m) => ({ t: 'mat3', m });
export const mat4 = (m) => ({ t: 'mat4', m });

export const isVec = (v) => v != null && (v.t === 'vec2' || v.t === 'vec3' || v.t === 'vec4');
export const isMat = (v) => v != null && (v.t === 'mat3' || v.t === 'mat4');

export const vecDim = (v) => (v.t === 'vec2' ? 2 : v.t === 'vec3' ? 3 : 4);

export const vecComps = (v) => {
  if (v.t === 'vec2') return [v.x, v.y];
  if (v.t === 'vec3') return [v.x, v.y, v.z];
  return [v.x, v.y, v.z, v.w];
};

export const mkVec = (dim, comps) => {
  if (dim === 2) return vec2(comps[0], comps[1]);
  if (dim === 3) return vec3(comps[0], comps[1], comps[2]);
  return vec4(comps[0], comps[1], comps[2], comps[3]);
};

const isNum = (v) => typeof v === 'number';

function expectNum(v, name) {
  if (!isNum(v)) throw new Error(`${name} requires a num`);
  return v;
}
function expectVec(v, name) {
  if (!isVec(v)) throw new Error(`${name} requires a vec`);
  return v;
}
function expectVec3(v, name) {
  expectVec(v, name);
  if (vecDim(v) !== 3) throw new Error(`${name} requires a vec3`);
  return v;
}
function sameDim(a, b) {
  if (vecDim(a) !== vecDim(b)) throw new Error('vector dimension mismatch');
}
function checkArity(args, n, name) {
  if (args.length !== n) throw new Error(`${name} expects ${n} argument(s), got ${args.length}`);
}

function dotSelf(v) {
  const c = vecComps(v);
  let s = 0;
  for (const x of c) s += x * x;
  return s;
}
function dotComps(a, b) {
  const ca = vecComps(a), cb = vecComps(b);
  let s = 0;
  for (let i = 0; i < ca.length; i++) s += ca[i] * cb[i];
  return s;
}
function normOrZero(v) {
  const l = Math.sqrt(dotSelf(v));
  if (l === 0) return mkVec(vecDim(v), vecComps(v).map(() => 0));
  return mkVec(vecDim(v), vecComps(v).map((x) => x / l));
}

// —— vec3→vec3 变换（角度一律弧度） ——

export function rotateXVec3(v, a) {
  expectVec3(v, 'rotateX');
  expectNum(a, 'rotateX angle');
  const c = Math.cos(a), s = Math.sin(a);
  return vec3(v.x, c * v.y - s * v.z, s * v.y + c * v.z);
}

export function rotateYVec3(v, a) {
  expectVec3(v, 'rotateY');
  expectNum(a, 'rotateY angle');
  const c = Math.cos(a), s = Math.sin(a);
  return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z);
}

export function rotateZVec3(v, a) {
  expectVec3(v, 'rotateZ');
  expectNum(a, 'rotateZ angle');
  const c = Math.cos(a), s = Math.sin(a);
  return vec3(c * v.x - s * v.y, s * v.x + c * v.y, v.z);
}

export function translateVec3(v, dx, dy, dz) {
  expectVec3(v, 'translate');
  expectNum(dx, 'translate dx');
  expectNum(dy, 'translate dy');
  expectNum(dz, 'translate dz');
  return vec3(v.x + dx, v.y + dy, v.z + dz);
}

export function scaleVec3(v, s) {
  expectVec3(v, 'scale');
  if (isNum(s)) return vec3(v.x * s, v.y * s, v.z * s);
  if (isVec(s)) {
    if (vecDim(s) !== 3) throw new Error('scale requires a scalar or vec3');
    return vec3(v.x * s.x, v.y * s.y, v.z * s.z);
  }
  throw new Error('scale requires a scalar or vec3');
}

function scaleVec(v, s) {
  const dim = vecDim(v);
  if (isNum(s)) return mkVec(dim, vecComps(v).map((x) => x * s));
  if (isVec(s)) {
    if (vecDim(s) !== dim) throw new Error('scale requires a scalar or same-dimension vec');
    const cs = vecComps(s);
    return mkVec(dim, vecComps(v).map((x, i) => x * cs[i]));
  }
  throw new Error('scale requires a scalar or vec');
}

// —— vec 实例方法（全部返回新值，不改原值） ——

export const VEC_METHODS = {
  normalize(v, args) {
    expectVec(v, 'normalize');
    checkArity(args, 0, 'normalize');
    const l = Math.sqrt(dotSelf(v));
    if (l === 0) throw new Error('cannot normalize a zero-length vector');
    return mkVec(vecDim(v), vecComps(v).map((x) => x / l));
  },

  dot(v, args) {
    expectVec(v, 'dot');
    checkArity(args, 1, 'dot');
    const w = expectVec(args[0], 'dot');
    sameDim(v, w);
    return dotComps(v, w);
  },

  cross(v, args) {
    expectVec(v, 'cross');
    checkArity(args, 1, 'cross');
    const w = expectVec(args[0], 'cross');
    if (vecDim(v) !== 3 || vecDim(w) !== 3) throw new Error('cross requires vec3 operands');
    return vec3(v.y * w.z - v.z * w.y, v.z * w.x - v.x * w.z, v.x * w.y - v.y * w.x);
  },

  len(v, args) {
    expectVec(v, 'len');
    checkArity(args, 0, 'len');
    return Math.sqrt(dotSelf(v));
  },

  len2(v, args) {
    expectVec(v, 'len2');
    checkArity(args, 0, 'len2');
    return dotSelf(v);
  },

  dist(v, args) {
    expectVec(v, 'dist');
    checkArity(args, 1, 'dist');
    const w = expectVec(args[0], 'dist');
    sameDim(v, w);
    const ca = vecComps(v), cb = vecComps(w);
    let s = 0;
    for (let i = 0; i < ca.length; i++) s += (ca[i] - cb[i]) ** 2;
    return Math.sqrt(s);
  },

  angleTo(v, args) {
    expectVec(v, 'angleTo');
    checkArity(args, 1, 'angleTo');
    const w = expectVec(args[0], 'angleTo');
    sameDim(v, w);
    const d = dotComps(normOrZero(v), normOrZero(w));
    return Math.acos(Math.max(-1, Math.min(1, d)));
  },

  project(v, args) {
    expectVec(v, 'project');
    checkArity(args, 1, 'project');
    const w = expectVec(args[0], 'project');
    sameDim(v, w);
    const bb = dotSelf(w);
    if (bb === 0) throw new Error('project onto zero-length vector');
    const s = dotComps(v, w) / bb;
    return mkVec(vecDim(w), vecComps(w).map((x) => x * s));
  },

  reflect(v, args) {
    expectVec(v, 'reflect');
    checkArity(args, 1, 'reflect');
    const n = expectVec(args[0], 'reflect');
    sameDim(v, n);
    const d = dotComps(v, n);
    const cn = vecComps(n).map((x) => 2 * d * x);
    const cv = vecComps(v);
    return mkVec(vecDim(v), cv.map((x, i) => x - cn[i]));
  },

  lerp(v, args) {
    expectVec(v, 'lerp');
    checkArity(args, 2, 'lerp');
    const w = expectVec(args[0], 'lerp');
    const t = expectNum(args[1], 'lerp t');
    sameDim(v, w);
    const ca = vecComps(v), cb = vecComps(w);
    return mkVec(vecDim(v), ca.map((x, i) => x + (cb[i] - x) * t));
  },

  rotateX(v, args) {
    expectVec3(v, 'rotateX');
    checkArity(args, 1, 'rotateX');
    return rotateXVec3(v, expectNum(args[0], 'rotateX angle'));
  },

  rotateY(v, args) {
    expectVec3(v, 'rotateY');
    checkArity(args, 1, 'rotateY');
    return rotateYVec3(v, expectNum(args[0], 'rotateY angle'));
  },

  rotateZ(v, args) {
    expectVec3(v, 'rotateZ');
    checkArity(args, 1, 'rotateZ');
    return rotateZVec3(v, expectNum(args[0], 'rotateZ angle'));
  },

  translate(v, args) {
    expectVec(v, 'translate');
    const dim = vecDim(v);
    if (args.length !== dim) throw new Error(`translate expects ${dim} argument(s), got ${args.length}`);
    const c = args.map((x, i) => expectNum(x, `translate[${i}]`));
    return mkVec(dim, vecComps(v).map((x, i) => x + c[i]));
  },

  scale(v, args) {
    expectVec(v, 'scale');
    checkArity(args, 1, 'scale');
    return scaleVec(v, args[0]);
  },
};