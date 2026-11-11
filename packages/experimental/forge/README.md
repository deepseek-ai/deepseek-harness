---
description: "Register code host providers and poll change request status through one provider-neutral service."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-forge

English | [中文](README.zh.md)

## Summary

Read and act on pull requests and merge requests without coupling consumers to one code host. A provider maps remote and change request URLs to provider-neutral references, finds change requests by head branch, reads their status in batches, reads their diffs and files, reads and writes their review threads, and marks drafts ready or merges on request. Watchers of one change request share a single polling loop whose cadence follows check, mergeability, and lifecycle state.

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

Mount the registry with at least one provider package, such as the GitHub provider.

```yaml
- name: '@deepseek-ai/dsh-experimental-forge'
- name: '@deepseek-ai/dsh-experimental-forge-github'
```

`ctx.forge.register(provider)` is an effect on the calling fiber and returns an async disposer that cancels and drains that registration's calls. Results arriving after cancellation are discarded. One provider serves one forge family; registering a second provider for the same family throws. Registration changes announce `forge/providers-changed`; registering a provider polls its existing watches immediately. `repositoryFromRemote(url)` and `changeRequestFromUrl(url)` ask providers in registration order and return the first match. `changeRequestUrl(ref)`, `findByHead(repository, branch, signal)`, and `readiness(repository, signal)` delegate to the provider of the reference's forge and throw when none is registered; `readiness` reports whether the provider can reach the host with current credentials.

`markReady(ref, signal)` marks a draft ready for review, and `merge(ref, { method, headSha }, signal)` merges a change request only while its head is still `headSha`. Both delegate to the provider of the reference's forge, throw when none is registered, and resolve to undefined once the host accepted the change or to a `ForgeActionFailure`: `unauthenticated`, `stale` when the head moved past `headSha`, `failed` with the host's reason, or `unknown` when the host's answer did not confirm the outcome, so the change may have been applied and must be checked on the host before it is tried again. After either settles, a watched change request is polled at once. Snapshots carry `mergeReady`, whether the host would merge the change request now for the signed-in user, and `mergeMethods`, the methods the repository accepts with that user's usual one first.

`diff(ref, headSha, signal)` reads the change request's unified patch at head commit `headSha` as the host computes it, with `a/` and `b/` path prefixes, and `fileText(ref, commit, path, signal)` reads one file of its repository at a commit. Both delegate to the provider of the reference's forge, throw when none is registered, and resolve to the text or to a `ForgeFailure`, which is `too-large` when the host or the provider refuses an answer over its size limit. A provider returns a patch only when it describes `headSha`; once the head is another commit, `diff` resolves to `stale`. The first stale read at a head commit polls a watched change request at once so its next status names the current head; later stale reads at that commit wait for the regular poll, which bounds reads while the host's answers briefly disagree. When the latest status of a watched change request names `headSha` and carries `baseSha`, the base commit the host recorded with that head, `diff` passes it to the provider, which may start reading from it before it confirms the head. Snapshots carry `unresolvedThreads` with `threadsTruncated`, which marks the count as a lower bound when the provider counted only some review threads. `fileUrl(ref, commit, path)` returns the web page of that file at that commit.

Providers may implement `commits` and `compare` together. `commits(ref, signal)` lists a change request's commits oldest first, each with its full object name, first parent, title, author, and author time, at one head commit and with a `truncated` flag; `compare(ref, base, head, signal)` reads the unified patch from commit `base` to commit `head`. The registry returns undefined from `commits` and an `unavailable` failure from `compare` when the provider lacks either method, so a consumer can offer commit views only where both exist.

Providers may implement `viewedFiles` and `setViewed` together. `viewedFiles(ref, headSha, signal)` reads the signed-in user's viewed marks on the files of a change request at head commit `headSha`, each `viewed`, `unviewed`, or `dismissed` when the file changed after it was marked, with a `truncated` flag; `setViewed(ref, { path, viewed, headSha }, signal)` sets or clears one file's mark only while the head is still `headSha`. Both report a moved head as `stale`, which polls a watched change request as a stale `diff` does. When the provider lacks either method, `viewedFiles` returns undefined and `setViewed` a `failed` failure, so a consumer keeps viewed marks itself.

Providers may implement `mergeBase(ref, base, head, signal)`, which names the commit whose files the old side of a change request's diff shows; `ctx.forge.mergeBase` returns `unsupported` without it. After a review write, a submitted review, or a viewed mark the host accepted, the registry announces `forge/review-changed` with the change request and the change, whichever plugin made it; an outcome that is unknown, refused, stale, or unsupported is not announced. The [extension API](../../../docs/subsystems/forge.md#extension-api) lists what other plugins may rely on.

Snapshots carry the overview of a change request. `reviewers` lists requested reviewers first, then the latest reviewer of each account with their verdict and the commit it was given at; `closingIssues` lists the issues the host closes when the change request merges; `reviewersTruncated` and `closingIssuesTruncated` mark lists the provider read only in part. `branchUpdates` names the methods that would bring a head behind its base up to date for the signed-in user, empty when the head is current, conflicts, or may not be updated, so a consumer cannot tell a user without that right that the head is behind. `canRequestReviews` and `canRerunChecks` state the signed-in user's rights, and each check's `rerun` names the host run that reruns it, or null; checks that name one run rerun together once none of them is pending.

