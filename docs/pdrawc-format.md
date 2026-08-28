# `.pdrawc` 播放文件规范（二进制）

`.pdrawc` 是 **ParticleDrawing 粒子动画编辑器** 导出的**仅供播放**的二进制动画文件，
由 NeoForge 模组 `ParticleDrawing` 读取并播放。它由可编辑工程 `.pdraw`（见
[`docs/pdraw-format.md`](./pdraw-format.md)）通过「导出动画」生成。

- **二进制**，自包含（贴图像素内嵌）。
- **最紧凑**：整型用 LEB128 varint，浮点用 float32，颜色用 0..255 字节，对象引用全部用索引。
- **带 Ed25519 签名**：文件内嵌 32 字节公钥，末尾 64 字节签名；播放端验签失败**拒绝播放**。
  - 信任模型为**完整性校验**（防意外损坏/被动篡改）；内嵌公钥不防「公钥与签名被一起替换」。

---

## 1. 总体布局

所有多字节整数均为 **little-endian**。

```
+--------------------+
| magic     4 bytes  |  ASCII "PDC1" = 0x50 0x44 0x43 0x31
| version   varint   |  2（当前）；1 = 旧版未压缩 body
| pubkey    32 bytes |  Ed25519 公钥（原始字节）
+--------------------+
| body（见 §2）      |  ← 签名覆盖范围：从 magic 到压缩 body 末尾
|  (raw DEFLATE)     |
+--------------------+
| signature 64 bytes |  Ed25519 签名
+--------------------+
```

**版本**：
- `v2`（当前）：`body` 为 **raw DEFLATE**（RFC 1951，无 zlib/gzip 头尾）压缩后的字节。
- `v1`（旧版）：`body` 为未压缩字节，读取端仍兼容。

**签名** = Ed25519 对「从 `magic` 起，到压缩 body 末尾为止」的全部字节做签名；
即**整个文件去掉末尾 64 字节签名**。验签用文件内嵌公钥，**先验签再解压**。

---

## 2. body 布局

> v2 中以下 section 描述的是 **解压后的 body**。编码时先按本节序列化为字节，再用 raw DEFLATE 压缩。

按顺序写入以下 section：

```
loop                         1 byte（0/1）
texture 表                   贴图名与 PNG 字节
particles                    独立粒子（不含派生粒子）
groups                       组（成员引用粒子索引）
groupUV                      组级 UV（引用组索引）
functions                    函数对象定义
tracks                       分量级轨道
```

### 2.1 texture 表

```
count                       varint
count × {
  nameLen                   varint
  name                      nameLen 字节 UTF-8
  pngLen                    varint
  png                       pngLen 字节 PNG 图像
}
```

贴图名是唯一的字符串来源；后续 UV 通过**贴图索引**（0-based）引用。

### 2.2 particles

```
count                       varint
count × {
  color                     4 bytes：R,G,B,A（0..255）
  scale                     3 × float32：[sx,sy,sz]
  flags                     1 byte：bit0=glow, bit1=hasUV, bit2=hasEnt, bit3=hasFiniteLife
  lightLevel                1 byte：0..15
  pos                       3 × float32：[x,y,z]
  vel                       3 × float32：[vx,vy,vz]
  st                        varint：入场 tick
  [life]                    varint：仅 flags.hasFiniteLife 时存在；>=0
  [ent]                     仅 flags.hasEnt 时存在：见 §3.2
  [uv]                      仅 flags.hasUV 时存在：见 §3.1
}
```

### 2.3 groups

```
count                       varint
count × {
  memberCount               varint
  memberCount × particleIdx varint：粒子索引（0-based，指向 particles）
}
```

组名不存储；解码时按顺序合成为 `g0, g1, …`。

### 2.4 groupUV

```
count                       varint
count × {
  groupIdx                  varint：组索引
  uv                        UV 对象（§3.1）
}
```

### 2.5 functions

