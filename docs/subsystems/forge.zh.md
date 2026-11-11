# Forges

[English](forge.md) | 中文

实验性的 forge 能力 seam 从代码托管平台读取变更请求（change request，即 pull request 与 merge request）。[`dsh-experimental-forge`](../../packages/experimental/forge/README.zh.md) 是 Service Definition，提供 `ctx.forge`；[`dsh-experimental-forge-github`](../../packages/experimental/forge-github/README.zh.md) 是服务 GitHub 主机的 Service Provider；[`dsh-experimental-forge-session`](../../packages/experimental/forge-session/README.zh.md) 是把变更请求绑定到 Session 的 Consumer，提供 `ctx.forgeSession`；[`dsh-experimental-client-ui-forge`](../../packages/experimental/client-ui-forge/README.zh.md) 是提供 `ctx.forgePanel` 的 GUI Consumer。默认禁用的 [forge Bundle](../../packages/experimental/forge-bundle/README.zh.md) 可从插件页面组合这四个包，同时加载[工作树模型工具](../../packages/experimental/tool-worktree/README.zh.md)，并为面板附带一个隔离的 [worktree 服务](../../packages/experimental/worktree/README.zh.md)；除此之外，它们只能通过显式组合加载。

## 提供方与变更请求

一个提供方服务一个 forge 家族，例如 `github`。它把 Git 远端 URL 映射为仓库，把变更请求 URL 映射为引用，构造规范的变更请求 URL，按 head 分支查找打开状态的变更请求，并批量读取状态。`changeRequestKey` 从引用派生一个不区分大小写的键，因此 URL 拼写不同的监听方共享同一个轮询循环。

```ts type-equiv
/** One repository on a code host, identified the way its provider addresses it. */
interface ForgeRepository {
  /** Provider family that serves the repository, such as `github`. */
  readonly forge: string
  /** Lowercase host name, such as `github.com`. */
  readonly host: string
  /** Owner or namespace path as the host spells it. */
  readonly owner: string
  /** Repository name as the host spells it. */
  readonly name: string
}
```

```ts type-equiv
/** One change request (pull request or merge request) in a repository. */
interface ChangeRequestRef {
  /** Repository that holds the change request. */
  readonly repository: ForgeRepository
  /** Host-assigned change request number. */
  readonly number: number
}
```

```ts type-equiv
/** Canonical identity of a change request across providers; built by `changeRequestKey`. */
type ChangeRequestKey = Branded<'ChangeRequestKey'>
```

```ts type-equiv
/**
 * Host-specific access registered with `ctx.forge`. One provider serves one
 * forge family; methods that take a signal must stop work when it aborts.
 */
interface ForgeProvider {
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
```

```ts type-equiv
/** One commit of a change request. */
interface ForgeCommit {
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
```

```ts type-equiv
/** The commits of a change request at one head commit. */
interface ForgeCommitList {
  /** Head commit the list was read at. */
  readonly headSha: string
  /** Commits oldest first, ending with the head commit unless `truncated`. */
  readonly commits: readonly ForgeCommit[]
  /** Whether the change request has more commits than the provider lists; the listed ones are the oldest. */
  readonly truncated: boolean
}
```

`ctx.forge.commits` 与 `ctx.forge.compare` 委托给同时实现两者的提供方；否则 `commits` 返回 undefined，`compare` 返回 `unavailable` 失败，因此 forge 面板只在提供方能读取提交时提供提交选择器。

```ts type-equiv
/** Whether a provider can reach one host with the current credentials. */
interface ForgeReadiness {
  /** `ready`, `unauthenticated` (sign-in needed), or `unavailable` (tool missing or host unreachable). */
  readonly state: 'ready' | 'unauthenticated' | 'unavailable'
  /** Human-readable detail, or null when ready. */
  readonly message: string | null
}
```

## 状态轮询

