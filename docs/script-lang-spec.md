# 函数对象脚本语言规范（setup / process）

本规范是编辑器（particle-editor，JavaScript）与播放器（ParticleDrawing，Kotlin）共同遵守的唯一语言语义来源。
两端实现必须对同一脚本产生一致结果；`docs/conformance/` 下的样例用于双端对拍。

## 1. 阶段与数据模型

每个函数对象 `fx` 包含两段脚本与一个种子：

- `fx.setup`：对象初始化时执行一次（对象级）。
- `fx.process`：每个粒子、每个求值时间点执行一次（粒子级）。
- `fx.seed`：整数，默认 `0`。用于未显式传种子的随机/噪声函数。

旧 `fx.code` 不再存在。工程格式为 `.pdraw v10`、`.pdrawc v9`；旧版本一律拒绝打开。

### setup 环境（对象级）
Context 只读字段：

- `Context.count`：粒子总数（`fx.count`，最小 1）。
- `Context.time`：当前时间（tick）。
- `fx.vars` 中的变量：只读注入（按变量名）。

不可访问：`Context.index`、`Context.delta`、`Context.uv`、`Context.life`，以及所有输出字段（见 §8）。

### process 环境（粒子级）
Context 只读字段：

- `Context.index`：粒子序号（`0 .. count-1`）。
- `Context.count`：粒子总数。
- `Context.time`：当前时间（tick）。
- `Context.delta`：距上次求值经过的秒数。连续播放时由帧/步进间隔提供；`seek`、循环回绕、加载后首次求值为 `0`。
- `Context.uv`：`vec2(uv_x, uv_y)`，见 §9。
- `Context` 输出字段读写：`position / color / velocity / scale / glow / light / life`（见 §8）。
- `fx.vars` 中的变量：只读注入。

`Context` 本身不是值；单独使用 `Context`（例如 `x = Context;`）抛错。

## 2. 值类型

- `num`：双精度浮点。
- `bool`：`true` / `false`。
- `vec2`：`(x,y)`。
- `vec3`：`(x,y,z)`。
- `vec4`：`(x,y,z,w)`。
- `mat3`：3×3 行主序。
- `mat4`：4×4 行主序。
- `array`：动态数组，元素可为任意类型，可嵌套。
- `func`：用户函数值（闭包）。

无 `null`；未定义变量、越界访问、类型错误均抛错。

## 3. 词法

- 标识符：`[A-Za-z_][A-Za-z0-9_]*`。
- 数字：`123`、`1.5`、`.5`、`1e3`（支持负号）。
- 字符串字面量：`"..."`（用于 `print` / `assert` 消息）。
- 注释：`// 行注释`、`/* 块注释 */`。
- 关键字：`setup` `process` `func` `return` `if` `else` `while` `do` `for` `break` `continue` `global` `static` `true` `false`。
- 唯一保留上下文标识符：`Context`（不能作为变量/函数名/参数/global/static 名）。
- 运算符与分隔符：`+ - * / % ^ == != < <= > >= && || ! ? : = ( ) [ ] { } , ; .`
- 分号：语句以 `;` 结束（`{}` 块后无分号）。

## 4. 语句

```text
setup { <statements> }
process { <statements> }

func name(p1, p2, ...) { <statements> }        // 仅顶层；支持递归；两阶段均可调用
return expr;                                   // 仅函数体内
if (cond) { ... } else if (cond) { ... } else { ... }
while (cond) { ... }
do { ... } while (cond);
for (init; cond; inc) { ... }
break;
continue;

// 赋值
name = expr;                    // 普通变量 / global / static
arr[idx] = expr;
[a,b,c] = expr;                 // expr 为 vecN 或等长数组时拆包（名称必须为标识符）
[a,b,c] = [e1,e2,e3];           // 打包赋值（逐项求值）
vec.x = expr;                   // 向量分量写入（分量必须为左值）

// Context 输出字段（仅 process）
Context.position = vec3 | [x,y,z];
Context.velocity = vec3 | [vx,vy,vz];
Context.color    = vec3 | vec4 | [r,g,b] | [r,g,b,a];
Context.scale    = num;
Context.glow     = num | bool;
Context.light    = num;
Context.life     = num;                     // 寿命（tick；<0 视为 -1=无限）
Context.position.x = num;       // 分量写入（velocity/color 同理）

// 声明（作用域见 §6）
global name = expr;             // setup 中；对象级共享，process 只读
global name;                    // 等价 global name = 0;
static name = expr;             // process 中；每粒子独立，首次执行初始化一次
static name;                    // 等价 static name = 0;

// 表达式语句
expr;                           // 仅允许函数调用等有副作用的表达式
print(expr1, expr2, ...);       // 仅 setup；输出到控制台/日志
assert(cond, "msg");            // 仅 setup；cond 为 false 时抛错
```

