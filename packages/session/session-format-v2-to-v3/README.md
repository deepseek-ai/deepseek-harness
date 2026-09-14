---
description: "The complete V2-to-V3 Session conversion: system heads, audited references, PTC and preset names, canonical envelopes, preservation, and refusal."
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v2-to-v3

English | [中文](README.zh.md)

## Summary

Restore supported released V2 Sessions as V3 without changing historical request meaning. This page is the single specification for this adjacent edge: what it transforms, preserves, and refuses, followed separately by native V3 admission. The library promotes system prompts into messages, remaps local event references, translates PTC and preset names, and canonicalizes envelopes. Persistence consumes it through the static catalog; the library does not read or publish files.

## Table of Contents

- [Use this package](#use-this-package)
- [V2-to-V3 specification](#v2-to-v3-specification)
  - [Header and preset references](#header-and-presets)
  - [System head and message identities](#system-head)
  - [Sequence references and inheritance](#sequence-references)
  - [PTC vocabulary](#ptc-vocabulary)
  - [Canonical envelopes and tool errors](#canonical-envelopes)
  - [Delivery guards](#delivery-guards)
  - [Source audit and refusal](#source-audit)
- [Native V3 admission](#native-v3-admission)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

Use the [catalog](../session-format-catalog/README.md) to restore a Session. Direct imports serve catalog assembly and tests; this library has no Cordis mount configuration. The [public exports](src/index.ts) provide the migration declaration, released V2 source codec, V3 target codec, target header validator, and target restorer.

### Entry point

The header-only operation does not convert or validate an event body:

```text
const targetHeader = sessionFormatV2ToV3.migrateHeader(sourceHeader)
```

Full restoration feeds decoded events through a fresh stage and validates the target artifact. Callers must not treat partial stage emissions as a successful restore: an error can occur at a later event or at `finish()`. The [format protocol](../session-format/README.md) owns stage scheduling and catalog error handling; [JSONL persistence](../session-persistence-jsonl/README.md) owns read preparation and immutable successor publication.

-----

<a id="v2-to-v3-specification"></a>
## V2-to-V3 specification

The complete edge is not an identity conversion. It preserves the relative order and timestamps of source events and the meaning of each historical request, but inserted system events change event count, dense sequence positions, local references, and inherited cuts. PTC/preset translation and final envelope canonicalization add no events. Only the named fields below change; preservation applies to admitted input, not arbitrary unaudited extensions.

<a id="header-and-presets"></a>
### Header and preset references

The logical header changes `version: 2` to `version: 3`. It retains `id`, `createdAt`, `isSeeded`, `delegationDepth`, and admitted optional `cwd`, `parentSession`, and `origin`. The exact preset id `code` becomes `ptc` in `header.agentPreset` and every `agent-preset/selected.data.agentPreset`, including inherited and local selections. Other strings and an absent header preset remain unchanged. Selection payloads require a string preset id and reject unaudited members.

This conversion does not inspect installed presets or rewrite other occurrences of `code`. Released V0/V1 data receives it only after the frozen preceding edges reach V2. Native V3 custom preset ids are not renamed, and `settings.yaml` is outside this package.

<a id="system-head"></a>
### System head and message identities

The first `step/start` is followed immediately by an empty `system/message` append, even if the step aborts without a request. Later steps do not create another head. A log with no step and no surface receives no head or invented request.

At every `request/header`, absent `data.header.system` means the empty prompt; otherwise its string is compared exactly with the current prompt. A change inserts a system message immediately before that request header, replacing exactly the current protected head and citing it in `sourceEventSeqs`. An unchanged prompt inserts nothing. Empty strings and absent fields clear an earlier prompt; whitespace-only strings remain nonempty text. Every request header loses `data.header.system`, regardless of whether a replacement was needed.

Synthetic messages carry the open step's `turn` and `step`, the anchor event's `time`, role `system`, and source `{ kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }`. Empty prompts use `content: []`; other prompts use one text block containing the exact string. The first append has no source-event reference; each replacement uses the preceding head's target sequence for both endpoints and its sole source reference. Empty heads retain protection but produce no model message.

Each synthetic id is `v2-to-v3-system-` followed by the hexadecimal SHA-256 of `JSON.stringify(['session-format-v2-to-v3', sourceHeader.id, anchor.seq, anchor.type])`. The anchor is the source `step/start` for initial creation or the changed `request/header` for replacement. Collisions with generated or source message ids are refused in either encounter order, including ids in inbox insertions and title-request messages. Existing message ids never change. In particular, a `TOOL_NOT_STARTED` repair id retains its canonical historical `interrupted-tool-result-<callId>-<integer>` suffix; that suffix is not a target sequence coordinate.

<a id="sequence-references"></a>
### Sequence references and inheritance

Source events must be dense from zero. Each original event receives its target position after any preceding insertion. The [reference mapper](src/references.ts) changes only these same-artifact references; every referenced source position must name an earlier event with an established mapping:

| Owner | Fields remapped |
|---|---|
| Surface envelope | `sourceEventSeqs[]`; `surfaceOp.start/end` before their canonical rename |
| `command/done.data` | `sourceEventSeq` when present |
| `compaction/summary.data` and `compaction/prune.data` | `shadowedRange.start/end` and `shadowedSeqs[]` |
| `session/title.data` and `session/title-llm-request.data` | `messageSeqs[]` |

There is no recursive numeric-field rewrite. Delivery `throughSeq` and `sessionFormatVersion`, session-reference `capturedThroughSeq` and `capturedFormatVersion`, workflow-local `seq`, stream block indices, turn/step numbers, inbox indices, token/byte counts, and all ids keep their source values. Embedded assistant streams, model replay state, tool arguments/results, title-request input text and `data.system` retain their recorded meaning. Compaction payload endpoints keep the names `start/end`; only envelope replacement endpoints are renamed.

For a seeded Session, the last `session/end-seed` with `data.inherited: true` identifies the source cut. Its source sequence is the inherited event count, excluding that marker; its mapped target sequence is the target cut. Synthetic events before it are inherited, and later ones are local. An untagged marker does not establish the cut. A supplied `sourceInheritedEventCount` must agree; a seeded log without a marker and an unseeded log with one are refused. Unseeded stages expose `headerInheritedEventCount: 0`; seeded stages leave it unknown until `finish()` derives the exact cut. This also supports V0/V1 chains whose preceding stage changes event count and cannot supply the cut before EOF.

<a id="ptc-vocabulary"></a>
### PTC vocabulary

The exact event tags `tool/code-dispatch-start` and `tool/code-dispatch` become `tool/ptc-dispatch-start` and `tool/ptc-dispatch`. Their payloads retain their values. Plugin attribution changes from exactly `tools-code-mode` to `tools-ptc` only when `source.kind === 'plugin'` in these three slots:

- `user/message.data.source.plugin`
- `agent/inbox/spliced.data.inserted[].source.plugin`
- `session/title-llm-request.data.messages[].source.plugin`

Similar plugin names, other source kinds, arbitrary text, nested JSON, and historical ids including `:code:` remain unchanged. This does not rename `run_code` or its `code` argument. V2 source events already using either reserved V3 PTC tag are refused even when ignorable; an opaque source extension must not acquire current lifecycle meaning through migration.

<a id="canonical-envelopes"></a>
### Canonical envelopes and tool errors

After structural insertion and reference remapping, canonicalization converts exact envelope replacements `{ op: 'replace', start, end }` to `{ op: 'replace', startSeq, endSeq }` on original and synthetic events. It omits exactly `tools: []` and `adapterDefaults: {}` from `request/header.data.header`. This final operation preserves its input event count, coordinates, timestamps, order, and inherited cut; it neither remaps twice nor normalizes unrelated empty values such as `config.stop: []`.

All four V3 surface types (`system/message`, `user/message`, `assistant/message`, `tool/result`) require `surfaceOp`. Assistant messages alone forbid `sourceEventSeqs`; for the others, a supplied list must be nonempty, unique, and refer only to earlier events. Known log-only events allow neither surface metadata field. Replacements allow no aliases or extra keys. Their endpoints identify an inclusive span in current surface order, not numeric sequence order; restoration checks live membership, endpoint order, and complete source-event coverage.

Source surface events already require placement; migration does not invent missing append markers. A `tool/result` with `data.error` requires its single tool-result block to carry `isError: true`. Failed results may omit structured error identity. Contradictory outcomes are refused, never repaired by adding `isError` or deleting diagnostics. Ordinary tool and PTC lifecycle relationships still require validation after these event-local checks.

<a id="delivery-guards"></a>
### Delivery guards

A V2 `session-log-deepseek/delivery-accepted` with `data.sessionFormatVersion === 3` is refused, not promoted into a V3 upload watermark. Markers for other generations retain their payloads, including an absent generation and future non-target generations. A V2-generation marker must have a valid earlier `throughSeq`; if it names a different Session, it is permitted only in the inherited prefix of a Session with `parentSession`. A foreign local marker or one without parent metadata is refused. The marker's envelope sequence changes normally; its captured acceptance coordinates do not.

<a id="source-audit"></a>
### Source audit and refusal

Migration classifies the [released V2 event inventory](../session-format-v1-to-v2/src/dispositions.ts), including log-only `assistant/attempt`, plus `feedback/message-put` and `feedback/message-delete`. The [payload validator](src/payload.ts) applies exact admitted envelope and payload members and released nested validation. Unknown events, even ignorable ones, and unaudited members at checked records are refused. Message-source classification covers the five Message slots below: unknown source kinds are refused, while agent relay attribution is admitted without interpreting ids as Session references.

The content audit admits exactly `text`, `reasoning`, `image`, `file`, `tool-call`, and `tool-result`. It validates owned block fields and recursively audits every nested `tool-result.content` in this finite set of positions:

| Owner | Audited content |
|---|---|
| Five Message slots | `user/message.data.content`; `assistant/message.data.message.content`; `tool/result.data.message.content`; `agent/inbox/spliced.data.inserted[].content`; `session/title-llm-request.data.messages[].content` |
| Queued team message | `team/message/queued.data.message.content`; the historical Team payload remains `version: 1` with `message.delivery` |
| Compaction output | `compaction/summary.data.summary` and optional `compaction/summary.data.rawOutput` |
| PTC predecessor output | `tool/code-dispatch.data.content` |
| Embedded assistant streams | In `assistant/message.data.stream[]` and `assistant/attempt.data.stream[]`, raw `type: 'chunk'` records: `chunk.block` for `block-end` and `chunk.blockType` for `block-start`, including starts with no completed block |

All positions use the same historical kind set; a partial start cannot introduce an unknown kind. Unknown kinds and malformed owned blocks refuse the whole migration; catalog restoration reports `SessionFormatUnsupportedMigrationError`. The diagnostic identifies the source event type, source sequence, full indexed payload path, and violated rule. Unknown-kind errors name the offending kind; malformed known-block errors name the kind and field error. A malformed content container or missing block reports its location without inventing a kind. Persistence leaves source bytes unchanged and publishes no successor on refusal.

Admission does not rewrite content. In particular, embedded stream bytes are preserved although their owned block fields are inspected. Tool arguments, `replayState.response`, and `replayState.blocks` remain opaque; matching field names inside arbitrary JSON do not trigger this audit. File attachment metadata is validated without interpreting ids or byte counts as Session references. This is not a general schema audit or recursive coordinate inference, and native V3 extension acceptance is separate.

A surface event before the first step, a changed prompt outside an open step, or a generated-id collision raises `SessionFormatUnsupportedMigrationError` rather than moving events or inventing ownership. Malformed source fields, missing placement, invalid references, inconsistent cuts, delivery violations, and contradictory tool results raise format errors in the direct stage or target validator. The catalog reports migration-stage and transformed-target validation failures as typed unsupported migration; physical decoding failures remain corruption under its selected recovery policy. No source or target repair, generation fallback, or file rewrite is performed by this edge.

-----

<a id="native-v3-admission"></a>
## Native V3 admission

Input already marked V3 does not run V2-to-V3. Native catalog reads with `validation: 'transformed'` apply codec checks only and skip artifact restoration; full relationships, open-step ownership, protected-head operations, and vocabulary checks require `restoreReleasedV3Artifact` or catalog `validation: 'current'`. The following rules distinguish those restoration checks from codec admission; they are not additional historical transformations:

- Native V3 admits in-history system appends, non-head system replacements, and compaction of non-head system nodes. System messages require valid payloads and matching open-step ownership. The first surface system head can be replaced only by a system message covering exactly that head; ordinary replacements and compaction cannot consume it. Migration itself produces only the initial head and head replacements, not route-dependent in-history updates.
- Native V3 rejects every `request/header.data.header.system`, even empty or malformed, and rejects noncanonical replacement spellings and the two empty header optionals. It preserves whitespace content, empty stop lists, and admitted nested header/source/data extensions. That extension admission does not widen the V2 source audit or the exact logical Session header fields.
- Required predecessor PTC tags are refused even if installed. Obsolete or unknown ignorable events remain opaque, including their logical metadata, and cannot satisfy current PTC relationships. Installed ordinary event additions are admitted as log-only envelopes; unknown required types are refused by vocabulary-aware restoration. The physical codec still enforces released framing and source-event range encoding.
- V3 event-local checks run before encoding and after decoding. Raw retired-system-header, malformed-system-payload, and required predecessor-PTC refusal run before recoverable suppression, including after corrupt rows. Strict reads reject canonical errors immediately. Recoverable canonical decoding withholds the first invalid event and its suffix; a later `turn/end` establishes a commit and rejects that suffix. Only accepted inherited markers count; a seeded accepted prefix without one is refused. Unclassified event metadata is deferred to vocabulary-aware restoration rather than discarded as canonical corruption, so it cannot hide an unknown required type.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [stage](src/migration.ts) owns synchronous per-artifact sequence maps, message identity sets, and prompt/lifecycle state. Compact runs expand incrementally. The [codec](src/codec.ts) reuses frozen V2 framing; the [restorer](src/validation.ts) validates V3 structure before giving frozen ordinary relationship validation a private system/PTC/repair-id and endpoint view. That view retains the actual target generation for delivery checks and never escapes: restoration returns the original V3 artifact and identities. Frozen V0-to-V1 and V1-to-V2 semantics remain unchanged. No runtime invariant companion is published because this library owns no independently observable registrations or state replicas.

[Combined catalog tests](tests/combined-migration.spec.ts) exercise transformation composition and native reopen; [migration tests](tests/migration.spec.ts) and [canonical tests](tests/canonical-envelopes.spec.ts) pin preservation and refusal. [Persistence integration](../session-persistence-jsonl/tests/v2-ptc-migration.spec.ts) owns publication evidence. The [released-format decision](../../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md) owns the rationale for testing adjacent composition separately from native admission.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Released V1 to V2](../session-format-v1-to-v2/README.md) — frozen preceding conversion and source codec.
- [System-prompt surface decision](../../../.agents/notes/implemented/architecture/2026-09-02-system-prompt-as-surface-node.md) — prompt ownership and protected-head rationale.
- [Canonical V3 envelope decision](../../../.agents/notes/implemented/architecture/2026-09-06-v3-canonical-session-envelopes.md) — strict acceptance and validation ownership.

-----

<a id="model-experience"></a>
## Model Experience

### Historical restoration

#### What the model sees

Each historical request retains its prompt text and ordinary message content. Empty system heads produce no model message. PTC attribution uses `tools-ptc`; dispatch events remain log-only.

#### Token effect

The edge adds no model-visible text; it moves the recorded prompt from the request header into the message history.

#### KV Cache effect

The edge preserves historical request meaning and model configuration; it does not guarantee provider cache hits or byte-identical native V3 recordings.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Historical preset ambiguity** — released `code` references cannot distinguish a custom preset with the legacy built-in id; the [exact rename](#header-and-presets) is host-independent.
- **No file or settings migration** — this package never changes committed generations or `settings.yaml`. Persistence owns publishing the final successor; an existing V3 generation does not rerun its incoming edge. See [format release status](../../../docs/session-format-status.md) and the compatibility obligations in the [released-format policy](../../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
