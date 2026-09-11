// 预设修改目录：给函数对象追加形状/颜色类后处理代码段（纯逻辑，无 DOM）。
// 每个预设定义一组参数与 build(values) → 生成 script-lang 语句；
// 应用时把生成的代码块插入 process（或 setup）末尾，块首尾带行注释标记，
// 再次应用同一预设先移除旧块再插入，避免重复叠加。

export const PRESET_MARK_BEGIN = '// ==pdraw-preset:';
export const PRESET_MARK_END = '// ==/pdraw-preset==';

// —— 参数工具 ——

const AXIS_OPTIONS = ['x', 'y', 'z', 'index', 'dist'];
const AXIS_TIME_OPTIONS = ['x', 'y', 'z', 'dist', 'time'];
const SHAPE_AXIS_OPTIONS = ['x', 'y', 'z'];

// 数值格式化：有限数取 4 位小数，否则回退。
const N = (v, fallback = 0) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.round(x * 10000) / 10000 : fallback;
};
// 颜色分量（0..1 数组）
const C = (v) => [0, 1, 2, 3].map((i) => N((v || [])[i], 1));

// —— 渐变停止点（stops，PS 式渐变条的色标模型）——

// 归一化：排序、钳制位置与颜色分量，不足 2 个时补默认白。
export function normalizeStops(stops) {
  const raw = Array.isArray(stops) ? stops : [];
  const out = raw
    .filter((s) => s && Number.isFinite(Number(s.pos)))
    .map((s) => ({
      pos: Math.max(0, Math.min(1, Number(s.pos))),
      color: [0, 1, 2, 3].map((i) => Math.max(0, Math.min(1, Number((s.color || [])[i])))),
    }));
  out.sort((a, b) => a.pos - b.pos);
  if (out.length < 2) {
    out.length = 0;
    out.push({ pos: 0, color: [1, 1, 1, 1] }, { pos: 1, color: [1, 1, 1, 1] });
  }
  return out;
}

// 色标元数据行（写进块内注释，重开窗口时用来还原色条）
export function stopsMetaLine(stops) {
  const data = normalizeStops(stops).map((s) => [N(s.pos), N(s.color[0], 1), N(s.color[1], 1), N(s.color[2], 1), N(s.color[3], 1)]);
  return '// ==pdraw-stops:' + JSON.stringify({ s: data }) + '==';
}

// 从源码里指定预设的块注释还原色标；没有/损坏返回 null。
export function extractGradientStops(src, presetId) {
  const s = String(src || '');
  const bi = s.indexOf(PRESET_MARK_BEGIN + presetId + '==');
  if (bi < 0) return null;
  const ei = s.indexOf(PRESET_MARK_END, bi);
  const block = ei < 0 ? s.slice(bi) : s.slice(bi, ei);
  const m = /\/\/ ==pdraw-stops:(\{.*?\})==/.exec(block);
  if (!m) return null;
  try {
    const o = JSON.parse(m[1]);
    if (Array.isArray(o.s)) {
      return o.s.map((x) => ({ pos: Number(x[0]), color: [Number(x[1]), Number(x[2]), Number(x[3]), Number(x[4])] }));
    }
  } catch (e) { /* 元数据损坏：忽略 */ }
  return null;
}

// 依据轴/距离/序号/时间的原始取值表达式（进程内，0..1 归一化前）
const AXIS_RAW = {
  x: 'p.position.x',
  y: 'p.position.y',
  z: 'p.position.z',
  index: 'p.index',
  dist: 'p.position.len()',
  time: 'this.time / 1000',
};

// 依据 expr + range 生成 0..1 归一化进度（坐标轴以世界原点为中心、跨 range 归一）
function axisNormExpr(axis, range) {
  if (axis === 'index') return 'clamp(norm(p.index, this.particles.size()), 0, 1)';
  if (axis === 'dist') return 'clamp(' + AXIS_RAW.dist + ' / ' + N(range, 8) + ', 0, 1)';
  if (axis === 'time') return 'mod(' + AXIS_RAW.time + ' / ' + Math.max(0.01, N(range, 4)) + ', 1)';
  return 'clamp(' + AXIS_RAW[axis] + ' / ' + N(range, 8) + ' + 0.5, 0, 1)';
}

// —— 预设目录 ——

export const PRESET_CATEGORIES = [
  { id: 'color', presetIds: ['gradient', 'rainbow', 'alpha_fade', 'pulse'] },
  { id: 'shape', presetIds: ['twist', 'wave', 'expand', 'swirl', 'stretch'] },
];

