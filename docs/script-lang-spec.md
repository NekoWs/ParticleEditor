# 函数对象脚本语言规范

本规范是编辑器（particle-editor，JavaScript）与播放器（ParticleDrawing，Kotlin）共同遵守的唯一语言语义来源。

## 1. 生命周期与数据模型

每个函数对象 `fx` 包含一段完整脚本源码与一个种子：

- `fx.source`：完整脚本源码（顶层 `func` 定义；`setup`/`tick`/`process` 为保留入口函数）。
- `fx.seed`：整数，默认 `0`。用于未显式传种子的随机/噪声函数。
- 顶层允许 `func` 定义与 `let`/`const` 全局声明；`setup` / `tick` / `process` 为保留函数名，其它自定义函数不可使用。
- 顶层初始化按源码顺序、每次重建运行时执行一次（先于 setup）；引用靠后声明的全局名报错（TDZ）。顶层初始化不能用 `this`。

调度顺序：每帧先按经过毫秒连续递减寿命，补跑该帧内到期的 `tick()`（每 50ms 一次，边界为绝对毫秒的 50 倍数且 ≥ `fx.st`），再跑一次 `process()`。

工程格式为 `.pdraw v14`、`.pdrawc v13`；旧版本一律拒绝打开，不自动迁移。

## 2. `this` 上下文

三阶段通用只读字段（时间单位均为毫秒）：

- `this.time`：对象本地时间 = 绝对播放毫秒 − `fx.st`；`setup()` 中为 `0`，范围 0..`this.duration`。
- `this.duration`：函数对象自身时长 `fx.duration`（毫秒）；`fx.duration ≤ 0`（无上限）时回退为整个动画总长 `maxMs`。
- `this.animTime`：整个动画的全局播放毫秒（绝对时间轴位置，0 起）。
- `this.particles`：当前函数对象的粒子列表（`particleList`，可 `for...of`、`[i]` 下标、`.size()`）。
- `this.spawn()`：创建并返回一个新 `particle`，立即加入列表。
- `fx.vars` 中的变量：只读注入（按变量名）。

`this` 本身不是值；单独使用 `this` 抛错。

## 3. particle 类型

`this.spawn()` 返回 `particle` 句柄，属性：

- 可写内建：`position`(vec3)、`color`(vec4)、`velocity`(vec3)、`scale`(num)、`glow`(bool)、`light`(0..15)、`life`(num)。
- 只读：`index`（本函数对象内单调递增的 spawn 序号，不复用）。
- 任意自定义字段：`p.foo = value` 即存即取；未设置的字段读 `undefined`。
- 分量别名（`x/y/z/w/r/g/b/a`）仅对向量有效；写在 `particle` 上时按自定义字段存取（如 `p.a = 1` 写入自定义字段 `a`）。颜色/位置分量须写 `p.color.a`、`p.position.x` 等。
- 方法：`p.kill()`，立即从列表移除。
- 无 `uv` 字段。

### 寿命

- `p.life` 为剩余毫秒数，`-1` 无限；默认 `-1`。
- 每帧按真实经过毫秒递减已入场（`time > max(spawnMs, fx.st)`）且 `life >= 0` 的粒子；剩余寿命 ≤ 经过毫秒时立即移除。
- setup 中 spawn 的粒子从 `fx.st` 开始倒计时；tick/process 中 spawn 的粒子从 spawn 时刻开始倒计时。
- `p.kill()` 立即移除（不等到帧结束）。

## 4. 值类型

- `num`、`bool`、`vec2/3/4`、`mat3/4`、`array`、`func`、`particle`、`particleList`、`undefined`。
- `let x;` 初始为 `undefined`；`undefined` 为假值，可 `x == undefined` 判断；参与算术/比较等运算报错。
- 未声明变量、越界访问、类型错误均抛错。

## 5. 词法

- 标识符：`[A-Za-z_][A-Za-z0-9_]*`。
- 数字：`123`、`1.5`、`.5`、`1e3`。
- 字符串字面量：`"..."`。
- 注释：`//`、`/* */`。
- 关键字：`setup` `process` `tick` `func` `return` `if` `else` `while` `do` `for` `of` `const` `let` `undefined` `break` `continue` `true` `false`。
- `static` 关键字已移除，可作为普通标识符。

## 6. 语句

```text
let x = expr / let x;          // 声明局部变量（块级作用域；let x; 初始 undefined）
const x = expr                 // 声明只读变量（必须带初始值；重新赋值报错）
func setup() { ... }
func tick() { ... }            // 每 50ms 执行一次（绝对毫秒 50 倍数且 ≥ fx.st）
func process() { ... }          // 每帧一次，不接受参数
func name(p1, p2, ...) { ... }  // 自定义函数，不可命名 setup/tick/process
return expr
if / else / while / do / for(init;cond;inc) / for (const x of ...) / for (let x of ...) / for (x of ...) / break / continue
```

语句以 `;`、换行或 `}` 结尾，三者均可；`;` 可省略，仅用于同行写多条语句。多行表达式需把运算符写在行尾续行，或靠未闭合的括号续行；行首的运算符 / `.` / `(` / `[` 不续接上一行，而是开启新语句。三元 `?:` 例外，`?` 与 `:` 可置于行首续接上一行。C 风格 `for(init;cond;inc)` 中的两个 `;` 是分隔符，仍必填。`for (let i = 0; ...)` 声明块级局部变量。赋值（`x = v`、`x += v`、`x++`）只能操作已声明变量；给未声明名赋值报错。`for-of` 的 `const` 循环变量只读，`let` 与省略写法可写。

## 7. 表达式与运算

与旧版一致：算术、比较、逻辑短路、三元、向量/矩阵运算、内建数学/噪声/PRNG 函数、数组方法与下标。`for...of` 可迭代 `particleList` 与 `array`（迭代快照：循环内 spawn/kill 不影响本次迭代）。`for...of` 的循环变量 `const` 可省略，两种写法等价，循环变量始终是循环体作用域内的新局部变量。

复合赋值：`+=` `-=` `*=` `/=` `%=` `^=`，`a += b` 等价于 `a = a + b`（同样适用于向量/矩阵与分量、粒子字段、数组下标等可赋值目标）。

常量：`PI`、`E`、`TAU`、`HALF_PI`、`QUARTER_PI`、`DEG2RAD`、`RAD2DEG`，为数值字面量保留名。

## 8. 错误处理

解析错误与运行时错误抛 `Error`（消息含行列号）。编辑器的函数对象求值路径会捕获运行时错误并记录到 `fx._error`，回退到粒子已存储值；播放器端保证同语义或安全失败。

## 9. 旧版兼容

旧 `setup {}` / `process {}` 块语法、`this.count/index/delta/uv`、`this.position` 等输出字段、`static` 关键字、`fx.count/fx.step`、tick 单位（20 tick/秒）均不再支持。`.pdraw ≤ v13`、`.pdrawc ≤ v12` 拒绝加载。