---
name: dsh-session-projection
description: Use when creating, extending, or reviewing a DeepSeek Harness session projection, or migrating a fold helper to one.
---

# DeepSeek Harness Session Projections

Follow the [projection API](../../../packages/session/session-projection/README.md) for registration and lifecycle details.

1. Decide whether to extend an existing projection or create one; check whether an existing owner already maintains the needed state.
2. Follow the README's [service ownership rules](../../../packages/session/session-projection/README.md#register-and-read): keep projection definitions and handles private to the owning service's implementation, and expose domain methods to consumers.
3. Require `sessionProjections` when the service needs projected state to function. Optional registration is for contributions the service can operate without.
4. Evaluate retained state size as the session grows. Do not accumulate state proportional to session length, including collections of event sequence numbers. Growth is acceptable only when slow enough to remain negligible. When the data would keep growing, consider incremental loading instead of retaining the complete state.
5. `apply` is synchronous; historical reads belong in asynchronous consumers. When later reads need event payloads, consider retaining sequence numbers within rule 4's state-size limits and letting consumers resolve them asynchronously.
6. When replacing a helper such as `foldSessionTitle` with a projection, remove the superseded helper.
7. After migrating to Session persistence, stop using `fold` in names and descriptions of the migrated logic.
8. Do not add calls to deprecated synchronous readers (`snapshotEvents`, `eventAt`, `ownEvents`) or wrappers exposing the same access ([decision](../../notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md)). Assume the full event log is not resident in memory and random reads may require asynchronous disk access.
9. Consider state size, replay cost, and per-event work; add complexity only for a concrete performance need.
10. Asynchronous `register()` is usually called in `[Service.init]`. If event listeners are registered afterward, check initialization ordering: when needed, install listeners before awaiting registration; if a listener needs the returned handle, await its readiness in a callback that supports asynchronous waiting. Otherwise, an event may fire before the listener is installed and be missed. Determine whether this race exists from the actual initialization flow and event trigger paths; do not move listeners earlier or add waits mechanically.
