---
name: dsh-session-projection
description: Use when creating, extending, or reviewing a DeepSeek Harness session projection, or migrating session-derived recovery state to one.
---

# Session Projection Rules

## Summary

Keep recoverable session facts in Projection and expose them through their owning services. Read the [API and lifecycle](../../../packages/session/session-projection/README.md) for the supported preparation, registration, read, and cleanup contracts.

1. Put all persisted or restorable session-derived state in Projection, including host-only state. Reuse an existing owner when suitable. Keep external resources and process-scoped ownership outside persisted state. Persist facts, not registration handles, promises, or runtime resources.

2. Do not expose projection definitions or handles as production read APIs. Keep the ready handle private; consumers use the owning service's domain methods. A handle is a process-local reader, recreated during activation. Require `sessionProjections` when the service depends on it; optional registration is only for optional contributions. Do not hide a missing required dependency with another recovery path.

3. State recovery through `init` and `apply` is synchronous and deterministic. Do not perform I/O or trigger Cordis hooks, models, or tools. Runtime hooks own those effects. Replay must not repeat them. Return the same state reference for unrelated events. Keep views synchronous and preserve their references when visible values do not change.

4. Persist JSON state that its schema accepts. Follow the README's state-version and checkpoint-watermark rules. Restoring a checkpoint and replaying its suffix must match full replay. Change the version when state fields or recovery semantics change.

5. Prefer fixed-size or sublinear state. Growth is acceptable only when slow enough to remain negligible. Necessary linear state must have a current use and explicit memory, replay, and per-event costs. Do not retain history-sized indexes, including event sequence collections, by habit. Do not discard required data or change behavior to reduce size. Start with a complete implementation; optimize for a concrete need.

6. Caches must be discardable and rebuildable without changing behavior. A sequence reference alone is insufficient when a synchronous consumer needs the referenced payload. Store the required current value within rule 5, or prepare the payload through an explicit asynchronous path. Do not hide full-log reads in a cache miss. Do not add `snapshotEvents`, `eventAt`, `ownEvents`, or equivalent wrappers: history need not stay in memory. An async wrapper does not make synchronous history reads asynchronous. Existing host replay may remain for named supported callers, with an owner and removal condition; this does not permit [Client cache-miss full-log reads](../../../docs/defensive-patterns/conversation-and-session.md#cold-reads-are-the-last-resort). Remove superseded recovery helpers; cache reconstruction must not duplicate recovery rules.

7. Await required registration before exposing synchronous readers or installing callbacks that use its handle, usually in `[Service.init]`. Let registration rejection fail that activation. Events can arrive during the await; install listeners earlier only when needed to avoid missed events. Await only in callbacks that support it. Do not move listeners or add waits mechanically. Keep fiber cleanup ownership, await explicit disposal, and do not create effects after the owner is disposed.

8. Keep registration readiness and Session recovery separate. The asynchronous Session-loading or preparation owner completes historical recovery before it publishes the Session to synchronous readers. Use the registry's supported lifecycle; do not add hydration or hidden I/O to domain getters. Recovery prepares state; getters read it. Preserve the registry's error scope for each unit and Session.

9. Identify all official consumers before switching a read path, including plugins, CLI/GUI, and both SDKs. Preserve synchronous callers until they migrate explicitly; a Promise cannot implement a synchronous API. A new required service or activation step needs consumer updates and an upgrade guide. Keep compatibility tied to actual supported callers, not test-only compositions.

10. Verify values, notifications, error scope and timing, and recovery through affected real entry points. Keep existing behavior assertions. Do not move consumer-only errors into eager Projection processing. For lifecycle changes, test delayed registration, rejection, replacement, and disposal during an await. Use actual Session/store lifecycles and explicit barriers instead of partial Session mocks or microtask counts. Check error logs as well as released state. Recovery tests cover usable, missing, and incompatible checkpoints plus suffix replay, without runtime effects.
