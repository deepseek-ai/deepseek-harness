/** Browser-safe panel state, the worktree request record, Remote error codes, and Host configuration of the forge panel. */

import type {} from '@deepseek-ai/dsh-typert-protocol'
import type { ChangeRequestSnapshot, ForgeReadiness, ForgeRepository } from '@deepseek-ai/dsh-experimental-forge/types'
import type { SessionChangeRequest } from '@deepseek-ai/dsh-experimental-forge-session/types'

/** Git facts for the checkout that contains the Session's current directory. */
export interface ForgeCheckout {
  /** Top-level directory of the checkout. */
  readonly root: string
  /** Checked-out branch, or null when HEAD is detached. */
  readonly branch: string | null
  /** Whether the checkout is a linked worktree of another checkout's repository. */
  readonly linked: boolean
  /** Abbreviated commit HEAD names, or null while the checked-out branch has no commit. */
  readonly commit: string | null
}

/** Inspection result for the Session's current directory. */
export type ForgeCheckoutState =
  /** The first inspection has not finished. */
  | { readonly state: 'pending' }
  /** The current directory is not inside a Git checkout. */
  | { readonly state: 'none' }
  /** Git could not run or reported an error. */
  | { readonly state: 'failed'; readonly message: string }
  /** The checkout facts. */
  | { readonly state: 'ready'; readonly checkout: ForgeCheckout }

/** The worktree the panel created and entered for a Session before its first step. */
export interface ForgeSessionWorktree {
  /** Canonical checkout directory. */
  readonly path: string
  /** Branch created for the checkout. */
  readonly branch: string
  /** Requested base branch, or null when the checkout started from HEAD of the source checkout. */
  readonly from: string | null
  /** Commit object name the branch started from. */
  readonly baseCommit: string
  /** Canonical root of the source checkout. */
  readonly repositoryRoot: string
}

/** Payload of the `plugin:client-ui-forge/worktree` record. */
export type WorktreeRecord =
  /** Create a worktree before the Session's first step, starting from `from`, or from HEAD when it is null. */
  | { readonly action: 'request'; readonly from: string | null }
  /** Withdraw the open request. */
  | { readonly action: 'cancel' }
  /** The requested worktree was created and became the Session's working directory. */
  | { readonly action: 'created'; readonly worktree: ForgeSessionWorktree }
  /** Restoration started; the checkout stays unavailable until restoration completes. */
  | { readonly action: 'restoring' }
  /** The recorded worktree was completely restored. */
  | { readonly action: 'restored' }

/** One open worktree request. */
export interface ForgeWorktreeRequest {
  /** Base branch, or null for HEAD of the source checkout. */
  readonly from: string | null
}

/** Host-only state of the `forgeWorktree` projection. */
export interface ForgeWorktreeState {
  /** Open request, or null without one. */
  readonly request: ForgeWorktreeRequest | null
  /** Created worktree, or null before creation. */
  readonly created: ForgeSessionWorktree | null
  /** Whether a turn has started; requests and withdrawals recorded afterwards are ignored. */
  readonly locked: boolean
  /** Whether a step has started; no worktree is created afterwards. */
  readonly stepped: boolean
  /** The Session's working directory as its log last recorded it, or null when none is recorded. */
  readonly cwd: string | null
  /** Whether a restoration started without a successful completion, including across reloads. */
  readonly restoring: boolean
}

/** Why the Session's checkout cannot host a new worktree. */
export type ForgeWorktreeBlocker =
  /** The current directory is not inside a Git checkout. */
  | 'not-git'
  /** The Session's sandbox cannot write the checkout or its Git directory, as for a linked worktree outside the writable root. */
  | 'outside-writable-root'
  /** The Session runs read-only. */
  | 'read-only'

/** One running worktree creation. */
export interface ForgeWorktreeCreation {
  /** Running step: `prepare` validates and creates the branch, then `checkout` writes the files. */
  readonly phase: 'prepare' | 'checkout'
  /** Branch the attempt creates. */
  readonly branch: string
  /** Base branch, or null for HEAD. */
  readonly from: string | null
  /**
   * Whether a message waits for the creation before its turn starts. Only
   * such a creation can be stopped, after which the message keeps waiting; a
   * creation at the first step serves a message the Session already holds.
   */
  readonly held: boolean
}

