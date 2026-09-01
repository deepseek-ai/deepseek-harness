---
description: "面向模型的 read、read_image、write 与 edit 工具：供组合或排查 agent 文件系统访问的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-fs

[English](README.md) | 中文

## 概述

`dsh-tool-fs` 提供面向模型的文件系统工具——`read`、`read_image`、`write` 与 `edit`——及其执行器。借助它们，模型可以带行号读取文件、原子地创建或替换文件，并执行有针对性的字面量编辑；结果都有上限，失败携带稳定错误码与恢复指令，所有文件操作都运行在已挂载的 `ctx.fs` 后端之上。编辑前读取策略位于独立插件（`dsh-fs-observation-policy`）中，因此省略它只会得到无条件、依然原子的变更。`read_image` 在持久附件存储已挂载时出现，并且只在路由模型声明图片输入时允许执行。当模型需要读取、创建、替换或编辑 UTF-8 文本文件时选择本包；发现工具（`glob`/`grep`）在同级包中。

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

在 `ctx.fs` 后端之后挂载工具，并在需要先读后写/编辑行为时挂载策略插件。模型随后获得带行号的读取、原子的写入与编辑，以及——挂载附件存储时——图像读取；每个结果都有上限，失败携带稳定错误码与恢复指令。

### 最小组合

一个后端、策略插件，然后是工具；附件存储为可选，用于启用 `read_image`。

```yaml
- name: '@deepseek-ai/dsh-fs-local'
- name: '@deepseek-ai/dsh-fs-observation-policy'
- name: '@deepseek-ai/dsh-tool-fs'
```

策略插件是可选的：省略时，工具直接使用裸提供方（无条件写入、覆盖与编辑，无已观察状态）。加载这些工具的部署也应加载该插件，从而提供写入/编辑前读取行为。`read_image` 只在持久 `ctx.attachments` 服务已挂载时注册；执行时还拒绝确切模型未声明图像输入的路由，因此文本路由的持久历史不会出现图像块。

### 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `read` | `file_path`、`offset?`、`limit?` | 带行号的 UTF-8 内容与分页 footer；`offset` 从 1 开始，`limit` 默认为配置的 `readLimit`，上限也为该值 |
| `read_image` | `file_path` | 读取并持久保存 PNG/JPEG/WebP/GIF 源图；无扩展名路径（包括规范化附件对象路径）按文件签名识别格式；规范化可在下一次模型请求前缩小图片，因此模型无需先创建缩略图 |
| `write` | `file_path`、`content` | 创建或完整替换文件；有策略插件时，覆盖要求先在未变版本上执行 `read`，创建不需要 |
| `edit` | `file_path`、`old_string`、`new_string`、`replace_all?` | 字面量替换，除非 `replace_all` 为 true 否则要求唯一匹配；有策略插件时，要求先执行 `read` 且文件未变 |

字段名使用 snake_case，与 Claude Code 和现有 harness 工具 schema 一致。成功返回紧凑信封——读取窗口、图像引用或 `Created file`/`Updated file` 确认——`write`/`edit` 还会派生可回放的 diff 卡片元数据供 UI 展示。

### 配置

所有键均为可选；默认值是随产品交付的读取上限。

| 键 | 默认值 | 含义 |
|---|---|---|
| `readLimit` | `2000` | 一次 `read` 调用返回的默认和最大行数 |
| `readMaxLineLength` | `2000` | 每行截断前保留的字符数 |
| `readMaxBytes` | `51200` | 一次 `read` 调用所选行的字节上限；溢出时以「已达上限」footer 结束窗口 |
| `readStreamMinSize` | `10485760` | 大于等于该大小或大小未知的文件采用流式读取，而不是整体加载到内存 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-fs)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 策略与沙箱行为

`read` 与 `read_image` 的路径授权完全由 `ctx.fs` 负责；媒体类型声明和文件签名只决定 `read_image` 是否接受该后端返回的字节。