export const MODIFY_PRESETS = [
  {
    id: 'gradient',
    cat: 'color',
    target: 'process',
    params: [
      {
        key: 'stops', type: 'gradient',
        def: [
          { pos: 0, color: [1, 0.478, 0.161, 1] },
          { pos: 1, color: [0.227, 0.549, 1, 1] },
        ],
      },
      { key: 'basis', type: 'enum', options: AXIS_OPTIONS, def: 'y' },
      { key: 'strength', type: 'num', min: 0, max: 1, step: 0.05, def: 1 },
      { key: 'power', type: 'num', min: 0.1, max: 10, step: 0.1, def: 1 },
      { key: 'reverse', type: 'bool', def: false, advanced: true },
      { key: 'range', type: 'num', min: 0.1, max: 100, step: 0.5, def: 8, advanced: true },
    ],
    build(v) {
      const stops = normalizeStops(v.stops);
      const strength = N(v.strength, 1);
      const power = N(v.power, 1);
      const reverse = !!v.reverse;
      const lines = [
        stopsMetaLine(stops),
        'for (const p of this.particles) {',
        '  let po = p.color',
        '  let gv = ' + axisNormExpr(v.basis, v.range),
      ];
      if (reverse) lines.push('  gv = 1 - gv');
      lines.push('  gv = pow(gv, ' + power + ')');
      const s0 = stops[0];
      lines.push(
        '  let cr = ' + N(s0.color[0]),
        '  let cg = ' + N(s0.color[1]),
        '  let cb = ' + N(s0.color[2]),
        '  let ca = ' + N(s0.color[3], 1),
      );
      const n = stops.length;
      const seg = (a, b, indent) => {
        const d = Math.max(1e-4, N(b.pos - a.pos));
        const p = ' '.repeat(indent);
        return [
          p + 'let s = clamp((gv - ' + N(a.pos) + ') / ' + d + ', 0, 1)',
          p + 'cr = ' + N(a.color[0]) + ' + ' + N(b.color[0] - a.color[0]) + ' * s',
          p + 'cg = ' + N(a.color[1]) + ' + ' + N(b.color[1] - a.color[1]) + ' * s',
          p + 'cb = ' + N(a.color[2]) + ' + ' + N(b.color[2] - a.color[2]) + ' * s',
          p + 'ca = ' + N(a.color[3], 1) + ' + ' + N(b.color[3] - a.color[3]) + ' * s',
        ];
      };
      if (n === 2) {
        lines.push(...seg(stops[0], stops[1], 2));
      } else {
        for (let i = 0; i < n - 1; i++) {
          lines.push(i === 0 ? '  if (gv < ' + N(stops[i + 1].pos) + ') {' : '  } else if (gv < ' + N(stops[i + 1].pos) + ') {');
          lines.push(...seg(stops[i], stops[i + 1], 4));
        }
        lines.push('  } else {');
        lines.push(...seg(stops[n - 2], stops[n - 1], 4));
        lines.push('  }');
      }
      lines.push('  let br = po.r * ' + N(1 - strength) + ' + cr * ' + strength);
      lines.push('  let bg = po.g * ' + N(1 - strength) + ' + cg * ' + strength);
      lines.push('  let bb = po.b * ' + N(1 - strength) + ' + cb * ' + strength);
      lines.push('  let ba = po.a * ' + N(1 - strength) + ' + ca * ' + strength);
      lines.push('  p.color = color(br, bg, bb, ba)');
      lines.push('}');
      return lines.join('\n');
    },
  },
  {
    id: 'rainbow',
    cat: 'color',
    target: 'process',
    params: [
      { key: 'hueOffset', type: 'num', min: 0, max: 360, step: 5, def: 0 },
      { key: 'range', type: 'num', min: 0, max: 1440, step: 30, def: 360 },
      { key: 'basis', type: 'enum', options: AXIS_OPTIONS, def: 'x' },
      { key: 'sat', type: 'num', min: 0, max: 1, step: 0.05, def: 1 },
      { key: 'bright', type: 'num', min: 0, max: 1, step: 0.05, def: 1 },
      { key: 'power', type: 'num', min: 0.1, max: 10, step: 0.1, def: 1, advanced: true },
      { key: 'useTime', type: 'bool', def: false, advanced: true },
      { key: 'period', type: 'num', min: 0.1, max: 60, step: 0.5, def: 4, advanced: true },
    ],
    build(v) {
      const hueStart = N(v.hueOffset, 0) / 360;
      const hueSpan = N(v.range, 360) / 360;
      const sat = N(v.sat, 1), bright = N(v.bright, 1);
      const power = N(v.power, 1);
      const lines = [
        'for (const p of this.particles) {',
        '  let ca2 = p.color.a',
      ];
      if (v.useTime) {
        lines.push('  let gv = mod(' + AXIS_RAW.time + ' / ' + Math.max(0.01, N(v.period, 4)) + ', 1)');
      } else {
        lines.push('  let gv = ' + axisNormExpr(v.basis, v.range));
      }
      lines.push('  gv = pow(gv, ' + power + ')');
      lines.push('  let hh = ' + N(hueStart) + ' + ' + N(hueSpan) + ' * gv');
      // 先设饱和度再设色相：无彩色源（灰/白）也能被着色。
      lines.push('  p.color = p.color.saturation(' + sat + ').hue(hh).value(' + bright + ').alpha(ca2)');
      lines.push('}');
      return lines.join('\n');
    },
  },
  {
    id: 'alpha_fade',
    cat: 'color',
    target: 'process',
    params: [
      { key: 'basis', type: 'enum', options: AXIS_TIME_OPTIONS, def: 'dist' },
      { key: 'range', type: 'num', min: 0.1, max: 100, step: 0.5, def: 8 },
      { key: 'a0', type: 'num', min: 0, max: 1, step: 0.05, def: 1 },
      { key: 'a1', type: 'num', min: 0, max: 1, step: 0.05, def: 0 },
      { key: 'power', type: 'num', min: 0.1, max: 10, step: 0.1, def: 1, advanced: true },
      { key: 'shift', type: 'num', min: -1, max: 1, step: 0.05, def: 0, advanced: true },
    ],
    build(v) {
      const a0 = N(v.a0, 1), a1 = N(v.a1, 0);
      const power = N(v.power, 1), shift = N(v.shift, 0);
      const lines = [
        'for (const p of this.particles) {',
        '  let gv = ' + axisNormExpr(v.basis, v.range),
      ];
      if (shift !== 0) lines.push('  gv = clamp(gv + ' + shift + ', 0, 1)');
      lines.push('  gv = pow(gv, ' + power + ')');
      lines.push('  p.color = p.color.alpha(' + a0 + ' + ' + N(a1 - a0) + ' * gv)');
      lines.push('}');
      return lines.join('\n');
    },
  },
  {
    id: 'pulse',
    cat: 'color',
    target: 'process',
    params: [
      { key: 'freq', type: 'num', min: 0.1, max: 20, step: 0.1, def: 1 },
      { key: 'amount', type: 'num', min: 0, max: 1, step: 0.05, def: 0.6 },
      { key: 'mode', type: 'enum', options: ['bright', 'alpha', 'both'], def: 'alpha' },
      { key: 'phase', type: 'num', min: 0, max: 1, step: 0.05, def: 0 },
      { key: 'brightBase', type: 'num', min: 0, max: 1, step: 0.05, def: 1, advanced: true },
      { key: 'alphaBase', type: 'num', min: 0, max: 1, step: 0.05, def: 1, advanced: true },
    ],
    build(v) {
      const freq = N(v.freq, 1), amount = N(v.amount, 0.6);
      const phase = N(v.phase, 0);
      const brightBase = N(v.brightBase, 1), alphaBase = N(v.alphaBase, 1);
      const lines = [
        'for (const p of this.particles) {',
        '  let wv = 0.5 - 0.5 * cos(' + N(freq * 2 * Math.PI) + ' * this.time / 1000 + ' + N(phase * 2 * Math.PI) + ')',
      ];
      const mode = v.mode === 'bright' || v.mode === 'both' ? v.mode : 'alpha';
      if (mode === 'bright') {
        lines.push('  let ca2 = p.color.a');
        lines.push('  p.color = p.color.value(' + brightBase + ' * (1 - ' + amount + ' * wv)).alpha(ca2)');
      } else if (mode === 'both') {
        lines.push('  p.color = p.color.value(' + brightBase + ' * (1 - ' + amount + ' * wv)).alpha(' + alphaBase + ' * (1 - ' + amount + ' * wv))');
      } else {
        lines.push('  p.color = p.color.alpha(' + alphaBase + ' * (1 - ' + amount + ' * wv))');
      }
      lines.push('}');
      return lines.join('\n');
    },
  },
  {
    id: 'twist',
    cat: 'shape',
    target: 'process',
    params: [
      { key: 'angle', type: 'num', min: -720, max: 720, step: 15, def: 180 },
      { key: 'axis', type: 'enum', options: SHAPE_AXIS_OPTIONS, def: 'y' },
      { key: 'start', type: 'num', min: -100, max: 100, step: 0.5, def: -4 },
      { key: 'end', type: 'num', min: -100, max: 100, step: 0.5, def: 4 },
      { key: 'curve', type: 'num', min: 0.1, max: 10, step: 0.1, def: 1, advanced: true },
      { key: 'cx', type: 'num', min: -100, max: 100, step: 0.5, def: 0, advanced: true },
      { key: 'cy', type: 'num', min: -100, max: 100, step: 0.5, def: 0, advanced: true },
      { key: 'cz', type: 'num', min: -100, max: 100, step: 0.5, def: 0, advanced: true },
    ],
    build(v) {
      const angle = N(v.angle, 180) * (Math.PI / 180);
      const start = N(v.start, -4), end = N(v.end, 4);
      let span = end - start;
      if (Math.abs(span) < 1e-4) span = span >= 0 ? 1e-4 : -1e-4;
      const curve = N(v.curve, 1);
      const cx = N(v.cx, 0), cy = N(v.cy, 0), cz = N(v.cz, 0);
      const along = { x: 'px', y: 'py', z: 'pz' }[v.axis] || 'py';
      const lines = [
        'for (const p of this.particles) {',
        '  let px = p.position.x - ' + cx,
        '  let py = p.position.y - ' + cy,
        '  let pz = p.position.z - ' + cz,
        '  let tt = clamp((' + along + ' - ' + start + ') / ' + span + ', 0, 1)',
        '  tt = pow(tt, ' + curve + ')',
        '  let aa = ' + N(angle) + ' * tt',
        '  let ca = cos(aa)',
        '  let sa = sin(aa)',
      ];
      if (v.axis === 'x') {
        lines.push('  let ny = py * ca - pz * sa', '  let nz = py * sa + pz * ca');
        lines.push('  p.position = [px + ' + cx + ', ny + ' + cy + ', nz + ' + cz + ']');
      } else if (v.axis === 'z') {
        lines.push('  let nx = px * ca - py * sa', '  let ny = px * sa + py * ca');
        lines.push('  p.position = [nx + ' + cx + ', ny + ' + cy + ', pz + ' + cz + ']');
      } else {
        lines.push('  let nx = px * ca + pz * sa', '  let nz = 0 - px * sa + pz * ca');
        lines.push('  p.position = [nx + ' + cx + ', py + ' + cy + ', nz + ' + cz + ']');
      }
      lines.push('}');
      return lines.join('\n');
    },
  },
  {
    id: 'wave',
    cat: 'shape',
    target: 'process',
    params: [
      { key: 'amp', type: 'num', min: -20, max: 20, step: 0.25, def: 1 },
      { key: 'freq', type: 'num', min: 0.01, max: 20, step: 0.1, def: 0.5 },
      { key: 'axis', type: 'enum', options: SHAPE_AXIS_OPTIONS, def: 'y' },
      { key: 'src', type: 'enum', options: AXIS_TIME_OPTIONS, def: 'x' },
      { key: 'phase', type: 'num', min: 0, max: 1, step: 0.05, def: 0 },
      { key: 'power', type: 'num', min: 0.1, max: 10, step: 0.1, def: 1, advanced: true },
      { key: 'decay', type: 'bool', def: false, advanced: true },
      { key: 'range', type: 'num', min: 0.1, max: 100, step: 0.5, def: 8, advanced: true },
    ],
    build(v) {
      const amp = N(v.amp, 1), freq = N(v.freq, 0.5);
      const phase = N(v.phase, 0);
      const power = N(v.power, 1);
      const decay = !!v.decay && v.src !== 'time';
      const lines = [
        'for (const p of this.particles) {',
        '  let sv = ' + AXIS_RAW[v.src === 'time' ? 'time' : (v.src || 'x')],
        '  let wv = sin(' + N(freq * 2 * Math.PI) + ' * sv + ' + N(phase * 2 * Math.PI) + ')',
      ];
      if (power !== 1) lines.push('  wv = sign(wv) * pow(abs(wv), ' + power + ')');
      if (decay) lines.push('  wv = wv * exp(0 - pow(sv / ' + Math.max(0.1, N(v.range, 8)) + ', 2))');
      lines.push('  let dv = ' + amp + ' * wv');
      lines.push('  p.position.' + (v.axis || 'y') + ' += dv');
      lines.push('}');
      return lines.join('\n');
    },
  },
  {
    id: 'expand',
    cat: 'shape',
    target: 'process',
    params: [
      { key: 'scale', type: 'num', min: 0.1, max: 10, step: 0.1, def: 1.5 },
      { key: 'axis', type: 'enum', options: ['all', 'x', 'y', 'z'], def: 'all' },
      { key: 'cx', type: 'num', min: -100, max: 100, step: 0.5, def: 0, advanced: true },
      { key: 'cy', type: 'num', min: -100, max: 100, step: 0.5, def: 0, advanced: true },
      { key: 'cz', type: 'num', min: -100, max: 100, step: 0.5, def: 0, advanced: true },
    ],
    build(v) {
      const scale = N(v.scale, 1.5);
      const cx = N(v.cx, 0), cy = N(v.cy, 0), cz = N(v.cz, 0);
      const lines = [
        'for (const p of this.particles) {',
        '  let px = p.position.x - ' + cx,
        '  let py = p.position.y - ' + cy,
        '  let pz = p.position.z - ' + cz,
      ];
      if (v.axis === 'x') lines.push('  p.position.x = px * ' + scale + ' + ' + cx);
      else if (v.axis === 'y') lines.push('  p.position.y = py * ' + scale + ' + ' + cy);
      else if (v.axis === 'z') lines.push('  p.position.z = pz * ' + scale + ' + ' + cz);
      else lines.push('  p.position = [px * ' + scale + ' + ' + cx + ', py * ' + scale + ' + ' + cy + ', pz * ' + scale + ' + ' + cz + ']');
      lines.push('}');
      return lines.join('\n');
    },
  },
  {
    id: 'swirl',
    cat: 'shape',
    target: 'process',
    params: [
      { key: 'angle', type: 'num', min: -1440, max: 1440, step: 30, def: 360 },
      { key: 'axis', type: 'enum', options: SHAPE_AXIS_OPTIONS, def: 'y' },
      { key: 'radius', type: 'num', min: 0.5, max: 100, step: 0.5, def: 8 },
      { key: 'curve', type: 'num', min: 0.1, max: 10, step: 0.1, def: 1, advanced: true },
      { key: 'useTime', type: 'bool', def: false, advanced: true },
      { key: 'speed', type: 'num', min: -720, max: 720, step: 15, def: 90, advanced: true },
    ],
    build(v) {
      const angle = N(v.angle, 360) * (Math.PI / 180);
      const speed = N(v.speed, 90) * (Math.PI / 180);
      const radius = Math.max(0.01, N(v.radius, 8));
      const curve = N(v.curve, 1);
      const lines = [
        'for (const p of this.particles) {',
        '  let px = p.position.x',
        '  let py = p.position.y',
        '  let pz = p.position.z',
      ];
      const radial = { x: 'sqrt(pow(py, 2) + pow(pz, 2))', y: 'sqrt(pow(px, 2) + pow(pz, 2))', z: 'sqrt(pow(px, 2) + pow(py, 2))' }[v.axis] || 'sqrt(pow(px, 2) + pow(pz, 2))';
      lines.push('  let rr = ' + radial);
      lines.push('  let ft = clamp(1 - rr / ' + radius + ', 0, 1)');
      lines.push('  ft = pow(ft, ' + curve + ')');
      if (v.useTime) {
        lines.push('  let aa = (' + N(angle) + ' + ' + N(speed) + ' * this.time / 1000) * ft');
      } else {
        lines.push('  let aa = ' + N(angle) + ' * ft');
      }
      lines.push('  let ca = cos(aa)', '  let sa = sin(aa)');
      if (v.axis === 'x') {
        lines.push('  let ny = py * ca - pz * sa', '  let nz = py * sa + pz * ca');
        lines.push('  p.position = [px, ny, nz]');
      } else if (v.axis === 'z') {
        lines.push('  let nx = px * ca - py * sa', '  let ny = px * sa + py * ca');
        lines.push('  p.position = [nx, ny, pz]');
      } else {
        lines.push('  let nx = px * ca + pz * sa', '  let nz = 0 - px * sa + pz * ca');
        lines.push('  p.position = [nx, py, nz]');
      }
      lines.push('}');
      return lines.join('\n');
    },
  },
  {
    id: 'stretch',
    cat: 'shape',
    target: 'process',
    params: [
      { key: 'axis', type: 'enum', options: SHAPE_AXIS_OPTIONS, def: 'y' },
      { key: 'factor', type: 'num', min: 0.1, max: 10, step: 0.1, def: 2 },
      { key: 'midPoint', type: 'num', min: -100, max: 100, step: 0.5, def: 0 },
      { key: 'keepVolume', type: 'bool', def: false, advanced: true },
    ],
    build(v) {
      const axis = v.axis || 'y';
      const factor = N(v.factor, 2), midPoint = N(v.midPoint, 0);
      const others = ['x', 'y', 'z'].filter((a) => a !== axis);
      const lines = [
        'for (const p of this.particles) {',
        '  let off = (p.position.' + axis + ' - ' + midPoint + ') * ' + N(factor - 1),
        '  p.position.' + axis + ' += off',
      ];
      if (v.keepVolume && factor > 0) {
        const k = N(Math.pow(factor, -0.5));
        lines.push('  p.position.' + others[0] + ' *= ' + k);
        lines.push('  p.position.' + others[1] + ' *= ' + k);
      }
      lines.push('}');
      return lines.join('\n');
    },
  },
];

