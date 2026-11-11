/** Provider-neutral vocabulary for code hosts, their change requests, and provider contracts. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** One repository on a code host, identified the way its provider addresses it. */
export interface ForgeRepository {
  /** Provider family that serves the repository, such as `github`. */
  readonly forge: string
  /** Lowercase host name, such as `github.com`. */
  readonly host: string
  /** Owner or namespace path as the host spells it. */
  readonly owner: string
  /** Repository name as the host spells it. */
  readonly name: string
}

/** One change request (pull request or merge request) in a repository. */
export interface ChangeRequestRef {
  /** Repository that holds the change request. */
  readonly repository: ForgeRepository
  /** Host-assigned change request number. */
  readonly number: number
}

/** Canonical identity of a change request across providers; built by `changeRequestKey`. */
export type ChangeRequestKey = Branded<'ChangeRequestKey'>

/** Lifecycle state of a change request. */
export type ChangeRequestState = 'open' | 'closed' | 'merged'

/** Normalized outcome of one status check. */
export type CheckState = 'pending' | 'success' | 'failure' | 'neutral' | 'skipped' | 'cancelled'

/** Opaque host identity of a status check that a rerun names. */
export type ForgeCheckId = Branded<'ForgeCheckId'>

/** One status check reported for the head commit of a change request. */
export interface ChangeRequestCheck {
  /** Check name as the host displays it. */
  readonly name: string
  /** Normalized check outcome. */
  readonly state: CheckState
  /** Web page for the check, or null when the host reports none. */
  readonly url: string | null
  /** Workflow that produced the check, or null when the host reports none. */
  readonly workflow: string | null
  /** ISO 8601 time the check started, or null before it starts and when the host reports none. */
  readonly startedAt: string | null
  /** ISO 8601 time the check completed, or null while it runs and when the host reports none. */
  readonly completedAt: string | null
  /**
   * Identity a rerun of this check names, or null when the provider cannot rerun it, as for a commit status. Checks that
   * name one identity rerun together, and their failed checks can be rerun once none of them is pending.
   */
  readonly rerun: ForgeCheckId | null
}

/** Combined outcome of all checks on the head commit. */
export type ChecksRollup = 'none' | 'pending' | 'success' | 'failure'

/** Whether the change request can merge into its base without conflicts. */
export type Mergeability = 'mergeable' | 'conflicting' | 'unknown'

/** Aggregate review outcome required by the host's merge rules. */
export type ReviewDecision = 'approved' | 'changes-requested' | 'review-required' | 'none'

/** How a merge brings the commits of a change request into its base branch. */
export type MergeMethod = 'merge' | 'squash' | 'rebase'

/** How an update brings the base branch's new commits into the head branch: a merge commit, or a rebase of the head's commits. */
export type BranchUpdateMethod = 'merge' | 'rebase'

/** Outcome of a reviewer's latest submitted review. */
export type ReviewVerdict = 'approved' | 'changes-requested' | 'commented' | 'dismissed'

/** An account or team asked to review a change request, or an account that reviewed it. */
export interface ChangeRequestReviewer {
  /** Whether the reviewer is a person's account, an app or bot account, or a team. */
  readonly kind: 'user' | 'bot' | 'team'
  /** Login, or `organization/slug` for a team. */
  readonly login: string
  /** Avatar image URL, or null when the host reports none. */
  readonly avatarUrl: string | null
  /** Whether a review from the reviewer is requested now. */
  readonly requested: boolean
  /** Whether the host requested the review because the reviewer owns changed paths. */
  readonly codeOwner: boolean
  /** Outcome of the reviewer's latest submitted review, or null before the first. */
  readonly verdict: ReviewVerdict | null
  /** Commit the latest submitted review was on, or null before the first or when the host reports none. */
  readonly reviewedSha: string | null
}

/** One issue linked to a change request, which the host closes once the change request merges. */
export interface ChangeRequestIssue {
  /** Repository that holds the issue. */
  readonly repository: ForgeRepository
  /** Host-assigned issue number. */
  readonly number: number
  /** Title as the author wrote it. */
  readonly title: string
  /** Whether the issue is still open. */
  readonly state: 'open' | 'closed'
  /** Web page of the issue. */
  readonly url: string
}

