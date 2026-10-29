/** Public requests and results for creating a Git worktree and entering it, and for restoring a removed one. */

/** A new checkout from a locally available Git commit, branch, or tag. */
export interface CreateWorktreeRequest {
  /** New branch name, also used as the relative checkout directory; omission generates a name. */
  name?: string
  /** Local revision to resolve before creation; omission selects HEAD. */
  from?: string
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

/**
 * Stage of one creation or restoration, reported before it begins: `prepare`
 * validates the request, allocates the checkout directory, and creates the
 * branch, which a restoration creates again only when it is gone; `checkout`
 * writes the files and, for a creation, enters the checkout.
 */
export type CreateWorktreePhase = 'prepare' | 'checkout'

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