`setup`/`process` 区块本身不是普通语句，只允许出现在脚本顶层。

## 5. 表达式

优先级由低到高：

1. 赋值 `=`（右结合，仅出现在语句层）
2. 三元 `cond ? a : b`（右结合，短路）
3. `||`
4. `&&`
5. 相等 `==` `!=`
6. 比较 `<` `<=` `>` `>=`
7. 加/减 `+` `-`
8. 乘/除/模 `*` `/` `%`
9. 幂 `^`
10. 一元 `-` `!`
11. 后缀：`f(args)`、`arr[idx]`、`.x` `.y` `.z` `.w` `.r` `.g` `.b` `.a`、`Context.<field>`
12. 主：字面量、标识符、数组字面量、`(...)`

数组字面量：`[e1, e2, ...]`、`[]`。

三元条件规则：`false`、数值 `0` 视为假；`true`、非零数值视为真；其他类型在条件位置报错。

分量别名：`r/g/b` 分别是 `x/y/z` 的别名，`a` 是 `w` 的别名。

## 6. 作用域与生命周期

- `global`：仅在 `setup` 顶层/块内声明；存入对象级环境；`process` 只读。
- `static`：仅在 `process` 内声明；每个粒子独立一份；首次执行时初始化，此后跨帧保持；仅在函数对象加载/重建时重置（`seek`/循环回绕不重置，此时 `delta=0`）。
- 普通变量：`setup`/`process` 内为块级作用域；函数参数与函数内普通变量为函数局部作用域；内部块可读外层变量。
- `fx.vars`：只读注入，脚本不能对其赋值。
- 函数可读外层 `global` 与调用点可见的 Context 字段；函数不捕获普通局部变量（按值传参）。

### 6.1 名称遮蔽与保留字

- **函数名可作为普通变量名**（含内建函数名与用户函数名）：`sin = 3; Context.position.x = sin;` 合法，
  值位置按普通变量查找（局部 → global → static → vars → 常量 → 函数值）。
  只有 `name(...)` 调用位置才把该名字解析为函数调用（内建函数优先于用户函数），
  即调用位置不受同名变量遮蔽。
- **`Context` 是唯一保留上下文标识符**：不能作为变量/函数名/参数/global/static 名。
  旧的 `i/idx/n/t/dt/uv_x/uv_y/life` 与 `x/y/z/r/g/b/a/vx/vy/vz/sc/glow/light`
  不再是保留字，均可作为普通变量名。
- `Context` 字段不受同名 global/变量遮蔽：`Context.count` 始终读粒子总数，
  `Context.position` 始终读写当前粒子输出。
- 关键字与常量名（`TAU`、`HALF_PI` 等）仍不可作为变量名。

## 7. 类型与运算

### 算术
- `num op num`：常规标量运算；`/` 除零报错。
- `vec2/vec3/vec4 + / -`：逐分量。
- `vec * scalar`、`scalar * vec`、`vec / scalar`：逐分量缩放。
- `vec * vec`：逐分量乘（Hadamard）。
- `mat + / -`：逐元素。
- `mat * scalar`、`scalar * mat`、`mat / scalar`：逐元素。
- `mat * vec`：矩阵乘向量；`mat3 * vec3`、`mat4 * vec3`（仿射，w=1）、`mat4 * vec4`（完整 4x4）。
- `mat3 * mat3`、`mat4 * mat4`：矩阵乘法（维度必须匹配）。
- `-vec`、`-mat`：取负。
- `^`：仅标量幂。

### 比较与逻辑
- `num` 比较、`bool` 比较。
- `vec2/vec3/vec4 ==/!=`：逐分量比较（无容差）返回 bool。
- `mat ==/!=`：逐元素比较。
- 数组 `==/!=`：长度相同且逐元素按各自类型相等规则比较。
- `&&` / `||` / `!`：仅接受标量/布尔；短路求值。

## 8. Context 输出字段（粒子属性）

process 中读写以下字段即读写当前粒子输出：

