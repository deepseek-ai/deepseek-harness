# Agent Note: Projection cache as per-session files

Status: implemented

English | [中文](2026-08-19-projection-cache-per-session-files.zh.md)

## Problem

The persisted projection cache was one global `session_projcache.json` — a `sessions` table in a single file at the storage root. Every throttled checkpoint rewrote the whole file containing every session's rows, so write amplification grew with session count, and one malformed file took the entire cache down at once.

## Decision

The cache opens the `session_projcache` storage domain in the new `per-record` layout, added to the json backend: one version-stamped document per session at `<root>/session_projcache/sessions/<id>.json`, owned by the storage stack — `storage` / `storage-json` / `storage-domain` live in the shared base bundle alongside the cache, and the cache itself is a plain domain consumer again. Every shipped base-backed profile keeps the cache enabled, so the session producer records checkpoints independently of whether its current application exposes a listing interface; `sdk-minimal`, which does not use the base bundle, remains outside this composition. The cache never consults the persistence layer: no `locate`, no dependency on which backend is mounted.

Reads and writes share ONE coherent state: every read (`cachedSnapshot`) is a synchronous lookup in the domain's in-memory tables (zero I/O), and every write queues on the domain's per-unit write chain, mutating memory only after durability — no direct disk reads that could lag the throttled writes. The cache keeps every other responsibility: checkpoint fold, write policy (turn/end + disposal mandatory, count/interval throttle), fail-soft durability, and the listing read. `cachedSnapshot(meta)` is synchronous. The cache runs no cold-refold ladder (that would require reading the session log, which belongs to the persistence layer); a consumer that needs a guaranteed cold snapshot refolds from the log itself. The json backend creates its tree owner-only (`0o700`).

## Consequences

- Per-session write isolation: each throttled write replaces only that session's small document, removing the global write amplification. The domain write chain serializes writes, so a newer cut never lands before an older one; domain close drains in-flight writes.
- Listing is a synchronous in-memory read; a session without a record document simply lacks the projection column.
- ACP, headless, SDK, and Web sessions publish cache rows for later consumers. The log-leading durability barrier may flush a covered prefix at the cache cadence and split otherwise coalesced physical JSONL runs; recorded profile snapshots re-pack the logical event stream so cache timing does not define fixture layout.
- The per-record contract scopes failure: a malformed or stale-version document reads as an absent record at open, so one bad file never bricks the cache, and a checkpoint schema bump discards stale sessions per record instead of rejecting the whole domain.
- The json backend bootstraps the per-record tree from the legacy whole-unit cache only when enumeration finds no new-layout document path, the legacy unit name matches, and its version is current or declared compatible. A version outside that accepted set remains untouched and the new domain opens empty; storage never relabels a version the domain owner did not approve. Any new document path, including an unreadable or stale file, suppresses the bootstrap for the whole unit; missing session rows refold from the log. The [cross-version read-compatibility decision](2026-09-02-projcache-cross-version-read-compat.md) owns the version policy.
- The `session_projcache` domain uses version 6 and declares versions 3, 4, and 5 compatible. Vouched-for records retain their listing projections across upgrades, absent lineage fields normalize to an unseeded identity, and a seeded caller rejects that identity and refolds cold. A record that still fails schema validation is backed up and skipped; every subsequent write stamps version 6.
- The cache record is bound to the same log lifecycle as before: the stored `{createdAt, cwd, isSeeded, inheritedEventCount}` identity guards against a recreated id or a mismatched inherited prefix.

## Alternatives considered

- **Keep the global sessions table.** Preserves one-load listing, but keeps the global write amplification and single-file blast radius that motivated the change.
- **Cache-owned per-session files** (`<root>/<session-id>/projection_cache.json`, the first revision of this change). Tried and reverted in review: the cache hand-rolled the medium — paths, per-path write chains, in-flight tracking, owner-only file modes, and a sqlite no-path special case — and its listing read hit the disk directly on every call while writes were throttled, so reads and writes were never consistent.
- **Resolve the path through `sessionPersistence.locate(meta)`** (the file beside the session log). Rejected: the cache would have to guess "beside the log" from a log artifact path (`dirname` + fixed filename), coupling the cache to the persistence service and to a backend's layout.
- **Make `per-record` a mode of the existing unit instead of a separate unit class.** Rejected: the two layouts have genuinely different state models — `single` is memory-authoritative with whole-file publish, `per-record` is stateless (the directory is the state; `loadAll` re-reads the tree) — so they are separate small classes behind one backend, with record keys validated path-safe instead of encoded.
- **Copy legacy values across undeclared unit versions.** Rejected: the json backend does not know a domain's record schema and cannot derive session-lineage fields. It copies an older record only when the domain explicitly lists that version in `compatibleVersions` and its current schema accepts the value; otherwise the record stays untouched and reads as absent.
