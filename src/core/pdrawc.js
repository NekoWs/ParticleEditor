/* =========================================================================
 * .pdrawc 二进制播放格式：编码 / 解码 / 签名 / 验签（纯逻辑，无 DOM）
 * 规范见 docs/pdrawc-format.md。
 * v2：body 使用 raw DEFLATE 极限压缩（签名覆盖压缩后的完整字节）。
 * ======================================================================= */

import { base64ToBytes, bytesToBase64, signData, verifyData } from './crypto.js';
import { EASING_NONE } from './easing-constants.js';

export const PDRAWC_MAGIC = new Uint8Array([0x50, 0x44, 0x43, 0x31]); // "PDC1"
export const PDRAWC_VERSION = 6;
export const PDRAWC_SIG_LEN = 64;
export const PDRAWC_PUB_LEN = 32;

// pr → 枚举（与模组解码约定一致）
export const PR_ENUM = {
  'pos.x': 0, 'pos.y': 1, 'pos.z': 2,
  'vel.x': 3, 'vel.y': 4, 'vel.z': 5,
  'col.r': 6, 'col.g': 7, 'col.b': 8, 'col.a': 9,
  'scl.x': 10, 'scl.y': 11, 'scl.z': 12,
  'rot.x': 13, 'rot.y': 14, 'rot.z': 15,
  'spin.x': 16, 'spin.y': 17, 'spin.z': 18,
  'center.x': 19, 'center.y': 20, 'center.z': 21,
  'fov': 22,
};
export const PR_BY_ENUM = Object.fromEntries(Object.entries(PR_ENUM).map(([k, v]) => [v, k]));

const UV_MODE = { static: 0, fill: 1, animated: 2 };
const UV_MODE_BY = ['static', 'fill', 'animated'];

/* ============================ raw DEFLATE ============================ */

async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') throw new Error('CompressionStream unavailable');
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream unavailable');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ============================ 字节写入 / 读取 ============================ */

