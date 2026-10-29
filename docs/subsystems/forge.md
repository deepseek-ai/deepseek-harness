# Forges

English | [中文](forge.zh.md)

The experimental forge capability seam reads change requests, meaning pull requests and merge requests, from code hosts. [`dsh-experimental-forge`](../../packages/experimental/forge/README.md) is the Service Definition and provides `ctx.forge`; [`dsh-experimental-forge-github`](../../packages/experimental/forge-github/README.md) is the Service Provider for GitHub hosts; [`dsh-experimental-forge-session`](../../packages/experimental/forge-session/README.md) is the Consumer that binds change requests to Sessions and provides `ctx.forgeSession`; [`dsh-experimental-client-ui-forge`](../../packages/experimental/client-ui-forge/README.md) is the GUI Consumer that provides `ctx.forgePanel`. The default-disabled [forge bundle](../../packages/experimental/forge-bundle/README.md) composes all four, with an isolated [worktree service](../../packages/experimental/worktree/README.md) for the panel, from the Plugins page; otherwise they load only through explicit composition.

## Providers and change requests

A provider serves one forge family, such as `github`. It maps Git remote URLs to repositories and change request URLs to references, builds canonical change request URLs, finds open change requests by head branch, and reads status in batches. `changeRequestKey` derives one case-insensitive key from a reference, so watchers of differently spelled URLs share one polling loop.

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
  /** Read the changes of a change request as the host computes them, as one unified patch with `a/` and `b/` path prefixes. */
  diff(ref: ChangeRequestRef, signal: AbortSignal): Promise<string | ForgeFailure>
  /** Read the text of `path` at `commit` in the change request's repository. */
  fileText(ref: ChangeRequestRef, commit: string, path: string, signal: AbortSignal): Promise<string | ForgeFailure>
  /** Build the web page of `path` at `commit` in the change request's repository. */
  fileUrl(ref: ChangeRequestRef, commit: string, path: string): string
}
```

```ts type-equiv
/** Whether a provider can reach one host with the current credentials. */
interface ForgeReadiness {
  /** `ready`, `unauthenticated` (sign-in needed), or `unavailable` (tool missing or host unreachable). */
  readonly state: 'ready' | 'unauthenticated' | 'unavailable'
  /** Human-readable detail, or null when ready. */
  readonly message: string | null
}
```

## Status polling

`ctx.forge.watch` shares one polling loop among the watchers of a change request and delivers every result as an update. Each forge has at most one fetch in flight. The [registry README](../../packages/experimental/forge/README.md#use-this-package) owns the poll cadence, backoff, and timeout rules.

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
  /** Aggregate review outcome. */
  readonly reviewDecision: ReviewDecision
  /** Checks on the head commit in host order. */
  readonly checks: readonly ChangeRequestCheck[]
  /** Combined check outcome. */
  readonly checksRollup: ChecksRollup
  /** Whether the host reported more checks than `checks` contains. */
  readonly checksTruncated: boolean
  /** Number of review threads that are not resolved. */
  readonly unresolvedThreads: number
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
   * the same way; `unavailable`: any other failure.
   */
  readonly code: 'not-found' | 'unauthenticated' | 'too-large' | 'unavailable'
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

## Change request actions

`ctx.forge.markReady` marks a draft ready for review, and `ctx.forge.merge` merges a change request only while its head is still the commit the user confirmed. Both resolve to a `ForgeActionFailure` instead of throwing when the host refuses, and poll a watched change request at once afterwards. A snapshot's `mergeReady` and `mergeMethods` tell a consumer when to offer a merge and with which methods; the [GitHub provider README](../../packages/experimental/forge-github/README.md#use-this-package) owns how GitHub answers both.

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
/** Why a provider could not change a change request. */
interface ForgeActionFailure {
  /**
   * `unauthenticated`: credentials are missing or rejected; `stale`: the head
   * moved past the confirmed commit; `failed`: the host refused or could not be reached.
   */
  readonly code: 'unauthenticated' | 'stale' | 'failed'
  /** Human-readable cause, usually the host's own message. */
  readonly message: string
}
```

