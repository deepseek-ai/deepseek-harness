---
description: "面向模型的 read、read_image、write 与 edit 工具：供组合或排查 agent 文件系统访问的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-fs

[English](README.md) | 中文

## 概述

使用 `dsh-tool-fs` 可让模型带行号读取 UTF-8 文件、读取受支持的图片、创建或原子地替换文件，执行有针对性的字面量编辑，以及应用 Codex 风格的多文件补丁。结果都有上限，失败会提供稳定错误码与恢复指令。当写入和编辑必须在成功读取后执行时，请添加 `dsh-fs-observation-policy`；省略它时，变更仍是原子的，但不受此条件约束。图片读取需要持久附件存储和支持图片输入的路由模型。glob 或 grep 搜索请选择同级的发现工具包。

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

相对路径使用 Session 的当前工作目录。切换目录会影响后续读取和修改，但不会改变沙箱权限根目录。成功结果返回 `fs.processPath` 提供的规范化绝对路径，根调用结果元数据保留该操作发生时的路径，用于回放和导航。

在 `ctx.fs` 后端之后挂载工具，并在需要先读后写/编辑行为时挂载策略插件。模型随后获得带行号的读取、原子的写入与编辑，以及——挂载附件存储时——图像读取；每个结果都有上限，失败携带稳定错误码与恢复指令。

### 最小组合

一个后端、策略插件，然后是工具；附件存储为可选，用于启用 `read_image`。

```yaml
- name: '@deepseek-ai/dsh-fs-local'
- name: '@deepseek-ai/dsh-fs-observation-policy'
- name: '@deepseek-ai/dsh-tool-fs'
```

策略插件是可选的：省略时，工具直接使用裸提供方（无条件写入、覆盖、编辑与补丁，无已观察状态）。加载这些工具的部署也应加载该插件，从而提供写入/编辑/补丁前读取行为。`read_image` 只在持久 `ctx.attachments` 服务已挂载时注册；执行时还拒绝确切模型未声明图像输入的路由，因此文本路由的持久历史不会出现图像块。

### 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `read` | `file_path`、`offset?`、`limit?` | 带行号的 UTF-8 内容与分页 footer；`offset` 从 1 开始，`limit` 默认为配置的 `readLimit`，上限也为该值 |
| `read_image` | `file_path` | 读取并持久保存 PNG/JPEG/WebP/GIF 源图；无扩展名路径（包括规范化附件对象路径）按文件签名识别格式；规范化可在下一次模型请求前缩小图片，因此模型无需先创建缩略图 |
| `write` | `file_path`、`content` | 创建或完整替换文件；有策略插件时，覆盖要求先在未变版本上执行 `read`，创建不需要 |
| `edit` | `file_path`、`old_string`、`new_string`、`replace_all?` | 字面量替换，除非 `replace_all` 为 true 否则要求唯一匹配；有策略插件时，要求先执行 `read` 且文件未变 |
| `apply_patch` | `input`，以及可用时的沙箱提权字段 | 新增/更新/删除/移动，整份预检后顺序执行并保留已知部分效果 |

字段名使用 snake_case，与 Claude Code 和现有 harness 工具 schema 一致。`write` 和 `edit` 的路径描述要求模型先输出 `file_path`，再输出内容或替换字符串；这用于引导流式展示，不强制 JSON 成员顺序。成功返回紧凑信封——读取窗口、图像引用或 `Created file`/`Updated file` 确认——`write`/`edit` 还会派生可回放的 diff 卡片元数据供 UI 展示。

### 配置

所有键均为可选。`read`、`readImage`、`write` 和 `edit` 开关默认为 `true`；将开关设为 `false` 可省略对应工具及其指导文本。`applyPatch` 默认为 `false`，因此默认组合不注册 `apply_patch`；启用 `edit` 的随发行版交付的 `tool-fs` 行（[`dsh-base`](../../bundle/base/cordis.patch.yml) 以及 Web 的 `standard`、`ptc`、`cordis` preset）显式写出 `applyPatch: false`，把这一行改为 `true` 即在 `edit` 旁加入该工具。允许关闭全部五个工具。启用 `readImage` 仍需要附件存储和支持图片输入的模型。关闭 `read` 时仍会校验读取上限。

