# Agent Note: Subagent list identity via the projection unit

Status: implemented

English | [中文](2026-08-06-subagent-list-identity-projection.zh.md)

## Problem

Before the rewrite, `SubagentRuntime.listChildren` ran two full-log materializations — `listEvents` plus `readEvent` — on every listing for each direct child with `header.origin === 'subagent'`, each materialization accompanied by a full-log structuredClone, all to fold two fields, mode and label, out of the descriptor event. The descriptor's position in the log is not fixed — the fork prefix is arbitrarily long, and zstd-compressed frames carry no seq index — so there is no shortcut to locating it; this path had no cache whatsoever, and its cost amplifies with transcript length × child count × listing frequency. It also dragged session-query in as a hard dependency of listing: in a deployment without a query backend, `list_agents` rejects wholesale with `SUBAGENT_CONTROL_SESSION_QUERY_UNAVAILABLE`, even though enumeration needs nothing but header facts.

The same root cause has a second symptom: on every Agent-bound RPC's owner check, the host-side `hasSubagentDescriptor()` scans the target session's own suffix, even though `SessionHeader.origin` already answers the vast majority of the same question.

The root cause is that the [durable-subagent-catalog decision](../feature/2026-07-22-durable-subagent-catalog-and-list-agents.md) made the descriptor event (`subagent/descriptor`) the catalog's sole durable authority yet paired descriptor reads with no cache layer, and explicitly accepted the per-child double read as the "no-index correctness baseline". [Web subagent conversations](../feature/2026-07-27-web-subagent-conversations.md) (#1569) already put "is this a subagent" into the header (`SessionHeader.origin`), so identity determination no longer reads the log; mode and label still had to be scanned.

## Decision

mode and label are folded by the `subagent` projection unit (pure identity, two arms), and the unit is the sole authority over the fold rules. Enumeration uses the shared Session query corpus, while value retrieval walks a three-rung compute-and-discard ladder: a live child synchronously reads the registry's existing watermark cache (zero log reads); an unseeded cold child may use the optional `sessionProjectionCache` checkpoint because its exact inherited cut is known to be zero; every seeded child and every cache miss pays one body-bearing Session observation plus a fold through the registered `subagent` unit. No index, no cache of its own, no list-side write-back.

There are three families of escape from the per-child scan: promote mode/label into the header (the write path pays); build a durable derivation for the projection (a checkpoint ladder, or values landed during query-index rebuild with read-side reconciliation); or compute at read time (live from the watermark cache, cold from one full read). This note takes the third. "Values landed with the query index" was retired wholesale: query infrastructure was forced to learn domain vocabulary while the sole consumer is satisfied by read-time computation — the live child's zero reads come for free from session-projection's existing watermark cache, and the cold child's single full read is explicitly accepted as compute-and-discard. The first two routes and the retirement rationale are detailed under Alternatives considered.

Key points:

- **The subagent list uses the Session query corpus for enumeration and body-bearing observations**: mode/label still comes through `ctx.sessionProjections`, and the list owns no descriptor parser or domain index.
- **Value retrieval is a three-rung compute-and-discard ladder**: a live child reads `sessionProjections.snapshot(session, ['subagent'])` (the registry's existing watermark cache, zero log reads); an unseeded cold child may read `sessionProjectionCache.cachedSnapshot(header, SessionLogOffset(0), ['subagent'])`; a seeded child or cache miss pays one Session observation carrying `inheritedEventCount` plus a fold through the registered `subagent` unit. Beyond that, absent is absent — no cache of its own, no list-side write-back, no index.
- **The `subagent` projection unit is the sole authority over the fold rules**: live and cold snapshots both run the one registered unit; no second copy of descriptor-interpretation logic exists.
- **The descriptor (v2) remains untouched**. Session, persistence, projection cache, and query now carry the exact inherited cut separately from the logical header; pre-existing data acquires exact values through one body-bearing observation when listing cannot prove a zero cut — no degraded unknown state and no durable format migration.

Relationship to existing notes:

- This note supersedes two designs on the list read path in [durable-subagent-catalog](../feature/2026-07-22-durable-subagent-catalog-and-list-agents.md): enumeration through `sessionQuery.traceSession`, and per-child descriptor-event reads (the `listEvents`-plus-exact-`readEvent` double read with in-place diagnostic classification). The diagnostic row semantics is retained, with classification now derived by the list from projection-value absence and activity; the descriptor event remains the sole durable authority for mode/label and the fold input, and the resume authorization and Activation contracts are untouched. This is partial supersession; the two notes stay cross-linked.
- The [session-projection RFC](../../proposed/architecture/2026-07-27-session-projection-and-command-log.md) is the authority for the registry contract, split by the later [state-and-client-views note](2026-08-19-session-projection-state-and-client-views.md); this note adds the client-visible `subagent` identity unit and consumes it through live and cold snapshots. The fold rules are registered with the registry exactly once; every consuming surface computes through the one registered unit, and no second copy of the fold logic exists.

### `subagent` projection unit

It hangs beside the existing `subagentTiming` ([projection.ts](../../../../packages/subagent/subagent/src/projection.ts), [projection-types.ts](../../../../packages/subagent/subagent/src/projection-types.ts)), under key `subagent`. Both units provide client wire views; the identity unit keeps an optional wrapped host value and maps its absence to the client sentinel:

```ts ignore-check
export type SubagentIdentityProjection =
  | { mode: 'one-shot'; label?: string; seq: SessionSeq }
  | { mode: 'continuable'; label: string; seq: SessionSeq }

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    subagent: { identity?: SubagentIdentityProjection }
  }
  interface SessionProjectionMap {
    subagentTiming: SubagentTimingProjection
    subagent: SubagentIdentityProjection | null
  }
}
```

- The projection is pure identity, and **the projection system has no failure channel**: a unit never throws; a corrupt payload or an unrecognized version folds exactly like a log with no descriptor at all. The host checkpoint state is the serializable wrapper `{ identity?: SubagentIdentityProjection }`; absence is `{}`. Its client view is the non-optional `SubagentIdentityProjection | null` entry. `null` passes JSON losslessly, so a pushed reset replaces a stale identity instead of being dropped by stringify. The judging discipline: consuming surfaces treat null and an absent client key alike as no value. How "computed to nothing" is presented is the consumer's own business (see the `listChildren` four-state mapping below).
- Label strength is decided by the descriptor schema: a continuable's label is mandatory at parse, a one-shot's was always optional; the mode/label discriminant matches the child row's strong contract below exactly (the row carries no `seq` — it is the projection's internal own-suffix proof).
- The identity carries branded `seq`: the seq of the `subagent/descriptor` event it was folded from, mandatory on both arms and absent on the null sentinel. A live Session checks it through `isOwnSeq()`; a cold body-bearing observation compares it with `inheritedEventCount`. Header-only seeded candidates skip the cache because the header intentionally exposes no integer cut; unseeded candidates know the cut is zero. The unit maps the wrapper's validated identity to its client wire view and is checkpointed like every unit (the `persist` opt-in is gone); its `stateVersion` is 2, bumped when `seq` was added. Existing older checkpoint rows are invalidated by version mismatch per the registry contract, falling to the authoritative refold.
- Fold rule: `subagent/descriptor` is last-wins, under the same descriptor-reset discipline as `subagentTiming` — ancestor descriptors in the fork prefix are overridden by the session's own descriptor. A corrupt or unrecognized-version payload is last-wins all the same: it resets to the null sentinel rather than keeping the prior identity, so a fork of a healthy ancestor does not inherit an identity its own descriptor cannot stand up.

### Enumeration: query corpus with live preference

`listChildren` ([list-children.ts](../../../../packages/subagent/subagent/src/list-children.ts)) asks `sessionQuery.listSessions()` for the canonical live-preferred corpus, then pairs each listed id with `ctx.sessions.get(id)` when a live Session exists. The live header overrides the listed header for that id. Everything enumeration needs is header facts:

- Filtering: `header.origin === 'subagent' && header.parentSession === parentSessionId`.
- `hasChildren`: the same merged material, looked at one level down — a direct descendant exists with `origin === 'subagent'` whose `parentSession` is that child.
- `activity`: a live record is `running`; one present only in persistence is `inactive`.
- Ordering: `createdAt` ascending, then child id ascending (matching the old contract).
- An absent `sessionQuery` service fails with `SUBAGENT_CONTROL_QUERY_UNAVAILABLE`; the shared query corpus owns whether a deployment can enumerate live-only or persisted Sessions.
- A query-corpus failure fails the whole enumeration; per-child isolation applies only to per-child cold observations.

### Value retrieval: the three-rung compute-and-discard ladder

For each enumerated child, mode/label retrieval walks a three-rung ladder — compute-and-discard, no cache of its own, no write-back (the third rung is the same shape as apiproxy `session.history`'s cold read):

| Rung | Read | Cost |
| --- | --- | --- |
| 1: live child | `ctx.sessionProjections.snapshot(session, ['subagent'])` | Zero log reads — the registry's existing watermark cache, synchronous retrieval |
| 2: unseeded cold child, cache hit | The optional `sessionProjectionCache.cachedSnapshot(header, SessionLogOffset(0), ['subagent'])`; every valid seq is owned when the exact cut is zero | Zero log reads |
| 3: seeded child or cold fallback | One body-bearing `sessionQuery.observeSession(id)` + the registered `subagent` projection, with `inheritedEventCount` available for the own-suffix check | One full read computed per listing |

- Error contract: `sessionProjections`, the Session store, and `sessionQuery` are required runtime services for listing. Their explicit failures are `SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE`, `SUBAGENT_CONTROL_SESSION_STORE_UNAVAILABLE`, and `SUBAGENT_CONTROL_QUERY_UNAVAILABLE`; no empty result disguises a missing classification or corpus capability.
- The cache is a purely optional acceleration layer: an absent service is skipped on a null check — no error code, no part in configuration validation (in contrast to `sessionProjections`, a required injection). A seeded header skips this rung because it cannot supply the cache identity's exact cut without a body read. For an unseeded child, anything the second rung throws (including a poisoned unit row detonating `viewCheckpoint`) silently falls to the third rung — the cache is derived data, so its faults never produce a `corrupt` verdict; the final judgment belongs to the authoritative refold. A row whose checkpoint cut predates the descriptor, an absent key, or a null sentinel likewise falls through.
- Per-child isolation: a single child's failed cold full read only turns that row into an `unavailable` diagnostic, naturally retried on the next listing, without affecting siblings (see the four-state mapping).
- The cold path's lifecycle witness: the observation must still point at the lifecycle that was enumerated. The witness fields are version, id, createdAt, cwd, parentSession, isSeeded, delegationDepth, origin, and agentPreset; a Session deleted and republished under the same id degrades to a `corrupt` row in the old parent's catalog, leaking nothing of the new owner's child.
- Cold-read concurrency is bounded by the constant 4 — it constrains a read-only scan of local media, not deployment behavior; when a networked persistence backend appears, it is promoted to a validated `Config` field.
- The cold-read cost, recorded honestly: every seeded child and every unseeded cache miss pays one full query observation per listing, at a cost proportional to its transcript size; the settled stance is compute-and-discard, and no cache of its own is built. The observation may reuse the query/persistence preparation layer, but listing does not depend on that optimization. A live child reads zero log throughout.
- Cancellation: the caller's signal is checked before and after each persistence read, and a read that settles only after abort is rejected, normalized to the stable error code `CANCELLED`.

### Authority model

- The session log is the sole authority; this design adds no domain index, checkpoint of its own, or in-process memo. The `sessionProjectionCache` checkpoint the second rung reads is an existing composition item's derived data, which the list only reads. Values are computed on read and discarded. Seeded candidates use a body-bearing observation to classify the identity against the exact cut; unseeded cached identities need no seq gate because every valid seq is owned.
- The Session and persistence write paths are entirely unaware of listing and projection consumption: no event-listener write-back, no fold-on-write.
- Enumeration and value retrieval constitute no second authorization source and make no unpublished child visible — the two sources see only published live records and durably written persisted records, consistent with the rule the durable-subagent-catalog note laid down for derived read surfaces.

### `listChildren` row shape and consuming surfaces

The `SubagentListEntry` **data structure is identical to before the rewrite** — the child and diagnostic arms, the `kind` discriminant, the three-valued `reason`, and the child arm's strong mode/label contract are all retained; the only change is the diagnostics' information source: the projection system has no failure channel, so diagnostics are derived by the list from projection-value absence and activity, and the list itself parses zero events. The "no value means await the hard read" rule guarantees the ladder always computes mode/label for healthy data.

```ts ignore-check
export type SubagentListEntry =
  | ({
    readonly kind: 'child'
    readonly id: SessionId
    readonly activity: 'running' | 'inactive'
    readonly hasChildren: boolean
  } & (
    | { readonly mode: 'one-shot'; readonly label?: string }
    | { readonly mode: 'continuable'; readonly label: string }
  ))
  | {
    readonly kind: 'diagnostic'
    readonly id: SessionId
    readonly reason: 'corrupt' | 'unsupported' | 'unavailable'
  }
```

For each enumerated child, the ladder's result maps to a row through four states:

| Ladder result | Row |
| --- | --- |
| Snapshot carries a non-null `subagent` identity | child row |
| Snapshot present, `subagent` null sentinel or key absent, and the child is **inactive** | diagnostic row, reason `corrupt` (settled debris: a missing, corrupt, or unrecognized-version descriptor, no longer subdivided) |
| Snapshot present, `subagent` null sentinel or key absent, and the child is **running** | no row (creation window: the descriptor is not yet appended — the same window the old implementation omitted) |
| The cold full read fails | diagnostic row, reason `unavailable` |

- `unsupported` is no longer produced: the type and the wire enum retain the member under "data structures stay as they are", and this note records it as no longer produced.
- Descriptor-less settled debris moves from the old implementation's omit into the `corrupt` diagnostic — damaged, dead child sessions in the corpus are visible rather than silently vanishing, which is exactly the original motivation for keeping diagnostics.
- The list selects only the `subagent` wire unit, whose fold never throws: a corrupt or unrecognized-version payload folds to the null sentinel, which the four-state mapping turns into that child's `corrupt` row (a deterministic data fault, aligned with the old implementation's `SESSION_QUERY_CORRUPT_SESSION`→`corrupt` mapping semantics). Live and cold are treated alike, isolation is per-child, and siblings and the listing itself are unaffected. It is orthogonal to "value absent + running → omit": the creation window means "no data yet", a fold to nothing means "the data is bad" — a poisoned running child also gets a `corrupt` row rather than an omit.