export function getPreset(id) {
  return MODIFY_PRESETS.find((p) => p.id === id) || null;
}

// 参数默认值表（应用与预览共用）
export function defaultPresetValues(preset) {
  const out = {};
  for (const p of preset.params) {
    if (p.type === 'gradient') {
      out[p.key] = (p.def || []).map((s) => ({ pos: Number(s.pos), color: (s.color || [1, 1, 1, 1]).slice() }));
    } else if (p.type === 'color') {
      out[p.key] = (p.def || [1, 1, 1, 1]).slice();
    } else {
      out[p.key] = p.def;
    }
  }
  return out;
}

// 生成预设代码（函数体语句，含 2 空格基础缩进）
export function buildPresetCode(preset, values) {
  return preset.build(values);
}

// —— 源码插入 / 替换 ——

function skipString(src, i) {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === '"') return j;
  }
  return src.length - 1;
}

// 从 open 处的 '{' 出发找到匹配的 '}'（跳过字符串与注释）
function matchBrace(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"') { i = skipString(src, i); continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) return -1;
      i = e + 1;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// 找到 func <name>() 的函数体结尾 '}' 下标；不存在返回 -1
function funcBodyCloseIndex(src, name) {
  const re = new RegExp('\\bfunc\\s+' + name + '\\s*\\(', 'g');
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf('{', re.lastIndex);
    if (open < 0) continue;
    const close = matchBrace(src, open);
    if (close >= 0) return close;
  }
  return -1;
}

