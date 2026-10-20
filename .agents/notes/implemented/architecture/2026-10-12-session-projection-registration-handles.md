# Agent Note: Asynchronous projection registration and retained readers

Status: implemented

English | [中文](2026-10-12-session-projection-registration-handles.zh.md)

## Problem

Host readers coupled to registry key lookup lose access when a plugin unloads, although an Agent may still need projected state while its asynchronous cleanup drains. Repeated batch snapshots materialize unrelated client views. A synchronous registration API also makes every consumer assume that acquisition can never require asynchronous initialization.

## Decision

`SessionProjectionRegistry.register` returns an awaitable registration for a typed handle. Domain owners await it during activation before exposing dependent operations. Function plugins retain their namespace exports and use asynchronous `apply`; services use their initialization hook. Each domain service keeps its definitions and handles internal and exposes methods returning business data. Consumers depend on that service rather than registering its definitions or receiving projection readers. This supersedes the optional first-access acquisition and disposer-return details in [the mandatory-reader decision](2026-08-19-session-projection-mandatory-seam.md), while retaining its mandatory-state and cropped-client-view rules.

A handle owns one reference to a shared definition and its per-Session cells. Its disposer releases global participation exactly once; the final release removes the unit from live drives, snapshots, and checkpoints. Its reader remains usable after release, folding unseen events with the original definition. A later registration at a different state version does not replace an older handle's definition. Registration checks owner liveness after its asynchronous handoff and rejects if the owner unloaded before receiving the handle.

AgentRegistry owns turn and step state and exposes `turnBoundaryOf(session)`. AgentLoop acquires its inbox handle once before publishing its factory, reads the last turn before creating an Agent scope, and passes an inbox callback plus that turn number into synchronous Agent construction. The callback retains its handle through cleanup after the loop fiber removes global registrations. This preserves the existing creation/setup sequence without per-Agent registration or an extra initialization state.

Plugins compiled against the synchronous API keep running during migration. The awaitable registration is also the original Cordis effect disposer, so calling it releases the registration and a composing effect adopts its ownership; that call is deprecated. Registry-level `stateOf(session, key)` remains a deprecated read returning `unknown`; it loses access after the final release and logs one `ctx.logger.warn` per key per registry. Registration itself does not warn, because an ignored result is indistinguishable from one awaited later. A legacy plugin may never observe the registration, so the registry attaches its own rejection handler: once the current macrotask and its microtasks finish, a rejection nobody observed through `then`, `catch`, or `finally` is logged as an error while the plugin stays active, and one whose owner is no longer loading or active is dropped. TypeScript consumers migrate their declarations; the host state map is not restored.

## Alternatives considered

**Keep registry-level lookup and delay unregistering.** This couples unrelated plugin disposal order to every reader's final access. Retained readers make cleanup independent of that order.

**Return a synchronous handle.** This preserves callers' immediate reads but commits the acquisition API to synchronous initialization. Awaited acquisition leaves that timing explicit while state reads remain synchronous after readiness.

**Register the same units for each Agent.** The definitions already contain per-Session cells. Additional references and asynchronous Agent initialization add a creation race without providing independent data ownership.

**Convert function plugins to classes.** Cordis already awaits promises returned by `apply`. Preserving namespace exports avoids a published entry-point and diagnostic-name break.

**Require every external plugin to migrate immediately.** Compiled plugins fail at runtime on the missing disposer and keyed read, although the projection keys and state fields they read are unchanged.

**Return a new wrapper around the disposer.** Cordis composition adopts effects by their returned identity. A wrapper leaves the original registration owned by the fiber, so owner disposal can release it before the composed cleanup finishes.

**Dispose the plugin after an ignored rejection.** This approximates the old failed activation, but it needs a startup observer, runs only after the plugin's services became visible, and ends in `DISPOSED` rather than a retryable `FAILED`. Logging keeps the failure visible without a second lifecycle path.

## Consequences

Projection owners must migrate acquisition and retain handles; other consumers use the owning services. Released handles retain their definitions and weakly keyed cells for as long as the caller keeps them; they do not restore global wire participation. Registration-reader tests cover post-release folding, version replacement, unrelated-unit isolation, repeated disposal, concurrent owner disposal, and owner unload during acquisition. Agent lifecycle tests cover cleanup failures, scope-minting races, and background child shutdown. Compatibility tests and a real Loader subprocess verify the deprecated calls.
