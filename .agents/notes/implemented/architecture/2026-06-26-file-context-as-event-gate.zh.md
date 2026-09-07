# Agent Note: 将 `dsh-fs-observation-policy` 改为事件门禁插件，而非方法接口

Status: implemented

[English](2026-06-26-file-context-as-event-gate.md) | 中文

## 问题

[拆分文件系统 seam Agent Note](../simplification/2026-06-26-fsspec-style-fs-seam.zh.md) 在面向模型的工具与 `ctx.fs` 提供方之间放置了 `ctx.fileContext`：`dsh-tool-fs` 注入 `fileContext`，并将每次 `read`/`write`/`edit` 路由到它的方法。这使得 `fileContext` **位于关键路径上且不可省略**。工具不经过它就无法访问 `ctx.fs`，策略层掌控着 fs I/O 和读取窗口，而一个不需要观测状态策略的部署也无法简单地移除该包——`dsh-tool-fs` 会因无法解析 `ctx.fileContext` 而失败。

这把三件本应可分离的事情耦合在了一起：

1. **工具做什么**——解析路径、读取窗口、写入/编辑文件。这是工具的职责，只需要 `ctx.fs`。
2. **新鲜度/观测策略**——「编辑前必须先读」、「写入/编辑必须基于你读到的版本」。这是 `dsh-fs-observation-policy` 插件的职责。
3. **观测状态的记录**——一个副作用，永远不应阻止工具正常运行。

由于工具调用的是 `fileContext` 方法，移除策略层就是一个破坏性变更，而非优雅地失去一个*附加*能力。策略层对工具的运行是承重性的，而非可选的收紧。

## 决策

反转控制流。**`dsh-tool-fs` 成为执行器，直接调用 `ctx.fs`**；**`dsh-fs-observation-policy` 成为门控 + 记录插件**，通过事件参与，从不通过工具调用的方法，也不注册 `ctx.fileContext` 服务。

```text
tool          dsh-tool-fs       executor: resolves, reads windows, writes/edits via ctx.fs;
                                emits fs policy events; renders results
policy        dsh-fs-observation-policy  plugin: listens to fs/write-intent +
                                fs/edit-intent (single-slot waterfall) and fs/observed
                                (emit) events; adds observed-state + freshness.
provider contract dsh-fs            ctx.fs: text IO + ATOMIC mutation primitives whose version
                                guard is OPTIONAL; owns the fs policy event vocabulary
provider      dsh-fs-local      local implementation of ctx.fs
```

该模型是叠加式的：裸 `ctx.fs` 执行原子化、无约束的文本 I/O，而 `dsh-fs-observation-policy` 叠加观测状态、先读后编辑和版本守卫。因此移除策略层后工具仍可用，只是不受约束。正式发布的 agent（智能体）配置会加载策略；裸模式的存在是为了让策略在服务边界保持可选，而非作为正常部署姿态。

[文件系统缺失观测后续决策](../../archived/bug-fix/2026-08-09-filesystem-absence-observation.md)把记录载荷从仅表示成功的版本细化为显式的存在/缺失状态，并要求带防护的创建以不替换方式发布。事件门控归属与无 I/O 策略边界保持不变。

`dsh-tool-fs` 不再注入 `fileContext`。它注入 `fs` 和 `tools`/`systemPrompt`。

## 策略由提供方 CAS 强制执行，而非 `dsh-fs-observation-policy` 的 stat

`dsh-fs-observation-policy` 强制执行「你必须基于你读到的版本来写入/编辑」，**自身从不调用 `stat` 或比较版本**。它将观测到的版本作为 CAS 基准提供，让提供方的 mutation 临界区检测陈旧性：

- 「该所有者最近观测到了什么？」是 `dsh-fs-observation-policy` 在本地决定的唯一事项——一次 `WeakMap` 查找，无 I/O。无记录表示未见；缺失记录只允许带防护的创建；存在记录携带替换/编辑基准。
- 「版本是否仍然有效，或者创建目标是否仍然缺失？」由**提供方的原子变更边界内部**决定。`dsh-fs-observation-policy` 提供 `replaceIfVersion` 或 `createIfAbsent`；对于已经变化的版本，提供方抛出 `FS_STALE_VERSION`；带防护的创建若败给另一个创建者，则抛出 `FS_NOT_OBSERVED`。