/** Status of one change request at the time its provider read it. */
export interface ChangeRequestSnapshot {
  /** Change request the snapshot describes. */
  readonly ref: ChangeRequestRef
  /** Web page of the change request. */
  readonly url: string
  /** Title as the author wrote it. */
  readonly title: string
  /** Lifecycle state. */
  readonly state: ChangeRequestState
  /** Whether the author marked the change request as a draft. */
  readonly draft: boolean
  /** Author login, or null when the host hides it. */
  readonly author: string | null
  /** Branch that carries the proposed commits. */
  readonly headBranch: string
  /** Commit object name at the head of the change request. */
  readonly headSha: string
  /** Branch the change request merges into. */
  readonly baseBranch: string
  /**
   * Base commit the host recorded with `headSha`, whose merge base with the head starts the change request's diff;
   * omitted when the provider does not report it.
   */
  readonly baseSha?: string
  /** Lines the change request adds. */
  readonly additions: number
  /** Lines the change request deletes. */
  readonly deletions: number
  /** Merge conflict status; `unknown` while the host computes it. */
  readonly mergeability: Mergeability
  /**
   * Whether the host would merge the change request now for the signed-in
   * user: open, not a draft, and meeting the base branch's merge rules.
   */
  readonly mergeReady: boolean
  /** Merge methods the repository accepts, the signed-in user's usual one first. */
  readonly mergeMethods: readonly MergeMethod[]
  /**
   * Ways the signed-in user can bring the base branch's new commits into the head branch now; empty while the head is
   * up to date, while the branches conflict, when the user cannot update the head branch, or when the provider cannot,
   * so a head behind its base cannot be told apart from a current one for a user without the right to update it.
   */
  readonly branchUpdates: readonly BranchUpdateMethod[]
  /** Aggregate review outcome. */
  readonly reviewDecision: ReviewDecision
  /** Reviewers whose review is requested, in host order, then other accounts that reviewed, each once; the author is never listed. */
  readonly reviewers: readonly ChangeRequestReviewer[]
  /** Whether the host reported more review requests or reviews than the provider read, so `reviewers` may be incomplete. */
  readonly reviewersTruncated: boolean
  /** Whether the signed-in user may request reviews of the change request through its provider. */
  readonly canRequestReviews: boolean
  /** Checks on the head commit in host order. */
  readonly checks: readonly ChangeRequestCheck[]
  /** Combined check outcome. */
  readonly checksRollup: ChecksRollup
  /** Whether the host reported more checks than `checks` contains. */
  readonly checksTruncated: boolean
  /** Whether the signed-in user may rerun the failed checks that name a `rerun`. */
  readonly canRerunChecks: boolean
  /** Number of counted review threads that are not resolved. */
  readonly unresolvedThreads: number
  /** Whether the change request has more review threads than the provider counted, so `unresolvedThreads` is a lower bound. */
  readonly threadsTruncated: boolean
  /** Issues linked to the change request, which the host closes once it merges, in host order. */
  readonly closingIssues: readonly ChangeRequestIssue[]
  /** Whether the host reported more closing issues than `closingIssues` holds. */
  readonly closingIssuesTruncated: boolean
  /** ISO 8601 time of the host's last update to the change request. */
  readonly updatedAt: string
  /** ISO 8601 time the change request was merged or closed, or null while it is open. */
  readonly closedAt: string | null
}

/** Why a provider could not read a change request. */
export interface ForgeFailure {
  /**
   * `not-found`: the host does not expose it; `unauthenticated`: credentials are missing or rejected;
   * `too-large`: the host or the provider refuses an answer over its size limit, so reading again fails
   * the same way; `stale`: the head is no longer the commit the read named, so reading again at the head of
   * a later status can succeed; `unsupported`: the provider does not offer the read; `unavailable`: any other failure.
   */
  readonly code: 'not-found' | 'unauthenticated' | 'too-large' | 'stale' | 'unsupported' | 'unavailable'
  /** Human-readable cause. */
  readonly message: string
}