| 键 | 默认值 | 含义 |
|---|---|---|
| `read` | `true` | 注册 `read` 及其指导文本 |
| `readImage` | `true` | 附件存储挂载时注册 `read_image` |
| `write` | `true` | 注册 `write` 及其指导文本 |
| `edit` | `true` | 注册 `edit` 及其指导文本 |
| `applyPatch` | `false` | 注册 `apply_patch` 及其提示 |
| `readLimit` | `2000` | 一次 `read` 调用返回的默认和最大行数 |
| `readMaxLineLength` | `2000` | 每行截断前保留的字符数 |
| `readMaxBytes` | `51200` | 一次 `read` 调用所选行的字节上限；溢出时以「已达上限」footer 结束窗口 |
| `readStreamMinSize` | `10485760` | 大于等于该大小或大小未知的文件采用流式读取，而不是整体加载到内存 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-fs)是每个受支持字段及其 JSDoc 的穷尽式真源。

挂载 `fs-observation-policy` 且关闭 `read` 时，`write` 仍可创建文件，成功写入或编辑会记录本会话后续修改所需的版本。未观察过的已有文件仍受保护；关闭 `read` 不会放宽策略。其他文件系统读取方必须发出 `fs/observed`，已有文件才会成为已观察状态。

### 策略与沙箱行为

`read` 与 `read_image` 的路径授权完全由 `ctx.fs` 负责；媒体类型声明和文件签名只决定 `read_image` 是否接受该后端返回的字节。

挂载策略插件后，`write` 与 `edit` 从 `fs/*` 意图槽位取得防护，因此未读目标或陈旧观察会以 `FS_NOT_OBSERVED` 或 `FS_STALE_VERSION` 及恢复指令失败。使用施加沙箱限制的后端（`fs-sandbox`）时，`write`/`edit` 还会公开 `sandbox_permissions` 与 `justification`；被拒绝的变更返回 `[sandbox: file access denied under <mode> mode]` 标记与同轮次升级提示，获批的重试可以在该次调用中加盖严格更宽的模式。省略 `sandbox_permissions` 或重复当前调用的生效模式时，`justification` 可以省略、为空字符串或仅含空白，且不会请求审批。不同模式仍需非空理由，升权还需审批。没有模式却提供非空理由会被拒绝。这些例外不会绕过观察检查或文件系统拒绝。理由字段提示模型使用用户当前提问的语言。

### 失败与恢复

`apply_patch` 的语法与预检拒绝在磁盘变更前抛错，结果为 `isError: true`。`FsError` 保留文件系统错误码；`PatchToolError extends HarnessError` 携带 `PATCH_SYNTAX` 和 `PATCH_SYMLINK_SOURCE`。进入提交后，即使失败或结果不确定也返回 `isError: false` 的值，确保已知部分效果的 diff 元数据得以保留；提交期间被取消的调用与其他工具一样收到工具注册表的中止结果，已完成的变更仍可通过 Review 查看。`phase`、`cancelled`、有序 `operations` 与 `affectedPaths` 描述提交；每条操作保留索引、种类、展示路径、补丁行号、状态、诊断与已知变更。完整 `before`/`after` 文本供渲染和 PTC 使用；Session 保存渲染文本以及 `meta.diffs` 与 `meta.stopped`。新建与 `write` 一样不保存 diff；删除与移动源仅在提供方返回有界基线时保存删除 diff，并使用 `newText: ''`，因为 `FileDiff.newText` 不可为 null。

