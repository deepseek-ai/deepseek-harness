# 工作目录

[English](working-directory.md) | 中文

Session 的当前目录由 [`dsh-working-directory`](../../packages/session/working-directory/README.zh.md) 拥有。不可变 header 标识原始项目；`working-directory/change` 记录后续目录相关操作使用的有效目录。生成的[持久化目录](../persistence-catalog.zh.md) 拥有事件声明。

## 目录选择

`ctx.workingDirectory.get(session)` 读取日志中的值。`ensure(agent)` 验证它，并在目录消失时恢复原始项目。`set(agent, path)` 验证并记录请求的变更。header 没有目录的 Session 使用配置的运行时回退目录；回退目录不可用时返回错误。

`rootOf(session)` 读取工作区根：包含当前目录的最长已登记锚。锚是原始项目以及 `relocate(agent, root, { cwd? })` 进入过的每个检出目录；该操作验证根及其内部的目录，然后用一条 `anchor` 指向该根的 `working-directory/change` 同时记录两者。`anchorsOf(session)` 列出这些锚。根内部的 `set` 只移动当前目录；进入另一个锚的 `set` 把该锚选为根；所有锚之外的 `set` 不改变根。恢复到原始项目时再次把它选为根。锚在规范路径上按词法比较：生产方以规范拼写记录原始项目，没有记录项目的 Session 把部署回退目录登记为第一个锚，恢复目的地不在任何锚内时也加入锚。

变更仅影响一个 Session。相对路径文件系统操作、新启动的进程、指令发现、技能和文件补全使用当前目录。已有终端和持久 shell 保留自己的目录。沙箱可写根目录与项目归属继续绑定原始项目。

## 模型上下文

初始值与后续当前值通过必需的用户上下文快照到达模型，即使可选运行时上下文被禁用也不例外；当前目录与根不同时，快照增加一行 `Workspace root`。每次已提交变更都会尝试通过普通 Agent 收件箱排入通知，选中另一个根的变更在通知末尾给出该根；取消或销毁可能丢弃尚未进入请求的通知。目录事件仍然保留，下一次获准进入的请求会收到当前值。目录上下文不进入系统提示词。[`working_directory`](../../packages/session/tool-working-directory/README.zh.md) 提供一个可选的 `cd` 参数。

## 迁移

`relocate` 接收新的根与以下选项，并解析为它提交的目录。`inherit(agent, source, { cwd, signal? })` 让一个 Session 的目录从另一个 Session 出发：来源在其原始项目之外的已登记检出目录中工作、且规范化的 `cwd` 位于其中时，通过 `relocate` 登记该检出目录；否则只设置目录。来源的其他锚不传递，它之后的变化也不影响已启动的 Session。

```ts type-equiv
/** Options of {@link WorkingDirectoryService.relocate}. */
interface RelocateOptions {
  /** Directory to enter inside the new root, absolute or relative to that root; omission enters the root itself. */
  cwd?: string
  /** Cancellation before the durable change. */
  signal?: AbortSignal
}
```

```ts type-equiv
/** Options of {@link WorkingDirectoryService.inherit}. */
interface InheritOptions {
  /** Canonical absolute directory the Session starts in, spelled as the service records directories. */
  cwd: string
  /** Cancellation before the durable change. */
  signal?: AbortSignal
}
```

```ts type-equiv
/** The committed outcome of {@link WorkingDirectoryService.relocate} and {@link WorkingDirectoryService.inherit}. */
interface RelocatedDirectories {
  /**
   * Canonical absolute workspace root the commit selected: the longest registered anchor containing
   * `cwd`. This is the registered root unless a more specific anchor, such as an original project
   * inside it, already contains `cwd`.
   */
  root: string
  /** Canonical absolute current directory inside `root`. */
  cwd: string
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxworkingdirectory--workingdirectoryservice"></a>

### `ctx.workingDirectory` — `WorkingDirectoryService`

One owner for each Session's effective directory, its workspace root, and their model-visible changes.

The current directory is the cursor every relative path resolves from. The workspace root is the checkout that cursor is in: the longest registered anchor containing it. Anchors are the original project plus every checkout a relocate entered, so an ordinary set inside the root moves only the cursor, a `set` into another anchor switches the root to that anchor, and a `set` outside every anchor moves the cursor and leaves the root.

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
 * @returns the registered anchor containing the current directory, or the deployment default when none is recorded.
 */
rootOf(session: Session): string

/**
 * Read the registered workspace anchors without filesystem I/O.
 * @param session - Session whose anchors are requested.
 * @returns anchors in registration order, the original project first when the header records one.
 */
anchorsOf(session: Session): readonly string[]

/**
 * Validate the current directory and restore the original project when it disappeared.
 * @param agent - live or unpublished Agent owning the Session.
 * @param signal - cancellation for filesystem inspection.
 * @returns the existing directory; recovery is committed before fulfillment.
 * A Session without a recorded project records the deployment fallback as its first anchor on its
 * first validation, and a recovery destination outside every anchor joins the anchors.
 * A notice failure is warned without reverting the committed state.
 * @throws {@link WorkingDirectoryError} `WORKING_DIRECTORY_UNAVAILABLE` when the original project is also
 *   unavailable or the service is disposed, or the rejection of a `working-directory/access` listener.
 */
ensure(agent: Agent, signal?: AbortSignal): Promise<string>

/**
 * Change one Session's directory without changing existing processes or permissions.
 * The workspace root follows the registered anchors: a path inside the current
 * root keeps it, a path inside another anchor selects that anchor, and a path
 * outside every anchor leaves the root unchanged.
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

/**
 * Enter another checkout: register `root` as a workspace anchor of the Session and
 * move its current directory to `options.cwd`, or to the root itself. One committed
 * event carries both; existing processes and permissions are unchanged.
 * @param agent - live or unpublished Agent owning the Session.
 * @param root - absolute checkout directory, or a path relative to the current directory.
 * @param options - directory to enter inside the root and cancellation before the durable change.
 * @returns the committed current directory and the workspace root selected after the commit;
 * the registered root is that root unless a more specific anchor already contains the directory.
 * A notice failure is warned; the next request still receives the committed directories.
 * @throws {@link WorkingDirectoryError} `WORKING_DIRECTORY_INVALID` for an empty path or a directory outside
 *   the root and `WORKING_DIRECTORY_NOT_FOUND` when either path is not an existing directory.
 */
relocate(agent: Agent, root: string, options: RelocateOptions = {}): Promise<RelocatedDirectories>

/**
 * Start a Session's directories from another Session's. When `source` works in a registered checkout
 * other than the starting Session's own original project and `options.cwd` lies inside that checkout,
 * the checkout is registered as the starting Session's anchor and `cwd` entered through {@link relocate};
 * otherwise only the current directory is set through {@link set}. Only the source's current root is
 * passed on, never its other anchors, and later changes to `source` do not reach the starting Session.
 * @param agent - live or unpublished Agent owning the Session that starts.
 * @param source - Session whose current root may be passed on; the call leaves it unchanged.
 * @param options - canonical absolute directory to start in and cancellation before the durable change.
 * @returns the committed current directory and the workspace root selected after the commit.
 * @throws {@link WorkingDirectoryError} `WORKING_DIRECTORY_NOT_FOUND` when `options.cwd` is not an existing
 *   directory, or the rejection of a `working-directory/access` listener.
 */
async inherit(agent: Agent, source: Session, options: InheritOptions): Promise<RelocatedDirectories>
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
