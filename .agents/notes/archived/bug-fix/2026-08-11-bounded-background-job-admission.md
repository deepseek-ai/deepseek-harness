# Agent Note: Bounded background job admission

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-11-bounded-background-job-admission.zh.md)

## Problem

A model can start background Bash, PowerShell, PTY operations, and one-shot subagents in separate tool calls and later turns. The agent loop's `maxParallelToolCalls` limits only calls still executing inside one step; each background producer returns a job id immediately, so repeated starts can grow live processes or child work without bound.

The process-local job registry already owns the exact job owner and the authoritative lifecycle state, but it retained terminal history beside live records and had no admission policy. Releasing capacity when cancellation was requested would also be incorrect: a `stopping` producer may still own its process, PTY, or child until `JobHooks.done` settles.

## Decision

`LocalJobRegistry` owns a `maxConcurrentJobsPerOwner` configuration field. It accepts positive safe integers, defaults to `10`, and is available through the provider's Cordis schema and the ACP app configuration. Profile compositions configure the provider row directly; the process-local provider owns the value's meaning.

The [generic job runtime decision](../architecture/2026-06-20-generic-long-running-tool-runtime.md) owns the shared Task lifecycle and control API; this note owns the process-local admission policy.

`start()` performs admission after the existing task-controller, task-field, and live-owner checks and before `JobStart.run()`. It derives the active count from the registry's current records instead of storing another counter:

| Record | Occupies capacity | Release fact |
|---|---:|---|
| `running` | yes | producer `done` settles |
| `stopping` | yes | producer `done` settles |
| `completed`, `killed`, or `failed` | no | already terminal |

Owned tasks are bucketed by exact `Agent` object identity, matching owner cleanup. Replacement agents that reuse a session id receive an independent bucket. Jobs without an owner share one service-level bucket, so omitting ownership is not an unlimited bypass.

When the bucket is full, `start()` throws before producer execution and task-id allocation. The diagnostic includes the current limit and tells the model to use `job_kill`, wait until the task finishes stopping, and retry. Rejection creates no execution resource, queue entry, reservation, or public job record; a later successful start receives the next ordinary per-kind id.

Owner and service disposal keep their existing order: request cancellation, retain `stopping` occupancy while producers release resources, await settlement, then remove records. The admission policy therefore follows the same lifecycle fact used by reads, notices, and cleanup rather than treating a cancellation request as resource release.

Continuable background subagents remain outside this budget. They own durable child sessions and live Activations rather than Task records, so limiting them requires a separate result and lifecycle contract. This decision also adds no Task snapshot, session-log, wire, persistence, process-wide CPU or memory budget, queue, priority, preemption, or automatic oldest-task termination.

## Verification

The task-provider suite covers the default and explicit limits, producer-before rejection, unchanged id counters, `stopping` occupancy, every terminal release state, exact-owner isolation, same-session replacement objects, the shared unowned bucket, invalid configuration, owner cleanup, and service teardown. Spine and ACP composition tests pin typed forwarding. A keyless ACP replay boots the real Loader composition with a limit of one, starts one real background Bash process, observes the second start's actionable error, stops the first task by its returned id, and verifies that the rejected producer's marker file was never created.

## Alternatives considered

**Rely on `maxParallelToolCalls`.** Rejected because a background tool call releases its step slot as soon as it returns a job id; the setting cannot bound work that remains live across later steps and turns.

**Release capacity when `job_kill` succeeds.** Rejected because successful cancellation only changes the task to `stopping`. The producer may still hold the resource until `done` settles, so admitting a replacement immediately would exceed the configured live-resource bound.

**Use one global process bucket.** Rejected because one busy agent would deny unrelated sessions, while unowned host work still needs an explicit bounded bucket. Exact owner identity already defines the cleanup lifecycle and supplies the correct partition.

**Queue, preempt, or terminate the oldest task.** Rejected because each policy adds ordering, ownership, and cancellation behavior beyond the requested fail-closed limit. An explicit rejection lets the model decide which work is no longer needed through the existing `job_kill` control.

**Maintain a mutable active-count map.** Rejected because the registry already holds the authoritative records and statuses. A second count would require rollback and settlement synchronization while providing no user result that a direct derivation lacks.

## Consequences

One exact owner cannot keep creating Task-backed live resources indefinitely, and unrelated owners retain independent allowances. A slow stop keeps a bucket full until `done` settles, which is deliberate: the configured number bounds work that may still own resources, not cancellation requests. A producer whose `cancel` returns but whose `done` never settles holds one slot for the rest of the service lifetime and can stall teardown because the registry cannot safely infer resource release.

Admission scans the process-local registry on each start. The cost grows with retained Task history, accepted in exchange for one state authority and a default limit small enough to bound the common live set. Terminal history remains available to existing reads and listings without consuming capacity.
