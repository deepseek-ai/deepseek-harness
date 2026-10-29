# Agent Note: Session snapshots, passive subscriptions, and Web aggregation

Status: implemented

English | [中文](2026-10-21-session-history-stream-and-snapshot.zh.md)

## Problem

A point read, an event subscription, and a Web conversation opening have different lifetimes. Combining them inside one history controller makes passive observation perform unnecessary reads and gives each aggregate its own acquisition logic. Reading before subscribing also creates a gap that requires another read to repair. The APIs need independent operations that can compose without losing events or duplicating ownership.

## Decision

`SessionController` is the single Session Remote Service. It owns ordinary `HistoryController`, `StateController`, and `WebController` instances, not three additional Cordis Services or Remote namespaces. The implementation separates six operations: history snapshot and observation, projection snapshot and observation, and state snapshot and observation. Follow and Wait compose those capabilities for their callers; the existing `page` entry forwards to the history reader.

### Reads and subscriptions

History reads return chronological records, `hasMore`, and an inclusive cursor. An omitted `throughSeq` selects the observed log end; `beforeSeq` selects older records without changing that read cut. Projection reads return exact sequenced values, sequence-free cache hints when migration is required, or null when the Session is absent. Live projection reads avoid persistence metadata access.

`usingObservation({ sessionId, projection }, signal, callback?)` acquires the existing disposable SessionObservation. A callback borrows it until the callback settles; without a callback the caller owns disposal. Ordinary history, state, and Wait output reads do not request projections. Follow, exact projection reads, and subagent history descriptor validation request them. No read activates an Agent implicitly.

`observeEvent` and `observeProjections` install listeners without acquiring an Observation. Their initial `ready` confirms subscription, not a snapshot cursor, existence, parent-child validity, or Agent readiness. History establishes continuity from its first received event; projection updates replace individual keys and may share a sequence number. `observeState` instead begins with a complete state read and coalesces later Session and Agent invalidations.

History, history observation, and Follow accept Address requests; projection and state operations accept Session IDs. All internal readers and listeners use Session IDs. History and Follow validate Address against their opening Observation at the Controller layer, including the existing subagent descriptor rules. Pure history observation does not acquire a read for entity validation. Gateway resource authorization remains independent: the registered Session resolver extracts the target ID from the request before access is decided.

### Follow ordering and ownership

Follow installs history and optional assistant listeners first, then acquires one projected Observation. It captures the assistant baseline and binding-local arrival ordinal synchronously, sets both cuts, publishes the opening snapshot, and consumes the shared output queue. History notifications at or before the snapshot cursor and assistant notifications at or before the ordinal are discarded at consumption. Later notifications remain ordered without a second history read, background merge pumps, or a tail repair introduced by the opening itself.

`session/created` contributes constructor seed events through the same history buffer. The adapter retains the supplied Session and its captured end position, then reads that in-memory prefix when consumed; it does not acquire another Observation. Each binding owns its subscriptions; a shared output queue belongs to Follow rather than to either listener.

Follow activates only when the caller passes `activate: true`; the Web Client does so explicitly. Background promotion starts once the opening is computed and before it is delivered, and does not promise Agent readiness. Ordinary promotion reuses the existing Agent controller and receives a separately retained Observation. Either Follow releases its opening Observation once the opening is computed, before yielding it; activation continues on the separately retained lease, so the cold entry's reference count drops to that lease alone. Subagent Sessions do not use ordinary promotion.

### State and Wait

State contains the event cursor, active and running flags, the complete readable queue or null, and pending-input kinds. It exposes neither a header nor an internal revision. Gateway owns unsettled Remote events; State samples their detached metadata and classifies approval, question, or other input without copying a request registry.

Wait evaluates complete states, confirms active-Agent quiescence with `whenIdle`, and rejects stale observations using listener-local revisions and Agent/Session identity checks. Session and Agent events wake reads immediately; while waiting, a one-second recheck detects pending input that produces no such event. This avoids adding a Gateway change event, at the cost of polling and bounded sampling delay rather than instantaneous notification. `observeState` does not poll, so pending-only changes need another state invalidation to become visible there.

Wait returns idle, input-required, or timeout with the last state it accepted and bounded assistant output. Output contains only `assistant/message` records in `(afterSeq, state.cursor]`, newest first, and reports truncation only when another eligible record exists. The caller's cancellation signal controls that output read independently of the expired wait deadline. A wait that accepts no state before its deadline fails instead of inventing a state.

## Alternatives considered

**Read history, then subscribe and repair the gap.** Subscription-before-read already captures opening-time increments. A second read adds acquisition and replay obligations without improving that ordering.

**Give pure subscriptions an Observation or ready cursor.** These values conflate subscription readiness with an independently selected read cut. Callers that need both subscribe and buffer first, then read and discard covered increments.

**Keep separate Remote Services for the implementation controllers.** The classes divide behavior, not external service identity. One Session Service owns their composition, resource policy, and Remote entry points.

**Have Gateway interpret pending input or emit Session status.** Gateway only owns Remote event transport and unsettled-event metadata. State owns classification; Wait's periodic sampling avoids adding a transport notification solely for Session waiting.

**Merge assistant and history with independent asynchronous pumps.** One caller-owned buffer retains cross-source arrival order without extra pump cancellation or queue ownership. Snapshot construction and per-binding buffering retain distinct lifetimes.

## Consequences

The standard reads and Web aggregate share one Observation acquisition path, while pure subscriptions remain read-free. The old combined History controller is removed; still-used pagination, validation, and wire helpers remain at their original path. Cancellation, consumer termination, failed opening reads, and Context disposal release subscriptions and owned leases without cancelling Agent execution.

The [Observation decision](2026-08-25-session-observations-and-projection-owned-client-state.md) remains the authority for exact read cuts and projection derivation. The [history and Remote transport decision](2026-08-18-session-history-and-event-transport.md) retains ownership of Client reconnection and transport lifetimes. This decision refines Session API composition rather than replacing either broader decision.

The migrated history, cold-read, and transport tests exercise the new classes, including cursor overlap, assistant ordinal cuts, sequence gaps, subagent validation, and teardown. Slow consumers can still retain queued notifications; silent dropping is not a supported recovery strategy. Independent completion-acknowledged activation is not implemented by these reads or by Follow's background activation option.
