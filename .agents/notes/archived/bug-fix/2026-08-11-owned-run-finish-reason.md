# Agent Note: Owned-run finish reason reporting

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-11-owned-run-finish-reason.zh.md)

## Problem

Python SDK consumers need a concise classification of how an owned activity interval reached idle. Requiring each consumer to scan raw `turn/end` events duplicates protocol knowledge, while a generic success status loses token-limit and model-error distinctions.

## Decision

`RunResult.finish_reason` is the string `kind` from the last root-session `turn/end` collected between the submitted message's durable inbox receipt and the next whole-agent idle. It is `None` when the interval contains no `turn/end`. A `turn/end` without a string `data.reason.kind` raises `SdkProtocolError` instead of being reported as an interval without a turn ending. The field describes the owned run interval; it does not assign that ending to the submitted prompt. The [owned-run boundary decision](../architecture/2026-07-30-followup-enqueue-and-owned-runs.md) continues to prohibit prompt-level result attribution.

The field exposes only the kind because callers need a stable classification and the complete structured reason remains available in `RunResult.events`. Transport loss, timeout, and protocol failures still raise instead of producing a finish reason.

## Alternatives considered

**Restore `status`.** A deployment-mapped `ok` or `error` status conflates distinct durable endings and resembles transport success, so it does not answer why the interval finished.

**Expose a model `FinishReason`.** A run may contain multiple model steps, and intermediate `tool-calls` endings do not finish the run. The agent's last `turn/end` is the relevant run-level observation.

**Call the field `stop_reason`.** ACP and subagent seams map turn-ending reasons into their own `stopReason` value sets. The Python field preserves the raw agent reason kind, so sharing their name would imply a mapping this interface does not perform.

**Expose the complete structured turn reason.** The raw event stream already preserves error and cancellation details. Duplicating that object on `RunResult` would create two representations that Python callers must reconcile.

## Verification

Python SDK tests cover selection of the last turn ending, an interval without a turn ending, and rejection of a malformed turn-ending reason. The SDK README documents the field's values, `None` case, failure behavior, and run-level scope.

## Consequences

Callers can branch on `completed`, `max-tokens`, `error`, and future reason kinds without parsing the event list. The field may describe steering, injected context, or queued work that joined the interval, so it must not be presented as the initiating prompt's causal outcome. The in-repo TypeScript SDK exposes the finish-reason observation only through its typed events; its callers can read it directly from `SessionEvent[]`.
