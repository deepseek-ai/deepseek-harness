---
description: "Serve the experimental forge registry for GitHub hosts through the GitHub CLI on the host."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-forge-github

English | [中文](README.zh.md)

## Summary

Read GitHub and GitHub Enterprise pull requests for `ctx.forge` with the GitHub CLI that is already signed in on the host. Each poll batches pull requests by host to read state, changed lines, checks, review decision, mergeability, and unresolved review threads for every due pull request.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider after the forge registry and list every GitHub Enterprise host explicitly.

```yaml
- name: '@deepseek-ai/dsh-experimental-forge'
- name: '@deepseek-ai/dsh-experimental-forge-github'
  config:
    hosts: [github.com, ghe.example.com]
```

The provider runs `gh` as a host process, even when Sessions execute commands in another execution world. Sign in once per host with `gh auth login --hostname <host>`. The child receives the host environment without `DSH_*` variables and without variables whose names contain `KEY`, `PASSWORD`, `SECRET`, or `TOKEN`, so `GH_TOKEN` and `GITHUB_TOKEN` are not forwarded and `gh` uses its own credential store. Prompts, update notices, pagers, and colors are disabled. `maxOutputBytes`, `maxReviewThreads`, `maxCommits`, and `maxViewedFiles` must be positive safe integers; only `timeoutMs` is bounded by the runtime timer limit. `ghCommand`, `hosts`, `timeoutMs`, `maxOutputBytes`, `maxReviewThreads`, `maxCommits`, and `maxViewedFiles` are listed in the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-forge-github).

The provider serves a remote URL in `https`, `http`, `ssh`, or `git` form, or in scp form such as `git@github.com:owner/name.git`, when its host is configured. HTTP(S) remotes retain custom ports in the host identity; SSH and Git transport ports are excluded. It serves pull request URLs of the form `https://<host>/<owner>/<name>/pull/<number>` with any trailing path, query, or fragment, and builds that form without the suffix as the canonical URL. A readiness probe runs `gh auth status --hostname <host>`: exit status 0 is `ready`, another exit status is `unauthenticated` with the first diagnostic line, and a `gh` that cannot start is `unavailable`. A head lookup returns up to 20 open pull requests whose head is the branch, newest first, excluding pull requests from forks; a lookup of the default branch returns none.

Polling returns the first 100 head-commit check contexts without following pages. An incomplete preview sets `checksTruncated` and keeps GitHub’s aggregate state; its counts do not describe the full list. `fetchChecks(ref, signal)` reads complete details only for the requested PR, pinning continuation pages to the first response’s rollup. The combined UTF-8 JSON responses, review thread pages included, must fit `maxOutputBytes`; excess returns `too-large`. Failed or non-advancing pages fail only this detail read and leave polling results intact. Runs with the same application, workflow, event, and check name keep only the newest run id; a queued replacement supersedes an older completed run. Runs without a numeric database id are retained by node id because their relative age is unknown. Commit status contexts keep the newest result per context name. Complete lists derive their indicator from these results; unknown context kinds retain GitHub’s aggregate state.

Every status read counts review threads in pages of up to 100 until it has counted `maxReviewThreads` (default 1,000) of them; each page after the first is one more GraphQL query. A pull request with more threads sets `threadsTruncated`, and its `unresolvedThreads` counts only the threads read. A thread page that fails or does not advance fails that pull request's status read and leaves the other pull requests of the batch intact; a partial count is not published.

Unfinished check runs and completed runs with stale, missing, or unrecognized conclusions map to `pending`. Other completed checks map to `success`, `failure` (failure, timed out, startup failure, or action required), `cancelled`, `skipped`, or `neutral`. Cancelled checks keep the rollup non-passing. Check runs keep their start and completion times. Commit status contexts map `SUCCESS` to `success`, `FAILURE` and `ERROR` to `failure`, and every other state to `pending`, and carry no times. A GraphQL `NOT_FOUND` error becomes a `not-found` failure. A response without GraphQL data or errors, including an HTTP error JSON body, uses the first stderr diagnostic or the body's message. Authentication diagnostics become `unauthenticated`; oversized check pages become `too-large`; rate limits and other failures become `unavailable`. Head lookups preserve the same diagnostic in their rejection.