`ctx.forge.watch` 让同一变更请求的所有监听方共享一个轮询循环，并把每次结果作为更新送达。每个 forge 同时最多只有一次读取在进行。轮询节奏、退避与超时规则见[注册表 README](../../packages/experimental/forge/README.zh.md#use-this-package)。

```ts type-equiv
/** Lifecycle state of a change request. */
type ChangeRequestState = 'open' | 'closed' | 'merged'
```

```ts type-equiv
/** Normalized outcome of one status check. */
type CheckState = 'pending' | 'success' | 'failure' | 'neutral' | 'skipped' | 'cancelled'
```

```ts type-equiv
/** One status check reported for the head commit of a change request. */
interface ChangeRequestCheck {
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
```

```ts type-equiv
/** Combined outcome of all checks on the head commit. */
type ChecksRollup = 'none' | 'pending' | 'success' | 'failure'
```

```ts type-equiv
/** Whether the change request can merge into its base without conflicts. */
type Mergeability = 'mergeable' | 'conflicting' | 'unknown'
```

```ts type-equiv
/** Aggregate review outcome required by the host's merge rules. */
type ReviewDecision = 'approved' | 'changes-requested' | 'review-required' | 'none'
```

```ts type-equiv
/** Status of one change request at the time its provider read it. */
interface ChangeRequestSnapshot {
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
```

```ts type-equiv
/** Why a provider could not read a change request. */
interface ForgeFailure {
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
```

```ts type-equiv
/** Latest polling result delivered to watchers of one change request. */
type ChangeRequestUpdate = {
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
```

```ts type-equiv
/**
 * Receives every polling result for one watched change request.
 * @param update - the settled result.
 */
type ChangeRequestListener = (update: ChangeRequestUpdate) => void
```

## 变更请求操作

`ctx.forge.markReady` 把草稿标记为可评审，`ctx.forge.merge` 只在 head 仍是用户确认的提交时合并变更请求。主机拒绝时，两者都 resolve 为 `ForgeActionFailure` 而不是抛错，并在结束后立即轮询被监听的变更请求。快照的 `mergeReady` 与 `mergeMethods` 告诉消费方何时提供合并、可用哪些合并方式；GitHub 如何给出这两项由 [GitHub 提供方 README](../../packages/experimental/forge-github/README.zh.md#use-this-package) 说明。

```ts type-equiv
/** A merge the user confirmed for the head commit they saw. */
interface MergeRequest {
  /** How the commits enter the base branch. */
  readonly method: MergeMethod
  /** Commit object name the head must still have; the merge is refused once the head moves. */
  readonly headSha: string
}
```

```ts type-equiv
/** Why a provider could not change a change request, or could not confirm that it did. */
interface ForgeActionFailure {
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
```

`ctx.forge.submitReview` 将明确指定的评论或完整评审交给 provider；未实现此能力的 provider 返回不支持。消费者在再次提交前核对结果不明的写操作；留待之后一起提交的评论通过 `ctx.forge.writeReview` 写入代码托管平台的待提交评审。

```ts type-equiv
/** One inline comment addressed to the old or new side of a pull request diff. */
interface ForgeLineComment {
  readonly path: string
  readonly side: 'L' | 'R'
  readonly startLine: number
  readonly endLine: number
  readonly body: string
}
```

```ts type-equiv
/** A single published comment or one completed review containing all pending comments. */
type ForgeReviewRequest = {
  /** Commit the user reviewed; providers must check it before writing and address that commit explicitly. */
  readonly headSha: string
} & (
  | { readonly kind: 'comment'; readonly comment: ForgeLineComment }
  | { readonly kind: 'review'; readonly event: ForgeReviewEvent; readonly body: string; readonly comments: readonly ForgeLineComment[] }
)
```

```ts type-equiv
/** Result of a review submission; unknown outcomes must be checked on the host before another submission. */
type ForgeReviewResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly code: 'unsupported' | 'stale' | 'failed' | 'unknown'; readonly message: string }
```

## 评审讨论

`ctx.forge.readReview(ref, headSha, signal)` 读取变更请求在某个 head 提交处的评审讨论。只有当读取时的 head 就是 `headSha` 时，提供方才返回 `ForgeReviewData`；否则返回 `stale`，并像 diff 读取遇到 `stale` 时一样，立即重新轮询被关注的变更请求。提供方没有实现 `readReview` 时，服务返回 `unsupported`，使用方据此不显示讨论，也不报错。行级讨论有两套位置：`original` 是写下讨论时所在提交上的行，`current` 是本次读取的 head 上的行；托管平台不再把讨论放在该提交上时，`current` 为 null。显示 head diff 的使用方把讨论放在 `current` 位置，其余讨论用 `diffHunk` 展示；用 `fileText` 读取 `original.commit` 上的文件，可以看到写下讨论时的完整文件。GitHub 各字段如何映射到这两套位置，由 [GitHub 提供方 README](../../packages/experimental/forge-github/README.zh.md#use-this-package) 说明。

```ts type-equiv
/** Opaque host identity of one review thread. */
type ForgeThreadId = Branded<'ForgeThreadId'>
```

```ts type-equiv
/** Opaque host identity of one review comment. */
type ForgeCommentId = Branded<'ForgeCommentId'>
```

```ts type-equiv
/** Consecutive lines on one side of a diff whose new side is one commit. */
interface ForgeAnchor {
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
```

```ts type-equiv
/** Account that wrote a review comment. */
interface ForgeCommentAuthor {
  /** Login as the host spells it. */
  readonly login: string
  /** Avatar image URL, or null when the host reports none. */
  readonly avatarUrl: string | null
  /** Whether the account is an app or bot rather than a person. */
  readonly bot: boolean
}
```

```ts type-equiv
/** One comment of a review thread. */
interface ForgeReviewComment {
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
```

```ts type-equiv
/**
 * One review thread on a file of a change request. A line thread has two positions: `original` on the commit it was
 * written on, and `current` on the head commit of the read. `current` is null once the host no longer places the
 * thread on the head commit, as after later commits changed its lines.
 */
interface ForgeReviewThread {
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
```

```ts type-equiv
/** Review threads of a change request read at one head commit. */
interface ForgeReviewData {
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
```

`ctx.forge.writeReview(ref, write, signal)` 写入评审讨论和当前登录用户的待提交评审：回复讨论，立即发布，或在 `pending` 时加入待提交评审；把讨论标记为已解决或取消解决；编辑或删除评论；在 head 上添加一条行内评论到待提交评审；以及提交或丢弃待提交评审。用户还没有待提交评审时，待提交的回复或评论会先开始一个评审。每个写操作都带有用户看到的 head 提交；提供方先检查它，head 已变化时不写入，直接返回 `stale`，并像读取遇到 `stale` 时那样重新轮询被关注的变更请求；其他结果之后，服务都会立即重新轮询被关注的变更请求。写操作从不重试；结果为 `unknown` 时，必须先在托管平台上核对，再重试。提供方没有实现 `writeReview` 时，服务返回 `unsupported`。`ForgeReviewData` 带有待提交评审，以及用户对每个讨论、每条评论和待提交评审的权限；未实现 `writeReview` 的提供方把这些权限报告为没有，使用方据此只提供能够成功的写操作。GraphQL mutation 以及它们的结果如何对应到这些返回值，由 [GitHub 提供方 README](../../packages/experimental/forge-github/README.zh.md#use-this-package) 说明。

```ts type-equiv
/** Opaque host identity of one review. */
type ForgeReviewId = Branded<'ForgeReviewId'>
```

```ts type-equiv
/** The signed-in user's review of a change request that is not submitted yet, which only that user sees. */
interface ForgePendingReview {
  /** Host identity of the review. */
  readonly id: ForgeReviewId
  /** Comments the review holds. */
  readonly comments: number
}
```

```ts type-equiv
/** Decision a submitted review records. */
type ForgeReviewEvent = 'comment' | 'approve' | 'request-changes'
```

```ts type-equiv
/**
 * One write to the review threads and the pending review of a change request. `pending` replies and `add-pending`
 * comments join the signed-in user's pending review, which is started when the user has none. A host that adds every
 * reply to an existing pending review, as GitHub does, refuses a reply with `pending: false` while one exists.
 */
type ForgeReviewWrite = {
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
```

```ts type-equiv
/** Result of a review write; an `unknown` outcome must be checked on the host before the write is tried again. */
type ForgeReviewWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'unsupported' | 'stale' | 'failed' | 'unknown'; readonly message: string }
```

<a id="overview-and-viewed-marks"></a>

## 概览与已审阅标记

快照还携带变更请求的概览：`reviewers` 及每位评审者最近的结论、合并后托管平台会关闭的 `closingIssues`、能让落后于基线的 head 更新到最新的 `branchUpdates`、当前登录用户能否请求评审或重跑检查，以及每个检查指出的 `rerun`。`ctx.forge.rerunChecks`、`ctx.forge.requestReviews` 与 `ctx.forge.updateBranch` 据此操作，并像上文的操作一样返回 `ForgeActionFailure`，主机的答复无法确认结果时为 `unknown`，提供方答复后立即轮询被监听的变更请求；重跑与更新指明用户看到的 head 提交，head 移动后以 `stale` 拒绝。提供方同时实现 `requestReviews` 与 `reviewerCandidates`，`ctx.forge.reviewerCandidates` 借后者列出可以请求评审的账号；提供方缺少的操作以 `failed` 失败，`reviewerCandidates` 则返回 `unsupported`。GitHub 如何填写各字段并执行这些操作见 [GitHub 提供方 README](../../packages/experimental/forge-github/README.zh.md#use-this-package)。

```ts type-equiv
/** Opaque host identity of a status check that a rerun names. */
type ForgeCheckId = Branded<'ForgeCheckId'>
```

```ts type-equiv
/** How an update brings the base branch's new commits into the head branch: a merge commit, or a rebase of the head's commits. */
type BranchUpdateMethod = 'merge' | 'rebase'
```

```ts type-equiv
/** Outcome of a reviewer's latest submitted review. */
type ReviewVerdict = 'approved' | 'changes-requested' | 'commented' | 'dismissed'
```

```ts type-equiv
/** An account or team asked to review a change request, or an account that reviewed it. */
interface ChangeRequestReviewer {
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
```

```ts type-equiv
/** One issue linked to a change request, which the host closes once the change request merges. */
interface ChangeRequestIssue {
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
```

```ts type-equiv
/** A rerun of the failed checks of the head commit whose checks the user saw. */
interface ForgeRerunRequest {
  /** Head commit whose checks the user saw; the provider refuses with `stale` once the head is another commit. */
  readonly headSha: string
}
```

```ts type-equiv
/** Reviewers to ask in addition to those whose review is requested now; one who already reviewed is asked again. */
interface ForgeReviewersRequest {
  /** The reviewers by kind and login, a team by `organization/slug`. */
  readonly reviewers: readonly Pick<ChangeRequestReviewer, 'kind' | 'login'>[]
}
```

```ts type-equiv
/** An account a review of the change request can be requested from. */
interface ForgeReviewerCandidate {
  /** Login as the host spells it. */
  readonly login: string
  /** Display name, or null when the account shows none. */
  readonly name: string | null
  /** Avatar image URL, or null when the host reports none. */
  readonly avatarUrl: string | null
  /** Whether the host suggests the account for this change request, as from the history of its changed files. */
  readonly suggested: boolean
}
```

```ts type-equiv
/** A branch update the user confirmed for the head commit they saw. */
interface BranchUpdateRequest {
  /** How the base branch's new commits enter the head branch. */
  readonly method: BranchUpdateMethod
  /** Commit object name the head must still have; the update is refused once the head moves. */
  readonly headSha: string
}
```

`ctx.forge.viewedFiles` 与 `ctx.forge.setViewed` 在一个 head 提交上读取和修改当前登录用户对变更请求各文件的已审阅标记。只有同时实现两个方法的提供方保存已审阅标记；否则 `viewedFiles` 返回 undefined，`setViewed` 失败，由使用方自行保存标记。`stale` 答复会像过期的 diff 读取一样立即轮询被监听的变更请求。

```ts type-equiv
/**
 * The signed-in user's review progress on one changed file: `viewed`, `unviewed`, or `dismissed` once the file
 * changed after the user marked it viewed.
 */
type ForgeViewedState = 'viewed' | 'unviewed' | 'dismissed'
```

```ts type-equiv
/** The signed-in user's viewed marks on the files of a change request, read at one head commit. */
interface ForgeViewedFiles {
  /** Head commit the marks were read at. */
  readonly headSha: string
  /** State of each changed file the host listed, by repository-relative path. */
  readonly files: Readonly<Record<string, ForgeViewedState>>
  /** Whether the change request has more files than `files` lists. */
  readonly truncated: boolean
}
```

```ts type-equiv
/** A viewed mark the user set or cleared on a file of the head commit they saw. */
interface ForgeViewedRequest {
  /** Repository-relative path of the changed file. */
  readonly path: string
  /** Whether the file is viewed. */
  readonly viewed: boolean
  /** Head commit whose changes the user saw; the provider refuses with `stale` once the head is another commit. */
  readonly headSha: string
}
```

## Session 绑定

`ctx.forgeSession` 从每个 Session 自己的日志派生其绑定：`gh pr create` 的结果绑定其输出的 URL，`gh pr view`、`gh pr edit` 与 `gh pr checkout` 调用绑定它们所操作的变更请求，`git push` 的结果通过 `ctx.forge` 触发按 head 分支的发现；面板也会报告其检出所跟踪的分支，触发同样的发现。track、dismiss 与发现操作都是 `plugin:forge-session/binding` 插件记录，位于模型可见对话之外。`forgeChangeRequests` 投影的客户端视图随 Session 摘要下发，列出绑定但不含其状态。识别与发现规则见 [Session 绑定 README](../../packages/experimental/forge-session/README.zh.md#use-this-package)。

```ts type-equiv
/**
 * How a change request became bound to a Session: `created` when a
 * `gh pr create` result printed its URL, `referenced` when a `gh pr view`,
 * `gh pr edit`, or `gh pr checkout` call named it or its result printed its
 * own URL, `discovered` when a lookup found it for a branch the Session pushed
 * or works on, `tracked` when a caller bound it by URL.
 */
type BindingOrigin = 'created' | 'referenced' | 'discovered' | 'tracked'
```

```ts type-equiv
/** Payload of the `plugin:forge-session/binding` record. */
interface BindingRecord {
  /**
   * `track` binds or restores, `dismiss` hides, `discover` binds a branch lookup,
   * and `reference` binds a CLI selector lookup without restoring dismissed entries.
   */
  readonly action: 'track' | 'dismiss' | 'discover' | 'reference'
  /** Web URL of the change request. */
  readonly url: string
}
```

```ts type-equiv
/** One change request bound to a Session and not dismissed, with its latest polling result. */
interface SessionChangeRequest {
  /** Web URL as first recorded. */
  readonly url: string
  /** How the change request became bound. */
  readonly origin: BindingOrigin
  /** Parsed reference, or null when no registered provider serves the URL. */
  readonly ref: ChangeRequestRef | null
  /** Latest polling result, or null before the first poll and without a provider. */
  readonly update: ChangeRequestUpdate | null
}
```

```ts type-equiv
/**
 * Receives the complete visible list after a binding or provider change, or a polling result.
 * @param changeRequests - every visible binding of the watched Session, in first-recorded order.
 */
type SessionChangeRequestsListener = (changeRequests: readonly SessionChangeRequest[]) => void
```

## 面板

`ctx.forgePanel` 是 [forge 面板](../../packages/experimental/client-ui-forge/README.zh.md#use-this-package)的宿主 Remote。跟随一个 Session 时，它以流的形式推送 `ForgePanelState`：在 Session 执行环境中对其当前目录进行的只读 Git 检查、从上游远端或 `origin` 识别出的代码托管平台、该平台的登录状态、Session 的绑定及其轮询状态与最近的快照，以及它的 worktree 请求。它的操作可以列出基准分支、绑定和隐藏 URL、刷新、把已绑定的草稿标记为可评审或合并已绑定的变更请求、请求或撤回 worktree、停止正在进行的创建，以及恢复已删除的 worktree 或离开它回到源检出。请求是一条 `plugin:client-ui-forge/worktree` 记录。消息在 Session 的 Agent 空闲时进入其收件箱，面板会在这次投递唤醒 [Agent](../../packages/core/agent/README.zh.md) 之前启动它的维护任务，暂留这条消息的这一轮：对未完成的请求，它通过 `ctx.worktrees` 创建 worktree，尝试失败或被停止后等待下一次尝试或请求被撤回；对在所创建 worktree 中工作的 Session，它检查该 worktree，已被删除时等待它被恢复或离开。面板状态说明消息在等待什么，以及最近一次失败的尝试。对于没有被暂留的消息，由第一个步骤提议创建 worktree。第一轮开始之后的请求会被忽略。对 Session 检出的改动以其 Agent 的维护任务运行，因此其他客户端发来的消息会等它们完成。

```ts type-equiv
/** Git facts for the checkout that contains the Session's current directory. */
interface ForgeCheckout {
  /** Top-level directory of the checkout. */
  readonly root: string
  /** Checked-out branch, or null when HEAD is detached. */
  readonly branch: string | null
  /** Whether the checkout is a linked worktree of another checkout's repository. */
  readonly linked: boolean
  /** Abbreviated commit HEAD names, or null while the checked-out branch has no commit. */
  readonly commit: string | null
}
```

```ts type-equiv
/** Inspection result for the Session's current directory. */
type ForgeCheckoutState =
  /** The first inspection has not finished. */
  | { readonly state: 'pending' }
  /** The current directory is not inside a Git checkout. */
  | { readonly state: 'none' }
  /** Git could not run or reported an error. */
  | { readonly state: 'failed'; readonly message: string }
  /** The checkout facts. */
  | { readonly state: 'ready'; readonly checkout: ForgeCheckout }
```

```ts type-equiv
/** The worktree the panel created and entered for a Session before its first step. */
interface ForgeSessionWorktree {
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
```


```ts type-equiv
/** Payload of the `plugin:client-ui-forge/worktree` record. */
type WorktreeRecord =
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
```

```ts type-equiv
/** One open worktree request. */
interface ForgeWorktreeRequest {
  /** Base branch, or null for HEAD of the source checkout. */
  readonly from: string | null
}
```

```ts type-equiv
/** Why the Session's checkout cannot host a new worktree. */
type ForgeWorktreeBlocker =
  /** The current directory is not inside a Git checkout. */
  | 'not-git'
  /** The Session's sandbox cannot write the checkout or its Git directory, as for a linked worktree outside the writable root. */
  | 'outside-writable-root'
  /** The Session runs read-only. */
  | 'read-only'
```

```ts type-equiv
/** One running worktree creation. */
interface ForgeWorktreeCreation {
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
```

```ts type-equiv
/** One running restoration of the removed worktree a Session works in. */
interface ForgeWorktreeRestoration {
  /** Running step: `prepare` registers the checkout again, creating a missing branch, then `checkout` writes the files. */
  readonly phase: 'prepare' | 'checkout'
}
```

```ts type-equiv
/** The last attempt to create the requested worktree for a message, which failed. */
interface ForgeWorktreeFailure {
  /** Branch the attempt created, or null when it failed before naming one. */
  readonly branch: string | null
  /** Base branch of the attempt, or null for HEAD. */
  readonly from: string | null
  /** Step that failed. */
  readonly phase: 'prepare' | 'checkout'
  /** Failure text. */
  readonly message: string
}
```

```ts type-equiv
/**
 * What a message waits for before its turn starts: the creation of the
 * requested worktree, or the restoration or leaving of the removed worktree
 * the Session works in.
 */
type ForgeWorktreeWaiting = 'creation' | 'restoration'
```

```ts type-equiv
/** The recorded worktree whose directory is missing, invalid, or incompletely restored. */
interface ForgeMissingWorktree {
  /** Whether its branch exists, or null when an incomplete restoration cannot inspect it. */
  readonly branchExists: boolean | null
}
```

```ts type-equiv
/** Worktree facts of one Session in the panel state. */
interface ForgePanelWorktree {
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
```

```ts type-equiv
/** One bound change request in the panel state. */
interface ForgePanelChangeRequest extends SessionChangeRequest {
  /** Latest snapshot a poll returned, kept while later polls fail, or null before the first successful poll. */
  readonly snapshot: ChangeRequestSnapshot | null
  /**
   * Number of review changes `forge/review-changed` announced for the change request since the panel host started; it
   * grows when any plugin's write is accepted, so a reader shows threads and viewed marks read after it.
   */
  readonly reviewRevision: number
}
```

```ts type-equiv
/** Everything the panel shows for one Session. */
interface ForgePanelState {
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
```

```ts type-equiv
/** Local branches offered as the base of a new worktree. */
interface ForgeBranches {
  /** Checked-out branch, or null when HEAD is detached. */
  readonly current: string | null
  /** Local branch names, `current` first and then most recently committed first, at most `maxBranches`. */
  readonly branches: readonly string[]
}
```

会话列表经同一个 Remote 读取。`changeRequestStates` 以流的形式推送 `ForgeChangeRequestStatesFrame`：先是一个 `baseline`，包含调用方可读的已列出 Session 所绑定的每个变更请求最近一次已知的 `ForgeChangeRequestListState`，之后是发生变化的状态。宿主用一次运行服务所有流：已加载 Session 的绑定取自 `ctx.forgeSession`，其他 Session 的绑定取自缓存的 Session 摘要而不加载它们；每个已绑定的变更请求保持订阅，已关闭的按空闲间隔轮询以检测重新打开，每次变化都会存储，因此重启后在下次轮询之前就能显示最近已知的状态。Session 摘要还带有 `forgeWorktree` 投影的客户端视图：Session 的目录就是所创建的 worktree 或位于其下时为该 worktree，否则为 null。

```ts type-equiv
/**
 * The last polled state of one change request that a listed Session binds, as
 * the Session list shows it.
 */
type ForgeChangeRequestListState = Pick<
  ChangeRequestSnapshot, 'url' | 'title' | 'state' | 'draft' | 'checksRollup' | 'reviewDecision' | 'mergeability'
> & {
  /** Change request number on its code host. */
  readonly number: number
}
```

```ts type-equiv
/**
 * One frame of `forgePanel.changeRequestStates`: the known state of every
 * change request the reader may see first, then the states that changed or
 * became visible since the previous frame.
 */
type ForgeChangeRequestStatesFrame =
  | { readonly type: 'baseline'; readonly states: readonly ForgeChangeRequestListState[] }
  | { readonly type: 'changed'; readonly states: readonly ForgeChangeRequestListState[] }
```

变更视图经同一个 Remote 读取。`localDiff` 读取 Session 检出的某个 `ForgeLocalScope`；`changeRequestDiff` 经提供方的 `diff` 读取已绑定变更请求在其最新状态 head 处的变更（提供方只返回描述该 head 提交的补丁），或经提供方的 `compare` 读取它指定的 `ForgeCommitRange`；两者返回的文件都已在宿主上解析为 `ForgeDiffFile` 的 hunk，并带有分层与改动摘要。`localCommits` 与 `changeRequestCommits` 列出范围可以指定的提交，提供方不读取提交时后者返回 null。`localText` 与 `changeRequestText` 读取一个文件的新版本，用来补出 hunk 之间未变更的行。每次检查还会把 `branch` 范围的规模统计为 `ForgePanelState.local`，供面板的变更卡片使用，始终以自动分叉点为准。`base` 指定了引用的 `branch` 范围改为与 HEAD 和该分支的合并基准比较；`diffBases` 列出视图可选的分支以及自动分叉点。head 已越过最新状态时，提供方返回 `stale`，`ctx.forge.diff` 立即重新轮询该变更请求（每个 head 提交一次）；`changeRequestDiff` 以 `forgePanel/stale-head` 拒绝且不缓存任何内容，变更视图保持加载，直到更新的状态到达后按该状态的 head 重新读取。因此评审评论始终指向视图所显示行的那个提交。

`changeRequestReview(session, url, headSha, fresh)` 在视图所显示 diff 的 head 处读取已绑定变更请求的讨论；head 不同时以 `forgePanel/stale-head` 拒绝，提供方不支持读取讨论时返回 `forgePanel/review-unsupported`，其他失败返回 `forgePanel/review-failed`。每个变更请求在内存里保留一次读取结果，以 head 提交和状态的更新时间为键、受 `maxCachedReviewBytes` 约束，保留时间达到 `reviewRefreshMs` 后，或 `fresh` 要求时（读者刷新视图后的第一次读取就是这样）重新读取：在 GitHub 上，新评论和回复会改变 PR 的更新时间，解决讨论则不会。变更视图可见时，每收到一次状态就重新请求一次，并按[面板 README](../../packages/experimental/client-ui-forge/README.zh.md#use-this-package) 所述把讨论叠加到文件上。

`changeRequestViewed(session, url, headSha)` 在视图所示 diff 的 head 上读取已绑定变更请求的已审阅标记，提供方不保存标记时返回 null，head 不同时以 `forgePanel/stale-head` 拒绝，其他失败以 `forgePanel/viewed-failed` 拒绝；`setFileViewed` 在该 head 上保存一个文件的标记。`rerunChecks`、`requestReviews` 与 `updateBranch` 作用于已绑定的变更请求，托管平台未确认的结果以 `forgePanel/action-unknown` 拒绝，`reviewerCandidates` 列出可请求评审的账号，托管平台未列出时以 `forgePanel/reviewers-failed` 拒绝。变更视图随 diff 一起读取整个变更请求的标记，本地变更与所选提交的标记保存在浏览器中；两者以及提供这些操作的卡片行见[面板 README](../../packages/experimental/client-ui-forge/README.zh.md#use-this-package)。

`changeRequestReviewWrite(session, url, write)` 检查已绑定变更请求的一个 `ForgeReviewWrite` 的 head 提交、id、文字和行范围后，交给 `ctx.forge.writeReview`，并返回 `ForgeReviewWriteResult`。提供方给出答复后，无论结果如何，都会丢弃该变更请求保留的讨论，以及在此之前开始的所有读取，使下一次 `changeRequestReview` 从托管平台读取；`submitReview` 同样如此。变更视图一次只发送一个写操作，每个可能改变讨论的写操作之后都会重新读取讨论。

```ts type-equiv
/**
 * Consecutive commits a changes view shows instead of its whole comparison, named by full object names in the order
 * the commit list shows them, oldest first; the view shows the changes from the first commit's first parent to the last.
 */
interface ForgeCommitRange {
  /** First, oldest commit shown. */
  readonly from: string
  /** Last, newest commit shown; equal to `from` for one commit. */
  readonly to: string
}
```

```ts type-equiv
/** Which local changes a diff covers; each reads the Session's checkout through Git. */
type ForgeLocalScope =
  /**
   * The working tree and untracked files against a fork point: the merge base of HEAD with the
   * `base` ref, or while `base` is null, the base commit of the worktree the Session created,
   * else the merge base of HEAD with the default branch of the code host remote. With `commits`, only the changes
   * of those commits between the fork point and HEAD, without uncommitted or untracked files.
   */
  | { readonly kind: 'branch'; readonly base: string | null; readonly commits: ForgeCommitRange | null }
  /** The working tree and untracked files against HEAD. */
  | { readonly kind: 'uncommitted' }
  /** The working tree and untracked files against the index. */
  | { readonly kind: 'unstaged' }
  /** The index against HEAD. */
  | { readonly kind: 'staged' }
```

```ts type-equiv
/** A branch the `branch` scope can compare with. */
interface ForgeBaseBranch {
  /** Full ref name: `refs/heads/<branch>` or `refs/remotes/<remote>/<branch>`. */
  readonly ref: string
  /** The ref without `refs/heads/` or `refs/remotes/`, such as `master` or `origin/master`. */
  readonly name: string
}
```

```ts type-equiv
/** What the `branch` scope compares with while no base branch is chosen. */
interface ForgeAutomaticBase {
  /** The created worktree's base branch or abbreviated base commit, or the default branch of the code host remote. */
  readonly name: string
  /** Whether the fork point is the base commit of the worktree the Session created rather than a merge base. */
  readonly worktree: boolean
}
```

```ts type-equiv
/** Branches the `branch` scope can compare with, whose names contain a query. */
interface ForgeBaseBranches {
  /** The fork point used while no base branch is chosen, whatever the query; null without one. */
  readonly automatic: ForgeAutomaticBase | null
  /** Remote-tracking branches without symbolic refs such as `origin/HEAD`, most recently committed first, at most `maxBranches`. */
  readonly remote: readonly ForgeBaseBranch[]
  /** Local branches other than the checked-out one, most recently committed first, at most `maxBranches`. */
  readonly local: readonly ForgeBaseBranch[]
}
```

```ts type-equiv
/** One hunk of a file diff. */
interface ForgeDiffHunk {
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
```

```ts type-equiv
/** How one file changed. */
type ForgeDiffStatus = 'added' | 'deleted' | 'modified' | 'renamed'
```

```ts type-equiv
/**
 * Review layer of a changed file: the layer the repository's root `.gitattributes` names with `dsh-review-layer`, else
 * `test` for a file it marks `linguist-generated`, else the first of `testPaths`, `interfacePaths`, and the built-in
 * test and interface rules that the path matches, else `implementation`.
 */
type ForgeFileLayer = 'interface' | 'implementation' | 'test'
```

```ts type-equiv
/** One changed file of a diff. */
interface ForgeDiffFile {
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
  /** Review layer the path falls in. */
  readonly layer: ForgeFileLayer
  /**
   * Digest of the file's change: its paths, status, and hunks, plus the blob names of a binary change, or the content
   * of an untracked binary file. Equal digests describe the same change; reading the same comparison again keeps it.
   */
  readonly digest: string
}
```

```ts type-equiv
/** Local changes of the Session's checkout in one scope. */
interface ForgeLocalDiff {
  /** Ref or abbreviated commit the `branch` scope compares with, such as `origin/master`; null for other scopes. */
  readonly base: string | null
  /** Changed files in Git's path order, untracked files last. */
  readonly files: readonly ForgeDiffFile[]
  /** Untracked files left out beyond `maxUntrackedFiles`. */
  readonly omitted: number
}
```

```ts type-equiv
/** Changes of a change request, or of consecutive commits of it, as its code host computes them. */
interface ForgeChangeRequestDiff {
  /** Commit whose new side the diff describes: the head, or the last chosen commit. */
  readonly headSha: string
  /** Changed files in the host's order. */
  readonly files: readonly ForgeDiffFile[]
  /**
   * Commits the checkout's branch has beyond the head when that branch is the change request's head
   * branch and the head commit is present locally; null otherwise and for chosen commits.
   */
  readonly localAhead: number | null
  /** Web page of each changed file at `headSha`, by path. */
  readonly fileUrls: Readonly<Record<string, string>>
}
```

```ts type-equiv
/** Commits of the `branch` scope at one HEAD commit, which the changes view can show one or several of. */
interface ForgeLocalCommits {
  /** HEAD commit the list was read at. */
  readonly headSha: string
  /** Commits oldest first, ending with HEAD's commit. */
  readonly commits: readonly ForgeCommit[]
  /** Whether the branch has more commits than `maxCommits`; the listed ones are the newest. */
  readonly truncated: boolean
}
```

```ts type-equiv
/** One file the `branch` scope changes, without its hunks. */
interface ForgeChangedFile {
  /** Path relative to the repository root after the change. */
  readonly path: string
  /** Lines added, or 0 for a binary file. */
  readonly additions: number
  /** Lines deleted, or 0 for a binary file. */
  readonly deletions: number
  /** Whether the content is binary. */
  readonly binary: boolean
}
```

```ts type-equiv
/** Size of the `branch` scope, which the panel's local changes card shows. */
interface ForgeLocalChanges {
  /** Ref or abbreviated commit the scope compares with. */
  readonly base: string
  /** Changed files in Git's path order, untracked files last, at most `maxUntrackedFiles` of those. */
  readonly files: readonly ForgeChangedFile[]
}
```

<a id="extension-api"></a>

## 扩展 API

其他插件通过上面的服务和另外五个扩展点扩展变更请求评审；每次注册都返回 disposer，并随做出注册的插件一起结束。与这一能力的其余部分一样，这些接口处于实验阶段，尚未稳定。新增可选字段、方法、slot、事件、错误码或带默认值的 Config 键是兼容的；删除或改名类型、方法、slot、owner props、事件、Config 键或 `dsh-resource://forge-changes/` 地址，或收窄其含义，需要写[升级指南](../../.agents/skills/dsh-create-upgrade-guide/SKILL.md)。这些扩展点都不向模型发送任何内容：插件要让模型看到 forge 数据、透镜结果或注解，须经由它自己的工具结果或 `agent.inject()`，Session log 会记录它们。

| 扩展点 | Service Definition | Service Provider | Consumer |
|---|---|---|---|
| 评审数据 | `ctx.forge` 与 `forge/review-changed` 事件 | 各 forge 提供方 | 面板 Host 与其他 Host 插件 |
| 筛选透镜 | `ctx.forgePanel.registerLens` | Host 插件 | 经 `changesLens` 使用它的变更视图 |
| 变更视图接口 | `ctx.forgeChanges` | forge 面板的 Client 插件 | 打开视图、给透镜起名、添加注解的 Client 插件 |
| Slot | `forge.changes.toolbar`、`forge.changes.file.menu`、`forge.diff.line.annotation`、`forge.diff.comment.actions`、`forge.change-request.card.actions` | Client 插件 | 变更视图与变更请求卡片 |
| Session 数据 | `forgeChangeRequests` 与 `forgeWorktree` 投影 | forge-session 与 forge 面板 | Client 插件经 `useProjection` 读取，Host 插件经 `ctx.forgeSession.changeRequests` 或 `ctx.sessionProjections.snapshot` 读取 |

托管平台接受一次评审写入、一次评审提交或一个已审阅标记后，`ctx.forge` 发出 `forge/review-changed`，无论是哪个插件做的；结果未知、被拒绝、已过时或不支持时不发出。面板 Host 随后丢弃为该变更请求保留的讨论，并让对应条目的 `reviewRevision` 加一，因此已打开的变更视图无需刷新就会重新读取讨论和已审阅标记。

```ts type-equiv
/**
 * One review change the host accepted, which `forge/review-changed` announces: a write to the threads or the pending
 * review, a submitted review, or a viewed mark. Each names the head commit the change was made against.
 */
type ForgeReviewChange =
  | { readonly kind: 'write'; readonly write: ForgeReviewWrite['kind']; readonly headSha: string }
  | { readonly kind: 'submit'; readonly headSha: string }
  | { readonly kind: 'viewed'; readonly path: string; readonly viewed: boolean; readonly headSha: string }
```

Host 插件用 `ctx.forgePanel.registerLens(lens)` 注册筛选透镜，Client 插件用 `ctx.forgeChanges.describeLens({ id, title })` 给它起名；没有名字的透镜显示其身份。透镜筛选显示的文件，不给文件分层：变更视图显示所选分层与所选透镜都保留的文件，测试文件开关仍然隐藏测试文件，透镜也不能把文件移到另一层。被保留文件中与 `ranges` 都不相交的 hunk 折叠成一行，读者可以展开。视图只请求所选的透镜，经流式 Remote `changesLens` 进行：它读取与视图相同的文件，文件不同时以 `forgePanel/lens-stale` 拒绝，并在 `lensTimeoutMs` 与 `maxLensReadBytes` 之内运行 `classify`；结果最多保留 `maxCachedLensBytes`。`text` 在分叉点、HEAD、暂存区或第一个所选提交的父提交上读取本地变更的旧侧，在所选提交的父提交上，或在提供方经可选的 `mergeBase` 给出的合并基准上读取变更请求的旧侧。

```ts type-equiv
/** A filter over the files of a changes view, which a plugin registers with `ctx.forgePanel.registerLens()`. */
interface ForgeLens {
  /** Identity the plugin chooses; one registration holds an id at a time. */
  readonly id: ForgeLensId
  /** Changes whenever `classify` may answer differently for the same input, which drops results kept under another version. */
  readonly version: string
  /**
   * Decide which files the lens keeps and which lines it is about. The signal aborts when the reader stops waiting, the
   * registration ends, or `lensTimeoutMs` passes; a rejection fails the request without a partial result.
   */
  classify(input: ForgeLensInput, signal: AbortSignal): Promise<ForgeLensResult>
}
```

```ts type-equiv
/** What one `classify` call receives. */
interface ForgeLensInput {
  /** What the view shows. */
  readonly source: ForgeLensSource
  /** Every file of the diff in display order, with the layer the panel gave it. */
  readonly files: readonly ForgeLensFile[]
  /**
   * Read one side of a file of `files`, by its `path`: the old side reads `previousPath` for a renamed file. Resolves to
   * null when the side does not exist, as the old side of an added file, or holds binary content. Rejects for a path not
   * in `files`, once the reads of one call exceed the panel's `maxLensReadBytes`, for an old side the provider cannot
   * locate, and when the read fails.
   */
  text(side: 'old' | 'new', path: string, signal: AbortSignal): Promise<string | null>
  /** Report how many of `total` units the lens finished; the changes view shows it while the lens runs. */
  progress(done: number, total: number): void
}
```

```ts type-equiv
/** The files a lens keeps, by path; a file the result does not name is filtered out. */
interface ForgeLensResult {
  readonly files: Readonly<Record<string, ForgeLensKeep>>
}
```

```ts type-equiv
/** What a lens keeps of one file. */
interface ForgeLensKeep {
  /**
   * Lines the lens is about on each side; hunks that touch none of them fold into one row the reader can expand.
   * Omitted: every hunk of the file shows.
   */
  readonly ranges?: { readonly old: readonly ForgeLineRange[]; readonly new: readonly ForgeLineRange[] }
}
```

`ctx.forgeChanges` 还可以生成和解析变更视图地址，给出标签的 `kinds`，并用 `open(target, { path, lens })` 在侧栏所显示的 Session 中打开视图。`registerAnnotations(source)` 添加行注解：数据源按路径观察每个视图的注解，它在 `forge.diff.line.annotation` 中按数据源身份登记的条目，负责绘制视图所画外框里的内容。注解放在其最后一行之后，位于评论框、浏览器草稿和托管平台讨论之后，落在所在一侧的那一栏；整个文件的注解排在最前，写在另一个 `digest` 上的注解在文件之后单独成段。每个文件最多显示 `maxAnnotationsPerFile` 条；逐行绘制的文件在文件段进入可视区附近之前不绘制注解。所有 slot 的 owner props 见 [`src/client/slots.ts`](../../packages/experimental/client-ui-forge/src/client/slots.ts)。

```ts type-equiv
/** Where one line annotation sits in a file of a changes view. */
interface ForgeLineAnnotation {
  /** Identity within its source, stable across updates; it keys the drawn entry. */
  readonly key: string
  /** Inclusive 1-based lines on the old (`L`) or new (`R`) side, or `file` for the whole file. */
  readonly place: { readonly side: 'L' | 'R'; readonly startLine: number; readonly endLine: number } | 'file'
  /** Digest of the file change it was written on; a file whose `digest` differs shows it in its outdated section. */
  readonly digest?: string
  /** Changes whenever the entry should draw again; equal keys and versions keep the drawn entry's props. */
  readonly version: string | number
}
```

```ts type-equiv
/** A Client plugin's line annotations, drawn through its `forge.diff.line.annotation` entry. */
interface ForgeAnnotationSource {
  /** Unique source identity, also the key of its `forge.diff.line.annotation` entry. */
  readonly id: string
  /** Position among sources in one stack, lower first; equal positions keep registration order. Default 0. */
  readonly order?: number
  /**
   * Observe the annotations of one view, by path. The changes view calls it once per view and source registration;
   * the source republishes through the same observable whenever the annotations change.
   * @param target - the view's Session and source.
   * @returns annotations by repository-relative path.
   */
  observe(target: ChangesTarget): HostObservable<ReadonlyMap<string, readonly ForgeLineAnnotation[]>>
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxforge--forgeservice"></a>

### `ctx.forge` — `ForgeService`

Registry of forge providers. Watchers of one change request share a single polling loop; each forge has at most one fetch in flight, which batches every due change request of that forge.

```ts cordis-catalog
/**
 * Register the provider of one forge family as an effect on the calling
 * fiber. Watches of that forge receive an `unavailable` failure when the
 * registration ends. Unregistering cancels and awaits its in-flight calls;
 * results from the withdrawn registration are discarded.
 * @param provider - provider to serve `provider.forge`.
 * @returns the disposer that unregisters the provider and waits for its calls to finish.
 * @throws when another provider already serves the same forge.
 */
register(provider: ForgeProvider): () => Promise<void>

/**
 * Map a Git remote URL to a repository through the first provider that serves it.
 * @param url - fetch or push URL as Git reports it.
 * @returns the repository, or undefined when no provider serves the URL.
 */
repositoryFromRemote(url: string): ForgeRepository | undefined

/**
 * Map a change request web URL through the first provider that serves it.
 * @param url - web URL of a pull or merge request.
 * @returns the change request, or undefined when no provider serves the URL.
 */
changeRequestFromUrl(url: string): ChangeRequestRef | undefined

/**
 * Build the canonical web URL of a change request.
 * @param ref - change request served by a registered provider.
 * @returns the provider's canonical URL.
 * @throws when no provider serves the change request's forge.
 */
changeRequestUrl(ref: ChangeRequestRef): string

/**
 * Find open change requests whose head is `branch`, excluding the default branch and forks.
 * @param repository - repository served by a registered provider.
 * @param branch - head branch name on the host.
 * @param signal - cancellation for the lookup.
 * @returns matching change requests, newest first as the provider reports them.
 * @throws when no provider serves the repository's forge or the lookup fails.
 */
async findByHead(repository: ForgeRepository, branch: string, signal: AbortSignal): Promise<readonly ChangeRequestRef[]>

/**
 * Report whether the provider can reach the repository's host with current credentials.
 * @param repository - repository served by a registered provider.
 * @param signal - cancellation for the probe.
 * @returns the provider's readiness for the host.
 * @throws when no provider serves the repository's forge.
 */
async readiness(repository: ForgeRepository, signal: AbortSignal): Promise<ForgeReadiness>

/**
 * Mark a draft change request ready for review, then poll it at once when it is watched.
 * @param ref - change request served by a registered provider.
 * @param signal - cancellation of the request.
 * @returns undefined once the host accepted the change, or why it did not.
 * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
 */
async markReady(ref: ChangeRequestRef, signal: AbortSignal): Promise<ForgeActionFailure | undefined>

/**
 * Merge a change request while its head is still `request.headSha`, then
 * poll it at once when it is watched.
 * @param ref - change request served by a registered provider.
 * @param request - merge method and the head commit the user confirmed.
 * @param signal - cancellation of the request.
 * @returns undefined once the host merged it, or why it did not.
 * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
 */
async merge(ref: ChangeRequestRef, request: MergeRequest, signal: AbortSignal): Promise<ForgeActionFailure | undefined>

/**
 * Rerun the failed checks of a change request's head commit while the head is still `request.headSha`, then poll it
 * at once when it is watched.
 * @param ref - change request served by a registered provider.
 * @param request - the head commit whose checks the user saw.
 * @param signal - cancellation of the request.
 * @returns undefined once the host accepted the rerun, or why it did not; a provider that reruns no checks fails.
 * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
 */
async rerunChecks(ref: ChangeRequestRef, request: ForgeRerunRequest, signal: AbortSignal): Promise<ForgeActionFailure | undefined>

/**
 * Request reviews of a change request from more reviewers, then poll it at once when it is watched.
 * @param ref - change request served by a registered provider.
 * @param request - the reviewers to ask.
 * @param signal - cancellation of the request.
 * @returns undefined once the host accepted the request, or why it did not; a provider that requests no reviews fails.
 * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
 */
async requestReviews( ref: ChangeRequestRef, request: ForgeReviewersRequest, signal: AbortSignal, ): Promise<ForgeActionFailure | undefined>

/**
 * List accounts a review of a change request can be requested from.
 * @param ref - change request served by a registered provider.
 * @param query - text the login or name contains; empty for the host's suggestions and first accounts.
 * @param signal - cancellation of the read.
 * @returns the accounts, the host's suggestions first, or why the host did not list them; a provider that requests no
 * reviews returns `unsupported`.
 * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
 */
async reviewerCandidates( ref: ChangeRequestRef, query: string, signal: AbortSignal, ): Promise<readonly ForgeReviewerCandidate[] | ForgeFailure>

/**
 * Bring the base branch's new commits into a change request's head branch while its head is still
 * `request.headSha`, then poll it at once when it is watched.
 * @param ref - change request served by a registered provider.
 * @param request - update method and the head commit the user confirmed.
 * @param signal - cancellation of the request.
 * @returns undefined once the host accepted the update, or why it did not; a provider that updates no branches fails.
 * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
 */
async updateBranch(ref: ChangeRequestRef, request: BranchUpdateRequest, signal: AbortSignal): Promise<ForgeActionFailure | undefined>

/**
 * Read complete check details independently of periodic polling.
 * @param ref - change request served by a registered provider.
 * @param signal - cancellation of the detail view.
 * @returns a complete snapshot or the provider's failure; unsupported providers return unavailable.
 * @throws on cancellation, provider disposal, or expiry of this read's own `fetchTimeoutMs` deadline.
 */
async fetchChecks(ref: ChangeRequestRef, signal: AbortSignal): Promise<ChangeRequestSnapshot | ForgeFailure>

/**
 * Read the changes of a change request at one head commit as its host
 * computes them. The first `stale` failure at a head commit polls a watched
 * change request again at once, so its next status names the current head;
 * later stale reads at the same commit wait for the regular poll, which
 * bounds the reads while the host's answers disagree. When the latest status of a watched change request names
 * `headSha`, its `baseSha` goes to the provider, which may then read the patch while it confirms the head.
 * @param ref - change request served by a registered provider.
 * @param headSha - head commit the patch must describe, usually the head of the latest status.
 * @param signal - cancellation of the read.
 * @returns one unified patch with `a/` and `b/` path prefixes, or why the host did not provide it at `headSha`.
 * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
 */
async diff(ref: ChangeRequestRef, headSha: string, signal: AbortSignal): Promise<string | ForgeFailure>

/**
 * Read the review threads of a change request at one head commit. A
 * `stale` failure polls a watched change request again as {@link ForgeService.diff} does.
 * @param ref - change request served by a registered provider.
 * @param headSha - head commit the threads must be read at, usually the head of the displayed diff.
 * @param signal - cancellation of the read.
 * @returns the threads read at `headSha`, or why the host did not provide them; `unsupported` when the provider cannot read reviews.
 * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
 */
async readReview(ref: ChangeRequestRef, headSha: string, signal: AbortSignal): Promise<ForgeReviewData | ForgeFailure>

/**
 * Write to the review threads or the pending review of a change request while its head is still `write.headSha`, then
 * poll the change request at once when it is watched, unless the provider cannot write reviews. A `stale` result polls
 * it as a stale read does; a write the host took is announced with `forge/review-changed`.
 * @param ref - change request served by a registered provider.
 * @param write - the write and the head commit the user saw.
 * @param signal - cancellation of the write.
 * @returns whether the host took the write; `unsupported` when the provider cannot write reviews, and `unknown` when the
 * outcome must be checked on the host before the write is tried again.
 * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
 */
async writeReview(ref: ChangeRequestRef, write: ForgeReviewWrite, signal: AbortSignal): Promise<ForgeReviewWriteResult>

/**
 * Read the signed-in user's viewed marks on the files of a change request at one head commit. A `stale` failure
 * polls a watched change request again as {@link ForgeService.diff} does.
 * @param ref - change request served by a registered provider.
 * @param headSha - head commit the marks must be read at, usually the head of the displayed diff.
 * @param signal - cancellation of the read.
 * @returns the marks read at `headSha`, why the host did not provide them, or undefined when the provider keeps no
 * viewed marks.
 * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
 */
async viewedFiles(ref: ChangeRequestRef, headSha: string, signal: AbortSignal): Promise<ForgeViewedFiles | ForgeFailure | undefined>

/**
 * Set or clear the signed-in user's viewed mark on one file of a change request while its head is still
 * `request.headSha`. A `stale` failure polls a watched change request again as {@link ForgeService.diff} does; a saved
 * mark is announced with `forge/review-changed`.
 * @param ref - change request served by a registered provider.
 * @param request - the file, its mark, and the head commit the user saw.
 * @param signal - cancellation of the request.
 * @returns undefined once the host saved the mark, or why it did not; a provider that keeps no viewed marks fails.
 * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
 */
async setViewed(ref: ChangeRequestRef, request: ForgeViewedRequest, signal: AbortSignal): Promise<ForgeActionFailure | undefined>

/**
 * List the commits of a change request at its current head.
 * @param ref - change request served by a registered provider.
 * @param signal - cancellation of the read.
 * @returns the commits, why the host did not provide them, or undefined when the provider does not read commits.
 * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
 */
async commits(ref: ChangeRequestRef, signal: AbortSignal): Promise<ForgeCommitList | ForgeFailure | undefined>

/**
 * Read the changes between two commits of a change request's repository.
 * @param ref - change request served by a registered provider.
 * @param base - full object name of the commit compared from.
 * @param head - full object name of a commit that descends from `base`.
 * @param signal - cancellation of the read.
 * @returns one unified patch with `a/` and `b/` path prefixes, or why the host did not provide it; a provider that
 * does not read commits returns `unavailable`.
 * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
 */
async compare(ref: ChangeRequestRef, base: string, head: string, signal: AbortSignal): Promise<string | ForgeFailure>

/**
 * Find the merge base of two commits of a change request's repository: the commit whose files the old side of the
 * change request's diff shows when `base` is the snapshot's `baseSha` and `head` its `headSha`.
 * @param ref - change request served by a registered provider.
 * @param base - full object name of the base commit.
 * @param head - full object name of the head commit.
 * @param signal - cancellation of the read.
 * @returns the merge base's full object name, or why the host did not provide it; `unsupported` when the provider
 * cannot name merge bases.
 * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
 */
async mergeBase(ref: ChangeRequestRef, base: string, head: string, signal: AbortSignal): Promise<string | ForgeFailure>

/**
 * Publish one comment or a completed review, then refresh the watched status; a publication the host took is announced
 * with `forge/review-changed`.
 * @param ref - change request served by a registered provider.
 * @param request - explicitly selected commit, comments, and review decision.
 * @param signal - request cancellation.
 * @returns a publication URL or a failure, including an unknown write outcome.
 */
async submitReview(ref: ChangeRequestRef, request: ForgeReviewRequest, signal: AbortSignal): Promise<ForgeReviewResult>

/**
 * Read the text of one file at a commit of a change request's repository.
 * @param ref - change request served by a registered provider.
 * @param commit - commit object name.
 * @param path - path relative to the repository root.
 * @param signal - cancellation of the read.
 * @returns the text, or why the host did not provide it.
 * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
 */
async fileText(ref: ChangeRequestRef, commit: string, path: string, signal: AbortSignal): Promise<string | ForgeFailure>

/**
 * Build the web page of one file at a commit of a change request's repository.
 * @param ref - change request served by a registered provider.
 * @param commit - commit object name.
 * @param path - path relative to the repository root.
 * @returns the provider's URL.
 * @throws when no provider serves the change request's forge.
 */
fileUrl(ref: ChangeRequestRef, commit: string, path: string): string

/**
 * Watch one change request as an effect on the calling fiber. The first
 * watcher starts polling at once; listeners receive every later result,
 * and `latest` returns the current one. Polling stops when the last watcher
 * leaves. Listeners must not throw; a thrown error is logged and skipped.
 * @param ref - change request to poll.
 * @param listener - receives each polling result.
 * @returns the disposer that stops this watch.
 */
watch(ref: ChangeRequestRef, listener: ChangeRequestListener): () => void

/**
 * Poll a watched change request at once, including after a terminal state.
 * A fetch already in flight is followed immediately by another fetch; an
 * unwatched change request is unchanged.
 * @param ref - change request to poll.
 */
refresh(ref: ChangeRequestRef): void

/**
 * Read the latest polling result of a watched change request.
 * @param ref - change request to read.
 * @returns the latest result, or undefined before the first result or without a watch.
 */
latest(ref: ChangeRequestRef): ChangeRequestUpdate | undefined
```

Source: [`packages/experimental/forge/src/index.ts`](../../packages/experimental/forge/src/index.ts)

<a id="ctxforgepanel--forgepanelcontroller"></a>

### `ctx.forgePanel` — `ForgePanelController`

Serves the forge panel. Following a Session inspects the checkout of its current directory using the Session's permissions and execution world, recognizes the code host of the upstream remote or `origin`, probes sign-in for that host, and polls the Session's bound change requests through `ctx.forge` until the last follower of that Session leaves. A worktree request makes the panel create a branch and checkout through an optional `ctx.worktrees` and enter it while the Session's first message waits in the inbox, or at the first step proposal of a message no wait took. After a failed or stopped attempt the message keeps waiting for another attempt or for the request to be withdrawn. A message also waits while the worktree the Session works in is gone, until that worktree is checked out again or left for the source checkout. Changes to a Session's checkout run as Agent maintenance, so a message that arrives meanwhile waits for them.

```ts cordis-catalog
/**
 * Stream the panel state of a Session: the current state first, then each
 * later state. Intermediate states may be skipped when the reader is slower
 * than the updates. The stream ends when `signal` aborts or the Remote stops.
 * @param session - Session to follow.
 * @param signal - ends the stream.
 * @returns panel states in publication order.
 */
@Remote({ mode: 'stream' }) async *follow(session: Session, signal: AbortSignal): AsyncIterable<ForgePanelState>

/**
 * Stream the last known state of every change request that a listed
 * Session the caller may read binds: the stored states first, then each
 * state a poll changes or a new binding reveals. Listing reads no Session
 * log: loaded Sessions report their bindings, others the cached Session
 * summary, and a Session without one shows nothing until it is opened.
 * Closed requests are polled at the idle cadence so reopening is observed. The
 * stream ends when `signal` aborts or the Remote stops.
 * @param signal - ends the stream.
 * @returns frames in publication order.
 * @throws when the Host lacks the Session query, projection cache, storage, or Session store service.
 */
@Remote({ mode: 'stream' }) async *changeRequestStates(signal: AbortSignal): AsyncIterable<ForgeChangeRequestStatesFrame>

/**
 * Read or await the worktree service's archive cleanup of the Session's checkout.
 * @param session - Session whose cleanup is visible to the caller.
 * @param revision - null reads now; a matching revision waits for completion.
 * @returns the cleanup state, or null without a worktree service, an attempt, or a current revision.
 */
@Remote async worktreeCleanup(session: Session, revision: number | null): Promise<WorktreeCleanup | null>

/**
 * List the local branches that can start a worktree of the Session's current checkout.
 * @param session - Session whose current directory is listed.
 * @param signal - request cancellation.
 * @returns the checked-out branch and at most `maxBranches` local branches, the checked-out one first.
 * @throws when the current directory is not inside a checkout or Git fails.
 */
@Remote async branches(session: Session, signal: AbortSignal): Promise<ForgeBranches>

/**
 * List the branches the `branch` scope of the Session's current checkout can compare with.
 * @param session - Session whose checkout is read.
 * @param query - text the branch names must contain, ignoring case; empty for every branch.
 * @param signal - request cancellation.
 * @returns the automatic fork point and at most `maxBranches` remote-tracking and local branches each,
 * most recently committed first, without the checked-out branch.
 * @throws `forgePanel/not-a-checkout` outside a checkout; the Git error when Git fails or the listed refs exceed `maxDiffBytes`.
 */
@Remote async diffBases(session: Session, query: string, signal: AbortSignal): Promise<ForgeBaseBranches>

/**
 * Bind a change request to a Session by URL, or restore a dismissed binding.
 * @param session - Session that receives the binding.
 * @param url - web URL of the change request.
 * @param signal - request cancellation.
 * @throws `forgePanel/unrecognized-url` when no registered provider serves the URL.
 */
@Remote async track(session: Session, url: string, signal: AbortSignal): Promise<void>

/**
 * Hide a visible binding of a Session; other URLs leave the Session unchanged.
 * @param session - Session that owns the binding.
 * @param url - web URL of the change request.
 * @param signal - request cancellation.
 */
@Remote async dismiss(session: Session, url: string, signal: AbortSignal): Promise<void>

/**
 * Reinspect a followed Session's checkout, probe sign-in again, and poll its
 * change requests at once; an unfollowed Session is unchanged.
 * @param session - Session whose panel refreshes.
 * @param signal - request cancellation.
 * @returns settles once the inspection and the sign-in probe have ended; poll results reach the panel stream later.
 */
@Remote async refresh(session: Session, signal: AbortSignal): Promise<void>

/**
 * Read the changes one scope covers in the checkout of the Session's
 * current directory, with Git using the Session's sandbox policy.
 * @param session - Session whose checkout is read.
 * @param scope - which changes to read.
 * @param signal - request cancellation.
 * @returns the files, the base of the `branch` scope, and the untracked files left out.
 * @throws `forgePanel/not-a-checkout` outside a checkout; `forgePanel/base-missing` when the base branch
 * chosen for the `branch` scope does not exist; `forgePanel/no-fork-point` for the `branch` scope without
 * a fork point; `forgePanel/commits-missing` when chosen commits are not between the fork point and HEAD in order;
 * `forgePanel/commits-not-linear` when a chosen commit's first parent is not the commit listed before it;
 * `forgePanel/filter-config-failed` when filter configuration cannot be read completely, before
 * any comparison; `forgePanel/diff-too-large` over `maxDiffBytes`; the Git error when Git fails.
 */
@Remote async localDiff(session: Session, scope: ForgeLocalScope, signal: AbortSignal): Promise<ForgeLocalDiff>

/**
 * List the commits of the `branch` scope of the Session's current checkout, which the changes view can show one or
 * several of instead of the whole scope.
 * @param session - Session whose checkout is read.
 * @param base - the base ref of the `branch` scope, or null for its automatic fork point.
 * @param signal - request cancellation.
 * @returns the newest `maxCommits` commits between the fork point and HEAD, oldest first, and HEAD's commit.
 * @throws `forgePanel/not-a-checkout` outside a checkout; `forgePanel/base-missing` when the base branch does not
 * exist; `forgePanel/no-fork-point` without a fork point; the Git error when Git fails or the listing exceeds `maxDiffBytes`.
 */
@Remote async localCommits(session: Session, base: string | null, signal: AbortSignal): Promise<ForgeLocalCommits>

/**
 * Read the new side of one changed file in a scope, which supplies the
 * unchanged lines between its hunks: the index for `staged`, the last chosen commit for chosen commits of
 * the `branch` scope, else the working tree.
 * @param session - Session whose checkout is read.
 * @param scope - the scope the diff was read in.
 * @param path - path relative to the checkout's top-level directory, as the diff names it.
 * @param signal - request cancellation.
 * @returns the text.
 * @throws `forgePanel/not-a-checkout` outside a checkout; `forgePanel/diff-too-large` over `maxDiffBytes`;
 * `forgePanel/commits-missing` for a chosen commit that is not a full object name; an error for a path outside
 * the checkout, binary content, or a failed read.
 */
@Remote async localText(session: Session, scope: ForgeLocalScope, path: string, signal: AbortSignal): Promise<string>

/**
 * Load complete checks for the change request whose list the user opened.
 * @param session - Session retaining the visible binding.
 * @param url - binding URL.
 * @param headSha - commit displayed by the card; a different head rejects the result.
 * @param signal - cancellation when the list closes.
 * @returns the complete snapshot at the displayed head.
 * @throws `forgePanel/not-bound` for an invisible binding, `forgePanel/stale-head` for a moved head,
 * or `forgePanel/checks-failed` when the provider cannot complete the read.
 */
@Remote async changeRequestChecks(session: Session, url: string, headSha: string, signal: AbortSignal): Promise<ChangeRequestSnapshot>

/**
 * List the commits of a change request of a Session at its current head, which the changes view can show one or
 * several of instead of the whole change request.
 * @param session - Session the change request is bound to.
 * @param url - binding URL of the change request.
 * @param signal - request cancellation.
 * @returns the commits oldest first with the head they were read at, or null when the provider does not read commits.
 * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
 * `forgePanel/diff-failed` when the host does not list them.
 */
@Remote async changeRequestCommits(session: Session, url: string, signal: AbortSignal): Promise<ForgeCommitList | null>

/**
 * Read the changes of a change request of a Session as its code host
 * computes them, with each file's layer following the root `.gitattributes`
 * of the commit the diff ends at. Without `commits` the diff covers the change
 * request at the head commit of its latest status; a patch already read at the
 * same head commit and base branch is reused from memory with its attributes, for
 * any Session, until `maxCachedDiffBytes` evicts it. With `commits`, it covers those
 * commits, from the first one's first parent to the last, and is read every time.
 * @param session - Session the change request is bound to.
 * @param url - binding URL of the change request.
 * @param commits - consecutive commits of the change request, or null for all of it.
 * @param signal - request cancellation.
 * @returns the files, the commit they end at, each file's web page, and the commits the checkout has beyond the head.
 * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
 * `forgePanel/commits-missing` when chosen commits are not among the change request's commits in order;
 * `forgePanel/commits-not-linear` when a chosen commit's first parent is not the commit listed before it;
 * `forgePanel/stale-head` without `commits` when the head moved past the latest status, which is then polled again;
 * `forgePanel/diff-too-large` when the host or its provider refuses the diff over a size limit;
 * `forgePanel/diff-failed` before its status was read, for a first chosen commit without a parent, and when the host
 * does not provide the commits, the diff, or an existing `.gitattributes` otherwise.
 */
@Remote async changeRequestDiff( session: Session, url: string, commits: ForgeCommitRange | null, signal: AbortSignal, ): Promise<ForgeChangeRequestDiff>

/**
 * Read one file of a change request's repository at a commit, which
 * supplies the unchanged lines between the hunks of its diff.
 * @param session - Session the change request is bound to.
 * @param url - binding URL of the change request.
 * @param commit - commit object name, the head commit of the diff.
 * @param path - path relative to the repository root.
 * @param signal - request cancellation.
 * @returns the text.
 * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
 * `forgePanel/diff-too-large` when the host or its provider refuses the file over a size limit;
 * `forgePanel/diff-failed` when the host does not provide the file otherwise.
 */
@Remote async changeRequestText(session: Session, url: string, commit: string, path: string, signal: AbortSignal): Promise<string>

/**
 * Register a filter lens as an effect on the calling fiber. The changes views list it while it is registered; ending
 * the registration aborts its running classifications and waits for them.
 * @param lens - the lens.
 * @returns the disposer that unregisters the lens and waits for its classifications to stop.
 * @throws when another registration holds `lens.id`.
 */
registerLens(lens: ForgeLens): () => Promise<void>

/**
 * Stream the facts every changes view reads about the panel's extensions: the current facts first, then the facts
 * after each lens registration or withdrawal. The stream ends when `signal` aborts or the Remote stops.
 * @param signal - ends the stream.
 * @returns the registered lenses and the annotation limit, in publication order.
 */
@Remote({ mode: 'stream' }) async *extensions(signal: AbortSignal): AsyncIterable<ForgeExtensionState>

/**
 * Classify the files a changes view of a Session shows with one registered lens: progress frames while the lens
 * runs, then the files it keeps. Results for the same files, lens, and lens version are reused from memory until
 * `maxCachedLensBytes` evicts them. Local changes are read with the Session's permissions; a change request's files
 * are those `changeRequestDiff` reads.
 * @param session - Session whose checkout or binding the view shows.
 * @param request - the view's source, the version of the files it shows, and the lens.
 * @param signal - ends the classification.
 * @returns progress frames, then one result frame.
 * @throws `forgePanel/lens-missing` while no lens holds the identity or once its registration ends;
 * `forgePanel/lens-stale` before a change request's status was read, when the files differ from `request.version`, and
 * when local files changed while the lens ran;
 * `forgePanel/lens-failed` when the lens fails, runs past `lensTimeoutMs`, reads past `maxLensReadBytes`, or answers
 * over `maxCachedLensBytes`; the errors of `localDiff` and `changeRequestDiff` for the files.
 */
@Remote({ mode: 'stream' }) async *changesLens(session: Session, request: ForgeLensRequest, signal: AbortSignal): AsyncIterable<ForgeLensFrame>

/**
 * Read the signed-in user's viewed marks on the files of a change request of a Session, which the host keeps for the
 * whole change request.
 * @param session - Session the change request is bound to.
 * @param url - binding URL of the change request.
 * @param headSha - head commit of the shown diff; marks read at another head are refused.
 * @param signal - request cancellation.
 * @returns the marks at `headSha`, or null when the provider keeps no viewed marks.
 * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
 * `forgePanel/stale-head` when the head moved past `headSha`, which is then polled again; `forgePanel/viewed-failed`
 * when the host does not provide the marks otherwise.
 */
@Remote async changeRequestViewed(session: Session, url: string, headSha: string, signal: AbortSignal): Promise<ForgeViewedFiles | null>

/**
 * Set or clear the signed-in user's viewed mark on one file of a change request of a Session.
 * @param session - Session the change request is bound to.
 * @param url - binding URL of the change request.
 * @param request - the file, its mark, and the head commit of the shown diff.
 * @param signal - request cancellation.
 * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
 * `forgePanel/stale-head` when the head moved past `request.headSha`; `forgePanel/action-failed` with the host's
 * reason when the host refuses, cannot be reached, or keeps no viewed marks; `forgePanel/action-unknown` when the host
 * did not confirm whether it saved the mark.
 */
@Remote async setFileViewed(session: Session, url: string, request: ForgeViewedRequest, signal: AbortSignal): Promise<void>

/**
 * Read the review threads of a change request of a Session at the head commit of its displayed diff. Threads read
 * at the same head commit and update time are reused from memory, for any Session, until they are
 * `reviewRefreshMs` old, `maxCachedReviewBytes` evicts them, or a review write through this panel drops them; a read
 * again after that age, or a `fresh` read, shows threads resolved elsewhere since, which do not change a GitHub pull
 * request's update time.
 * @param session - Session the change request is bound to.
 * @param url - binding URL of the change request.
 * @param headSha - head commit of the displayed diff.
 * @param fresh - whether to read from the host even when threads at this head and update time are kept, as after the
 * reader refreshes the view; the result replaces the kept threads.
 * @param signal - request cancellation.
 * @returns the threads at `headSha`, with `current` positions numbering the files of that diff.
 * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
 * `forgePanel/stale-head` when the latest status or the host names another head, which a host answer polls again;
 * `forgePanel/review-unsupported` when the provider cannot read reviews; `forgePanel/review-failed` before the
 * status was read and when the host does not provide the threads otherwise.
 */
@Remote async changeRequestReview(session: Session, url: string, headSha: string, fresh: boolean, signal: AbortSignal): Promise<ForgeReviewData>

/**
 * Publish a line comment or completed review for a visible Session binding. The threads kept for the change request
 * are dropped once the host answers, so the next read shows the comments.
 * @param session - Session retaining the change request.
 * @param url - visible binding URL.
 * @param request - reviewed head, ranges, plain text, and explicit review decision.
 * @param signal - request cancellation.
 * @returns confirmed publication or a typed failure; unknown outcomes require reconciliation on the host.
 */
@Remote async submitReview(session: Session, url: string, request: ForgeReviewRequest, signal: AbortSignal): Promise<ForgeReviewResult>

/**
 * Write to the review threads or the pending review of a change request of a Session while its head is still the
 * head the user saw. The threads kept for the change request are dropped once the host answers, so the next read
 * shows the write, which a resolve does not show through a GitHub pull request's update time.
 * @param session - Session the change request is bound to.
 * @param url - binding URL of the change request.
 * @param write - the write and the head commit of the threads the user saw.
 * @param signal - request cancellation.
 * @returns whether the host took the write; `stale` once the head moved, which polls the change request again, and
 * `unknown` when the outcome must be checked on the host before the write is tried again.
 * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves; an error
 * for a write without text, a head that is not a commit object name, or an invalid line range.
 */
@Remote async changeRequestReviewWrite( session: Session, url: string, write: ForgeReviewWrite, signal: AbortSignal, ): Promise<ForgeReviewWriteResult>

/**
 * Mark a draft change request of a Session ready for review; the change
 * request is polled again once the host answers.
 * @param session - Session the change request is bound to.
 * @param url - binding URL of the change request.
 * @param signal - request cancellation.
 * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
 * `forgePanel/action-failed` with the host's reason when the host refuses or cannot be reached.
 */
@Remote async markReady(session: Session, url: string, signal: AbortSignal): Promise<void>

/**
 * Merge a change request of a Session while its head is still `headSha`;
 * the change request is polled again once the host answers.
 * @param session - Session the change request is bound to.
 * @param url - binding URL of the change request.
 * @param method - how the commits enter the base branch.
 * @param headSha - head commit the user confirmed.
 * @param signal - request cancellation.
 * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
 * `forgePanel/stale-head` when the head moved past `headSha`; `forgePanel/action-failed` with the host's
 * reason when the host refuses otherwise or cannot be reached.
 */
@Remote async merge(session: Session, url: string, method: MergeMethod, headSha: string, signal: AbortSignal): Promise<void>

/**
 * Rerun the failed checks of a change request of a Session while its head is still the commit whose checks the user
 * saw; the change request is polled again once the host answers.
 * @param session - Session the change request is bound to.
 * @param url - binding URL of the change request.
 * @param request - the head commit whose checks the user saw.
 * @param signal - request cancellation.
 * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
 * `forgePanel/stale-head` when the head moved past `request.headSha`; `forgePanel/action-failed` with the host's
 * reason when the host refuses, cannot be reached, or reruns no checks; `forgePanel/action-unknown` when the host did
 * not confirm whether it started the rerun.
 */
@Remote async rerunChecks(session: Session, url: string, request: ForgeRerunRequest, signal: AbortSignal): Promise<void>

/**
 * Request reviews of a change request of a Session from more reviewers; the change request is polled again once the
 * host answers.
 * @param session - Session the change request is bound to.
 * @param url - binding URL of the change request.
 * @param reviewers - the reviewers to ask, by kind and login.
 * @param signal - request cancellation.
 * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
 * `forgePanel/action-failed` with the host's reason when the host refuses, cannot be reached, or requests no reviews;
 * `forgePanel/action-unknown` when the host did not confirm whether it requested the reviews.
 */
@Remote async requestReviews( session: Session, url: string, reviewers: readonly Pick<ChangeRequestReviewer, 'kind' | 'login'>[], signal: AbortSignal, ): Promise<void>

/**
 * List accounts a review of a change request of a Session can be requested from.
 * @param session - Session the change request is bound to.
 * @param url - binding URL of the change request.
 * @param query - text the login or name contains; empty for the host's suggestions and first accounts.
 * @param signal - request cancellation.
 * @returns the accounts, the host's suggestions first.
 * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
 * `forgePanel/reviewers-failed` when the host does not list them.
 */
@Remote async reviewerCandidates(session: Session, url: string, query: string, signal: AbortSignal): Promise<readonly ForgeReviewerCandidate[]>

/**
 * Bring the base branch's new commits into the head branch of a change request of a Session while its head is still
 * `headSha`; the change request is polled again once the host answers.
 * @param session - Session the change request is bound to.
 * @param url - binding URL of the change request.
 * @param method - merge commit or rebase.
 * @param headSha - head commit the user confirmed.
 * @param signal - request cancellation.
 * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
 * `forgePanel/stale-head` when the head moved past `headSha`; `forgePanel/action-failed` with the host's reason when
 * the host refuses, cannot be reached, or updates no branches; `forgePanel/action-unknown` when the host did not
 * confirm whether it started the update.
 */
@Remote async updateBranch(session: Session, url: string, method: BranchUpdateMethod, headSha: string, signal: AbortSignal): Promise<void>

/**
 * Ask for a new worktree before the Session's first turn, replacing an open
 * request and forgetting a failed attempt. While the next message waits in
 * the inbox, or else at the first step proposal, the panel creates a branch
 * from `from`, or from HEAD of the current checkout when it is null, and
 * enters its checkout. A message that already waits after a failed or
 * stopped attempt keeps waiting for {@link ForgePanelController.retryWorktree}.
 * @param session - Session without a started turn.
 * @param from - local base branch, or null for HEAD.
 * @param signal - request cancellation.
 * @throws `forgePanel/invalid-branch` when `from` is empty; `forgePanel/worktrees-unavailable`
 * without a worktree service; `forgePanel/session-started` after a turn started or the worktree was
 * created; `forgePanel/session-busy` while the worktree is being created.
 */
@Remote async requestWorktree(session: Session, from: string | null, signal: AbortSignal): Promise<void>

/**
 * Withdraw the open worktree request of a Session with its failed attempt,
 * which lets a waiting message go on in the current checkout; without a
 * request the Session is unchanged. Withdrawing needs no worktree service.
 * @param session - Session without a started turn.
 * @param signal - request cancellation.
 * @throws `forgePanel/session-started` after a turn started or the worktree was created;
 * `forgePanel/session-busy` while the worktree is being created.
 */
@Remote async cancelWorktree(session: Session, signal: AbortSignal): Promise<void>

/**
 * Stop the creation a message of the Session waits for; the message keeps
 * waiting with the request still open. Without such a creation the Session
 * is unchanged.
 * @param session - Session whose creation stops.
 * @param signal - request cancellation.
 */
@Remote async stopCreation(session: Session, signal: AbortSignal): Promise<void>

/**
 * Make another attempt, with a new branch name, at the worktree a message
 * of the Session waits for after a failed or stopped attempt.
 * @param session - Session whose message waits.
 * @param signal - request cancellation.
 * @throws `forgePanel/not-waiting` when no message waits or an attempt is running.
 */
@Remote async retryWorktree(session: Session, signal: AbortSignal): Promise<void>

/**
 * Check out the created worktree of a Session again at its recorded
 * directory when that directory is gone: its branch when the branch still
 * exists, otherwise a new branch of the same name at the base commit. Changes
 * that were never committed are not recovered. Runs as Agent maintenance,
 * inside the wait of a message that waits for the restoration, which then
 * goes on; without a missing directory the Session is unchanged.
 * @param session - Session whose worktree directory is gone.
 * @param signal - request cancellation, which aborts the restoration.
 * @throws `forgePanel/no-worktree` without a created worktree; `forgePanel/worktrees-unavailable`
 * without a worktree service; `forgePanel/session-busy` while the Session's Agent is not loaded or
 * has other work; `forgePanel/restore-failed` when Git fails.
 */
@Remote async restoreWorktree(session: Session, signal: AbortSignal): Promise<void>

/**
 * Move a Session from its created worktree to the source checkout the
 * worktree came from; the Session no longer works in the worktree. Runs as
 * Agent maintenance, inside the wait of a message that waits for the removed
 * worktree, which then goes on.
 * @param session - Session with a created worktree.
 * @param signal - request cancellation.
 * @throws `forgePanel/no-worktree` without a created worktree; `forgePanel/session-busy` while the
 * Session's Agent is not loaded or has other work; the working-directory service's error when the
 * source checkout no longer exists.
 */
@Remote async continueInProject(session: Session, signal: AbortSignal): Promise<void>
```

Types: [Session](session.zh.md) · [WorktreeCleanup](worktrees.zh.md)

Source: [`packages/experimental/client-ui-forge/src/index.ts`](../../packages/experimental/client-ui-forge/src/index.ts)

<a id="ctxforgesession--forgesessionservice"></a>

### `ctx.forgeSession` — `ForgeSessionService`

Session-scoped change request bindings. The `forgeChangeRequests` projection derives them from `gh pr create`, `gh pr view`, `gh pr edit`, `gh pr checkout`, and `git push` results, including those of shell calls inside PTC programs, and from `plugin:forge-session/binding` records. After each push result, and when a caller reports the branch a Session works on, the service looks up open change requests whose head is that branch and records the unbound ones as discovered. Watching a Session polls its visible change requests through `ctx.forge`.

```ts cordis-catalog
/**
 * List the change requests bound to a Session and not dismissed.
 * @param session - Session whose bindings are read.
 * @returns visible bindings in first-recorded order, each with its latest polling result.
 */
changeRequests(session: Session): SessionChangeRequest[]

/**
 * Bind a change request to a Session by URL, or restore a dismissed binding.
 * Appends a `track` record with the provider's canonical URL unless the
 * change request is already visible.
 * @param session - Session that receives the binding.
 * @param url - web URL of the change request.
 * @throws when no registered provider recognizes the URL.
 */
track(session: Session, url: string): void

/**
 * Look up open change requests whose head is a branch the Session works on,
 * and record the unbound ones as discovered, as after a push of that branch.
 * A remote that no provider recognizes changes nothing; a failed lookup is
 * logged and changes nothing.
 * @param session - Session that receives the bindings.
 * @param remote - URL of the remote that holds the branch.
 * @param branch - branch name on that remote.
 * @returns resolves once the lookup has recorded its bindings or failed.
 */
discoverBranch(session: Session, remote: string, branch: string): Promise<void>

/**
 * Hide a visible binding. Appends a `dismiss` record; a URL that is not
 * visibly bound leaves the log unchanged. Discovery never restores a
 * dismissed binding; `track` does.
 * @param session - Session that owns the binding.
 * @param url - web URL of the change request.
 */
dismiss(session: Session, url: string): void

/**
 * Watch a Session's visible change requests as an effect on the calling
 * fiber. Every visible change request that a provider recognizes is polled
 * through `ctx.forge` while the Session has a watcher. Listeners receive the
 * complete list after each later binding or provider change, or polling result; read the
 * current list with {@link changeRequests}. Listeners must not throw; a
 * thrown error is logged and skipped.
 * @param session - Session to watch.
 * @param listener - receives the complete visible list.
 * @returns the disposer that stops this watch.
 */
watch(session: Session, listener: SessionChangeRequestsListener): () => void
```

Types: [Session](session.zh.md)

Source: [`packages/experimental/forge-session/src/index.ts`](../../packages/experimental/forge-session/src/index.ts)

<a id="forge-events"></a>

### `forge/*` events

<a id="forgeproviders-changed--parallel"></a>

#### `forge/providers-changed` — parallel

Announces a provider registration or withdrawal after the registry changes. Listener failures are logged without preventing other listeners from running.

```ts cordis-catalog
/**
 * Announces a provider registration or withdrawal after the registry changes.
 * Listener failures are logged without preventing other listeners from running.
 * @param forge - family whose provider changed.
 * @mode parallel
 */
'forge/providers-changed'(forge: string): void | Promise<void>
```

Source: [`packages/experimental/forge/src/index.ts`](../../packages/experimental/forge/src/index.ts)

<a id="forgereview-changed--parallel"></a>

#### `forge/review-changed` — parallel

Announces a review change the host accepted through this service: a thread or pending-review write, a submitted review, or a viewed mark. Changes whose outcome is unknown, refused, stale, or unsupported are not announced. Listener failures are logged without preventing other listeners from running.

```ts cordis-catalog
/**
 * Announces a review change the host accepted through this service: a thread or pending-review write, a submitted
 * review, or a viewed mark. Changes whose outcome is unknown, refused, stale, or unsupported are not announced.
 * Listener failures are logged without preventing other listeners from running.
 * @param ref - change request the change went to.
 * @param change - what changed and the head commit it was made against.
 * @mode parallel
 */
'forge/review-changed'(ref: ChangeRequestRef, change: ForgeReviewChange): void | Promise<void>
```

Source: [`packages/experimental/forge/src/index.ts`](../../packages/experimental/forge/src/index.ts)
<!-- END GENERATED cordis-surface -->