/** Latest polling result delivered to watchers of one change request. */
export type ChangeRequestUpdate = {
  /** Canonical identity of the watched change request. */
  readonly key: ChangeRequestKey
  /** Epoch milliseconds when the result settled. */
  readonly fetchedAt: number
} & ({
  /** Status read from the host. */
  readonly snapshot: ChangeRequestSnapshot
} | {
  /** Reason the status could not be read. */
  readonly failure: ForgeFailure
})

/** A merge the user confirmed for the head commit they saw. */
export interface MergeRequest {
  /** How the commits enter the base branch. */
  readonly method: MergeMethod
  /** Commit object name the head must still have; the merge is refused once the head moves. */
  readonly headSha: string
}

/** A branch update the user confirmed for the head commit they saw. */
export interface BranchUpdateRequest {
  /** How the base branch's new commits enter the head branch. */
  readonly method: BranchUpdateMethod
  /** Commit object name the head must still have; the update is refused once the head moves. */
  readonly headSha: string
}

/** A rerun of the failed checks of the head commit whose checks the user saw. */
export interface ForgeRerunRequest {
  /** Head commit whose checks the user saw; the provider refuses with `stale` once the head is another commit. */
  readonly headSha: string
}

/** Reviewers to ask in addition to those whose review is requested now; one who already reviewed is asked again. */
export interface ForgeReviewersRequest {
  /** The reviewers by kind and login, a team by `organization/slug`. */
  readonly reviewers: readonly Pick<ChangeRequestReviewer, 'kind' | 'login'>[]
}

/** An account a review of the change request can be requested from. */
export interface ForgeReviewerCandidate {
  /** Login as the host spells it. */
  readonly login: string
  /** Display name, or null when the account shows none. */
  readonly name: string | null
  /** Avatar image URL, or null when the host reports none. */
  readonly avatarUrl: string | null
  /** Whether the host suggests the account for this change request, as from the history of its changed files. */
  readonly suggested: boolean
}

/** One inline comment addressed to the old or new side of a pull request diff. */
export interface ForgeLineComment {
  readonly path: string
  readonly side: 'L' | 'R'
  readonly startLine: number
  readonly endLine: number
  readonly body: string
}

/** A single published comment or one completed review containing all pending comments. */
export type ForgeReviewRequest = {
  /** Commit the user reviewed; providers must check it before writing and address that commit explicitly. */
  readonly headSha: string
} & (
  | { readonly kind: 'comment'; readonly comment: ForgeLineComment }
  | { readonly kind: 'review'; readonly event: ForgeReviewEvent; readonly body: string; readonly comments: readonly ForgeLineComment[] }
)

/** Opaque host identity of one review thread. */
export type ForgeThreadId = Branded<'ForgeThreadId'>

/** Opaque host identity of one review comment. */
export type ForgeCommentId = Branded<'ForgeCommentId'>

/** Opaque host identity of one review. */
export type ForgeReviewId = Branded<'ForgeReviewId'>

/** Consecutive lines on one side of a diff whose new side is one commit. */
export interface ForgeAnchor {
  /**
   * Full object name of the commit the diff's new side shows: new-side (`R`) lines number this commit's file, and
   * old-side (`L`) lines number the file at the diff's base.
   */
  readonly commit: string
  /** First line, inclusive. */
  readonly startLine: number
  /** Last line, inclusive. */
  readonly endLine: number
}

/** Account that wrote a review comment. */
export interface ForgeCommentAuthor {
  /** Login as the host spells it. */
  readonly login: string
  /** Avatar image URL, or null when the host reports none. */
  readonly avatarUrl: string | null
  /** Whether the account is an app or bot rather than a person. */
  readonly bot: boolean
}