A pull request is `mergeReady` when it is open, not a draft, GitHub reports its merge state as `CLEAN`, `HAS_HOOKS`, or `UNSTABLE`, and the signed-in user has write, maintain, or admin permission. `mergeMethods` lists the squash, merge-commit, and rebase methods the repository allows, the user's default merge method first. Marking ready runs `gh pr ready <number> --repo <host>/<owner>/<name>`. Merging calls `PUT repos/<owner>/<name>/pulls/<number>/merge` through `gh api` with the method and the expected head SHA, so GitHub refuses once new commits arrived, which is reported as `stale`. Unlike `gh pr merge`, it never enables auto-merge, never joins a merge queue, and never deletes the head branch. A refused action reports GitHub's message, and a diagnostic that mentions authentication becomes `unauthenticated`.

`diff` reads `headRefOid` and `baseRefOid` in one GraphQL query and returns `stale` when the head is not the requested commit, which must be a full 40- or 64-digit hexadecimal commit. Otherwise it reads `repos/<owner>/<name>/compare/<baseRefOid>...<headSha>` through `gh api --allow-escape-sequences` with the diff media type, the patch from the merge base of both commits, so neither end follows a moving branch. Each status snapshot carries `baseRefOid` as `baseSha`, and leaves it out when GitHub reports no full commit there; given it, `diff` starts this comparison while the GraphQL query confirms the head, and a stale head or another base commit cancels the early comparison and waits for it to end before `diff` returns. For every open and merged pull request measured, this patch is byte-identical to `gh pr diff`, which takes no commit argument. Unlike the pull request diff, the compare endpoint returns diffs over 300 files, so only output over `maxOutputBytes` or GitHub's own refusal makes such a diff `too-large`. `--allow-escape-sequences` keeps terminal escape sequences that file contents hold, which `gh` 2.97 and newer otherwise refuse to print; an older `gh` rejects the option with `unknown flag` before sending a request and prints such sequences unchanged, so that rejection repeats the read without it. `fileText` reads `repos/<owner>/<name>/contents/<path>?ref=<commit>` through `gh api` with the raw media type and accepts only a full 40- or 64-digit hexadecimal commit. `fileUrl` returns `https://<host>/<owner>/<name>/blob/<commit>/<path>`. Both paths percent-encode each segment. `commits` reads a pull request's commits through GraphQL, 100 per page with the owner, name, number, and cursor as variables, until `maxCommits`; every page must report the head and commit count of the first one and a cursor no earlier page returned, else the listing is `unavailable`. `compare` reads the patch from the merge base of two full commits to the second through the same compare request as `diff`. A refused read becomes `not-found` for HTTP 404, `unauthenticated` for a diagnostic that mentions authentication, `too-large` for GitHub's HTTP 406 refusal or `too_large` error, which a diff or file over its size limit draws, and `unavailable` otherwise, with GitHub's message. A read whose output exceeds `maxOutputBytes` becomes `too-large`, and one that outlives `timeoutMs` becomes `unavailable`.

Review submission checks the current pull request head, then posts a single inline comment or one completed review through the REST API with an explicit `commit_id`. Multiline comments carry their side and inclusive start and end lines. Review decisions are Comment, Approve, and Request changes. JSON request bodies travel on stdin. The provider never retries a mutation: a timeout, unexpected response, or server error after dispatch returns an unknown outcome that the caller must reconcile on GitHub. A commit arriving between the check and the write can make the explicitly addressed review outdated; GitHub does not offer an atomic head precondition on these endpoints.

`readReview` reads review threads with one GraphQL query that names `headRefOid` and the signed-in viewer's login, and returns `stale` when the head is not the requested commit. It reads threads in pages of up to 100 until it has read `maxReviewThreads` of them, each thread page after the first naming the head again, so a push during the read returns `stale`; it reads every comment of each thread through comment pages, which do not name the head, and the commits and `diffHunk` of a thread's first comment once. All pages together, measured as JSON, must fit `maxOutputBytes`: a later page that would pass it is dropped with the threads after it, and the result is marked `truncated`, as when more than `maxReviewThreads` threads exist; a first page whose output alone passes it fails the read as `too-large`. A thread on lines gets a `current` position only when GitHub reports it not outdated, with a `line`, and its first comment's `commit` is the head: a comment written on an earlier commit after a force-push keeps a `line` that numbers that commit, and GitHub can mark a thread outdated while keeping its `line`. `original` comes from `originalLine` and `originalStartLine` at the first comment's `originalCommit`; `subjectType: FILE` threads have neither. A range whose start is on the other side of the diff keeps its last line. Threads without comments are left out. A pull request or repository GitHub does not have makes the read `not-found`, as it does the commit listing. REST's `position` does not tell outdated threads apart and is not read.

