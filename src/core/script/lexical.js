// 脚本语言词法常量（script-lang.js / script/parser.js 共享）：关键字、上下文名、生命周期
// 函数名、常量、向量分量名、内建函数名、parseError。不依赖运行时，避免 parser ↔ runtime 循环依赖。

export const KEYWORDS = new Set([
  'setup', 'process', 'tick', 'func', 'return', 'if', 'else', 'while', 'do', 'for', 'of', 'const',
  'let', 'undefined',
  'break', 'continue', 'true', 'false',
]);

// this 对象：唯一保留的上下文访问名。
export const CTX_NAME = 'this';

// 生命周期入口：setup / tick / process 是保留函数名，其它自定义函数不可使用。
export const LIFECYCLE_FUNCS = new Set(['setup', 'tick', 'process']);

// 常量（§13）。PI / E 在 tokenizer 中直接变成数值字面量，这里保留以防查表。
export const CONSTANTS = new Map([
  ['TAU', Math.PI * 2],
  ['HALF_PI', Math.PI / 2],
  ['QUARTER_PI', Math.PI / 4],
  ['DEG2RAD', Math.PI / 180],
  ['RAD2DEG', 180 / Math.PI],
  ['PI', Math.PI],
  ['E', Math.E],
]);

// 向量分量访问名：r/g/b 分别是 x/y/z 的别名，a 是 w 的别名（§5 后缀）。
export const COMP_ALIAS = { x: 'x', y: 'y', z: 'z', w: 'w', r: 'x', g: 'y', b: 'z', a: 'w' };
export const COMP_NAMES = new Set(['x', 'y', 'z', 'w', 'r', 'g', 'b', 'a']);

// 内建函数名（与 BUILTIN_TABLE 的声明一一对应，parser 用于保留名校验）。
export const BUILTIN_FUNCTION_NAMES = [
  'print', 'assert',
  'vec2', 'vec3', 'vec4', 'vec', 'mat3',
  'translate', 'scale', 'rotate', 'lookAt',
  'rotX', 'rotY', 'rotZ', 'rotAxis',
  'dot', 'cross', 'len', 'len2', 'norm', 'lerp', 'mix',
  'distance', 'angle_between', 'project', 'reflect',
  'clamp', 'map_range', 'remap',
  'int', 'float', 'bool',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'sqrt', 'abs', 'sign', 'exp', 'log', 'ln',
  'floor', 'ceil', 'round', 'fract', 'pow', 'min', 'max',
  'step', 'smoothstep', 'mod',
  'noise', 'fbm', 'rand', 'random',
  'ease_linear', 'ease_in_out', 'ease_out_back', 'ease_in_elastic',
  'unique', 'reverse', 'sort',
];
export const BUILTIN_FUNCTIONS = new Set(BUILTIN_FUNCTION_NAMES);

export function parseError(msg, line, col) {
  return new Error(`${msg} (line ${line}, col ${col})`);
}