失败被规范化为 `Error: <message>`，并为调用方保留结构化错误码。稳定消息包括 `file_path must be a non-empty string`、`limit must be less than or equal to <max>`、`cannot read "<path>": not found`、`cannot read "<path>": not a regular file`，以及图像路由拒绝 `cannot read "<path>" as an image: model "<model>" does not declare image input; switch to an image-capable model to read images`。无论拒绝来自策略还是提供方，`FS_NOT_OBSERVED` 都规范化为 `cannot modify "<path>": file has not been read — read the file, then retry`；`FS_STALE_VERSION` 保留提供方原因并追加 `— re-read the file, then retry`。该次重新读取确认缺失后，`edit` 报告 `FS_NOT_FOUND` 而不会重复陈旧恢复指令，`write` 则使用防护创建。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具套件背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

工具就是执行器；策略是事件门禁。工具不注入策略服务，也不检查任何缓存——每次变更都通过 `ctx.waterfall` 向单一意图槽位请求防护，每个操作只在成功后发出 `fs/observed`。读取恰好执行一次提供方 `stat`（类型与大小路由加观察到的版本）；`write` 与 `edit` 一次也不执行，因为防护来自意图槽位，提供方在锁内重新检查。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、工具组合、`read_image` 附件门禁 |
| [`src/read.ts`](src/read.ts) | `read` 执行器：一次 stat、流式决策、窗口构建、观察 |
| [`src/read-image.ts`](src/read-image.ts) | `read_image` 执行器：路由与媒体类型门禁、有界字节、附件保存 |
| [`src/write.ts`](src/write.ts) | `write` 执行器：意图 waterfall、原子写入、观察 |
| [`src/apply-patch.ts`](src/apply-patch.ts)、[`apply-patch-output.ts`](src/apply-patch-output.ts) | `apply_patch` 注册、严格提交值与精简诊断 |
| [`src/apply-patch-presentation.ts`](src/apply-patch-presentation.ts) | 纯调用预览与已知结果 diff |
| [`src/edit.ts`](src/edit.ts) | `edit` 执行器：意图 waterfall、字面量编辑、观察 |
| [`src/patch/index.ts`](src/patch/index.ts)、[`types.ts`](src/patch/types.ts) | 内部 `executePatch` 入口与可序列化的逐操作报告 |
| [`src/patch/plan.ts`](src/patch/plan.ts) | 解析补丁并按 Session 工作目录解析路径；保留共享规范化目标的有序操作 |
| [`src/patch/preflight.ts`](src/patch/preflight.ts) | 模拟前序成功操作，在任何写入前收集观察、类型、文本与 hunk 失败 |
| [`src/patch/execute.ts`](src/patch/execute.ts) | 重新获取防护、顺序提交、记录实际效果并判断不确定失败 |
| [`src/read-render.ts`](src/read-render.ts) | 不依赖 Cordis 的窗口构建与信封格式化 |
| [`src/sandbox.ts`](src/sandbox.ts) | 各变更工具共享的升权 API：策略解析与拒绝标记映射 |
| [`src/error.ts`](src/error.ts) | 防护变更失败的稳定模型侧诊断 |
| [`src/mutation-result.ts`](src/mutation-result.ts) | 成功变更的观察记录与规范化结果路径 |

### 各工具流程

四个工具共享同一种流程形态：用调用会话的 cwd 解析路径、运行适用的门禁、恰好执行一次提供方操作，并且只在成功后发出 `fs/observed`。`read` 与 `read_image` 为类型与大小路由付出一次 `stat`；`write` 与 `edit` 不执行 stat，因为防护来自意图槽位，提供方失败以类型化 `FsError` 结果呈现。各工具执行器位于 `src/read.ts`、`src/read-image.ts`、`src/write.ts` 与 `src/edit.ts`。

内部补丁执行器接收原始补丁和已解析的沙箱策略。它建立有序计划，针对模拟状态预检全部操作，再通过 `writeText`、`patchText`、`deleteFile` 或一次 `moveFile` 调用提交。被预检拒绝的操作不产生模拟效果，任何拒绝都会阻止全部写入。沙箱围栏不参与模拟：与 `write`、`edit` 一样由提供方在每次提交时判断，被拒绝的操作使补丁停止并保留之前的操作。语法报告携带解析器失败；预检报告列出被拒绝的操作；提交报告为每个操作保留 `completed`、`failed`、`unknown` 或 `skipped` 状态及已知的 LF 文本变化。未解析的路径保留补丁原始写法；已解析的路径使用提供方显示路径。编程错误使调用拒绝。