The same first page reads what the signed-in viewer may write: each thread's `viewerCanReply` and, for its current state, `viewerCanResolve` or `viewerCanUnresolve`, and each comment's `viewerCanUpdate` and `viewerCanDelete`. It also reads the viewer's pending review, the `PENDING` review the viewer authored, with its comment count; GitHub lists a pending review only to its author, and the read takes up to 100 so the viewer's is found even if another were listed first. The viewer may start a pending review unless the repository is archived or the conversation is locked without `ADMIN`, `MAINTAIN`, or `WRITE` permission.

`writeReview` first reads the pull request's `headRefOid` and the viewer's pending review in one GraphQL query and returns `stale` without writing when the head is not `write.headSha`. It then sends one mutation with its variables as JSON on stdin: `addPullRequestReviewThreadReply`, inside the pending review for a pending reply; `resolveReviewThread` or `unresolveReviewThread`; `updatePullRequestReviewComment` or `deletePullRequestReviewComment`; `addPullRequestReviewThread` into the pending review, or `addPullRequestReview` at `write.headSha` with the comment as its first thread when the viewer has none; and `submitPullRequestReview` or `deletePullRequestReview` for the pending review the write names, which the check must still find. A pending reply without a pending review first starts an empty one at the head, so it takes two mutations; when the reply then fails, the empty review stays. A write to a thread or comment also reads, in the same check, the pull request that holds it, and returns `failed` without a mutation when that is another pull request. GitHub adds every reply of a user with a pending review to that review, even one sent without its id, so a reply at once returns `failed` without a mutation while the viewer has one; a thread added to a pending review numbers the lines of the current head, whichever commit the review started at. A mutation's payload means GitHub applied it; GraphQL errors whose types all name a refusal (`FORBIDDEN`, `INSUFFICIENT_SCOPES`, `NOT_FOUND`, `RATE_LIMITED`, `UNPROCESSABLE`) and HTTP 400, 401, 403, 404, 409, and 422 refusals return `failed`, as does a `gh` that cannot start; any other GraphQL error, such as GitHub's timeout message, a `gh` timeout, a server error, or an answer without the payload returns `unknown`. No mutation is retried.

Every status read also reads the overview of each pull request: up to 25 review requests, latest reviews, latest opinionated reviews, and closing issue references, each list marked truncated when GitHub counts more. A review request names a user, bot, or team, and whether it is a code owner request. Reviews of the author and reviews without an author are left out; a dismissed review counts as `dismissed`, and a later opinionated review decides the verdict over a comment. `branchUpdates` is empty for a pull request that is not open, that GitHub reports as conflicting, or whose head the signed-in user may not update, as GitHub's `viewerCanUpdateBranch` is false both for a head that is up to date and for a user without the right to update it; otherwise it offers merge, and rebase as well when GitHub's `canBeRebased` is true. `canBeRebased` reports whether the pull request can be rebase merged, so it follows the repository's rebase merge setting, and a repository without rebase merges is offered merge only. `mergeStateStatus` does not tell a head behind its base, since BLOCKED, DIRTY, and UNSTABLE take precedence over BEHIND: of 23 open pull requests of this repository whose head was behind its base, none reported BEHIND. `canRequestReviews` requires triage, write, maintain, or admin permission on an open pull request, and `canRerunChecks` requires write, maintain, or admin permission. A check run of a GitHub Actions workflow names its workflow run as `rerun`; status contexts and other check runs name none.

`viewedFiles` lists the pull request's files through GraphQL, 100 per page, up to `maxViewedFiles` (default 3,000) files, and sets `truncated` when GitHub counts more; GitHub's `VIEWED`, `UNVIEWED`, and `DISMISSED` map to `viewed`, `unviewed`, and `dismissed`, and an unknown state to `unviewed`. A page whose head is not the requested commit makes the read `stale`, and a page that does not advance makes it `unavailable`. `setViewed` checks the head, then calls `markFileAsViewed` or `unmarkFileAsViewed`; GitHub keeps one viewed mark per file and user, whatever the commit. `rerunChecks` reads the complete checks, returns `stale` when the head moved, and posts `repos/<owner>/<name>/actions/runs/<run>/rerun-failed-jobs` once for each workflow run with a failed check and no pending one, as GitHub offers no rerun of a run in progress; it tries every such run, reports the refused ones together, and stops early only for missing credentials. GitHub reruns the failed jobs with the jobs that depend on them. `requestReviews` resolves user logins and `organization/slug` team names to node ids in one GraphQL query and calls `requestReviews` with `union: true`, so existing requests stay; bot logins, given the `[bot]` suffix, go to `requestReviewsByLogin` afterwards, which GitHub Enterprise Server 3.19 and 3.20 lack. `reviewerCandidates` lists up to 20 assignable users whose login or name contains the query, and with an empty query GitHub's suggested reviewers first; the author is left out. `updateBranch` checks the head, then calls `updatePullRequestBranch` with the update method and `expectedHeadOid`, so GitHub refuses once new commits arrived. These mutations go through the sender `writeReview` uses, with their GraphQL document and variables as JSON on stdin, and are never retried: a refusal becomes `failed` and an answer that does not confirm the outcome becomes `unknown`, each with GitHub's message.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

