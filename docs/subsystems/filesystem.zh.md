# 文件系统

[English](filesystem.md) | 中文

可选的文件系统能力由四个部分组成：[dsh-fs](../../packages/fs/fs) 拥有 `ctx.fs` 以及带可选守卫的原子文本操作；[dsh-fs-local](../../packages/fs/fs-local) 实现本地磁盘后端；[dsh-fs-observation-policy](../../packages/fs/fs-observation-policy) 记录观测到的存在或缺失状态，并通过事件（而非服务）添加新鲜度规则；[dsh-tool-fs](../../packages/fs/tool-fs) 直接执行面向模型的 read/write/edit 调用并渲染窗口。它位于 agent loop（智能体循环）主干之外；替换后端不会改变策略或工具 schema。

`dsh-fs-observation-policy` 是可选插件。没有该插件时，`FileSystem` 服务定义、一个提供方和 `dsh-tool-fs` 消费方组成完整且不受约束的文件系统 seam：`write` 无条件创建或覆盖，`edit` 无条件替换字面文本。策略插件通过裁决 `fs/*` waterfall（瀑布式事件）来改变这些操作。移除该插件不会破坏工具，因为工具调用 `ctx.fs` 并分发事件，而不调用策略方法。加载了 `dsh-tool-fs` 的部署也应加载 `dsh-fs-observation-policy`，使默认行为为「先读后写/编辑」。

提供方源码：[`packages/fs/fs/src/types.ts`](../../packages/fs/fs/src/types.ts) 与 [`packages/fs/fs/src/index.ts`](../../packages/fs/fs/src/index.ts)。策略源码：[`packages/fs/fs-observation-policy/src/types.ts`](../../packages/fs/fs-observation-policy/src/types.ts)。读取渲染源码：[`packages/fs/tool-fs/src/read-render.ts`](../../packages/fs/tool-fs/src/read-render.ts)。

## 目标标识与元数据（提供方约定）

每个操作首先将用户提供的路径解析为不透明的后端目标。消费方可以显示 `displayPath`，但禁止解析 `targetKey`（一个品牌化的不透明 id），也不得假设它是本地绝对路径。

与文件系统共享执行世界的消费方通过提供方获取跨能力坐标，而不是解释该身份：`processPath(target)` 返回子进程可以打开的规范化绝对路径；`processPathFromHostPath(hostPath)` 只在该执行世界共享相应宿主文件时映射其绝对路径；`fileUrl(target)` 返回采用提供方平台语法的 `file:` URI；`contains(parent, child)` 检查规范化身份相等或后代包含关系。

```ts type-equiv
/**
 * A path resolved by a backend into a stable identity. `resolve()` produces
 * this; every other operation takes it.
 */
interface FsTarget {
  /** Opaque key for stale guards and target lookup. */
  targetKey: FsTargetKey
  /**
   * Path for model/UI-facing output. May be a local absolute path,
   * workspace-relative path, or remote URI depending on the backend.
   */
  displayPath: string
}
```

后端拥有文件版本 token，即 write/edit 所守卫的新鲜度 token。策略插件存储它们以进行陈旧检查；消费方不解释其内容。两个 id 都是品牌化的不透明字符串。

```ts type-equiv
/**
 * Opaque key for stale guards and target lookup. The local backend uses a
 * realpath-like string; a remote backend might use a workspace URI or file id.
 * Consumers MUST NOT parse it or assume it is a local absolute path.
 */
type FsTargetKey = Branded<'FsTargetKey'>
```

```ts type-equiv
/**
 * Opaque file-version token — the freshness token a write/edit guards against.
 * The local backend derives it from high-resolution stat identity and freshness
 * fields; a remote backend might use a revision id. The policy layer records it
 * for stale checks; consumers may display related metadata but MUST NOT
 * interpret this token.
 */
type FsVersion = Branded<'FsVersion'>
```