### 观察与并发

`fs/observed` 在操作成功之后通过普通 `ctx.emit` 发出；监听器的约定是同步且只有副作用的记录器，因此异步或可能失败的观察不属于该事件。`read` 允许并发调度，因为它唯一改变状态的操作是同步记录版本；稍后的 `write` 或 `edit` 会在目标锁内重新检查版本，因此记录器竞态会安全地失败，两个变更工具仍保持互斥。

补丁预检读取从不发出 `fs/observed`。对目标的首次预检操作分发意图；同一目标的后续操作使用模拟状态。每次提交重新分发意图以取得当前防护。新增与更新记录存在，删除记录缺失，移动记录目标存在，且仅在源删除成功后记录源缺失；部分移动为 `failed`，只包含目标变化。移动源基线由 `moveFile` 在锁内返回。

变更以 `FS_IO_ERROR` 拒绝后，执行器使用新的 `stat` 比较每个受影响目标的版本。全部未变表示已知失败；任何目标已变或比较失败均为 `unknown`，不记录观察或变化。`FS_ABORTED` 一律为 `unknown`：被取消的远端请求在提供方可能仍在写入时就已拒绝。执行在首个失败或未知提交后停止，或在信号已取消的操作开始前停止。

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

组装时，每个指导段落通过 `ctx.tools.get(name, scope)` 检查对应工具，仅在该 agent 可见时输出。write 段落仅在 edit 可见时推荐 edit。三个工具都可用时，下方原文保持不变；限制的施加、解除和工具注册变化在下次组装时生效。同一检查适用于直接限制 agent 和从历史 descriptor 恢复的 subagent 过滤器，也适用于通过 `run_code` 暴露的 PTC 能力。 write/edit 中的先读后改句子描述观察策略，并非要求调用名为 `read` 的工具。隐藏 `read` 时仍保留这些句子：策略继续保护修改操作，其他产生观察记录的操作（例如 `str_replace_editor` 的 `command: view`）也能建立同一文件观察记录。工具可见性不会禁用该前置条件。

##### Read 指导

```markdown
Use the read tool — not shell commands like cat — to inspect text files. Use offset and limit to continue reading large files.
```

##### Write 指导

```markdown
Read an existing file before overwriting it with write (the default fs-observation-policy requires it) and prefer edit for targeted changes.
```

##### Edit 指导

```markdown
Read a file before editing it (the default fs-observation-policy requires it), unless you just created or edited it in this session.
```

#### Token 影响

指导成本取决于可见工具及其适用的跨工具推荐。

#### KV Cache 影响

可见工具集合、插件作用域和指导文本不变时，前缀保持稳定。限制或插件生命周期变化可能从首个变化的段落开始使复用失效。

### 工具 schema

#### 模型看到的内容

模型会看到已生成的 [`read`、`read_image`、`write` 和 `edit` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-fs)，参数使用 snake_case。图片工具只在持久附件存储已挂载时出现；schema 本身与路由无关，严格门禁在执行时拒绝。作用域工具限制可以为某个 agent 移除任一定义。

#### Token 影响

该工具视图中的每个请求都支付固定 schema 成本。

#### KV Cache 影响

只要可见工具定义和顺序不变，前缀就保持稳定。注册生命周期或作用域限制可能从首个变化的 schema token 开始使复用失效。

### 读取结果

#### 模型看到的内容