这是有意为之的。如果 `dsh-fs-observation-policy` 在其 waterfall（瀑布式事件）处理器中 stat 并比较版本，该检查与工具实际写入之间会存在 TOCTOU 间隙——文件可能在此期间变化，因此该检查只是一个虚假保证，提供方的锁无论如何都要兜底。将版本检查放在提供方的临界区中既无竞态又无额外 `stat`。所以 `dsh-fs-observation-policy` **不做**任何文件系统 I/O；「必须基于最近一次读取」的保证由 CAS *实现*，`dsh-fs-observation-policy` 只负责选择基准（`vObserved`）并对先前观测进行门控。

## 提供方约定变更：版本守卫变为可选

为使裸提供方不受约束，其两个 mutation 上的版本守卫变为**可选**——传入则守卫，省略则无条件执行：

```ts ignore-check
// writeText: expected is now optional. The FsWriteIntent union is UNCHANGED.
writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome>
//   undefined          → unconditionally create-or-overwrite (bare default)
//   createIfAbsent     → create only, reject an existing file (dsh-fs-observation-policy, unobserved)   [unchanged]
//   replaceIfVersion   → overwrite only at the observed version, else FS_STALE_VERSION    [unchanged]

// editText: expected becomes optional (was the required { version: FsVersion }).
editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome>
//   undefined    → unconditionally replace literal text in the current content (bare default);
//                  a missing target still reports FS_STALE_VERSION
//   { version }  → edit only at that version, else FS_STALE_VERSION (the current behavior)
```

`FsWriteIntent` 联合类型本身不变——第三种「无条件」状态通过*省略* `expected` 来表达，因此两个 mutation 共享同一种对称形状（`expected?`：省略 = 无守卫，传入 = 有守卫）。这对 `dsh-fs-observation-policy` 使用的有守卫路径保持完全向后兼容；只有之前不可能出现的「无守卫」情况是新增的，且它是裸提供方的默认行为。无论哪种情况，mutation 仍在后端的 per-target 锁内运行，因此无条件写入/编辑仍是原子的（不会产生撕裂文件）；「无条件」去掉的是*版本*前置条件，而非原子性。`editText` 在有守卫和无守卫路径上都将缺失目标报告为 `FS_STALE_VERSION`，保持一个统一的编辑失败码表示「此刻无法编辑该目标」。

## 事件词汇（由 `dsh-fs` 拥有）

事件定义在 `@deepseek-ai/dsh-fs` 中，而非 `dsh-fs-observation-policy` 中。这是解耦约定所迫：`dsh-tool-fs` 是发射方，因此它必须引用事件类型，且即使 `dsh-fs-observation-policy` 不再提供方法服务，它也必须能编译通过。`dsh-fs` 是 `dsh-tool-fs` 和 `dsh-fs-observation-policy` 都已依赖的包，因此它是唯一能让发射方和策略监听方共享词汇而不让发射方依赖策略插件的归属地。

这些事件携带既有的 `dsh-fs` 词汇（`FsTarget`、`FsVersion`、`FsObservation`、`FsWriteIntent`）加一个不透明的 actor——不携带面向模型的概念（行窗口、行号或渲染后的页脚不会泄漏到此层）。

**两个 `fs/*` 决策事件是单槽、先到先得的 waterfall。** `dsh-fs-observation-policy` 不调用 `next()` 直接返回，因此在默认部署中它占据该槽位；更早注册或使用 `prepend` 的监听器会替代该策略。权限、审计和沙箱关注点仍留在可组合的 `tools/execute` waterfall 上。

actor 在 `dsh-fs` 中类型为 `object`——一个纯粹的不透明载体，提供方约定从不读取或收窄它。owner 的推导（`actor.agent?.session`）和 `{ agent?: { session? } }` 结构形状完全留在 `dsh-fs-observation-policy` 内部，由其在监听器中将 `object` actor 收窄为该形状。`dsh-fs` 拥有事件名和 fs 词汇；它不拥有策略层的运行时 owner 结构。

