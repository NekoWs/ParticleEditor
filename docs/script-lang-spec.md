# 函数对象脚本语言规范（v12：spawn 模型）

本规范是编辑器（particle-editor，JavaScript）与播放器（ParticleDrawing，Kotlin）共同遵守的唯一语言语义来源。

## 1. 生命周期与数据模型

每个函数对象 `fx` 包含一段完整脚本源码与一个种子：

- `fx.source`：完整脚本源码（顶层 `func` 定义；`setup`/`tick`/`process` 为保留入口函数）。
- `fx.seed`：整数，默认 `0`。用于未显式传种子的随机/噪声函数。
- 顶层只允许 `func` 定义；`setup` / `tick` / `process` 为保留函数名，其它自定义函数不可使用。

调度顺序：每帧先补跑该帧内所有到期的 `tick()`，再跑一次 `process(deltaMs)`；`scrub` / `seek` / 回绕 / 加载后首次 process 的 `deltaMs = 0`。播放时 `deltaMs` 为动画时间毫秒（编辑器为 `真实帧毫秒 × playSpeed`；播放器为真实帧间隔）。

工程格式为 `.pdraw v12`、`.pdrawc v11`；旧版本一律拒绝打开，不自动迁移。

## 2. `this` 上下文

三阶段通用只读字段：

- `this.time`：当前时间（tick；setup 中为 `fx.st`）。
- `this.duration`：动画总时长（tick）。
- `this.particles`：当前函数对象的粒子列表（`particleList`，可 `for...of`、`[i]` 下标、`.size()`）。
- `this.spawn()`：创建并返回一个新 `particle`，立即加入列表。
- `fx.vars` 中的变量：只读注入（按变量名）。

`this` 本身不是值；单独使用 `this` 抛错。旧 `this.count / this.index / this.delta / this.uv` 与旧输出字段（`this.position` 等）已移除。

## 3. particle 类型

`this.spawn()` 返回 `particle` 句柄，属性：

- 可写内建：`position`(vec3)、`color`(vec4)、`velocity`(vec3)、`scale`(num)、`glow`(bool)、`light`(0..15)、`life`(num)。
- 只读：`index`（本函数对象内单调递增的 spawn 序号，不复用）。
- 任意自定义字段：`p.foo = value` 即存即取；未设置的字段读 `0`。
- 方法：`p.kill()`，立即从列表移除。
- 无 `uv` 字段。

### 寿命

- `p.life` 为剩余 tick 数，`-1` 无限；默认 `-1`。
- 每个 tick 开始前，对 `life >= 0` 且已入场（`tick > max(spawnTick, fx.st)`）的粒子递减；`life <= 1` 时立即移除。
- setup 中 spawn 的粒子从 `fx.st` 开始倒计时；tick/process 中 spawn 的粒子从 spawn 所在 tick 开始倒计时。
- `p.kill()` 立即移除（不等到 tick 结束）。

## 4. 值类型

- `num`、`bool`、`vec2/3/4`、`mat3/4`、`array`、`func`。
- 新增 `particle`、`particleList`。
- 无 `null`；未定义变量、越界访问、类型错误均抛错。

## 5. 词法

- 标识符：`[A-Za-z_][A-Za-z0-9_]*`。
- 数字：`123`、`1.5`、`.5`、`1e3`。
- 字符串字面量：`"..."`。
- 注释：`//`、`/* */`。
- 关键字：`setup` `process` `tick` `func` `return` `if` `else` `while` `do` `for` `of` `const` `break` `continue` `global` `true` `false`。
- `static` 关键字已移除，可作为普通标识符。

## 6. 语句

```text
func setup() { ... }
func tick() { ... }
func process(delta) { ... }     // 参数名可自定义，恰好一个
func name(p1, p2, ...) { ... }  // 自定义函数，不可命名 setup/tick/process
return expr;
if / else / while / do / for(init;cond;inc) / for (const x of collection) / break / continue
global name = expr;             // 仅 setup 顶层可写；tick/process/函数内只读
```

## 7. 表达式与运算

与旧版一致：算术、比较、逻辑短路、三元、向量/矩阵运算、内建数学/噪声/PRNG 函数、数组方法与下标。`for...of` 可迭代 `particleList` 与 `array`（迭代快照：循环内 spawn/kill 不影响本次迭代）。

## 8. 错误处理

解析错误与运行时错误抛 `Error`（消息含行列号）。编辑器的函数对象求值路径会捕获运行时错误并记录到 `fx._error`，回退到粒子已存储值；播放器端保证同语义或安全失败。

## 9. 旧版兼容

旧 `setup {}` / `process {}` 块语法、`this.count/index/delta/uv`、`this.position` 等输出字段、`static` 关键字、`fx.count/fx.step` 均不再支持。`.pdraw ≤ v11`、`.pdrawc ≤ v10` 拒绝加载。