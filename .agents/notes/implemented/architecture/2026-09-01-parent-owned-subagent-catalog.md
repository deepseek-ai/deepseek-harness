# Agent Note: Parent-owned subagent catalog events

Status: implemented

English | [中文](2026-09-01-parent-owned-subagent-catalog.zh.md)

## Problem

Direct-child discovery once reconstructed a catalog from the global Session corpus and each selected child's log. Creation already knows the direct parent, child id, mode, and label, so repository-wide enumeration and child-log reads duplicated an owned fact and made browser refresh cost depend on unrelated Sessions.

The child descriptor remains necessary for recovery and composition, but it cannot be the discovery source because a reader must find and open the child before it can read the descriptor. Forks add a separate requirement: a seeded copy of a parent log must not inherit the original Session's children.

## Decision

The parent Session's required `subagent/catalog` events are the persistent authority for direct-child discovery. Each event is one successful creation fact containing `childId`, `childCreatedAt`, mode, and the mode-discriminated label. Remote one-shot runs without a local Session remain outside this catalog. Invalid own facts, including unsupported payload versions, reject projection restoration because silently dropping a required fact would return an incomplete catalog.

Creation publishes only successful facts. A one-shot run appends the catalog event after its provider returns a local child and before the run reaches its caller. A continuable run admits the initial prompt, appends the catalog event, then returns the child id. If admission or catalog append fails, creation fails and releases the activation; there is no compensating catalog event or rollback protocol.

The child header and `subagent/descriptor` remain authoritative for recovery and composition. An Activation and the exact parent relationship remain authoritative for authorization and delivery. Mode and label are snapshotted once and the same detached values reach the parent catalog fact and child descriptor.

The registered `subagentCatalog` projection materializes the parent facts. It delegates storage, append, iteration, and checkpoint validation to [`dsh-chunked-list`](../../../../packages/util/chunked-list/README.md), which stores facts in a persistent stack of 64-entry chunks, so an append copies at most the head chunk in bounded O(1) work. Materialization visits chunks from oldest to newest and preserves parent catalog event order in O(D) time for D facts. Concurrent creation is ordered by successful catalog append, independent of child timestamps and ids. A projection checkpoint clones the state once in O(D); projection-cache writes remain asynchronous and use the existing mandatory creation, turn-end, and disposal points.

The utility owns chunk layout and its shared capacity constant; the catalog owns event validation, fork filtering, and row conversion. Catalog projection state version 2 stores generic chunk values, so the projection registry rebuilds incompatible caches from Session events. Session event payloads and public catalog rows retain their formats.

Fork isolation uses the exact `Session.inheritedEventCount` supplied to projection initialization. The fold ignores `subagent/catalog` events below that offset. The state stores the inherited offset but not each event seq because acceptance is decided during folding.

Headless snapshot collection assigns sibling fixture roles by their parent catalog order, regardless of child creation timestamps: provider startup can publish an older Session after a newer one. The collection preserves each log verbatim.

Snapshot normalizers zero `childCreatedAt` because it originates from the process clock. Event order and source-event references remain intact: adjacent facts can come from sequential creation, so adjacency does not establish commutativity.

Current-writer snapshot expectations include catalog facts even when replay input retains a historical Session generation. The comparison preserves the catalog and its source-event references; historical replay files remain unchanged.

## Alternatives considered

**A flat immutable array.** Appending with `[...facts, fact]` copies D facts, so creation is O(D). Mutating a shared array would violate projection state ownership and checkpoint safety.

**A node-per-fact linked list.** It provides O(1) append and O(D) read, but persisted projection checkpoints form JSON nested D levels deep. Sixty-four-entry chunks preserve the asymptotic costs while reducing nesting.

**Separate host-state observation output.** Returning internal projection states duplicates the existing observation result mechanism and copies states unrelated to child discovery. A catalog view supplies the direct-child list through the existing typed projection map.

**A durable SQLite child index.** An index would create another write path, reconciliation protocol, schema, and corruption surface for a fact already ordered in the parent Session log.

**A compensating failure event.** Recording catalog membership before initial prompt admission requires a second operation, pairing rules, rollback cleanup, and client reconciliation. Delaying the success fact until admission completes removes that protocol.

## Consequences

Session observations and client snapshots expose the direct-child list through `projections.values.subagentCatalog`. The projection change feed publishes a complete list when catalog state changes. Each view costs O(D), so D creations can incur O(D²) cumulative view work; this follows the existing projection mechanism. Direct-child and descendant listing still use the Session corpus and child identity projection.

Backends that do not know the required event refuse the log under the existing Session event mechanism. Catalog projection does not reconstruct missing parent facts by scanning old child logs.