A fetch groups references by host and sends one initial `gh api graphql` query per host. Continuation queries use the original rollup node id, so a changed pull request head cannot mix commits within one check list. The query inlines validated owner, name, and number values and gives each pull request an alias, so partial GraphQL errors fail only their own aliases. `gh` exits nonzero on partial errors but still prints the complete response, which the provider parses before it inspects the exit code.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Configuration validation and provider registration |
| [`src/provider.ts`](src/provider.ts) | URL mapping, host grouping, and failure classification |
| [`src/graphql.ts`](src/graphql.ts) | Query construction and response validation and mapping |
| [`src/compare.ts`](src/compare.ts) | Patch between two commits through the compare API, shared by every diff read |
| [`src/threads.ts`](src/threads.ts) | Review thread read, pagination, and mapping onto head and original positions |
| [`src/review-writes.ts`](src/review-writes.ts) | Head check and review thread and pending review mutations |
| [`src/mutation.ts`](src/mutation.ts) | Sending one GraphQL mutation and classifying its outcome |
| [`src/gh.ts`](src/gh.ts) | Host `gh` execution with environment scrubbing and limits |
| [`src/viewed.ts`](src/viewed.ts) | Viewed file reads and writes |
| [`src/overview.ts`](src/overview.ts) | Review requests, reviewer search, and branch updates |
| [`src/pull-request-node.ts`](src/pull-request-node.ts) | Pull request node id at a checked head, for mutations |
| [`src/urls.ts`](src/urls.ts) | Remote URL and pull request URL parsing, and validation of inlined names and commits |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Forge registry](../forge/README.md) — provider registration and shared polling.
- [Forge subsystem](../../../docs/subsystems/forge.md) — provider contract and change request types.
- [Subprocess environment](../../subprocess/subprocess/README.md) — the shared environment scrub.

-----

<a id="model-experience"></a>
## Model Experience

None, as the provider reads pull request status for host-side watchers without contributing model context.

#### KV Cache effect

None. Provider output reaches only host-side watchers.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **GitHub CLI on the host** — `gh` must be installed and signed in for each configured host; tokens in environment variables are not forwarded. Hosts missing from `hosts` are never read, including references retained across configuration changes. A status fetch returns `unavailable` for those references; a head lookup rejects before starting `gh`.
- **Review thread bound** — a status read counts, and a review read reads, at most `maxReviewThreads` review threads per pull request; beyond it `unresolvedThreads` is a lower bound that `threadsTruncated` marks, and a review read is `truncated`.
- **Batch deadline** — continuation pages of a pull request with many review threads lengthen its host's polling batch; a batch that outlives `ctx.forge`'s `fetchTimeoutMs` reports `unavailable` for every pull request in it, not only for the one with many threads.
- **Rewritten base branch** — the diff starts from the merge base of the head and the base commit GitHub recorded at the pull request's last update. After the base branch is force-pushed, that merge base can differ from the one GitHub's pull request view uses, so the patch can include or omit commits until the pull request is updated.
- **No fork discovery** — head lookups exclude pull requests whose head is in another repository.
- **Rate limits** — every poll costs one GraphQL query per host, plus one query per further page of 100 review threads, and a complete check read one more query per further page of 100 check records; every diff read costs one GraphQL query and one REST request, and a second REST request when the base commit changed after the latest status. All count against the signed-in account’s rate limit. A review read costs one GraphQL query per page of 100 threads and one more per further page of 100 comments in a thread. A review write costs one GraphQL query for the head check and one mutation, or two for a pending reply that starts the pending review.
- **No merge queue** — a base branch that requires a merge queue refuses a direct merge, and the provider never queues one.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
