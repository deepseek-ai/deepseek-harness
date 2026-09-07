# Agent Note: Embedded Assistant stream consumers read compact records

Status: implemented

English | [中文](2026-09-06-embedded-stream-record-readers.zh.md)

## Problem

Session format v2 embeds each model attempt's compact stream (`AssistantStreamRecord[]`: packed `text-chunks`, `reasoning-chunks`, and `tool-call-chunks` runs plus timestamped raw `chunk` records) in `assistant/message` and `assistant/attempt`. Consumers that folded those settlements called `expandAssistantStream()` first; it materializes the complete per-member array, so a consumer that needs one fact (`find` on the first token, the last usage chunk, a joined text, one block-end) paid O(members) allocation and time: about two objects per member on top of the compact form.

After v2 embedded streams settlement widened with the message content and Chat and Trajectory sections settled directly from it, the remaining expand consumers are the Host and client folds: Session Stats reads the first-token time per `assistant/attempt` and `assistant/message` (the projection phase of every Session open), the token meter rebuilds provider content and scans every stream for its last usage chunk (the projection unit still scans to the end), the subagent output fold joins plain text, and the Session Controller image lookup scans for block-end chunks.

## Decision

`@deepseek-ai/dsh-llm` answers consumer questions directly from compact records; every remaining consumer folds records once with early exit.

`packages/llm/llm/src/assistant-stream.ts` exports record-level readers beside the accumulator and `expandAssistantStream`:

- Chunk rules: `isTokenDelta` (non-empty text, reasoning, or Tool-call arguments fragment, or any name-bearing Tool-call delta), `isVisibleChunk` (non-whitespace text or reasoning, or a block start or end of any kind other than text, reasoning, or Tool call), and `chunkHasVisibleText` (non-whitespace text delta or completed text block).
- Run readers: `runFirstTokenTime` and `runFirstVisibleTime` reconstruct the first qualifying member's time from `time0` and the `dt` gaps and stop scanning there; a name-bearing Tool-call run yields `time0` without reading a fragment.
- Stream readers: `assistantStreamFirstTokenTime`, `assistantStreamHasVisibleContent`, `assistantStreamHasVisibleText`, `lastAssistantStreamChunk(stream, type)` (backward scan), `assistantStreamChunks(stream, type)`, `joinAssistantStreamText`, and `assembleAssistantStream`, which feeds a `BlockAssembler` one joined delta per run (assembly only concatenates, so blocks, usage, finish, and replay state equal the per-member result). `RawStreamChunkType` excludes the delta types, so a raw-chunk lookup can never silently skip packed members.

Session Stats reads `assistantStreamFirstTokenTime`; the token meter reads `lastAssistantStreamChunk(stream, 'usage')` and assembles provider output through `assembleAssistantStream`; the subagent output fold appends `joinAssistantStreamText`; the Session Controller scans `assistantStreamChunks(stream, 'block-end')` for images.

`expandAssistantStream` keeps its strict validation and its remaining callers, which need every member or validate the stream at a durable boundary: Session restore validation, the v1-to-v2 migration validator and publication Worker replay, the reconnect baseline, and test support.

### Measurements

The repo's synthetic first-open benchmark (200 turns, 127,400 released-v0 events, 500,000 streamed deltas in 1,600 compact records; five samples, median):

| Phase | Before | After |
|---|---|---|
| first-open projection | 28.0 ms | 5.9 ms |
| first-open total | 76.9 ms | 53.8 ms |
| first-open peak RSS | 137.2 MB | 94.6 MB |
| reopen projection | 17.8 ms | 6.5 ms |

Open, read, and restore phases are unchanged; the reader keeps the same first-token time by construction (the first qualifying member is the first record's first qualifying fragment, and the deltas stay ordered).

## Alternatives considered

**Memoize `expandAssistantStream` per input array.** Expanding all streams once costs tens of milliseconds, but retaining the expansions costs about ten times the compact stream for the event's lifetime — a permanent version of the transient allocation the change removes. The readers remove the need for retained expansions entirely.

**Keep the per-member fold.** Early-exit `.find` still materializes the whole array first, so the allocation and O(members) time remain.

## Consequences

Host and Client folds of an embedded settlement cost O(records) plus one join per run, and no consumer materializes members unless it validates at a durable boundary or needs every member. The token, visibility, and visible-text rules have one home in `dsh-llm`, so a record reader and the accumulator's packing rules cannot drift apart.

Publication verification (`assertCurrentAssistantStreams`) still replays every settlement at publish time; because it must prove content-by-chunk agreement, converting it to run-aware assembly without member materialization remains open work.