/** One running restoration of the removed worktree a Session works in. */
export interface ForgeWorktreeRestoration {
  /** Running step: `prepare` registers the checkout again, creating a missing branch, then `checkout` writes the files. */
  readonly phase: 'prepare' | 'checkout'
}

/** The last attempt to create the requested worktree for a message, which failed. */
export interface ForgeWorktreeFailure {
  /** Branch the attempt created, or null when it failed before naming one. */
  readonly branch: string | null
  /** Base branch of the attempt, or null for HEAD. */
  readonly from: string | null
  /** Step that failed. */
  readonly phase: 'prepare' | 'checkout'
  /** Failure text. */
  readonly message: string
}

/**
 * What a message waits for before its turn starts: the creation of the
 * requested worktree, or the restoration or leaving of the removed worktree
 * the Session works in.
 */
export type ForgeWorktreeWaiting = 'creation' | 'restoration'

/** The recorded worktree whose directory is missing, invalid, or incompletely restored. */
export interface ForgeMissingWorktree {
  /** Whether its branch exists, or null when an incomplete restoration cannot inspect it. */
  readonly branchExists: boolean | null
}

/** Worktree facts of one Session in the panel state. */
export interface ForgePanelWorktree {
  /**
   * Whether the Session can still request or withdraw a worktree: a worktree
   * service is mounted, no turn has started, and none was created.
   */
  readonly editable: boolean
  /** Why the checkout cannot host a worktree, or null when it can, before the first inspection, and after a failed one. */
  readonly blocker: ForgeWorktreeBlocker | null
  /** Open request, or null without one. */
  readonly request: ForgeWorktreeRequest | null
  /** Created worktree, or null before creation. */
  readonly created: ForgeSessionWorktree | null
  /** Running creation, or null. */
  readonly creation: ForgeWorktreeCreation | null
  /**
   * The last failed attempt of the creation a message waits for, or null. It
   * clears when another attempt starts, when the request changes or is
   * withdrawn, and when the wait ends.
   */
  readonly failure: ForgeWorktreeFailure | null
  /** The created worktree the Session works in when its directory is gone, or null. */
  readonly missing: ForgeMissingWorktree | null
  /** Running restoration of the removed worktree, or null. */
  readonly restoration: ForgeWorktreeRestoration | null
  /** What a message of the Session waits for before its turn starts, or null while none waits. */
  readonly waiting: ForgeWorktreeWaiting | null
}

/**
 * The last polled state of one change request that a listed Session binds, as
 * the Session list shows it.
 */
export type ForgeChangeRequestListState = Pick<
  ChangeRequestSnapshot, 'url' | 'title' | 'state' | 'draft' | 'checksRollup' | 'reviewDecision' | 'mergeability'
> & {
  /** Change request number on its code host. */
  readonly number: number
}

/**
 * One frame of `forgePanel.changeRequestStates`: the known state of every
 * change request the reader may see first, then the states that changed or
 * became visible since the previous frame.
 */
export type ForgeChangeRequestStatesFrame =
  | { readonly type: 'baseline'; readonly states: readonly ForgeChangeRequestListState[] }
  | { readonly type: 'changed'; readonly states: readonly ForgeChangeRequestListState[] }

/** One bound change request in the panel state. */
export interface ForgePanelChangeRequest extends SessionChangeRequest {
  /** Latest snapshot a poll returned, kept while later polls fail, or null before the first successful poll. */
  readonly snapshot: ChangeRequestSnapshot | null
}

/** Everything the panel shows for one Session. */
export interface ForgePanelState {
  /** Current working directory of the Session. */
  readonly directory: string
  /** Inspection result for `directory`. */
  readonly checkout: ForgeCheckoutState
  /** Code host repository of the checkout's upstream remote or `origin`, or null when no provider serves them. */
  readonly repository: ForgeRepository | null
  /** Sign-in state for the repository's host, or null before the first probe and without a repository. */
  readonly readiness: ForgeReadiness | null
  /** Visible change request bindings with their latest polling results, in first-recorded order. */
  readonly changeRequests: readonly ForgePanelChangeRequest[]
  /** Worktree request and creation state. */
  readonly worktree: ForgePanelWorktree
  /**
   * Files the `branch` scope changes, or null before the first inspection,
   * outside a checkout, and without a fork point.
   */
  readonly local: ForgeLocalChanges | null
}