```ts
import type { FsObservation, FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'

interface Events {
  /**
   * Single-slot decision: produce the write expectation for the next
   * ctx.fs.writeText. The default returns undefined (unconditional create-or-
   * overwrite — the bare provider). The policy listener returns createIfAbsent
   * (unobserved) or { kind: 'replaceIfVersion', version: vObserved } (observed).
   * The listener does NOT call next(): one decision, not a composable chain. @mode waterfall
   */
  'fs/write-intent'(target: FsTarget, actor: object | undefined, next: () => FsWriteIntent | undefined | Promise<FsWriteIntent | undefined>): Promise<FsWriteIntent | undefined>
  /**
   * Single-slot decision: produce the optional version guard for the next
   * ctx.fs.editText. The default returns undefined (unconditional edit of the
   * current content — the bare provider; no stat). The policy listener returns
   * { version: vObserved }, or throws FS_NOT_OBSERVED if the actor is unset or
   * has not observed the target. Does NOT call next(): one decision. @mode waterfall
   */
  'fs/edit-intent'(target: FsTarget, actor: object | undefined, next: () => { version: FsVersion } | undefined | Promise<{ version: FsVersion } | undefined>): Promise<{ version: FsVersion } | undefined>
  /**
   * Record that an actor observed a target as present at a version or absent.
   * Fire-and-forget (plain emit). Listeners MUST be
   * synchronous, side-effect-only recorders (`dsh-fs-observation-policy`'s is a WeakMap
   * write); the tool does not guard the emit, so a throwing listener surfaces as
   * the tool's isError result. No listener ⇒ nothing recorded.
   * @mode emit
   */
  'fs/observed'(target: FsTarget, observation: FsObservation, actor: object | undefined): void
}
```

`fs/*` 决策事件是**由工具分发的无绑定 waterfall**（类似 `agent/request`，由循环分发且无 `this`），而非服务绑定的 waterfall（如 `llm/stream`）。分发者是 `dsh-tool-fs` 插件，它不是一个服务。

## 工具约定（`dsh-tool-fs`）

工具保留其面向模型的 schema（`read`/`write`/`edit`，逐字节不变）和提示词段落。提示词引导仍以策略优先，因为加载 fs 工具的部署预期也会加载 `dsh-fs-observation-policy`：模型仍被告知在覆写或编辑前先读取，而该要求来自 fs-observation-policy 插件，并非后端。裸提供方回退不改变提示词立场。

`dsh-tool-fs` 获得从旧 `fileContext` 方法服务迁移来的执行器职责，包括**读取渲染**（`read-render.ts`：`buildWindow` + `formatReadOutput`、`READ_MAX_BYTES`、`READ_MAX_LINE_LENGTH`、`FileReadOutcome`/`FileTextLine`，以及 `read.ts` 中的 `STREAM_MIN_SIZE`），这些现在是工具的渲染细节，因为读取已由工具拥有。这些读取渲染类型和辅助函数移入 `dsh-tool-fs`；策略插件不得继续作为工具的类型依赖。

`dsh-tool-fs` 是一个注册全部三个工具（`read`/`write`/`edit`）的单一根插件，与 `dsh-tool-bash` 相同。它注入 `fs`（加 `tools`/`systemPrompt`），从不注入 `fileContext`。（最初的提案还将每个工具作为 `/read`/`/write`/`/edit` 子路径插件暴露，供聚焦部署使用；实现时被放弃——没有消费方需要单工具部署，且子路径发布迫使引入兄弟工具包都不需要的定制 `tsdown`/`tsconfig`/`files`/workspace-constraint 处理。每工具的注册辅助函数（`applyReadTool`/`applyWriteTool`/`applyEditTool`）仍作为根插件组合的内部模块保留。）

通过让 waterfall 惰性产出期望值来最小化 `stat` 预算——裸默认返回 `undefined`（无守卫），从不 stat：

- **read**——一次 `stat`；元数据未命中时，在返回 `FS_NOT_FOUND` 前 emit `{ kind: 'absent' }`；目标为文件时，则依次执行 `readText`/`streamText`、`buildWindow`，再 emit `{ kind: 'present', version: info.version }`。旧 `fileContext.read` 中读后确认的 `stat` 仍保持移除；在路由 stat 和读取之间竞争的写入者最多只能使后续带防护的编辑误报陈旧。
- **write**——`expectation = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)`，然后 `ctx.fs.writeText(target, content, expectation)`，再 emit 表示存在的结果版本。无论是否有 `dsh-fs-observation-policy`，**工具内零 stat**。
- **edit**——`expectation = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)`，然后 `ctx.fs.editText(target, edit, expectation)`，再 emit 表示存在的结果版本。两种情况下**工具内零 stat**：裸默认为 `undefined`（无条件编辑），因此工具从不 stat 来制造基准。如果裸路径上的目标不存在，提供方报告 `FS_STALE_VERSION`；策略已持有缺失观测时，则直接返回 `FS_NOT_FOUND`。

