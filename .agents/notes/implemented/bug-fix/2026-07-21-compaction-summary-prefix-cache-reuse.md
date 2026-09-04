# Agent Note: The summarization call replays the conversation prefix for KV-cache reuse

Status: implemented

English | [中文](2026-07-21-compaction-summary-prefix-cache-reuse.zh.md)

## Problem

Automatic compaction fires mid-conversation, right after the loop has warmed the provider's KV cache with the last routed request (`system` + `tools` + derived history). The default summarizer then issued a *separate* auxiliary request whose prefix shared nothing with that warm request: a bespoke summarizer `system` prompt followed by the older history flattened to a single rendered transcript string. A provider caches on the request's leading token sequence, so a first token that differs — a different system prompt — invalidates the entire cached prefix. Every compaction therefore paid full prompt-processing cost for the whole replayed history twice: once for the conversation request that tripped pressure, and again for the summarization call, defeating the cache exactly when the conversation is largest.

## Decision

The summarization directive moves from the **front** of the request (a fresh `system` prompt) to the **end** of the conversation (the final `user` message). The auxiliary call now reproduces the last routed request's prefix verbatim and appends one trailing instruction, so it is a genuine prefix-extension of the warm request and the provider reuses the cached tokens.

### `SummarizationInput` carries the replayed prefix, not a rendered string

`summarize()` (and the internal `summarizeWithLlm`) take a `SummarizationInput` — `{ system?, tools?, messages }` — instead of a flat transcript string. `region.ts` builds it from `session.requestHeader()` (the durable `system` and `tools`) plus the shadowed region mapped through `session.deriveEventMessage`, which yields byte-identical `Message` objects to what `deriveMessages()` folded into the routed request. `summarizeWithLlm` forwards `system` and `tools` onto `GenerateOptions` and sends `[...input.messages, { role: 'user', content: COMPACTION_INSTRUCTION }]`. `tools` ride along even though the summarizer never calls one: dropping them would shorten the token sequence and break alignment with the cached request.

### The instruction is a trailing user message

`COMPACTION_INSTRUCTION` opens "You are now acting as a compaction engine…" and directs the model to condense *the conversation ABOVE*. It keeps the prior checkpoint's structured headings and adds two rules the front-loaded system prompt did not need in its new position: do not mention the summarization request, and output only the checkpoint text without calling a tool. The shadowed region always ends on a tool-pairing-balanced boundary, so appending a `user` message after it is a valid message ordering for OpenAI-compatible and DeepSeek adapters.

### Cache reuse is best-effort, correctness is not

Auto-compaction always anchors at the surface head, so the shadowed region is the head of the routed request and the replayed prefix matches it exactly — the guaranteed-hit case. Manual mid-range `compactRegion` still replays the true prefix and stays correct, but forgoes reuse because its shadowed region is not the request head. A configured `summarizationProvider`/`summarizationModel` that differs from the conversation's route also forgoes reuse; that is the deployment's explicit trade-off, not a defect. Target resolution (configured override → latest routed header → agent options, else throw) is unchanged.

## Alternatives considered

- **Keep the summarizer system prompt but reuse the rest** — rejected: the system slot is the very first token region a provider caches on, so a distinct summarizer system prompt invalidates the whole prefix regardless of what follows. Only moving the directive off the front recovers the cache.
- **Send only the shadowed region without the `system`/`tools` head** — rejected: a differently-headed sequence still diverges from the cached request at the first token, so it caches no better while losing the framing the summary needs.
- **Omit `tools` from the summarization request** (the model never calls one) — rejected: tool schemas are part of the cached token sequence; omitting them misaligns every following token and defeats reuse.
- **A dedicated Agent-backed summarization sub-session for snapshot replay** — rejected: the durable `compaction/summary` event records the successful local call's position and complete output, while its explicit call marker prevents replay from treating template or remote output as a local stream. Creating a sub-session solely to obtain an Assistant settlement adds an unrelated lifecycle.

## Consequences

- **`dsh-compaction-basic`** owns `SummarizationInput`; the protected `summarize(input, agent, signal?)` hook signature changed (acceptable pre-release), and `region.ts` gained `buildSummarizationInput` folding `deriveEventMessage` over the shadowed seqs behind the header prefix.
- **Dead render surface removed.** The old flattening path (`renderTranscript` / `renderContentBlocks` and its spec in `dsh-compaction`) had no remaining consumer and was deleted with its export.
- **README model experience** for `dsh-compaction-basic` now documents the auxiliary request as the replayed prefix plus a trailing compaction-instruction message, and its KV-cache effect as reuse of the warm conversation prefix.
- **The framed checkpoint output is unchanged**, so the landed `user/message` and every conversation-request snapshot are unaffected; only the auxiliary request's shape changed.

## Testing

- **Unit:** `compaction-basic.spec.ts` asserts the auxiliary call forwards `system`/`tools`/leading messages and appends the compaction instruction as the final message, and that `compactRegion` replays the latest routed header prefix. Existing content assertions read the summarizer input through the replayed messages rather than a transcript string.
- **Loop:** `compact-loop-repro.spec.ts` classifies the summarization request by the compaction instruction in its trailing user message, and the overflow-recovery tests continue to pin conversation-vs-summary request counts across the real loop.
- **Snapshot:** keyless replay reconstructs one canonical successful stream from a marked `compaction/summary`; the [compaction-seam note](../feature/2026-06-18-compaction-capability-seam.md) owns the durable marker contract.
