# Agent Note: Embed Assistant streams in v2 attempt settlements

Status: implemented

English | [中文](2026-09-01-v2-embedded-assistant-streams.zh.md)

## Problem

Token-sized `assistant/chunk` events preserve exact stream order, timing, usage, terminal state, replay metadata, and partial failed output, but making each chunk a top-level Session event repeats envelopes throughout persistence, telemetry, history transport, indexing, and client assembly. Physical packed rows reduce JSONL bytes without reducing logical event count or the work of consumers that receive the canonical stream.

Storing only assembled successful messages would remove that overhead but lose failed and abandoned output, token boundaries, timestamps, and deterministic provider replay. The durable record needs one unit per model attempt without reducing the evidence that replay, diagnostics, cancellation recovery, usage accounting, snapshots, and UI history rely on.

Changing event cardinality also changes Session sequence numbers. A released migration must preserve the relative order of unrelated events, rewrite every declared same-Session reference, retain the exact fork cut, and refuse any relationship it cannot preserve semantically.

## Decision

Session format v2 has no top-level `assistant/chunk` event. Each model attempt commits one durable settlement containing `stream: AssistantStreamRecord[]`:

- `assistant/message` is the surface settlement for a successful response or a cancelled response with visible assembled content. It embeds the exact compact timed stream beside the assembled message, optional usage, and optional `interrupted: true` marker.
- `assistant/attempt` is log-only. It preserves the stream for a failed, retried, cancelled, or stream-error attempt that reaches settlement without a surface message, so diagnostics and accounting do not fabricate model-visible history.

`AssistantStreamAccumulator` snapshots each chunk once. Consecutive text, reasoning, or tool-argument deltas for the same block become one compact run with its first timestamp, exact timestamp gaps, and one array member per original delta. Every other chunk remains a timestamped raw record. `expandAssistantStream()` strictly validates and reconstructs the exact timed sequence; compaction never joins delta boundaries.

The current v2 validator requires the embedded stream to reproduce a non-empty `assistant/message`'s content, usage, and replay state. An empty stream remains valid for a migrated legacy message that had no source chunks. `assistant/message` cannot carry obsolete chunk `sourceEventSeqs`; ordinary user and tool surface provenance remains available.

### Live presentation and durable replay

`agent/assistant-stream` publishes process-local start, transient chunk, and end frames. The loop appends the complete `assistant/message` or `assistant/attempt` before a committed end frame names its type and sequence. An abandoned end has no settlement.

The Web follow adapter opts into these process-local frames and adds the last durable sequence observed at each start. It presents chunks as Client-only `assistant/live-chunk` updates between durable cursors, stages only a later matching settlement until the committed end, and reopens follow on a revision gap. A committed end publishes a named settlement delta that removes the attempt's transient matches, adds the durable entry, and replays only affected Conversation Contexts; an abandoned end publishes the same delta without an entry. A reconnect baseline carries the active attempt's durable start cursor and compact prefix. Paged history, replay, telemetry, token accounting, and cold UI assembly read the durable embedded stream rather than the live frames.

### Released v1 to v2 migration

The adjacent migration validates the complete frozen v1 artifact, groups chunks by turn, step, terminal boundary, and exact message provenance, and then substitutes one settlement per attempt. A successful group's chunks move into its message. An unclaimed group becomes `assistant/attempt` at the last consumed chunk's position. Unrelated interleaved events retain their relative order, and survivors receive dense v2 sequence numbers. The edge compacts, expands, and re-assembles embedded streams through the runtime `AssistantStreamAccumulator`, `expandAssistantStream`, and `BlockAssembler` from `dsh-llm` instead of frozen copies, because that package owns the v2 stream encoding. Target validation re-checks agreement between each migrated `assistant/message` and its embedded stream itself, so a disagreeing v1 log is refused as an unsupported migration with its source artifact retained instead of surfacing as corruption from the installed Session restoration. A later format that changes the stream encoding must freeze copies of these helpers into this edge.

The edge remaps the finite declared reference inventory: envelope provenance, surface replacement endpoints, command source events, compaction ranges and shadowed lists, and title message lists. The model-visible text of a validated `session/title-llm-request` remains byte-identical in the source sequence namespace while its `messageSeqs` field moves to the v2 namespace; target validation therefore does not reconstruct that text from remapped sequences. A reference to a consumed chunk refuses migration; it is never redirected to a settlement with different meaning. The edge also refuses an inherited cut that splits an attempt.

