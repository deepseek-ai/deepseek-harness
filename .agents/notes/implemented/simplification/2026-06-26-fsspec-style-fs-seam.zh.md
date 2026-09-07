# Agent Note: 拆分文件系统 seam——提供方文本变更操作与 `dsh-fs-observation-policy` 插件

Status: implemented

[English](2026-06-26-fsspec-style-fs-seam.md) | 中文

## 问题

[文件系统能力 seam](../../archived/architecture/2026-06-17-filesystem-capability-seam.md)中的文件系统能力目前让一个抽象 `FileSystem` 服务同时负责两项不同工作：

1. **提供方操作**——解析目标、stat/版本元数据、文本读取/流式读取、原子写入，以及受保护的字面编辑。
2. **面向 agent（智能体）的策略**——行窗口、字面编辑语义，以及读后写/编辑的观测状态。

这导致每个未来的后端都要重新实现面向模型的读取语义和观测策略。`readPage` 返回带行号的行和视图元数据；基础服务按 owner 存储文件状态，并区分 `full` 与 `partial` 读取。这些是有用的策略，但它们不是文件系统提供方的原语。字面文本变更则不同：版本守卫、字面匹配、歧义检测与原子重写必须留在提供方的变更边界内，但当前的 `applyEdit` 命名及其周围的 seam 将这一提供方操作绑定到了旧的读后编辑策略形状上。

这还造成了一个真实的用户体验死胡同：窗口化读取记录 `view: partial`，而 partial 视图无法授权 `edit`。一个模型读取了大文件的第 100-150 行，如果想编辑第 120 行，就必须先获取一次 `full` 读取，而对于超过读取上限的文件这可能做不到。字面编辑实际上只需要新鲜度：被匹配的字节仍然来自模型所读取的那个版本即可。

旧 Agent Note 已经推迟了独立的 `@deepseek-ai/dsh-fs-observation-policy` 包。本决策构建该层，使 `ctx.fs` 保持接近 fsspec 风格的存储原语（`info`/`cat`/`open`），但不把它变成完整的 fsspec。

## 决策

将栈拆为四层：

```text
tool          dsh-tool-fs       model-facing schemas + read windowing + text rendering; the EXECUTOR (reads/writes/edits via ctx.fs, dispatches the fs/* events)
policy        dsh-fs-observation-policy  observed-state + read-before-edit + write/edit freshness, contributed through the fs/* event gate (no service)
provider contract dsh-fs            ctx.fs: text IO + atomic mutation primitives (optional version guard)
provider      dsh-fs-local      local implementation of ctx.fs
```

`dsh-tool-fs` 保持相同的面向模型的 `read`/`write`/`edit` schema。它是执行器：注入 `fs`（不是策略服务）并直接访问 `ctx.fs`，拥有读取窗口化逻辑，并分发 `fs/*` 事件以便 `dsh-fs-observation-policy` 进行门控和记录。

本 Agent Note 决定了四层拆分、提供方约定和新鲜度策略。随后，[事件门禁 Agent Note](../architecture/2026-06-26-file-context-as-event-gate.zh.md) 细化了工具↔策略耦合：`dsh-fs-observation-policy` 是通过 `fs/*` 事件参与的门禁插件，而非 `ctx.fileContext` 方法服务，因此工具不会在方法层与其耦合；读取窗口和 fs I/O 位于 `dsh-tool-fs`。本文描述已经落地的事件门禁形状；提供方的版本守卫可选（省略即无条件裸提供方）。

## 提供方约定

`@deepseek-ai/dsh-fs` 收缩为提供方文本 IO 加受保护的文本变更：

```ts ignore-check
abstract resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
abstract stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
abstract readText(target: FsTarget, signal?: AbortSignal): Promise<string>
abstract streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>
abstract writeText(target: FsTarget, content: string, expected: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome>
abstract editText(target: FsTarget, edit: FsEditRequest, expected: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome>

interface FsInfo {
  version: FsVersion
  type: 'file' | 'directory' | 'other'
  size?: number
}

type FsWriteIntent =
  | { kind: 'createIfAbsent' }
  | { kind: 'replaceIfVersion'; version: FsVersion }
```

