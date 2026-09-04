---
description: "The persisted session-projection cache for deployments and maintainers choosing, configuring, or debugging durable checkpoints, zero-I/O list reads, and accelerated cold projection folds."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-projection-cache

English | [中文](README.zh.md)

## Summary

`dsh-session-projection-cache` persists the state checkpoints of every registered projection unit (`ctx.sessionProjectionCache`) as one versioned document per session in the `session_projcache` storage domain's `per-record` layout. The shipped JSON backend stores each record at `<root>/session_projcache/sessions/<id>.json`, and the cache never reads the session-persistence layer. A stored row is a fold shortcut, never an authority: it may be stale — its `seq` says exactly how stale — but never wrong. Three mandatory checkpoints (session creation, `turn/end`, and session disposal) plus configurable count and interval throttles keep the cache fresh. Choose it when list views need synchronous cached values or cold projection folds should skip an already-checkpointed prefix.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package beside the projection registry and the storage stack when clients should list projection values for cold sessions without loading their logs. Without it, consumers must obtain the log before they can reconstruct cold projection values.

### When to choose it

Choose it when a deployment restarts sessions and needs durable projection values for history lists, statistics, or goal snapshots. Skip it when projections serve only live sessions, or when the extra storage writes cost more than the saved projection work.

### Minimal configuration

Both throttle fields are required — flush cadence is a deployment choice with no universally correct value:

The cache opens its domain through the storage stack, so base mounts `storage`, `storage-json` (root `dshHomePath('storages')`), and `storage-domain` (`backend: json`) before it:

```yaml
- id: session-projection-cache
  name: '@deepseek-ai/dsh-session-projection-cache'
  config:
    writeEveryEvents: 200
    writeIntervalMs: 5000
```

| Field | Default | Meaning |
|---|---|---|
| `writeEveryEvents` | required | Committed events per session that force a durable checkpoint write between mandatory points |
| `writeIntervalMs` | required | Longest time a dirty checkpoint may stay unwritten between mandatory points |

The plugin injects `storageDomain`, `sessionProjections`, and `sessions`. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-projection-cache) is the exhaustive source for every accepted field and its JSDoc.

### How checkpoints are written

Three mandatory points always write: session creation persists the seed-derived cut, `turn/end` persists the value that listing reads want, and session disposal persists the final live cut. Between them, the configured count and interval throttles write as events accumulate. Every write atomically replaces the session's complete record through the domain write chain; a failure logs a warning and keeps the cache stale, and the next write self-heals.

### Reading cached values

`cachedSnapshot(meta, inheritedEventCount)` synchronously serves client values from the storage domain's in-memory tables with zero I/O. It accepts only an identity-matching record and version- and schema-matching keys, then returns a `{ asOfSeq, values }` cut at the lowest served-row watermark. `cachedPredecessorTitle(meta, inheritedEventCount)` is the narrower listing-only exception: a structurally admitted predecessor record whose lifecycle matches may expose only a current-version-compatible `title` row. The title is a possibly stale fact from a durable prefix, not a fold seed; it carries the sentinel `asOfSeq: -1` because a cardinality-changing Session migration can invalidate the predecessor row's numeric sequence. All other predecessor rows remain unavailable. An unseeded listing knows that its cut is zero; a seeded header-only listing does not know the numeric cut and skips both fast paths until an authoritative body read supplies it. `coldSnapshot(meta, inheritedEventCount, events)` accepts the exact cut with a complete ordered log, skips the checkpointed prefix while folding, and refreshes the record without reading persistence itself.

### What the cache guarantees

The log leads and the cache follows: a live checkpoint flushes the session's buffered events durably before the cache row lands, so a crash can leave the cache behind the log but never ahead of it. Reads and writes share the storage domain's coherent in-memory state; the per-unit write chain mutates memory only after durability. Each version-stamped record must match the live unit schema and complete lifecycle identity (`formatVersion`, `createdAt`, `cwd`, `isSeeded`, and `inheritedEventCount`), so a row folded from another Session format generation or fork cut cannot seed the caller. The JSON backend stores each record at `<root>/session_projcache/sessions/<id>.json` in an owner-only directory tree.

