# Agent Note: Record unanswered tool results before closing a failed step

Status: implemented
Archived: 2026-09-30

English | [中文](2026-09-19-failed-step-tool-results.zh.md)

## Problem

A committed assistant message can request tools whose scheduler fails before all results are recorded. Closing the step and turn with those calls unanswered makes later model requests invalid for providers that require paired tool calls and results. An error turn is already closed, so crash-tail repair cannot recover it on resume.

## Decision

The AgentLoop driver records recovery results for unanswered calls before it closes a failed step, then propagates the original failure. Live step recovery and `interruptedTurnClosers` share incremental pending-call tracking and result construction; the live driver still owns its step and turn events. A step-local observer retains pending identities from committed events without copying session history. The scheduler stops replenishment and drains started dispatches before rejecting, so result recovery cannot race a live dispatch.

Recovery preserves committed results and follows the assistant's call order. A recorded `tool/call` without a result receives `TOOL_OUTCOME_UNKNOWN`; its text warns against blindly retrying an operation with possible side effects. An assistant request with no call record receives `TOOL_NOT_STARTED`. A call record precedes preparation and does not establish that the tool body ran, so unknown outcomes remain conservative.

This decision supersedes only the missing-result policy in [parallel tool-call execution](../feature/2026-07-10-parallel-tool-call-execution.md). Its classification, concurrency limit, ordering, and quiescence rules remain applicable.

## Alternatives considered

**Leave calls unanswered to avoid inventing tool outcomes.** An unanswered call invalidates later provider requests. An explicit unknown-outcome error records the limit of the available evidence without claiming success, cancellation, or absence of side effects.

**Repair only when resuming or forking.** The ordinary failure path already records `step/end` and `turn/end`; open-tail repair intentionally preserves closed history. Recovery belongs before those records, while the driver owns the failed step.

**Repair inside the tool scheduler alone.** Failure can occur after the assistant message is recorded but before scheduling starts. The step driver covers that interval and reuses the existing session repair semantics rather than adding a second implementation of call/result matching.

**Retry automatically.** A dispatch can have side effects even when its result is missing. The error result supplies retry guidance, while the turn retains the original failure and waits for later work.

## Consequences

Later requests, resume, and fork retain a usable call/result history after a live step failure. Recovery appends results; it does not remove assistant messages, replace completed results, execute tools, or convert the failed turn into success. The log uses existing event types and recovery codes, with no format change.

Already-closed inconsistent historical turns remain unchanged. The live recovery path requires the session to accept the missing result records; it cannot promise recovery from a failed log append.