/** Local branches offered as the base of a new worktree. */
export interface ForgeBranches {
  /** Checked-out branch, or null when HEAD is detached. */
  readonly current: string | null
  /** Local branch names, `current` first and then most recently committed first, at most `maxBranches`. */
  readonly branches: readonly string[]
}

/** Which local changes a diff covers; each reads the Session's checkout through Git. */
export type ForgeLocalScope =
  /**
   * The working tree and untracked files against the fork point: the base commit of the worktree the
   * Session created, else the merge base of HEAD with the default branch of the code host remote.
   */
  | { readonly kind: 'branch' }
  /** The working tree and untracked files against HEAD. */
  | { readonly kind: 'uncommitted' }
  /** The working tree and untracked files against the index. */
  | { readonly kind: 'unstaged' }
  /** The index against HEAD. */
  | { readonly kind: 'staged' }

/** One hunk of a file diff. */
export interface ForgeDiffHunk {
  /** First old line the hunk covers, or the old line it comes before when it covers none. */
  readonly oldStart: number
  /** Old lines the hunk covers. */
  readonly oldLines: number
  /** First new line the hunk covers, or the new line it comes before when it covers none. */
  readonly newStart: number
  /** New lines the hunk covers. */
  readonly newLines: number
  /** Lines in patch form: a leading space for context, `+` for added, `-` for deleted, and `\` for a missing final newline. */
  readonly lines: readonly string[]
}

/** How one file changed. */
export type ForgeDiffStatus = 'added' | 'deleted' | 'modified' | 'renamed'

/** One changed file of a diff. */
export interface ForgeDiffFile {
  /** Path relative to the repository root after the change, or before it for a deleted file. */
  readonly path: string
  /** Path before a rename, else null. */
  readonly previousPath: string | null
  /** How the file changed. */
  readonly status: ForgeDiffStatus
  /** Whether the content is binary, which carries no hunks. */
  readonly binary: boolean
  /** Whether an untracked file exceeds `maxDiffBytes`, so it carries no hunks. */
  readonly oversized: boolean
  /** Whether Git does not track the file yet; only local diffs list such files. */
  readonly untracked: boolean
  /** Lines added. */
  readonly additions: number
  /** Lines deleted. */
  readonly deletions: number
  /** Hunks in file order; none for a binary file or a change of mode or name only. */
  readonly hunks: readonly ForgeDiffHunk[]
}

/** Local changes of the Session's checkout in one scope. */
export interface ForgeLocalDiff {
  /** Ref or abbreviated commit the `branch` scope compares with, such as `origin/master`; null for other scopes. */
  readonly base: string | null
  /** Changed files in Git's path order, untracked files last. */
  readonly files: readonly ForgeDiffFile[]
  /** Untracked files left out beyond `maxUntrackedFiles`. */
  readonly omitted: number
}

/** Changes of a change request as its code host computes them. */
export interface ForgeChangeRequestDiff {
  /** Head commit the diff describes. */
  readonly headSha: string
  /** Changed files in the host's order. */
  readonly files: readonly ForgeDiffFile[]
  /**
   * Commits the checkout's branch has beyond the head when that branch is the change request's head
   * branch and the head commit is present locally; null otherwise.
   */
  readonly localAhead: number | null
  /** Web page of each changed file at the head commit, by path. */
  readonly fileUrls: Readonly<Record<string, string>>
}

/** One file the `branch` scope changes, without its hunks. */
export interface ForgeChangedFile {
  /** Path relative to the repository root after the change. */
  readonly path: string
  /** Lines added, or 0 for a binary file. */
  readonly additions: number
  /** Lines deleted, or 0 for a binary file. */
  readonly deletions: number
  /** Whether the content is binary. */
  readonly binary: boolean
}

