# 工作目录

[English](working-directory.md) | 中文

Session 的当前目录由 [`dsh-working-directory`](../../packages/session/working-directory/README.zh.md) 拥有。不可变 header 标识原始项目；`workspace-root/change` 记录后续目录相关操作所用目录的每次移动。生成的[持久化目录](../persistence-catalog.zh.md) 拥有事件声明。

## 目录选择

`ctx.workingDirectory.get(session)` 读取日志中的值。`ensure(agent)` 验证它，并在目录消失时恢复原始项目。`set(agent, path)` 验证并记录由 Host 操作选定的移动，例如创建工作树、forge 面板或 SDK 请求；模型没有可以移动目录的工具。header 没有目录的 Session 使用配置的运行时回退目录；回退目录不可用时返回错误。

`rootOf(session)` 读取工作区根。服务记录的每次变更都是 `workspace-root/change`，根随目录一起移动，因此两者相等。只有当 Session 日志中存在 `working-directory/change` 时两者才不同，这类事件记录于模型还能移动目录的版本：它已标为 deprecated，没有写入方，只移动目录，根留在原始项目，直到下一次记录的变更。

变更仅影响一个 Session。模型的相对路径文件系统操作以及其工具启动的进程使用当前目录。用户看到的内容跟随工作区根：沙箱 `workspace-write` 边界、文件树与目录列举、变更摘要、新开的侧栏终端、`@` 文件补全、技能目录、项目指令发现和 LSP 工作区。已有终端和持久 shell 保留自己的目录。项目归属继续绑定原始项目。

## 模型上下文

初始值与后续当前值通过必需的用户上下文快照到达模型，即使可选运行时上下文被禁用也不例外。每次已提交变更都会尝试通过普通 Agent 收件箱排入通知；取消或销毁可能丢弃尚未进入请求的通知。目录事件仍然保留，下一次获准进入的请求会收到当前值。目录上下文不进入系统提示词。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxworkingdirectory--workingdirectoryservice"></a>

### `ctx.workingDirectory` — `WorkingDirectoryService`

One owner for each Session's directory, its workspace root, and their model-visible changes.

A Session works in one directory. Relative paths resolve from it, and it is the workspace root that the write boundary, file views, and discovery follow. Only Host operations move it, through set or the recovery of ensure; every such change moves both. The two differ only in a Session whose log holds a `working-directory/change`.

```ts cordis-catalog
/**
 * Read the committed directory without filesystem I/O.
 * @param session - Session whose directory is requested.
 * @returns its effective absolute directory.
 */
get(session: Session): string

/**
 * Read the committed workspace root without filesystem I/O.
 * @param session - Session whose root is requested.
 * @returns the directory of the last `workspace-root/change`, the original project before any,
 * or the deployment default when none is recorded.
 */
rootOf(session: Session): string

/**
 * Read the recorded workspace root without the deployment fallback and without filesystem I/O.
 * @param session - Session whose root is requested.
 * @returns the directory of the last `workspace-root/change`, the original project before any,
 * or undefined while the log records neither; consumers apply their own fallback.
 */
recordedRootOf(session: Session): string | undefined

/**
 * Validate the current directory and restore the original project when it disappeared.
 * @param agent - live or unpublished Agent owning the Session.
 * @param signal - cancellation for filesystem inspection.
 * @returns the existing directory; recovery is committed before fulfillment and moves the workspace
 * root with the directory. A notice failure is warned without reverting the committed state.
 * @throws {@link WorkingDirectoryError} `WORKING_DIRECTORY_UNAVAILABLE` when the original project is also
 *   unavailable or the service is disposed, or the rejection of a `working-directory/access` listener.
 */
ensure(agent: Agent, signal?: AbortSignal): Promise<string>

/**
 * Move one Session's workspace: its current directory and its workspace root become `path`.
 * Existing processes keep their directories. Callers are Host operations that chose the
 * directory; a model-supplied path would move the workspace-write boundary with it.
 * @param agent - live or unpublished Agent owning the Session.
 * @param path - absolute path or a path relative to its current directory.
 * @param signal - cancellation before the durable change.
 * @returns the canonical absolute directory, committed before fulfillment.
 * A notice failure is warned; the next request still receives the committed directory.
 * @throws {@link WorkingDirectoryError} `WORKING_DIRECTORY_INVALID` for an empty path and
 *   `WORKING_DIRECTORY_NOT_FOUND` when the path is not an existing directory, or the rejection of a
 *   `working-directory/access` listener.
 */
set(agent: Agent, path: string, signal?: AbortSignal): Promise<string>
```

Types: [Agent](core.zh.md) · [Session](session.zh.md)

Source: [`packages/session/working-directory/src/index.ts`](../../packages/session/working-directory/src/index.ts)

<a id="working-directory-events"></a>

### `working-directory/*` events

<a id="working-directoryaccess--waterfall"></a>

#### `working-directory/access` — waterfall

Coordinate directory validation and publication with a resource operation on the directory, such as a checkout being removed. A listener that must wait awaits that operation, then calls `next()`; every other listener calls `next()` at once. A rejection fails this access and leaves the recorded directory unchanged; it is not a fallback.

```ts cordis-catalog
/**
 * Coordinate directory validation and publication with a resource operation
 * on the directory, such as a checkout being removed. A listener that must
 * wait awaits that operation, then calls `next()`; every other listener
 * calls `next()` at once. A rejection fails this access and leaves the
 * recorded directory unchanged; it is not a fallback.
 * @param request - owner, requested path (null validates the current directory), and the access's cancellation.
 * @param next - perform validation and commit.
 * @mode waterfall
 */
'working-directory/access'( request: { agent: Agent; path: string | null; signal: AbortSignal }, next: () => Promise<string>, ): Promise<string>
```

Types: [Agent](core.zh.md)

Source: [`packages/session/working-directory/src/index.ts`](../../packages/session/working-directory/src/index.ts)
<!-- END GENERATED cordis-surface -->