/** One comment of a review thread. */
export interface ForgeReviewComment {
  /** Host identity of the comment. */
  readonly id: ForgeCommentId
  /** Author, or null when the account no longer exists. */
  readonly author: ForgeCommentAuthor | null
  /** Markdown source as the author wrote it; it may contain raw HTML, which readers must not render as HTML. */
  readonly body: string
  /** ISO 8601 time the comment was created. */
  readonly createdAt: string
  /** Whether the comment belongs to the signed-in user's review that is not submitted yet, which only that user sees. */
  readonly pending: boolean
  /** Web page of the comment, or null when the host reports none. */
  readonly url: string | null
  /** Whether the signed-in user can replace the comment's text through `writeReview`; false for a provider without it. */
  readonly viewerCanEdit: boolean
  /** Whether the signed-in user can delete the comment through `writeReview`; false for a provider without it. */
  readonly viewerCanDelete: boolean
}

/**
 * One review thread on a file of a change request. A line thread has two positions: `original` on the commit it was
 * written on, and `current` on the head commit of the read. `current` is null once the host no longer places the
 * thread on the head commit, as after later commits changed its lines.
 */
export interface ForgeReviewThread {
  /** Host identity of the thread. */
  readonly id: ForgeThreadId
  /** Repository-relative path the thread is on. */
  readonly path: string
  /** Old (`L`) or new (`R`) side of the diff the lines number. */
  readonly side: 'L' | 'R'
  /** Whether the thread is on lines or on the whole file. */
  readonly subject: 'line' | 'file'
  /** Lines in the diff that ends at the head commit of the read, whose `commit` is that head; null for an outdated or file thread. */
  readonly current: ForgeAnchor | null
  /** Lines in the diff that ended at the commit the thread was written on; null for a file thread. */
  readonly original: ForgeAnchor | null
  /** Diff hunk the host recorded when the thread was written, ending at its last line; null when it recorded none. */
  readonly diffHunk: string | null
  /** Whether the thread is marked resolved. */
  readonly resolved: boolean
  /** Whether the signed-in user can reply to the thread through `writeReview`; false for a provider without it. */
  readonly viewerCanReply: boolean
  /**
   * Whether the signed-in user can mark the thread resolved, or unresolved when `resolved`, through `writeReview`; false
   * for a provider without it.
   */
  readonly viewerCanResolve: boolean
  /** Comments oldest first; the first starts the thread. */
  readonly comments: readonly ForgeReviewComment[]
}

/** The signed-in user's review of a change request that is not submitted yet, which only that user sees. */
export interface ForgePendingReview {
  /** Host identity of the review. */
  readonly id: ForgeReviewId
  /** Comments the review holds. */
  readonly comments: number
}

/** Review threads of a change request read at one head commit. */
export interface ForgeReviewData {
  /** Head commit the threads were read at; `current` positions number its files. */
  readonly headSha: string
  /** Login of the signed-in user the provider read as, or null when the host does not name one. */
  readonly viewer: string | null
  /** Threads in host order, at most the provider's limit. */
  readonly threads: readonly ForgeReviewThread[]
  /** Whether the change request has more threads than `threads` holds. */
  readonly truncated: boolean
  /** The signed-in user's pending review, or null without one. */
  readonly pendingReview: ForgePendingReview | null
  /**
   * Whether the signed-in user can add comments to a pending review and submit or discard it through `writeReview`;
   * false for a provider without it.
   */
  readonly viewerCanReview: boolean
}

/** Decision a submitted review records. */
export type ForgeReviewEvent = 'comment' | 'approve' | 'request-changes'

/**
 * One write to the review threads and the pending review of a change request. `pending` replies and `add-pending`
 * comments join the signed-in user's pending review, which is started when the user has none. A host that adds every
 * reply to an existing pending review, as GitHub does, refuses a reply with `pending: false` while one exists.
 */