The v2 physical header requires `isSeeded` and stores no numeric cut. A seeded artifact marks its exact cut with `session/end-seed { inherited: true }`; decoding derives the cut from the last tagged marker. The v2 codec writes one durable event per physical row, range-encodes only `sourceEventSeqs`, and validates physical envelopes without freezing ordinary event vocabulary or payload additions. The v1-to-v2 target validator separately freezes the released-v2 inventory, while current restoration uses the installed Session vocabulary. Frozen v0 and v1 codecs retain packed-row decoding for their immutable historical generations.

A fresh subagent child's constructor seed is exactly the inherited parent prefix. `Session` appends the tagged cut marker, then subagent setup appends the child-owned descriptor and delegated policies. The former descriptor-seed helper is removed, so a descriptor is never counted as inherited and cold resume replays the persisted child-owned setup. Historical snapshot fixtures that placed an untagged marker after the descriptor are corrected at their source; current comparison keeps marker count and sequence references visible.

The `dsh_session_log` request extension keeps its own outer schema at version 1: its Session header projection still derives `seedLength` from the logical inherited cut, and only its `sessionFormatVersion` member identifies the embedded logical Session generation. Projection units likewise keep their `stateVersion`; the projection cache binds every checkpoint to the Session format generation, so a generation change never needs a unit version bump.

Generation selection and publication follow the [released Session migration decision](2026-08-31-released-session-format-migrations.md): the source path, bytes, and inode remain unchanged, only the final version-named successor is published, and retained predecessors provide neither fallback nor downgrade support.

## Verification

The compact-stream tests pin exact accumulation and expansion for text, reasoning, tool arguments, raw chunks, timestamp gaps, malformed records, and detached snapshots. The v1-to-v2 tests cover successful and failed attempts, interleaving, dense sequence and reference remapping, source-sequence title framing, seed-cut insertion and split refusal, strict source and target validation, one-row v2 encoding, backend-compatible provenance ranges, raw and Zstandard publication, and no-write current reads.

The pre-merge performance acceptance measured static catalog-routing overhead against direct released-v2 restoration of the same already parsed physical rows across three runs, 100 warmup pairs, and 600 measured pairs; it did not compare v1 with v2 or time backend I/O. Every pooled median and p95 regression stayed within the 5% budget, with a worst p95 regression of 3.150%.

Agent-loop tests pin durable-before-end ordering, interrupted visible prefixes, failed and retry attempts, abandonment, usage, and replay metadata. Session Controller and Conversation tests pin live transient display, reconnect baselines, committed settlement release, history replay, Chat and Trajectory parity, while TypeScript and Python SDK snapshots pin the external event representation.

## Alternatives considered

**Persist only assembled successful messages.** This loses partial failed output, timing, token boundaries, usage from attempts without a message, and exact deterministic replay. `assistant/attempt` and the embedded compact stream preserve those facts without adding them to model history.

**Keep top-level chunks and pack only physical rows.** This preserves the v1 logical representation but leaves sequence density, telemetry volume, wire envelopes, Client entries, and consumer dispatch proportional to token count. Historical codecs still decode that representation; it is not the current event model.

**Carry packed chunk rows through the history API.** This reduces wire and Client work for v1 but gives the Client a second event vocabulary and keeps transport coupled to token-row cardinality. The current API carries scalar durable settlements plus a separate live transient stream.

**Store the stream in a sidecar or replay-only fixture.** This splits one attempt's message and evidence across durability owners and cannot give ordinary resumed sessions the same failed-output and timing facts. The settlement is the atomic owner.

**Redirect references from consumed chunks to their settlement.** A chunk and an attempt settlement are not interchangeable facts. Refusal prevents a migration from silently changing the meaning of plugin-owned references.

## Consequences

Current logs, telemetry, history pages, and cold Client assembly scale by model attempts rather than token chunks while retaining exact stream evidence inside each settlement. Live presentation remains incremental and intentionally process-local.

Unlike v1 top-level chunks, which the buffered persistence writer could flush before an attempt ended, v2 has no durable attempt evidence until settlement. A hard process or host loss before settlement discards the complete in-flight stream; `agent/assistant-stream` is not a write-ahead log. This tradeoff avoids a second durability owner for live output.

One settlement can be large, and v1-to-v2 migration materializes the whole artifact plus its sequence map. The closed alpha inventory refuses unknown v1 events and undeclared references instead of guessing. Consumers that need individual chunks call `expandAssistantStream()` and must not infer durability from `agent/assistant-stream`.

Migration changes sequence numbers after consumed v1 chunks, so every same-Session reference belongs to an explicit rewrite rule. This constraint makes future cardinality-changing migrations expensive by design and keeps silent semantic redirection out of the format chain.