工具在每次分发时将 `exec`（工具执行上下文）作为 `actor` 参数传入，以便 `dsh-fs-observation-policy` 推导其观测状态的 owner。工具不知道策略插件是否存在：它始终在 `next` thunk 中提供裸默认行为，而 `dsh-fs-observation-policy` 在默认部署中会在 thunk 运行前短路它。

**`fs/observed` 在操作成功后，以及元数据探测确认缺失后触发。** 其监听器必须是同步、不抛异常的记录器；工具不对 plain emit 做保护，因此抛异常的监听器可能取代待返回的读取错误，或在 mutation 已成功后报告失败。异步或可失败的观测需要另一份事件约定。

## 策略插件约定（`dsh-fs-observation-policy`）

`dsh-fs-observation-policy` 是插件，不是服务。它不注册 `ctx.fileContext`，没有公开方法面，不暴露 `read`/`write`/`edit`/`resolve` 方法。它通过 `ctx.on()` 注册三个监听器（每个返回一个 disposer 用于 HMR（热模块替换））。它维护观测状态 `WeakMap<owner, Map<targetKey, FsObservation>>`，以及结构化的 owner 推导（将事件中不透明的 `object` actor 收窄为自己的 `{ agent?: { session? } }` 形状），但不注入 `fs`——每个处理器只操作自己的 `WeakMap`，从不操作 `ctx.fs`。

- `fs/write-intent` 监听器：未见/缺失 ⇒ `createIfAbsent`；存在 ⇒ `replaceIfVersion`。它不调用 `next()`：完全占据单一决策槽位。
- `fs/edit-intent` 监听器：未见 ⇒ `FS_NOT_OBSERVED`；缺失 ⇒ `FS_NOT_FOUND`；存在 ⇒ 返回其版本守卫。同样不调用 `next()`。
- `fs/observed` 监听器：记录存在/缺失的可辨识值。

一条观测状态条目是**先前观测记录**，但其可辨识字段会影响决策。成功的 read/write/edit 会记录存在状态及版本，使 create-then-edit 或 edit-then-edit 序列无需中间重新读取即可工作。确认缺失的 read/view 会用缺失状态取代旧的正向版本，因此只允许带防护的创建；随后成功的创建会再用新的存在版本取代缺失状态。只有条目不存在才表示未见，并使 edit 返回 `FS_NOT_OBSERVED`。owner 从 `{ agent?: { session? } }` 结构化推导；dispose 时丢弃所有状态（HMR 安全）。

`dsh-fs-observation-policy` 现在是一个纯策略/记录插件，没有服务 API——它只通过事件门禁影响外界。这正是移除 `dsh-tool-fs` 方法耦合的关键。

## 裸提供方行为（无 `dsh-fs-observation-policy`）

这不是预期的部署姿态——加载 fs 工具的配置预期也会加载 `dsh-fs-observation-policy`。它是工具不再耦合于策略方法服务后所存在的无约束提供方下限。当 `dsh-fs-observation-policy` 不存在时，每个 `fs/*` waterfall 落入其 `undefined` 默认值，`fs/observed` 无监听器：

- **read** 行为不变（它从不需要策略；只是 emit 了一个现在无人监听的 `fs/observed`）。
- **write** 无条件 create-or-overwrite：`expected` 为 `undefined`，因此 `writeText` 无论文件是否存在、无论当前版本如何都直接写入。无先读要求，无版本检查。
- **edit** 无条件替换文件当前内容中的字面文本：`expected` 为 `undefined`，因此 `editText` 无版本守卫、无先读要求地匹配并重写（`FS_EDIT_NOT_FOUND`/`FS_AMBIGUOUS_EDIT` 仍适用——它们关乎字面匹配，而非新鲜度）。缺失目标仍报告 `FS_STALE_VERSION`，与有守卫编辑路径的「此刻无法编辑该目标」错误码一致。

两个 mutation 仍是原子的（后端的 per-target 锁是无条件的）。仅仅是*不存在*（而非丢失）的是 `dsh-fs-observation-policy` 本会叠加的策略：观测状态、先读后编辑和版本守卫的写入/编辑。加载 `dsh-fs-observation-policy` 后，其监听器返回有守卫的 `expected` 值而非 `undefined`，从而叠加这些约束；裸提供方本身无需任何变更。

## 取代关系

