# Agent Note: Distinguish Session event identities from log offsets

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-31-session-sequence-and-log-offset-brands.zh.md)

## Problem

Session positions used one structural `number` type for two incompatible meanings. An event reference names an existing row, while a prefix length, next append position, or read cut names a gap and may equal the event count. The compiler therefore accepted an offset where an event identity was required and could not expose a missed sequence-field migration.

`SessionHeader.seedLength` also mixed a v0 storage coordinate into metadata used by body-free readers. Listing needs to know whether a Session has fork lineage, but only a reader that holds the event body can interpret the exact inherited prefix length.

## Decision

`@deepseek-ai/dsh-brand` exports the erased numeric primitive `BrandedNumber<B>` and the runtime-identity helper `brandNumber()`. `@deepseek-ai/dsh-session` owns two validated brands: `SessionSeq` names one existing event and `SessionLogOffset` names a log gap, prefix length, or read offset. `SessionSeqCursor = SessionSeq | -1` represents an inclusive watermark before or after the first event, and `OptionalSessionSeq = SessionSeq | null` represents an event identity whose absence is data.

`SessionEvent.seq`, surface replacement endpoints, provenance, and owner payload fields that identify Session events use `SessionSeq`. `Session.seq`, `Session.firstLiveSeq`, `Session.inheritedEventCount`, body-read offsets, and inherited prefix cuts use `SessionLogOffset`. Arithmetic returns an ordinary number and re-enters either domain through its validating constructor.

The logical `SessionHeader` carries `isSeeded: boolean` and no numeric seed cut. Body-bearing storage values and observations carry `inheritedEventCount` beside the header; `Session.ownEvents()` and `Session.isOwnSeq()` hide the comparison from ordinary consumers. A seeded constructor requires an explicit seed and exact cut, including an empty seed with cut zero, because constructor input may contain child-owned setup events after the inherited prefix.

The v0 JSONL header remains byte-compatible: absent `seedLength` decodes to `isSeeded: false` with cut zero, while present zero or nonzero values decode to `isSeeded: true` with the exact cut. Header-only listing translates only the presence bit. API, SDK, DeepSeek, telemetry, query-row, and JSON representations continue to carry ordinary numbers; their owning adapters validate and brand values when they enter same-process domain code.

## Admission and ownership

Domain constructors reject negative, fractional, non-finite, and unsafe integer values. Parsers validate a raw number once and retain the parsed object where the brand does not require a runtime wrapper. A compile-time brand does not discover unknown numeric fields in an external event; a format migration still needs an exhaustive owner disposition and must refuse schemas it cannot safely rewrite.

`session/end-seed` remains a lifecycle marker, not the source of the inherited cut. Every constructor restore appends or retains that marker, including unseeded replay, so projections and cold readers receive `inheritedEventCount` explicitly instead of scanning the log.

## Alternatives considered

**Keep every position as `number`.** Rejected because event identities, counts, and cursors cross package and persistence seams frequently enough that accidental interchange is a migration risk, not a local arithmetic convenience.

**Use one branded Session position for identities and offsets.** Rejected because it would again permit `eventCount` or `fromSeq` where an existing event is required and would force the `-1` and `null` sentinels into unrelated operations.

**Derive the inherited cut from `session/end-seed`.** Rejected because the marker records constructor lifecycle, not only fork lineage, and a constructor seed may contain child-owned events after the inherited prefix.

## Consequences

Sequence-bearing code now states whether a number identifies an event or a gap. Header-only readers receive stable lineage metadata without opening the body, while persistence, projection, query, and authorization paths retain the exact cut they need. The on-disk v0 format and public numeric wires do not change.

The cost is explicit conversion at durable and wire parsers and a separate exact-cut field on body-bearing observations. Projection-cache identity includes the lineage bit and exact cut, so its disposable storage domain advances and older rows rebuild on demand; body-free readers skip seeded cache hints when they do not hold the cut. Turn numbers, step numbers, message-list indexes, workflow member ordinals, token counts, and unrelated numeric domains remain plain numbers because they do not identify Session events.

## Testing

Type assertions pin that `SessionSeq` and `SessionLogOffset` are not interchangeable. Runtime suites cover constructor validation, mixed inherited and child-owned seeds, empty seeds, `ownEvents()` and `isOwnSeq()`, v0 JSONL absent/zero/nonzero headers in plain and Zstandard encodings, header-only listing, cold prepare and reopen, query and projection cuts, and unchanged numeric wire values.
