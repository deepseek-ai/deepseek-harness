# Agent Note: Carry packed chunk rows through session history

Status: implemented
Archived: 2026-09-01

English | [中文](2026-08-15-packed-session-history-transport.zh.md)

## Problem

`session.page` and the opening `session.follow` snapshot serve a bounded logical Session-event interval to remote clients. Provider streams can place hundreds of thousands of token-sized `assistant/chunk` events in one incomplete tail. Expanding every persisted row and then serializing every logical event repeats the same envelope on the wire. Expanding a packed response at the Client boundary recreates the same event objects, journal entries, Location indexing, Definition matches, and State updates before conversation replay can finish.

The transport must remain lossless. Session sequence numbers are pagination and reconnect evidence; exact fragment boundaries and timestamps remain useful to diagnostics and non-UI API consumers; live streaming, durable export, replay, and model-history derivation continue to require the canonical event stream. Browser presentation does not require one allocated event object and one Definition callback per historical fragment when a Definition can fold the lossless run directly.

## Decision

History pages and follow opening snapshots carry `records: SessionHistoryRecord[]`. An ordinary record is `{ type: 'event', event: SessionWireEvent }`; consecutive same-block Assistant delta events use `{ type: 'chunks', event: ChunkRowEvent }` and the shared lossless codec from [the packed JSONL decision](2026-07-26-packed-chunk-rows-by-default.md). The Host constructs the event-shaped value once when it packs the selected page. Its `type` is `chunkrow/text-chunks`, `chunkrow/reasoning-chunks`, or `chunkrow/tool-call-chunks`; `seq` and `time` identify the first member, while `data` retains the original fragment and timestamp-gap arrays. The explicit outer discriminator selects the record class without interpreting that detailed chunk kind. The page is selected from logical events before packing, so message-aligned pagination remains independent of physical persistence layout.

The generated Remote decoder validates the response fields. `SessionEventStream` passes the original wire records to `RemoteJournalStream` and supplies each record's inclusive logical sequence range: an event covers `[event.seq, event.seq]`, while a row covers `[event.seq, event.seq + memberCount - 1]`. The journal checks page continuity, pagination joins, reconnect repair, complete duplicates, partial overlaps, and live-event deduplication before publishing records. The durable address in the page request selects either an ordinary Session or an authorized direct subagent child without a second history protocol.

The Client narrows the accepted `SessionHistoryRecord[]` to `SessionEventLikeEntry[]` without allocating replacement entries. The outer `type` remains available to the journal, Session, and assembler; both variants carry an inner value with aligned `type`, `seq`, `time`, and `data` fields. `ChunkRowEvent` is Client history data, not a durable Session event: it is absent from `SessionEventMap`, `Session.events`, and `session/event`.

Conversation accepts the same `{ type, event }` entries retained by Session. Definitions receive the inner `SessionEventLike`: `match()` and `update()` accept standard or packed values, while `start()` accepts only a standard `SessionEvent`; the assembler uses the outer discriminator to reject a packed start. Chat Assistant, Turn Tail, and Trajectory Assistant handle the three packed tags in their existing reducers. One row therefore remains one Client entry, Conversation input, and Match, while those reducers preserve scalar replay's final blocks, tool-call fields, first-token time, first-visible boundary, retry behavior, and interruption state.

Live `session.follow` frames remain individual events and use the scalar path, so visible streaming cadence is unchanged. Session persistence, raw export, replay, model-history derivation, and the canonical in-memory log are unchanged.

## Measured result

A production-sized private session sample was measured without retaining or committing its content. Its tail page contained 416,756 logical events. The lossless packed response used 696 top-level records, including 116 packed rows.

| Representation | Top-level records | JSON bytes | gzip bytes | Brotli bytes |
| --- | ---: | ---: | ---: | ---: |
| Raw logical events | 416,756 | 69,433,638 | 4,190,226 | 1,972,998 |
| Completed-step projection candidate | 228,129 | 38,427,209 | 2,324,688 | 957,350 |
| Lossless packed history | 696 | 6,362,724 | 1,154,206 | 528,145 |

Packing reduced uncompressed JSON by 90.8% relative to raw logical events and by 83.4% relative to the lossy completed-step projection candidate. Brotli output was 73.2% smaller than raw and 44.8% smaller than that projection candidate. These figures describe this sample rather than a protocol guarantee; savings scale with the length and regularity of delta runs.

