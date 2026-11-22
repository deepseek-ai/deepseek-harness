# Git Worktrees

English | [中文](worktrees.zh.md)

The experimental [`dsh-experimental-worktree`](../../packages/experimental/worktree/README.md) service provides `ctx.worktrees`. Its [`enter_worktree`](../../packages/experimental/tool-worktree/README.md) consumer selects a checkout of the pool through the [working-directory service](working-directory.md), creating a new Git branch and checkout when none has the requested name, and `exit_worktree` returns to the checkout the Session came from. The [Change requests & worktrees bundle](../../packages/experimental/forge-bundle/README.md#use-this-package) loads both packages through the GUI plugin manager and ships switched off. Other profiles can select the [standalone worktree bundle](../../packages/experimental/tool-worktree/README.md#use-this-package) or mount the two packages explicitly.

## Creation and retention

The calling Session's current directory selects the source repository. Creation pins the requested local commit, branch, or tag before allocating the checkout; omission selects `HEAD`. A request may instead ask to fetch a remote-tracking branch of a configured remote first, which fetches only that branch and pins the fetched commit. Each name must identify a new branch and an unused checkout path. The operation neither fetches other commits or missing objects nor copies staged, unstaged, untracked, or ignored files from the source checkout.

The default destination is `<current checkout root>/.agents/worktrees/<name>`. `repositoryRoot` is the top-level directory of the caller’s current checkout; a linked checkout therefore contains its own pool. The service writes a `.gitignore` containing `*` and a trailing newline only when its allocation creates the configured pool directory. Existing files and ignore rules are preserved. The calling Session’s existing sandbox policy must permit writes to the destination and shared Git administration directory. Successful Git setup precedes the working-directory change.

`ctx.worktrees.enter(agent, { name })` moves the Session into an existing worktree in the pool of the checkout it works in. The `enter_worktree` tool calls it first for a named request without a start revision, and calls `create` only when it reports `WORKTREE_NOT_FOUND`. The directory must lie inside that pool and be a registered worktree of the repository: a missing name, an unregistered directory, and a link that leaves the pool fail with `WORKTREE_NOT_FOUND`. Entry changes neither Git state nor files and records itself in the Session log.

`ctx.worktrees.exit(agent)`, which the `exit_worktree` tool calls, returns the Session from the recorded worktree that contains its current directory to the checkout it created or entered that worktree from; the checkout and branch remain. Nested worktrees exit one level at a time. Cancellation or failure can also retain partial artifacts; the error identifies their location. Worktree failures throw `WorktreeError` with a `WORKTREE_*` code; a failure after allocation keeps the wrapped error's `name` and `code`, and caller cancellation stays an `AbortError`. The service aborts and drains pending operations on disposal. The [package README](../../packages/experimental/worktree/README.md) owns configuration and Git requirements.

## Request and result

The creation request selects only the new name and local revision. The result identifies the created checkout and exact commit; it does not change the Session's original project or write permissions. An entry request names a worktree inside the pool; its result identifies the checkout, the branch checked out there, and the checkout the Session entered from. An optional callback receives each stage of the creation before it begins. A restoration checks a removed checkout out again at its recorded directory, from its branch or, when the branch is gone, from its base commit.

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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.md) · [SessionId](core.md)

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

Types: [SessionId](core.md)

Source: [`packages/experimental/worktree/src/archive.ts`](../../packages/experimental/worktree/src/archive.ts)
<!-- END GENERATED cordis-surface -->