成功读取结果精确为 `<path><resolvedPath></path>`、换行、`<type>file</type>`、换行、`<content>`、形如 `<lineNumber>: <text>` 的编号行、一个空行、一条 footer 和 `</content>`。footer 精确为 `(Output capped. Showing lines <start>-<end>. Use offset=<next> to continue.)`、`(Showing lines <start>-<end> of <total>. Use offset=<next> to continue.)` 或 `(End of file - total <total> lines)`。长行结尾精确为 `... (line truncated to <max> chars)`。读取缺失目标仍返回 `FS_NOT_FOUND`，但会为调用会话记录确认缺失；外部删除的文件被重新读取后，重试的 `write` 可以通过提供方的不替换防护安全地重新创建该文件。

#### Token 影响

读取输出受 `readLimit`、`readMaxLineLength` 与 `readMaxBytes` 限制；保留的调用与结果会反复发送，直到上下文压缩（compaction）。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 图像读取结果

#### 模型看到的内容

成功的 `read_image` 返回 `<path><resolvedPath></path>`、`<type>image</type>` 和写明媒体类型、规范化尺寸与字节数的 `<content>` 信封，随后是作为原生图像块的图像本身。结果会随持久引用写入会话日志，然后才进入下一次模型请求。

#### Token 影响

图像在之后每次请求中都会计费，直到压缩。每次调用都独立受附件存储的 `maxImageBytes`/`maxImagePixels`/`maxImageDimension` 约束；重复成功调用会在历史中累积，内容寻址只去重存储的字节，不去重每次请求的 token 成本。

#### KV Cache 影响

仅追加；新可见内容跟在可复用请求前缀之后，不会使既有 KV 缓存条目失效。

### 写入与编辑结果

#### 模型看到的内容

写入精确返回五行包络：`<path><resolvedPath></path>`、`<type>file</type>`、`<content>`、`Created file` 或 `Updated file`，以及 `</content>`。编辑精确返回 `The file <resolvedPath> has been updated successfully.`；对于 `replace_all`，精确返回 `The file <resolvedPath> has been updated. All occurrences were successfully replaced.`。完整写入或替换文本仍保留在 assistant 工具调用参数中。

#### Token 影响

成功文本很少，但大型变更参数和所有结果会反复发送，直到上下文压缩。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 工具错误

#### 模型看到的内容

失败会规范化为 `Error: <message>`。本包稳定的校验和读取消息是 `file_path must be a non-empty string`、`limit must be less than or equal to <max>`、`old_string must be a non-empty string`、`old_string and new_string must differ`、`cannot read "<path>": not found`、`cannot read "<path>": not a regular file`、`offset <offset> is out of range for "<path>" (<total> lines)`、`cannot read "<path>": the <ext> extension does not declare a supported image format; read_image accepts PNG/JPEG/WebP/GIF files, including extension-less files in those formats`、`cannot read "<path>": the file content is not a supported image format; read_image accepts PNG/JPEG/WebP/GIF`、`cannot read "<path>": the bytes do not decode as a supported PNG/JPEG/WebP/GIF image; the file may be truncated or corrupt`、`cannot read "<path>" as an image: model "<model>" does not declare image input; switch to an image-capable model to read images`，以及类型不匹配的修复消息 `cannot read "<path>": the <ext> extension declares <type>, but the bytes use a different image format; rename the file to match its actual format if it is PNG/JPEG/WebP/GIF, or convert it to one of those formats`（无扩展名路径的不匹配报告 `cannot read "<path>": the file signature claims <type>, but the bytes decode as a different image format; the file may be corrupt`）。16-bit 转换失败会报告 `cannot read "<path>": the 16-bit PNG could not be converted to the normalized 8-bit sRGB form; convert it to an 8-bit PNG/JPEG/WebP and retry`。提供方和策略模板在各自包的 README 中逐字列出。模型侧错误包装把所有 `FS_NOT_OBSERVED` 来源规范化为 `cannot modify "<path>": file has not been read — read the file, then retry`；`FS_STALE_VERSION` 保留提供方原因并追加 `— re-read the file, then retry`。两者都保留结构化错误码和原始原因。该次重新读取确认缺失后，`edit` 会报告 `FS_NOT_FOUND`，而不会重复陈旧恢复指令；`write` 则使用带防护的创建。

#### Token 影响

只有失败调用会添加这些保留 token。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 应用补丁

