# 函数对象脚本语言规范

本规范是编辑器（particle-editor，JavaScript）与播放器（ParticleDrawing，Kotlin）共同遵守的唯一语言语义来源。内建函数按包组织（vec / color / math / noise / ease / collection / debug），本轮全部默认可见，无 import 语法。

## 1. 生命周期与数据模型

每个函数对象 `fx` 包含一段完整脚本源码与一个种子：

- `fx.source`：完整源码（顶层 `func` 定义；`setup`/`tick`/`process` 为保留入口函数）。
- `fx.seed`：整数，默认 `0`。未显式传种子的随机/噪声函数用它。
- 顶层允许 `func` 定义与 `let`/`const` 全局声明（含对象解构声明）；`setup`/`tick`/`process` 为保留函数名，自定义函数不可使用。
- 顶层初始化按源码顺序、每次重建运行时先于 setup 执行一次；引用靠后声明的全局名报错（TDZ）。顶层不能用 `this`。

帧调度（`evaluateFxFrame`）：`T < st` 只保证 setup 已执行；超过 `duration` 不再跑 tick/process。正常帧先按经过毫秒连续递减粒子寿命，再补跑 `(cursorMs, T]` 内每个 50ms 边界的 `tick()`（边界为绝对毫秒的 50 倍数且 ≥ `fx.st`），最后跑一次 `process()`。向后 seek 重建运行时（清空粒子、重跑 setup）。

工程格式为 `.pdraw v14`、`.pdrawc v14`；旧版本一律拒绝打开，不自动迁移。

## 2. `this` 上下文

`setup`/`tick`/`process` 内 `this` 提供只读字段（时间单位均为毫秒）：

- `this.time`：对象本地时间 = 绝对播放毫秒 − `fx.st`；`setup()` 中为 `0`，范围 0..`this.duration`。
- `this.duration`：函数对象自身时长 `fx.duration`；`fx.duration ≤ 0`（无上限）时回退为整个动画总长 `maxMs`。
- `this.animTime`：整个动画的全局播放毫秒（绝对时间轴位置）。
- `this.particles`：当前函数对象的粒子列表（`particleList`，可 `for...of`、`[i]` 下标、`.size()`）。
- `this.spawn(config)`：创建并返回一个新 `particle`，立即加入列表（§3）。

`fx.vars` 中的外部变量按变量名只读注入（§11）。

`this` 本身不是值；单独使用 `this` 抛错。

## 3. particle 类型

`this.spawn()` 返回 `particle` 句柄：

- 可写内建：`position`(vec3)、`color`(color)、`velocity`(vec3)、`scale`(num)、`glow`(bool)、`light`(0..15)、`life`(num)。
- 只读：`index`（本函数对象内单调递增的 spawn 序号，不复用）。
- 任意自定义字段：`p.foo = value` 即存即取；未设置的字段读 `undefined`。
- 分量别名（`x/y/z/w/r/g/b/a/alpha`）对向量与 color 有效（`alpha` 是 `a` 的别名）；写在 `particle` 上时按自定义字段存取（`p.a = 1` 写入自定义字段 `a`）。颜色/位置分量须写 `p.color.a`、`p.color.alpha`、`p.position.x` 等。
- `p.color` 读取返回 color；写入接受 color、vec3、vec4、`[r,g,b]`、`[r,g,b,a]`，分量钳制到 0..1。
- 方法：`p.kill()` 立即从列表移除。
- 读取 `p.position`/`p.color`/`p.velocity` 得到新值（拷贝）；改分量须写 `p.position.x = ...` 或整体写回，先把字段存进局部变量再改分量不会写回粒子。

### this.spawn(config)

`this.spawn()` 无参生成默认粒子；`this.spawn(config)` 接受一个对象字面量，字段与校验：

| 字段 | 类型 | 默认 |
| --- | --- | --- |
| `position` | vec3 或 `[x,y,z]` | `[0,0,0]` |
| `color` | color / vec3 / vec4 / `[r,g,b]` / `[r,g,b,a]` | `[1,1,1,1]` |
| `velocity` | vec3 或 `[vx,vy,vz]` | `[0,0,0]` |
| `scale` | num | `1` |
| `glow` | bool 或 num（>0.5 为真） | `false` |
| `light` | num（取整并钳制 0..15） | `0` |
| `life` | num（取整，负值视为 -1 无限） | `-1` |
| `uv` | vec2 或 `[u,v]`，写入自定义字段 `p.uv` | 无 |

config 必须是对象；未知字段报错。

### p.apply { ... }

`p.apply { ... }` 以接收者 lambda 执行块：块内 `this` 指向该粒子，裸名优先解析为粒子字段（粒子无该字段时回退外层作用域），返回该粒子。裸名写入针对已存在的粒子字段（内建或已设置的自定义字段）；给粒子新增自定义字段用 `this.foo = ...`。