挂载策略插件后，`write` 与 `edit` 从 `fs/*` 意图槽位取得防护，因此未读目标或陈旧观察会以 `FS_NOT_OBSERVED` 或 `FS_STALE_VERSION` 及恢复指令失败。使用施加沙箱限制的后端（`fs-sandbox`）时，`write`/`edit` 还会公开 `sandbox_permissions` 与 `justification`；被拒绝的变更返回 `[sandbox: file access denied under <mode> mode]` 标记与同轮次升级提示，获批的重试可以在该次调用中加盖严格更宽的模式。

### 失败与恢复

失败被规范化为 `Error: <message>`，并为调用方保留结构化错误码。稳定消息包括 `file_path must be a non-empty string`、`limit must be less than or equal to <max>`、`cannot read "<path>": not found`、`cannot read "<path>": not a regular file`，以及图像路由拒绝 `cannot read "<path>" as an image: model "<model>" does not declare image input; switch to an image-capable model to read images`。防护变更失败会追加恢复指令：`FS_STALE_VERSION` 追加 `— re-read the file, then retry`，`FS_NOT_OBSERVED` 追加 `— read the file, then retry`。该次重新读取确认缺失后，`edit` 报告 `FS_NOT_FOUND` 而不会重复陈旧恢复指令，`write` 则使用防护创建。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具套件背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

工具就是执行器；策略是事件门禁。工具不注入策略服务，也不检查任何缓存——每次变更都通过 `ctx.waterfall` 向单一意图槽位请求防护，每个操作只在成功后发出 `fs/observed`。读取恰好执行一次提供方 `stat`（类型与大小路由加观察到的版本）；变更一次也不执行，因为防护来自意图槽位，提供方在锁内重新检查。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、工具组合、`read_image` 附件门禁 |
| [`src/read.ts`](src/read.ts) | `read` 执行器：一次 stat、流式决策、窗口构建、观察 |
| [`src/read-image.ts`](src/read-image.ts) | `read_image` 执行器：路由与媒体类型门禁、有界字节、附件保存 |
| [`src/write.ts`](src/write.ts) | `write` 执行器：意图 waterfall、原子写入、观察 |
| [`src/edit.ts`](src/edit.ts) | `edit` 执行器：意图 waterfall、字面量编辑、观察 |
| [`src/read-render.ts`](src/read-render.ts) | 不依赖 Cordis 的窗口构建与信封格式化 |
| [`src/sandbox.ts`](src/sandbox.ts) | `write`/`edit` 共享的升权 API：策略解析与拒绝标记映射 |
| [`src/error.ts`](src/error.ts) | 追加到 `FS_STALE_VERSION` 与 `FS_NOT_OBSERVED` 的面向模型恢复指令 |

### 各工具流程

四个工具共享同一种流程形态：用调用会话的 cwd 解析路径、运行适用的门禁、恰好执行一次提供方操作，并且只在成功后发出 `fs/observed`。`read` 与 `read_image` 为类型与大小路由付出一次 `stat`；`write` 与 `edit` 不执行 stat，因为防护来自意图槽位，提供方失败以类型化 `FsError` 结果呈现。各工具执行器位于 `src/read.ts`、`src/read-image.ts`、`src/write.ts` 与 `src/edit.ts`。

### 观察与并发

`fs/observed` 在操作成功之后通过普通 `ctx.emit` 发出；监听器的约定是同步且只有副作用的记录器，因此异步或可能失败的观察不属于该事件。`read` 允许并发调度，因为它唯一改变状态的操作是同步记录版本；稍后的 `write` 或 `edit` 会在目标锁内重新检查版本，因此记录器竞态会安全地失败，两个变更工具仍保持互斥。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从工具逐步进入它们所组合的约定、后端与策略。

- [文件系统子系统](../../../docs/subsystems/filesystem.zh.md)——穷尽式提供方约定、策略事件与错误分类体系。
- [dsh-fs](../fs/README.zh.md)——这些工具消费的 `ctx.fs` 约定。
- [fs-local](../fs-local/README.zh.md)——这些工具运行于其上的宿主文件系统后端。
- [fs-sandbox](../fs-sandbox/README.zh.md)——添加升权字段的沙箱强制后端。
- [fs-observation-policy](../fs-observation-policy/README.zh.md)——通过 `fs/*` 事件防护变更的策略插件。
- [生成工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-fs)——本包注册的穷尽式 schema。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型看到的内容

