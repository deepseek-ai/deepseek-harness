---
description: "通过独立发布的 kit 在 Host 渲染、转换 Office 文档和重算工作簿。"
kind: "package-reference"
---

# @deepseek-ai/dsh-office-kit

[English](README.md) | 中文

## 概述

在宿主计算机上将 Office 文档渲染为 PDF 或 PNG 图片、在格式之间转换，以及重算工作簿。声明了原生 LibreOffice 引擎的目标使用原生引擎，其余目标使用 Node WASM。预览支持 DOC、DOCX、XLS、XLSX、PPT 和 PPTX；操作还支持 OpenDocument 格式，图片渲染还支持 PDF。OOXML 操作返回缺失字体名称；二进制 Office 操作返回空列表。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

[Web bundle](../../bundle/web-app/README.zh.md)和 [SDK bundle](../../bundle/sdk-app/README.zh.md)以 `office-kit` 条目挂载此提供方；[Office 工具](../tool-office/README.zh.md)是其面向模型的消费方。独立组合通过 `cordis.yml` 条目挂载 `@deepseek-ai/dsh-office-kit`。

调用方提交已授权源的标识、版本、可选字节数、延迟的有界读取、输入扩展名；PDF 转换还指定调度优先级，图片渲染、格式转换和重算以前台优先级运行。源版本变化会拒绝操作。取消以原因为拒绝值，失败使用 `OfficeKitError`，其小写 `code` 也是 `document-render/failed` 的原因；[`dsh-tool-office`](../tool-office/README.zh.md#use-this-package) 在工具结果中把它映射为 `OfficeToolError` 的代码。每个结果都携带缺失字体；PDF 结果还携带转换 generation（配置替换后随之改变）。

| 方法 | 操作 | 结果 |
|---|---|---|
| `convert()` | 为预览把 Office 转为 PDF | 调用方拥有的 PDF 字节和缓存键 |
| `renderImages()` | 把选定的页、幻灯片或工作表区域渲染为 PNG | 按文档顺序排列的图片及其页码、工作表或区域，以及文档页数和 DPI |
| `convertTo()` | 转换为 `format` 指定的格式；CSV 需要 `sheet` | 已保存文件的 Host 路径、大小和 PDF 页数 |
| `recalculate()` | 把 XLS、XLSX 或 ODS 重算为 XLSX 或 ODS | 已保存工作簿的 Host 路径和大小 |

`renderImages()` 要求提供 `maxImages`、`maxPixels`、`maxDimension` 和 `maxBytes`。图片数超过 `maxImages`，或单张图片超过像素或尺寸上限时，引擎拒绝该选择；图片 PNG 总字节数超过 `maxBytes` 时，提供方在读取前和读取过程中以 `output-too-large` 拒绝。引擎拒绝的页、工作表、区域、分辨率或格式选择以 `invalid-request` 失败，并附带引擎的说明。转换和重算的文件受 `maxOutputBytes` 限制。提供方从不写入工作区：它把每个输出保存在 `outputDirectory` 下各自仅属主可访问的目录中，按请求的 `output.owner`（`office_convert` 和 `office_recalculate` 传入调用方 subagent 树的根 Session）分组，并返回绝对 Host 路径。文件在 `outputRetentionMs` 到期、较新的输出需要 `maxOutputStoreBytes` 内的空间（最旧的先删）、id 等于 owner 的 Session 卸载或提供方卸载时删除；单个文件超过 `maxOutputStoreBytes` 时以 `output-too-large` 失败。文件在删除成功之前一直计入 `maxOutputStoreBytes`；删除失败时记录日志，并在之后的淘汰、释放和卸载时重试，腾不出足够空间的保存以 `unavailable` 失败。卸载会等待进行中的删除结束。启动时还会删除之前进程留下的、超过保留期的输出目录，但只处理名字符合提供方生成格式的真实目录，不处理链接或 junction：`outputDirectory` 下一级为 `session-` 加 24 位小写十六进制数字，其下为小写 UUID v4 的输出目录。其他条目保持不动。服务公开 `outputDirectory`，供消费方检查其执行环境能否读取。

此 provider 依赖独立发布的 [`@deepseek-ai/libreoffice-kit`](https://github.com/deepseek-ai/dsh-libreoffice-kit) npm API，kit 版本为 `0.2.3`。应用打包选择 kit 的 `optionalDependencies` 中声明的匹配原生包；目标没有声明原生包时选择 WASM。已声明的原生引擎缺失时拒绝打包，不会选择 WASM。[发布归属决策](../../../.agents/notes/implemented/architecture/2026-09-14-independent-libreoffice-kit.zh.md)定义独立 kit 与 Harness 各自的职责。

Kit 缺失时提供方照常注册，例如未下载 Office sidecar 就启动的 Python SDK 可执行程序。此时需要新转换器的转换以代码为 `unavailable` 的 `OfficeKitError` 拒绝，提供方通过 `ctx.logger` 对每种不同的失败只报告一次。Kit 入口导入失败时行为相同。提供方只保留成功的导入，因此之后的转换会重新定位并导入 Kit。Office 预览对 `document-render/failed` 原因显示本地化的 `unavailable` 提示。

浏览器通过 `officeKit.render` Remote 方法请求 PDF，参数为 Session 标识、Office 路径和优先级。此入口使用 `workspaceFiles` 完成授权和源版本检查，再通过 `fs.readBytes` 在转换预留容量内读取原始字节。进程内 `convert()` 不要求这些服务。响应保留源文件路径与版本，通过二进制 Remote 的 multipart 传输携带原生 PDF 字节，并携带缺失字体和转换 generation。`officeKit.generation` Remote 方法返回当前提供方 generation；`api/remotes` 负责挂载生成的 Client 描述符。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxConcurrentConversions` | `2` | 最大活跃转换器数量；排队调用仍可取消。 |
| `timeoutMs` | `60000` | 获取转换器后的转换期限。 |
| `maxInputBytes` | `52428800` | 最大源字节数。 |
| `maxOutputBytes` | `104857600` | 最大完整 PDF、转换或重算文件字节数。 |
| `outputDirectory` | `$DSH_HOME/office-kit/outputs` | 转换和重算文件的绝对目录。 |
| `outputRetentionMs` | `86400000` | 输出保留的毫秒数。 |
| `maxOutputStoreBytes` | `536870912` | 保留输出的最大总字节数。 |
| `maxImageResolution` | `192` | PDF 导出中图像的 DPI；覆盖 kit 的默认值 `144`。`renderImages()` 改用每个请求的 `dpi`。 |
| `fontFallbacks` | kit 默认值 | 有序字体族优先组；每组至少包含两个含非空白字符的名称。 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-office-kit)定义全部字体、归档和图像设置。`fontDirectories` 接受绝对目录；省略时使用 kit 的平台默认值。显式 `fontFallbacks` 替换 kit 的默认分组。已安装的请求字体仍优先使用，缺失字形仍可由其他系统字体提供。原生引擎可能在应用这些优先规则前选中已安装的度量兼容字体。

[有界转换决策](../../../.agents/notes/implemented/architecture/2026-09-15-bounded-office-conversion.zh.md)说明队列准入、缓存限额与共享取消的设计依据。

四个方法共用一个准入队列，因此工具操作与预览竞争同一组转换器、预留容量和缓存。提供方按转换 generation、输入扩展名、操作及其参数和精确源字节的 SHA-256 保留成功输出。有界的源版本索引在授权 stat 后避免重读已知内容；内容标识也会在不同源路径之间共享转换。达到任一保留上限时，最近最少使用的输出及其别名一同移除。不保留失败或超过缓存上限的结果。每个结果具有独立的字节与字体缓冲区。已就绪别名命中不占用读取方名额；同一源的最后一个读取方离开时，立即释放其在途定位信息。源的最后一个读取方取消后，再次打开该源会重新读取字节，再按内容摘要共享转换，即使其他源仍保持该转换运行或其 PDF 已就绪。

准入在调用源读取前限制排队元数据、未完成读取方、活动源字节预留和转换。未知源大小预留 `maxInputBytes`；已知大小预留 stat 字节数。读取收到该容量，最多额外读取一个超限哨兵字节。`maxSourceBytes` 必须覆盖 `maxInputBytes`。最后一个读取方额度预留给前台。`maxBackgroundConversions` 设为零时，拒绝后台读取方加入排队或运行中的工作；仍可命中已完成的别名缓存。只要仍有前台任务排队，后台任务就继续等待，包括前台正在等待源容量的情况。前台加入会提升排队预热；最后一个前台读取方离开后，排队任务恢复后台优先级，符合条件的工作可立即开始。前台准入也可移除排队推测工作。总并发大于一时，后台并发为前台保留一个槽位。正在运行的预热即使被提权，也保留后台准入槽位直至结束。最后一个读取方取消共享工作。移除排队的前台阻塞任务后，其他符合条件的工作立即准入；实际读取、转换和清理完成前仍保留活动预留容量。

默认保留 8 个输出、128 MiB 和 64 个源别名，准入 32 个读取方与 8 个排队任务，最多预留 100 MiB 源字节，并允许一个后台转换。这些限制约束拥有的请求和二进制载荷，不约束引擎 RSS、multipart 封装、调用方保留的结果或 PDF.js 页面渲染。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

在 Kit 导入成功之前，每次需要转换器时，提供方都把返回自身 `import.meta.resolve('@deepseek-ai/libreoffice-kit')` 的查找函数传给 [`resolveKitModule`](src/locate.ts)，它返回 Kit 入口和以其为起点的引擎包解析器，或返回 `missing`。随后提供方动态导入该入口；提供方没有静态导入 Kit 的值。这使引擎查找以提供方实际使用的 Kit 安装为起点。

引擎包解析器以 Kit 入口为起点创建；每个解析器互相独立。解析成功时返回引擎 `package.json` 的绝对路径。包不存在时保留 Node 原始的 `MODULE_NOT_FOUND`，允许 Kit 从原生引擎回退到 WASM。如果包目录存在（包括断开的符号链接），但清单无法解析，解析器抛出安装不完整错误，并将 Node 错误保存在 `cause` 中；此时应重新安装该包。其他解析错误和文件系统检查错误原样传播。Kit 负责验证返回的清单和必需资源。

定位函数每次解析调用一次提供方的查找函数，并把任何抛出的值视为 Kit 缺失。原生引擎路径使用同一映射，只将第一个 `.asar` 归档段替换为 `.asar.unpacked`，不论进程是否运行在 Electron 中。已解包路径及归档外路径保持不变。`@deepseek-ai/libreoffice-kit-wasm` 始终保留 Node 逻辑路径，供支持归档的文件系统访问。这些函数不导入 Kit、不加载引擎代码、不注册服务、不修改模块解析，也不保留模块级状态；[Desktop 打包](../../../apps/desktop/packaging/README.zh.md#runtime-file-selection)负责决定解包哪些包。

引擎元数据无效、必需资源缺失和转换错误会拒绝请求，不会切换引擎。共享的 WASM 引擎使用 LibreOffice 的 CPU 图像过滤器。原生转换使用独立的平台引擎。

每个并发槽按需创建并复用一个 kit 转换器。提供方将已授权输入写入私有临时目录，从中读取有大小上限的普通输出文件，拒绝位于图片目录之外的图片路径，并在完成前删除目录。取消已准入的读取方不会阻塞后续排队工作。读取方取消只会释放该读取方；最后一个读取方和提供方卸载会取消共享工作。卸载向未完成读取方报告 `unavailable`，并等待转换及转换器清理结束。

Remote 文件读取在查询转换缓存前重新检查内容读取授权和源版本。延迟读取在取得转换容量后执行，并在读取后验证源版本。源读取失败直接传递；转换失败返回 `document-render/failed` 及分类原因，不暴露引擎诊断。卸载会取消并等待授权读取、Remote 请求和转换工作全部结束。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Office Kit](../../../docs/subsystems/office-kit.zh.md) — 组合与输入、结果所有权。
- [Office 工具](../tool-office/README.zh.md) — 面向模型的渲染、转换和重算工具。
- [工作区文件](../../api/workspace-files/README.zh.md) — Session 文件授权与有界读取。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 [Office 工具](../tool-office/README.zh.md#model-experience)，这些工具返回此服务渲染的图片和转换的文件。

#### KV Cache effect

无；此服务不会构造或修改模型请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 转换保真度和已安装的原生/WASM 资产由 `@deepseek-ai/libreoffice-kit` 负责；此提供方不查找系统 LibreOffice，也不在运行时下载引擎。
- `timeoutMs` 仅在 kit 开始转换时计时，不限制队列等待时间。
- 提供方只定位自身解析到的 Kit 安装；不搜索其他位置，也不安装 Kit 或引擎。
- 渲染的图片以字节返回。转换和重算后的文件存放在提供方的输出目录中，不写入工作区；由调用方把每个文件复制到目标位置。
- 映射原生路径时不验证解包副本是否存在。Kit 会拒绝缺失的清单或资源，而不会将其视为原生包缺失。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
