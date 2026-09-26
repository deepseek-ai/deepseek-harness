# Agent Note: Workflow runs gain `run_in_background` over the job registry

Status: implemented

Update: with the [jobs seam consolidation](../architecture/2026-09-03-jobs-seam-consolidation.md) the run registers a `JobSpec` (no `record` flag), narrates through `JobHandle.append` and `updateProgress`, and returns its rendered value as `JobOutcome.result`, which the model's first read after settlement carries once.

English | [中文](2026-09-01-workflow-run-in-background.zh.md)

## Problem

A `workflow` call blocked the parent turn until the whole script settled: a long orchestration (an audit fanning out over hundreds of files) held the model hostage for its entire wall-clock, with no way to keep working, no live progress for a human, and cancellation as the only exit. Every other long-running execution surface — bash, pwsh, one-shot subagents — already had a `run_in_background` route into `ctx.jobs`. The [record merge](../architecture/2026-09-01-jobs-absorb-activity-record.md) also removed the foreground workflow's activity mirror on the explicit promise that live workflow narration would return as a background record job.

## Decision

The `workflow` tool gains `run_in_background: true` (exposed and accepted while the `enableRunInBackground` config holds, default on): the call registers the run as an owned `kind: 'workflow'` job with an observation record and returns `{ kind: 'background', jobId, runId }` immediately.

- **The run belongs to the job, not the tool step.** The engine run starts inside the job starter with no `exec.signal`; `job_kill`, the job list's stop control, and owner teardown are the cancellation paths, each forwarding its reason into `run.cancel`. A synchronous engine rejection (meta/parse failure) propagates out of the starter, so nothing registers and the model sees the ordinary correctable error.
- **Settlement is the job's settlement.** `done` chains from `run.result`: dispose (a disposal failure warns and never rejects into the registry), stop the mirrors, then map the stop reason — `completed` carries the same rendered return value as the foreground path in `JobOutcome.output` (so the completion notice and `job_output` deliver it), `cancelled` settles `killed` and leaves the detail to the registry's kill-reason merge (the forwarded cancel reason is the same string), `error` settles `failed` with the script's failure message.
- **The record mirror replaces the deleted activity mirror.** `src/record.ts` subscribes `workflow/phase`, `workflow/log`, and member lifecycle events once per plugin and routes them into tracked runs' `JobHandle` faces as the same text lines the activity mirror wrote, on the `log` channel so the model's `job_output` never renders them; `updateProgress` tracks the current phase. There is no contained-error wrapper: `append`/`updateProgress` are non-throwing surfaces (post-settlement appends drop inside the registry), and a straggling event finds no tracked run.
- **The output schema becomes a `kind`-discriminated union** (`background` | `foreground`), matching bash's shape; the foreground envelope gains `kind: 'foreground'` for symmetry. The durable run-start/member/run-end session recording keeps its `exec.parent === undefined` gate on both paths, with the background run-end written from the job's `done` chain.
- **`workflow` joins `JobKindMap`** by declaration merging from the tool package, like `pwsh` and `pty`.

## Alternatives considered

- **A start/poll API on the tool itself** (a `workflow_status` companion): duplicates `job_output`/`job_kill` for one producer and leaves the run outside owner teardown and the session-header list; the job registry already is the start/poll surface.
- **Streaming intermediate values to the model** (partial results through `readOutput`): a workflow's value is the script's single return; per-agent intermediates are script-internal (`log()` narrates them for humans through the record). A consuming model cursor would invite polling loops against an inherently final-value producer.
- **Bridging `exec.signal` into the background run:** the returning tool step's abort (turn cancellation) would kill work the model just intentionally detached; bash's background route set the precedent that only the registry cancels.

## Consequences

The model can fire long orchestrations and keep working; humans watch phases, logs, and member lifecycles stream in the session-header job list and can stop the run there. A background run's value arrives only at settlement (`job_output` before that returns status alone). The snapshot tree pins the schema, prompt, and PTC stub changes; a recorded-session scenario replaying a full background run is deferred and tracked in the package README's limitations.