该插件注册作用域内的每个请求都会收到下方独立注册的 read、write 与 edit 指导。作用域工具限制可以隐藏 schema，而不移除这些段。

##### Read 指导

```markdown
Use the read tool — not shell commands like cat — to inspect text files. Results include line numbers. Use offset and limit to continue reading large files.
```

##### Write 指导

```markdown
Use the write tool to create files or completely replace file contents. Existing files are overwritten, so read an existing file first (the default fs-observation-policy requires it) and prefer edit for targeted changes.
```

##### Edit 指导

```markdown
Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string; by default old_string must appear exactly once. If old_string appears multiple times, provide a more specific old_string or set replace_all to true. Read the file first (the default fs-observation-policy requires it), unless you just created or edited it in this session.
```

#### Token 影响

插件启用期间，每个请求支付固定指导成本；即使限制隐藏了一个或多个工具也一样。

#### KV Cache 影响

只要插件作用域和指导文本不变，前缀就保持稳定。工具限制不会移除该段，但插件启用或 dispose（资源释放）可能从该段开始使复用失效。

### 工具 schema

#### 模型看到的内容

模型会看到已生成的 [`read`、`read_image`、`write` 和 `edit` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-fs)，参数使用 snake_case。图片工具只在持久附件存储已挂载时出现；schema 本身与路由无关，严格门禁在执行时拒绝。作用域工具限制可以为某个 agent 移除任一定义。

#### Token 影响

该工具视图中的每个请求都支付固定 schema 成本。

#### KV Cache 影响

只要可见工具定义和顺序不变，前缀就保持稳定。注册生命周期或作用域限制可能从首个变化的 schema token 开始使复用失效。

### 读取结果

#### 模型看到的内容

成功读取结果精确为 `<path><displayPath></path>`、换行、`<type>file</type>`、换行、`<content>`、形如 `<lineNumber>: <text>` 的编号行、一个空行、一条 footer 和 `</content>`。footer 精确为 `(Output capped. Showing lines <start>-<end>. Use offset=<next> to continue.)`、`(Showing lines <start>-<end> of <total>. Use offset=<next> to continue.)` 或 `(End of file - total <total> lines)`。长行结尾精确为 `... (line truncated to <max> chars)`。读取缺失目标仍返回 `FS_NOT_FOUND`，但会为调用会话记录确认缺失；外部删除的文件被重新读取后，重试的 `write` 可以通过提供方的不替换防护安全地重新创建该文件。

#### Token 影响

读取输出受 `readLimit`、`readMaxLineLength` 与 `readMaxBytes` 限制；保留的调用与结果会反复发送，直到上下文压缩（compaction）。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 图像读取结果

#### 模型看到的内容

成功的 `read_image` 返回 `<path><displayPath></path>`、`<type>image</type>` 和写明媒体类型、规范化尺寸与字节数的 `<content>` 信封，随后是作为原生图像块的图像本身。结果会随持久引用写入会话日志，然后才进入下一次模型请求。

#### Token 影响

图像在之后每次请求中都会计费，直到压缩。每次调用都独立受附件存储的 `maxImageBytes`/`maxImagePixels`/`maxImageDimension` 约束；重复成功调用会在历史中累积，内容寻址只去重存储的字节，不去重每次请求的 token 成本。

#### KV Cache 影响

仅追加；新可见内容跟在可复用请求前缀之后，不会使既有 KV 缓存条目失效。

### 写入与编辑结果

#### 模型看到的内容

写入精确返回五行包络：`<path><displayPath></path>`、`<type>file</type>`、`<content>`、`Created file` 或 `Updated file`，以及 `</content>`。编辑精确返回 `The file <displayPath> has been updated successfully.`；对于 `replace_all`，精确返回 `The file <displayPath> has been updated. All occurrences were successfully replaced.`。完整写入或替换文本仍保留在 assistant 工具调用参数中。

