# Agent Note: Separate session projection state from client views

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-19-session-projection-state-and-client-views.zh.md)

## Problem

The projection registry persisted each unit's internal fold state without a runtime schema, while `SessionProjectionMap` described the client value returned by `view`. This left restored state unvalidated and made the same type table appear to describe two values that may differ. Host consumers also needed the current folded state without serializing every registered client view or exposing internal-only state through the client protocol.

## Decision

`SessionProjectionStateMap` is the merge-extensible table for host fold states. Every `ProjectionDefinition` key belongs to this table and supplies a `stateSchema`; cached rows are validated before they seed a fold. `SessionProjectionMap` retains its existing meaning and name as the sole table of client-visible whole values, preserving existing client data structures such as `title: string | null`.

A unit whose key also appears in `SessionProjectionMap` supplies `wire.viewSchema` and `wire.view`. Every unit's state is checkpointed — client-visible and host-only alike; the `persist` opt-in is gone, so no unit can silently skip the durable cache. Snapshot APIs enumerate only definitions with `wire`, so omitting an audience flag cannot place internal state in an API payload. Host code reads one current state through `stateOf(session, key)`; the returned reference is borrowed and must not be mutated.

## Consequences

Projection state and client values are independently typed and validated without introducing a second client DTO vocabulary. A unit may expose a compact or compatibility-preserving client value while retaining richer host state. Malformed cached state cannot seed `viewCheckpoint`; restore rejects malformed state and the cache's existing full-read fallback rebuilds it from the log. Host consumers can replace private log scans with the same incremental fold used by carriers, while carrier snapshots cannot enumerate host-only state.

The original [session-projection proposal](../../proposed/architecture/2026-07-27-session-projection-and-command-log.md) now records this split. The earlier [subagent identity projection](2026-08-06-subagent-list-identity-projection.md) and [projected token usage](2026-07-29-projected-token-usage-and-request-context.md) decisions remain current; their domain folds move to the state table without changing their user-facing values.

## Alternatives considered

- **Rename the existing map to a state table and introduce a new client map** — rejected because it changes the established client type name and invites unnecessary client payload migrations.
- **Keep one table for both state and client values** — rejected because a richer fold state and a compatibility-preserving client value then cannot be represented accurately.
- **Opt-in persistence for host-only units** — rejected: a `persist` flag lets a unit silently skip the durable cache, and the savings (one small row per session) never justify the asymmetry or the stateVersion confusion it invites. Every unit's state is checkpointed uniformly.
- **Return copied state from `stateOf`** — rejected because cloning every host read adds work without protecting a boundary; the method documents a readonly borrowed-reference obligation for typed same-process callers.
