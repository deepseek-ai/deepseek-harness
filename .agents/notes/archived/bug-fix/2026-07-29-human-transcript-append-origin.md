# Agent Note: The human transcript projects append-origin events

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-29-human-transcript-append-origin.zh.md)

## Problem

The terminal and the host history gateway both treated the model-visible surface as the human transcript. A successful compaction replaces a surface range with one checkpoint node, so the moment that replacement landed the terminal dropped every message it shadowed — conversation the user had already read — and re-ran that destructive rebuild on any later replacement. The same confusion reached pagination: `maxMessages` counted every `user/message` and `assistant/message` in the window, so a model-only replacement copy consumed a page slot the human never filled, and the cut could land between a compaction's log-only `compaction/summary` event and the replacement that cites it.

Nothing was lost from the log. `Session.snapshotEvents()` still returned every original message and full tool result; the surface only decides what the model is sent next. The defect was entirely in the projection.

## Decision

Model and human projections are separate, and the event's own marker decides which one an event belongs to. `dsh-session` exports the marker split `isAppendSurfaceEvent(event)` and `isReplacementSurfaceEvent(event)` over the two `SurfaceOp` variants, from the browser-safe `surface` module. Append-origin events are the durable source for a transcript; replacement copies stay model-only. Everything that must send exactly what the model sees — `deriveMessages`, token accounting, the compaction backends, tool pairing, injected-context liveness, cross-session reference projection — keeps reading `session.surface`.

The terminal replays the transcript from append-origin surface events and keeps a shadowed step's tool cards paired through `transcriptToolCallIds`, which reads the append-origin `assistant/message` rather than surface membership. A landed compaction contributes one dim `… earlier context was compacted …` row at its own log position: the marker reports where the model stopped seeing that history instead of erasing it. The framed checkpoint payload never renders, and both paths classify a surface event by the same marker, so a compaction that arrives live and the same log replayed after resume produce the same transcript. Only replay re-derives `tool/call` pairing: a call event carries no marker of its own and inherits membership from the `assistant/message` that advertised it, which the live listener has necessarily just rendered.

A checkpoint is recognized through the compaction seam's own contract — `isCompactCheckpointSource`, the backend-independent marker `CompactionEngine` requires on the replacement user message — so the terminal depends on the declared vocabulary, not on the shape of the replacement. `dsh-session-reference` already consumes that predicate to project another session's log; this is the same question asked by a different reader. Other replacements are silent: a pruned `tool/result` and a regenerated `assistant/message` rewrite one node for the model and mark no boundary in the conversation.

`session.history` counts only append-origin messages toward `maxMessages`. Each page remains one contiguous raw event range, so a compaction's `compaction/summary` event stays on the page of the replacement that cites it.

No persisted event, RPC envelope, compaction transaction, or model-visible surface changed, and no migration is required.

## Deferred

The browser client is fixed separately, in [the web transcript projection note](2026-07-30-web-transcript-log-ordered-projection.md): it projects the same append-origin transcript in log order and renders a marker component, and it closes the pagination hole this change opened — because `session.history` no longer spends quota on the checkpoint, it never cuts on the checkpoint and its cited source events as a unit, so a page can carry a checkpoint citing a `surfaceOp.start` outside the window, which the browser's surface fold rejected. That hole predates this change (counting could already run past a checkpoint into the range it shadows), but when the checkpoint was the oldest counted message, the old pagination rule happened to include the whole shadowed range on the same page.

The terminal's [archived live compaction progress decision](../../archived/feature/2026-07-30-compaction-progress-visibility.md) uses standalone bracket events to drive the existing one-cell indicator. It does not change the completion marker owned here or add scale: the checkpoint's `sourceEventSeqs` remain available for a separately justified count or range. Progress therefore needs neither marker-content changes nor a prerequisite `renderReplacement(event)` extraction.

## Alternatives considered

**Recognize a checkpoint by shape (a replacement `user/message`).** Rejected: it reads a coincidence of the shipped producer set instead of a declared contract, and any future producer that replaces a range with a user message would silently inherit the compaction marker. The seam already publishes `COMPACT_CHECKPOINT_SOURCE` precisely so consumers can recognize a checkpoint independently of the backend.

**Keep rendering the checkpoint as an injected-context card.** Rejected: the framed checkpoint is an instruction envelope written for the model, not human conversation content. Showing it while hiding the history it replaced inverts what the reader needs.

**Persist a second display transcript.** Rejected: the append-only log already contains the authoritative source material, so a parallel record buys nothing and adds migration and consistency work.

**Derive the marker from the `compaction/*` bracket instead of the checkpoint.** Rejected for the transcript: the bracket is a pair of time-point markers around an operation, while the transcript needs the position where the surface actually changed. The bracket is the right source for progress and duration, which this change does not render.

**Classify events by re-folding the log, as `session-query` does for search (`current` / `shadowed` / `log-only`).** Rejected: a fold answers a whole-log question, while a projection asks a per-event one that the event's own marker already answers in constant time.

## Consequences

Compaction no longer erases terminal history; a session compacted several times shows one marker per landed compaction, in log order. Pagination pages can carry more raw events than before, because quota is spent only on messages a human or model actually produced.

`rebuildTranscript` now materializes a component per append-origin event in the whole log, and it runs on mount, on a terminal color-scheme change, and on every reasoning toggle. Compaction used to bound that work for exactly the long sessions compaction serves, so the cost now grows with session length instead of with the surface. That is the trade the fix exists to make — preserved history is the point — but a windowing or reuse strategy belongs to whoever first measures a slow rebuild, not to a later profiler wondering why the work grew.

`dsh-tui` gains a dependency on the `dsh-compaction` seam for one pure predicate, mirroring `dsh-session-reference`'s existing use. The terminal still needs no compaction backend at runtime.

Two behaviors changed with their tests. The surface-replacement terminal test previously pinned erasure ("hides shadowed tool calls") and now pins preservation plus exactly one marker, including a pruned result copy, a regenerated assistant message, and a foreign plugin's replacement all rendering nothing. The compaction snapshot scenario wrote a `agent-instructions` source while claiming to pin compaction; it now writes a real checkpoint source, and its three fixtures are re-recorded to show the preserved prompt, the full tool card, and the marker.

The live/replay equivalence above is fixture-pinned, not only asserted here: `surface-replayed-compaction` mounts with the replacement already stored and records byte-identical to the live path's `surface-after-compaction-wide`. Changing either path breaks that equality, which is the point — the resume projection is what regressed for users, and the two fixtures must move together.
