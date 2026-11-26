# Forges

[English](forge.md) | 中文

实验性的 forge 能力 seam 从代码托管平台读取变更请求（change request，即 pull request 与 merge request）。[`dsh-experimental-forge`](../../packages/experimental/forge/README.zh.md) 是 Service Definition，提供 `ctx.forge`；[`dsh-experimental-forge-github`](../../packages/experimental/forge-github/README.zh.md) 与 [`dsh-forge-gitlab`](../../packages/experimental/forge-gitlab/README.zh.md) 是服务 GitHub 与 GitLab 主机的 Service Provider；[`dsh-experimental-forge-session`](../../packages/experimental/forge-session/README.zh.md) 是把变更请求绑定到 Session 的 Consumer，提供 `ctx.forgeSession`；[`dsh-experimental-client-ui-forge`](../../packages/experimental/client-ui-forge/README.zh.md) 是提供 `ctx.forgePanel` 的 GUI Consumer。默认禁用的 [forge Bundle](../../packages/experimental/forge-bundle/README.zh.md) 可从插件页面组合这五个包，同时加载[工作树模型工具](../../packages/experimental/tool-worktree/README.zh.md)，并为面板附带一个隔离的 [worktree 服务](../../packages/experimental/worktree/README.zh.md)；除此之外，它们只能通过显式组合加载。

## 提供方与变更请求

一个提供方在其 `hosts` 列出的主机上服务一个 forge 家族，例如 `github`；任意两个已注册的提供方不能列出同一主机，因此每个远端和变更请求 URL 至多对应一个提供方。它把 Git 远端 URL 映射为仓库，把变更请求 URL 映射为引用，构造规范的变更请求 URL，按 head 分支查找打开状态的变更请求，并批量读取状态。`changeRequestKey` 从引用派生一个不区分大小写的键，因此 URL 拼写不同的监听方共享同一个轮询循环。

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
 * forge family on the hosts it lists; methods that take a signal must stop work when it aborts.
 */
