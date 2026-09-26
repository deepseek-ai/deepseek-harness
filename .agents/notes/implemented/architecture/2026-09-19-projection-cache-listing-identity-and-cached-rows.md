# Agent Note: Projection cache read-only face matches the lifecycle identity; the client store separates cached and sequenced rows

Status: implemented

English | [中文](2026-09-19-projection-cache-listing-identity-and-cached-rows.zh.md)

## Problem

After a Host process restart, every forked session (`SessionHeader.isSeeded === true`) shows no title in the sidebar session list, `@` reference completion shows only the session id, and list ordering degrades to creation time. Opening the session once restores all of it. On one development machine on 2026-09-19, 44 of 241 projcache records were seeded, all 44 carried a valid `title` row, and the list never read any of them.

This is neither cache corruption nor a version mismatch. The projcache record's domain version is 7 and its `identity.formatVersion` is 4; those are the cache's own on-disk format generation and the Session log format generation the fold ran under, and both are current. The defect is on the read path.

### Mechanism

A cache record (record format and predecessor recovery: [Projection-cache predecessor recovery and Session-format binding](2026-09-02-projcache-cross-version-read-compat.md)) is bound to a lifecycle identity: `formatVersion + createdAt + cwd + isSeeded + inheritedEventCount`, matched by `identityMatches` on full equality. Since #3346, `inheritedEventCount` (the length of the event prefix a fork inherits, the cut below) no longer appears in the logical header: the header keeps only the `isSeeded` bit and the exact cut follows the body. Since Session format v2 (#3398) the physical header line no longer stores `seedLength` either; the reader derives the cut from the seq of the `session/end-seed {inherited: true}` marker in the body.

A header-only read therefore cannot obtain the cut: the JSONL backend's `fromHeaderLine` hard-codes `inheritedEventCount: 0` for header-only reads, and `SessionPersistenceSnapshot` carries only the header, the revision, and an optional eventCount. The Session-list and reference consumers grew the same guard:

| Consumer | Guard | Fallback | Consequence |
|---|---|---|---|
| `packages/api/session-controller/src/list.ts` `projectionsFor` | `header.isSeeded ? undefined : cachedSnapshot(header, 0) ?? cachedPredecessorTitle(header, 0)` | none | no title, no `sessionListMetadata`; blank falls back to `false`, ordering falls back to `createdAt` |
| `packages/context/session-reference/src/index.ts` `projectedLabels` | same | none | `@` completion labels by id; the title cannot be searched |