export type ForgeReviewWrite = {
  /** Head commit the user saw; providers check it before writing and refuse with `stale` once the head is another commit. */
  readonly headSha: string
} & (
  | { readonly kind: 'reply'; readonly thread: ForgeThreadId; readonly body: string; readonly pending: boolean }
  | { readonly kind: 'resolve'; readonly thread: ForgeThreadId; readonly resolved: boolean }
  | { readonly kind: 'edit-comment'; readonly comment: ForgeCommentId; readonly body: string }
  /** Deleting the only comment of a thread deletes the thread. */
  | { readonly kind: 'delete-comment'; readonly comment: ForgeCommentId }
  /** A comment on lines of `headSha`. */
  | { readonly kind: 'add-pending'; readonly comment: ForgeLineComment }
  | { readonly kind: 'submit-pending'; readonly review: ForgeReviewId; readonly event: ForgeReviewEvent; readonly body: string }
  /** Delete the pending review with every comment it holds. */
  | { readonly kind: 'discard-pending'; readonly review: ForgeReviewId }
)

/** Result of a review write; an `unknown` outcome must be checked on the host before the write is tried again. */
export type ForgeReviewWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'unsupported' | 'stale' | 'failed' | 'unknown'; readonly message: string }

/**
 * One review change the host accepted, which `forge/review-changed` announces: a write to the threads or the pending
 * review, a submitted review, or a viewed mark. Each names the head commit the change was made against.
 */
export type ForgeReviewChange =
  | { readonly kind: 'write'; readonly write: ForgeReviewWrite['kind']; readonly headSha: string }
  | { readonly kind: 'submit'; readonly headSha: string }
  | { readonly kind: 'viewed'; readonly path: string; readonly viewed: boolean; readonly headSha: string }

/** Result of a review submission; unknown outcomes must be checked on the host before another submission. */
export type ForgeReviewResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly code: 'unsupported' | 'stale' | 'failed' | 'unknown'; readonly message: string }

/** Why a provider could not change a change request, or could not confirm that it did. */
export interface ForgeActionFailure {
  /**
   * `unauthenticated`: credentials are missing or rejected; `stale`: the head
   * moved past the confirmed commit; `failed`: the host refused or could not be reached, so nothing changed;
   * `unknown`: the request reached the host but its answer did not confirm the outcome, so the change may have been
   * applied and must be checked on the host before it is tried again.
   */
  readonly code: 'unauthenticated' | 'stale' | 'failed' | 'unknown'
  /** Human-readable cause, usually the host's own message. */
  readonly message: string
}

/** One commit of a change request. */
export interface ForgeCommit {
  /** Full commit object name. */
  readonly sha: string
  /** Full object name of the first parent, or null for a root commit. */
  readonly parent: string | null
  /** First line of the commit message. */
  readonly title: string
  /** Author name or login as the host reports it, or null when it reports none. */
  readonly author: string | null
  /** ISO 8601 time the commit was authored. */
  readonly authoredAt: string
}

/** The commits of a change request at one head commit. */
export interface ForgeCommitList {
  /** Head commit the list was read at. */
  readonly headSha: string
  /** Commits oldest first, ending with the head commit unless `truncated`. */
  readonly commits: readonly ForgeCommit[]
  /** Whether the change request has more commits than the provider lists; the listed ones are the oldest. */
  readonly truncated: boolean
}

/**
 * The signed-in user's review progress on one changed file: `viewed`, `unviewed`, or `dismissed` once the file
 * changed after the user marked it viewed.
 */
export type ForgeViewedState = 'viewed' | 'unviewed' | 'dismissed'

/** The signed-in user's viewed marks on the files of a change request, read at one head commit. */
export interface ForgeViewedFiles {
  /** Head commit the marks were read at. */
  readonly headSha: string
  /** State of each changed file the host listed, by repository-relative path. */
  readonly files: Readonly<Record<string, ForgeViewedState>>
  /** Whether the change request has more files than `files` lists. */
  readonly truncated: boolean
}

/** A viewed mark the user set or cleared on a file of the head commit they saw. */
export interface ForgeViewedRequest {
  /** Repository-relative path of the changed file. */
  readonly path: string
  /** Whether the file is viewed. */
  readonly viewed: boolean
  /** Head commit whose changes the user saw; the provider refuses with `stale` once the head is another commit. */
  readonly headSha: string
}

