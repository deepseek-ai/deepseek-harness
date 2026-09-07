# Agent Note: Reuse spill storage for truncated session references

Status: implemented

English | [中文](2026-09-05-session-reference-spill-reuse.zh.md)

## Problem

A bounded cross-session preview can omit whole messages or most of a retained message. A model that sees only the preview needs an accurate account of the omission and a way to inspect the captured text, without treating another session's instructions as current authority. Rereading the source later would not recover the same observation when the source advances or compacts.

## Decision

[Session-reference preparation](../../../../packages/context/session-reference/README.md) retains its existing preview policy and per-reference JSON byte budget. Each truncated reference attempts `saveText` through optional `ctx.get("spillStore")`; an untruncated reference writes no artifact. The full transcript and bounded preview derive from the same captured user/assistant text projection, including compaction checkpoints but excluding tools, reasoning, and other injected context. No second source read occurs.

The artifact belongs to the target session receiving the context. Its descriptive source is `{ kind: "session-reference", sessionId, label }`, where `sessionId` identifies the referenced session. [Spill storage](../../../../packages/spill/spill/README.md) accepts this minimal alternative alongside the existing tool source; it requires no fabricated tool name or call id. Storage ownership does not authorize retrieval.

A separate omission notice outside the bounded preview JSON records exact `omittedMessages` and `omittedBytes`. It carries the saved locator and backend `retrievalHint`, or an unavailable outcome distinguishing missing storage from a failed save. This notice is model-visible content in the same durable reference message, not metadata-only UI decoration. A tiny preview budget cannot remove it. The saved transcript carries capture metadata, including `capturedFormatVersion`, and the same untrusted-background warning as the preview. Per-message JSON string fragments contain at most 64 Unicode code points per line; decoding and concatenating them restores exact text, including original newlines. This fixed artifact format keeps long single-line middles retrievable with ordinary paged file reads without changing preview retention.

Cancellation after an asynchronous save prevents context publication, even if storage already created the artifact. The consumer does not add rollback or deletion APIs; the existing backend expiry policy governs that artifact. Replay uses the logged preview and notice and never repeats the save or source read.

## Alternatives considered

**Write a separate session-reference file store.** Rejected because private naming, session-scoped ownership, locator guidance, and artifact lifetime already belong to spill storage. A second store would duplicate those policies.

**Reread the source when saving or retrieving.** Rejected because source mutation could make the artifact disagree with the preview and its captured sequence. Saving the original projection preserves the observation.

**Put omission and retrieval data inside the bounded preview JSON.** Rejected because that spends the conversation budget on metadata and can hide the notice precisely when the budget is smallest. Separate durable model-visible text preserves both obligations.

**Use tool provenance for every spill.** Rejected because a session reference has no model-issued tool call. Invented tool ids would misattribute the artifact rather than describe its producer.

## Consequences

The model can inspect text omitted from a preview without increasing the preview budget. Notices add request tokens outside that budget, and retrieval adds the requested transcript text later. Storage is best-effort: an unavailable notice is honest about loss of retrieval while the bounded preview remains usable. A saved locator can expire even while its notice remains in durable history; this feature does not promise permanent archival or recover content already removed by source compaction.

## Verification

The [unit suite](../../../../packages/context/session-reference/tests/session-reference.spec.ts) pins omission counts, full Unicode and control-character recovery, whole-message drops, three-reference isolation, missing and failed storage, source exclusions and mutation isolation, and cancellation before publication. The [Loader composition test](../../../../packages/context/session-reference/tests/loader-composition.spec.ts) exercises the real local store and paged `read` tool against the middle of a giant single-line message, with target-session storage ownership. The [keyless recorded-session scenario](../../../../snapshots/session/session-reference-spill/snapshot.yml) pins the durable model-visible reference context. Nested Windows-locator regressions cover both serialized extraction and normalization without rewriting unrelated backslashes. Replay [normalizes known quoted spill locators](../../../../packages/test-support/session-snapshot/README.md) while preserving saved byte lengths and omission counts.

## Related decisions

The [tool-output spill decision](../architecture/2026-07-08-tool-output-spill-files.md) remains active: its storage/policy separation, failure degradation, provider caps, and retrieval alternatives still constrain tool consumers. This note extends its producer vocabulary without replacing that rationale. [Separate context injection from turn execution](../architecture/2026-07-24-separate-context-injection-from-turn-execution.md) remains the authority for durable message admission, and [producer-declared context forms](../feature/2026-08-05-context-form-vocabulary.md) remains the authority for recall presentation.