When the guard landed (#3346, 2026-09-01), `list.ts` still had `probeSmallCold`: on a cache miss it read the body when the log file was at most `DEFAULT_COLD_BLANK_PROBE_MAX_BYTES = 1024` bytes. Its purpose was blank-session detection; it covered only logs under 1KB and never applied to an ordinary fork. #3400 (2026-09-03) removed it and the list returned to metadata plus cache only. #4320 (2026-09-19) made forking a first-class feature (`packages/core/session/src/fork.ts`, fork at any seq); every fork is `isSeeded: true` with an exact cut, seeded sessions went from a handful to dozens, all of them cold after a restart, and the gap became visible at once.

### The cache's two uses and where validation lives

The read and write faces of `SessionProjectionCache` and their callers:

| Face | What it does with the record | Writes back | Callers |
|---|---|---|---|
| `write(session)` | writes the checkpoint at three mandatory points plus a throttle | yes | the cache's own listeners |
| `hydratePrepared(session, events)` | uses `rows` as the fold starting point and applies events from `row.seq + 1`; the result lands in live cells | the next checkpoint | `session-query/src/observation.ts` |
| `coldSnapshot(meta, cut, events)` | fold starting point plus write-back | yes | no production caller |
| `cachedSnapshot(meta, cut, keys?)` | `viewCheckpoint`: each row passes `ver` and `stateSchema`, is `view`ed, and returned | no | `list.ts`, `session-reference` |
| `cachedPredecessorTitle(meta, cut)` | the same, `title` only, allowing an older `formatVersion` | no | `list.ts` |

Identity validation lives entirely inside the cache (`recordFor` → `identityMatches`; `viewCheckpoint` checks `ver` and schema per row). `list.ts` validates nothing itself; it merely declines to call when it cannot supply a cut.

spec.ts and the README describe the purpose of the identity check with one verb: preventing "seed state folded from an unrelated log", "cannot seed the caller". That guards the fold face. The read-only face has never seeded anything.

### The client store cannot guarantee that connected data replaces hints

Each session has exactly one `ProjectionValueStore` on the client (`manager.projectionStores`; its merge rules were recorded in [Session observations and projection-owned client state](2026-08-25-session-observations-and-projection-owned-client-state.md)). The block delivered by the list, the history first-page baseline on open, the control baseline, push frames, and rename results all write into that one object, and `useProjection` reads it. All writers are peers under one higher-seq-wins rule: `apply` drops a new value when `seq <= row.seq`, and `seed` clears omitted keys only when `row.seq <= cut`. A list hint whose seq is equal or higher survives untouched after the session is opened. The hint's seq comes from a disk record; after a crash-repair truncation it can be numerically higher than the connected cursor, which is exactly the case where the cache is wrong and the connection is right. Comparing seqs against a hint is the wrong tool.

## Decision

### Two read faces; the cut is compared only on the fold face

| Face | Identity | Who can supply it | Methods |
|---|---|---|---|
| read-only face | lifecycle identity: `formatVersion + createdAt + cwd + isSeeded`, all from the header | any header-only caller | `cachedSnapshot(header, keys?)`, `cachedPredecessorTitle(header)` |
| fold face | lifecycle identity plus `inheritedEventCount` | callers holding the Session or its body | `hydratePrepared`, `write`, `coldSnapshot`, all through `recordFor` |

The two read-only methods no longer take a cut parameter. `inheritedEventCount` is still written into every record and the fold face still compares it on full equality; the original design expectation, that records folded under different fork cuts never seed each other, is unchanged.

In the block the read-only face returns, `asOfSeq` is the lowest watermark among the served rows, the stored record's own position. A header can vouch neither for the cut nor for the comparability of that watermark with the current log, so comparability is not expressed by this number: the Session list adds an independent field `kind` to each summary's `projections` block (`SessionProjectionHints`). A block a cold session's row viewed from projcache is `cached`; a block the Host's live registry computed for an attached session is `sequenced`. The two fields are independent facts: `kind` names the sequence space `asOfSeq` belongs to, and `asOfSeq` is the watermark within that space.

### Why the read-only face may skip the cut

- Within one `formatVersion`, a log's cut is determined by `(id, createdAt, cwd, isSeeded)`: it is fixed at fork creation, and only a cardinality-changing format migration can alter it, which necessarily bumps `formatVersion`. The cut is a derived fact of the lifecycle, not an independent coordinate.
- What the read-only face actually did until now: unseeded callers passed the constant 0 (true by construction) and seeded callers never called. The cut was never compared against any real fact on this face. Removing it changes the rejection set not at all: a record from another lifecycle (any of the four fields differing) is still rejected, unseeded results are identical, and seeded lifecycles go from unaddressable to addressable.
- The read-only face never seeds and never writes back; its output is a pure function of the stored record, the cut plays no part in it, and it flows nowhere.
- The one new exposure: a record whose four fields all match but whose cut differs. The system cannot produce it; only copying a session directory by hand and editing files can. Even then the list shows that record's values until the session is opened, and nothing enters any fold.

### Consumers

| Location | Change |
|---|---|
| `list.ts` `projectionsFor` | drop the `isSeeded` branch and `SessionLogOffset(0)`; every cold row reads `cachedSnapshot(header) ?? cachedPredecessorTitle(header)` |
| `session-reference` `projectedLabels` | same symptom, same change |

### The client store separates cached and sequenced rows

Rows in `ProjectionValueStore` come in two kinds, named for the property the rule depends on: whether the value carries a seq comparable within this connection.

| Row | Meaning | Carries |
|---|---|---|
| `cached` | viewed from the persisted checkpoint without a Session; its seq is not comparable with this connection | `value` only |
| `sequenced` | computed by the Host for this Session within this connection; seqs share one space | `value` and `seq` |

Rules:

| Write | Against a `cached` row | Against a `sequenced` row |
|---|---|---|
| `applyCached(values)` | replaces | ignored |
| `seed(baseline)` | discards every `cached` row first, then writes the block; omitted keys clear under `seq <= cut` | higher-seq-wins |
| `apply(key, value, seq)` | replaces | higher-seq-wins |

Seq comparison happens only within one Host connection: `handleConnected` clears the whole store, then the list writes cached rows again and opening a session seeds again. From cached to sequenced is an unconditional replacement without any seq comparison.

Writer classification:

| Entry | Row kind |
|---|---|
| the `projections` block of each summary in the `session.list` response (`manager.refreshList`) | by the block's `kind`: `cached` for a cold session, `sequenced` for a live one |
| the `projections` block of an `api-session/added` summary (`manager.handleSessionAdded`) | by the block's `kind`; the summary comes from a live session, so in practice `sequenced` |
| the history first page's `projections` (`projections.seed` in `session.ts`) | sequenced |
| the control baseline, live sessions only (`manager.replaceControlBaseline`) | sequenced |
| the `session.projections` result of `refreshProjections` (a body observation) | sequenced |
| push frames (the `projection` frame handled by `manager`) | sequenced |
| the `title` after a successful rename (`session.ts`) | sequenced |

The `seed` and `apply` signatures are unchanged. The client routes by `kind`: a `sequenced` block goes through `apply` key by key, a `cached` block through `applyCached`, which does not read its `asOfSeq`.

### What stays untouched

- The Session format, the physical header line, `fromHeaderLine`, persistence, `SessionPersistenceSnapshot`.
- Hydration and the checkpoint write path; `recordFor` keeps full equality on all five fields.
- `coldSnapshot` stays; having no production caller is not a reason to delete it here.
- Old records (domain v4/v5, lacking `isSeeded` and `inheritedEventCount`) keep missing for seeded sessions until the session is opened and rewritten as a v7 record.
- The list still delivers every row with a wire view (`contextBreakdown`, `turnOutline`, and so on); narrowing that is out of scope.

### Worst case, walked through

1. The list serves a wrong record; the sidebar shows a wrong title, held in a cached row.
2. The session is opened; for the instant before the first-page baseline arrives the wrong value is still shown. Every pre-population has this window.
3. The first-page baseline `seed`s: every cached row is discarded unconditionally, then the block is written. Nothing of the wrong value survives, whatever its seq.
4. A later list refresh writes cached values that hit sequenced rows and are ignored; the wrong value does not come back.

## Alternatives considered

**Write the cut back into the physical header line.** Header-only reads would obtain the cut directly and the read-only face would keep its identity. The cost is another Session format generation right after V4 landed, and reversing #3346's decision that the exact cut does not pose as body-free metadata. Rejected: the header is not changed for this.

**An index of each session's cut maintained by persistence or session-query.** A new durable index with its own consistency maintenance, serving one display read. Rejected.

**Restore a bounded body probe.** The `probeSmallCold` idea #3400 removed, or a client-side asynchronous `refreshProjections` for visible seeded sessions. It breaks the list's zero-I/O principle, and the historical 1KB threshold shows it never covered an ordinary fork. Rejected.

**Only the `asOfSeq: -1` sentinel, without store tiers.** One server-side change makes hints always lose under the seq rule. It rests on a convention: when a hint's seq equals or exceeds the baseline cut (crash-repair truncation), `apply` keeps the old row and the wrong value survives until the next frame. The user requires connected data to replace hints unconditionally, so the rule belongs in the store rather than in a seq convention.

**Express cached through `asOfSeq: -1` and let the client route on the sentinel.** The read-only face always emits `-1` and the client treats every list block as cached. Rejected: one field would carry two meanings, and the second could only be inferred by convention; a live session's list block carries a real seq comparable within the connection, and treating every block as cached demoted those too. The PR review reproduced the regression: a delayed control baseline at a lower cut overwrote a newer list value. The independent field `kind` replaces the sentinel, and `asOfSeq` keeps each source's own watermark.

**Remove the cut from the cache identity entirely.** The fold face needs it: `restore` continues applying from the cached row's state, and `schedule`, `subagentCatalog`, `permissions.seeded`, and owned/inherited classification encode the cut; an error would be written back and persisted. Rejected.

**Naming the row kinds `hint` / `authoritative`.** Those words speak of trust, while the rule depends on seq comparability. Renamed `cached` / `sequenced` so the names state the property the rule uses.

## Consequences

Bought:

- After a restart, forked sessions immediately show their title, `sessionListMetadata` (blank, lastPromptAt), and every other cached wire value in the sidebar, ordered by the last prompt time.
- `@` completion shows and searches forks by title.
- Connected data replaces list hints unconditionally, independent of seq ordering.
- The two levels of the cache identity have names: the lifecycle identity answers "is this the same log", the fold identity answers "may this continue a fold".

Paid:

- `cachedSnapshot` and `cachedPredecessorTitle` change signature; the Session-list and reference callers use the header-only signatures.
- `SessionProjectionHints` gains the required field `kind`; every producer of a list summary and every test fixture that builds one carries it.
- A hand-crafted record with the same four fields and a different cut is displayed in the list until the session is opened.
- Keys the baseline omits clear together with their hints: when a Host does not mount `schedule`, the schedule mark the list hinted disappears after the session opens. Under "connected data is the truth" this is the correct behavior.
- Old records still miss for seeded sessions until an open rewrites them.

## Testing

- `session-projection-cache/tests/cache.spec.ts`: a seeded cold header obtains every version-matching row through `cachedSnapshot(header)` at the row's watermark; an unseeded header is refused for the same id's seeded record; `coldSnapshot` continues from the row when the cut matches, refolds the whole log when it differs, and throws for an unseeded call with a nonzero cut; `cachedPredecessorTitle(header)` serves only `title` from a seeded record of an older `formatVersion`; rows with differing watermarks form one block whose `asOfSeq` is the lowest row.
- `session-projection-cache/tests/fixtures.spec.ts`: archived v3 to v6 records still expose only the predecessor title; lineage-less archives still miss for seeded callers.
- `api/session-controller/tests/session-cold.host.spec.ts`: a seeded cold summary carries `kind: 'cached'`, `title`, and `sessionListMetadata`, `updatedAt` takes `lastPromptAt`, the cache is queried, and the body is not read.
- `api/session-controller/tests/session-projections.host.spec.ts`: a real fork made through `sessions.fork` is checkpointed into projcache, the whole Context is disposed, and a Host restarted over the same storage root reads the `kind: 'cached'` `title` and `sessionListMetadata` through `session.list` from the header alone; `inspect` and `open` are never called.
- `api/session-controller/tests/projection-store.client.spec.ts`: `applyCached` fills empty keys only and never displaces a sequenced row; every sequenced write (including a frame at cursor `-1` and a baseline at a lower cut) replaces cached rows; a baseline discards all cached rows before clearing omitted keys; face subscribers are notified on cached fills and their discard. Manager path: a `cached` list block at any watermark is replaced by a control baseline at a lower cut, and a later list refresh cannot bring it back; a `sequenced` list block merges under higher-seq-wins, so a delayed baseline at a lower cut neither overwrites nor clears it while a higher-seq frame still advances it.
- `api/session-controller/tests/manager.client.spec.ts`: a `cached` `api-session/added` block is replaced by a control baseline at the same cursor; a `cached` list block does not displace an existing sequenced title.
- `api/session-controller/tests/inbox-projection.client.spec.ts`: unchanged; a live session's `sequenced` list block still outranks a delayed control baseline at a lower cut.
- `context/session-reference/tests/session-reference.spec.ts`: a seeded cold session is labeled and searchable by its cached title, a session without a cache record is still labeled by id, and neither reads a log.