/** Size of the `branch` scope, which the panel's local changes card shows. */
export interface ForgeLocalChanges {
  /** Ref or abbreviated commit the scope compares with. */
  readonly base: string
  /** Changed files in Git's path order, untracked files last, at most `maxUntrackedFiles` of those. */
  readonly files: readonly ForgeChangedFile[]
}

/** Host settings of the forge panel Remote. */
export interface Config {
  /** Git executable name or absolute path in the Session's execution world. */
  gitCommand?: string
  /** Deadline in milliseconds for one Git command, including confinement. */
  gitTimeoutMs?: number
  /** Termination grace period in milliseconds for each Git process. */
  graceMs?: number
  /** Maximum captured bytes per Git output stream. */
  maxOutputBytes?: number
  /** Deadline in milliseconds for one provider sign-in probe. */
  readinessTimeoutMs?: number
  /** Most local branches listed as worktree bases. */
  maxBranches?: number
  /**
   * Prefix of the branch and checkout directory created for a Session worktree; the first eight
   * hexadecimal digits of the Session id's UUID, a hyphen, and four random hexadecimal digits follow it.
   */
  worktreePrefix?: string
  /** Largest diff, or file read to show unchanged lines, in bytes. */
  maxDiffBytes?: number
  /** Most untracked files a local diff or the local changes card includes. */
  maxUntrackedFiles?: number
  /** Most UTF-8 bytes of change request diffs kept in memory for later reads at the same head commit and base branch. */
  maxCachedDiffBytes?: number
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No registered provider serves the change request URL. */
    'forgePanel/unrecognized-url': Record<string, never>
    /** A turn of the Session has started, or its worktree was created, so its worktree request can no longer change. */
    'forgePanel/session-started': Record<string, never>
    /** No worktree service is mounted. */
    'forgePanel/worktrees-unavailable': Record<string, never>
    /** The requested base branch name is empty. */
    'forgePanel/invalid-branch': Record<string, never>
    /** The Session has no created worktree to restore or leave. */
    'forgePanel/no-worktree': Record<string, never>
    /** The Session's Agent is not loaded or has other work, so its checkout cannot change now. */
    'forgePanel/session-busy': Record<string, never>
    /** No message of the Session waits after a failed or stopped attempt to create its worktree. */
    'forgePanel/not-waiting': Record<string, never>
    /** The removed worktree could not be checked out again; the message gives the reason. */
    'forgePanel/restore-failed': Record<string, never>
    /** The URL is not a visible binding of the Session that a provider serves, so the panel does not act on it. */
    'forgePanel/not-bound': Record<string, never>
    /** The change request has new commits since the head the user confirmed, so it was not merged. */
    'forgePanel/stale-head': Record<string, never>
    /** The code host refused the change or could not be reached; the message gives the host's reason. */
    'forgePanel/action-failed': Record<string, never>
    /** The Session's directory is not inside a Git checkout, so it has no local changes. */
    'forgePanel/not-a-checkout': Record<string, never>
    /** No remote names a default branch that HEAD shares history with, and the checkout is not a worktree the Session created. */
    'forgePanel/no-fork-point': Record<string, never>
    /** Filter configuration could not be read completely; no comparison ran. Correct Git settings or the output limit before retrying. */
    'forgePanel/filter-config-failed': Record<string, never>
    /**
     * The patch, the untracked file list, or the file exceeds `maxDiffBytes`, or the code host
     * or its provider refuses a change request's diff or file over a size limit.
     */
    'forgePanel/diff-too-large': Record<string, never>
    /** Complete checks could not be loaded; the polling preview remains available. */
    'forgePanel/checks-failed': Record<string, never>
    /** The code host did not provide the change request's diff or file, or its status has not been read yet; the message says why. */
    'forgePanel/diff-failed': Record<string, never>
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** A request, withdrawal, or creation of the worktree a Session starts in. */
    'plugin:client-ui-forge/worktree': WorktreeRecord
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** The worktree the panel created for the Session while the Session works in it, else null. */
    forgeWorktree: ForgeSessionWorktree | null
  }
}