`ctx.forge.submitReview` delegates an explicit comment or completed review to the provider. A provider that omits this capability returns unsupported. Consumers retain pending drafts and reconcile unknown write outcomes before resubmitting.

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
  | { readonly kind: 'review'; readonly event: 'comment' | 'approve' | 'request-changes'; readonly body: string; readonly comments: readonly ForgeLineComment[] }
)
```

```ts type-equiv
/** Result of a review write; unknown outcomes must be checked on the host before another submission. */
type ForgeReviewResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly code: 'unsupported' | 'stale' | 'failed' | 'unknown'; readonly message: string }
```

## Session bindings

`ctx.forgeSession` derives each Session's bindings from its own log: `gh pr create` results bind the URLs they print, `gh pr view`, `gh pr edit`, and `gh pr checkout` calls bind the change request they act on, and `git push` results trigger head-branch discovery through `ctx.forge`; the panel also reports the branch its checkout tracks for the same discovery. Track, dismiss, and discovery actions are `plugin:forge-session/binding` records, which stay outside the model-visible conversation. The `forgeChangeRequests` projection's client view, which the Session summary carries, lists the bindings without their status. The [Session binding README](../../packages/experimental/forge-session/README.md#use-this-package) owns the recognition and discovery rules.

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

## Panel

`ctx.forgePanel` is the Host Remote of the [forge panel](../../packages/experimental/client-ui-forge/README.md#use-this-package). Following a Session streams a `ForgePanelState`: a read-only Git inspection of the Session's current directory in its execution world, the code host recognized from the upstream remote or `origin`, the sign-in state of that host, the Session's bindings with their polled status and last snapshot, and its worktree request. Its actions list base branches, bind and hide URLs, refresh, mark a bound draft ready or merge a bound change request, request or withdraw a worktree, stop a running creation, and restore a removed worktree or leave it for the source checkout. A request is a `plugin:client-ui-forge/worktree` record. When a message enters a Session's inbox while its Agent is idle, the panel holds the message's turn with maintenance of the [Agent](../../packages/core/agent/README.md), started before the delivery wakes the Agent: it creates the worktree of an open request through `ctx.worktrees` and, after a failed or stopped attempt, waits for another attempt or the request's withdrawal; for a Session that works in its created worktree it checks that worktree and, when it is gone, waits until it is restored or left. The panel state names what a message waits for and the last failed attempt. The first step proposal creates the worktree for a message no hold took. Requests after the first turn starts are ignored. Changes to a Session's checkout run as maintenance of its Agent, so a message from another client waits for them.

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

The Session list reads through the same Remote. `changeRequestStates` streams `ForgeChangeRequestStatesFrame` values: a `baseline` with the last known `ForgeChangeRequestListState` of every change request that a listed Session the caller may read binds, then the states that change. One Host run serves every stream; it takes the bindings of loaded Sessions from `ctx.forgeSession` and those of other Sessions from their cached Session summary without loading them, keeps each bound change request subscribed, including closed requests polled at the idle cadence to detect reopening, and stores every change, so a restart shows the last known states before the next poll. The Session summary also carries the `forgeWorktree` projection's client view: the created worktree while the Session's directory is that worktree or lies below it, else null.

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

The changes view reads through the same Remote. `localDiff` reads one `ForgeLocalScope` of the Session's checkout, and `changeRequestDiff` reads a bound change request at the head of its latest status through the provider's `diff`; both return files that the Host parsed into `ForgeDiffFile` hunks. `localText` and `changeRequestText` read the new side of one file, which supplies the unchanged lines between hunks. Each inspection also sizes the `branch` scope as `ForgePanelState.local` for the panel's local changes card.

```ts type-equiv
/** Which local changes a diff covers; each reads the Session's checkout through Git. */
type ForgeLocalScope =
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
/** Changes of a change request as its code host computes them. */
interface ForgeChangeRequestDiff {
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

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
 * Read complete check details independently of periodic polling.
 * @param ref - change request served by a registered provider.
 * @param signal - cancellation of the detail view.
 * @returns a complete snapshot or the provider's failure; unsupported providers return unavailable.
 * @throws on cancellation, provider disposal, or expiry of this read's own `fetchTimeoutMs` deadline.
 */
async fetchChecks(ref: ChangeRequestRef, signal: AbortSignal): Promise<ChangeRequestSnapshot | ForgeFailure>

/**
 * Read the changes of a change request as its host computes them.
 * @param ref - change request served by a registered provider.
 * @param signal - cancellation of the read.
 * @returns one unified patch with `a/` and `b/` path prefixes, or why the host did not provide it.
 * @throws when no provider serves the change request's forge, or with `signal.reason` when it aborts.
 */
async diff(ref: ChangeRequestRef, signal: AbortSignal): Promise<string | ForgeFailure>

/**
 * Publish one comment or a completed review, then refresh the watched status.
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
 * List the local branches that can start a worktree of the Session's current checkout.
 * @param session - Session whose current directory is listed.
 * @param signal - request cancellation.
 * @returns the checked-out branch and at most `maxBranches` local branches, the checked-out one first.
 * @throws when the current directory is not inside a checkout or Git fails.
 */
@Remote async branches(session: Session, signal: AbortSignal): Promise<ForgeBranches>

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
 * @throws `forgePanel/not-a-checkout` outside a checkout; `forgePanel/no-fork-point` for the `branch`
 * scope of a checkout without one; `forgePanel/filter-config-failed` when filter configuration cannot be read
 * completely, before any comparison; `forgePanel/diff-too-large` over `maxDiffBytes`; the Git error when Git fails.
 */
@Remote async localDiff(session: Session, scope: ForgeLocalScope, signal: AbortSignal): Promise<ForgeLocalDiff>

/**
 * Read the new side of one changed file in a scope, which supplies the
 * unchanged lines between its hunks: the index for `staged`, else the working tree.
 * @param session - Session whose checkout is read.
 * @param scope - the scope the diff was read in.
 * @param path - path relative to the checkout's top-level directory, as the diff names it.
 * @param signal - request cancellation.
 * @returns the text.
 * @throws `forgePanel/not-a-checkout` outside a checkout; `forgePanel/diff-too-large` over `maxDiffBytes`;
 * an error for a path outside the checkout, binary content, or a failed read.
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
 * Read the changes of a change request of a Session as its code host
 * computes them, at the head commit of its latest status. A patch already
 * read at the same head commit and base branch is reused from memory, for
 * any Session, until `maxCachedDiffBytes` evicts it.
 * @param session - Session the change request is bound to.
 * @param url - binding URL of the change request.
 * @param signal - request cancellation.
 * @returns the files, the head commit, each file's web page, and the commits the checkout has beyond the head.
 * @throws `forgePanel/not-bound` unless the URL is a visible binding of the Session that a provider serves;
 * `forgePanel/diff-too-large` when the host or its provider refuses the diff over a size limit;
 * `forgePanel/diff-failed` before its status was read and when the host does not provide the diff otherwise.
 */
@Remote async changeRequestDiff(session: Session, url: string, signal: AbortSignal): Promise<ForgeChangeRequestDiff>

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
 * Publish a line comment or completed review for a visible Session binding.
 * @param session - Session retaining the change request.
 * @param url - visible binding URL.
 * @param request - reviewed head, ranges, plain text, and explicit review decision.
 * @param signal - request cancellation.
 * @returns confirmed publication or a typed failure; unknown outcomes require reconciliation on the host.
 */
@Remote async submitReview(session: Session, url: string, request: ForgeReviewRequest, signal: AbortSignal): Promise<ForgeReviewResult>

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

Types: [Session](session.md)

Source: [`packages/experimental/client-ui-forge/src/index.ts`](../../packages/experimental/client-ui-forge/src/index.ts)

<a id="ctxforgesession--forgesessionservice"></a>

### `ctx.forgeSession` — `ForgeSessionService`

Session-scoped change request bindings. The `forgeChangeRequests` projection derives them from `gh pr create`, `gh pr view`, `gh pr edit`, `gh pr checkout`, and `git push` results and from `plugin:forge-session/binding` records. After each push result, and when a caller reports the branch a Session works on, the service looks up open change requests whose head is that branch and records the unbound ones as discovered. Watching a Session polls its visible change requests through `ctx.forge`.

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

Types: [Session](session.md)

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
<!-- END GENERATED cordis-surface -->