/** Whether a provider can reach one host with the current credentials. */
export interface ForgeReadiness {
  /** `ready`, `unauthenticated` (sign-in needed), or `unavailable` (tool missing or host unreachable). */
  readonly state: 'ready' | 'unauthenticated' | 'unavailable'
  /** Human-readable detail, or null when ready. */
  readonly message: string | null
}

/**
 * Host-specific access registered with `ctx.forge`. One provider serves one
 * forge family; methods that take a signal must stop work when it aborts.
 */
export interface ForgeProvider {
  /** Forge family name stored in every repository this provider returns. */
  readonly forge: string
  /** Publish a comment or completed review. Omission declares that this provider cannot write reviews. */
  submitReview?(ref: ChangeRequestRef, request: ForgeReviewRequest, signal: AbortSignal): Promise<ForgeReviewResult>
  /**
   * Read the review threads of a change request at head commit `headSha`. The threads are returned only when the
   * read names `headSha` as the head; once the head is another commit, the read resolves to a `stale` failure.
   * Omission declares that this provider cannot read reviews.
   */
  readReview?(ref: ChangeRequestRef, headSha: string, signal: AbortSignal): Promise<ForgeReviewData | ForgeFailure>
  /**
   * Write to the review threads or the pending review of a change request while its head is `write.headSha`; once the
   * head is another commit, the write resolves to `stale` without writing. A write is never retried. Omission declares
   * that this provider cannot write reviews, and its `readReview` then reports no viewer permission.
   */
  writeReview?(ref: ChangeRequestRef, write: ForgeReviewWrite, signal: AbortSignal): Promise<ForgeReviewWriteResult>
  /** Map a Git remote URL to its repository, or undefined when this provider does not serve it. */
  repositoryFromRemote(url: string): ForgeRepository | undefined
  /** Map a change request web URL to its reference, or undefined when this provider does not serve it. */
  changeRequestFromUrl(url: string): ChangeRequestRef | undefined
  /** Build the canonical web URL of a change request this provider serves. */
  changeRequestUrl(ref: ChangeRequestRef): string
  /** Read the status of several change requests, returning one result per requested key. */
  fetch(
    refs: readonly ChangeRequestRef[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<ChangeRequestKey, ChangeRequestSnapshot | ForgeFailure>>
  /** Read all checks for one change request on demand; omission declares that only the polling preview is available. */
  fetchChecks?(ref: ChangeRequestRef, signal: AbortSignal): Promise<ChangeRequestSnapshot | ForgeFailure>
  /** Find open change requests whose head is `branch` in `repository`, excluding the default branch and forks. */
  findByHead(repository: ForgeRepository, branch: string, signal: AbortSignal): Promise<readonly ChangeRequestRef[]>
  /** Report whether the provider can reach `host` with current credentials. */
  readiness(host: string, signal: AbortSignal): Promise<ForgeReadiness>
  /** Mark a draft change request ready for review, resolving to undefined once the host accepted it. */
  markReady(ref: ChangeRequestRef, signal: AbortSignal): Promise<ForgeActionFailure | undefined>
  /** Merge a change request while its head is still `request.headSha`, resolving to undefined once merged. */
  merge(ref: ChangeRequestRef, request: MergeRequest, signal: AbortSignal): Promise<ForgeActionFailure | undefined>
  /**
   * Read the changes of a change request at head commit `headSha` as the host computes them, as one unified
   * patch with `a/` and `b/` path prefixes. A patch is returned only when it describes `headSha`; once the
   * head is another commit, the read resolves to a `stale` failure. `base`, when given, is the `baseSha` the
   * latest status recorded with `headSha`; a provider may start reading from it before it confirms the head.
   */
  diff(ref: ChangeRequestRef, headSha: string, signal: AbortSignal, base?: string): Promise<string | ForgeFailure>
  /** Read the text of `path` at `commit` in the change request's repository. */
  fileText(ref: ChangeRequestRef, commit: string, path: string, signal: AbortSignal): Promise<string | ForgeFailure>
  /** Build the web page of `path` at `commit` in the change request's repository. */
  fileUrl(ref: ChangeRequestRef, commit: string, path: string): string
  /**
   * List the commits of a change request at its current head. A provider implements `commits` and `compare`
   * together; omitting either declares that the change request can be read only as a whole.
   */
  commits?(ref: ChangeRequestRef, signal: AbortSignal): Promise<ForgeCommitList | ForgeFailure>
  /**
   * Read the changes from commit `base` to commit `head` in the change request's repository, as one unified patch
   * with `a/` and `b/` path prefixes. Both are full object names; `head` descends from `base`.
   */
  compare?(ref: ChangeRequestRef, base: string, head: string, signal: AbortSignal): Promise<string | ForgeFailure>
  /**
   * Find the merge base of commits `base` and `head` in the change request's repository, as a full object name: the
   * commit whose files the old side of a change request's diff shows. Omission declares that the provider cannot name
   * it, so readers of the old side get `unsupported`.
   */
  mergeBase?(ref: ChangeRequestRef, base: string, head: string, signal: AbortSignal): Promise<string | ForgeFailure>
  /**
   * Read the signed-in user's viewed marks on the change request's files at head commit `headSha`. The marks are
   * returned only when the read names `headSha` as the head; once the head is another commit, the read resolves to a
   * `stale` failure. A provider implements `viewedFiles` and `setViewed` together; omitting either declares that the
   * host keeps no viewed marks.
   */
  viewedFiles?(ref: ChangeRequestRef, headSha: string, signal: AbortSignal): Promise<ForgeViewedFiles | ForgeFailure>
  /**
   * Set or clear the signed-in user's viewed mark on one file while the head is still `request.headSha`, resolving to
   * undefined once the host saved it.
   */
  setViewed?(ref: ChangeRequestRef, request: ForgeViewedRequest, signal: AbortSignal): Promise<ForgeActionFailure | undefined>
  /**
   * Rerun the failed checks of the head commit that name a `rerun` none of whose checks is pending, while the head is
   * still `request.headSha`, resolving to undefined once the host accepted every rerun. Omission declares that the
   * provider reruns no checks, and its snapshots then name none.
   */
  rerunChecks?(ref: ChangeRequestRef, request: ForgeRerunRequest, signal: AbortSignal): Promise<ForgeActionFailure | undefined>
  /**
   * Request reviews from more reviewers, resolving to undefined once the host accepted the request. A provider implements
   * `requestReviews` and `reviewerCandidates` together; omitting either declares that it requests no reviews, and its
   * snapshots then deny `canRequestReviews`.
   */
  requestReviews?(ref: ChangeRequestRef, request: ForgeReviewersRequest, signal: AbortSignal): Promise<ForgeActionFailure | undefined>
  /** List accounts whose login or name matches `query`, the host's suggestions first, for a review request. */
  reviewerCandidates?(ref: ChangeRequestRef, query: string, signal: AbortSignal): Promise<readonly ForgeReviewerCandidate[] | ForgeFailure>
  /**
   * Bring the base branch's new commits into the head branch while its head is still `request.headSha`, resolving to
   * undefined once the host accepted the update. Omission declares that the provider updates no branches, and its
   * snapshots then offer no `branchUpdates`.
   */
  updateBranch?(ref: ChangeRequestRef, request: BranchUpdateRequest, signal: AbortSignal): Promise<ForgeActionFailure | undefined>
}

/**
 * Receives every polling result for one watched change request.
 * @param update - the settled result.
 */
export type ChangeRequestListener = (update: ChangeRequestUpdate) => void

/** Poll cadence and fetch deadline for watched change requests. */
export interface Config {
  /** Poll interval in milliseconds while checks run or mergeability is unknown. */
  activeIntervalMs?: number
  /** Poll interval in milliseconds for a closed request or an open request whose checks have settled. */
  idleIntervalMs?: number
  /** Largest delay in milliseconds between polls after consecutive failures. */
  maxBackoffMs?: number
  /** Deadline in milliseconds for one provider fetch. */
  fetchTimeoutMs?: number
}