`stat` 返回元数据而非内容。`version` 是新鲜度令牌；`type` 让执行器在读取前拒绝目录/特殊文件；`size` 让 `read` 工具无需通过失败探测即可选择 `readText` 还是 `streamText`。`undefined` 表示目标不存在。

`readText` 读取整个普通文本文件。`streamText` 以相同的文本语义流式读取大文件。两个提供方原语负责普通文件检查、UTF-8 解码、二进制/NUL 拒绝以及 `FS_NOT_TEXT`；策略层从不处理原始字节，也不重新实现跨分片解码。`readText` 是小文件/直接全文件原语，而面向模型的大文件读取使用 `streamText`。

`writeText` 通过临时文件 + rename 实现原子写入，并带有显式的写入期望。`createIfAbsent` 创建不存在的目标，对已存在的目标以 `FS_NOT_OBSERVED` 拒绝；这是 owner 没有先前读取时使用的路径。`replaceIfVersion` 仅在目标以观测到的版本存在时替换；目标不存在或版本不匹配时抛出 `FS_STALE_VERSION`。

`editText` 是提供方级别的受保护文本变更。启用守卫时，它首先验证目标仍以 `expected.version` 存在，然后读取当前文本、应用字面替换并原子写入。陈旧检查必须在字面匹配之前发生，这样基于旧读取的编辑会报告 `FS_STALE_VERSION`，而不是对更新内容进行匹配后报告 `FS_EDIT_NOT_FOUND` 或 `FS_AMBIGUOUS_EDIT`。将此原语保留在提供方约定上，保持了后端本地锁定的能力，也让未来的远程后端能够实现原生的 compare-and-edit，而无需策略层拉取整个文件。

这是一个*文本存储* seam，刻意比字节级 fsspec（`cat`/`open` 返回原始字节）高半个层次。UTF-8 解码、二进制/NUL 拒绝、受保护的全文件写入和受保护的字面文本编辑都在提供方内完成，因此策略层从不接触原始字节、不重新实现跨分片解码、也不将陈旧检查与变更临界区分离。面向模型的概念仍然不下沉到提供方：行窗口、带行号的行、渲染的页脚、观测状态存储都不会泄漏下去。

从 `dsh-fs` 删除：`readPage`、`FsExpectation`、`FsView`、`FsStateSource`、`FsReadRequest`、`FsTextLine`、行/窗口常量、`formatReadBody` 和 observed-state `WeakMap`。`applyEdit` 由更窄的提供方原语 `editText` 取代，其约定是带版本守卫的字面文本变更，而非策略层读取授权。`FS_PARTIAL_OBSERVATION` 错误码也从 `FsErrorCode` 分类体系中移除：新鲜度授权没有部分/完整之分，因此没有任何路径会抛出它。`FsTargetKey` 和 `FsVersion` 按现有[品牌化 id Agent Note](../../archived/architecture/2026-06-20-branded-ids.md) 成为品牌化不透明 id。

## 策略约定

`@deepseek-ai/dsh-fs-observation-policy` 是插件，而非服务：它不注册任何 `ctx.*` 键，也不注入任何内容。它拥有不应位于 `FileSystem` 提供方基类上的写入/编辑新鲜度策略和 observed state（否则沙箱/远程后端会继承不该由其承载的面向模型观察策略）。它通过执行器分派的 `fs/*` 事件门禁贡献该策略。

观测状态以 `WeakMap<owner, Map<targetKey, FsVersion>>` 的形式存放于此。当且仅当 owner 读取、写入或编辑过该目标时，条目才存在（每次成功都会发出 `fs/observed`），因此条目的存在*本身就是*先前观测的记录——没有单独的 `hasRead` 标志。owner 从不透明的事件 actor（`{ agent?: { session? } }`）结构化派生，该形状定义在 `dsh-fs-observation-policy` 中而非 `dsh-fs` 中。