本 Agent Note 修正——而非推翻——[拆分文件系统 seam Agent Note](../simplification/2026-06-26-fsspec-style-fs-seam.zh.md)。四层拆分、提供方约定和新鲜度*策略*均保留。变更的是**工具与策略层之间的耦合方式**：强制性方法服务变为插件拥有的事件门控，fs I/O + 读取窗口从 `fileContext` 上移至 `dsh-tool-fs`。拆分文件系统 seam Agent Note 中关于 `dsh-tool-fs` 注入 `fileContext` 以及 `fileContext` 拥有 `read`/`write`/`edit` 的描述已在同一变更中更新。

## 验证

测试固定了两条路径：无 `dsh-fs-observation-policy` 时，根工具插件对 `dsh-fs-local` 启动，read、create、overwrite 和未读 edit 均成功；有策略时，未读 edit 返回 `FS_NOT_OBSERVED`，未读 overwrite 被 `createIfAbsent` 门控。策略决定后，后注册的 intent 监听器不会被触达。陈旧编辑通过提供方 CAS 失败，而策略不执行 `stat`；工具预算在两条路径上保持 read 一次 `stat`，write 或 edit 均为零次。测试也组装了删除恢复路径：陈旧变更、重新读取时确认缺失、带防护的重新创建。面向模型的 schema 逐字节不变，但恢复后的结果 transcript（文本记录）发生变化。

## 曾考虑的替代方案

- **保留 `ctx.fileContext` 作为关键路径上的方法服务**——[拆分文件系统 seam Agent Note](../simplification/2026-06-26-fsspec-style-fs-seam.zh.md) 最初落地的形态；否决，因为工具无法在没有策略层的情况下运行，使策略对基本操作是承重性的，而非可选的收紧。
- **策略侧版本检查**（`dsh-fs-observation-policy` 在其 waterfall 处理器中 stat 并比较版本）——否决，因为该检查与工具实际写入之间存在 TOCTOU 间隙；提供方的 mutation 临界区是唯一无竞态的位置，因此策略只选择 CAS 基准并对先前观测进行门控。
- **每工具 `/read`/`/write`/`/edit` 子路径插件**——实现时放弃：没有消费方需要单工具部署，且子路径发布迫使引入兄弟工具包都不需要的定制 `tsdown`/`tsconfig`/`files`/workspace-constraint 处理；每工具的注册辅助函数仍作为根插件组合的内部模块保留。

## 后果

- **事件间接层取代方法调用。** 一次 waterfall + emit 不如 `await ctx.fileContext.edit(...)` 直接。收益是移除了工具到策略的方法依赖，同时保留默认策略插件；代价是多一套事件词汇需要学习。通过保持三个事件的窄小范围并在每个事件上记录 default-thunk 语义来缓解。
- **策略事件位于存储 seam 中。** `dsh-fs` 增加了两个版本决策事件和一个记录事件，尽管它「只是存储」。这是解耦的代价（发射方不能依赖策略插件）。这些事件只携带 `dsh-fs` 词汇加一个不透明的 `object` actor，不携带面向模型的概念，因此 seam 不沾染行窗口/观测策略类型，也不沾染 agent/会话所有者结构。
- **单一策略占位者，按惯例先到先得。** `fs/write-intent`/`fs/edit-intent` 槽位恰好容纳一个决策者；先注册（或 `prepend`）的监听器获胜，其余被短路。`dsh-fs-observation-policy` 占据该槽位是部署惯例，而非事件系统强制的不变式——一个先注册的第二决策者会绕过它。这是可接受的，因为第二个 fs 版本策略决策者是配置错误，而非功能。如果未来出现*分层* fs 版本策略的需求，那是一个新 Agent Note（可组合的值传递 waterfall），而非在这些事件上静默添加第二个监听器。分层的权限/审计/沙箱拦截已有其归属：`tools/execute`。
- **移除读后确认 stat** 使后续*有守卫*的编辑在 read/write 竞争下偶尔为安全起见拒绝写入（`FS_STALE_VERSION` → 重新读取）。这是丢失的 UX 便利，绝非正确性漏洞；提供方锁仍阻止基于错误版本的写入。
- **裸提供方不做先读后写/编辑，也不做版本检查。** 没有 `dsh-fs-observation-policy` 的部署允许模型无条件覆写或编辑任何已有文件。这正是保持工具独立于策略服务的有意含义：安全纪律存在于 `dsh-fs-observation-policy` 插件中。省略它的部署是有意选择无约束的文件系统；对于发布 fs 工具的配置而言，这不是预期的姿态。
