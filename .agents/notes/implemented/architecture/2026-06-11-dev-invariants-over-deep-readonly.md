# Agent Note: Source-owned session immutability

Status: implemented

English | [中文](2026-06-11-dev-invariants-over-deep-readonly.zh.md)

## Problem

The session log needs immutable ownership of each stored fact. Making that protection an optional development plugin would leave production history vulnerable; expressing it through TypeScript readonly types would not create a runtime boundary.

The session log is the durable source of truth for replay, request reconstruction, persistence, and user-visible history. Code outside the session package must be able to inspect that history without retaining a reference that can rewrite it later, and inputs accepted from callers must not remain connected to caller-owned mutable objects.

Immutability of individual values does not establish relationships among records. A log can contain perfectly immutable records whose sequence, turn/step nesting, tool-call pairing, scoped delivery, or reconstructed model request is wrong. Those rules relate multiple records or services, cannot be established by freezing one object, and are outside this decision.

TypeScript readonly types are not a sufficient runtime boundary. They disappear when the program runs, a cast can bypass them, and a recursive `DeepReadonly<T>` would spread through every log and message consumer even though some downstream request-processing APIs intentionally work with mutable values.

## Decision

`Session` owns an always-on storage boundary.

### Session owns immutable history

`Session` accepts an event only after one recursive pass has materialized a lossless JSON snapshot. That pass rejects unsupported values and produces the exact detached record that enters the log, so validation and storage cannot observe different values from a stateful getter or retain caller-owned nested references.

The accepted event and all of its descendants are deep-frozen before publication. `append()` returns that owned frozen event, and `session/event` observers and `eventAt(seq)` receive the same record. `snapshotEvents(fromSeq?, toSeqExclusive?)` returns a frozen array snapshot; a previously returned array does not grow after a later append. `seq` reads the current length without materializing an array. Synchronous historical readers are deprecated under the [event-read policy](2026-09-09-deprecate-synchronous-session-event-reads.md). Seed records pass through the same validation, snapshot, and freeze boundary before construction succeeds.

This guarantee belongs in `Session`, not in an optional listener, because every composition relies on trustworthy history. A production deployment, a focused test, or a custom embedding receives the same storage semantics regardless of which plugins are registered.

### Derived requests remain detached

`deriveMessages()` projects logged surface events into detached, deep-frozen `Message` objects and returns a fresh array snapshot. Request assembly can therefore combine derived history with other inputs without exposing a path back into the log. The cache reuses safe immutable projections rather than recloning the complete history for each model call.

## Alternatives considered

### Pervasive deep-readonly types

A rejected companion proposal would apply a recursive `DeepReadonly<T>` type across public log and message surfaces, flipping session read paths (`events`, `session/event` listeners, `deriveMessages()`) to deep-readonly while keeping in-flight waterfalls mutable. That provides editor feedback but not a runtime guarantee: TypeScript types are erased and plugin code can cast through them. It also pushes readonly types into consumers where mutation is intentional. Runtime ownership at the `Session` boundary protects every caller without that type propagation.

### Development-only freezing

Freezing history only when a development plugin is installed would make the core guarantee composition-dependent. Code could pass development tests and still corrupt history in production or in a focused composition that omits the plugin. Storage immutability is therefore always on.

### Clone only when deriving messages

Detaching `deriveMessages()` would protect the most common request path but leave other readers of `snapshotEvents()`, `eventAt()`, append return values, and session-event observers able to mutate durable history. The log must protect its own boundary; derived projections are an additional isolation boundary, not a substitute.

## Consequences

- Every accepted live or seeded session event is detached from caller-owned inputs and deeply immutable before any observer can receive it.
- Existing `snapshotEvents()` and `eventAt()` callers retain immutable read results while their migration is deferred; `seq` reads the log length without copying the array.
- Request-side mutation cannot reach stored history through derived messages.
- The runtime boundary carries a recursive snapshot-and-freeze cost once per accepted event; later readers and cached projections reuse the owned immutable records.