该插件决定三个 `fs/*` 事件：

- `fs/write-intent`——无先前观测 ⇒ `{ kind: 'createIfAbsent' }`（只有新文件可以盲创建）；有先前观测 ⇒ `{ kind: 'replaceIfVersion', version: vObserved }`（已有文件仅在自观测以来未变时才替换）。单槽决策；不调用 `next()`。
- `fs/edit-intent`——要求 owner 有先前观测（否则 `FS_NOT_OBSERVED`）；返回 `{ version: vObserved }` 作为 CAS 基础。它不实现字面替换——它授权并提供版本，提供方的变更临界区负责应用守卫，因此基于同一观测版本的并发编辑仍然是一个成功，另一个因版本陈旧而失败。
- `fs/observed`——在成功的读取/写入/编辑后，为该 owner+target 记录 `{ version }`。同步、仅副作用的 `WeakMap.set`。

该插件不做任何文件系统 I/O：「你是否观测过此文件？」是一次 `WeakMap` 查找，而「你读取的版本是否仍然是当前版本？」在 `ctx.fs.editText`/`writeText` 内部、与执行变更相同的原子锁中决定——插件只提供 `vObserved` 作为基础。

## 工具约定

`dsh-tool-fs` 保持相同的 schema 和提示词表面。`read` 仍然暴露 `file_path`、`offset` 和 `limit`；`write` 和 `edit` 不变。它是执行器：验证模型参数，通过 `ctx.fs` 直接读取/写入/编辑，拥有行窗口化和结果渲染（`N: text`、页脚、`<path>/<content>` 封装），并分发 `fs/*` 事件。

每个变更操作先分发其 intent waterfall（瀑布式事件），带有 `undefined` 裸提供方默认值，然后调用 `ctx.fs`，再发出 `fs/observed`。例如 `write` 执行 `ctx.waterfall('fs/write-intent', target, exec, () => undefined)` → `ctx.fs.writeText(target, content, intent)` → `ctx.emit('fs/observed', …)`。`read` 先 stat 一次，然后读取/流式读取，构建窗口，最后发出 `fs/observed`。将 `exec` 作为 actor 传递，让 `dsh-fs-observation-policy` 无需工具深入策略即可派生 owner。

由于策略通过带有 `undefined` 默认值的事件贡献，`dsh-tool-fs` 不与 `dsh-fs-observation-policy` 产生方法耦合：在插件缺席时，每个 intent waterfall 都落到 `undefined`（无条件裸提供方写入/编辑），`fs/observed` 没有监听器。加载插件后即可叠加读后写/编辑策略。

## 并发边界

进程内更新是安全的：本地后端保持既有的按目标变更锁，因此版本检查-然后-rename 是串行化的，失败的更新会看到 `FS_STALE_VERSION`。

进程内创建由同一个按目标变更锁保护：两个调用者以 `createIfAbsent` 竞争时串行化，一个创建成功，另一个看到目标已存在并收到 `FS_NOT_OBSERVED`。跨进程创建仅为尽力而为；本地的 stat-then-rename 守卫无法在所有未来后端上提供可移植的排他创建保证。

跨进程写入是尽力而为的新鲜度加原子替换：`mtime:size` 通常能捕获编辑器保存，但可能检测不到同一 tick 内大小相同的写入；原子的 temp+rename 防止文件撕裂但不能防止所有丢失更新。

## 取代

本 Agent Note 推翻[文件系统能力 seam](../../archived/architecture/2026-06-17-filesystem-capability-seam.md)中的两项决策，并收窄第三项：

