# Agent Note: Session log reads state their materialization cost

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-21-session-log-read-intent.zh.md)

## Problem

An all-purpose `Session.events` accessor hides an array-sized copy behind every read after an append. The full frozen snapshot can be cached, but streaming invalidates that cache for every new event, so a caller that only needs the log length or one event can repeatedly copy millions of references. Making the return value immutable does not require every read intent to pay that cost; event immutability is owned separately by the [source-owned session immutability decision](2026-06-11-dev-invariants-over-deep-readonly.md).

## Decision

`Session` exposes three cost-specific read operations. `seq` reads the current length in constant time, `eventAt(seq)` reads one event in constant time, and `snapshotEvents(fromSeq?, toSeqExclusive?)` explicitly materializes a frozen array for consumers that need array operations or a stable materialized range. Sequence parameters are non-negative log positions, not `Array.prototype.slice` offsets from the end. Recurring domain state such as the selected agent preset is read from a Session projection instead of rescanning live history.

The complete current snapshot is cached until append because repeated whole-log consumers can share the same immutable array. A range snapshot copies only the selected references and is not cached: arbitrary range caching would retain unbounded arrays and require an eviction policy. Previously returned snapshots remain stable because accepted events are immutable and a snapshot array never grows after append.

Recurring domain-state reads use [session projections](2026-08-19-session-projection-state-and-client-views.md) when the required value can be maintained incrementally. Raw-log snapshots remain appropriate for persistence, export, replay, and consumers whose output is the event sequence itself. This API makes materialization visible but does not attempt to eliminate every full-log fold in the same change.

## Alternatives considered

**Keep a cached `events` array accessor.** This preserves ordinary array syntax but makes scalar and indexed reads appear cheap while an append can turn either into a whole-log copy.

**Return a custom immutable cut with array-like traversal operations.** A captured length could provide a stable constant-time cut over the growing log, but the abstraction would reimplement selected array semantics and keep expanding as callers request more operations. Explicit indexed reads, explicit materialization, and projections cover the shipped intents with a smaller public API.

**Cache every materialized range or maintain an incremental chunked snapshot.** Range caching needs retention and eviction rules, while a chunked public representation changes consumers and serialization for a cost that many callers avoid through indexed reads or projections. These representations remain options if measured full-snapshot consumers justify them.

## Consequences

- Length and single-event reads do not copy the log.
- Full and ranged snapshots retain an explicit linear cost proportional to the selected event count.
- Consumers choose between raw history and incrementally maintained state at the call site.
- The public API does not emulate an array; callers materialize only when they need array operations.
