# Agent Note: The browser conversation is a log-ordered human transcript

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-30-web-transcript-log-ordered-projection.zh.md)

## Problem

The browser client built its conversation from the model-visible surface: `FoldAdapter` ran the core `SurfaceManager` over the history window and read `surface.nodes`. A successful compaction replaces a surface range with one checkpoint node, so the moment that replacement landed the web flow collapsed every message it shadowed into a single dim context row — conversation the user had already read. Nothing was lost from the log; the defect was entirely in the projection, and [the terminal and the host gateway were fixed the same way](2026-07-29-human-transcript-append-origin.md) while the browser was left for this change.

Surface order made two further problems structural. It is not seq-ascending after a replacement — `SurfaceManager` splices the high-seq checkpoint into the position of the range it shadows — so log-only nodes merged into that array by numeric seq (slash-command rows, interrupted frozen nodes) could be flushed ahead of the checkpoint and never interleave into the retained tail again. And because pagination no longer spends `maxMessages` quota on replacement copies, a page can now carry a checkpoint whose `surfaceOp.start` lies outside the window; the core fold rejects that range, so `nodes()` fell back to a lenient linear scan behind a `console.error` and published a `foldDegraded` flag describing the failure.

## Decision

`TranscriptAdapter` replaces `FoldAdapter` and never consults surface order. It projects the raw window in log order: every append-origin surface event (`isAppendSurfaceEvent`) at its own log position, plus one `CompactionSummaryNode` marker per landed compaction checkpoint. A landed compaction therefore keeps the conversation it shadowed on the model side, and the marker reports where the model stopped seeing that history instead of erasing it. Model-only replacement copies stay out of the transcript: a pruned `tool/result` and a regenerated `assistant/message` rewrite one node for the model and mark no boundary in the conversation. Everything that must send exactly what the model sees keeps reading the surface; this is the human projection, and the two are now separate on both frontends.

Node order is seq-monotonic by construction, and three things follow. The log-only `command/run` / `command/done` pair folds into `CommandNode`s that splice into an already-monotonic array by seq — no anchors, no reordering. `Session` keeps ownership of interrupted frozen nodes and merges them by their fractional seqs with a plain sort, which is now exactly flow order. And a window whose checkpoint cites a shadowed range outside it has no range to resolve, so the marker renders and nothing is logged.

`foldDegraded` is gone from `ConversationSnapshot`, and with it the padding sentinels, the `baseSeq` arithmetic they needed, and `degradedSeqs()`. They existed only to satisfy the core fold's `seq === index` assertion and to survive its throw; the fold they describe is no longer run. Deleting the flag is part of the fix, not cleanup after it — `degradedSeqs()` was already almost the log-ordered projection, reached after a thrown error instead of intended.

The marker's summary text, replaced-item count, and estimated shadowed-token count come from the checkpoint's cited `compaction/summary` event, never from the framed checkpoint payload, which is an instruction envelope written for the model. A window cut that left that event outside makes those fields unavailable, the same soft-fall as a call-less tool result, and a later page supplying the event resolves them.

The [manual compaction command](../feature/2026-07-30-queued-manual-compaction.md) returns the summary event's seq as the successful `CommandResult.sourceEventSeq`, and `command/done` persists that optional reference. Chat pairs only a successful named `/compact` command whose reference equals exactly one loaded `CompactionSummaryNode.summaryEventSeq`. The running command first renders `compact · Compacting context…`; after the checkpoint lands, the same React key renders one collapsed `compact` disclosure at the checkpoint's flow position with the count and token estimate. Input rejection, no compactable history, cancellation, and failure remain generic command rows with complete handler-authored text. Automatic compaction has no command reference and keeps the standalone context-compacted marker.

The explicit event reference matters because manual compaction permits durable context injection while its asynchronous summary is running: command and checkpoint rows are not guaranteed to be adjacent. The command lifecycle event gains one optional field, but the compaction transaction, RPC envelope, and model-visible surface do not change; pre-release persisted logs without the field keep the former two-row soft-fall and require no migration.

## Recognizing a checkpoint: one declaration, pinned at compile time

Recognition needs all three conditions, as in the terminal: `event.type === 'user/message'`, the compaction seam's checkpoint plugin source, **and** `isReplacementSurfaceEvent(event)`. A plugin-sourced `user/message` that *appends* is injected context — a session-reference card — not a compaction.

What is unreachable from a `packages/client/*` program is `dsh-compaction`'s **root**, not the package. The root reaches `dsh-session`'s root, whose cordis `Context` merge declares the host `sessions: SessionStore` against the client's `sessions: ISessions` — `TS2717`, the one-program-per-side rule in [development.md](../../../../docs/development.md#typescript-project-layout) — and that holds for a type-only import too, because the collision is a compiler fact rather than a bundler one.

The repo's answer to exactly this is a cordis-free leaf subpath, and this change adds one: `COMPACT_CHECKPOINT_SOURCE` and `isCompactCheckpointSource` now live in `packages/compaction/compaction/src/checkpoint.ts`, which imports no cordis and augments no module (the `dsh-commands/brand` / `dsh-llm/message` shape), and the root re-exports both so every host-side consumer — the terminal's chat helpers, `dsh-session-reference`'s projection — is unchanged. The adapter pins its literal to that declaration with a type-only import:

```ts
import type { CompactionCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
const COMPACT_PLUGIN: CompactionCheckpointSource['plugin'] = 'compact'
```

Renaming the Service Definition's plugin id is now a compile error in the client: `TS2322: Type '"compact"' is not assignable to type '"compaction"'`. The import must stay **type-only** — a value import of any `@deepseek-ai` package that is neither a platform module nor an inline-safe wire layer is rejected by the client purity gate (`packages/client/tsdown.client.ts`), whose own message records that type-only imports are erased and never reach it. A type-only leaf import needs both a `tsconfig.base.json` `paths` entry and `{"path": "../../compaction/compaction"}` in `packages/client/ui-chat/tsconfig.json` `references`: composite `rootDir` rules apply to erased imports as well, and without the reference the diagnostic is `TS6059`/`TS6307`.

`packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts` is the behavioral half, driving the compaction Definition with checkpoint and provenance records and proving that an older page can fill missing summary data. The Definition's type-only leaf import keeps the client isolated from the compact package root and the host-side `Context` merges reachable through it.

The divergence from the terminal is therefore narrow: both frontends recognize a checkpoint from the same declaration — the terminal value-imports `isCompactCheckpointSource` host-side, where no gate applies, and the client pins the type.

## What #835's positional anchors were for, and why they are dissolved rather than lost

The unmerged manual-compaction-queueing branch fixes the same interleaving bug by recording a per-event anchor — the surface tail at append time — and retargeting shadowed anchors onto the checkpoint. That mechanism exists to make positional anchors survive surface **reordering**. The human transcript is never re-ordered, so anchors have nothing to retarget: the precondition is removed, not the fix discarded. The mechanism does not exist in this codebase.

## Alternatives considered

**Value-import the predicate** from the new leaf and add `dsh-compaction` to the client `INLINE_SAFE` allowlist. Rejected: the client needs the plugin id, not the predicate — a type is enough, and an erased import never reaches the purity gate, so nothing has to be admitted to it. The allowlist would only matter for a value import, and there it is a poor trade: `INLINE_SAFE` matches on specifier *prefix*, so admitting the package admits its cordis-importing root along with the leaf.

**A bare shape rule** — any replacement `user/message` is a compaction. Rejected: correct only because compaction is the sole producer of replacement `user/message`s, with nothing to catch it if that changes. The pinning spec costs one file and removes exactly that risk.

**Tag the checkpoint host-side** through the projection or wire contract. Rejected: most aligned with the "collaborate through cordis services" rule, but the client folds raw `SessionEvent`s, so it means a wire contract change out of proportion to one pure predicate.

**Move frozen-node ownership into the adapter** (`nodes(extraNodes)`), as the unmerged branch does. Rejected: the interrupted nodes come from the `turn/end` sweep `Session` already runs over the window, and with a seq-monotonic transcript the simple shape is correct — the adapter returns nodes, the session merges frozen ones by seq. Widening the adapter's signature would buy nothing and split the sweep from its product.

**Keep `foldDegraded` as a defensive flag.** Rejected: it described a specific failure of a fold that no longer runs. A flag no consumer can act on, reachable only through a `console.error`, is a false contract.

**Pair the nearest `/compact` row with the next checkpoint.** Rejected: context injection may land between them, and concurrent or malformed lifecycle records must degrade without stealing another checkpoint. The command result instead names the authoritative summary event, and ambiguous references pair nothing.

**Parse the English settlement text for item and token counts.** Rejected: handler copy is presentation text, not a stable data contract. The marker reads the structured `compaction/summary` payload already owning both values.

## Consequences

Compaction no longer erases web history; a session compacted several times shows one marker per landed compaction, in log order, and the same window renders identically live and after a cold resume. The pagination hole is closed by construction rather than defended against, and `ConversationSnapshot` loses a published field, which touched thirteen files.

`ConversationNode` gains an eighth arm, so every exhaustive consumer grew one case: `MessageItem` renders the marker through the new `CompactionItem`, and the trajectory layout widens its no-cell arm so a marker contributes no cell but still advances the duration cursor.

The performance contract is unchanged and now simpler to state: one append materializes one node, an event that changes no node keeps the previous array reference — so a chunk storm costs nothing and `nodes()` is not even recomputed — and unchanged nodes keep their object identity. The window still grows with session length rather than with the surface, which is the trade the fix exists to make; a compaction used to bound the projection for exactly the long sessions compaction serves.

The web e2e scenario now seeds a real manual command lifecycle around a compaction transaction over its recorded turn, so the aria golden pins the complete behavior through the real host and a real browser: the recorded prompt and full tool output are still on screen, exactly one `compact` row reports scale after them, and its disclosure opens the exact summary. The seed recording itself is untouched and stays model-authentic — replay derives the manual compaction from the recording's own surface.

## Deferred

The terminal's [archived compaction progress decision](../../archived/feature/2026-07-30-compaction-progress-visibility.md) uses the live standalone bracket to drive a one-cell indicator and does not change this browser projection.