Known boundary deviations (deliberately accepted, recorded with this note):

- Multiple descriptors in the own suffix: the old implementation judged corrupt; last-wins now takes the final one (the provider contract guarantees exactly one anyway).
- A live/persisted header conflict: the old implementation made it per-child corrupt; enumeration now prefers live with no consistency check, the conflict goes unnoticed, and the live record forms the row.
- A source-read failure on damaged storage (e.g. a bad surface rejected by the cold full read): the old implementation mapped it to per-child `corrupt`; it is now uniformly an `unavailable` row (the read side cannot tell the causes apart).
- An unknown parent: the old implementation threw not-found through session-query ('parent session … was not found'); the subagent-owned merge now yields an empty subset for a nonexistent parent, enumeration returns an empty list, and later operations on the wire land as child-level subagent-not-found — a silent change of semantics and wording, recorded as explicitly accepted.
- Rung 2's later-event window applies only to an unseeded child: a cache row lands right after the first descriptor, the log then appends a second descriptor (or a malformed payload setting the null sentinel), and the process crashes before the next checkpoint. Cold listing can keep serving the old identity until a live run or cache write replaces the row. The precondition violates the provider's append-exactly-once contract and also requires missing every mandatory checkpoint; healthy children are unaffected. Seeded children never take rung 2 without the body-owned cut.

Consuming surfaces keep the same row and diagnostic wire shape. `list_agents` reaches the required query corpus plus projection registry; live identities come from the registry snapshot and cold identities from cache or query observation. Host ownership still uses `header.origin`, and history uses the shared live/cold Session query sources; no consumer parses descriptor events independently.

### Change footprint

