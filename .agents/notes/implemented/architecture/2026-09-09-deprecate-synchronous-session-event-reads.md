# Agent Note: Deprecate synchronous reads of arbitrary Session events

Status: implemented

English | [中文](2026-09-09-deprecate-synchronous-session-event-reads.zh.md)

## Problem

Synchronous access to arbitrary event positions makes consumers depend on the complete Session event sequence being immediately available in memory. The storage direction is to stop retaining that complete sequence in memory. Once historical events require storage I/O, the runtime cannot preserve the same synchronous read guarantee without retaining the history or blocking on storage.

New callers increase that dependency even when they read only one old event. Repeated history scans after resume also make ordinary domain logic depend on historical storage instead of the state it actually needs.

## Decision

All operations that synchronously read arbitrary positions or ranges of Session event history are deprecated, including `Session.eventAt()`, `Session.snapshotEvents()`, and `Session.ownEvents()`. Existing logic may remain unmigrated for now, but new calls are prohibited. New aliases or wrappers that expose the same synchronous historical access are prohibited as well.

The three methods carry this rule in `@deprecated` JSDoc. This is an API-use decision; the current Session implementation still retains the complete event sequence in memory.

Repository test files, including `scripts/**/*.spec.{ts,tsx}`, may call these three readers to inspect emitted events and exercise Session history behavior. The test-file lint override allows `snapshotEvents`, `eventAt`, and `ownEvents`; all other deprecated names remain errors. This allowance also covers unrelated declarations with the same three names under the current linter. It does not apply to production source or non-test repository scripts.

### State needed after resume

Design durable event fields and Session projections together so each domain can reconstruct the state its consumers need. Restore that state during resume, then maintain it incrementally from newly committed events. After resume, ordinary logic reads the projection or processes the delivered current event instead of looking back through historical events. Reading already-maintained projection state synchronously does not require arbitrary access to the event log.

Historical content presented on demand uses explicit asynchronous pagination and progressive loading, with each read limited to the requested window. Loading the complete sequence behind a synchronous helper preserves the dependency this decision removes.

### Operations that require complete history

Fork and a small number of operations may genuinely need a complete historical sequence or inherited prefix. Their need for those records remains valid and requires an explicit storage read. It does not require the whole sequence to remain resident or grant an exception for new calls to deprecated synchronous readers. Each such consumer must establish why its result requires the complete sequence rather than projected state or a limited historical window.

## Alternatives considered

**Keep synchronous single-event reads while deprecating only full snapshots.** A single requested event may also be absent from memory. Restricting the result size does not remove the storage dependency, and helpers such as `ownEvents()` retain the same assumption for a suffix.

**Keep the complete sequence resident to preserve the read APIs.** This lets consumer convenience dictate Session memory retention and prevents the intended storage design. Projections preserve required state, while explicit historical reads preserve access to the records themselves.

**Require every existing caller to migrate immediately.** Existing logic may defer migration under this decision. Preventing new dependencies bounds the remaining work without making every existing consumer part of the same change.

**Disable deprecation lint throughout test files or exempt production readers by name.** Tests only need the three reader names; other deprecated APIs must remain errors. Production code retains the prohibition on new synchronous reads.

**Add a separate test-only reader API.** The three existing readers already expose the observations these tests need. Wrapping them adds an API and production-import checks without changing those observations.

## Consequences

New domain behavior must make its event data and projected state sufficient for resumed execution. User-requested history may still load progressively, and genuine full-history operations still have a storage path to design. This decision does not claim that resume or fork already avoids loading the complete log.

Calls outside test files carry line-scoped `typescript/no-deprecated` waivers that identify deferred migration or delegation between deprecated readers. Remove a waiver when its deprecated call is removed; copying a waiver to a new production call violates this policy. The executable lint check accepts test reads and existing waived reads, rejects unwaived production reads, and rejects unrelated deprecated APIs in tests. Documentation checks verify the source-equivalent API declarations and bilingual records.

## Related decisions

The [session immutability decision](2026-06-11-dev-invariants-over-deep-readonly.md) continues to own event ownership and freezing; this decision supersedes its recommendation to use synchronous historical readers. The [required projection reader decision](2026-08-19-session-projection-mandatory-seam.md) continues to own missing-state failures and typed state reads. The [recallable compaction proposal](../../proposed/feature/2026-07-06-recallable-compaction.md) retains its recall design while replacing its proposed synchronous history access with paged reads.