#### 模型看到的内容

`apply_patch` schema 要求一个 `input` 字符串（沿用 Codex 的参数名，在该工具上训练过的模型会不经提示地发送这个键），包含 `*** Begin Patch` / `*** End Patch`、Add/Update/Delete 文件头、可选 Move to，以及上下文/新增/删除 hunk 行。路径相对于 Session 工作目录。有围栏后端追加与 write/edit 相同的提权字段。成功行按 A/M/D 分组，完成的移动显示 `M <destination>`，与 Codex rust-v0.158.0 一致。空补丁显示 `Success. No operations in patch.`。停止的补丁只包含适用的 Completed、Failed、Outcome unknown 与 Not executed 小节；结果不确定时以重读建议结束。语法错误保留解析器消息。

##### 系统提示

```markdown
Prefer apply_patch over separate edit calls for changes across files or separated regions. Read a file before updating, deleting, or moving it (the default fs-observation-policy requires it), unless you just created or edited it in this session. The whole patch is checked first (syntax, hunk matching, missing files) and a rejected patch changes nothing; once applying starts, operations run in order, stop at the first failure, and are not rolled back, so re-read affected files before retrying when needed.
```

##### 结果示例

```markdown
Success. Updated the following files:
A src/new.ts
M src/a.ts
D src/obsolete.ts

Patch stopped after 1 of 3 operations.
Completed:
M src/a.ts
Failed:
- operation 2 (move src/b.ts -> src/c.ts, patch line 6): source removal denied
  destination src/c.ts was written; source src/b.ts remains
Not executed:
- operation 3 (add src/d.ts)

Patch rejected before any change (1 problems):
- operation 1 (update src/a.ts, patch line 2): cannot modify "src/a.ts": file has not been read — read the file, then retry
```

#### Token 影响

默认工具集在首轮请求新增一份补丁工具 schema 与三句提示。提交输出随操作数量与诊断增长，不随文件大小增长。

#### KV Cache 影响

可见工具不变时保持稳定；调用和结果文本追加到历史。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明工具套件何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用文件系统对比或任务积压。

- **补丁提交不回滚**——后续失败后，先前成功操作和已发布的移动目标仍保留在磁盘上，`unknown` 结果要求重读受影响文件后再重试。
- **未交付面向模型的目录列表工具**：`ctx.fs.listDir` 服务于 skill（技能）发现等提供方代码，同级 `dsh-tool-fs-search` 包则提供基于 ripgrep 的 `glob` 与 `grep`，而不是扩展文件系统 seam。
- **`read` 只处理 UTF-8 文本文件**：图像使用独立的 `read_image` 工具；PDF、音频和视频仍延期处理。目录目标为 `FS_NOT_REGULAR_FILE`。
- **媒体类型按扩展名声明**：扩展名选择声明类型，附件存储的魔数校验保持权威；扩展名错误但格式正确的图像会得到改名修复提示，而不是被嗅探接受。只有没有扩展名的路径按文件签名识别格式。
- **对象路径重新走源准入**：对规范化附件对象调用 `read_image` 会把其字节作为新来源重新准入，因此把 `maxImageBytes`/`maxMessageImageBytes` 配置得低于规范化图片字节预算的部署可能拒绝 `ctx.attachments.readImage` 仍可读取的对象路径；默认配置下规范化预算（4 MiB）远低于源上限（50 MiB）。
- **内嵌图像预览依赖 UI 组合**：工具结果卡片经由浏览器的 `tool.call.images` 槽位渲染图像，由附件呈现插件填充；未组合该插件的 UI 改为显示结果的信封文本。
- **没有附件区域工具**：agent 在拥有文件系统路径时可以通过其他可用工具裁剪图片；没有路径的粘贴或拖入图片无法按更高分辨率重新读取。
- **没有超时接口**：`read`/`write`/`edit` 不接受超时参数，也不声明超时预算；取消只通过 `exec.signal` 传递（见[提供方理由](../README.zh.md)）。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