- `Context.position`：位置（世界坐标，随后叠加对象中心 `fx.center`）。vec3。
- `Context.color`：颜色，各分量钳制到 `[0,1]`。vec4；`Context.color = vec3(r,g,b)` 只改 RGB、alpha 保留，`vec4(r,g,b,a)` 改 RGBA。
- `Context.velocity`：速度。vec3。
- `Context.scale`：缩放。标量。
- `Context.glow`：读为 bool；写接受 num/bool，`>0.5` 视为 true。
- `Context.light`：整数，钳制到 `[0,15]`。
- `Context.life`：寿命（tick）。读为当前粒子寿命（默认 `-1` = 无限）；写接受 num，`Math.round` 取整，负值与非有限值视为 `-1`（无限）。`T - fx.st >= life` 时粒子隐藏。

输出字段仅在 `process` 可写；`setup` 中访问任何输出字段报错。

## 9. Context 只读字段

- `Context.index`：粒子序号（`0 .. count-1`）。
- `Context.count`：粒子总数。
- `Context.time`：tick。
- `Context.delta`：秒。
- `Context.uv`：把 `count` 个粒子按列优先平铺到近正方形网格，返回 `vec2(uv_x, uv_y)`。
  - `C = grid_cols`；若 `fx.vars` 中存在名为 `grid_cols` 的变量，用其 `base`，否则 `C = ceil(sqrt(count))`。
  - `R = ceil(count / C)`；`col = index % C`；`row = floor(index / C)`。
  - `uv.x = (C == 1) ? 0 : col / (C - 1)`。
  - `uv.y = (R == 1) ? 0 : row / (R - 1)`。

`setup` 中仅 `Context.count` / `Context.time` 可用；其余字段报错。

## 10. 数组

- `[]` 空数组；`[e1, e2, ...]` 数组字面量。
- `arr[idx]` 读取；`arr[idx] = val` 写入。
- `arr.push(v)`：末尾追加；原地修改，返回该数组。
- `arr.insert(idx, v)`：指定位置插入；原地修改，返回该数组。
- `arr.remove(idx)`：删除指定位置；原地修改，返回该数组。
- `arr.slice(start, end)`：返回新数组；`start` 含、`end` 不含；负下标从末尾计数；越界自动钳制到 `[0, size]`。
- `arr.size()` 或 `len(arr)`：长度。
- `arr.find(v)`：首次出现的下标，不存在返回 `-1`。
- `arr.includes(v)`：是否包含。
- `arr.sort()`：原地升序排序，返回该数组；比较规则见 §11。
- `arr.sort(cmp)`：`cmp` 为顶层函数名，`cmp(a,b)` 返回负数/零/正数。
- `arr.unique()`：返回去重后的新数组。
- `arr.reverse()`：原地反转，返回该数组。
- 越界访问/`insert`/`remove` 一律抛错。
- 相等比较（`find/includes/unique`）：数值与向量/矩阵分量按 `1e-6` 容差；布尔精确；数组递归比较。

## 11. 排序比较

- 标量：数值/布尔直接升序。
- `vec2`/`vec3`/`vec4`：按分量逐级字典序。
- `mat3`/`mat4`：按行主序元素逐级字典序。
- 嵌套数组：逐元素递归字典序。
- **严格禁止混合类型比较**：一旦检测到两个元素类型不同，直接抛错。

## 12. 内建函数

### 向量/矩阵构造与变换
- `vec2(x,y)`；`vec3(x,y,z)`；`vec4(x,y,z,w)`。
- `mat3(row0,row1,row2)`：三个 `vec3` 行向量。
- `translate(v)`：返回 `mat4` 平移矩阵。
- `scale(s)` / `scale(x,y,z)` / `scale(v)`：返回 `mat4` 缩放矩阵。
- `rotate(axis, angle)`：绕单位轴 `axis` 旋转 `angle` 弧度，返回 `mat4`。
- `lookAt(eye, target, up)`：标准 view 观察矩阵，返回 `mat4`。
- `rotX(a)/rotY(a)/rotZ(a)/rotAxis(axis,a)`：保留，返回 `mat3`。

### 向量函数
- `dot(a,b)`；`cross(a,b)`（仅 vec3）；`len(v)`；`len2(v)`；`norm(v)`。
- `lerp(a,b,t)` / `mix(a,b,t)`：标量或向量。
- `distance(a,b)`；`angle_between(a,b)`；`project(a,b)`；`reflect(v,n)`。
- 上述向量函数对 `vec2`/`vec3`/`vec4` 均适用（`cross` 除外）。

