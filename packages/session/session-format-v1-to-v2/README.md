---
description: "Frozen released-v1 Session reader and cardinality-changing migration that embeds Assistant streams in released v2 events."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-format-v1-to-v2

English | [中文](README.zh.md)

## Summary

`dsh-session-format-v1-to-v2` converts a complete released-v1 Session into the released-v2 event model. It consumes top-level `assistant/chunk` events, embeds their exact timed stream in the matching `assistant/message`, and records an `assistant/attempt` when a failed, retried, cancelled, or stream-error attempt reached settlement without a surface message. The edge densely remaps surviving events and every declared same-Session sequence reference, while the v2 codec stores one event per row and derives the inherited cut from a tagged `session/end-seed` marker.

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

Persistence obtains this edge through `dsh-session-format-catalog`; feature compositions do not mount it. Import it directly only when assembling or testing the static released-format catalog or inspecting the exact v1-to-v2 transformation. No runtime invariant companion is published because every codec and migration call validates its complete source or target artifact and retains no runtime state.

### Entry point

```text
const decodedV1 = releasedV1SessionFormatCodec.decodeArtifact(header, rows)
const migratedV2 = sessionFormatV1ToV2.migrate(decodedV1)
```

`releasedV1SessionFormatCodec` reads the frozen v1 physical language. `sessionFormatV1ToV2` validates that complete source, performs the cardinality-changing transformation, remaps declared references, and validates the exact v2 result. `releasedV2SessionFormatCodec` then encodes or decodes the current physical representation.

A successful v1 `assistant/message` must cite its complete ordered attempt. The migration removes the cited top-level chunks and obsolete message provenance, compacts the chunks without joining token boundaries, and stores the stream on that message. An unclaimed attempt becomes one log-only `assistant/attempt` at its final chunk position. Unrelated interleaved events keep their relative order.

The migration refuses a reference to a consumed chunk instead of redirecting it to a different semantic event. It remaps declared event provenance, surface replacements, command source events, compaction ranges and lists, and title message lists. The already model-visible `session/title-llm-request.messages` text remains byte-identical after source validation, so target validation does not reinterpret the old sequence numbers embedded in that prompt. A seeded source also refuses an inherited cut that splits an Assistant attempt; the target marks the exact cut with `session/end-seed { inherited: true }`.

The v2 physical header requires `isSeeded` and does not store a numeric cut. The codec derives the cut from the last inherited end-seed marker, writes one event per row, range-encodes only `sourceEventSeqs`, and remains neutral to ordinary event vocabulary and payload growth. Strict migration-target validation freezes the released-v2 inventory and rejects unknown types or members. Current restoration instead admits event types known to the installed Session package plus unknown events carrying `ignorable: true`, then delegates payload and stream semantics to the installed current restorer. All paths retain strict header, event-envelope, sequence, and inherited-cut validation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The edge first groups v1 chunks by turn, step, terminal finish, and explicit message provenance. It stages survivors in source order, substitutes one settlement for each group, computes a dense old-to-new sequence map, and rewrites only the reference fields declared by the frozen event inventory. Source and target validators bracket the transformation so a partially understood artifact is never admitted.

| File | Role |
|---|---|
| [`src/migration.ts`](src/migration.ts) | Attempt grouping, settlement substitution, dense sequence mapping, and reference rewriting |
| [`src/codec.ts`](src/codec.ts) | Released-v2 header, one-event-per-row encoding, provenance ranges, and recoverable prefix decoding |
| [`src/validation.ts`](src/validation.ts) | Physical v2 envelope/cut validation, exact migration-target policy, and vocabulary-neutral current restoration |
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
- **Whole-artifact transformation** — the edge materializes the source, target, and sequence map in memory; it does not stream the rewrite.
- **No publication or compatibility fallback** — persistence owns exclusive successor publication, and retained v1 generations are not automatic downgrade or restore inputs.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