Providers may implement `rerunChecks(ref, { headSha }, signal)`, which reruns the failed checks of head commit `headSha` whose run has no pending check; `requestReviews(ref, { reviewers }, signal)` together with `reviewerCandidates(ref, query, signal)`, which lists accounts a review can be requested from with the host's suggestions first; and `updateBranch(ref, { method, headSha }, signal)`, which merges or rebases the base into the head only while the head is still `headSha`. Each action resolves to undefined once the host accepted it or to a `ForgeActionFailure`, and polls a watched change request once it settles. The registry fails an action the provider lacks with `failed`, without polling, and returns `unsupported` from `reviewerCandidates` unless the provider implements both review request methods.

`fetchChecks(ref, signal)` reads one change request’s complete checks on demand. It has its own `fetchTimeoutMs` deadline and does not occupy the polling batch or publish to its watchers. Failure leaves previously polled snapshots intact. A provider without `fetchChecks` returns `unavailable`. Caller cancellation and provider or service disposal abort the read; disposal waits for it to settle.

`ctx.forge.watch(ref, listener)` is also an effect. The first watcher of a change request polls it at once; `latest(ref)` returns the most recent result. Each forge has at most one polling fetch in flight, and that fetch includes every due change request of the forge. An open change request is polled every `activeIntervalMs` while checks are pending or mergeability is unknown, and every `idleIntervalMs` otherwise. Closed change requests use `idleIntervalMs` to detect reopening; merged requests stop automatic polling. `refresh(ref)` polls a watched change request at once, including after a terminal state; if a fetch is already in flight for its forge, another fetch starts immediately after it settles. A failed read repeats after `activeIntervalMs` doubled for each consecutive failure, up to `maxBackoffMs`, which must be at least `activeIntervalMs`. Unregistering a provider settles its watched change requests as `unavailable`. Polling stops when the last watcher leaves. The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-forge) lists the defaults.

Reaching `fetchTimeoutMs` aborts the fetch signal with `FORGE_FETCH_TIMEOUT`. Providers must stop their work and settle when the signal aborts; rejected fetches become `unavailable` failures. A provider that ignores cancellation can stall polling and service disposal.

Providers may implement `submitReview` to publish a line comment or a completed review at an explicit head commit. The registry returns unsupported when that capability is absent and refreshes watched status after a submission. Successful writes return their web URL; failures distinguish changed heads, refusals, and unknown outcomes. Callers must reconcile unknown outcomes before another submission. Comments a user keeps for a later review go to the code host's pending review through `writeReview`, not to the polling registry.

Providers may implement `readReview` to read a change request's review threads at one head commit. `readReview(ref, headSha, signal)` returns `ForgeReviewData`, the threads with each line thread's position at the head and at the commit it was written on, only when the read names `headSha` as the head; otherwise `stale`, which polls a watched change request at once, once per head commit shared with stale diff reads. The registry returns an `unsupported` failure when the provider lacks the method.

Providers may implement `writeReview` to change a change request's review threads and the signed-in user's pending review. `writeReview(ref, write, signal)` takes one `ForgeReviewWrite`: a reply, published at once or with `pending` inside the pending review; resolving or unresolving a thread; editing or deleting a comment; adding a line comment at the head to the pending review; or submitting or discarding the pending review. A pending reply or comment starts a pending review when the user has none. The provider writes only while the head is still `write.headSha`; otherwise it returns `stale`, which polls a watched change request as a stale read does, and after any other result the registry polls a watched change request at once. A write is never retried, and an `unknown` result must be checked on the host before the write is tried again. The registry returns `unsupported` when the provider lacks the method. `ForgeReviewData` names the user's pending review and whether the user may reply to and resolve each thread, edit and delete each comment, and add to, submit, and discard a pending review; a provider without `writeReview` reports none of these permissions.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One timer covers all watched change requests. When it fires, the service groups due change requests by forge and starts one batched provider fetch per idle forge. A listener that throws is logged and skipped. Disposing the service aborts in-flight fetches and waits for them to settle.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Provider registration, URL mapping, watch lifetime, and batched polling |
| [`src/schedule.ts`](src/schedule.ts) | Delay before the next poll of one change request |
| [`src/keys.ts`](src/keys.ts) | Case-insensitive canonical identity of a change request |
| [`src/types.ts`](src/types.ts) | Repository, change request, status, and provider types |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Forge subsystem](../../../docs/subsystems/forge.md) — provider contract, change request types, and service reference.
- [GitHub provider](../forge-github/README.md) — the provider for GitHub hosts.
- [Session bindings](../forge-session/README.md) — the consumer that binds change requests to Sessions.
- [Binding decision](../../../.agents/notes/implemented/feature/2026-10-09-session-change-request-bindings.md) — why bindings derive from shell results and status stays on the host.

-----

<a id="model-experience"></a>
## Model Experience

None, as providers and watchers exchange code host status without contributing model context.

#### KV Cache effect

None. No model request contains data from this package.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Polling only** — status reaches watchers on the next scheduled poll or `refresh`; there is no webhook intake.
- **Process-local results** — latest results live in memory and are lost on restart; the next watcher polls again.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