```js
p.apply {
  position = vec(1, 2, 3)
  scale = 2
}
```

### 寿命

- `p.life` 为剩余毫秒数，`-1` 无限；默认 `-1`。
- 每帧按真实经过毫秒递减已入场（`time > max(spawnMs, fx.st)`）且 `life >= 0` 的粒子；剩余寿命 ≤ 经过毫秒时立即移除。
- setup 中 spawn 的粒子从 `fx.st` 开始倒计时；tick/process 中 spawn 的粒子从 spawn 时刻开始倒计时。
- `p.kill()` 立即移除（不等到帧结束）。

## 4. 值类型

`num`、`bool`、`string`、`vec2/3/4`、`mat3/4`、`color`、`array`、`obj`、`func`、`lambda`、`particle`、`particleList`、`undefined`。

- `let x;` 初始为 `undefined`；`undefined` 为假值，可 `x == undefined` 判断；参与算术/比较等运算报错。
- 没有 `null`；未声明变量、越界访问、类型错误均抛错。
- vec/mat/color 是值类型：分量赋值（`v.x = ...`）产生新值写回目标，不共享可变对象。

### lambda

- 语法：`{ body }`、`{ p1 -> body }`、`{ p1, p2 -> body }`。
- 无参 lambda 绑定隐式参数 `it`（唯一实参）；0 实参调用时访问 `it` 抛错，≥2 实参抛错。
- 显式参数列表按位置绑定，缺参为 `undefined`。
- 捕获定义处作用域链（按引用），可读写外层变量。
- 体值 = 最后一条表达式语句的值；`return expr` 立即返回；无表达式语句时返回 `undefined`。
- 尾随 lambda：`f(args) { λ }` 等价于 `f(args, λ)`（λ 追加为最后一个实参），方法调用同理。
- lambda 与 func 都可作为值传入/返回（可调用）。

### obj（JSON 对象）

- 字面量 `{ key: value, ... }`，key 为标识符或字符串，value 为任意表达式，可嵌套。
- 可变；读 `o.k` 或 `o["k"]`，写 `o.k = v` 或 `o["k"] = v`（下标键须为字符串）。
- 缺失键读 `undefined`；对象无方法。

### color

- `color(r, g, b, a)`，分量 0..1。
- 分量 `.r/.g/.b/.a` 与别名 `.x/.y/.z/.w`、`.alpha`；分量写入返回新 color 并钳制 0..1。
- 与 vec4 是不同类型：粒子颜色字段写入时两者都接受（§3）。手动转换用 `vec4(c.r, c.g, c.b, c.a)` 与 `color(v.x, v.y, v.z, v.w)`；HSV 往返用 `c.toHSV()` / `c.toRGB()`（§8）。

## 5. 词法

- 标识符：`[A-Za-z_][A-Za-z0-9_]*`。
- 数字：`123`、`1.5`、`.5`、`1e3`。
- 字符串字面量：`"..."`（转义 `\n` `\r` `\t` `\"` `\\`）。
- 注释：`//`、`/* */`。
- 关键字：`setup` `process` `tick` `func` `return` `if` `else` `while` `do` `for` `of` `const` `let` `undefined` `when` `break` `continue` `true` `false`。
- 运算符/箭头：`->`（lambda 参数箭头）。
- `static` 关键字已移除，可作普通标识符。

## 6. 语句

```text
let x = expr / let x;            // 块级局部；let x; 初始 undefined
const x = expr                   // 只读，必须带初始值
let a = 1, b = 2, c = 3          // 一条语句声明多个；const 同理，每个声明都必须带初始值
let { a, b } = expr              // 对象解构（同名取键；const { a, b } = expr 同理）
func setup() { ... }             // 对象级执行一次，无参数
func tick() { ... }              // 每 50ms 执行一次
func process() { ... }           // 每帧一次，无参数
func name(p1, p2, ...) { ... }   // 自定义函数，不可命名 setup/tick/process
return expr
if / else / while / do / for(init;cond;inc) / for (const|let|x of ...) / break / continue
when (x) { 1 -> stmt; 2 -> stmt; else -> stmt }   // 语句形式（§7）
[a, b] = expr                    // 数组/向量拆包赋值（数量须一致）
```

语句以 `;`、换行或 `}` 结尾，三者均可；`;` 仅用于同行写多条语句。多行表达式需把运算符写在行尾续行，或靠未闭合的括号续行；行首的运算符 / `(` / `[` 不续接上一行，而是开启新语句；行首的 `.` 会续接上一行的链式调用（方法链可多行）。三元 `?:` 例外，`?` 与 `:` 可置于行首续接上一行。

