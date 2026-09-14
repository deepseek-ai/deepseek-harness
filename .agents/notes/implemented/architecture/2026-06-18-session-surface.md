# Agent Note: Session surface — an ordered projection over the event log

Status: implemented

English | [中文](2026-06-18-session-surface.zh.md)

## Problem

The event log is authoritative, but history manipulation had no durable shared mechanism. Without one, plugins such as compaction would rewrite derived requests through order-sensitive listeners without recording which events each replacement used. Every new history manipulation would also require changes to `deriveMessages()`.

## Decision

Add a **surface** — a derived, cached order of event sequences (the subset of events that produce LLM messages) — maintained by `surfaceOp` markers in the event log.

### Top-level surface metadata on `SessionEvent`

Surface metadata belongs only to the four surface event types (`system/message`, `user/message`, `assistant/message`, `tool/result`):

- **`sourceEventSeqs?: SessionSeq[]`** — seq numbers of earlier events cited as sources, such as a `tool/call` cited by its result or surface nodes shadowed by a compaction marker. A present list is non-empty, unique, earlier, and known. `assistant/message` embeds its provider stream and cannot carry this field. Without cited seqs, replay cannot validate that a replace-range operation names every event it removed.
- **`surfaceOp: SurfaceOp`** — required placement for every surface event. Known log-only events forbid both metadata fields; native unknown or obsolete ignorable envelopes remain opaque.

### SurfaceOp: two operations

The [source-backed `SurfaceOp` reference](../../../../docs/subsystems/session.md#surface-types) defines the exact union. Replacement objects contain only `op`, `startSeq`, and `endSeq`; endpoints use the `SessionSeq` brand.

1. **Append** — add the new event seq to the tail. Used by `system/message`, `user/message`, `assistant/message`, `tool/result`. The loop passes `surfaceOp: 'append'` on all such appends and records `sourceEventSeqs` where applicable: `tool/result` records its `tool/call` source, while `assistant/message` owns its embedded stream directly.

2. **Replace** — remove entries from `startSeq` through `endSeq` (both inclusive) and insert the new event seq in their place. Both `startSeq` and `endSeq` must be present in the current surface; `startSeq === endSeq` replaces one entry. The event's `sourceEventSeqs` must contain every shadowed surface seq. The shadowed events remain in the log but are no longer on the surface.

### SurfaceManager: delta-based, not full rebuild

A `Session` owns one `SurfaceManager` that maintains an ordered `SessionSeq[]` of event seqs. The manager validates each seed or append candidate without applying it before commit, then processes only committed events since its previous synchronization rather than rescanning the entire log. `Session.surface` exposes the same manager through the readonly `SessionSurface` contract, so acceptance, derived history, compaction, and workspace context share one incremental state. Replace locates its inclusive endpoints by array position and splices the replacement seq into that range; no second manager, link objects, or seq-to-node map duplicates the order.

Delta processing is O(1) when no new events and O(new events) when new events arrive.

`deriveMessages()` walks the surface as its sole derivation path. A surface event without its required marker is invalid, not an implicit append.

### Persistence

The fields are serialized as top-level JSON properties. JSONL preserves placement and source-event references without a separate column mapping. The [V3 canonical-envelope decision](2026-09-06-v3-canonical-session-envelopes.md) owns exact replacement keys and strict-acceptance rationale; the [V2-to-V3 specification](../../../../packages/session/session-format-v2-to-v3/README.md#canonical-envelopes) owns historical conversion. This note retains ordered-projection ownership and replacement rationale.

### Crash recovery

The `repair.ts` module synthesizes `tool/result` closers for orphaned tool calls after a crash. These closers carry `surfaceOp: 'append'` and `sourceEventSeqs` pointing to the orphaned `tool/call` event, so the rehydrated surface is valid.

### Invariants

`Session` validates `sourceEventSeqs` and `surfaceOp` at the always-on seed/append boundary: source lists are non-empty, unique, earlier, and known; `assistant/message` carries no source list; replacement endpoints exist in surface order; and `sourceEventSeqs` covers every shadowed node. These are single-record acceptance and storage-projection rules, not optional invariant-service contributions.

Every surface-eligible event must carry `surfaceOp` or it would disappear from derived history. Typed `append` overloads enforce this for literal event types; runtime checks in `append` and the seed constructor cover widened unions and current loaded logs. Released validation and conversion belong to their versioned migration edges rather than generic Session code; see the [V2-to-V3 placement rules](../../../../packages/session/session-format-v2-to-v3/README.md#canonical-envelopes).

## Alternatives considered

- **Per-plugin `agent/request` wrapping** (the pre-surface pattern for history manipulation) — listener-ordering fragility, no durable record of what was changed, and every new manipulation forces another change to core `deriveMessages()`.
- **Half-open `[start, endExclusive)` replace ranges** — rejected: endpoints are named by surface event seqs, and single-entry replacement (`startSeq === endSeq`) reads naturally with inclusive semantics.
- **Linked node objects plus a seq map** — rejected: production did not read predecessor links, the only successor use was the next array position, and replacement already required linear `indexOf` lookup. A single seq array preserves the same asymptotic behavior with one representation to validate.
- **Full rebuild behind a dirty flag** instead of delta processing — O(N²) over a session's lifetime: every single-event append would rescan all prior events.

## Consequences

- **`packages/core/session`**: `surface.ts` (`SurfaceManager`) maintains one ordered seq array for candidate acceptance and live projection; `SessionSurface` is its readonly public view. `SurfaceOp`/`SurfaceIntent` and the top-level session-event fields record how entries join it. `append()` requires a `SurfaceIntent` for surface events, `deriveMessages()` walks the surface as the sole derivation path, and `repair.ts` emits surface-aware closers. The seed constructor rejects a surface-eligible seed event missing its `surfaceOp` marker (see § Invariants).
- **`packages/core/agent-loop`**: All surface-capable appends pass surface opts. Each `assistant/message` embeds its exact provider stream and forbids `sourceEventSeqs`; each `tool/result` cites its `tool/call` seq.
- **`packages/session/session-persistence-jsonl`**: Persists canonical surface metadata and restores current events through validated format preparation.
- **`packages/session/session-persistence`**: Keeps storage ownership separate from the in-memory surface projection.

The surface is the foundation history manipulation ships on — dsh-compaction's compaction rides it. A compaction or tool-result-pruner plugin appends one of the existing message-producing event types (a `user/message` carrying the summary, say) with `surfaceOp: { op: 'replace', startSeq, endSeq }` and `sourceEventSeqs` covering the shadowed entries — the new event takes the range's place on the surface while the plugin's own trace events (e.g. `compaction/start`, `compaction/end`) stay off it. Replay preserves the decision deterministically.

A `tool/result` replacement may rewrite exactly one current `tool/result` and must preserve every data field except `content`. Session acceptance enforces this rule together with positional range and cited source-event validation, independent of optional diagnostic plugins.
