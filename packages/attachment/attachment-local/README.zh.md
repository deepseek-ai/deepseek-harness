---
description: "DSH_HOME 下附加图片的本地存储，供用户与维护者选择或排查图片附件的存放位置。"
kind: "package-reference"
---

# @deepseek-ai/dsh-attachment-local

[English](README.md) | 中文

## 概述

在运行 DSH 的机器上，把图片与通用文件附件持久存储到 `DSH_HOME` 下。图片经过校验、针对模型请求完成规范化并按路由缓存；通用文件不设准入限制，按字节原样保存。即使上传时使用不同显示名称，相同字节也只存储一次；读取会校验文件长度与内容，之后收紧限制也不会让已接纳的图片不可读。随附的 `dsh` 组合无需配置即可使用本包。对象仅限本机，并且永远不会自动删除。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在默认组合中，把图片或通用文件附加到提示词或命令，它们会自动保存到本机。自行组合时，挂载这个插件即可获得持久附件。

### 最小配置

挂载插件，无需任何必填配置。下列默认值规定了可以附加的内容；生成的配置目录完整列出了所有字段。

```yaml
- name: '@deepseek-ai/dsh-attachment-local'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dshHome` | 自动解析 | 显式 harness home；省略时依次跟随 `$DSH_HOME` 与 `~/.dsh` |
| `maxImageBytes` | `50 MiB` | 单张图片接受的最大编码源字节数 |
| `maxImagesPerMessage` | `20` | 单条提交消息接受的最大图片数量 |
| `maxMessageImageBytes` | `200 MiB` | 单条提交消息接受的最大编码源图字节总数 |
| `maxImagePixels` | `64,000,000` | 源图宽度与高度乘积的最大值 |
| `maxImageDimension` | `65,535` | 源图接受的最大宽度或高度；默认值让 `maxImagePixels` 单独把关，长边由规范化缩小 |
| `normalizedImageMaxPixels` | `2048 × 2048` | 已存规范化图片的总像素预算 |
| `normalizedImageMaxDimension` | `8192` | 应用总像素预算后的最大长边 |
| `normalizedImageMaxBytes` | `4 MiB` | 编码字节目标；没有候选满足时保留质量阶梯中的最小输出 |
| `imageCompressionConcurrency` | `2` | 并发规范化与请求变换的 FIFO 上限 |
| `requestImageMinShrinkFactor` | `1.1` | 请求图片超过硬字节上限后，长边缩小倍数的最小值；必须大于 1 |
| `requestImageByteHeadroom` | `0.95` | 估算下一次尺寸时使用的硬字节上限比例；范围为 `(0, 1]` |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-attachment-local)完整列出了所有受支持的字段及其 JSDoc。

### 图片存储在哪里、会保留多久

附加的图片保存在本机的 `<DSH_HOME>/attachments/v1` 下。已存储的图片永远不会被自动删除，相同图片只会存储一份，之后收紧限制也绝不会让已保存的图片不可读。如果你的图片需要能从另一台机器读取，本包并不合适。

### 附加图片时会发生什么

附加图片后，会先检查源图限制、媒体类型、尺寸与像素，再完成规范化并保存。系统应用 EXIF 方向、移除元数据与色彩配置、保留透明度，并按总像素预算与长边上限缩小光栅。带 alpha 的图片使用 WebP，不透明图片使用 JPEG，共享 85/75/60 质量阶梯；全部候选都超过字节目标时保留最小输出。被接受的图片会重新出现在历史和后续轮次中，重启后也不例外；所选模型路由会收到缓存的请求版本，并在其文件系统可映射宿主对象时收到只读执行世界路径。

### 请求图片的字节限制