`stat` 返回元数据（从不返回内容），目标不存在时返回 `undefined`。`type` 让消费方在读取前拒绝目录和特殊文件；`size` 让文本消费方无需通过失败探测即可选择 `readText` 还是 `streamText`。文本消费方在消费 `streamText` 时执行自己的保留量上限。原始字节消费方调用 `readBytes(target, signal, maxBytes)`；其必填的完整内容上限会使已知或读取中发现的超限以 `FS_TOO_LARGE` 失败，不会截断结果或无界缓冲。

```ts type-equiv
/**
 * Metadata about a target — what {@link FileSystem.stat} returns. Lets the
 * policy layer reject directories/special files before reading and choose
 * `readText` vs `streamText` from `size` without probing by failure. `version`
 * is the freshness token. `undefined` from `stat` means the target is absent.
 */
interface FsInfo {
  /** Opaque freshness token of the target right now. */
  version: FsVersion
  /** Whether the target is a regular file, a directory, or something else. */
  type: 'file' | 'directory' | 'other'
  /** Byte size of a regular file, when the backend can report it. */
  size?: number
}
```

`lstat` 是路径级、不跟随链接的元数据原语。它接收路径而不是 `FsTarget`，因为 `resolve` 会有意跟随 symlink 以产生稳定标识；需要检查信任边界的消费方可以先调用 `lstat`，在解析前拒绝 `symlink`。

```ts type-equiv
/**
 * Metadata about a path without following the final path component when it is a
 * symbolic link. Unlike {@link FsInfo}, this path-level probe can report
 * `symlink` so consumers with trust-boundary rules can reject repository-owned
 * links before resolving a target.
 */
interface FsPathInfo {
  /** Opaque freshness token of the path entry right now. */
  version: FsVersion
  /** Whether the path entry is a regular file, directory, symlink, or other. */
  type: 'file' | 'directory' | 'symlink' | 'other'
  /** Byte size of the path entry, when the backend can report it. */
  size?: number
}
```

`listDir` 按稳定的名称顺序返回直接子条目。每个条目携带子项的 basename、类型、已解析目标，以及后端能报告时的廉价元数据。它禁止读取文件内容，因此 `size` 仅用于普通文件，`version` 来自元数据。已损坏或已消失的子项可以作为 `other` 返回且不带元数据；列出或解析子项元数据时的权限或后端 I/O 失败会以 `FS_PERMISSION_DENIED` 或 `FS_IO_ERROR` 使整个列表操作失败。

```ts type-equiv
/**
 * One direct child returned by {@link FileSystem.listDir}. Listing returns
 * metadata and resolved targets only; it must not read file contents.
 */
interface FsDirEntry {
  /** Basename of the child inside the listed directory. */
  name: string
  /** Whether the child is a regular file, a directory, or something else. */
  type: 'file' | 'directory' | 'other'
  /** Resolved child target for follow-up operations. */
  target: FsTarget
  /** Opaque freshness token when the backend can report metadata cheaply. */
  version?: FsVersion
  /** Byte size of a regular file, when the backend can report it. */
  size?: number
}
```

## 写入与编辑守卫（提供方约定）

`writeText` 和 `editText` 的版本守卫都是可选的：省略守卫时执行无条件的裸提供方变更，提供守卫时则执行相应的条件检查。`writeText` 的守卫是 `FsWriteIntent`：`createIfAbsent` 在目标缺失时创建，目标已存在时以 `FS_NOT_OBSERVED` 拒绝；即使目标在提供方初始探测后才出现，也必须拒绝，因为发布操作本身不得替换。`replaceIfVersion` 仅在目标存在且版本匹配时替换，否则报 `FS_STALE_VERSION`。省略 `expected` 则无条件创建或覆盖。联合类型本身只包含两种有守卫的意图；「无守卫」通过省略表达，因此 write 和 edit 都使用同一个可选的 `expected` 字段。

```ts type-equiv
/**
 * Guarded write intent. `createIfAbsent` rejects an existing target with
 * `FS_NOT_OBSERVED`; `replaceIfVersion` rejects absence or mismatch with
 * `FS_STALE_VERSION`. Omitting the intent from `writeText` means unconditional
 * create-or-overwrite, not a third union arm.
 */
type FsWriteIntent =
  | { kind: 'createIfAbsent' }
  | { kind: 'replaceIfVersion'; version: FsVersion }
```