```
count                       varint
count × {
  center                    3 × float32：[x,y,z]
  count                     varint：派生粒子数
  codeLen                   varint
  code                      codeLen 字节 UTF-8（公式代码块，原样保留）
  duration                  varint：tick
  st                        varint：入场 tick
  flags                     1 byte：bit0=hasEnt, bit1=hasUV
  [ent]                     仅 flags.hasEnt 时存在：见 §3.2
  [uv]                      仅 flags.hasUV 时存在：见 §3.1
  varCount                  varint
  varCount × {
    nameLen                 varint
    name                    nameLen 字节 UTF-8
    base                    float32：数值基值
    kfCount                 varint
    kfCount × keyframe      关键帧（§3.3）
  }
}
```

函数对象 id 不存储；解码时按顺序合成为 `fx0, fx1, …`，派生粒子 id 为 `fx<i>:p<j>`。

> 变量使用**数值基值 + 关键帧**模型（与当前编辑器一致，无表达式字符串）。

### 2.6 tracks

```
count                       varint
count × {
  pr                        1 byte：分量枚举（§4）
  mode                      1 byte：0=set, 1=op
  idCount                   varint
  idCount × idRef           引用（§5）
  kfCount                   varint
  kfCount × keyframe        关键帧（§3.3）
}
```

---

## 3. 子结构

### 3.1 UV 对象

```
textureIdx                 varint：贴图索引（0-based，指向 texture 表）
mode                       1 byte：0=static, 1=fill, 2=animated
texSize                    2 × varint：[w,h]（像素）
uvStart                    2 × varint：[x,y]（像素）
uvSize                     2 × varint：[w,h]（像素）
uvStep                     2 × varint：[x,y]（像素）
fps                        float32
maxFrame                   varint：1=自动，>1=上限
loop                       1 byte：0/1
```

### 3.2 ent（入场过渡）

```
presetLen                  varint
preset                     presetLen 字节 UTF-8（当前实现 "fade"；未知值保留，播放端按词表分派）
d                          varint：过渡时长 tick
```

### 3.3 keyframe

```
tick                       varint
value                      float32
easing                     缓动编码（§6）
```

### 3.4 easing

```
tag                        1 byte：
                             0 → presetIdx varint（0..13，见 .pdraw 文档 §8）
                             1 → custom：4 × float32 [cx1,cy1,cx2,cy2]
```

---

## 4. `pr` 分量枚举

| 值 | pr | 值 | pr | 值 | pr |
|---|---|---|---|---|---|
| 0 | pos.x | 6 | col.r | 12 | scl.z |
| 1 | pos.y | 7 | col.g | 13 | rot.x |
| 2 | pos.z | 8 | col.b | 14 | rot.y |
| 3 | vel.x | 9 | col.a | 15 | rot.z |
| 4 | vel.y | 10 | scl.x | | |
| 5 | vel.z | 11 | scl.y | | |

---

## 5. 轨道 id 引用

```
kind                        1 byte：0=粒子, 1=组, 2=函数对象
index                       varint：对应数组的 0-based 索引
```

解码合成规则：

| kind | 合成字符串 |
|---|---|
| 0 | `p<index>` |
| 1 | `g:g<index>` |
| 2 | `f:fx<index>` |

---

## 6. 解码合成 id（模组运行时）

- 粒子：`p0, p1, …`（按 particles 数组顺序）。
- 组：`g0, g1, …`。
- 函数对象：`fx0, fx1, …`。
- 派生粒子：`fx<函数索引>:p<序号>`。

这些合成 id 与模组现有字符串运行时模型无缝衔接；编辑期用户可见命名
（`粒子0`/`组A` 等）与播放无关，故不进入 `.pdrawc`。

---

## 7. 版本与拒绝语义

- 魔数不是 `PDC1`、版本不是 1 或 2、或数据截断/越界 → **拒绝**。
- 签名验证失败 → **拒绝播放**。
- raw DEFLATE 解压失败 → **拒绝**。
- 未知 `pr` 枚举、未知 UV mode、未知 easing tag 等 → 视为损坏数据拒绝。