- 顶层（函数外）只允许 `let`/`const` 声明（含解构）与 `func` 定义；此处变量为全局，`let` 处处可写、`const` 只读。
- 赋值（`x = v`、`x += v`、`x++`）只能操作已声明变量；给未声明名赋值报错。`let`/`const` 块级作用域，同作用域重复声明报错，可遮蔽外层。
- C 风格 `for(init;cond;inc)` 中的两个 `;` 是分隔符，仍必填。`for (let i = 0; ...)` 声明块级局部变量；`for (i = 0; ...)` 的 `i` 须已声明。
- `for...of` 可迭代 `particleList` 与 `array`（迭代快照：循环内 spawn/kill 不影响本次迭代）；`const` 循环变量只读，`let` 与省略写法可写。
- 普通语句块内裸表达式语句必须是调用（call / method / 前/后置自增 / apply）；lambda 体内允许任意裸表达式语句，其值即块值。

## 7. 表达式与运算

### 优先级

从低到高：

1. 赋值 `=` `+=` `-=` `*=` `/=` `%=` `^=`（右结合）
2. 三元 `?:`
3. `||`
4. `&&`
5. `==` `!=`
6. `<` `<=` `>` `>=`
7. `+` `-`
8. `*` `/` `%`
9. 幂 `^`（右结合）
10. 一元 `-` `!` `++` `--`（前置）
11. 后缀 `()` `[]` `.` `++` `--`

一元负号高于幂：`-2^2` 按 `(-2)^2` 计算，拿不准就加括号。

### 运算

- 算术：num 的四则/取模/幂；`vec + vec`、`vec - vec`（同维）、`vec * num`、`vec * vec`（同维分量乘）、`vec / num`、`mat + mat`、`mat - mat`、`mat * mat`、`mat * vec`（`mat4 * vec3` 按仿射变换 w=1）、`mat * num`、`mat / num`；一元 `-` 对 num/vec/mat。
- 比较 `<` `<=` `>` `>=` 仅 num/bool；`==`/`!=` 精确比较（无容差），支持 num/bool/vec/mat/color/array，字符串不参与相等判定（两个字符串 `==` 也返回 false）。
- 逻辑 `&&` `||` 短路，返回操作数的值（num/bool）；`!` 要求 num/bool/undefined。
- 复合赋值 `a += b` 等价于 `a = a + b`（同样适用于向量/矩阵分量、粒子字段、数组下标等可赋值目标）。

### when

- 表达式形式：`when (subject) { label -> expr; else -> expr }`，值为命中 case 或 else 的表达式；必须含 else。
- 语句形式：`when (subject) { label -> stmt; else -> stmt }`，命中即执行该语句；无 fallthrough；无 else 且无命中则跳过。
- 匹配：case 标签为表达式，逐个求值并与 subject 比较；数值/向量/矩阵/颜色/数组按 1e-6 容差，bool/字符串精确比较。

```js
let c = when(x) { 0 -> color(1,0,0,1); 1 -> color(0,1,0,1); else -> color(1,1,1,1) }
```

### 方法链

变换与分量调整统一用链式方法调用，`.` 前可换行：

```js
vec(1, 0, 0).rotateZ(PI / 2).rotateX(PI / 2)
color(1, 0, 0, 1).red(0.25).alpha(0.5)
```

### vec 实例方法

全部返回新值，不改原值；参数须同维（`cross` 仅 vec3）：

- `v.normalize()`：归一化；零向量抛错。
- `v.dot(w)`
- `v.cross(w)`（仅 vec3）
- `v.len()`、`v.len2()`
- `v.dist(w)`
- `v.angleTo(w)`
- `v.project(w)`：投影到 w；w 为零向量抛错。
- `v.reflect(n)`：`v - 2*dot(v,n)*n`。
- `v.lerp(w, t)`
- `v.rotateX(a)` / `v.rotateY(a)` / `v.rotateZ(a)`：仅 vec3，绕轴旋转。
- `v.translate(...)`：按维数平移（vec2 两参、vec3 三参、vec4 四参）。
- `v.scale(s)` / `v.scale(w)`：标量或同维向量缩放。

旧的全局 `dot`/`cross`/`len`/`len2`/`norm(v)`/`lerp`/`mix`/`distance`/`angle_between`/`project`/`reflect` 已删除，改用上述实例方法；`norm` 现为标量函数（§8）。

## 8. 内建函数

按包分组，默认全部可见：

### vec

- `vec2(x,y)`、`vec3(x,y,z)`、`vec4(x,y,z,w)`、`vec(x,y,z)`（等价 vec3）
- `mat3(r0,r1,r2)`：三个 vec3 行向量；`mat4(r0,r1,r2,r3)`：四个 vec4 行向量
- 矩阵乘法 `mat * mat`、`mat * vec`（§7）；旋转/平移/缩放用 vec 实例方法（§7）

### math