```ts type-equiv
/** Outcome of a full-file write. */
interface FsWriteOutcome {
  /** Whether the write created a new file or replaced an existing one. */
  operation: 'create' | 'update'
  /** Opaque version of the file after the write. */
  version: FsVersion
  /**
   * The file's content BEFORE the write, or `null` when the file did not exist
   * (a create) or the backend declined a contextual basis (for example, a
   * binary/non-UTF-8 prior file or either overwrite side reaching its exclusive limit).
   * LF-normalized storage text (the diff basis), never a diff — a consumer
   * computes the result-time contextual diff from `before`/`after` when
   * `before` is present, else falls back to a whole-file diff.
   */
  before: string | null
  /** The file's content AFTER the write, LF-normalized to share `before`'s diff basis. */
  after: string
}
```

`editText` 是提供方级别的变更操作，而非在别处组合的 `read` 加 `write`。带守卫时，它在字面匹配之前先验证预期版本（因此对陈旧内容的编辑报 `FS_STALE_VERSION`，而非对更新内容的匹配失败）；不带守卫时，它编辑当前内容。无论哪种路径，它都应用替换并原子写入——将匹配、行尾处理、陈旧检查和原子替换保持在一个变更临界区内——目标缺失时两条路径都报 `FS_STALE_VERSION`。

```ts type-equiv
/** A literal-replacement edit request. */
interface FsEditRequest {
  /** Literal non-empty text to replace. Must match exactly (after line-ending normalization). */
  oldString: string
  /** Literal replacement text. An empty string deletes the matched text. */
  newString: string
  /** Replace every match instead of requiring exactly one. */
  replaceAll: boolean
}
```

```ts type-equiv
/** Outcome of a literal edit. */
interface FsEditOutcome {
  /** Opaque version of the file after the edit. */
  version: FsVersion
  /**
   * The file's content BEFORE the edit. Raw storage text (LF-normalized by the
   * backend), never a diff — a consumer computes the result-time contextual diff
   * (the applied hunk with context) from `before`/`after`.
   */
  before: string
  /** The file's content AFTER the edit. */
  after: string
}
```

## fs 策略事件（提供方约定词汇）

`dsh-fs` 拥有三个事件，由工具分发、策略插件监听，使事件发出方（`dsh-tool-fs`）与监听方（`dsh-fs-observation-policy`）共享词汇，而事件发出方无需依赖策略插件。它们只携带 `dsh-fs` 词汇加一个不透明的 `object` actor，不含面向模型的概念，也不含 agent/会话所有者结构。

