# Agent Note: headless streams provider reasoning to stderr

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-21-headless-reasoning-progress.zh.md)

## Problem

The one-shot headless runner waits for complete Agent quiescence before printing the final Assistant text. Reasoning-capable providers expose reasoning through live `agent/assistant-stream` chunk frames and the final durable settlement, but a long reasoned response leaves the terminal silent if the runner observes only settled history. The final answer must remain the only stdout payload so command substitution and other consumers keep a stable result channel.

The earlier [direct core entry-point decision](../architecture/2026-08-09-headless-direct-core-entry-point.md) required empty stderr on every successful run. That clause prevents live reasoning progress and is superseded by this note; its transport, durability, and completion decisions remain unchanged.

## Decision

`headless-runner` observes `agent/assistant-stream` for the exact Agent it creates after startup quiescence and before submitting the task. Once the owned interval opens with `turn/start`, each non-empty `reasoning-delta` chunk frame is written immediately to stderr. A contiguous reasoning phase starts with `dsh: reasoning:` on its own line; deltas retain provider order without token-boundary decoration. Reasoning block boundaries and usage metadata keep that phase open; a later non-reasoning block or output delta, stream end, new turn, or listener disposal terminates it with one newline when the provider supplied none.

This output is a transient projection of the process-local Assistant stream. The runner still derives final text and exit status from the flushed durable Session settlements rather than from progress-presentation state. SDK projections do not expose the live frames.

Reasoning progress is not TTY-gated and has no separate flag. A redirected stderr stream and a supervisor receive the same provider-reported content as an attached terminal. A successful run without reasoning still writes nothing to stderr; terminal model and driver errors keep their existing `dsh:` diagnostics after any open reasoning phase is terminated.

## Verification

The package test holds the Agent active after a reasoning frame and observes stderr before idle, then pins newline ownership for provider-terminated and unterminated phases plus terminal errors. The owner-local product expectation drives the shipped headless profile through a reasoning-plus-tool round and pins both stderr and the persisted Session. Recorded-session replay reconstructs expected stderr by expanding embedded Assistant streams, closes sections on text and tool-call output, and uses the raw run log before fixture path tokenization in record modes. Built-bin acceptance sends `reasoning_content` through the native DeepSeek SSE adapter and requires reasoning on stderr while stdout remains the final answer.

## Alternatives considered

**Dump reasoning after quiescence.** Folding reasoning from the persisted log would preserve content but leave the terminal silent during the long-running interval that motivates the feature.

**Wrap the LLM stream.** Tapping `ctx.llm.stream()` would place a presentation concern in the request path and duplicate the scoped frames that the agent loop already publishes.

**Print a spinner or periodic heartbeat.** A timer reports process liveness rather than provider progress, adds an interval policy, and still hides reasoning that the provider already supplies. Time before the first reasoning delta remains silent and can be addressed separately if providers buffer their first token.

**Enable output only on a TTY or explicit flag.** Headless runs under CI and supervisors need the same progress signal, while implicit TTY-dependent behavior makes redirected runs differ from interactive runs. Callers that do not want reasoning logs redirect stderr.

## Consequences

Reasoning-capable successful runs now write provider-reported content to stderr, so log collectors may retain substantially more and potentially sensitive model output. Stdout remains one final assistant result, text-only success keeps stderr empty, errors remain line-separated, and no new configuration or durable format is introduced. Silence before the provider emits its first non-empty reasoning delta remains an explicit limitation.