#### Token 影响

成功文本很少，但大型变更参数和所有结果会反复发送，直到上下文压缩。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 工具错误

#### 模型看到的内容

失败会规范化为 `Error: <message>`。本包稳定的校验和读取消息是 `file_path must be a non-empty string`、`limit must be less than or equal to <max>`、`old_string must be a non-empty string`、`old_string and new_string must differ`、`cannot read "<path>": not found`、`cannot read "<path>": not a regular file`、`offset <offset> is out of range for "<path>" (<total> lines)`、`cannot read "<path>": the <ext> extension does not declare a supported image format; read_image accepts PNG/JPEG/WebP/GIF files, including extension-less files in those formats`、`cannot read "<path>": the file content is not a supported image format; read_image accepts PNG/JPEG/WebP/GIF`、`cannot read "<path>": the bytes do not decode as a supported PNG/JPEG/WebP/GIF image; the file may be truncated or corrupt`、`cannot read "<path>" as an image: model "<model>" does not declare image input; switch to an image-capable model to read images`，以及类型不匹配的修复消息 `cannot read "<path>": the <ext> extension declares <type>, but the bytes use a different image format; rename the file to match its actual format if it is PNG/JPEG/WebP/GIF, or convert it to one of those formats`（无扩展名路径的不匹配报告 `cannot read "<path>": the file signature claims <type>, but the bytes decode as a different image format; the file may be corrupt`）。16-bit 转换失败会报告 `cannot read "<path>": the 16-bit PNG could not be converted to the normalized 8-bit sRGB form; convert it to an 8-bit PNG/JPEG/WebP and retry`。提供方和策略模板在各自包的 README 中逐字列出。防护变更失败还会在消息中携带恢复指令，由本包面向模型的错误包装追加：`FS_STALE_VERSION` 追加 `— re-read the file, then retry`，`FS_NOT_OBSERVED` 追加 `— read the file, then retry`；结构化错误码保持不变。该次重新读取确认缺失后，`edit` 会报告 `FS_NOT_FOUND`，而不会重复陈旧恢复指令；`write` 则使用带防护的创建。

#### Token 影响

只有失败调用会添加这些保留 token。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明工具套件何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用文件系统对比或任务积压。

- **未交付面向模型的目录列表工具**：`ctx.fs.listDir` 服务于 skill（技能）发现等提供方代码，同级 `dsh-tool-fs-search` 包则提供基于 ripgrep 的 `glob` 与 `grep`，而不是扩展文件系统 seam。
- **`read` 只处理 UTF-8 文本文件**：图像使用独立的 `read_image` 工具；PDF、音频和视频仍延期处理。目录目标为 `FS_NOT_REGULAR_FILE`。
- **媒体类型按扩展名声明**：扩展名选择声明类型，附件存储的魔数校验保持权威；扩展名错误但格式正确的图像会得到改名修复提示，而不是被嗅探接受。只有没有扩展名的路径按文件签名识别格式。
- **对象路径重新走源准入**：对规范化附件对象调用 `read_image` 会把其字节作为新来源重新准入，因此把 `maxImageBytes`/`maxMessageImageBytes` 配置得低于规范化图片字节预算的部署可能拒绝 `ctx.attachments.readImage` 仍可读取的对象路径；默认配置下规范化预算（4 MiB）远低于源上限（20 MiB）。
- **工具结果卡片没有内嵌图像预览**：UI 表面以通用形式渲染图像结果（持久引用而非像素）；内嵌渲染延后到 UI 包处理。
- **没有附件区域工具**：agent 在拥有文件系统路径时可以通过其他可用工具裁剪图片；没有路径的粘贴或拖入图片无法按更高分辨率重新读取。
- **没有超时接口**：`read`/`write`/`edit` 不接受超时参数，也不声明超时预算；取消只通过 `exec.signal` 传递（见[提供方理由](../README.zh.md)）。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这个模型侧 adapter 没有独立 lifecycle stream；执行关系由它调用的 capability seam 负责。
