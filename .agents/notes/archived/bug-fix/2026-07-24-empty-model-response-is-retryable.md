# Agent Note: Empty model completions are retryable EMPTY_RESPONSE failures

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-24-empty-model-response-is-retryable.zh.md)

## Problem

Providers occasionally return a degenerate completion: a well-formed stream that carries a terminal `stop` finish and zero content blocks — no text, no reasoning, no tool calls. If an adapter maps this shape to a successful `{kind: 'stop'}` finish, the loop logs an empty `assistant/message` and ends the turn as `completed`. Retry never runs, no failure reaches the caller, and a driver such as goal-round-driver consumes a round without progress.

## Decision

An adapter classifies a completed empty response as a provider-boundary failure, and retry policy treats it as transient:

- `dsh-llm` exports the canonical code `EMPTY_RESPONSE_CODE` (`'EMPTY_RESPONSE'`) beside `CONTEXT_WINDOW_EXCEEDED_CODE`/`QUOTA_EXCEEDED_CODE`.
- `dsh-llm-pi-ai` (`mapStopReason`): a terminal `stop` whose assistant message has no content blocks becomes a `finish {kind: 'error'}` with that code. Context-overflow detection still wins where it applies (it is checked first and is the more actionable classification).
- `dsh-llm-deepseek` (`translate`): at `[DONE]`, a `stop` (or absent) finish with no opened blocks becomes the same error finish. Reasoning-only streams count as content and stay successful.
- The provider-owned normal retry default includes `EMPTY_RESPONSE`: the attempt produced nothing durable, so repeating it is safe; deployments can still remove it via `retryableCodes`, and `dsh-llm-retry` executes the resolved policy.

Detection is scoped to `stop` finishes only. `max-tokens` with empty content keeps its existing meaning (pi-ai already normalizes the zero-output overflow case), `tool-calls` cannot be block-empty in practice, and error/aborted finishes already fail.

The classification uses the existing loop machinery — `finishError` → `agent/request-error` → `dsh-llm-retry` — and keeps `agent-loop` provider-neutral. Exhausting the retry budget ends the turn with an explicit `EMPTY_RESPONSE` failure instead of an empty success.

## Alternatives considered

**Detect in the loop or `BlockAssembler`.** One shared implementation, but it moves provider-response judgment into the loop, against "plugins, not loop changes", and the assembler is a pure assembly algorithm. The adapter is where wire facts become harness classification, with the overflow reclassification as exact precedent.

**A stream-transform plugin on the `llm/stream` waterfall.** Provider-neutral and one implementation, but it adds a package plus wiring for what is a boundary fact each adapter can state in a few lines, and default-on behavior would still require touching every bundle.

**Treat whitespace-only or reasoning-only responses as empty too.** Rejected as overreach: those carry model-produced content, and misclassifying a legitimate (if useless) response as a transport-class failure risks retry loops on models that intentionally stop after reasoning. The scope is exactly "zero content blocks".

## Consequences

- A transiently misbehaving provider consumes a bounded retry instead of a turn with no output; a persistently empty model produces an actionable `EMPTY_RESPONSE` turn failure.
- A model that genuinely intends to say nothing (rare, but possible after a tool result) is retried and, if consistently empty, fails the turn. This trade was accepted deliberately: an empty assistant message is indistinguishable from the provider defect and has no value to the user.
- The [`empty-response-retry` headless snapshot](../../../../snapshots/session/empty-response-retry/) is an authored keyless scenario with a deterministic 1 ms zero-jitter retry overlay. It pins a durable `llm/retry` event, no output for the discarded attempt, the recovered reply, and a clean completed turn.
