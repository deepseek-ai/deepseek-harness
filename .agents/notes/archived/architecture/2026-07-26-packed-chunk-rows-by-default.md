# Agent Note: Make packed chunk rows the default JSONL layout

Status: implemented
Archived: 2026-09-01

English | [中文](2026-07-26-packed-chunk-rows-by-default.zh.md)

## Problem

Provider streams produce many token-sized `assistant/chunk` delta events whose repeated JSON envelopes can outweigh their payloads. The session log must retain each chunk as a distinct logical event: live `session/event` delivery, sequence numbers, `sourceEventSeqs`, replay, cancellation evidence, and UI streaming all depend on those boundaries.

The JSONL storage seam can reduce that envelope cost without changing the logical log. A run of at least three consecutive same-block delta events fits in one `text-chunks`, `reasoning-chunks`, or `tool-call-chunks` storage row, and decoding reconstructs every original event, timestamp, and sequence number. A credible default must cover runtime writers, app-level config, snapshot producers, and committed fixtures together; otherwise tests avoid the layout that deployments write.

## Decision

`dsh-session-persistence-jsonl` resolves an omitted `packChunks` to `true`. The ACP demo wrapper exposes the same default, and every composition that omits the field inherits packed writes. `packChunks: false` remains an explicit write-side diagnostic mode that stores one event per line.

Reading is unconditional and layout-blind. Packed, unpacked, and mixed files load into the same contiguous `SessionEvent[]`, so the default does not require a session-format version change or an on-disk runtime migration. The option controls newly appended batches only; it never selects a reader mode.

### Logical events and physical rows

The JSONL packing path stays at the `dsh-session` storage seam through `packChunkRuns()` and `decodeStorageRecord()`. The encoder recognizes exact delta-event shapes, preserves unrecognized events verbatim, and packs only runs of at least three. A packed row is encoding vocabulary, not a `SessionEventMap` member: it never enters the Session log or fires `session/event`. The [packed session-history transport decision](2026-08-15-packed-session-history-transport.md) reuses this vocabulary for a bounded lossless wire interval without changing those event semantics.

The JSONL backend packs each durable append batch. Raw `compression: 'none'` and default Zstandard framing carry the same logical storage records; selecting raw mode for reviewable fixtures does not disable packing. Repository replay readers and normalizers decode the shared row format instead of maintaining snapshot-specific codecs.

### Canonical snapshot fixtures

Every committed session-format JSONL fixture uses the canonical packed representation. `scripts/session-fixture-layout.snapshot.ts` discovers tracked `*.jsonl` files and unignored untracked additions repository-wide, selects those whose first record is a `session` header, decodes all body records, and rejects content that differs from `packChunkRuns()` output. The inventory therefore includes ACP, headless, TUI, `apps/web`, parent sessions, child sessions, and future fixture names without a maintained path list.

ACP and headless snapshot runs harvest the default JSONL backend output. TUI and web record-mode writers apply `packChunkRuns()` to their in-memory events before writing fixtures. The authored `packed-chunks` ACP scenario runs under the ordinary config and retains all three packed row kinds; its contract decodes both its independent source fixture and target fixture before asserting event-for-event equality.

Focused package tests keep unpacked and mixed-layout inputs for reader compatibility. They do not opt the default snapshot corpus out of the canonical layout.

### In-flight branch convergence

The temporary [`scripts/migrate-packed-session-fixtures.ts`](../../../../scripts/migrate-packed-session-fixtures.ts) command lets in-flight branches converge after merging current `master`: `pnpm run migrate:packed-session-fixtures` discovers the same repository-wide fixture set as the permanent gate, preserves each header line, decodes existing mixed records, writes the canonical packed body, proves decoded equality, and proves idempotence. It never calls a model or regenerates transcript and presentation outputs.

The command remains linked from the testing policy and ACP snapshot README while older branches may carry fixture edits. The [removal proposal](../../proposed/process/2026-07-26-remove-packed-session-fixture-migrator.md) deletes the CLI, package command, this transitional section, and the documentation links, then replaces the permanent gate's command-specific remediation text once a live open-PR inventory shows that every affected branch is merged, closed, or canonical. The shared canonicalizer and snapshot gate remain permanent.

### Verification contract

JSONL persistence tests prove that omission writes a packed row, explicit `false` writes one event per line, and both forms load identical events. Canonicalizer unit tests cover header preservation, unpacked conversion, non-session JSONL, already-packed idempotence, and malformed input. The keyless snapshot gate covers every committed fixture and assembled replay path; documentation gates keep config defaults and bilingual contracts aligned.

## Alternatives considered

**Flip only the backend schema default.** This leaves wrapper defaults, direct TUI/web serializers, existing fixtures, and future fixture policy inconsistent. A default is meaningful only when shipping compositions and the tests representing them share it.

**Keep snapshots unpacked for readability.** Packed rows retain every fragment and timestamp explicitly, while the shared decoder and normalizer provide logical inspection. Keeping the largest committed consumer on a different layout would make snapshot coverage avoid the shipping write path.

**Remove `packChunks` and always pack.** One writer is simpler, but one-event-per-line output remains useful for diagnostics and for focused mixed-layout compatibility tests. The explicit opt-out preserves those current consumers without weakening the default.

**Batch chunks as logical session events.** This reduces event count, but it delays or reshapes live delivery, renumbers the chunk seqs cited by assistant messages, and requires every UI and replay consumer to understand another streaming unit. Physical packing obtains the storage benefit behind the existing persistence interface.

**Keep the branch migrator permanently.** The read-only canonicalizer and snapshot gate own continuing enforcement. A mutation command has value only while in-flight branches still carry the former fixture layout, so its lifetime is explicitly bounded by the removal proposal.

## Consequences

Ordinary JSONL writes and committed fixtures use fewer physical rows while preserving the exact logical event stream. Runtime readers accept every existing layout, and operators retain a deliberate unpacked diagnostic mode. Raw files are less convenient for per-token line processing, and external tools that incorrectly treat every post-header row as a `SessionEvent` encounter storage tags more often; supported readers call `decodeStorageRecord()`.

The repository carries a large mechanical fixture diff, reviewed through decoded equality and the canonical-layout gate rather than token-by-token line inspection. It also temporarily carries one branch migration command and its links; the separate removal proposal prevents that transition aid from becoming permanent process surface.