Upgrades never cost the boot or expose an unproven fold. Records stamped with a version in the spec's `compatibleVersions` remain structurally readable for a current checkpoint rewrite, but a missing or older `formatVersion` never matches a current Session and therefore cannot seed hydration. A lifecycle-matching predecessor title remains available only through the listing hint above because title text is invariant across the adjacent Session-format edges and its row still passes the current projection `stateVersion` and schema. Once the format matches, absent lineage fields decode as the unseeded lineage — exact for unseeded sessions, while a seeded caller fails the identity match and refolds cold. A stored record that still fails schema validation is moved aside as `<id>.json.bak.<stamp>` under the domain's `invalidRecords: 'backup-and-skip'` policy, logged with its cause, and rebuilt by the next checkpoint.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the cache's durability and storage ownership; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

The cache is a fold shortcut over the projection registry's checkpoint face, stored in a `per-record` domain data table. It commits to six consequences: reads never bypass the domain write chain; every background write is fail-soft; a `ver` mismatch discards rather than migrates a row; a record must pass the live unit's `stateSchema`; writes replace one complete session record through the lossless-JSON boundary; and the log leads, the cache follows.

### Read and write ownership

The cache stores one version-stamped document per session in the `session_projcache` domain. It does not depend on a session-persistence backend, call `locate`, or inspect per-session directories. A malformed or stale record reads as absent, and consumers that require a cold value own any log refold.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `SessionProjectionCache` service, write-behind listeners, cache reads |
| [`src/spec.ts`](src/spec.ts) | The `session_projcache` domain spec and record identity types |
| — | No runtime invariant companion is published; the cache's correctness relation (a stored row equals the registry fold at its `seq` watermark) is only checkable by re-running the fold over the persisted log — duplicating the implementation rather than detecting drift — and its staleness is by design (fail-soft writes). The durable boundary is schema-validated by the cache's own zod parse on every read, and the read ladder's version/watermark guards are proven by the package spec. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the cache to the registry it checkpoints and the storage domain that holds its records.

- [Session projections subsystem](../../../docs/subsystems/session-projection.md) — the projection unit contract and drive semantics this cache checkpoints.
- [Session projection registry](../session-projection/README.md) — the `ctx.sessionProjections` service whose checkpoints this cache persists.
- [Storage subsystem](../../../docs/subsystems/storage.md) — the domain routing and backend behavior that store cache records.
- [Session package map](../README.md) — adjacent persistence, title, and telemetry packages.
- [Session-projection RFC](../../../.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md) — the persisted projection cache design rationale.

-----

<a id="model-experience"></a>
## Model Experience

None, as the persisted cache accelerates host-side reads of projection state and registers nothing model-facing.

#### KV Cache effect

None; the cache never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the cache needs operational care. They are current package constraints, not a task backlog.

- **No eviction or retention surface** — records accumulate per session; pruning stored checkpoints is out-of-band maintenance, same stance as session persistence itself.
- **Interval throttle is per-session coarse** — the timer arms at the first dirty event after a clean write; a steady sub-threshold trickle writes once per interval, not a sliding window.
- **No cache-side cold refold** — the cache serves and refreshes its rows but never reads the session log (it does not depend on the persistence layer); a consumer that needs a guaranteed cold snapshot refolds from the log itself.
- **Every schema or domain-version change must prove its upgrade story** — a change to the stored record schema or the domain version lands in the same PR with an archived fixture of the previously shipped on-disk format under `tests/fixtures/` and test cases in `tests/fixtures.spec.ts` proving the chosen disposition: read-compat recovery (`compatibleVersions`), current-version rewrite, or backup-and-skip salvage. A bump whose old records are simply discarded still proves that the discard neither fails the boot nor poisons the tree.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
