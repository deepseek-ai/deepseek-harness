# Agent Note: Session surface — an ordered projection over the event log

Status: implemented

English | [中文](2026-06-18-session-surface.zh.md)

## Problem

The event log is authoritative, but history manipulation had no durable shared mechanism. Without one, plugins such as compaction would rewrite derived requests through order-sensitive listeners without recording which events each replacement used. Every new history manipulation would also require changes to `deriveMessages()`.

## Decision

Add a **surface** — a derived, cached order of event sequences (the subset of events that produce LLM messages) — maintained by `surfaceOp` markers in the event log.

### Two new top-level fields on `SessionEvent`

Every `SessionEvent` gains two optional fields (structural metadata, like `seq`/`time`):

- **`sourceEventSeqs?: number[]`** — seq numbers of earlier events cited as sources, such as a `tool/call` cited by its result or surface nodes shadowed by a compaction marker. A present list is non-empty, unique, earlier, and known. V2 `assistant/message` embeds its provider stream and cannot carry this field. Without cited seqs, replay cannot validate that a replace-range operation names every event it removed.
- **`surfaceOp?: SurfaceOp`** — how this event entered the surface. Absent for non-surface events.

### SurfaceOp: two operations

```ts
export type SurfaceOp =
  | 'append'                                    // normal tail append
  | { op: 'replace'; start: number; end: number }  // shadow [start, end] inclusive
```

1. **Append** — add the new event seq to the tail. Used by `user/message`, `assistant/message`, `tool/result`, `context/message`. The loop passes `surfaceOp: 'append'` on all such appends and records `sourceEventSeqs` where applicable: `tool/result` records its `tool/call` source, while `assistant/message` owns its embedded stream directly.

2. **Replace** — remove entries from `start` through `end` (both inclusive) and insert the new event seq in their place. Both `start` and `end` must be present in the current surface; `start === end` replaces one entry. The event's `sourceEventSeqs` must contain every shadowed surface seq. The shadowed events remain in the log but are no longer on the surface.

### SurfaceManager: delta-based, not full rebuild

A `Session` owns one `SurfaceManager` that maintains an ordered `number[]` of event seqs. The manager validates each seed or append candidate without applying it before commit, then processes only committed events since its previous synchronization rather than rescanning the entire log. `Session.surface` exposes the same manager through the readonly `SessionSurface` contract, so acceptance, derived history, compaction, and workspace context share one incremental state. Replace locates its inclusive endpoints by array position and splices the replacement seq into that range; no second manager, link objects, or seq-to-node map duplicates the order.

Delta processing is O(1) when no new events and O(new events) when new events arrive.

`deriveMessages()` uses the surface when surface markers exist, falling back to the existing linear scan for sessions without markers (backward compatibility).

### Persistence

The new fields are serialized as top-level JSON properties. JSONL storage requires no separate column mapping: its lossless JSON boundary preserves both values. Released v0 and v1 share this surface representation, and the identity v0-to-v1 edge preserves it exactly; a future structural representation change increments `SESSION_FORMAT_VERSION` and owns an adjacent migration.

### Crash recovery

The `repair.ts` module synthesizes `tool/result` closers for orphaned tool calls after a crash. These closers carry `surfaceOp: 'append'` and `sourceEventSeqs` pointing to the orphaned `tool/call` event, so the rehydrated surface is valid.

### Invariants

`Session` validates `sourceEventSeqs` and `surfaceOp` at the always-on seed/append boundary: source lists are non-empty, unique, earlier, and known; `assistant/message` carries no source list; replacement endpoints exist in surface order; and `sourceEventSeqs` covers every shadowed node. These are single-record acceptance and storage-projection rules, not optional invariant-service contributions.

Every surface-eligible event must carry `surfaceOp` or it would disappear from derived history. Typed `append` overloads enforce this for literal event types; runtime checks in `append` and the seed constructor cover widened unions and current loaded logs. Historical v0 validation and normalization belong to the v0-to-v1 edge rather than generic Session code.

## Alternatives considered

- **Per-plugin `agent/request` wrapping** (the pre-surface pattern for history manipulation) — listener-ordering fragility, no durable record of what was changed, and every new manipulation forces another change to core `deriveMessages()`.
- **Half-open `[start, endExclusive)` replace ranges** — rejected: endpoints are named by surface event seqs, and single-entry replacement (`start === end`) reads naturally with inclusive semantics.
- **Linked node objects plus a seq map** — rejected: production did not read predecessor links, the only successor use was the next array position, and replacement already required linear `indexOf` lookup. A single seq array preserves the same asymptotic behavior with one representation to validate.
- **Full rebuild behind a dirty flag** instead of delta processing — O(N²) over a session's lifetime: every single-event append would rescan all prior events.

## Consequences

- **`packages/core/session`**: `surface.ts` (`SurfaceManager`) maintains one ordered seq array for candidate acceptance and live projection; `SessionSurface` is its readonly public view. `SurfaceOp`/`SurfaceIntent` and the top-level session-event fields record how entries join it. `append()` requires a `SurfaceIntent` for surface events, `deriveMessages()` walks the surface as the sole derivation path, and `repair.ts` emits surface-aware closers. The seed constructor rejects a surface-eligible seed event missing its `surfaceOp` marker (see § Invariants).
- **`packages/core/agent-loop`**: All surface-capable appends pass surface opts. Each `assistant/message` cites its chunk seqs; each `tool/result` cites its `tool/call` seq.
- **`packages/session/session-persistence-jsonl`**: No changes required.
- **`packages/session/session-persistence`**: Abstract interface unchanged.

The surface is the foundation history manipulation ships on — dsh-compaction's compaction rides it. A compaction or tool-result-pruner plugin appends one of the existing message-producing event types (a `user/message` carrying the summary, say) with `surfaceOp: { op: 'replace', start, end }` and `sourceEventSeqs` covering the shadowed entries — the new event takes the range's place on the surface while the plugin's own trace events (e.g. `compaction/start`, `compaction/end`) stay off it. Replay preserves the decision deterministically.

A `tool/result` replacement may rewrite exactly one current `tool/result` and must preserve every data field except `content`. Session acceptance enforces this rule together with positional range and cited source-event validation, independent of optional diagnostic plugins.
