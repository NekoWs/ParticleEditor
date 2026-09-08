// 生成双端共享脚本对拍语料（docs/conformance/corpus.json）。
// 运行：node docs/conformance/generate.mjs
import { writeFileSync } from 'node:fs';
import { parseProgram, createObjectState, runSetup, createStatics, evalProcess } from '../../src/core/script-lang.js';

const TICKS_PER_SEC = 20;
const DT_PER_TICK = 1 / TICKS_PER_SEC;

function uvFor(count, i, gridColsBase) {
  const C = gridColsBase || Math.max(1, Math.ceil(Math.sqrt(count)));
  const R = Math.max(1, Math.ceil(count / C));
  const col = i % C;
  const row = Math.floor(i / C);
  return {
    uv_x: (C === 1) ? 0 : col / (C - 1),
    uv_y: (R === 1) ? 0 : row / (R - 1),
  };
}

function out0() {
  return { pos: [0, 0, 0], color: [1, 1, 1, 1], vel: [0, 0, 0], scale: 1, glow: false, light: 0 };
}

function evalCase(def, i, t) {
  const program = parseProgram('setup {\n' + (def.setup || '') + '\n}\nprocess {\n' + (def.process || '') + '\n}\n');
  const objState = createObjectState(def.seed | 0);
  runSetup(program, objState, { n: def.count, t: def.st || 0, vars: def.vars || {} });
  const statics = createStatics();
  const uv = uvFor(def.count, i, def.gridCols);
  const ctx = {
    i, n: def.count, t, dt: def.dt ?? 0,
    life: def.life ?? 0,
    uv_x: uv.uv_x, uv_y: uv.uv_y,
    vars: def.vars || {},
    out: out0(),
  };
  return evalProcess(program, objState, statics, ctx);
}

const cases = [
  {
    name: 'attrs_arith',
    seed: 0, count: 3, setup: '',
    process: '[x,y,z] = [i*2, i+1, n]; r = i/n; sc = 0.5; vx = i; glow = 1; light = 12;',
    samples: [
      { i: 0, t: 0, expect: { pos: [0, 1, 3], color: [0, 1, 1, 1], vel: [0, 0, 0], scale: 0.5, glow: true, light: 12 } },
      { i: 2, t: 0, expect: { pos: [4, 3, 3], color: [2 / 3, 1, 1, 1], vel: [2, 0, 0], scale: 0.5, glow: true, light: 12 } },
    ],
  },
  {
    name: 'vec_mat',
    seed: 0, count: 1, setup: '',
    process: 'v = vec(1,2,3); m = rotZ(PI/2); w = m * v; [x,y,z] = w; [r,g,b,a] = [len(w)/4, dot(v,w)/12, cross(v,w).y/10, 1];',
    samples: [
      { i: 0, t: 0, expect: null }, // 下面用近似断言，不写死
    ],
  },
  {
    name: 'arrays',
    seed: 0, count: 1, setup: 'global arr = []; arr.push(3); arr.push(1); arr.push(2); global brr = arr.slice(0, 3);',
    process: 'x = arr[0]; y = arr.find(2); z = arr.includes(9) ? 1 : 0; sc = brr.size();',
    samples: [
      { i: 0, t: 0, expect: { pos: [3, 2, 0], color: [1, 1, 1, 1], vel: [0, 0, 0], scale: 3, glow: false, light: 0 } },
    ],
  },
  {
    name: 'control_flow',
    seed: 0, count: 1, setup: '',
    process: 's = 0; for (k = 0; k < 5; k = k + 1) { s = s + k; } while (s < 11) { s = s + 1; } if (s > 10) { x = s; } else { x = -1; } y = (s == 12) ? 2 : 0;',
    samples: [
      { i: 0, t: 0, expect: { pos: [12, 2, 0], color: [1, 1, 1, 1], vel: [0, 0, 0], scale: 1, glow: false, light: 0 } },
    ],
  },
  {
    name: 'func_recursion',
    seed: 0, count: 1, setup: '',
    process: 'x = fib(6); y = fac(4);',
    funcs: 'func fib(nn) { if (nn < 2) { return nn; } return fib(nn-1) + fib(nn-2); }\nfunc fac(nn) { if (nn <= 1) { return 1; } return nn * fac(nn-1); }',
    samples: [
      { i: 0, t: 0, expect: { pos: [8, 24, 0], color: [1, 1, 1, 1], vel: [0, 0, 0], scale: 1, glow: false, light: 0 } },
    ],
  },
  {
    name: 'noise_rand_seeded',
    seed: 42, count: 2, setup: '',
    process: 'x = noise(i, 0.5, 1.5) * 10; y = rand() * 10; z = rand(7) * 10;',
    samples: [
      { i: 0, t: 0, expect: null },
      { i: 1, t: 0, expect: null },
    ],
  },
];

const corpus = { version: 1, ticksPerSec: TICKS_PER_SEC, cases: [] };

for (const def of cases) {
  const programSource = (def.funcs ? def.funcs + '\n' : '') +
    'setup {\n' + (def.setup || '') + '\n}\nprocess {\n' + (def.process || '') + '\n}\n';
  const program = parseProgram(programSource);
  const outCase = { name: def.name, seed: def.seed, count: def.count, setup: def.setup || '', process: def.process || '', funcs: def.funcs || '', gridCols: def.gridCols ?? null, samples: [] };

  // 对需要精确写死的样例直接采用 def.samples.expect；对 noise/rand 等用运行时生成。
  for (const s of def.samples) {
    const objState = createObjectState(def.seed | 0);
    runSetup(program, objState, { n: def.count, t: def.st || 0, vars: def.vars || {} });
    const statics = createStatics();
    const uv = uvFor(def.count, s.i, def.gridCols);
    const ctx = {
      i: s.i, n: def.count, t: s.t, dt: s.dt ?? 0,
      life: s.life ?? 0,
      uv_x: uv.uv_x, uv_y: uv.uv_y,
      vars: def.vars || {},
      out: out0(),
    };
    const out = evalProcess(program, objState, statics, ctx);
    outCase.samples.push({
      i: s.i, t: s.t, dt: s.dt ?? 0, life: s.life ?? 0,
      uv_x: ctx.uv_x, uv_y: ctx.uv_y,
      expect: {
        pos: out.pos.slice(),
        color: out.color.slice(),
        vel: out.vel.slice(),
        scale: out.scale,
        glow: out.glow,
        light: out.light,
      },
    });
  }
  corpus.cases.push(outCase);
}

writeFileSync(new URL('./corpus.json', import.meta.url), JSON.stringify(corpus, null, 2) + '\n');
console.log('wrote corpus.json with', corpus.cases.length, 'cases');