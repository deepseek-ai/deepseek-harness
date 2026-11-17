/**
 * Public requests and results for creating a Git worktree and entering it, for entering an existing one, and
 * for restoring a removed one.
 */

/** A new checkout from a locally available Git commit, branch, or tag, or from a remote branch fetched first. */
export interface CreateWorktreeRequest {
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

/** Committed Git baseline and the calling Session's resulting working directory. */
export interface CreatedWorktree {
  /** Canonical absolute checkout directory in the filesystem provider's execution world. */
  path: string
  /** Newly created branch name. */
  branch: string
  /** Resolved commit object name; repository-local replacement refs can change its checked-out content. */
  baseCommit: string
  /** Canonical root of the source checkout. */
  repositoryRoot: string
}

/** An existing checkout in the worktree pool of the checkout the calling Session works in. */
export interface EnterWorktreeRequest {
  /** Checkout directory relative to the pool: the name `create` gave the worktree. */
  name: string
}

/** An existing checkout the calling Session entered. */
export interface EnteredWorktree {
  /** Canonical absolute checkout directory in the filesystem provider's execution world. */
  path: string
  /** Branch checked out there at entry; absent on a detached HEAD. */
  branch?: string
  /** Canonical root of the checkout whose pool holds the worktree; `exit` returns the Session there. */
  repositoryRoot: string
}

/**
 * Stage of one creation or restoration, reported before it begins: `fetch`
 * fetches the remote base branch of a creation that asks for it; `prepare`
 * validates the request, allocates the checkout directory, and creates the
 * branch, which a restoration creates again only when it is gone; `checkout`
 * writes the files and, for a creation, enters the checkout.
 */
export type CreateWorktreePhase = 'fetch' | 'prepare' | 'checkout'

/** A removed checkout to check out again at its recorded directory. */
export interface RestoreWorktreeRequest {
  /** Canonical checkout directory the worktree had. */
  path: string
  /** Branch the worktree had checked out. */
  branch: string
  /** Commit the branch started from; a branch that no longer exists is created again here. */
  baseCommit: string
  /** Canonical root of the source checkout. */
  repositoryRoot: string
}

/** Outcome of one restoration. */
export interface RestoredWorktree {
  /** Checkout directory, present again. */
  path: string
  /** Whether the branch no longer existed and was created again at the base commit, without the commits it had gained. */
  branchRecreated: boolean
}

/** One checkout in a Session's log and whether that Session, rather than a fork ancestor, created it. */
export interface WorktreeCreation {
  readonly worktree: CreatedWorktree
  /** False for a creation inside the fork-inherited prefix. */
  readonly owned: boolean
}

/** Process-local state of one archive-triggered cleanup of a checkout. */
export interface WorktreeCleanup {
  /** Monotonic attempt number within this Host lifetime; a Remote waits on a specific one. */
  readonly revision: number
  /**
   * `scheduled` until the background inspection ends; `retained` when a use,
   * policy, or Git state keeps the checkout; `removed` after `git worktree
   * remove`; `failed` when removal threw and may have left a partial directory.
   */
  readonly status: 'scheduled' | 'retained' | 'removed' | 'failed'
}
