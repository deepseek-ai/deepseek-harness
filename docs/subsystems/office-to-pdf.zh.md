# Office 转 PDF

[English](office-to-pdf.md) | 中文

[document 包族](../../packages/document/README.zh.md) 在 Node 宿主上将 Office 文件转换为 PDF。消费者负责源文件读取授权与展示；共享提供方负责转换、有界准入和临时 PDF 复用。此子系统不创建面向模型的工具或 Session 事件。

## 所有权

| 所有者 | 职责 |
|---|---|
| [office-to-pdf](../../packages/document/office-to-pdf/README.zh.md) | `ctx.officeToPdf`：共享 LibreOffice 转换、有界准入和 PDF 缓存 |
| [Web bundle](../../packages/bundle/web-app/README.zh.md) | 由宿主消费者共享的单个可配置转换提供方 |
| [Office 预览 Client](../../packages/client/ui-sidebar-documentpreview/README.zh.md#office-preview) | Office 扩展名选择、PDF 复用和缺失字体提示 |

## 请求和结果

[`OfficeToPdfRequest`](../../packages/document/office-to-pdf/src/types.ts)包含已授权的源键与版本、可选 stat 大小、延迟的 `read(signal, maxBytes)` 回调、前台或后台优先级以及 `OfficeExtension`：`doc`、`docx`、`xls`、`xlsx`、`ppt` 或 `pptx`。`OfficeToPdf.convert(request, signal?)` 返回一个完整 PDF 结果。取消遵循调用方和提供方生命周期；校验、输出和引擎失败以分类的 `OfficeToPdfError` 拒绝。

`OfficeToPdfPriority` 对请求的预览或 QA 使用 `foreground`，对推测工作使用 `background`。`OfficeSourceKey` 为调用方拥有的已授权源定位符增加品牌类型。`OfficeToPdfGeneration` 表示提供方生命周期，`OfficeToPdfKey` 表示其内容身份；消费者不解析这两种不透明值。

| 结果字段 | 含义 |
|---|---|
| `pdf` | 调用方拥有的 `Uint8Array`，包含完整 PDF |
| `missingFonts` | 本次转换无法使用的文档请求字体名称 |
| `cacheKey` | 不透明的转换 generation 加扩展名与源内容身份 |
| `generation` | 提供方生命周期；替换后缓存 PDF 不再可复用 |

提供方先准入延迟读取，再分配源文件字节；按内容身份共享转换，并在返回前删除私有临时目录。返回的 PDF 字节在提供方释放后仍有效。源文件和 PDF 字节不会进入 Session 存储。消费者可通过[工作区文件](../../packages/api/workspace-files/README.zh.md)执行已授权的有界读取。

## 预览读取

`RenderedDocumentBytes` 携带工作区文件元数据、原生 PDF `data`、`missingFonts` 和 `generation`；转换后的 PDF 附带原始源文件身份。

`officeToPdf.render` Remote 方法通过 Session 的[工作区文件](../../packages/api/workspace-files/README.zh.md)服务检查源文件授权与版本。取得转换容量后，`fs.readBytes` 在预留字节容量内提供原始输入；该读取受 Office 输入上限约束。二进制 Remote 将 PDF 投影为 multipart 附件，并在 Client 恢复为由 `ArrayBuffer` 支撑的 `Uint8Array`。源访问失败直接传递；大小和引擎失败只暴露分类原因，不含诊断信息。转换不激活 Agent 或追加事件。

`api/remotes` 挂载转换服务生成的 Remote 描述符。共享文档预览包使用完整字节加载和现有 PDF.js Worker 注册 Office 格式。每次预览读取都会重新检查渲染 generation、源文件授权和版本，再共享进行中的转换或缓存 PDF。连接重置和插件卸载会取消请求并清空缓存字节。缺少服务时显示本地化配置引导。

## 引擎选择和限制

外部 [`@deepseek-ai/libreoffice-kit`](https://github.com/deepseek-harness/libreoffice-kit) Node API 选择其预编译引擎。kit 独立维护版本和发布流程，具体归属由[发布归属决策](../../.agents/notes/implemented/architecture/2026-09-14-independent-libreoffice-kit.zh.md)定义。应用构建时安装已发布的 npm 包。应用打包要求目标已声明的原生引擎；kit 未为该目标声明原生引擎时使用 Node WASM。[平台引擎决策](../../.agents/notes/implemented/architecture/2026-09-15-platform-office-engines.zh.md)定义安装和打包规则。元数据无效、必需资源缺失和转换错误都会拒绝请求，不切换引擎。转换在 Host 使用磁盘输入输出路径，不使用浏览器转换引擎或字体 RPC。

[Host 提供方配置](../../packages/document/office-to-pdf/README.zh.md#use-this-package)负责并发、期限、输入输出上限、归档上限、图像分辨率和字体访问。原生/WASM 实现和资产分发属于 kit 工作区。系统 LibreOffice 探测、运行时引擎下载、持久 PDF 缓存和面向模型的渲染不属于此提供方。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxofficetopdf--officetopdf"></a>

### `ctx.officeToPdf` — `OfficeToPdf`

A provider lifetime owns all converters, queued calls, and temporary files.

```ts cordis-catalog
/**
 * Convert Office bytes without modifying the source or writing Session events.
 * @param request - authorized metadata and deferred bounded source read.
 * @param signal - caller cancellation; provider disposal also stops active work.
 * @returns caller-owned PDF bytes after conversion and scratch cleanup settle; canceled readers reject independently.
 * @throws {OfficeToPdfError} Invalid input, unusable output, or engine failure; cancellation rejects with its reason.
 */
convert(request: OfficeToPdfRequest, signal?: AbortSignal): Promise<OfficeToPdfResult>

/**
 * Read and convert one Office file using the Session's ordinary filesystem authorization.
 * @param workspaceFileScope - Session header lookup shared with workspaceFiles.
 * @param path - absolute or workspace-relative Office path.
 * @param priority - foreground preview or speculative background work.
 * @param signal - Remote cancellation; disposal also cancels outstanding reads and conversions.
 * @returns complete PDF bytes with original source identity and missing font families.
 */
@Remote async render( workspaceFileScope: WorkspaceFileScope, path: string, priority: OfficeToPdfPriority, signal: AbortSignal, ): Promise<RenderedDocumentBytes>

/**
 * Read the current rendering generation before reusing a Client PDF.
 * @param signal - Remote caller cancellation.
 * @returns provider lifetime, replaced with rendering, font, or engine configuration.
 */
@Remote('generation') getGeneration(signal: AbortSignal): OfficeToPdfGeneration
```

Source: [`packages/document/office-to-pdf/src/index.ts`](../../packages/document/office-to-pdf/src/index.ts)
<!-- END GENERATED cordis-surface -->
