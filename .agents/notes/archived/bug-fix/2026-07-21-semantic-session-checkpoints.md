# Agent Note: Semantic session checkpoints

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-21-semantic-session-checkpoints.zh.md)

## Problem

Persistence buffered every synchronous `session/event` until the loop's final turn checkpoint. A turn is the correct conversational transaction, but it is too coarse as the only crash-recovery point: a hard crash during a long model request or tool call could discard the whole in-flight turn, including the request envelope needed to identify what had been attempted. A tool call with no result was also repaired with one undifferentiated interruption error, so the resumed model could not tell whether execution had started and could retry a side effect blindly.

## Decision

`dsh-session-checkpoint-policy` owns semantic durability barriers as a zero-config plugin beside a persistence backend. At `agent/pre-step`, it flushes pending prompt input or the preceding response/result batch before the next request is derived. It wraps `llm/stream` lazily and flushes the live session after `request/header` is logged but before the adapter stream is constructed. It wraps top-level `tools/execute` after ordered pre-execute policy and flushes the recorded `tool/call` before the tool body; nested dispatches reuse the outer model-visible call. The loop's final `turn/end` checkpoint remains the closing boundary and settles before another queued turn or idle observation.

Persistence and checkpoint scheduling remain separate Cordis plugins. A backend makes requested `session/flush` boundaries durable but does not choose them; loading it without this policy is valid and retains the loop's coarser checkpoints. First-party persisted apps and runtimes explicitly mount both, while a specialized deployment may intentionally omit or replace the policy. Registration order governs whether events appended by other `agent/pre-step` listeners precede this checkpoint; prompt input and the preceding loop-owned assistant message and ordered results are already in the log.

Checkpoint failure and cancellation are fail-closed at effect boundaries. A rejected request checkpoint prevents adapter dispatch; a rejected tool checkpoint becomes an error result without invoking the tool body. If cancellation lands while the tool checkpoint is pending, the policy rechecks the signal and returns the canonical `ABORTED_BEFORE_DISPATCH` result. A rejected between-step checkpoint closes the turn before another model request. A rejected final turn checkpoint is reported live and does not prevent later queued work. Persistence serialization continues to belong to the coordinator, so concurrent tool checkpoints cannot duplicate event sequences.

The ACP app owns its bridge, checkpoint policy, and persistence backend in one ordered Cordis effect. Cordis unloads sibling plugin effects concurrently, so independent mounts would let persistence detach while bridge teardown was still closing an interrupted turn. The composite lifecycle unloads the bridge first, waits for its agents to quiesce and flush the real `step/end` and `turn/end`, then removes checkpoint scheduling and persistence.

Crash repair distinguishes durable evidence. An assistant tool request without a `tool/call` becomes `TOOL_NOT_STARTED` and may be retried if still needed. A durable `tool/call` without a result becomes `TOOL_OUTCOME_UNKNOWN`; its model-visible result permits retry only for read-only or idempotent operations and directs the model to verify external state or ask the user before deciding about side-effecting work. A provider that supports idempotency keys can receive the stable `callId`, but the Harness does not claim generic exactly-once effects.

## Alternatives considered

Flushing every event or streaming chunk minimizes loss but turns local append and `fsync` latency into the hot path and destabilizes streaming throughput. Moving the barriers into `agent-loop` prevents omission for that loop but hides checkpoint policy inside the mechanism and removes Cordis-level replacement and ordering. Keeping turn-only flush preserves throughput but loses the request and execution intent needed for safe recovery. Automatically retrying every unmatched call is safe only for a subset of tools and can duplicate irreversible effects.

## Consequences

Hard-crash recovery retains the complete model request, durable tool intent, and complete settled step at the nearest semantic boundary while allowing partial streaming chunks since the previous boundary to remain lossy. Default CLI, TUI, ACP, Python SDK runtime, headless persistence tests, and JSON-RPC compositions mount the policy with their persistence backend. Unit tests cover ordering, cancellation during a checkpoint, fail-closed behavior, nested dispatch, disposal, Loader shape, and final-checkpoint ordering and failure containment; a real child process killed with `SIGKILL` proves request and tool-intent recovery through JSONL, and the shared persistence contract proves both recovery classifications across backends. The crash harness waits for the expected marker contents rather than path existence, so open-before-write visibility cannot trigger the kill early. Keyless ACP and SDK snapshots prove that retry-risk guidance reaches resumed history and the next model turn, graceful cancellation persists the loop's real closing boundaries, and SDK shutdown observes the complete persisted turn.
