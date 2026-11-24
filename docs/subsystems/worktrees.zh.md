# Git 工作树

[English](worktrees.md) | 中文

实验性的 [`dsh-experimental-worktree`](../../packages/experimental/worktree/README.zh.md) 服务提供 `ctx.worktrees`。其消费方 [`enter_worktree`](../../packages/experimental/tool-worktree/README.zh.md) 通过[工作目录服务](working-directory.zh.md)选中池中的检出目录，没有同名检出目录时创建新的 Git 分支与检出目录；`exit_worktree` 回到 Session 来自的检出目录。[变更请求与工作树组合包](../../packages/experimental/forge-bundle/README.zh.md#use-this-package)通过 GUI 插件管理器一起加载这两个包，随安装提供但默认关闭。其他 profile 可以选择[独立工作树组合包](../../packages/experimental/tool-worktree/README.zh.md#use-this-package)，或显式挂载这两个包。

## 创建与保留

调用方 Session 的当前目录决定源仓库。创建操作在分配检出目录前，将请求的本地提交、分支或标签固定为具体提交；省略时选择 `HEAD`。请求也可以要求先获取某个已配置远程的远程跟踪分支，此时只获取这一个分支，并固定获取到的提交。每个名称必须对应新分支与未使用的检出路径。操作既不获取其他提交或缺失对象，也不复制源检出目录中的暂存、未暂存、未跟踪或被忽略文件。

默认目标为 `<current checkout root>/.agents/worktrees/<name>`。`repositoryRoot` 是调用方当前检出目录的顶层目录；因此，链接检出目录会在自身内部保存工作树父目录。仅当服务的分配操作创建了配置指定的父目录时，服务才会写入内容为 `*` 加换行符的 `.gitignore`。已有文件与忽略规则保持不变。调用方 Session 的现有沙箱策略必须允许写入目标目录与共享 Git 管理目录；在链接工作树中工作的 Session 通过[链接工作树授权](../../packages/experimental/sandbox-policy-git/README.zh.md)持有后者的写权限。Git 初始化成功后才改变工作目录。

`ctx.worktrees.enter(agent, { name })` 把 Session 移入它所在检出的池中已有的工作树。`enter_worktree` 工具对带名称且不带起始修订的请求先调用它，只有它报告 `WORKTREE_NOT_FOUND` 时才调用 `create`。该目录必须位于池内，并且是仓库已登记的工作树：名称不存在、目录未登记、链接指向池外都以 `WORKTREE_NOT_FOUND` 失败。进入不改变 Git 状态和文件，并在 Session 日志中记录这次进入。

`exit_worktree` 工具调用的 `ctx.worktrees.exit(agent)` 找到包含 Session 当前目录的已记录工作树，把 Session 送回创建或进入该工作树时所在的检出；检出目录与分支保留。嵌套的工作树每次退出一层。取消或失败也可能留下部分产物；错误会指出它们的位置。worktree 失败抛出带 `WORKTREE_*` code 的 `WorktreeError`；分配开始后的失败保留被包装错误的 `name` 与 `code`，调用方取消仍为 `AbortError`。服务销毁时会中止待完成操作并等待它们结束。[包 README](../../packages/experimental/worktree/README.zh.md)拥有配置与 Git 要求。

## 请求与结果

创建请求只选择新名称与本地版本。结果标识创建的检出目录与确切提交；它不会改变 Session 的原始项目或写权限。进入请求给出池内工作树的名称；结果标识检出目录、其中检出的分支，以及 Session 进入前所在的检出。可选的回调会在创建的每个阶段开始之前收到该阶段。恢复会在记录的目录重新检出已删除的检出目录：从它的分支检出；分支也已删除时，从它的基准提交检出。

```ts type-equiv
/** A new checkout from a locally available Git commit, branch, or tag, or from a remote branch fetched first. */
interface CreateWorktreeRequest {
  /** New branch name, also used as the relative checkout directory; omission generates a name. */
  name?: string
  /** Local revision to resolve before creation; omission selects HEAD. */
  from?: string
  /**
   * Fetch `from` from its remote before resolving it. `from` must then be the full name of a remote-tracking
   * branch, `refs/remotes/<remote>/<branch>`, of a configured remote; only that branch is fetched, without tags.
   */
  fetch?: boolean
}
```

```ts type-equiv
/** Committed Git baseline and the calling Session's resulting working directory. */
interface CreatedWorktree {
  /** Canonical absolute checkout directory in the filesystem provider's execution world. */
  path: string
  /** Newly created branch name. */
  branch: string
  /** Resolved commit object name; repository-local replacement refs can change its checked-out content. */
  baseCommit: string
  /** Canonical root of the source checkout. */
  repositoryRoot: string
}
```

```ts type-equiv
/** An existing checkout in the worktree pool of the checkout the calling Session works in. */
interface EnterWorktreeRequest {
  /** Checkout directory relative to the pool: the name `create` gave the worktree. */
  name: string
}
```

```ts type-equiv
/** An existing checkout the calling Session entered. */
interface EnteredWorktree {
  /** Canonical absolute checkout directory in the filesystem provider's execution world. */
  path: string
  /** Branch checked out there at entry; absent on a detached HEAD. */
  branch?: string
  /** Canonical root of the checkout whose pool holds the worktree; `exit` returns the Session there. */
  repositoryRoot: string
}
```

```ts type-equiv
/**
 * Stage of one creation or restoration, reported before it begins: `fetch`
 * fetches the remote base branch of a creation that asks for it; `prepare`
 * validates the request, allocates the checkout directory, and creates the
 * branch, which a restoration creates again only when it is gone; `checkout`
 * writes the files and, for a creation, enters the checkout.
 */
type CreateWorktreePhase = 'fetch' | 'prepare' | 'checkout'
```

```ts type-equiv
/** A removed checkout to check out again at its recorded directory. */
interface RestoreWorktreeRequest {
  /** Canonical checkout directory the worktree had. */
  path: string
  /** Branch the worktree had checked out. */
  branch: string
  /** Commit the branch started from; a branch that no longer exists is created again here. */
  baseCommit: string
  /** Canonical root of the source checkout. */
  repositoryRoot: string
}
```

```ts type-equiv
/** Outcome of one restoration. */
interface RestoredWorktree {
  /** Checkout directory, present again. */
  path: string
  /** Whether the branch no longer existed and was created again at the base commit, without the commits it had gained. */
  branchRecreated: boolean
}
```

```ts type-equiv
/** One checkout in a Session's log and whether that Session, rather than a fork ancestor, created it. */
interface WorktreeCreation {
  readonly worktree: CreatedWorktree
  /** False for a creation inside the fork-inherited prefix. */
  readonly owned: boolean
}
```

```ts type-equiv
/** Process-local state of one archive-triggered cleanup of a checkout. */
interface WorktreeCleanup {
  /** Monotonic attempt number within this Host lifetime; a Remote waits on a specific one. */
  readonly revision: number
  /**
   * `scheduled` until the background inspection ends; `retained` when a use,
   * policy, or Git state keeps the checkout; `removed` after `git worktree
   * remove`; `failed` when removal threw and may have left a partial directory.
   */
  readonly status: 'scheduled' | 'retained' | 'removed' | 'failed'
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxworktrees--worktreeservice"></a>

### `ctx.worktrees` — `WorktreeService`

Creates retained Git worktrees under the mounted filesystem and sandbox providers, moves Sessions into and out of them, records each creation and entry in the Session log, and reclaims a clean, unreferenced checkout when the Session that created it is archived.

```ts cordis-catalog
/**
 * Create a fresh branch and checkout at a pinned local revision, then enter it. A request that asks to fetch
 * first fetches its remote-tracking branch, only that branch and without tags, then pins the fetched commit.
 * Existing branches or checkout paths fail. Uncommitted files stay in the source checkout.
 * Checkout disables configured clean, smudge, and process filters without changing Git config.
 * Repository-local replacement refs still apply; baseCommit reports the resolved object name.
 * The new checkout becomes current only after Git setup succeeds. Failures may retain newly
 * allocated Git/filesystem artifacts; no branch or checkout is removed automatically.
 * @param agent - caller whose current directory selects the source repository and file policy.
 * @param request - optional new name, local revision, and fetch switch; defaults are generated name, HEAD, and no fetch.
 * @param signal - cancellation of lookup, creation, and working-directory publication.
 * @param onPhase - receives each stage before it begins; it must not throw.
 * @returns canonical checkout path, branch name, pinned commit, and source repository root.
 * @throws {WorktreeError} for an invalid request, a fetch request whose `from` is not a remote-tracking branch of a
 *   configured remote, an existing branch or path, or a failed, oversized, or timed-out command, including the
 *   fetch; a failure after allocation keeps its `name` and `code` and adds retained-artifact context.
 */
async create( agent: Agent, request: CreateWorktreeRequest = {}, signal?: AbortSignal, onPhase?: (phase: CreateWorktreePhase) => void, ): Promise<CreatedWorktree>

/**
 * Check out a removed worktree again at its recorded directory: its branch
 * when the branch still exists, otherwise a new branch of the same name at
 * `baseCommit`. Only the missing target's unlocked registration is removed, and an
 * existing directory fails. Changes that were never committed are not
 * recovered. Checkout disables configured clean, smudge, and process filters,
 * as creation does. The calling Session's working directory does not change.
 * Failures may retain newly allocated Git/filesystem artifacts.
 * @param agent - caller whose sandbox policy confines the commands.
 * @param request - recorded directory, branch, base commit, and source repository root.
 * @param signal - cancellation of the restoration.
 * @param onPhase - receives each stage before it begins, never `fetch`; it must not throw.
 * @returns the directory and whether the branch was created again.
 * @throws {WorktreeError} for an invalid request, an existing path, a locked registration, or a failed, oversized,
 *   or timed-out command; a failure after allocation keeps its `name` and `code` and adds retained-artifact context.
 */
async restore( agent: Agent, request: RestoreWorktreeRequest, signal?: AbortSignal, onPhase?: (phase: Exclude<CreateWorktreePhase, 'fetch'>) => void, ): Promise<RestoredWorktree>

/**
 * Move the calling Session into an existing worktree in the pool of the checkout it works in. The
 * directory `name` selects must lie inside that pool and be a registered worktree of the repository;
 * neither Git state nor files change. The Session's log records the entry, so {@link exit} returns it to
 * the checkout it entered from. Archiving the Session never removes a checkout it only entered.
 * @param agent - caller whose current directory selects the checkout and its pool.
 * @param request - name of the worktree inside the pool.
 * @param signal - cancellation of lookup and of the working-directory change.
 * @returns the entered checkout, its branch, and the checkout the Session entered from.
 * @throws {WorktreeError} `WORKTREE_INVALID_ARGUMENT` for a name that is not a relative path inside the pool,
 *   `WORKTREE_NOT_FOUND` when the pool holds no registered worktree of that name, a command failure, and
 *   `WORKTREE_UNAVAILABLE` after service disposal; or the working-directory service's error when the
 *   registered directory no longer exists.
 */
async enter(agent: Agent, request: EnterWorktreeRequest, signal?: AbortSignal): Promise<EnteredWorktree>

/**
 * Return the calling Session from the worktree it works in to the checkout it entered that worktree
 * from: the source checkout of a creation, or the checkout whose pool holds an entered worktree. The
 * worktree is the recorded creation or entry, the Session's own or fork-inherited, with the longest
 * directory containing the Session's current directory. Its checkout and branch remain.
 * @param agent - caller whose current directory lies in a recorded worktree.
 * @param signal - cancellation of directory validation and of the working-directory change.
 * @returns the worktree the Session left; the Session now works in its `repositoryRoot`.
 * @throws {WorktreeError} `WORKTREE_NOT_ENTERED` when no recorded worktree contains the current directory and
 *   `WORKTREE_UNAVAILABLE` after service disposal, or the working-directory service's error when the source
 *   checkout no longer exists.
 */
async exit(agent: Agent, signal?: AbortSignal): Promise<CreatedWorktree | EnteredWorktree>

/**
 * Read the archive cleanup of a Session's created checkout; waiting never
 * starts one. Absent without the Workspace and query providers.
 * @param sessionId - archived Session whose cleanup is read; reading neither loads nor resumes it.
 * @param revision - null reads at once; a matching revision waits for that attempt to settle.
 * @returns the attempt state, or null when none exists, the revision was superseded, or the service is stopping.
 */
async cleanupOf(sessionId: SessionId, revision: number | null): Promise<WorktreeCleanup | null>
```

Types: [Agent](core.zh.md) · [SessionId](core.zh.md)

Source: [`packages/experimental/worktree/src/index.ts`](../../packages/experimental/worktree/src/index.ts)

<a id="worktree-events"></a>

### `worktree/*` events

<a id="worktreecleanup--emit"></a>

#### `worktree/cleanup` — emit

A cleanup attempt changed state. Fires once at admission with `scheduled` and once at settlement with the final status.

```ts cordis-catalog
/**
 * A cleanup attempt changed state. Fires once at admission with
 * `scheduled` and once at settlement with the final status.
 * @param info - the archived Session, the checkout, and the attempt state.
 * @mode emit
 */
'worktree/cleanup'(info: { sessionId: SessionId; path: string; cleanup: WorktreeCleanup }): void
```

Types: [SessionId](core.zh.md)

Source: [`packages/experimental/worktree/src/archive.ts`](../../packages/experimental/worktree/src/archive.ts)
<!-- END GENERATED cordis-surface -->