模型路由提供硬编码字节上限 `maxImageBytes`，以及不大于硬上限的目标 `imageTargetBytes`。编码器先在请求尺寸下尝试 85、75、60 三档质量。仅超过目标值的输出保持分辨率。最小结果仍超过硬上限时，长边除以 `max(requestImageMinShrinkFactor, sqrt(actualBytes / (requestImageByteHeadroom × maxImageBytes)))`，向下取整并确保严格减小。每次都从已保存的源图按新尺寸编码，不重复压缩上一轮有损结果。每轮编码之间检查取消状态；即使 1×1 图片仍无法满足上限时，以 `IMAGE_REQUEST_TOO_LARGE` 失败。成功结果和缓存命中均满足硬上限。调用方使用返回的实际宽高计算坐标。

### 可能出什么问题

附加图片时可能被拒绝：格式不受支持、超出字节、像素或单边尺寸限制，或者字节与声明类型不符。之后读取时，磁盘上被删除或损坏的图片会以明确错误失败。每个失败都带有稳定错误码，客户端与协议适配器可以用自己的措辞解释。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释存储背后的持久性与校验设计，以及实现它的写入与读取路径；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计决策

- **持久性靠 fsync 链，而非存在性。** 当目录项从未到达存储时，仅同步文件无法在崩溃后存活，因此写入路径会在引用可能到达会话检查点前，把每个祖先条目同步到进程已验证的边界。
- **一次规范化，按路由投影。** 准入持久保存一份提供方无关的规范化附件；请求投影派生确定性变体而不改写持久历史。
- **惰性 alpha 路由编码。** 带 alpha 的图片使用 WebP，不透明图片使用 JPEG；质量候选按 85/75/60 顺序运行，没有候选满足编码字节目标时保留最小输出。
- **限制是写入时策略。** 字节、总像素与单边尺寸限制只约束准入，因此之后收紧它们绝不会让已接纳的历史不可读。

### 写入与读取路径

对象存放在 `<DSH_HOME>/attachments/v1/objects/<sha256-prefix>/<sha256>`；相同字节会去重为同一个对象和同一个 `sha256:` 标识符。首次写入前，进程会把 home 的每个祖先目录逐级同步到文件系统根目录，因此绝不会把另一个进程已创建但尚未同步的目录误认为安全边界。随后，写入过程把字节暂存到 `v1/tmp`、同步临时文件、以原子且排他的硬链接发布，并同步发布目录——在 Windows 上，文件系统元数据日志负责目录项持久性。保存操作完成后，返回的引用已具备持久性。

图片读取接收包含规范 `sha256:` ID 的完整引用，在该存储目录内推导对象路径，校验完整摘要，并探测图片文件头。实际格式、字节数、宽度和高度必须与传入引用一致。返回的引用把可选的 `name` 和 `originalDimensions` 作为调用方提交的显示信息原样保留，不根据对象校验这两个字段。读取不查询 Session 历史，也不重新应用准入限制；对象缺失或校验失败都会拒绝读取。

准入允许每条消息最多 20 张图片与 200 MiB 源字节；单个源图最多 50 MiB、6400 万像素与单边 65,535 像素。系统应用方向、移除元数据与色彩配置，并把规范化结果限制在 2048×2048 总像素预算、8192 像素长边和 4 MiB 编码字节目标内，因此，即使宽高比极端，图片也会保留短边分辨率。已经满足限制的干净、单帧、8-bit sRGB/sRGBA PNG、JPEG 或 WebP 会逐字节直通；GIF、动画、元数据、方向、16-bit PNG 与不兼容色彩空间会触发转换。

请求版本位于 `<DSH_HOME>/cache/attachments/request-images/`，由 `dshCachePath` 解析；显式 `dshHome` 同时用于缓存和持久存储。请求之间清空此缓存不会影响持久附件，后续读取会重新生成变体。`readImageRequest` 按路由目标缩放且不放大，沿长边调整以保持比例，再按相同的透明度分流和质量阶梯处理软目标及硬字节上限，仅在硬上限仍不满足时继续降低分辨率。缓存身份包含附件 id、变换版本、目标尺寸、两项字节限制、缩放参数和固定编码设置。缓存读取检查格式、8 位 sRGB/sRGBA、尺寸、透明度和硬字节上限，不匹配时重新生成。并发调用共享一次变换和缓存写入，仅在所有等待方均离开后取消共享工作。`imageHostPath` 派生规范化对象的宿主路径，文件系统可以将其映射到执行环境，不写入持久历史。