- 读后写/编辑策略从 `ctx.fs` 移出，进入 `dsh-fs-observation-policy` 插件（通过 `fs/*` 事件门控）。
- 文本读取不再返回后端编号的行记录或 `full`/`partial` 视图；授权基于版本新鲜度，因此窗口化读取在文件未变时即可授权编辑。
- 字面编辑不再位于旧的 `applyEdit` API 之后（该 API 混合了后端变更与 seam 拥有的观测策略）。它作为 `editText` 保留为提供方原语，因为版本守卫 + 字面匹配 + 原子重写必须留在提供方的变更临界区内。

保留的内容：Service Definition / Service Provider / Consumer 纪律、消费方不导入后端规则、后端定义的 target/version/display 元数据、原子本地写入，以及共享的 `FsError` 分类体系。

## 验证

`dsh-fs` 精确暴露 `resolve`/`stat`/`readText`/`streamText`/`writeText`/`editText`（`stat` 返回 `FsInfo | undefined`，`writeText` 接受 `FsWriteIntent`），已删除的类型/原语不再存在；`dsh-fs-local` 不包含行、视图或 `formatReadBody` 逻辑；面向模型的 schema 保持逐字节不变。测试固定了以下行为：窗口化读取授权对未变文件的后续编辑；基于陈旧读取的编辑在尝试字面匹配之前报告 `FS_STALE_VERSION`；版本 CAS 行为得以保留；观测约定成立（`read` 工具的读取记录观测状态；直接 `ctx.fs` 读取不记录）；`dsh-fs-observation-policy` 具有 HMR（热模块替换）/dispose（资源释放）测试覆盖。

## 后续扩展

后来，[为文件系统 seam 添加直接目录列表](../../archived/architecture/2026-07-03-filesystem-directory-listing-seam.md)进一步扩展了该 seam。该后续工作单独记录，使本文继续描述最初落地的 fsspec 风格改造。

## 曾考虑的替代方案

- **字节级 fsspec（`cat`/`open` 返回原始字节）**：否决。该 seam 刻意定位为文本存储，比字节级高半个层次，这样 UTF-8 解码、二进制/NUL 拒绝和受保护的文本变更只在提供方实现一次，策略层从不接触原始字节，也不将陈旧检查与变更临界区分离。
- **具体的 `ctx.fileContext` 方法服务**——本 Agent Note 最初的策略形状；[事件门禁 Agent Note](../architecture/2026-06-26-file-context-as-event-gate.zh.md) 将其重做为门禁插件，使工具永远不会在方法层与策略耦合。
- **在提供方保留 `readPage` 和 `full`/`partial` 视图授权**：「取代」一节所逆转的重构前形态。视图完整性不是编辑安全所需的，版本新鲜度才是；而视图规则使超过读取上限的大文件无法编辑。

## 后果

- 新增第四个 fs 包和一个新的插件层。这是有意为之：它是此前推迟的策略层，而非第二个抽象后端约定。
- 直接使用 `ctx.fs` 会绕过策略：直接 `ctx.fs.readText` 不发出 `fs/observed`，因此在默认策略下，后续 `edit` 会以 `FS_NOT_OBSERVED` 拒绝，直到通过 `read` 工具读取该文件。这一失败是显式且有文档记录的。
- 大文件行窗口化从后端移至 `dsh-tool-fs` 中的 `read` 工具；文本解码和二进制拒绝留在 `ctx.fs.streamText` 中，因此这只是窗口化逻辑的迁移，而非第二套文本 IO 实现。
- 将 `editText` 保留在提供方约定上意味着每个后端都必须实现字面替换约定。这是有意为之：该操作不是纯存储，但陈旧守卫 + 字面匹配 + 原子重写是必须保持在一起的单元，以确保正确的错误归因和并发行为。该约定应保持窄且仅限文本，以便未来后端可以原生实现或通过全文件重写实现。
- 新鲜度允许在窗口化读取后进行全文件 `write`。这比旧的视图检查更弱，但避免了大文件无法编辑的问题；提示词引导仍然不鼓励盲目的全文件替换。