`fs/write-intent` 与 `fs/edit-intent` 是**单槽决策 waterfall**：工具分发时附带一个默认 thunk（返回 `undefined`，即裸提供方），监听方完全决策而不调用 `next()`。该 slot 按注册顺序先到先得——由策略插件占据是部署约定，而非强制不变式。`fs/observed` 是一个即发即弃的记录事件，携带 `FsObservation`：存在于某个版本，或确认缺失。该事件通过普通 `ctx.emit` 分发；其监听方必须是同步的、仅产生副作用，因为工具不会捕获该 emit 抛出的异常——抛出异常的监听方可能取代读取操作原本待返回的错误，或使工具在变更已经成功后返回 `isError` 结果。下方生成的 [cordis surface](#cordis-surface) 展示确切签名。

```ts type-equiv
/**
 * One authoritative observation of a target. A present observation carries the
 * version used by guarded replacement; an absent observation authorizes only a
 * guarded create, never an edit.
 */
type FsObservation =
  | { readonly kind: 'present'; readonly version: FsVersion }
  | { readonly kind: 'absent' }
```

## 执行上下文（策略插件）

策略插件只需要足够的执行上下文，通过收窄 `fs/*` 事件携带的不透明 `object` actor 来推导观测状态的所有者。`ToolExecution` 包含必需的字段，因此 `dsh-tool-fs` 将其执行对象作为 actor 直接传递，而无需让 `dsh-fs-observation-policy` 导入工具、agent 或会话包。

```ts type-equiv
/**
 * Minimal structural view of a tool execution the policy plugin needs to derive
 * an observed-state owner. `@deepseek-ai/dsh-tools`' `ToolExecution` contains
 * these fields, so the tool passes its `exec` straight through as the opaque
 * `object` actor on the `fs/*` events; this plugin narrows that actor to
 * `FsObservationActor` without importing `dsh-tools`, `dsh-agent`, or `dsh-session`.
 *
 * The owner is `agent.session` when present. It is treated as an opaque object
 * identity (a `WeakMap` key); this package never reads any of its fields.
 */
interface FsObservationActor {
  /** The agent on whose behalf the call runs, when there is one. */
  agent?: {
    /** The session that owns observed-file state, used as an opaque key. */
    session?: object
  }
}
```

## 读取结果（消费方 / 读取渲染）

文本读取受行窗口、字节上限和后端限制约束。达到字节上限后，扫描仍会继续，但不再保留更多行，因此 `totalLines` 仍为精确值。面向模型的 `read` 工具渲染的结果纯粹是展示性的；不存在 `full`/`partial` 视图区分——授权基于新鲜度（工具发出表示目标存在的 `fs/observed` 事件，并直接携带 stat 的版本），因此任何窗口化读取在文件未变时都能授权后续的 write/edit。元数据未命中时，工具会在返回 `FS_NOT_FOUND` 前 emit 缺失观测，使后续带守卫的写入可以重新创建外部删除的目标，但不会授权 edit。拥有读取操作的执行器 `dsh-tool-fs` 实现读取窗口化并构造该结果；策略插件不执行这些操作。

```ts type-equiv
/** Outcome of a bounded text read — what {@link formatReadOutput} renders. */
interface FileReadOutcome {
  /** 1-based first line requested. */
  offset: number
  /** Returned lines, already numbered. */
  lines: FileTextLine[]
  /** Exact total line count in the file. */
  totalLines: number
  /** Whether selected output hit the byte cap. */
  truncatedByBytes?: true
}
```

## 已观测文件状态（策略插件）

已观测状态是 `dsh-fs-observation-policy` 插件内部持有的 `WeakMap<owner, Map<targetKey, FsObservation>>`。映射中没有条目表示未见；`{ kind: 'absent' }` 表示 `read` 的元数据未命中，或 `str_replace_editor` 的 `view`、`str_replace`、`insert` 命令发生元数据未命中，从而确认缺失；`{ kind: 'present', version }` 表示 read、write 或 edit 观测到该版本。写入决策把未见和缺失映射到 `createIfAbsent`，把存在映射到 `replaceIfVersion`；编辑决策把未见映射到 `FS_NOT_OBSERVED`，把缺失映射到 `FS_NOT_FOUND`，把存在映射到其版本守卫。所有者从事件 actor 推导（通常是 `exec.agent.session`），被视为不透明且从不读取。dispose（资源释放）时丢弃全部数据（HMR（热模块替换）安全），策略不执行任何文件系统 I/O。

## 错误分类体系（提供方约定）

文件系统故障使用稳定的 `FsErrorCode` 字符串，由 `FsError`（`HarnessError`）携带。工具注册表在错误结果上保留 `{ name, code }`，使重试、权限和 UI 层可以按 code 分支而无需解析文本。

```ts type-equiv
/**
 * Stable, machine-routable codes for filesystem failures. Carried on
 * {@link FsError}; the tool registry exposes `{ name, code }` on `isError`
 * results so retry/permission/UI layers can branch without parsing messages.
 */
type FsErrorCode =
  | 'FS_NOT_FOUND'
  | 'FS_NOT_DIRECTORY'
  | 'FS_NOT_TEXT'
  | 'FS_NOT_REGULAR_FILE'
  | 'FS_TOO_LARGE'
  | 'FS_PERMISSION_DENIED'
  | 'FS_SANDBOX_DENIED'
  | 'FS_IO_ERROR'
  | 'FS_STALE_VERSION'
  | 'FS_NOT_OBSERVED'
  | 'FS_AMBIGUOUS_EDIT'
  | 'FS_EDIT_NOT_FOUND'
  | 'FS_ABORTED'
```

目录列表使用 `FS_NOT_DIRECTORY`、`FS_PERMISSION_DENIED` 与 `FS_IO_ERROR` 区分已存在但并非目录的目标、被拒绝的列表操作和意外的后端 I/O 失败。`FS_SANDBOX_DENIED` 是强制执行沙箱的后端（`dsh-fs-sandbox`）所作的策略拒绝——模式边界拒绝了写入/编辑——与 `FS_PERMISSION_DENIED`（宿主内核拒绝）不同。`FS_NOT_OBSERVED` 表示策略插件没有此所有者的先前观测记录（或 `createIfAbsent` 遇到了现有文件）。`FS_NOT_FOUND` 也表示策略因确认缺失而拒绝 edit。`FS_STALE_VERSION` 表示后端版本不再与观测到的版本匹配（或提供方本身收到针对缺失目标的 edit）。新鲜度授权没有部分/完整之分，因此不存在 `FS_PARTIAL_OBSERVATION`。

## 文件 IO 不设超时

`read`/`write`/`edit` **不**接受 `timeoutMs`，提供方约定也不设置截止时间——不同于 bash 与 web（它们消费 [`@deepseek-ai/dsh-timeout`](../../packages/util/timeout/README.zh.md)）以及 subprocess 支撑的 `glob`/`grep`（其声明的 `timeoutMs` 由 `@deepseek-ai/dsh-tool-call-timeout-policy` 强制执行）：那些是进程支撑的，截止时间可以真正终止工作。本地系统调用至多是尽力中止——超时无法迫使进行中的 `fsync`/`rename` 停下，因此这里的 `timeoutMs` 会成为 seam 无法强制执行的截止时间，而且恰好落在「显式优于隐式」禁止隐式默认值的位置。取消仍通过工具执行 signal 传播，在系统调用边界尽力中止。

## 服务与插件

`FileSystem`（`ctx.fs`，abstract）拥有提供方原语：`resolve`、`processPath`、`processPathFromHostPath`、`fileUrl`、`contains`、`stat`、`lstat`、`readText`、`streamText`、`readBytes`、`listDir`、`writeText` 与 `editText`。`dsh-fs-observation-policy` **不注册服务**。它通过 `fs/*` 事件门禁添加策略，根据未见、缺失或存在状态对写入与编辑意图 waterfall 作出决策，并记录 `FsObservation` 值。执行器是 `dsh-tool-fs`：它通过 `ctx.fs` 读取、写入或编辑，分发 waterfall，并 emit 记录事件。下方生成的 [`ctx.fs` 小节](#ctxfs--filesystem-abstract-seam) 展示确切的 `ctx.fs` 签名。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxfs--filesystem-abstract-seam"></a>

### `ctx.fs` — `FileSystem` (abstract seam)

Abstract filesystem provider. Targets must preserve identity across aliases; reads expose regular UTF-8 text or typed errors, listings are stable and content-free, and mutations are atomic. Optional guards add stale protection without changing the unguarded provider contract.

```ts cordis-catalog
/**
 * Resolve a model/plugin-supplied path into a stable {@link FsTarget}. May perform I/O (a
 * remote/sandboxed backend may need a round-trip to map a path to a stable identity), hence
 * async even though the local backend only normalizes + realpaths.
 *
 * @param path - the path to resolve; relative paths resolve against `opts.cwd`.
 * @param opts - optional cwd override and cancellation signal.
 * @returns the stable target; the same file yields the same `targetKey`.
 */
abstract resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>

/**
 * Return the canonical absolute path a subprocess in this filesystem's
 * execution world can open. The path is deliberately separate from
 * {@link FsTarget.targetKey}: consumers may pass this value to another OS
 * capability, but must continue treating the target key as opaque.
 * @param target - the resolved target whose process path is required.
 * @returns an absolute path in the backend's execution world.
 */
abstract processPath(target: FsTarget): string

/**
 * Map an absolute path from the harness host into this filesystem's
 * execution world when both paths identify the same file. The base provider
 * exposes no mapping; host-backed or explicitly shared backends override it.
 * @param hostPath - absolute path in the harness host filesystem.
 * @returns the process path for the same file, or undefined when this
 *   execution world cannot read that host file.
 */
processPathFromHostPath(hostPath: string): string | undefined

/**
 * Return the canonical `file:` URI for a target in this filesystem's
 * execution world. Backends own URI encoding because the host platform may
 * differ from the execution platform.
 * @param target - the resolved target to encode.
 * @returns the target's canonical file URI.
 */
abstract fileUrl(target: FsTarget): string

/**
 * Test canonical containment without exposing or parsing backend target
 * keys. Both targets must come from this provider.
 * @param parent - canonical directory target.
 * @param child - canonical candidate target.
 * @returns true when `child` is `parent` or a descendant of it.
 */
abstract contains(parent: FsTarget, child: FsTarget): boolean

/**
 * Return target metadata, or `undefined` when the target does not exist.
 * @param target - the resolved target to stat.
 * @param signal - aborts the metadata round-trip.
 * @returns metadata only, never content; undefined for an absent target.
 */
abstract stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>

/**
 * Return path metadata without following the final path component when it is a
 * symbolic link. This is intentionally path-shaped, not target-shaped:
 * {@link resolve} follows symlinks to produce the stable identity used by
 * normal reads/writes, while `lstat` lets a consumer reject the path itself
 * before that follow happens.
 *
 * `opts.cwd` follows {@link resolve}'s cwd rules. `undefined` means the path is
 * absent.
 * @param path - the path to inspect; relative paths resolve against `opts.cwd`.
 * @param opts - `cwd` overrides the backend's default base for relative paths.
 * @param signal - aborts the metadata round-trip.
 * @returns metadata only, never content; undefined for an absent path.
 */
abstract lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined>

/**
 * Read the whole regular text file as a single decoded string.
 * @param target - the resolved target to read.
 * @param signal - aborts the read.
 * @returns the full decoded UTF-8 content.
 */
abstract readText(target: FsTarget, signal?: AbortSignal): Promise<string>

/**
 * Stream the whole regular text file as decoded text chunks (same text
 * semantics as {@link readText}, for large files). The backend owns
 * cross-chunk UTF-8 decoding and binary rejection so the policy layer never
 * touches raw bytes.
 * @param target - the resolved target to read.
 * @param signal - aborts the stream, including between chunks.
 * @returns the chunk iterable, decoded and validated like {@link readText}.
 */
abstract streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>

/**
 * Read the whole regular file as raw bytes with no decoding or binary
 * rejection. The bound lives at this seam so a backend can never buffer an
 * unbounded file: a target known or discovered to exceed `maxBytes` fails
 * with `FS_TOO_LARGE` instead of returning a truncated result.
 * @param target - the resolved target to read.
 * @param signal - aborts the read.
 * @param maxBytes - inclusive byte cap on the complete content.
 * @returns the full raw content, at most `maxBytes` long.
 */
abstract readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>

/**
 * Read one byte window of the regular file as raw bytes with no decoding or
 * binary rejection: the bytes at `[offset, offset + length)`, shorter when
 * the file ends inside the window and empty when `offset` lies at or past
 * its end. The window is the bound here, not the file: a backend transfers
 * at most `length` bytes of content beyond the prefix it skips to reach
 * `offset` and never buffers the whole file, so the caller's cap on `length`
 * is the guard against unbounded buffering.
 * @param target - the resolved target to read.
 * @param range - `offset`, the 0-based first byte, and `length`, the largest byte count; both non-negative integers.
 * @param signal - aborts the read.
 * @returns the window's bytes, at most `length` long.
 */
abstract readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array>

/**
 * List direct children of a directory in stable name order. Returns resolved
 * child targets plus cheap metadata only; never reads file contents.
 * @param target - the resolved directory target.
 * @param signal - aborts the listing.
 * @returns one entry per direct child, in stable name order.
 */
abstract listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>

/**
 * Atomically create or replace UTF-8 text. `expected` guards intent and
 * staleness; omission allows unconditional overwrite.
 * @param target - the resolved target to write.
 * @param content - the full new file content.
 * @param expected - the write intent guarding the write; omit for unconditional.
 * @param signal - aborts before atomic publication takes effect.
 * @param sandboxPolicy - the per-call mode and workspace root this write
 *   runs under; a sandboxing backend fences the write by it, the bare backend
 *   ignores it. Omit to leave the backend its own default.
 * @returns the outcome, including the version the write produced.
 */
abstract writeText( target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy, ): Promise<FsWriteOutcome>

/**
 * Atomically edit literal text. When supplied, the version guard is checked
 * before matching so stale content reports `FS_STALE_VERSION`; omission edits
 * the current content without a freshness precondition.
 * @param target - the resolved target to edit.
 * @param edit - the literal search/replace request.
 * @param expected - the version guard; omit for an unconditional edit.
 * @param signal - aborts before atomic publication takes effect.
 * @param sandboxPolicy - the per-call mode and workspace root this edit runs
 *   under; a sandboxing backend fences the edit by it, the bare backend
 *   ignores it. Omit to leave the backend its own default.
 * @returns the outcome, including the version the edit produced.
 */
abstract editText( target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy, ): Promise<FsEditOutcome>
```

Types: [SandboxExecutionPolicy](sandbox.zh.md)

Source: [`packages/fs/fs/src/index.ts`](../../packages/fs/fs/src/index.ts)

<a id="fs-events"></a>

### `fs/*` events

<a id="fsedit-intent--waterfall"></a>

#### `fs/edit-intent` — waterfall

Single-slot decision for the next FileSystem.editText. Calling `next()` yields an unconditional edit; the first returned guard wins.

```ts cordis-catalog
/**
 * Single-slot decision for the next {@link FileSystem.editText}. Calling
 * `next()` yields an unconditional edit; the first returned guard wins.
 * @param target - the resolved target about to be edited.
 * @param actor - the opaque tool-execution context the decider keys off.
 * @mode waterfall
 */
'fs/edit-intent'(target: FsTarget, actor: object | undefined, next: () => { version: FsVersion } | undefined | Promise<{ version: FsVersion } | undefined>): Promise<{ version: FsVersion } | undefined>
```

Source: [`packages/fs/fs/src/index.ts`](../../packages/fs/fs/src/index.ts)

<a id="fsobserved--emit"></a>

#### `fs/observed` — emit

Record an authoritative positive or negative observation. Listeners must be synchronous recorders: throws fail the tool call and returned promises are not awaited.

```ts cordis-catalog
/**
 * Record an authoritative positive or negative observation. Listeners must
 * be synchronous recorders: throws fail the tool call and returned promises
 * are not awaited.
 * @param target - the target whose presence or absence was observed.
 * @param observation - present with its version, or confirmed absent.
 * @param actor - the observing tool-execution context; undefined records nothing useful.
 * @mode emit
 */
'fs/observed'(target: FsTarget, observation: FsObservation, actor: object | undefined): void
```

Source: [`packages/fs/fs/src/index.ts`](../../packages/fs/fs/src/index.ts)

<a id="fswrite-intent--waterfall"></a>

#### `fs/write-intent` — waterfall

Single-slot decision for the next FileSystem.writeText. Calling `next()` yields the bare provider's unconditional write; the first listener that returns an intent owns the decision rather than composing with peers.

```ts cordis-catalog
/**
 * Single-slot decision for the next {@link FileSystem.writeText}. Calling
 * `next()` yields the bare provider's unconditional write; the first listener
 * that returns an intent owns the decision rather than composing with peers.
 * @param target - the resolved target about to be written.
 * @param actor - the opaque tool-execution context the decider keys off.
 * @mode waterfall
 */
'fs/write-intent'(target: FsTarget, actor: object | undefined, next: () => FsWriteIntent | undefined | Promise<FsWriteIntent | undefined>): Promise<FsWriteIntent | undefined>
```

Source: [`packages/fs/fs/src/index.ts`](../../packages/fs/fs/src/index.ts)
<!-- END GENERATED cordis-surface -->