- `sin` `cos` `tan` `asin` `acos` `atan` `atan2(y,x)`
- `sqrt` `abs` `sign` `exp` `log` `ln`（`log` 与 `ln` 都是自然对数）
- `floor` `ceil` `round` `fract` `pow(x,y)` `min(a,b)` `max(a,b)`
- `step(edge,x)`、`smoothstep(e0,e1,x)`
- `mod(a,b)`（取模，结果非负）
- `clamp(x,lo,hi)`（x 可为向量，lo/hi 可为标量或同维向量）、`map_range`、`remap`（结果再钳制到输出范围）
- `int(v)`（截断取整，对向量/矩阵逐分量）、`float(v)`、`bool(v)`（非零为 true）
- `norm(a,b)` = `a / max(b-1, 1)`；a、b 为非负整数
- `hash(seed, salt)`：MurmurHash3 终结器，返回 [0,1)；seed/salt 为 32 位整数

### noise

- `noise(x, y, z [, seed])`：3D Simplex，范围约 [-1, 1]；不传 seed 用 `fx.seed`
- `fbm(x, y, z, octaves [, seed])`：分形布朗运动，[-1, 1]；octaves ≥ 1
- `rand()`：对象级 PRNG 序列（同一工程每次播放一致）
- `rand(seed)`：确定性，`mulberry32(seed|0)` 的下一个值
- `random()`：非确定性（每次不同）

### ease

- `ease_linear(a,b,t)`、`ease_in_out(a,b,t)`、`ease_out_back(a,b,t)`、`ease_in_elastic(a,b,t)`（`a` 到 `b`，`t` 为 0..1 进度）

### collection

- `phases(t, { k: [a,b], ... })`：逐键计算 `smoothstep`，进度 `(t-a)/(b-a)` 钳制到 0..1，返回 obj
- `repeat(count, fn)`：count 截断为整数，按下标 i 调用 fn（0..count-1），返回 0
- `unique(arr)`（返回新数组）、`reverse(arr)`（原地并返回）、`sort(arr [, cmpFunc])`

### color

- `color(r,g,b,a)`
- `c.toRGB()` → `{ r, g, b, a }`；`c.toHSV()` → `{ h, s, v }`
- 分量方法无参=读、带参=写（返回新 color，钳制 0..1）：`c.red()` / `c.red(v)`、`c.green()`、`c.blue()`、`c.alpha()`
- HSV 方法：`c.hue()` / `c.hue(h)`、`c.saturation()` / `c.saturation(s)`、`c.value()` / `c.value(v)`、`c.shift_hue(d)`（色相偏移并循环）

### debug

- `print(...)`：输出到编辑器终端；`assert(cond, "msg")`

## 9. 数组方法

`arr.push(v)`、`arr.insert(i, v)`、`arr.remove(i)`、`arr.slice([start [, end]])`、
`arr.size()`、`arr.find(v)`（返回下标或 -1）、`arr.includes(v)`、
`arr.sort([cmpFunc])`、`arr.unique()`、`arr.reverse()`。

`particleList` 只有 `.size()`、`for...of`、`[i]` 下标。

`find`/`includes`/`unique` 的相等判定按 1e-6 容差（数值/向量/矩阵/颜色分量）。

## 10. 常量

`PI`、`E`、`TAU`（2π）、`HALF_PI`、`QUARTER_PI`、`DEG2RAD`、`RAD2DEG`。`PI`/`E` 在词法层直接作为数值字面量。

## 11. 外部变量（fx.vars）

函数对象可声明外部变量，按变量名只读注入脚本（num 类型，含 `base` 基础值与 `kf` 关键帧列表）。脚本直接按变量名使用，不要用 `fx.vars.xxx` 访问。

## 12. 确定性与性能建议

- 需要「每次播放结果一致」时用 `rand()` / `rand(seed)` / `noise` / `fbm`；不要用 `random()`。
- `setup` 只 spawn 一次；`process` 每帧逐粒子执行，保持 O(粒子数)，不要在 process 里做全列表扫描嵌套。
- 大量粒子时避免在每帧 / 每粒子路径里分配大数组或反复解析字符串。
- 粒子在 XZ 平面、间距单位常以 block 计（1 block = 1 单位）。

## 13. 错误处理

解析错误与运行时错误抛 `Error`（消息含行列号）。编辑器的函数对象求值路径会捕获运行时错误并记录到 `fx._error`，回退到粒子已存储值；播放器端保证同语义或安全失败。

## 14. 旧版兼容

旧 `setup {}` / `process {}` 块语法、`this.count/index/delta/uv`、`this.position` 等输出字段、`static` 关键字、`fx.count/fx.step`、tick 单位（20 tick/秒）均不再支持。`.pdraw ≤ v13`、`.pdrawc ≤ v13` 拒绝加载。