### 数学与钳制
- `clamp(v, lo, hi)`：标量或向量逐分量；`lo/hi` 可为标量或同维向量。
- `map_range(val, in1, in2, out1, out2)`。
- `remap(val, in_min, in_max, out_min, out_max)`：同 map_range，但输出钳制到 `[out_min, out_max]`。
- `int(x)`：截断取整；向量/矩阵逐分量返回同类型。
- `float(x)`：转浮点；向量/矩阵逐分量返回同类型。
- `bool(x)`：仅标量；非零为 true。
- 已有标量数学函数：`sin cos tan asin acos atan atan2 sqrt abs sign exp log ln floor ceil round fract pow min max step smoothstep mod`。

### 噪声与随机
- `noise(x,y,z)`：3D Simplex，范围约 `[-1,1]`；使用 `fx.seed`。
- `noise(x,y,z,seed)`：显式 seed。
- `fbm(x,y,z,octaves)`：使用 `fx.seed`；`fbm(x,y,z,octaves,seed)`：显式 seed。
- `rand()`：使用 `fx.seed` 的确定性 PRNG，返回 `[0,1)`。
- `rand(seed)`：显式 seed。
- `random()`：非确定随机（编辑器与播放器不保证一致）。
- 种子解析：整数截断；PRNG 与 Simplex 噪声两端算法一致（见实现约定：采用同一梯度表与排列表）。

### 缓动
- `ease_linear(a,b,t)` = `a + (b-a)*t`。
- `ease_in_out(a,b,t)` = smoothstep：`t' = clamp(t,0,1)`，`a + (b-a) * t'^2 * (3 - 2*t')`。
- `ease_out_back(a,b,t)`：`t' = clamp(t,0,1)`，`c1 = 1.70158`，`s = 1 + c1`，`a + (b-a) * (1 + s*(t'-1)^3 + c1*(t'-1)^2)` 变体：`a + (b-a) * (1 + (c1+1)*(t'-1)^3 + c1*(t'-1)^2)`。
- `ease_in_elastic(a,b,t)`：`t' = clamp(t,0,1)`；`t'==0 → 0`，`t'==1 → 1`，否则 `-2^(10*(t'-1)) * sin((t'*10 - 10.75) * (2*pi)/3)` 映射到 `[a,b]`。

### 集合
- `unique(arr)`：返回去重新数组。
- `reverse(arr)`：原地反转，返回数组。
- `sort(arr[, cmp])`：见 §11。
- `len(arr)`：同 `arr.size()`。

### 调试（仅 setup）
- `print(expr1, ...)`。
- `assert(cond, "msg")`。

### 快速标量数学近似（`fx.fastMath`，可选）
- 函数对象 `fx.fastMath = true` 时，**仅 `process`** 中的下列内建标量函数改用快速近似实现：
  `sin cos tan asin acos atan atan2 exp log ln pow`。
- 精度目标：`sin/cos/tan` 最大绝对误差 ≤ 1e-4；`asin/acos/atan/atan2/exp/log/ln/pow` 相对误差 ≤ 1e-4。
- `setup` 与 `fx.fastMath = false` 时仍用精确实现；`sqrt` 保持原生；
  内部矩阵/缓动函数（`rotX/rotZ/ease_*` 等）实现里的三角运算不切换。
- 两端（编辑器 JS 与播放器 Kotlin）使用同一套公式与运算顺序，保证逐位一致。
- 默认关闭（`.pdraw` 函数对象缺省 `fm` / `.pdrawc` 函数 flags bit2 为 0）。

## 13. 常量

- `TAU` = `2 * pi`
- `HALF_PI` = `pi / 2`
- `QUARTER_PI` = `pi / 4`
- `DEG2RAD` = `pi / 180`
- `RAD2DEG` = `180 / pi`
- `pi`、`e` 作为数值字面量保留。

## 14. 错误与防护

- 未知变量、类型错误、数组越界、`assert` 失败、混合类型排序 → 抛错。
- 编辑器：错误弹窗提示；播放器：记录日志并跳过该函数对象。
- 单次循环语句最大迭代次数：`100000`。
- 函数最大递归深度：`64`。
- 超出限制抛错。

## 15. 执行顺序

1. 解析脚本为 AST。
2. 对每个函数对象加载/重建：执行 `setup` 一次，得到对象级环境（global、数组等）。
3. 对每个粒子、每个 tick：
   - 若为连续播放：`delta = 距上次求值秒数`；若为 seek/循环回绕/首次：`delta = 0`。
   - 以该粒子独立 static 状态执行 `process`。
4. 编辑器通过按 tick 采样 `process` 生成派生轨道用于预览与导出；采样步长 `delta` 取采样间隔（秒）。