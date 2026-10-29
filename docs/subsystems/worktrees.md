# Git Worktrees

English | [中文](worktrees.zh.md)

The experimental [`dsh-experimental-worktree`](../../packages/experimental/worktree/README.md) service provides `ctx.worktrees`. Its [`create_worktree`](../../packages/experimental/tool-worktree/README.md) consumer creates a new Git branch and checkout, then selects it through the [working-directory service](working-directory.md). The [Git Worktrees optional bundle](../../packages/experimental/tool-worktree/README.md#use-this-package) loads both packages through the GUI plugin manager. It ships switched off; explicit compositions can also mount the two packages.

## Creation and retention

The calling Session's current directory selects the source repository. Creation pins the requested local commit, branch, or tag before allocating the checkout; omission selects `HEAD`. Each name must identify a new branch and an unused checkout path. The operation neither fetches missing objects nor copies staged, unstaged, untracked, or ignored files from the source checkout.

The default destination is `<current checkout root>/.agents/worktrees/<name>`. `repositoryRoot` is the top-level directory of the caller’s current checkout; a linked checkout therefore contains its own pool. The service writes a `.gitignore` containing `*` and a trailing newline only when its allocation creates the configured pool directory. Existing files and ignore rules are preserved. The calling Session’s existing sandbox policy must permit writes to the destination and shared Git administration directory. Successful Git setup precedes the working-directory change.

Leaving through `working_directory({ cd: path })` retains the checkout and branch. Cancellation or failure can also retain partial artifacts; the error identifies their location. The service aborts and drains pending operations on disposal. The [package README](../../packages/experimental/worktree/README.md) owns configuration and Git requirements.

## Request and result

The request selects only the new name and local revision. The result identifies the created checkout and exact commit; it does not change the Session's original project or write permissions. An optional callback receives each stage of the creation before it begins. A restoration checks a removed checkout out again at its recorded directory, from its branch or, when the branch is gone, from its base commit.

```ts type-equiv
/** A new checkout from a locally available Git commit, branch, or tag. */
interface CreateWorktreeRequest {
  /** New branch name, also used as the relative checkout directory; omission generates a name. */
  name?: string
  /** Local revision to resolve before creation; omission selects HEAD. */
  from?: string
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
/**
 * Stage of one creation or restoration, reported before it begins: `prepare`
 * validates the request, allocates the checkout directory, and creates the
 * branch, which a restoration creates again only when it is gone; `checkout`
 * writes the files and, for a creation, enters the checkout.
 */
type CreateWorktreePhase = 'prepare' | 'checkout'
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

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxworktrees--worktreeservice"></a>

### `ctx.worktrees` — `WorktreeService`

Creates retained Git worktrees under the mounted filesystem and sandbox providers.

```ts cordis-catalog
/**
 * Create a fresh branch and checkout at a pinned local revision, then enter it.
 * Existing branches or checkout paths fail. Uncommitted files stay in the source checkout.
 * Checkout disables configured clean, smudge, and process filters without changing Git config.
 * Repository-local replacement refs still apply; baseCommit reports the resolved object name.
 * The new checkout becomes current only after Git setup succeeds. Failures may retain newly
 * allocated Git/filesystem artifacts; no branch or checkout is removed automatically.
 * @param agent - caller whose current directory selects the source repository and file policy.
 * @param request - optional new name and local revision; defaults are generated name and HEAD.
 * @param signal - cancellation of lookup, creation, and working-directory publication.
 * @param onPhase - receives each stage before it begins; it must not throw.
 * @returns canonical checkout path, branch name, pinned commit, and source repository root.
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
 * @param onPhase - receives each stage before it begins; it must not throw.
 * @returns the directory and whether the branch was created again.
 */
async restore( agent: Agent, request: RestoreWorktreeRequest, signal?: AbortSignal, onPhase?: (phase: CreateWorktreePhase) => void, ): Promise<RestoredWorktree>
```

Types: [Agent](core.md)

Source: [`packages/experimental/worktree/src/index.ts`](../../packages/experimental/worktree/src/index.ts)
<!-- END GENERATED cordis-surface -->