| Area | Files | Change |
| --- | --- | --- |
| subagent | projection.ts, projection-types.ts, index.ts | New client-visible `subagent` unit and its registration |
| subagent | list-children.ts and its types | Query-corpus enumeration plus the projection-ladder four-state mapping; required projections/query services and optional projection-cache acceleration |
| host/apiproxy | Session controller/query integration | Owner checks use `header.origin`; live/cold history and listing consume the shared query and projection sources |
| tool | tool-subagent-control/list-agents.ts | Model-visible schema, description, and rendering remain unchanged |
| wire/client | api/subagents.ts, runtime sessions/service.ts, GUI | Types, row shape, and diagnostic handling **unchanged**; api/subagents.ts only reworded the `history` JSDoc to the dual arm |
| core/session, session-persistence, session-projection(-cache), session-query(-sqlite) | body-bearing cut and branded seq plumbing | Logical headers expose `isSeeded`; Session, persistence observations, cache identity, and query records carry exact `inheritedEventCount` separately |

## Alternatives considered

**mode/label into SessionHeader.** The strongest zero-read guarantee — rows form from the header alone. But a header change propagates into the persistence provider and compatibility check; pre-existing JSONL can only degrade to unknown or be backfilled. Read-time computation's answer for pre-existing data is "one `inspect` computation on first listing", touching no durable format.

**The projection-cache ladder (`cachedSnapshot ?? cold fold` plus fail-soft write-back).** The mechanism works — session-projection-cache's checkpoint ladder is designed for cold reads in the first place. But checkpoint write-back is a whole list-driven body of derived-data persistence and invalidation orchestration (floor/identity/putSoft); what was rejected is that orchestration as the primary mechanism. The settled three-rung ladder later reuses this cache opportunistically, read-only, as its second rung — no write-back, no orchestration, skipped when absent.

**A bounded-read primitive on persistence to rescue pre-existing data.** Opens a new persistence primitive for a one-time problem; superseded by the read-time `inspect` full read — the full read the first time pre-existing data is listed is itself the value retrieval.

**Optional mode/label on list rows.** Healthy data is always computable; optionality merely spills garbage-data handling complexity onto every consumer — each consuming surface has to grow filter branches and an unknown display state. The strong contract plus omit-when-uncomputable is cleaner.

**Deleting diagnostic rows outright.** Deletion turns corpus-corruption visibility into rows silently vanishing, and wire/tool/GUI would each have to absorb contract and snapshot changes; retention only asks the list side to derive the classification from projection-value absence and activity, at zero cost. That damaged, dead child sessions in the corpus must be visible is the original motivation for diagnostics' existence, and with retention the consuming surfaces stay wholly unchanged.

**A registry computation failure channel (per-unit fault tolerance plus a supplementary `failures` field).** To report corruption and unrecognized versions to consumers, the registry would catch unit exceptions and attach a per-key failure state beside the snapshot. Rejected: a failure is not a value and needs no channel — a unit never throws, absence is itself the signal, worst case the computation comes back empty, and how that is presented is the consumer's problem. An independent observation: the vendored Cordis `emit` ([vendor/cordis/src/events.ts](../../../../vendor/cordis/src/events.ts)) catches nothing a listener throws, so with the projection driver hanging off `session/event`, a unit exception would escape along emit — which adds weight to the "a unit never throws" discipline, but fixing emit fault tolerance is outside this note's scope.

**Values landed with query index preparation.** Projection values folded into session index rows during the sqlite backend's reconciliation rebuild, for zero log reads in the steady read state: the `projectionsFor` bulk read face, the invalidation reconciliation of row values stored against the `(key → stateVersion)` registration set, and the SCHEMA bump. Retired wholesale: the direction was backwards — query infrastructure was forced to learn domain vocabulary (projection columns, registration-set reconciliation) while the sole consumer, the subagent list, is satisfied by read-time computation; with consumers down to zero, this derived persistence has no reason to exist. `SESSION_QUERY_PROJECTIONS_UNAVAILABLE` was deleted along with the read face.