// 移除源码中指定预设的代码块（标记行起止整段），返回新字符串
export function stripPresetBlock(src, presetId) {
  const begin = PRESET_MARK_BEGIN + presetId + '==';
  let out = String(src || '');
  for (;;) {
    const bi = out.indexOf(begin);
    if (bi < 0) return out;
    let ls = bi;
    while (ls > 0 && out[ls - 1] !== '\n') ls--;
    const ei = out.indexOf(PRESET_MARK_END, bi);
    if (ei < 0) return out;
    let le = ei;
    while (le < out.length && out[le] !== '\n') le++;
    if (le < out.length) le++;
    out = out.slice(0, ls) + out.slice(le);
  }
}

// 把预设代码块插入目标函数末尾；目标函数不存在时在源码末尾补一个空函数包裹。
export function applyPresetToSource(src, presetId, code, target) {
  const clean = stripPresetBlock(src, presetId).trimEnd();
  const indent2 = (text) => text.split('\n').map((l) => '  ' + l).join('\n');
  const block = PRESET_MARK_BEGIN + presetId + '==\n' + indent2(code) + '\n  ' + PRESET_MARK_END;
  const close = funcBodyCloseIndex(clean, target || 'process');
  if (close >= 0) {
    return clean.slice(0, close) + '\n' + block + '\n' + clean.slice(close);
  }
  const fn = 'func ' + (target || 'process') + '() {\n' + block + '\n}';
  return clean ? clean + '\n\n' + fn + '\n' : fn + '\n';
}

// 已应用的预设 id 集合（按源码中的块标记）
export function appliedPresetIds(src) {
  const ids = new Set();
  const re = /\/\/ ==pdraw-preset:([A-Za-z0-9_]+)==/g;
  let m;
  while ((m = re.exec(String(src || '')))) ids.add(m[1]);
  return ids;
}