class ByteWriter {
  constructor() { this.parts = []; this.len = 0; }
  u8(v) { this.parts.push(new Uint8Array([v & 0xff])); this.len += 1; }
  bytes(u8) { this.parts.push(u8); this.len += u8.length; }
  f32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    this.bytes(b);
  }
  varint(n) {
    n = Math.max(0, Math.floor(n));
    while (n >= 0x80) {
      this.u8((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    this.u8(n);
  }
  str(s) {
    const b = new TextEncoder().encode(s == null ? '' : String(s));
    this.varint(b.length);
    this.bytes(b);
  }
  toUint8Array() {
    const out = new Uint8Array(this.len);
    let off = 0;
    for (const p of this.parts) { out.set(p, off); off += p.length; }
    return out;
  }
}

class ByteReader {
  constructor(bytes) { this.b = bytes; this.pos = 0; }
  get remaining() { return this.b.length - this.pos; }
  u8() {
    if (this.remaining < 1) throw new Error('pdrawc: truncated byte');
    return this.b[this.pos++];
  }
  bytes(n) {
    if (n < 0 || this.remaining < n) throw new Error('pdrawc: truncated bytes');
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  f32() {
    const b = this.bytes(4);
    return new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, true);
  }
  varint() {
    let result = 0;
    let shift = 0;
    while (true) {
      const b = this.u8();
      result += (b & 0x7f) * (2 ** shift);
      if ((b & 0x80) === 0) return result;
      shift += 7;
      if (shift > 63) throw new Error('pdrawc: varint overflow');
    }
  }
  str() {
    const n = this.varint();
    const b = this.bytes(n);
    return new TextDecoder().decode(b);
  }
}

/* ============================ 子结构编码 ============================ */

function writeUV(w, uv, texIndex) {
  w.varint(texIndex);
  w.u8(UV_MODE[uv.mode] != null ? UV_MODE[uv.mode] : 0);
  const texSize = (uv.texSize || [16, 16]).slice(0, 2);
  const uvStart = (uv.uvStart || [0, 0]).slice(0, 2);
  const uvSize = (uv.uvSize || [0, 0]).slice(0, 2);
  const uvStep = (uv.uvStep || [0, 0]).slice(0, 2);
  w.varint(texSize[0] | 0); w.varint(texSize[1] | 0);
  w.varint(uvStart[0] | 0); w.varint(uvStart[1] | 0);
  w.varint(uvSize[0] | 0); w.varint(uvSize[1] | 0);
  w.varint(uvStep[0] | 0); w.varint(uvStep[1] | 0);
  w.f32(uv.fps != null ? uv.fps : 1);
  w.varint(uv.maxFrame != null ? uv.maxFrame : 1);
  w.u8(uv.loop != null && uv.loop === false ? 0 : 1);
}

function writeEnt(w, ent) {
  w.str(ent.p);
  w.varint(ent.d != null ? ent.d : 5);
}

function writeEasing(w, e) {
  if (e === EASING_NONE) {
    w.u8(2); // 无缓动（阶跃）
  } else if (Number.isInteger(e)) {
    w.u8(0);
    w.varint(Math.max(0, Math.min(13, e)));
  } else if (Array.isArray(e)) {
    w.u8(1);
    for (let i = 0; i < 4; i++) w.f32(Number(e[i]) || 0);
  } else {
    w.u8(0);
    w.varint(3); // EASE_IN_OUT
  }
}

function writeKf(w, kf) {
  w.varint(kf.length);
  for (const k of kf) {
    w.varint(Math.round(k[0]));
    w.f32(k[1]);
    writeEasing(w, k[2]);
  }
}

function writeRef(w, kind, index) {
  w.u8(kind);
  w.varint(index);
}

/* ============================ body 编码 ============================ */

function encodeBody(state, texPngOf) {
  const w = new ByteWriter();
  w.u8(state.loop ? 1 : 0);

  // 贴图表：保留全部贴图名（缺 PNG 时写空），UV 索引稳定。
  const texNames = Object.keys(state.textures);
  w.varint(texNames.length);
  for (const name of texNames) {
    w.str(name);
    const png = texPngOf ? texPngOf(name) : null;
    if (png && png.length) { w.varint(png.length); w.bytes(png); }
    else w.varint(0);
  }
  const texIndex = new Map(texNames.map((n, i) => [n, i]));

  // 独立粒子（不含派生粒子）；id → 索引
  const particles = state.particles.filter(p => !p.fx);
  const particleIndex = new Map(particles.map((p, i) => [p.id, i]));
  w.varint(particles.length);
  for (const p of particles) {
    const c = p.color || [1, 1, 1, 1];
    w.u8(Math.round(c[0] * 255)); w.u8(Math.round(c[1] * 255));
    w.u8(Math.round(c[2] * 255)); w.u8(Math.round(c[3] * 255));
    const s = p.scale || [1, 1, 1];
    w.f32(s[0]); w.f32(s[1]); w.f32(s[2]);
    const hasUV = !!(p.uv && p.uv.texture && texIndex.has(p.uv.texture));
    const hasEnt = !!(p.ent && p.ent.p);
    const hasLife = (p.life != null && p.life >= 0);
    let flags = 0;
    if (p.glow) flags |= 1;
    if (hasUV) flags |= 2;
    if (hasEnt) flags |= 4;
    if (hasLife) flags |= 8;
    w.u8(flags);
    w.u8(p.lightLevel || 0);
    w.f32(p.pos[0]); w.f32(p.pos[1]); w.f32(p.pos[2]);
    const v = p.vel || [0, 0, 0];
    w.f32(v[0]); w.f32(v[1]); w.f32(v[2]);
    w.varint(p.st || 0);
    if (hasLife) w.varint(p.life);
    if (hasEnt) writeEnt(w, p.ent);
    if (hasUV) writeUV(w, p.uv, texIndex.get(p.uv.texture));
  }

  // 组：只保留含非派生成员的组；成员用粒子索引。
  const groupNames = [];
  for (const [name, members] of Object.entries(state.groups)) {
    const idxs = [];
    for (const id of members) {
      if (particleIndex.has(id)) idxs.push(particleIndex.get(id));
    }
    if (idxs.length) groupNames.push([name, idxs]);
  }
  const groupIndex = new Map(groupNames.map(([n], i) => [n, i]));
  w.varint(groupNames.length);
  for (const [name, idxs] of groupNames) {
    // v5：组级自转/公转空间 flags：bit0=spinLocal, bit1=rotLocal
    const spinLocal = (state.groupSpinSpace && state.groupSpinSpace[name] === 'local') ? 1 : 0;
    const rotLocal = (state.groupRotSpace && state.groupRotSpace[name] === 'local') ? 2 : 0;
    w.u8(spinLocal | rotLocal);
    w.varint(idxs.length);
    for (const idx of idxs) w.varint(idx);
  }

  // 组级 UV
  const groupUVEntries = [];
  for (const [name, uv] of Object.entries(state.groupUV || {})) {
    if (uv && uv.texture && groupIndex.has(name) && texIndex.has(uv.texture)) {
      groupUVEntries.push([groupIndex.get(name), uv, texIndex.get(uv.texture)]);
    }
  }
  w.varint(groupUVEntries.length);
  for (const [gidx, uv, tidx] of groupUVEntries) {
    w.varint(gidx);
    writeUV(w, uv, tidx);
  }

  // 函数对象
  const functions = state.functions;
  const functionIndex = new Map(functions.map((f, i) => [f.id, i]));
  w.varint(functions.length);
  for (const fx of functions) {
    const center = fx.center || [0, 0, 0];
    w.f32(center[0]); w.f32(center[1]); w.f32(center[2]);
    w.varint(fx.count || 0);
    w.str(fx.setup || '');
    w.str(fx.process || '');
    w.varint(Number.isInteger(fx.seed) ? fx.seed : 0);
    w.varint(fx.duration || 0);
    w.varint(fx.st || 0);
    const hasEnt = !!(fx.ent && fx.ent.p);
    const hasUV = !!(fx.uv && fx.uv.texture && texIndex.has(fx.uv.texture));
    const fastMath = !!fx.fastMath;
    const hasFuncs = !!(fx.funcs && String(fx.funcs).trim());
    const spinLocal = fx.spinSpace === 'local';
    const rotLocal = fx.rotSpace === 'local';
    w.u8((hasEnt ? 1 : 0) | (hasUV ? 2 : 0) | (fastMath ? 4 : 0) | (hasFuncs ? 8 : 0) | (spinLocal ? 16 : 0) | (rotLocal ? 32 : 0));
    if (hasEnt) writeEnt(w, fx.ent);
    if (hasUV) writeUV(w, fx.uv, texIndex.get(fx.uv.texture));
    if (hasFuncs) w.str(fx.funcs);
    const vars = Object.entries(fx.vars || {});
    w.varint(vars.length);
    for (const [name, v] of vars) {
      w.str(name);
      w.f32(Number.isFinite(v.base) ? v.base : 0);
      writeKf(w, v.kf || []);
    }
  }

  // 摄像机对象（v6 新增；供播放端按 id 查询位置/旋转/FOV 关键帧）
  const cameras = state.cameras || [];
  const cameraIndex = new Map(cameras.map((c, i) => [c.id, i]));
  w.varint(cameras.length);
  for (const c of cameras) {
    w.str(c.id || '');
    w.str(c.name || '');
    w.f32(c.pos[0]); w.f32(c.pos[1]); w.f32(c.pos[2]);
    w.f32(c.rot[0]); w.f32(c.rot[1]); w.f32(c.rot[2]);
    w.f32(c.fov != null ? c.fov : 50);
  }

  // 轨道（非函数对象轨道）
  const tracks = state.tracks.filter(tr => !tr.fx);
  const outTracks = [];
  for (const tr of tracks) {
    const pr = PR_ENUM[tr.pr];
    if (pr == null) continue;
    const refs = [];
    for (const id of tr.ids || []) {
      if (id.startsWith('g:')) {
        const gi = groupIndex.get(id.slice(2));
        if (gi != null) refs.push([1, gi]);
      } else if (id.startsWith('f:')) {
        const fi = functionIndex.get(id.slice(2));
        if (fi != null) refs.push([2, fi]);
      } else if (id.startsWith('c:')) {
        const ci = cameraIndex.get(id.slice(2));
        if (ci != null) refs.push([3, ci]);
      } else {
        const pi = particleIndex.get(id);
        if (pi != null) refs.push([0, pi]);
      }
    }
    if (refs.length) outTracks.push({ tr, pr, refs });
  }
  w.varint(outTracks.length);
  for (const { tr, pr, refs } of outTracks) {
    w.u8(pr);
    w.u8(tr.m === 'op' ? 1 : 0);
    w.varint(refs.length);
    for (const [kind, idx] of refs) writeRef(w, kind, idx);
    writeKf(w, tr.kf || []);
  }

  return w.toUint8Array();
}

/* ============================ 编码 / 组装 / 签名 ============================ */

/**
 * 编码未签名部分：magic + version + pubkey + raw-deflate(body)。
 */
export async function encodePdrawcUnsigned(state, texPngOf) {
  const pub = base64ToBytes(state.key.public);
  const body = encodeBody(state, texPngOf);
  const compressed = await deflateRaw(body);
  const w = new ByteWriter();
  w.bytes(PDRAWC_MAGIC);
  w.varint(PDRAWC_VERSION);
  w.bytes(pub);
  w.bytes(compressed);
  return w.toUint8Array();
}

/** 组装最终 .pdrawc（未签名部分 + 64 字节签名）。 */
export function assemblePdrawc(unsigned, signature) {
  const out = new Uint8Array(unsigned.length + signature.length);
  out.set(unsigned, 0);
  out.set(signature, unsigned.length);
  return out;
}

/**
 * 完整导出：编码 + raw-deflate 压缩 + Ed25519 签名。私钥缺失时抛错。
 */
export async function buildPdrawc(state, texPngOf) {
  if (!state.key || !state.key.private) throw new Error('missing signing key');
  const unsigned = await encodePdrawcUnsigned(state, texPngOf);
  const signature = await signData(state.key.private, unsigned);
  return assemblePdrawc(unsigned, signature);
}

/* ============================ 解码（回环测试 / 校验用） ============================ */

function readUV(r) {
  return {
    textureIndex: r.varint(),
    mode: UV_MODE_BY[r.u8()] || 'static',
    texSize: [r.varint(), r.varint()],
    uvStart: [r.varint(), r.varint()],
    uvSize: [r.varint(), r.varint()],
    uvStep: [r.varint(), r.varint()],
    fps: r.f32(),
    maxFrame: r.varint(),
    loop: r.u8() !== 0,
  };
}

function readEnt(r) {
  return { p: r.str(), d: r.varint() };
}

function readEasing(r) {
  const tag = r.u8();
  if (tag === 0) return r.varint();
  if (tag === 1) return [r.f32(), r.f32(), r.f32(), r.f32()];
  if (tag === 2) return EASING_NONE; // 无缓动（阶跃）
  throw new Error('pdrawc: unknown easing tag');
}

function readKf(r) {
  const n = r.varint();
  const kf = [];
  for (let i = 0; i < n; i++) {
    kf.push([r.varint(), r.f32(), readEasing(r)]);
  }
  return kf;
}

function readMagic(r) {
  const magic = r.bytes(4);
  if (magic[0] !== PDRAWC_MAGIC[0] || magic[1] !== PDRAWC_MAGIC[1] ||
      magic[2] !== PDRAWC_MAGIC[2] || magic[3] !== PDRAWC_MAGIC[3]) {
    throw new Error('pdrawc: bad magic');
  }
}

export async function decodePdrawc(bytes) {
  const r = new ByteReader(bytes);
  readMagic(r);
  const version = r.varint();
  if (version !== PDRAWC_VERSION) throw new Error('pdrawc: unsupported version');
  const pubKeyBytes = r.bytes(PDRAWC_PUB_LEN);
  const rest = bytes.subarray(r.pos);
  const bodyBytes = await inflateRaw(rest);
  const br = new ByteReader(bodyBytes);

  const loop = br.u8() !== 0;

  const texCount = br.varint();
  const textures = [];
  const texIndex = new Map();
  for (let i = 0; i < texCount; i++) {
    const name = br.str();
    const pngLen = br.varint();
    const png = br.bytes(pngLen);
    textures.push({ name, png });
    texIndex.set(i, name);
  }

  const particleCount = br.varint();
  const particles = [];
  for (let i = 0; i < particleCount; i++) {
    const color = [br.u8() / 255, br.u8() / 255, br.u8() / 255, br.u8() / 255];
    const scale = [br.f32(), br.f32(), br.f32()];
    const flags = br.u8();
    const lightLevel = br.u8();
    const pos = [br.f32(), br.f32(), br.f32()];
    const vel = [br.f32(), br.f32(), br.f32()];
    const st = br.varint();
    const life = (flags & 8) !== 0 ? br.varint() : -1;
    const ent = (flags & 4) !== 0 ? readEnt(br) : null;
    const uv = (flags & 2) !== 0 ? readUV(br) : null;
    particles.push({ color, scale, glow: !!(flags & 1), lightLevel, pos, vel, st, life, ent, uv });
  }

  const groupCount = br.varint();
  const groups = [];
  const groupSpinLocal = [];
  const groupRotLocal = [];
  for (let i = 0; i < groupCount; i++) {
    const gflags = br.u8();
    const n = br.varint();
    const members = [];
    for (let j = 0; j < n; j++) members.push(br.varint());
    groups.push(members);
    groupSpinLocal.push((gflags & 1) !== 0);
    groupRotLocal.push((gflags & 2) !== 0);
  }

  const guvCount = br.varint();
  const groupUV = [];
  for (let i = 0; i < guvCount; i++) {
    const groupIdx = br.varint();
    const uv = readUV(br);
    groupUV.push({ groupIdx, uv });
  }

  const fxCount = br.varint();
  const functions = [];
  for (let i = 0; i < fxCount; i++) {
    const center = [br.f32(), br.f32(), br.f32()];
    const count = br.varint();
    const setup = br.str();
    const process = br.str();
    const seed = br.varint();
    const duration = br.varint();
    const st = br.varint();
    const flags = br.u8();
    const ent = (flags & 1) !== 0 ? readEnt(br) : null;
    const uv = (flags & 2) !== 0 ? readUV(br) : null;
    const fastMath = !!(flags & 4);
    const spinLocal = !!(flags & 16);
    const rotLocal = !!(flags & 32);
    const funcs = (flags & 8) !== 0 ? br.str() : '';
    const varCount = br.varint();
    const vars = [];
    for (let j = 0; j < varCount; j++) {
      const name = br.str();
      const base = br.f32();
      const kf = readKf(br);
      vars.push({ name, base, kf });
    }
    functions.push({ center, count, setup, process, funcs, seed, duration, st, ent, uv, vars, fastMath, spinLocal, rotLocal });
  }

  const camCount = br.varint();
  const cameras = [];
  for (let i = 0; i < camCount; i++) {
    const id = br.str();
    const name = br.str();
    const pos = [br.f32(), br.f32(), br.f32()];
    const rot = [br.f32(), br.f32(), br.f32()];
    const fov = br.f32();
    cameras.push({ id, name, pos, rot, fov });
  }

  const trackCount = br.varint();
  const tracks = [];
  for (let i = 0; i < trackCount; i++) {
    const pr = PR_BY_ENUM[br.u8()];
    if (!pr) throw new Error('pdrawc: unknown pr enum');
    const mode = br.u8() === 1 ? 'op' : 'set';
    const idCount = br.varint();
    const ids = [];
    for (let j = 0; j < idCount; j++) {
      const kind = br.u8();
      if (kind > 3) throw new Error('pdrawc: unknown ref kind');
      ids.push({ kind, index: br.varint() });
    }
    const kf = readKf(br);
    tracks.push({ pr, mode, ids, kf });
  }

  if (br.remaining !== 0) throw new Error('pdrawc: trailing bytes in body');

  return { loop, textures, particles, groups, groupSpinLocal, groupRotLocal, groupUV, functions, cameras, tracks, pubKeyBytes };
}

/** 从完整 .pdrawc 提取公钥 base64（用于验签）。 */
export function readPubKeyBase64(bytes) {
  const r = new ByteReader(bytes);
  readMagic(r);
  r.varint();
  return bytesToBase64(r.bytes(PDRAWC_PUB_LEN));
}

/** 验证完整 .pdrawc 的 Ed25519 签名（覆盖除末尾 64 字节外的全部内容）。 */
export async function verifyPdrawc(bytes) {
  if (bytes.length < PDRAWC_MAGIC.length + 1 + PDRAWC_PUB_LEN + PDRAWC_SIG_LEN) return false;
  const unsigned = bytes.subarray(0, bytes.length - PDRAWC_SIG_LEN);
  const signature = bytes.subarray(bytes.length - PDRAWC_SIG_LEN);
  const pub = readPubKeyBase64(bytes);
  return verifyData(pub, unsigned, signature);
}