**Subagent hand-rolled parsing plus an in-process memo plus creation seeding.** To excise the session-query dependency, the subagent package would parse descriptor events itself, avoid repeated full reads with an in-process memo, and seed initial values at creation. Superseded by the shipped ladder: live goes through the `sessionProjections` watermark cache and cold through the registered unit's fold, reusing the registry's single fold authority — no second copy of descriptor-interpretation logic appears, and no process-state cache or seeding ordering is introduced.

**DeepReadonly on the session-query output surface (a read-path overhaul experiment).** Make the public query outputs deeply readonly to pin immutable borrowing at the type level. Rejected on evidence: 3 TS2589 occurrences (excessively deep type instantiation) plus 17 sites of array-position contagion (consumers' array methods and spread sites forced to follow); deep immutability is guaranteed by core/session's runtime deep freeze, and that read-path overhaul is not part of this note.

## Verification

`packages/subagent/subagent/tests/list-children.spec.ts` pins this contract: live identity checks use `Session.isOwnSeq()`; an unseeded cold identity may use the cache at cut zero; seeded candidates skip that cache rung and use an observation carrying `inheritedEventCount`; ancestor identities fail the own-suffix check; absent, null, poisoned, and unavailable cache/observation cases fall through or produce the documented diagnostic; lifecycle tampering degrades to `corrupt` across the complete witness field set. The existing keyless snapshots keep the healthy wire and model-visible surfaces fixed, while `subagent-diagnostic` pins diagnostic classification.

## Consequences

- Listing a live child reads zero log throughout; with the cache unmounted or missed, a cold child pays one full `inspect` read per listing, at a cost proportional to its transcript size and repeated with listing frequency — compute-and-discard is the settled stance: no cache of its own is built, nothing is written back, and short-term repeated full reads of the same id can hit the preparation-phase LRU, though listing does not depend on it.
- The subagent list requires the Session query corpus and projection registry; missing services fail explicitly instead of producing incomplete rows. The optional projection cache changes only the number of body reads.
- Identity interpretation exists only in the single unit registered with the registry: the list's three-rung ladder and GUI history's cold read use its live, cached, or observed wire snapshots, and no hand-written bypass fold exists; if some future consuming surface bypasses the unit with a hand-written fold, values will drift across read faces — a discipline this design requires be maintained, not a mechanical guarantee.
- Per-child isolation is back: a single child's cold-read failure loses only that row and healthy siblings are unaffected; a persistence listing failure still fails the whole enumeration.
- The diagnostic and enumeration semantics leaves five boundary deviations (multiple descriptors resolving to the last, header conflicts going unnoticed, damaged-source read failures changing classification, an unknown parent yielding an empty list instead of not-found, and the unseeded rung-2 later-event window). Seeded ancestor identities are no longer a deviation because body-bearing reads compare them with `inheritedEventCount`; resume authorization remains unaffected.
- Pre-#1569 data without `origin` is no longer recognized as a subagent owner; it never entered the catalog anyway, and pre-release carries no compatibility promise.

## Related

- [Durable subagent catalog and list_agents](../feature/2026-07-22-durable-subagent-catalog-and-list-agents.md) — partially superseded by this note: the descriptor remains the durable authority for mode/label and the fold input, while value retrieval moves to the projection ladder over the shared query corpus.
- [Session projections and command lifecycle logging](../../proposed/architecture/2026-07-27-session-projection-and-command-log.md) — the authority for the registry contract; this note adds the `subagent` identity unit and consumes its live and cold wire snapshots.
- [Session projection state and client views](2026-08-19-session-projection-state-and-client-views.md) — the state/client split; both `subagent` and `subagentTiming` provide client wire views.
- [Session projections as a required seam](2026-08-19-session-projection-mandatory-seam.md) — `sessionProjections` becomes a required injection; the list's error contract follows it (registry absence is an activation-time failure, and the projection error code is deleted).
- [Web subagent conversations](../feature/2026-07-27-web-subagent-conversations.md) — the origin of `SessionHeader.origin` (#1569), the first half of taking identity determination off the log; its history cold read (inspect prefix plus registry fold) is the same-shape precedent for this note's value ladder.
- [Reusable Session preparation before publication](2026-08-05-session-preparation.md) — the `inspect()` cold read and LRU reuse; the cold child's full-read cost model builds on it.
