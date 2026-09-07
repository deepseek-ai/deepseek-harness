---
description: "Frozen released-v1 Session reader and cardinality-changing migration that embeds Assistant streams in released v2 events."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-format-v1-to-v2

English | [中文](README.zh.md)

## Summary

`dsh-session-format-v1-to-v2` converts a released-v1 Session into the released-v2 event model through one stateful event stage. It consumes top-level `assistant/chunk` events, embeds their exact timed stream in the matching `assistant/message`, and records an `assistant/attempt` when a failed, retried, cancelled, or stream-error attempt reached settlement without a surface message. The edge densely remaps surviving events and every declared same-Session sequence reference, while the v2 codec stores one event per row and derives the inherited cut from a tagged `session/end-seed` marker.

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

### When to use it

Persistence obtains this edge through `dsh-session-format-catalog`; feature compositions do not mount it. Import it directly only when assembling or testing the static released-format catalog or inspecting the exact v1-to-v2 transformation. No runtime invariant companion is published because the package has no independently observable runtime registrations whose state can diverge; decoder and transformer state belongs to one restore.

### Entry point

```text
const decoder = releasedV1SessionFormatCodec.createDecoder(physicalHeader, 'strict')
for (const row of physicalRows) decoder.decodeRow(row, migrationContext)
const stage = sessionFormatV1ToV2.createStage(stageInput)
stage.transformEvent(event, migrationContext)
const targetInheritedEventCount = stage.finish(migrationContext)
const headerRecord = releasedV2SessionFormatCodec.encodeHeader(currentHeader, targetInheritedEventCount)
const eventRecord = releasedV2SessionFormatCodec.encodeEvent(currentEvent)
```

`releasedV1SessionFormatCodec` reads the frozen v1 physical language one row at a time. `sessionFormatV1ToV2` creates the cardinality-changing Stage that the static catalog connects to that decoder without retaining a v1 event array. The catalog remaps declared references and validates the released-v2 envelope, inherited cut, event admission, and relationships. Persistence applies full installed-current validation in its Worker before publication. `releasedV2SessionFormatCodec` creates a current row decoder and encodes current headers and events one record at a time.

A successful v1 `assistant/message` must cite its complete ordered attempt. The migration removes the cited top-level chunks and obsolete message provenance, compacts the chunks without joining token boundaries, and stores the stream on that message. An unclaimed attempt becomes one log-only `assistant/attempt` at its final chunk position. Unrelated interleaved events keep their relative order.

The edge also closes the bounded legacy restart pattern in which a non-empty `next-turn` inbox insertion is followed by the next `turn/start` without the prior `turn/end`. It records that prior turn as interrupted. A legacy round-zero goal mutation becomes a `goal/change` followed by the original model-visible message with ordinary plugin attribution, so both durable goal state and historical model input survive.

The migration refuses a reference to a consumed chunk instead of redirecting it to a different semantic event. It remaps declared event provenance, surface replacements, command source events, compaction ranges and lists, and title message lists. The already model-visible `session/title-llm-request.messages` text remains byte-identical after source validation, so target validation does not reinterpret the old sequence numbers embedded in that prompt. A seeded source also refuses an inherited cut that splits an Assistant attempt; the target marks the exact cut with `session/end-seed { inherited: true }`.

The v2 physical header requires `isSeeded` and does not store a numeric cut. The codec derives the cut from the last inherited end-seed marker, writes one event per row, range-encodes only `sourceEventSeqs`, and remains neutral to ordinary event vocabulary and payload growth. Released-current restoration admits event types known to the installed Session package plus unknown events carrying `ignorable: true`, and validates event members and relationships. Ordinary Session restoration checks runtime-required settlement fields without replaying embedded streams; persistence publication and the frozen writer-image fixture validator retain full stream verification.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The incremental edge retains one unsettled Assistant attempt, events whose output position depends on that attempt, and the dense old-to-new sequence map. It emits settled survivors in source order and rewrites only reference fields declared by the frozen event inventory. Released-current validation rejects any relationship the transformation cannot preserve.

| File | Role |
|---|---|
| [`src/migration.ts`](src/migration.ts) | Attempt grouping, settlement substitution, dense sequence mapping, and reference rewriting |
| [`src/codec.ts`](src/codec.ts) | Released-v2 header, one-event-per-row encoding, provenance ranges, and recoverable prefix decoding |
| [`src/validation.ts`](src/validation.ts) | Physical v2 envelope/cut validation and released-current event admission and relationships |
| [`src/dispositions.ts`](src/dispositions.ts) | Frozen released-v2 event and payload-member inventory |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Released v0 to v1 edge](../session-format-v0-to-v1/README.md) — the source codec and frozen historical vocabulary reused here.
- [Static catalog](../session-format-catalog/README.md) — build-owned codec and migration ordering.
- [Session persistence subsystem](../../../docs/subsystems/persistence.md) — immutable generation selection and publication.
- [Embedded Assistant stream decision](../../../.agents/notes/implemented/architecture/2026-09-01-v2-embedded-assistant-streams.md) — rationale, alternatives, and consequences.

-----

<a id="model-experience"></a>
## Model Experience

### Historical restoration

#### What the model sees

Successful Assistant messages retain the content, provider, model, usage, and replay state assembled from the same v1 stream. Failed or abandoned attempts remain durable diagnostics through `assistant/attempt` but do not enter `deriveMessages()`.

#### Token effect

The migration adds no model-visible content. It preserves the derived message history and removes only top-level chunk envelopes from the current logical event sequence.

#### KV Cache effect

The restored model-message sequence stays unchanged, so the migration alone does not alter request-prefix cache identity.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Closed first-party source inventory** — an unknown v1 event refuses migration, including an event marked `ignorable: true`.
- **Linear remap state** — streaming retains no complete v1 event array, but the final v2 event array and old-to-new sequence map remain O(event count).
- **No publication or compatibility fallback** — persistence owns exclusive successor publication, and retained v1 generations are not automatic downgrade or restore inputs.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
