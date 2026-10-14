---
kind: upgrade-guide
description: "Session-title providers register directly, own their strategy settings, and share only prepared execution."
---

# Migrate session-title providers

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-session-title-llm` no longer exports `registerSessionTitleLlmProvider`, `generateSessionTitleWithLlm`, or `SessionTitleLlmMessageSelector`. `SessionTitleLlmConfig` now holds only execution controls (`maxInputBytes`, `maxOutputTokens`, `timeoutMs`, and the optional `provider`/`model` pair); `targetWords` and `targetCjkCharacters` moved into each provider's own `Config`. Each provider owns its system instruction, message framing, title parsing, reasoning selection, and output interpretation, registers directly with `ctx.sessionTitle.register()`, and calls `executeSessionTitleLlm(ctx, config, request, providerId, { system, input, messageSeqs, selectReasoningEffort })`. That function returns the assembled content blocks, the terminal finish, and the used model route. `SessionTitleProviderRequest` gains an optional `currentTitle` snapshot.

## Migration

1. Replace a `registerSessionTitleLlmProvider(...)` call with a direct `ctx.sessionTitle.register({ id, automatic, generate })`; keep the same `id` and cadence.
2. In `generate(request)`, build your own system prompt and user input, pass a `selectReasoningEffort` function, then call `executeSessionTitleLlm` with `{ system, input, messageSeqs, selectReasoningEffort }`.
3. Reject a `tool-calls` or `max-tokens` terminal finish and tool-call blocks; derive the title from the text blocks.
4. Read `request.currentTitle` when the strategy should preserve an accepted provider title; it is absent before any title.
5. Generate a title and confirm the saved result plus the exact `session/title-llm-request` record.
