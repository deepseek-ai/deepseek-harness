---
description: "Register code host providers and poll change request status through one provider-neutral service."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-forge

English | [中文](README.zh.md)

## Summary

Read and act on pull requests and merge requests without coupling consumers to one code host. A provider maps remote and change request URLs to provider-neutral references, finds change requests by head branch, reads their status in batches, reads their diffs and files, and marks drafts ready or merges on request. Watchers of one change request share a single polling loop whose cadence follows check, mergeability, and lifecycle state.

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

`markReady(ref, signal)` marks a draft ready for review, and `merge(ref, { method, headSha }, signal)` merges a change request only while its head is still `headSha`. Both delegate to the provider of the reference's forge, throw when none is registered, and resolve to undefined once the host accepted the change or to a `ForgeActionFailure`: `unauthenticated`, `stale` when the head moved past `headSha`, or `failed` with the host's reason. After either settles, a watched change request is polled at once. Snapshots carry `mergeReady`, whether the host would merge the change request now for the signed-in user, and `mergeMethods`, the methods the repository accepts with that user's usual one first.

`diff(ref, signal)` reads the change request's unified patch as the host computes it, with `a/` and `b/` path prefixes, and `fileText(ref, commit, path, signal)` reads one file of its repository at a commit. Both delegate to the provider of the reference's forge, throw when none is registered, and resolve to the text or to a `ForgeFailure`, which is `too-large` when the host or the provider refuses an answer over its size limit. `fileUrl(ref, commit, path)` returns the web page of that file at that commit.

`fetchChecks(ref, signal)` reads one change request’s complete checks on demand. It has its own `fetchTimeoutMs` deadline and does not occupy the polling batch or publish to its watchers. Failure leaves previously polled snapshots intact. A provider without `fetchChecks` returns `unavailable`. Caller cancellation and provider or service disposal abort the read; disposal waits for it to settle.

`ctx.forge.watch(ref, listener)` is also an effect. The first watcher of a change request polls it at once; `latest(ref)` returns the most recent result. Each forge has at most one polling fetch in flight, and that fetch includes every due change request of the forge. An open change request is polled every `activeIntervalMs` while checks are pending or mergeability is unknown, and every `idleIntervalMs` otherwise. Closed change requests use `idleIntervalMs` to detect reopening; merged requests stop automatic polling. `refresh(ref)` polls a watched change request at once, including after a terminal state; if a fetch is already in flight for its forge, another fetch starts immediately after it settles. A failed read repeats after `activeIntervalMs` doubled for each consecutive failure, up to `maxBackoffMs`, which must be at least `activeIntervalMs`. Unregistering a provider settles its watched change requests as `unavailable`. Polling stops when the last watcher leaves. The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-forge) lists the defaults.

Reaching `fetchTimeoutMs` aborts the fetch signal with `FORGE_FETCH_TIMEOUT`. Providers must stop their work and settle when the signal aborts; rejected fetches become `unavailable` failures. A provider that ignores cancellation can stall polling and service disposal.

Providers may implement `submitReview` to publish a line comment or a completed review at an explicit head commit. The registry returns unsupported when that capability is absent and refreshes watched status after a submission. Successful writes return their web URL; failures distinguish changed heads, refusals, and unknown outcomes. Callers must reconcile unknown outcomes before another submission. Pending drafts belong to the consumer, not the polling registry.

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
