# Agent Note: Source-owned session immutability and dev-mode invariants

Status: implemented

English | [中文](2026-06-11-dev-invariants-over-deep-readonly.zh.md)

## Problem

The session log needs two different protections: immutable ownership of each stored fact, and checks for relationships among facts across time and service contracts. Conflating them in an optional development plugin would leave production history vulnerable; trying to express both through TypeScript readonly types would not create a runtime boundary or describe relational rules.

The session log is the durable source of truth for replay, request reconstruction, persistence, and user-visible history. Code outside the session package must be able to inspect that history without retaining a reference that can rewrite it later, and inputs accepted from callers must not remain connected to caller-owned mutable objects.

Immutability of individual values is only half of the contract. A log can contain perfectly immutable records whose sequence, turn/step nesting, tool-call pairing, scoped delivery, or reconstructed model request is wrong. Those rules relate multiple records or services and cannot be established by freezing one object.

TypeScript readonly types are not a sufficient runtime boundary. They disappear when the program runs, a cast can bypass them, and a recursive `DeepReadonly<T>` would spread through every log and message consumer even though some downstream request-processing APIs intentionally work with mutable values.

## Decision

Responsibility is split between an always-on storage boundary and optional development assertions.

### Session owns immutable history

`Session` accepts an event only after one recursive pass has materialized a lossless JSON snapshot. That pass rejects unsupported values and produces the exact detached record that enters the log, so validation and storage cannot observe different values from a stateful getter or retain caller-owned nested references.

The accepted event and all of its descendants are deep-frozen before publication. `append()` returns that owned frozen event, and `session/event` observers and `eventAt(seq)` receive the same record. `snapshotEvents(fromSeq?, toSeqExclusive?)` returns a frozen array snapshot; a previously returned array does not grow after a later append. `seq` and `eventAt()` avoid array materialization when a caller needs only the current length or one event. Seed records pass through the same validation, snapshot, and freeze boundary before construction succeeds.

This guarantee belongs in `Session`, not in an optional listener, because every composition relies on trustworthy history. A production deployment, a focused test, or a custom embedding receives the same storage semantics whether or not development support plugins are registered.

### Derived requests remain detached

`deriveMessages()` projects logged surface events into detached, deep-frozen `Message` objects and returns a fresh array snapshot. Request assembly can therefore combine derived history with other inputs without exposing a path back into the log. The cache reuses safe immutable projections rather than recloning the complete history for each model call.

### Package-owned invariant companions check relationships

`dsh-invariants` registers the configurable `ctx.invariants` service and contains no product checks. A package publishes a `./invariant` ownership companion only for an independently observable runtime relationship; packages without one omit the companion and record the reason in their README. `dsh-session`, `dsh-agent`, `dsh-scope`, and `dsh-agent-loop` provide the initial rules that require trace state or observation of another seam: monotonic sequence numbers, turn and step nesting, tool-call/result pairing, legal agent-status transitions, subject-correct scoped dispatch, and equality between a loop-built request and the request reconstructed from its session-log prefix. Global enablement and package-name regex filters belong to the service ([package-owned invariant service](2026-07-19-package-owned-invariant-service.md); [omission decision](../simplification/2026-08-28-omit-unneeded-invariant-companions.md)).

When the session companion attaches to an existing or seeded session, it replays the immutable log to rebuild trace state. The service gives each contribution a disposable child fiber, so hot reload is safe in the middle of a turn without giving diagnostics ownership of session storage.

## Alternatives considered

### Pervasive deep-readonly types

A rejected companion proposal would apply a recursive `DeepReadonly<T>` type across public log and message surfaces, flipping session read paths (`events`, `session/event` listeners, `deriveMessages()`) to deep-readonly while keeping in-flight waterfalls mutable. That provides editor feedback but not a runtime guarantee: TypeScript types are erased and plugin code can cast through them. It also pushes readonly types into consumers where mutation is intentional. Runtime ownership at the `Session` boundary protects every caller without that type propagation.

### Development-only freezing

Freezing history only when an invariants plugin is installed would make the core guarantee composition-dependent. Code could pass development tests and still corrupt history in production or in a focused composition that omits the plugin. Storage immutability is therefore always on, while the more expensive relational checks remain opt-in development support.

### Clone only when deriving messages

Detaching `deriveMessages()` would protect the most common request path but leave other readers of `snapshotEvents()`, `eventAt()`, append return values, and session-event observers able to mutate durable history. The log must protect its own boundary; derived projections are an additional isolation boundary, not a substitute.

## Consequences

- Every accepted live or seeded session event is detached from caller-owned inputs and deeply immutable before any observer can receive it.
- `snapshotEvents()` exposes stable immutable snapshots instead of the private growing array; `seq` and `eventAt()` serve scalar reads without copying that array.
- Request-side mutation cannot reach stored history through derived messages.
- Development builds can enable relational assertions without changing storage behavior, and disposing or filtering a companion does not weaken log immutability.
- `dsh-invariants` configures global enablement plus package allow/block regex lists; each check remains owned and tested by its product package.
- The runtime boundary carries a recursive snapshot-and-freeze cost once per accepted event; later readers and cached projections reuse the owned immutable records.