通用文件字节的唯一规范对象位于 `<DSH_HOME>/attachments/v1/file-objects/<digest-prefix>/<digest>`。每条引用路径 `<DSH_HOME>/attachments/v1/files/<digest-prefix>/<digest>/<name>` 都是只读硬链接，所以名称不同但字节相同的文件不会重复占用磁盘。`readFileStream` 以有界分块读取引用路径，并在消费方成功结束前校验完整摘要与记录的字节数。对象缺失、被改写或截断时，消费方会失败，不会得到字节已经变化的完整导出。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`LocalAttachmentStore`、`Config` schema、默认值 |
| [`src/store.ts`](src/store.ts) | 内容寻址写入与校验读取：暂存、硬链接发布、fsync 链、摘要校验 |
| [`src/file-store.ts`](src/file-store.ts) | 原样文件的流式写入、校验式流式读取与安全存储文件名 |
| [`src/normalization.ts`](src/normalization.ts) + [`src/encoding.ts`](src/encoding.ts) | 提供方无关的规范化与有界格式／质量候选 |
| [`src/request-image.ts`](src/request-image.ts) | 路由专用请求变换、缓存身份与 singleflight |
| [`src/image.ts`](src/image.ts) | 完整光栅解码与元数据校验 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

完整的服务约定与载荷类型请看子系统参考；这份存储所支撑的能力请看 seam 包。

- [附件子系统参考](../../../docs/subsystems/attachment.zh.md)——服务约定、载荷类型与 `ctx.attachments` 的 Cordis 接口面。
- [附件 seam 包](../attachment/README.zh.md)——本存储支撑的图片附件能力。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-attachment-local)——每个受支持配置字段及其源声明。
- [Home 路径解析](../../util/home-paths/README.zh.md)——`DSH_HOME` 如何从显式配置、环境变量与用户主目录解析。

-----

<a id="model-experience"></a>
## 模型体验

本包通过请求描述符间接影响模型。执行文件系统可以映射宿主对象时，模型会随请求字节看到每张图片的身份、尺寸、媒体类型、只读进程路径、可写副本扩展名与规范化警告。通用文件会投影为指出文件身份与只读进程路径的文本句柄；无法映射时，句柄会说明当前执行环境不能读取该文件。

#### KV Cache 影响

规范化和请求投影都是确定性的。附件和路由策略不变时，之后各轮会复用相同的缓存请求字节；执行世界路径映射可以改变描述符文本，而不会改变这些字节或其 `variantId`。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制描述了这份存储能做什么、不能做什么；它们是当前包约束。

- **图片会永久保留**——已存储的图片永远不会被自动删除，也没有任何机制回收未被引用的对象。
- **仅限本机**——图片存放在运行 harness 的机器上；其他主机无法读取。
- **动态 GIF 变为静态**——规范化只保留第一帧；动画不属于第一版图片约定。
- **编码器输出带版本**——已安装的 Sharp/libvips 构建会固定规范化结果与请求字节；编码器或变换版本升级会让未来变体产生新地址，已有对象继续有效。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：尚未决定的探索方向与开放问题。它明确不具权威性——已交付的行为与限制以上文和包代码为准。

#### 未来：保留与远程存储

保留与垃圾回收被推迟，因为恢复和 fork 后的会话可能共享不可变对象；服务于远程运行时或共享存储的后端则需要自己的持久性证明。两个方向都尚未决定；本地存储当前在 `DSH_HOME` 下保留所有对象。

</details>