One-to-one Client retention keeps the same sample at 696 history entries and Conversation inputs instead of restoring 416,756 event entries. A local synthetic benchmark run measured Client parse, validation, retention, and two-Definition fold at 4,682.11 ms for scalar input and 276.10 ms for packed input, with sampled additional V8 heap peaks of 612,523,344 and 199,436,928 bytes respectively. These machine-dependent values are observations rather than thresholds.

The opt-in `packages/client/ui-conversation/tests/history-transport.perf.client.ts` benchmark constructs the same logical-event, ordinary-event, and delta-run cardinalities from synthetic content. `DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.perf.config.ts packages/client/ui-conversation/tests/history-transport.perf.client.ts` reports wire sizes, Host/client timing, uncompressed chunked Node loopback transfer medians, combined synthetic API-wait/UI-ready timing, and sampled additional V8 heap peaks under `HISTORY_TRANSPORT_PERF_RESULT`; a second inventory reports batch-fold medians for 10,000-, 20,000-, and 40,000-member whitespace-prefix runs under `HISTORY_WHITESPACE_PREFIX_PERF_RESULT`. The combined timing starts from an in-memory event array and omits cold persistence reads, the production API bridge and RPC envelope, and Chromium scheduling, so it is comparative inventory rather than production wall-clock latency. Heap measurements force garbage collection before three runs and report the median peak observed after each major Host construction/serialization or Client parse/validation/retention/fold stage, relative to the same initialized benchmark state; they do not measure process RSS, external or ArrayBuffer memory, or transients within a sampled stage. The manual performance inventory does not run in CI and carries no machine-dependent timing or memory assertions; structural assertions pin the fixture cardinalities, one Client input per wire record, and identical final state—including delta count and last-delta sequence—from its two-consumer Assistant fold fixture.

## Alternatives considered

**Discard completed-step chunks on the Host.** This lowers logical event count but makes transport semantics depend on the current transcript policy, removes exact evidence from all consumers, and still sends every retained incomplete-step token as a separate envelope. The measured packed response is smaller while remaining lossless.

**Expand each packed row before the Session object layer.** This preserves one callback per historical delta but recreates the browser allocation, indexing, and fold costs that packed transport can avoid. Consumers that require scalar events can still call `decodeStorageRecord()` explicitly.

**Put the raw row under a distinct `.chunks` payload.** This forces downstream consumers either to retain two payload field names or to allocate an aligned wrapper before assembly. The shared `.event` field preserves fast outer classification and one inner Definition path.

**Rely on HTTP content encoding.** gzip and Brotli reduce bytes on the network but do not remove repeated JSON parsing, validation, allocation, indexing, and fold work.

**Page directly over physical persistence rows.** This could also avoid logical expansion in a cold Host read, but page cuts depend on append-origin messages and replacement provenance rather than backend row boundaries. The current decision keeps the API independent of JSONL, SQLite, and future persistence layouts.

**Return only assembled Assistant snapshots.** The [assembled-messages-only rejection](../../rejected/simplification/2026-06-20-assembled-assistant-messages-only.md) remains applicable: event families outside finalized messages carry user-visible and diagnostic state, and incomplete steps need their actual accumulated chunks.

## Consequences

History responses preserve every logical event while reducing wire bytes, Host response serialization and heap, browser JSON parsing and validation, Client entry allocation, and Conversation dispatch for long delta runs. The journal validates logical ranges before publication, so packed records neither create false gaps nor hide partial overlap. Direct `session.page` consumers must switch on `SessionHistoryRecord.type` and explicitly expand `record.event.data` when they require one event per member.

Cold persisted history is still decoded into the complete logical `SessionEvent[]` before the Host selects and repacks a page. This decision therefore improves transport and browser work, not the Host's cold-read decode memory. Eliminating that expansion requires a persistence-neutral message-boundary index or a separate streaming page reader and remains a distinct optimization.

The default Client history path exposes `SessionEventLike`, so consumers that require only canonical durable events must remain on Host `Session.events`, `session/event`, or an explicit decode path. A Definition that consumes Assistant deltas maintains equivalent scalar and packed branches. Scalar deltas already received live remain scalar in the current window; online replacement with a packed row is separate work, while reopen and reconnect install packed history.