interface ForgeProvider {
  /** Forge family name stored in every repository this provider returns. */
  readonly forge: string
  /**
   * Lowercase host names this provider serves, such as `github.com`; `repositoryFromRemote` and `changeRequestFromUrl`
   * return only these hosts, and no other registered provider may list one of them.
   */
  readonly hosts: readonly string[]
  /** Product name readers know this provider's hosts by, such as `GitHub`. */
  readonly label: string
  /** What this provider's hosts call a change request. */
  readonly changeRequestNoun: ChangeRequestNoun
  /**
   * Where and which lists of the signed-in user's change requests this provider reads. A provider declares `viewer` and
   * implements `listForViewer` and `countForViewer` together; omitting any declares that it reads no viewer lists.
   */
  readonly viewer?: ForgeViewerCapability
  /**
   * Read one viewer list, most recently updated first. A query outside {@link ForgeProvider.viewer} resolves to an
   * `unsupported` failure.
   */
  listForViewer?(query: ForgeViewerQuery, signal: AbortSignal): Promise<ForgeViewerList | ForgeFailure>
  /** Count the change requests in every list of {@link ForgeViewerCapability.filters} on one of its hosts. */
  countForViewer?(host: string, signal: AbortSignal): Promise<ReadonlyMap<ForgeViewerFilter, number> | ForgeFailure>
  /** Read the description and labels of a change request. Omission declares that this provider reads no descriptions. */
  readDescription?(ref: ChangeRequestRef, signal: AbortSignal): Promise<ChangeRequestDescription | ForgeFailure>
  /**
   * Read the activity of a change request: the comments in its conversation, its submitted reviews, its commits, and
   * the changes of its state. Omission declares that this provider reads no activity.
   */
  readActivity?(ref: ChangeRequestRef, signal: AbortSignal): Promise<ChangeRequestActivity | ForgeFailure>
  /**
   * Add a comment of Markdown source `body` to a change request's conversation, resolving to undefined once the host
   * saved it. A comment is never retried. Omission declares that this provider adds no comments, and its `readActivity`
   * then denies `viewerCanComment`.
   */
  addComment?(ref: ChangeRequestRef, body: string, signal: AbortSignal): Promise<ForgeActionFailure | undefined>
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
  /**
   * Read the briefs of several change requests, returning one result per requested key. Omission declares that the
   * provider reads briefs as snapshots through {@link ForgeProvider.fetch}.
   */
  fetchBriefs?(
    refs: readonly ChangeRequestRef[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<ChangeRequestKey, ChangeRequestBrief | ForgeFailure>>
  /**
   * Most change requests of one host that one polling call of {@link ForgeProvider.fetch} reads, a positive safe
   * integer. The registry then calls `fetch` once for every that many due change requests of a host, one call after
   * another, each within its own fetch deadline, and publishes the results of a call when it returns. Omission
   * declares that one call reads every due change request of the forge.
   */
  readonly snapshotBatchSize?: number
  /** The same bound for one polling call of {@link ForgeProvider.fetchBriefs}. */
  readonly briefBatchSize?: number
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
   * Turn the host's automatic merge of a change request on, while its head is still the request's `headSha`, or off,
   * resolving to undefined once the host accepted it. Omission declares that the provider sets no automatic merge, and
   * its snapshots then carry no `autoMerge`.
   */
  setAutoMerge?(
    ref: ChangeRequestRef, request: AutoMergeRequest, signal: AbortSignal,
  ): Promise<ForgeActionFailure | undefined>
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
   * undefined once the host accepted the update. A host whose update names the expected head checks it with the update;
   * for one whose update cannot, the provider reads the head just before it, so a push between the read and the update
   * is updated too. Omission declares that the provider updates no branches, and its snapshots then offer no
   * `branchUpdates`.
   */
  updateBranch?(ref: ChangeRequestRef, request: BranchUpdateRequest, signal: AbortSignal): Promise<ForgeActionFailure | undefined>
}
```

`ctx.forge.register` 返回该次注册的 disposer。它的 `replace` 用同一家族的另一个提供方替换已注册的提供方；主机列表在运行期间被修改的提供方调用它来服务新的列表：

```ts type-equiv
/**
 * What `ctx.forge.register` returns: the disposer, plus the replacement of the registered provider by another provider
 * of the same forge family, for a provider whose configuration changes while it runs.
 */
interface ForgeRegistrationHandle {
  /** Unregister the provider this registration holds and wait for its calls, and those of the providers it replaced, to finish. */
  (): Promise<void>
  /**
   * Replace the registered provider in one synchronous step, so no reader finds the family without a provider. The
   * replaced provider's in-flight calls are cancelled and their results discarded; watches of the family poll at once
   * and `forge/providers-changed` announces the change.
   * @param provider - provider of the same forge family.
   * @throws when the registration was withdrawn, `provider.forge` is another family, or another family's provider
   *   serves one of `provider.hosts`, compared without case; the registered provider then keeps serving.
   */
  replace(provider: ForgeProvider): void
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
  /** Shell command the user runs on the host to sign in, while `unauthenticated`; null otherwise or when the provider names none. */
  readonly signIn: { readonly command: string } | null
}
```

`ctx.forge.describe(forge)` 用已注册家族的提供方声明的 `label` 与 `changeRequestNoun` 称呼该家族，读者因此可以按托管平台自己的叫法称呼平台及其变更请求。

```ts type-equiv
/** What the hosts of a forge family call a change request. */
type ChangeRequestNoun = 'pull-request' | 'merge-request'
```

```ts type-equiv
/** How readers name a forge family and its change requests. */
interface ForgeDescription {
  /** Forge family name, such as `github`. */
  readonly forge: string
  /** Product name readers know the family's hosts by, such as `GitHub`. */
  readonly label: string
  /** What the family's hosts call a change request. */
  readonly changeRequestNoun: ChangeRequestNoun
}
```

## 状态轮询

`ctx.forge.watch` 与 `ctx.forge.watchBrief` 让同一变更请求的所有监听方共享一个轮询循环。变更请求有快照监听方时轮询读取快照，否则读取简报，并把结果作为更新送达它所服务的各类监听方。每个 forge 同时最多有一次快照读取和一次简报读取在进行。轮询节奏、退避与超时规则见[注册表 README](../../packages/experimental/forge/README.zh.md#use-this-package)。

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
   * How the change request stands with its host's automatic merge; omitted by a provider that sets none, whose change
   * requests then offer no automatic merge.
   */
  readonly autoMerge?: ChangeRequestAutoMerge
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
   * a later status can succeed; `rate-limited`: the host refused the read under its rate limit, so reading again
   * succeeds only after the limit resets; `unsupported`: the provider does not offer the read; `unavailable`: any other
   * failure.
   */
  readonly code: 'not-found' | 'unauthenticated' | 'too-large' | 'stale' | 'rate-limited' | 'unsupported' | 'unavailable'
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

```ts type-equiv
/**
 * The fields of a {@link ChangeRequestSnapshot} that name a change request and its state in a list. A provider can
 * read them for many change requests in one request, without the checks, reviewers, and merge rules of a snapshot.
 */
type ChangeRequestBrief = Pick<
  ChangeRequestSnapshot, 'ref' | 'url' | 'title' | 'state' | 'draft' | 'mergeability' | 'reviewDecision' | 'checksRollup'
>
```

```ts type-equiv
/** Latest brief delivered to brief watchers of one change request, from a brief read or from a snapshot read. */
type ChangeRequestBriefUpdate = {
  /** Canonical identity of the watched change request. */
  readonly key: ChangeRequestKey
  /** Epoch milliseconds when the result settled. */
  readonly fetchedAt: number
} & ({
  /** Brief read from the host. */
  readonly brief: ChangeRequestBrief
} | {
  /** Reason the brief could not be read. */
  readonly failure: ForgeFailure
})
```

```ts type-equiv
/**
 * Receives every polling result for one change request watched for its brief.
 * @param update - the settled result.
 */
type ChangeRequestBriefListener = (update: ChangeRequestBriefUpdate) => void
```

```ts type-equiv
/** When a watcher that joins a watched change request, or a refresh of one, needs a status newer than the latest one. */
interface ChangeRequestWatchOptions {
  /**
   * Age in milliseconds past which the latest status is too old. A watcher that joins a change request whose
   * snapshot was already read polls at once when the latest snapshot or failure is older and no snapshot poll is in
   * flight; without it, the watcher waits for the regular poll. A refresh polls at once unless the change request is
   * merged or its latest poll at either level, in flight or settled, started within it; without it, a refresh always
   * polls.
   */
  readonly maxAgeMs?: number
}
```

```ts type-equiv
/**
 * The state a brief watcher last saw for a change request it starts to watch, which times the first poll as a brief
 * read at `fetchedAt` would: a merged change request is not polled, and any other one once its interval has passed.
 */
interface ChangeRequestKnownState extends Pick<ChangeRequestBrief, 'state' | 'mergeability' | 'checksRollup'> {
  /** Epoch milliseconds when the state was read. */
  readonly fetchedAt: number
}
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

`ctx.forge.setAutoMerge` 为用户确认过的 head 提交启用代码托管平台的自动合并（方式取快照 `mergeMethods` 中的一种），或取消它；启用后，变更请求满足合并条件时由平台自行合并。快照的 `autoMerge` 说明它是否已启用、平台给出时的合并方式与启用人，以及当前用户现在能否启用或取消。不设置自动合并的提供方两者都不提供，此时 `setAutoMerge` 不询问平台，直接返回失败。

```ts type-equiv
/** How a change request stands with its host's automatic merge. */
interface ChangeRequestAutoMerge {
  /** Whether the host merges the change request by itself once its merge requirements are met. */
  readonly enabled: boolean
  /** How the commits enter the base branch then, while enabled and the host names the method; null otherwise. */
  readonly method: MergeMethod | null
  /** Login of the account that turned it on, while enabled and the host names one; null otherwise. */
  readonly enabledBy: string | null
  /** Whether the signed-in user can turn it on now through `setAutoMerge`; false while it is on. */
  readonly canEnable: boolean
  /** Whether the signed-in user can turn it off now through `setAutoMerge`; false while it is off. */
  readonly canDisable: boolean
}
```

```ts type-equiv
/** Turning a change request's automatic merge on for the head commit the user saw, or off. */
type AutoMergeRequest =
  /** `method` is one of the snapshot's `mergeMethods`; the host refuses once the head is no longer `headSha`. */
  | { readonly enabled: true; readonly method: MergeMethod; readonly headSha: string }
  | { readonly enabled: false }
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

`ctx.forge.readReview(ref, headSha, signal)` 读取变更请求在某个 head 提交处的评审讨论。只有当读取时的 head 就是 `headSha` 时，提供方才返回 `ForgeReviewData`；否则返回 `stale`，并像 diff 读取遇到 `stale` 时一样，立即重新轮询被关注的变更请求。提供方没有实现 `readReview` 时，服务返回 `unsupported`，使用方据此不显示讨论，也不报错。行级讨论有两套位置：`original` 是写下讨论时所在提交上的行，`current` 是本次读取的 head 上的行；托管平台不再把讨论放在该提交上时，`current` 为 null。显示 head diff 的使用方把讨论放在 `current` 位置，其余讨论用 `diffHunk` 展示；用 `fileText` 读取 `original.commit` 上的文件，可以看到写下讨论时的完整文件。各平台的字段如何映射到这两套位置，由 [GitHub 提供方 README](../../packages/experimental/forge-github/README.zh.md#use-this-package) 与 [GitLab 提供方 README](../../packages/experimental/forge-gitlab/README.zh.md#use-this-package) 说明；GitLab 只保留讨论所在行保持不变的最后一个位置，它即成为讨论的 `original`。

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
 * One review thread on a file of a change request. A line thread has two positions: `original` on a commit whose file
 * holds the thread's lines as they were written, and `current` on the head commit of the read. `current` is null once
 * the host no longer places the thread on the head commit, as after later commits changed its lines.
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
  /**
   * Lines in the diff that ended at a commit whose file holds the lines as the thread was written on them: the commit
   * the thread was written on, or a later one the host carried the thread to while the lines stayed unchanged; null for
   * a file thread.
   */
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
  /**
   * Decisions the host lets the signed-in user record in a submitted review of this change request, such as only
   * `comment` on their own pull request on GitHub; empty when `viewerCanReview` is false.
   */
  readonly reviewEvents: readonly ForgeReviewEvent[]
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

<a id="viewer-lists-and-descriptions"></a>

## 登录用户的列表与描述

声明了 `viewer` 的提供方在它的每个主机上读取与登录用户有关的三类打开的变更请求：`review-requested`、`authored` 与 `involved`，三者互不重叠。`ctx.forge.viewerSources()` 列出每个提供方的主机、列表与 `maxItems`；`ctx.forge.listForViewer` 按最近更新在前读取一个列表，每项是 `ChangeRequestSummary`，不含快照的检查、评审者与合并状态；`ctx.forge.countForViewer` 读取一个主机上每个列表的总数。两者都不进入状态轮询：调用方自行轮询列表，并对完整展示的变更请求单独 watch。提供方、主机或列表不提供查看者列表时返回 `unsupported`，主机按限流拒绝时返回 `rate-limited`。

`ctx.forge.readDescription` 读取变更请求的 Markdown 描述与标签；`body` 中的原始 HTML 不得按 HTML 渲染。`images` 把浏览器在没有用户托管平台会话时无法加载的图片地址，映射为托管平台签发、无需会话即可加载该图片的地址；这些地址在 `imagesExpireAt` 之后失效，之后读者应重新读取描述。搜索与图片配对由 [GitHub 提供方 README](../../packages/experimental/forge-github/README.zh.md#use-this-package) 说明。

```ts type-equiv
/**
 * A list of open change requests that involve the signed-in user: `review-requested` asks the user or one of the user's
 * teams for a review; `authored` names the user as author; `involved` names the user in any other way, as an assignee,
 * a commenter, a reviewer, or a mention, and holds none of the other two lists' change requests.
 */
type ForgeViewerFilter = 'review-requested' | 'authored' | 'involved'
```

```ts type-equiv
/** Hosts a provider lists change requests on for the signed-in user, and the lists it offers there. */
interface ForgeViewerCapability {
  /** Lowercase host names, each one this provider serves. */
  readonly hosts: readonly string[]
  /** The lists the provider reads on each of `hosts`. */
  readonly filters: ReadonlySet<ForgeViewerFilter>
  /** Most change requests one read returns, a positive integer. */
  readonly maxItems: number
}
```

```ts type-equiv
/** A registered provider's viewer lists, as {@link ForgeViewerCapability} with the forge family that offers them. */
interface ForgeViewerSource extends ForgeViewerCapability {
  /** Forge family of the provider. */
  readonly forge: string
}
```

```ts type-equiv
/** One read of a list of open change requests that involve the signed-in user on one host. */
interface ForgeViewerQuery {
  /** Lowercase host name from the provider's {@link ForgeViewerCapability.hosts}. */
  readonly host: string
  /** The list to read, from the provider's {@link ForgeViewerCapability.filters}. */
  readonly filter: ForgeViewerFilter
  /** One repository to read in, or null for every repository the user can read on `host`. */
  readonly repository: Pick<ForgeRepository, 'owner' | 'name'> | null
  /** Most change requests returned, a positive integer no greater than {@link ForgeViewerCapability.maxItems}. */
  readonly limit: number
}
```

```ts type-equiv
/** The signed-in user's latest submitted review of a change request. */
interface ChangeRequestViewerReview {
  /** Outcome of the review. */
  readonly verdict: ReviewVerdict
  /** Commit the review was on, or null when the host reports none. */
  readonly reviewedSha: string | null
}
```

```ts type-equiv
/** Status of one change request as a viewer list reports it, without the checks, reviewers, and merge state of a snapshot. */
interface ChangeRequestSummary {
  /** The change request. */
  readonly ref: ChangeRequestRef
  /** Web page of the change request. */
  readonly url: string
  /** Title as the author wrote it. */
  readonly title: string
  /** Whether the author marked the change request as a draft. */
  readonly draft: boolean
  /** Author, or null when the host hides the account. */
  readonly author: ForgeCommentAuthor | null
  /** Commit object name at the head of the change request. */
  readonly headSha: string
  /** Combined check outcome on the head commit. */
  readonly checksRollup: ChecksRollup
  /** Aggregate review outcome. */
  readonly reviewDecision: ReviewDecision
  /** The signed-in user's latest submitted review, or null before the first. */
  readonly viewerReview: ChangeRequestViewerReview | null
  /**
   * The review request that asks the signed-in user, or null when none does: `team` names the team, as
   * `organization/slug`, when the request asks a team the user belongs to rather than the user.
   */
  readonly viewerRequest: { readonly team: string | null } | null
  /** ISO 8601 time of the host's last update to the change request. */
  readonly updatedAt: string
}
```

```ts type-equiv
/** One page of a viewer list, most recently updated first. */
interface ForgeViewerList {
  /** Login of the signed-in user the provider read as. */
  readonly viewer: string
  /** Change requests most recently updated first, at most the query's limit. */
  readonly items: readonly ChangeRequestSummary[]
  /** Number of change requests the host reports in the whole list; more than `items` holds when the list was cut. */
  readonly total: number
}
```

```ts type-equiv
/** The description of a change request as its author wrote it. */
interface ChangeRequestDescription {
  /** Markdown source; it may contain raw HTML, which readers must not render as HTML. Empty without a description. */
  readonly body: string
  /** Labels in host order, at most the provider's limit. */
  readonly labels: readonly ChangeRequestLabel[]
  /** Whether the change request has more labels than `labels` holds. */
  readonly labelsTruncated: boolean
  /**
   * Image addresses that a browser cannot load without the user's host session, each mapped to an address the host
   * issued for loading that image without one. Addresses not listed load as written.
   */
  readonly images: Readonly<Record<string, string>>
  /** ISO 8601 time after which the addresses in `images` stop loading, or null when there are none or the host names no time. */
  readonly imagesExpireAt: string | null
  /** ISO 8601 time the change request was created. */
  readonly createdAt: string
}
```

```ts type-equiv
/** One label of a change request. */
interface ChangeRequestLabel {
  /** Name as the host spells it. */
  readonly name: string
  /** Six-digit hexadecimal color without `#`, or null when the host reports none. */
  readonly color: string | null
}
```

## 动态与评论

`ctx.forge.readActivity` 读取变更请求上发生过的事：对话中的评论、已提交的评审、提交，以及状态的变化，按时间从旧到新，最多为提供方的上限，超出时保留最新的条目。`ctx.forge.addComment` 向对话添加一条评论，之后如果该变更请求正被监视，就立即轮询一次。提供方可以实现其中一个或两个方法：没有 `readActivity` 的提供方返回 `unsupported`，没有 `addComment` 的提供方返回失败；动态的 `viewerCanComment` 说明当前用户能否添加评论。评论和评审的正文是 Markdown 源文本，其中的原始 HTML 不得作为 HTML 渲染。请求以及各主机的记录如何变成条目，由 [GitHub](../../packages/experimental/forge-github/README.zh.md#use-this-package) 与 [GitLab](../../packages/experimental/forge-gitlab/README.zh.md#use-this-package) 提供方的 README 说明。

```ts type-equiv
/**
 * One entry of a change request's activity: a comment in its conversation, a submitted review, a commit, a change of
 * its state, or a record the host words itself.
 */
type ChangeRequestActivityItem = {
  /** ISO 8601 time of the entry. */
  readonly at: string
  /** Account the entry is by, or null when the host names none or the account no longer exists. */
  readonly actor: ForgeCommentAuthor | null
} & (
  /** A comment in the conversation. `body` is Markdown source; it may contain raw HTML, which readers must not render as HTML. */
  | { readonly kind: 'comment'; readonly body: string; readonly url: string | null }
  /**
   * A submitted review: its decision, its own Markdown text, which follows the rule of a comment's `body` and is empty
   * without one, and the number of comments it left on lines and files.
   */
  | { readonly kind: 'review'; readonly verdict: ReviewVerdict; readonly body: string; readonly comments: number; readonly url: string | null }
  /**
   * A commit added to the change request: its object name, abbreviated when the host records only an abbreviation, and
   * the first line of its message.
   */
  | { readonly kind: 'commit'; readonly sha: string; readonly title: string }
  | { readonly kind: 'merged' | 'closed' | 'reopened' | 'ready-for-review' | 'converted-to-draft' | 'force-pushed' }
  | { readonly kind: 'auto-merge-enabled' | 'auto-merge-disabled' }
  /** A review was requested from an account or a team, named as the host spells it; null when the host names neither. */
  | { readonly kind: 'review-requested'; readonly reviewer: string | null }
  | { readonly kind: 'renamed'; readonly from: string; readonly to: string }
  /** A record with no kind of its own, as plain text in the host's own words. */
  | { readonly kind: 'other'; readonly text: string }
)
```

```ts type-equiv
/** The activity of a change request. */
interface ChangeRequestActivity {
  /** Entries oldest first, at most the provider's limit; the latest ones when the change request has more. */
  readonly items: readonly ChangeRequestActivityItem[]
  /** Whether the change request has entries older than `items` holds. */
  readonly truncated: boolean
  /** Whether the signed-in user can add a comment through `addComment`; false for a provider without it. */
  readonly viewerCanComment: boolean
}
```

## Session 绑定

`ctx.forgeSession` 按提供方注册的命令规则，从每个 Session 自己的日志派生其绑定：forge-github 的 `gh` 规则与 forge-gitlab 的 `glab` 规则绑定 `gh pr create` 与 `glab mr create` 结果输出的 URL，以及 `gh pr view`、`glab mr view` 及其同类引用命令所操作的变更请求，`git push` 的结果通过 `ctx.forge` 触发按 head 分支的发现；面板也会报告其检出所跟踪的分支，触发同样的发现。track、dismiss 与发现操作都是 `plugin:forge-session/binding` 插件记录，位于模型可见对话之外。`forgeChangeRequests` 投影的客户端视图随 Session 摘要下发，列出绑定但不含其状态。识别与发现规则见 [Session 绑定 README](../../packages/experimental/forge-session/README.zh.md#use-this-package)。

```ts type-equiv
/**
 * How a change request became bound to a Session: `created` when the result of a command a registered rule names as a
 * creation printed its URL, `referenced` when a command a rule names as a reference named it, its result printed its
 * own URL, or a lookup for it found the URL, `discovered` when a lookup found it for a branch the Session pushed or
 * works on, `tracked` when a caller bound it by URL.
 */
type BindingOrigin = 'created' | 'referenced' | 'discovered' | 'tracked'
```

```ts type-equiv
/** Payload of the `plugin:forge-session/binding` record. */
interface BindingRecord {
  /**
   * `track` binds or restores, `dismiss` hides, `discover` binds a branch lookup,
   * and `reference` binds a command lookup without restoring dismissed entries.
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

提供方通过 `registerCommands` 注册其 CLI 的命令；投影如何据此折叠见 [Session 绑定 README](../../packages/experimental/forge-session/README.zh.md#use-this-package)。

```ts type-equiv
/**
 * The shell commands of one forge family's CLI that bind change requests to the Session that ran them, registered
 * with `ctx.forgeSession.registerCommands`. The `forgeChangeRequests` projection folds the Session log with the
 * recognized rules and folds it again when a registration changes them, so a rule must classify the same input the
 * same way every time: its members are fixed, and `select` reads only its arguments.
 */
interface ForgeCommandRule {
  /** Stable name of the rule, such as `gh`; no two registered rules share one. */
  readonly id: string
  /** Positive integer the registrant raises whenever the rule classifies some command or output differently. */
  readonly version: number
  /** Executable word the rule classifies, such as `gh`; no two registered rules share one. */
  readonly executable: string
  /** Subcommand word sequences that create a change request and print its URL, such as `['pr', 'create']`. */
  readonly creates: readonly (readonly string[])[]
  /** Subcommands that act on one change request, which their words or their output name, such as `['pr', 'view']`. */
  readonly references: ForgeCommandGroup
  /**
   * Subcommands that send a raw API request, such as `['api']`, whose words can name one change request. Their output
   * is not read, since one request can list many change requests.
   */
  readonly apiRequests: ForgeCommandGroup
  /** Regular expression source matching a change request page path after the repository path, such as `\/pull\/\d+`. */
  readonly changeRequestPath: string
  /** JSON member names whose value is the URL of the change request a reference command prints, such as `url`. */
  readonly urlMembers: readonly string[]
  /**
   * Find the change request that one literal reference or API request command names.
   * @param command - the command's kind, subcommand, operands, and option values.
   * @param environment - the variables the command assigns before the executable, the last assignment of a name winning.
   * @returns the change request's URL when the command names its host; a lookup when it names the change request
   * without one; undefined when it names no change request.
   */
  select(command: ForgeCommandArguments, environment: Readonly<Record<string, string>>): ForgeCommandSelection | undefined
}
```

```ts type-equiv
/** Subcommands of one kind and the options they accept. */
interface ForgeCommandGroup {
  /** Subcommand word sequences, such as `['pr', 'view']`; may be empty. */
  readonly subcommands: readonly (readonly string[])[]
  /**
   * Options that take a value: the next word, the text after `=`, or for a one-letter option such as `-R`, the rest of
   * the word.
   */
  readonly valueOptions: readonly string[]
  /** Options that take no value; a command with any other option names nothing. */
  readonly flagOptions: readonly string[]
}
```

```ts type-equiv
/** The parsed words of one reference or API request command after its executable. */
interface ForgeCommandArguments {
  /** Which group of the rule the subcommand belongs to. */
  readonly kind: 'reference' | 'api-request'
  /** The subcommand words, such as `['pr', 'view']`. */
  readonly subcommand: readonly string[]
  /** Words after the subcommand that are neither options nor option values. */
  readonly operands: readonly string[]
  /** Each value option as written, with its value, in command order. */
  readonly values: readonly (readonly [option: string, value: string])[]
}
```

```ts type-equiv
/**
 * The change request one command names: its URL, or a read-only command, starting with the executable, that prints
 * exactly that URL. forge-session runs a lookup in the shell of the command that named it, with that command's
 * variable assignments, and only while the command runs; replaying the Session log runs none.
 */
type ForgeCommandSelection = { readonly url: string } | { readonly lookup: readonly string[] }
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
  /**
   * Requested base: the full name of a local or remote-tracking branch, a short branch name that earlier panels
   * recorded, or null when the checkout started from HEAD of the source checkout.
   */
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
  /**
   * Create a worktree before the Session's first step, starting from `from`, or from HEAD when it is null, on the
   * branch `name`, or on a generated branch name when `name` is absent.
   */
  | { readonly action: 'request'; readonly from: string | null; readonly name?: string }
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
  /**
   * Base: the full name of a local or remote-tracking branch, a short branch name that earlier panels recorded, or
   * null for HEAD of the source checkout. A remote-tracking branch is fetched before each attempt that does not skip it.
   */
  readonly from: string | null
  /** New branch name the user chose, which every attempt uses, or null for a generated name per attempt. */
  readonly name: string | null
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
  /**
   * Running step: `fetch` fetches a remote base branch, `prepare` validates and creates the branch, then
   * `checkout` writes the files.
   */
  readonly phase: 'fetch' | 'prepare' | 'checkout'
  /** Branch the attempt creates. */
  readonly branch: string
  /** Base as the request names it, or null for HEAD. */
  readonly from: string | null
  /** Whether the attempt fetches its remote base branch first. */
  readonly fetch: boolean
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
  /** Base of the attempt as the request names it, or null for HEAD. */
  readonly from: string | null
  /** Whether the attempt fetched, or tried to fetch, its remote base branch first. */
  readonly fetch: boolean
  /** Step that failed. */
  readonly phase: 'fetch' | 'prepare' | 'checkout'
  /** Failure text. */
  readonly message: string
  /** Whether the branch or the checkout directory of that name already existed, which another name avoids. */
  readonly exists: boolean
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
  /** Prefix of generated branch names, the Config `worktreePrefix`, which a name the user types starts from. */
  readonly namePrefix: string
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
  /** How readers name the change request's code host and its change requests, or null when no provider serves its URL. */
  readonly forge: ForgeDescription | null
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
/** Branches offered as the base of a new worktree whose names contain a query. */
interface ForgeWorktreeBases {
  /** Checked-out branch, or null when HEAD is detached or its name does not contain the query. */
  readonly current: ForgeBaseBranch | null
  /** Default branch of each remote that names one with `refs/remotes/<remote>/HEAD`, in remote order. */
  readonly defaults: readonly ForgeRemoteDefault[]
  /** Other local branches, most recently committed first, at most `maxBranches`. */
  readonly local: readonly ForgeBaseBranch[]
  /**
   * Remote-tracking branches of each configured remote in remote order: the remote the checked-out branch tracks,
   * then `origin`, then the others as Git lists them. Remotes without a matching branch are left out.
   */
  readonly remotes: readonly ForgeRemoteBranches[]
}
```

```ts type-equiv
/** A remote's default branch, which `refs/remotes/<remote>/HEAD` names. */
interface ForgeRemoteDefault extends ForgeBaseBranch {
  /** Remote the branch belongs to; it may contain `/`. */
  readonly remote: string
}
```

```ts type-equiv
/** Remote-tracking branches of one remote, without its default branch. */
interface ForgeRemoteBranches {
  /** Remote name such as `origin`; it may contain `/`. */
  readonly name: string
  /** `owner/name` of the repository a provider recognizes from the remote's URLs, else its fetch URL, or null without one. */
  readonly repository: string | null
  /** Branches named `<remote>/<branch>`, most recently committed first, at most `maxBranches`. */
  readonly branches: readonly ForgeBaseBranch[]
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

变更视图经同一个 Remote 读取。`localDiff` 读取 Session 检出的某个 `ForgeLocalScope`，或该范围用 `head` 指定的分支；`changeRequestDiff` 经提供方的 `diff` 读取已绑定变更请求在其最新状态 head 处的变更（提供方只返回描述该 head 提交的补丁），或经提供方的 `compare` 读取它指定的 `ForgeCommitRange`；两者返回的文件都已在宿主上解析为 `ForgeDiffFile` 的 hunk，并带有分层与改动摘要。`localCommits` 与 `changeRequestCommits` 列出范围可以指定的提交，提供方不读取提交时后者返回 null。`localText` 与 `changeRequestText` 读取一个文件的新版本，用来补出 hunk 之间未变更的行。每次检查还会把 `branch` 范围的规模统计为 `ForgePanelState.local`，供会话面板的本地变更行使用，始终以自动分叉点为准。`base` 指定了引用的 `branch` 范围改为与 HEAD 和该分支的合并基准比较；`diffBases` 列出视图可选的分支以及自动分叉点。head 已越过最新状态时，提供方返回 `stale`，`ctx.forge.diff` 立即重新轮询该变更请求（每个 head 提交一次）；`changeRequestDiff` 以 `forgePanel/stale-head` 拒绝且不缓存任何内容，变更视图保持加载，直到更新的状态到达后按该状态的 head 重新读取。因此评审评论始终指向视图所显示行的那个提交。

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

本地范围读取 Session 当前目录所在的检出，除非它用 `head` 指定一个分支：`refs/heads/` 或 `refs/remotes/` 下的完整引用名，并且 `show-ref --verify` 能在 Session 的仓库里找到它。Host 在检出该分支的地方读取它。`git worktree list` 给出仓库里检出该分支的 worktree、并且检查发现那里是同一个仓库的检出且确实检出了该分支时，Git 以读取方 Session 的沙箱策略在这个 worktree 里运行：每个范围都读取它的工作树，结果在 `worktree` 中给出这个目录。否则（所有远程跟踪分支都是）只有 `branch` 范围可用，它比较已提交的内容，以该引用代替 HEAD，不含未提交和未跟踪的文件；其他范围以 `forgePanel/no-working-tree` 拒绝。`head` 指向 Session 自己检出的分支时，读取的是 Session 的检出。带 `head` 的范围没有指定 `base` 时，分叉点是 `head` 与 Session 自己的 HEAD 所指提交的合并基准，所以范围覆盖的是该分支离开 Session 的工作之后的改动，没有远端的仓库也一样；结果的 `base` 是 Session 检出的分支名，分离 HEAD 时是缩写提交。

`diffBases(session, head, query)` 与 `localCommits(session, head, base)` 接受同样的 `head`，null 表示 Session 自己的检出。`diffBases` 不列出范围正在查看的分支；带 `head` 时也不列出 Session 检出的分支，因为自动基准已经是它；并给每个本地分支写上检出它的 worktree 的目录，所以页面用同一个 Remote 方法、以 null 作为 `head` 列出可以查看的分支。`head` 指向的分支不存在时，读取以 `forgePanel/head-missing` 拒绝。`localWrite` 不接受 `head`，只写 Session 自己的检出。

```ts type-equiv
/**
 * Which local changes a diff covers. Without `head` each reads the checkout of the Session's current directory through
 * Git. With `head`, the full ref name of a branch under `refs/heads/` or `refs/remotes/`, it reads that branch in place
 * of the checked-out one: in the worktree of the repository that has the branch checked out, where every scope applies
 * and HEAD below is that worktree's, or, when no worktree has it, from the branch's commits, where only the `branch`
 * scope applies and no uncommitted or untracked file shows.
 */
type ForgeLocalScope =
  /**
   * The working tree and untracked files against a fork point: the merge base of HEAD with the `base` ref. While
   * `base` is null, a scope with a `head` uses the merge base with the commit the Session's own HEAD names; a scope
   * without one uses the base commit of the worktree the Session created, else the merge base of HEAD with the
   * default branch of the code host remote. With `commits`, only the changes of those commits between the fork
   * point and HEAD, without uncommitted or untracked files.
   */
  | { readonly kind: 'branch'; readonly head?: string; readonly base: string | null; readonly commits: ForgeCommitRange | null }
  /** The working tree and untracked files against HEAD. */
  | { readonly kind: 'uncommitted'; readonly head?: string }
  /** The working tree and untracked files against the index. */
  | { readonly kind: 'unstaged'; readonly head?: string }
  /** The index against HEAD. */
  | { readonly kind: 'staged'; readonly head?: string }
```

```ts type-equiv
/** A branch the `branch` scope can compare with. */
interface ForgeBaseBranch {
  /** Full ref name: `refs/heads/<branch>` or `refs/remotes/<remote>/<branch>`. */
  readonly ref: string
  /** The ref without `refs/heads/` or `refs/remotes/`, such as `master` or `origin/master`. */
  readonly name: string
  /**
   * Directory Git registered for the worktree that has this local branch checked out, absent when none has; a scope
   * that names the branch as its head reads that worktree.
   */
  readonly worktree?: string
}
```

```ts type-equiv
/** What the `branch` scope compares with while no base branch is chosen. */
interface ForgeAutomaticBase {
  /**
   * The created worktree's base branch or abbreviated base commit, or the default branch of the code host remote;
   * for a scope with a `head`, the Session's checked-out branch, or its abbreviated HEAD commit when detached.
   */
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
  /** Local branches other than the one the scope shows, most recently committed first, at most `maxBranches`. */
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
  /** Whether the path is a submodule, whose change is the commit recorded for it and whose hunks hold no file content. */
  readonly submodule: boolean
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
  /**
   * Top-level directory of the worktree the scope read for its `head`; absent for the Session's own checkout and for
   * a head read from its commits.
   */
  readonly worktree?: string
}
```

`localWrite(session, write)` 对 Session 检出中的整个文件进行暂存、取消暂存或还原，或把暂存区条目恢复到更早的 tree。调用方按下按钮就是授权，所以它的 Git 命令不受 Session 沙箱策略约束，在任何访问模式下都运行。`stage` 和 `restore` 为每个文件带上读者所见改动的 digest；重新读取的 `unstaged` 范围列出的改动不同时，以 `forgePanel/local-stale` 拒绝整次写入。已删除文件的路径上是一个目录时，两者都以 `forgePanel/local-path-replaced` 拒绝；`restore` 还拒绝 `submodule` 为 true 的文件。`stage` 或 `unstage` 的结果带有写入之前的暂存区 tree，对同一批路径执行 `reindex` 即可恢复到它。

```ts type-equiv
/** One file of a local write, as the `unstaged` scope listed it for the reader. */
interface ForgeLocalWriteFile {
  /** Path relative to the repository root, as the diff names it. */
  readonly path: string
  /** Digest of the change the reader saw. */
  readonly digest: string
}
```

```ts type-equiv
/**
 * A write a person makes from the changes view to the index or the working tree of the Session's checkout, on whole
 * files. The person's press authorizes it, so the Session's access mode does not bound it.
 */
type ForgeLocalWrite =
  /** Copy the working-tree state of the files into the index, adding untracked files and recording deletions. */
  | { readonly kind: 'stage'; readonly files: readonly ForgeLocalWriteFile[] }
  /** Return the index entries of the paths to HEAD; a staged rename names both of its paths. */
  | { readonly kind: 'unstage'; readonly paths: readonly string[] }
  /**
   * Return the working-tree files to their index entries and delete untracked files. A file Git tracks without
   * content yet, as `git add --intent-to-add` leaves it, is refused, because its index entry is empty; so is a
   * submodule, whose checkout a restore leaves as it is.
   */
  | { readonly kind: 'restore'; readonly files: readonly ForgeLocalWriteFile[] }
  /** Return the index entries of the paths to `tree`, the {@link ForgeLocalWriteResult.undo} of an earlier write. */
  | { readonly kind: 'reindex'; readonly tree: string; readonly paths: readonly string[] }
```

```ts type-equiv
/** What a local write left for undoing it. */
interface ForgeLocalWriteResult {
  /**
   * Object name of the index as a tree before a `stage` or `unstage`, which a `reindex` of the same paths returns to;
   * null for other writes and while the index holds unmerged entries.
   */
  readonly undo: string | null
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
/** Size of the `branch` scope, which the Session panel's local changes row shows. */
interface ForgeLocalChanges {
  /** Ref or abbreviated commit the scope compares with. */
  readonly base: string
  /** Changed files in Git's path order, untracked files last, at most `maxUntrackedFiles` of those. */
  readonly files: readonly ForgeChangedFile[]
}
```

### 代码评审页

[代码评审页](../../packages/experimental/client-ui-forge/README.zh.md#use-this-package)按 URL 读取变更请求，而不经过会话绑定。它的 `forgePanel` 方法（`reviewLists`、`reviewCount`、`reviewChangeRequest`、`reviewDescription`、`reviewActivity`、`reviewComment`、`reviewSetAutoMerge`，以及与会话绑定版本对应的各个 `review*` 读取与操作）用 `ForgeService.changeRequestFromUrl` 解析 URL，没有提供方能处理时以 `forgePanel/unrecognized-url` 失败；它们不指向任何会话资源，因此只有可以使用 Host 代码托管凭据的调用方能访问。一个列表中心只在列表流或计数流存在时读取[登录用户的列表](#viewer-lists-and-descriptions)：同一仓库范围的流共用一个读取器，它每隔 `reviewListIntervalMs` 读取每个主机的每个列表，各主机并行、同一主机的列表依次读取；某主机拒绝当前用户或触发限流时，本轮不再读取它的其余列表；读取失败的主机每次间隔更久再读，以 `reviewMaxBackoffMs` 为上限，其他主机保持原来的间隔。计数每隔 `reviewCountIntervalMs` 以同样的方式读取，全部仓库范围的列表读取也会更新它。范围是全部主机的全部仓库，或一个 `ForgeReviewRepository`；后者带有主机，只在该主机上读取。`reviewLists` 流式返回 `ForgeReviewFrame`，含每个主机的列表、最近一次成功读取的条目、最近一次读取的失败，以及主机拒绝当前用户时其提供方的 `readiness` 给出的登录命令；`reviewCount` 流式返回 `ForgeReviewCountFrame`；`reviewChangeRequest` 为显示中的变更请求流式返回 `ForgeReviewChangeRequest`，该变更请求在其流存在期间经 `ForgeService.watch` 轮询。

对话标签在 `connectWorkspace` 解析出的空白会话中开始，并用 `reviewStage` 记录该变更请求；Host 只在内存中保存这个选择，等该会话的下一条消息进入收件箱时再绑定，因此未使用的空白会话保持未绑定。

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

`ctx.forgeChanges` 还可以生成和解析变更视图地址，给出标签的 `kinds`，并用 `open(target, { path, lens })` 在侧栏所显示的 Session 中打开视图。`registerAnnotations(source)` 添加行注解：数据源按路径观察每个视图的注解，它在 `forge.diff.line.annotation` 中按数据源身份登记的条目，负责绘制视图所画外框里的内容。注解放在其最后一行之后，位于评论框、浏览器草稿和托管平台讨论之后，落在所在一侧的那一栏；整个文件的注解排在最前，写在另一个 `digest` 上的注解在文件之后单独成段。每个文件最多显示 `maxAnnotationsPerFile` 条；逐行绘制的文件在文件段进入可视区附近之前不绘制注解。本地变更视图查看的是 `head` 指定的分支而不是 Session 自己的检出时，不绘制注解，也不绘制 `forge.changes.toolbar`、`forge.changes.file.menu` 与 `forge.diff.comment.actions` 插槽的条目。所有 slot 的 owner props 见 [`src/client/slots.ts`](../../packages/experimental/client-ui-forge/src/client/slots.ts)。

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

Registry of forge providers. Watchers of one change request share a single polling loop, which reads its snapshot while a snapshot watcher remains and its brief otherwise. Each forge has at most one snapshot fetch and one brief fetch in flight; each batches every due change request of that forge at its level, and those past the midpoint of the wait after a status, so change requests that became due at different times come to share one fetch. A fetch calls a provider that names a batch size once per that many change requests of a host, and settles the results of each call when it returns.

```ts cordis-catalog
/**
 * Register the provider of one forge family as an effect on the calling
 * fiber. Watches of that forge receive an `unavailable` failure when the
 * registration ends. Unregistering cancels and awaits its in-flight calls;
 * results from the withdrawn registration are discarded.
 * @param provider - provider to serve `provider.forge` on `provider.hosts`.
 * @returns the disposer that unregisters the provider and waits for its calls to finish, carrying
 *   {@link ForgeRegistrationHandle.replace}.
 * @throws when another provider already serves the same forge or one of the same hosts, compared without case, and
 * when the provider names a batch size that is not a positive safe integer.
 */
register(provider: ForgeProvider): ForgeRegistrationHandle

/**
 * Name a forge family and its change requests for readers.
 * @param forge - forge family name, such as `github`.
 * @returns the registered provider's description, or undefined when no provider serves the family.
 */
describe(forge: string): ForgeDescription | undefined

/**
 * Map a Git remote URL to a repository through the provider that serves its host.
 * @param url - fetch or push URL as Git reports it.
 * @returns the repository, or undefined when no provider serves the URL.
 */
repositoryFromRemote(url: string): ForgeRepository | undefined

/**
 * Map a change request web URL through the provider that serves its host.
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
 * Report whether a provider can reach one host with current credentials.
 * @param repository - forge family of a registered provider and the host to probe; a repository names both.
 * @param signal - cancellation for the probe.
 * @returns the provider's readiness for the host.
 * @throws when no provider serves the forge.
 */
async readiness(repository: Pick<ForgeRepository, 'forge' | 'host'>, signal: AbortSignal): Promise<ForgeReadiness>

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
 * Turn the host's automatic merge of a change request on, while its head is still the request's `headSha`, or off,
 * then poll it at once when it is watched.
 * @param ref - change request served by a registered provider.
 * @param request - on with the merge method and the head commit the user confirmed, or off.
 * @param signal - cancellation of the request.
 * @returns undefined once the host accepted it, or why it did not; a provider that sets no automatic merge fails.
 * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
 */
async setAutoMerge( ref: ChangeRequestRef, request: AutoMergeRequest, signal: AbortSignal, ): Promise<ForgeActionFailure | undefined>

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
 * List the viewer lists every registered provider offers; `forge/providers-changed` announces a change.
 * @returns one source per provider that declares viewer lists and reads them, in registration order.
 */
viewerSources(): ForgeViewerSource[]

/**
 * Read one list of open change requests that involve the signed-in user.
 * @param forge - forge family of a registered provider.
 * @param query - host, list, repository, and limit of the read.
 * @param signal - cancellation of the read.
 * @returns the list, or why the host did not provide it; `unsupported` when the provider does not offer the host or list.
 * @throws when no provider serves `forge`, or with `signal.reason` when it aborts.
 */
async listForViewer(forge: string, query: ForgeViewerQuery, signal: AbortSignal): Promise<ForgeViewerList | ForgeFailure>

/**
 * Count the change requests in each viewer list a provider offers on one host.
 * @param forge - forge family of a registered provider.
 * @param host - lowercase host name the provider lists on.
 * @param signal - cancellation of the read.
 * @returns the count of each list, or why the host did not provide them; `unsupported` when the provider does not list on `host`.
 * @throws when no provider serves `forge`, or with `signal.reason` when it aborts.
 */
async countForViewer(forge: string, host: string, signal: AbortSignal): Promise<ReadonlyMap<ForgeViewerFilter, number> | ForgeFailure>

/**
 * Read the description and labels of a change request.
 * @param ref - change request served by a registered provider.
 * @param signal - cancellation of the read.
 * @returns the description, or why the host did not provide it; `unsupported` when the provider reads no descriptions.
 * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
 */
async readDescription(ref: ChangeRequestRef, signal: AbortSignal): Promise<ChangeRequestDescription | ForgeFailure>

/**
 * Read the activity of a change request: its comments, submitted reviews, commits, and changes of state.
 * @param ref - change request served by a registered provider.
 * @param signal - cancellation of the read.
 * @returns the activity, or why the host did not provide it; `unsupported` when the provider reads no activity.
 * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
 */
async readActivity(ref: ChangeRequestRef, signal: AbortSignal): Promise<ChangeRequestActivity | ForgeFailure>

/**
 * Add a comment to a change request's conversation, then poll it at once when it is watched.
 * @param ref - change request served by a registered provider.
 * @param body - Markdown source of the comment.
 * @param signal - cancellation of the request.
 * @returns undefined once the host saved the comment, or why it did not; a provider that adds no comments fails.
 * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
 */
async addComment(ref: ChangeRequestRef, body: string, signal: AbortSignal): Promise<ForgeActionFailure | undefined>

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
 * Watch the snapshot of one change request as an effect on the calling fiber. Its first snapshot watcher polls it at
 * once, and a later one does when `options.maxAgeMs` is given and the latest result is older. Listeners receive every
 * later snapshot poll result, and `latest` returns the current one. While a snapshot watcher remains, polls read the
 * snapshot; polling stops when the last watcher of the snapshot and the brief leaves. Listeners must not throw; a
 * thrown error is logged and skipped.
 * @param ref - change request to poll.
 * @param listener - receives each snapshot poll result.
 * @param options - when the watcher needs a status newer than the latest one.
 * @returns the disposer that stops this watch.
 */
watch(ref: ChangeRequestRef, listener: ChangeRequestListener, options: ChangeRequestWatchOptions = {}): () => void

/**
 * Watch the brief of one change request as an effect on the calling fiber. Listeners receive the brief of every
 * later poll result: of a brief read while only brief watchers remain, and of a snapshot read otherwise. The first
 * watcher of a change request polls it at once, or as `known` times it. Polling stops when the last watcher of the
 * snapshot and the brief leaves. Listeners must not throw; a thrown error is logged and skipped.
 * @param ref - change request to poll.
 * @param listener - receives the brief of each poll result.
 * @param known - the state the caller last saw, which times the first poll of a change request without a watcher.
 * @returns the disposer that stops this watch.
 */
watchBrief(ref: ChangeRequestRef, listener: ChangeRequestBriefListener, known?: ChangeRequestKnownState): () => void

/**
 * Poll a watched change request at once, including after a terminal state.
 * A fetch already in flight is followed immediately by another fetch; an
 * unwatched change request is unchanged. With `options.maxAgeMs`, the caller
 * needs a status no older than that many milliseconds: a change request
 * whose latest poll at either level, in flight or settled, started within
 * them is left alone, and so is a merged one, whose status is final.
 * @param ref - change request to poll.
 * @param options - when the caller needs a status newer than the latest one.
 */
refresh(ref: ChangeRequestRef, options: ChangeRequestWatchOptions = {}): void

/**
 * Announce that a watched change request is about to change, as after a push to its head branch. It is polled at
 * once and then every `activeIntervalMs`, until a status reports running checks or a closed or merged change
 * request, and for at most `idleIntervalMs`; after that the regular cadence applies. A fetch already in flight is
 * followed immediately by another fetch; an unwatched change request is unchanged.
 * @param ref - change request the caller expects to change.
 */
expectChange(ref: ChangeRequestRef): void

/**
 * Read the latest snapshot poll result of a watched change request.
 * @param ref - change request to read.
 * @returns the latest result, or undefined before the first snapshot poll settled or without a watch.
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
 * Stream the review page's lists of the signed-in user's open change requests on every host a provider lists them on:
 * the lists read so far first, then a frame after each read settles. Readers of one repository scope share one
 * reader, which reads each host every `reviewListIntervalMs` while some stream lasts and reads a host whose read failed
 * again later each time, up to `reviewMaxBackoffMs`, without delaying the other hosts; nothing is read while no stream
 * lasts. The stream ends when `signal` aborts or the Remote stops.
 * @param repository - one repository to list in, read on its host only, or null for every repository the user can
 * read on every host.
 * @param signal - ends the stream.
 * @returns frames, each complete.
 */
@Remote({ mode: 'stream' }) async *reviewLists( repository: ForgeReviewRepository | null, signal: AbortSignal, ): AsyncIterable<ForgeReviewFrame>

/**
 * Stream the number of open change requests that ask the signed-in user for a review, summed over the hosts read:
 * the latest count first, then each change. It is read every `reviewCountIntervalMs` while some stream lasts, and a
 * list stream of every repository updates it as well. The stream ends when `signal` aborts or the Remote stops.
 * @param signal - ends the stream.
 * @returns frames, each complete.
 */
@Remote({ mode: 'stream' }) async *reviewCount(signal: AbortSignal): AsyncIterable<ForgeReviewCountFrame>

/**
 * Read every streamed review page list and the count again at once.
 * @param signal - request cancellation.
 */
@Remote // oxlint-disable-next-line typescript/require-await -- async keeps a refused or cancelled request a rejection, as Remote callers expect async reviewRefresh(signal: AbortSignal): Promise<void>

/**
 * Report whether a provider reaches one of its hosts with the Host's current credentials, for the host list on the
 * Plugins page of that provider's row. The read names no Session, so, like the review page reads, only callers that
 * may use the Host's code host credentials reach it.
 * @param forge - forge family of a registered provider, such as `gitlab`.
 * @param host - host name as the provider's configuration lists it.
 * @param signal - request cancellation.
 * @returns the provider's readiness for the host; `unavailable` with the reason when no provider serves the family,
 * the probe fails, or it runs past `readinessTimeoutMs`.
 */
@Remote async hostReadiness(forge: string, host: string, signal: AbortSignal): Promise<ForgeReadiness>

/**
 * Poll one change request the review page shows at once; its stream reports the result.
 * @param url - web URL of the change request.
 * @param signal - request cancellation.
 * @throws `forgePanel/unrecognized-url` when no provider serves the URL.
 */
@Remote // oxlint-disable-next-line typescript/require-await -- async keeps a refused or cancelled request a rejection, as Remote callers expect async reviewPoll(url: string, signal: AbortSignal): Promise<void>

/**
 * Stream one change request the review page shows in full: its latest polling result first, then each later result
 * and each review change `forge/review-changed` announces for it. The change request is polled through `ctx.forge`
 * while the stream lasts. Review page reads and actions name a change request by URL and need no Session binding, so
 * only callers that may use the Host's code host credentials reach them.
 * @param url - web URL of the change request.
 * @param signal - ends the stream.
 * @returns frames, each complete.
 * @throws `forgePanel/unrecognized-url` when no provider serves the URL.
 */
@Remote({ mode: 'stream' }) async *reviewChangeRequest(url: string, signal: AbortSignal): AsyncIterable<ForgeReviewChangeRequest>

/**
 * Read the description and labels of a change request for the review page.
 * @param url - web URL of the change request.
 * @param signal - request cancellation.
 * @returns the description.
 * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/description-failed` with the
 * host's reason when the host does not provide it.
 */
@Remote async reviewDescription(url: string, signal: AbortSignal): Promise<ChangeRequestDescription>

/**
 * Read the activity of a change request for the review page: its comments, submitted reviews, commits, and changes
 * of state.
 * @param url - web URL of the change request.
 * @param signal - request cancellation.
 * @returns the activity, or null when the change request's provider reads none.
 * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/activity-failed` with the
 * host's reason when the host does not provide it.
 */
@Remote async reviewActivity(url: string, signal: AbortSignal): Promise<ChangeRequestActivity | null>

/**
 * Add a comment to the conversation of a change request the review page shows.
 * @param url - web URL of the change request.
 * @param body - Markdown source of the comment.
 * @param signal - request cancellation.
 * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/action-failed` when `body` is
 * blank, or with the host's reason; `forgePanel/action-unknown` when the host's answer did not confirm the comment.
 */
@Remote async reviewComment(url: string, body: string, signal: AbortSignal): Promise<void>

/**
 * Read every check of a change request the review page shows.
 * @param url - web URL of the change request.
 * @param headSha - head commit whose checks the page shows.
 * @param signal - request cancellation.
 * @returns the snapshot with every check.
 * @throws as {@link ForgePanelController.changeRequestChecks} does, with `forgePanel/unrecognized-url` in place of
 * `forgePanel/not-bound`.
 */
@Remote async reviewChecks(url: string, headSha: string, signal: AbortSignal): Promise<ChangeRequestSnapshot>

/**
 * Read the review threads of a change request the review page shows, at the head of its latest status.
 * @param url - web URL of the change request.
 * @param headSha - head commit the page shows.
 * @param fresh - whether to read from the host even when threads at this head and update time are kept.
 * @param signal - request cancellation.
 * @returns the threads at `headSha`.
 * @throws as {@link ForgePanelController.changeRequestReview} does, with `forgePanel/unrecognized-url` in place of
 * `forgePanel/not-bound`.
 */
@Remote async reviewThreads(url: string, headSha: string, fresh: boolean, signal: AbortSignal): Promise<ForgeReviewData>

/**
 * Write to the review threads or the pending review of a change request the review page shows.
 * @param url - web URL of the change request.
 * @param write - the write and the head commit the user saw.
 * @param signal - request cancellation.
 * @returns whether the host took the write, as {@link ForgePanelController.changeRequestReviewWrite} does.
 * @throws `forgePanel/unrecognized-url` when no provider serves the URL; an error for an invalid write.
 */
@Remote async reviewThreadWrite(url: string, write: ForgeReviewWrite, signal: AbortSignal): Promise<ForgeReviewWriteResult>

/**
 * Publish a line comment or a completed review on a change request the review page shows.
 * @param url - web URL of the change request.
 * @param request - reviewed head, ranges, plain text, and explicit review decision.
 * @param signal - request cancellation.
 * @returns confirmed publication or a typed failure, as {@link ForgePanelController.submitReview} does.
 * @throws `forgePanel/unrecognized-url` when no provider serves the URL; an error for an invalid review.
 */
@Remote async reviewSubmit(url: string, request: ForgeReviewRequest, signal: AbortSignal): Promise<ForgeReviewResult>

/**
 * Read the changes of a change request the review page shows, or of consecutive commits of it.
 * @param url - web URL of the change request.
 * @param commits - consecutive commits of the change request, or null for all of it.
 * @param signal - request cancellation.
 * @returns the files and the commit they end at, without a local checkout count.
 * @throws as {@link ForgePanelController.changeRequestDiff} does, with `forgePanel/unrecognized-url` in place of
 * `forgePanel/not-bound`.
 */
@Remote async reviewDiff(url: string, commits: ForgeCommitRange | null, signal: AbortSignal): Promise<ForgeChangeRequestDiff>

/**
 * List the commits of a change request the review page shows.
 * @param url - web URL of the change request.
 * @param signal - request cancellation.
 * @returns the commits, or null when the provider does not read commits.
 * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/diff-failed` when the host does
 * not list them.
 */
@Remote async reviewCommits(url: string, signal: AbortSignal): Promise<ForgeCommitList | null>

/**
 * Read one file of a change request's repository at a commit for the review page.
 * @param url - web URL of the change request.
 * @param commit - commit object name.
 * @param path - path relative to the repository root.
 * @param signal - request cancellation.
 * @returns the text.
 * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/diff-too-large` or
 * `forgePanel/diff-failed` when the host does not provide the file.
 */
@Remote async reviewText(url: string, commit: string, path: string, signal: AbortSignal): Promise<string>

/**
 * Read the signed-in user's viewed marks on the files of a change request the review page shows, as
 * {@link ForgePanelController.changeRequestViewed} keeps them.
 * @param url - web URL of the change request.
 * @param headSha - head commit of the shown diff.
 * @param fresh - whether to read the host although kept marks could answer, as after a refresh.
 * @param signal - request cancellation.
 * @returns the marks, or null when the provider keeps no viewed marks.
 * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/stale-head` or
 * `forgePanel/viewed-failed` as {@link ForgePanelController.changeRequestViewed} does.
 */
@Remote async reviewViewed(url: string, headSha: string, fresh: boolean, signal: AbortSignal): Promise<ForgeViewedFiles | null>

/**
 * Set or clear the signed-in user's viewed mark on one file of a change request the review page shows.
 * @param url - web URL of the change request.
 * @param request - the file, its mark, and the head commit of the shown diff.
 * @param signal - request cancellation.
 * @throws `forgePanel/unrecognized-url` when no provider serves the URL; the action errors of
 * {@link ForgePanelController.setFileViewed}.
 */
@Remote async reviewSetViewed(url: string, request: ForgeViewedRequest, signal: AbortSignal): Promise<void>

/**
 * Mark a draft change request the review page shows ready for review.
 * @param url - web URL of the change request.
 * @param signal - request cancellation.
 * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/action-failed` or
 * `forgePanel/action-unknown` with the host's reason.
 */
@Remote async reviewMarkReady(url: string, signal: AbortSignal): Promise<void>

/**
 * Merge a change request the review page shows while its head is still `headSha`.
 * @param url - web URL of the change request.
 * @param method - how the commits enter the base branch.
 * @param headSha - head commit the user confirmed.
 * @param signal - request cancellation.
 * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/stale-head`,
 * `forgePanel/action-failed`, or `forgePanel/action-unknown` with the host's reason.
 */
@Remote async reviewMerge(url: string, method: MergeMethod, headSha: string, signal: AbortSignal): Promise<void>

/**
 * Turn the code host's automatic merge of a change request the review page shows on, while its head is still the
 * request's `headSha`, or off.
 * @param url - web URL of the change request.
 * @param request - on with the merge method and the head commit the user confirmed, or off.
 * @param signal - request cancellation.
 * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/stale-head`,
 * `forgePanel/action-failed`, or `forgePanel/action-unknown` with the host's reason.
 */
@Remote async reviewSetAutoMerge(url: string, request: AutoMergeRequest, signal: AbortSignal): Promise<void>

/**
 * Rerun the failed checks of a change request the review page shows.
 * @param url - web URL of the change request.
 * @param request - the head commit whose checks the user saw.
 * @param signal - request cancellation.
 * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/stale-head`,
 * `forgePanel/action-failed`, or `forgePanel/action-unknown` with the host's reason.
 */
@Remote async reviewRerunChecks(url: string, request: ForgeRerunRequest, signal: AbortSignal): Promise<void>

/**
 * Request reviews of a change request the review page shows from more reviewers.
 * @param url - web URL of the change request.
 * @param reviewers - the reviewers to ask, by kind and login.
 * @param signal - request cancellation.
 * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/action-failed` or
 * `forgePanel/action-unknown` with the host's reason; an error without reviewers.
 */
@Remote async reviewRequestReviews(url: string, reviewers: readonly Pick<ChangeRequestReviewer, 'kind' | 'login'>[], signal: AbortSignal): Promise<void>

/**
 * List accounts a review of a change request the review page shows can be requested from.
 * @param url - web URL of the change request.
 * @param query - text the login or name contains; empty for the host's suggestions.
 * @param signal - request cancellation.
 * @returns the accounts, the host's suggestions first.
 * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/reviewers-failed` when the host
 * does not list them.
 */
@Remote async reviewReviewerCandidates(url: string, query: string, signal: AbortSignal): Promise<readonly ForgeReviewerCandidate[]>

/**
 * Bring the base branch's new commits into the head branch of a change request the review page shows.
 * @param url - web URL of the change request.
 * @param method - merge or rebase.
 * @param headSha - head commit the user confirmed.
 * @param signal - request cancellation.
 * @throws `forgePanel/unrecognized-url` when no provider serves the URL; `forgePanel/stale-head`,
 * `forgePanel/action-failed`, or `forgePanel/action-unknown` with the host's reason.
 */
@Remote async reviewUpdateBranch(url: string, method: BranchUpdateMethod, headSha: string, signal: AbortSignal): Promise<void>

/**
 * Remember the change request a review conversation's draft quotes, or forget it with null. When the Session's next
 * message enters its inbox, the change request is bound to the Session with a `track` record before the turn starts;
 * a Session that already started is bound at its next message. The choice lives in memory until then.
 * @param sessionId - the Session whose draft quotes the change request; staging neither loads nor resumes it.
 * @param url - web URL of the change request, or null.
 * @param signal - request cancellation.
 * @throws `forgePanel/unrecognized-url` when no provider serves the URL.
 */
@Remote // oxlint-disable-next-line typescript/require-await -- async keeps a refused or cancelled request a rejection, as Remote callers expect async reviewStage(sessionId: SessionId, url: string | null, signal: AbortSignal): Promise<void>

/**
 * Read or await the worktree service's archive cleanup of the Session's checkout.
 * @param sessionId - Session whose cleanup is visible to the caller; reading neither loads nor resumes it.
 * @param revision - null reads now; a matching revision waits for completion.
 * @returns the cleanup state, or null without a worktree service, an attempt, or a current revision.
 */
@Remote async worktreeCleanup(sessionId: SessionId, revision: number | null): Promise<WorktreeCleanup | null>

/**
 * List the branches that can start a worktree of the Session's current checkout: the checked-out branch, each
 * remote's default branch, other local branches, and each remote's other remote-tracking branches, remotes in the
 * order the panel recognizes code hosts.
 * @param session - Session whose checkout is read.
 * @param query - text the branch names must contain, ignoring case; empty for every branch.
 * @param signal - request cancellation.
 * @returns the branches, at most `maxBranches` local branches and `maxBranches` per remote, most recently committed first.
 * @throws `forgePanel/not-a-checkout` outside a checkout; the Git error when Git fails or the listed refs exceed `maxDiffBytes`.
 */
@Remote async worktreeBases(session: Session, query: string, signal: AbortSignal): Promise<ForgeWorktreeBases>

/**
 * List the branches the `branch` scope can compare with, for the Session's current checkout or for a head branch
 * read in its place.
 * @param session - Session whose checkout is read.
 * @param head - full ref of the branch the scope reads in place of the checked-out one, or null for the checkout.
 * @param query - text the branch names must contain, ignoring case; empty for every branch.
 * @param signal - request cancellation.
 * @returns the automatic fork point and at most `maxBranches` remote-tracking and local branches each,
 * most recently committed first, without the branch the scope shows and, for a head, without the Session's
 * checked-out branch, which the automatic fork point compares with; a local branch that a worktree has checked
 * out names that worktree's directory.
 * @throws `forgePanel/not-a-checkout` outside a checkout; `forgePanel/head-missing` when the head does not exist; the
 * Git error when Git fails or the listed refs exceed `maxDiffBytes`.
 */
@Remote async diffBases(session: Session, head: string | null, query: string, signal: AbortSignal): Promise<ForgeBaseBranches>

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
 * @param sessionId - Session whose panel refreshes; refreshing neither loads nor resumes it.
 * @param signal - request cancellation.
 * @returns settles once the inspection and the sign-in probe have ended; poll results reach the panel stream later.
 */
@Remote async refresh(sessionId: SessionId, signal: AbortSignal): Promise<void>

/**
 * Bring a followed Session's panel up to date after its surface showed again: reinspect the checkout, poll the
 * change requests whose latest poll is older than `statusMaxAgeMs`, probe sign-in again unless the last probe found
 * the host ready, and look the upstream branch up again while the Session shows no change request; an unfollowed
 * Session is unchanged.
 * @param sessionId - Session whose panel is revisited; revisiting neither loads nor resumes it.
 * @param signal - request cancellation.
 * @returns settles once the inspection and the sign-in probe have ended; poll results reach the panel stream later.
 */
@Remote async revisit(sessionId: SessionId, signal: AbortSignal): Promise<void>

/**
 * Read the changes one scope covers in the checkout of the Session's current directory, or for the head branch the
 * scope names: in the worktree that has it checked out, else from its commits. Git uses the Session's sandbox policy.
 * @param session - Session whose checkout is read.
 * @param scope - which changes to read.
 * @param signal - request cancellation.
 * @returns the files, the base of the `branch` scope, the untracked files left out, and the worktree read for a head.
 * @throws `forgePanel/not-a-checkout` outside a checkout; `forgePanel/head-missing` when the head the scope names
 * does not exist; `forgePanel/no-working-tree` for another scope than `branch` whose head no worktree has checked
 * out; `forgePanel/base-missing` when the base branch
 * chosen for the `branch` scope does not exist; `forgePanel/no-fork-point` for the `branch` scope without
 * a fork point; `forgePanel/commits-missing` when chosen commits are not between the fork point and HEAD in order;
 * `forgePanel/commits-not-linear` when a chosen commit's first parent is not the commit listed before it;
 * `forgePanel/filter-config-failed` when filter configuration cannot be read completely, before
 * any comparison; `forgePanel/diff-too-large` over `maxDiffBytes`; the Git error when Git fails.
 */
@Remote async localDiff(session: Session, scope: ForgeLocalScope, signal: AbortSignal): Promise<ForgeLocalDiff>

/**
 * List the commits of the `branch` scope of the Session's current checkout or of a head branch read in its place,
 * which the changes view can show one or several of instead of the whole scope.
 * @param session - Session whose checkout is read.
 * @param head - full ref of the branch the scope reads in place of the checked-out one, or null for the checkout.
 * @param base - the base ref of the `branch` scope, or null for its automatic fork point.
 * @param signal - request cancellation.
 * @returns the newest `maxCommits` commits between the fork point and the shown HEAD or branch, oldest first, and its commit.
 * @throws `forgePanel/not-a-checkout` outside a checkout; `forgePanel/head-missing` when the head does not exist;
 * `forgePanel/base-missing` when the base branch does not exist; `forgePanel/no-fork-point` without a fork point;
 * the Git error when Git fails or the listing exceeds `maxDiffBytes`.
 */
@Remote async localCommits(session: Session, head: string | null, base: string | null, signal: AbortSignal): Promise<ForgeLocalCommits>

/**
 * Read the new side of one changed file in a scope, which supplies the
 * unchanged lines between its hunks: the index for `staged`, the last chosen commit for chosen commits of
 * the `branch` scope, the branch for a head read from its commits, else the working tree of the checkout the scope reads.
 * @param session - Session whose checkout is read.
 * @param scope - the scope the diff was read in.
 * @param path - path relative to the checkout's top-level directory, as the diff names it.
 * @param signal - request cancellation.
 * @returns the text.
 * @throws `forgePanel/not-a-checkout` outside a checkout; `forgePanel/head-missing` and `forgePanel/no-working-tree`
 * as for {@link ForgePanelController.localDiff}; `forgePanel/diff-too-large` over `maxDiffBytes`;
 * `forgePanel/commits-missing` for a chosen commit that is not a full object name; an error for a path outside
 * the checkout, binary content, or a failed read.
 */
@Remote async localText(session: Session, scope: ForgeLocalScope, path: string, signal: AbortSignal): Promise<string>

/**
 * Stage, unstage, or restore whole files in the checkout of the Session's current directory, or return index
 * entries to the tree an earlier write reported. The caller's press authorizes the write, so Git runs without the
 * Session's sandbox policy and under any access mode. The Session's panel inspects the checkout again afterwards,
 * whether or not the write succeeded.
 * @param session - Session whose checkout is written.
 * @param write - the write; `stage` and `restore` name each file with the digest of the change the reader saw.
 * @param signal - request cancellation.
 * @returns the index before a `stage` or `unstage` as a tree, for undoing it.
 * @throws `forgePanel/not-a-checkout` outside a checkout; `forgePanel/local-stale` before anything is written when a
 * file's unstaged change is not the one the reader saw; `forgePanel/local-path-replaced` before anything is written
 * when a deleted file's path holds a directory; the errors of {@link ForgePanelController.localDiff} for the
 * `unstaged` scope; an error for a path outside the checkout, a tree that is not a full object name, a restore of a
 * submodule or of a file without index content, or a Git failure.
 */
@Remote async localWrite(session: Session, write: ForgeLocalWrite, signal: AbortSignal): Promise<ForgeLocalWriteResult>

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
 * whole change request. Marks read at the same head are kept in memory and returned until they are `reviewRefreshMs`
 * old or `maxCachedReviewBytes` evicts them; a mark saved through `ctx.forge` at that head replaces the kept state
 * of its file, so the read after a save costs no request.
 * @param session - Session the change request is bound to.
 * @param url - binding URL of the change request.
 * @param headSha - head commit of the shown diff; marks read at another head are refused.
 * @param fresh - whether to read the host although kept marks could answer, as after a refresh.
 * @param signal - request cancellation.
 * @returns the marks at `headSha`, or null when the provider keeps no viewed marks.
 * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
 * `forgePanel/stale-head` when the head moved past `headSha`, which is then polled again; `forgePanel/viewed-failed`
 * when the host does not provide the marks otherwise.
 */
@Remote async changeRequestViewed( session: Session, url: string, headSha: string, fresh: boolean, signal: AbortSignal, ): Promise<ForgeViewedFiles | null>

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
 * Turn the code host's automatic merge of a change request of a Session on, while its head is still the request's
 * `headSha`, or off; the change request is polled again once the host answers.
 * @param session - Session the change request is bound to.
 * @param url - binding URL of the change request.
 * @param request - on with the merge method and the head commit the user confirmed, or off.
 * @param signal - request cancellation.
 * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
 * `forgePanel/stale-head` when the head moved past the request's `headSha`; `forgePanel/action-failed` with the
 * host's reason when the host refuses otherwise, cannot be reached, or sets no automatic merge;
 * `forgePanel/action-unknown` when the host's answer did not confirm the change.
 */
@Remote async setAutoMerge(session: Session, url: string, request: AutoMergeRequest, signal: AbortSignal): Promise<void>

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
 * the inbox, or else at the first step proposal, the panel creates the
 * branch `name`, or a generated branch per attempt when it is null, from
 * `from`, or from HEAD of the current checkout when it is null, and enters
 * its checkout; a remote-tracking `from` is fetched first. A message that
 * already waits after a failed or stopped attempt keeps waiting for
 * {@link ForgePanelController.retryWorktree}.
 * @param session - Session without a started turn.
 * @param from - full name of a local or remote-tracking base branch, or null for HEAD.
 * @param name - new branch name, or null to generate one per attempt.
 * @param signal - request cancellation.
 * @throws `forgePanel/invalid-branch` when `from` is empty; `forgePanel/invalid-name` when `name` breaks
 * a branch-name rule; `forgePanel/branch-exists` when the checkout has a local branch named `name`;
 * `forgePanel/not-a-checkout` when a name is checked outside a checkout; `forgePanel/worktrees-unavailable`
 * without a worktree service; `forgePanel/session-started` after a turn started or the worktree was
 * created; `forgePanel/session-busy` while the worktree is being created.
 */
@Remote async requestWorktree(session: Session, from: string | null, name: string | null, signal: AbortSignal): Promise<void>

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
 * Make another attempt, on the requested branch name or a new generated
 * one, at the worktree a message of the Session waits for after a failed or
 * stopped attempt.
 * @param session - Session whose message waits.
 * @param fetch - false skips fetching a remote-tracking base branch for this attempt, which then starts from the
 * commit last fetched.
 * @param signal - request cancellation.
 * @throws `forgePanel/not-waiting` when no message waits or an attempt is running.
 */
@Remote async retryWorktree(session: Session, fetch: boolean, signal: AbortSignal): Promise<void>

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

Types: [Session](session.zh.md) · [SessionId](core.zh.md) · [WorktreeCleanup](worktrees.zh.md)

Source: [`packages/experimental/client-ui-forge/src/index.ts`](../../packages/experimental/client-ui-forge/src/index.ts)

<a id="ctxforgesession--forgesessionservice"></a>

### `ctx.forgeSession` — `ForgeSessionService`

Session-scoped change request bindings. The `forgeChangeRequests` projection derives them from the results of the creation and reference commands that forge providers register through `registerCommands`, from `git push` results, including those of shell calls inside PTC programs, and from `plugin:forge-session/binding` records. After each push result, and when a caller reports the branch a Session works on, the service looks up open change requests whose head is that branch and records the unbound ones as discovered. Watching a Session polls its visible change requests through `ctx.forge`.

```ts cordis-catalog
/**
 * Register the commands of one forge CLI as an effect on the calling fiber.
 * A rule that changes the recognized rule set re-registers the
 * `forgeChangeRequests` projection at the new set's state version, so every
 * Session refolds its log with the new rules when next read, including
 * commands that ran before the registration, and watchers receive the
 * refolded bindings. Disposal does not change the recognized set: the rule
 * keeps recognizing commands until the service restarts or another rule
 * replaces its id or executable, so unloading a provider, including at
 * shutdown, leaves the checkpointed state version unchanged. Only live
 * registrations run reference lookups, so a disposed rule starts no CLI
 * process; lookups that started before a change finish with the rules they
 * started with.
 * @param rule - the CLI's executable, subcommands, change request page path, and selection.
 * @returns the disposer that ends the registration.
 * @throws when the rule is malformed, or a live registration has its id or executable.
 */
registerCommands(rule: ForgeCommandRule): () => void

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
 * for its snapshot through `ctx.forge` while the Session has a watcher. Listeners receive the
 * complete list after each later binding or provider change, or polling result; read the
 * current list with {@link changeRequests}. Listeners must not throw; a
 * thrown error is logged and skipped.
 * @param session - Session to watch.
 * @param listener - receives the complete visible list.
 * @param options - when the Session's first watcher needs a status newer than the latest one; a later watcher's
 * options change nothing.
 * @returns the disposer that stops this watch.
 */
watch(session: Session, listener: SessionChangeRequestsListener, options: ChangeRequestWatchOptions = {}): () => void
```

Types: [Session](session.zh.md)

Source: [`packages/experimental/forge-session/src/index.ts`](../../packages/experimental/forge-session/src/index.ts)

<a id="forge-events"></a>

### `forge/*` events

<a id="forgeproviders-changed--parallel"></a>

#### `forge/providers-changed` — parallel

Announces a provider registration, replacement, or withdrawal after the registry changes. Listener failures are logged without preventing other listeners from running.

```ts cordis-catalog
/**
 * Announces a provider registration, replacement, or withdrawal after the registry changes.
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
