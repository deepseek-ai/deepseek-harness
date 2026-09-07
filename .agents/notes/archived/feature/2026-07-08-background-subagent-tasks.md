# Agent Note: Background subagent tasks

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-08-background-subagent-tasks.zh.md)

## Problem

The [subagent seam](2026-06-21-subagent-capability-seam.md) returns a `SubagentRun`, but the model-facing tool originally collected every run synchronously. Independent, slow delegations therefore held the parent call open or ran serially.

Subagents need the same start, collect, list, stop, ownership, notification, and cleanup behavior as other long-running tools without adopting process-stream semantics. The child session remains the detailed trace; the parent needs the final answer or safe failure detail plus job status. A background child also outlives its starting tool call, so its cancellation and owner-disposal contracts must be explicit.

## Decision

Each `dsh-tool-subagent` instance may expose `run_in_background`, controlled by `enableRunInBackground` and enabled by default. A disabled instance omits the parameter and rejects a forced background argument at execution. Provider selection remains deployment configuration, so one instance still registers one distinctly named tool for one provider.

Background subagents use the [generic background job runtime](../architecture/2026-06-20-generic-long-running-tool-runtime.md). Collection, listing, cancellation, completion notices, and prompt guidance come from `job_output`, `job_list`, and `job_kill`; there are no subagent-specific companion tools.

Foreground calls retain their synchronous contract: await provider startup and `run.result`, return final text only for `completed`, map other terminal reasons to an errored tool result with the optional safe diagnostic described by the [non-interactive permissions decision](2026-08-15-product-subagent-noninteractive-permissions.md), and always dispose the run before returning.

For a background call, the tool validates the parent and refuses an already-aborted execution signal before calling `ctx.jobs.start()`. The job runtime preflights the control API and owner cleanup before invoking the producer starter. That starter creates an independent `AbortController` and begins `ctx.subagents.start()`; after the id is returned, the tool-call signal no longer owns the child.

The task registration maps the subagent seam as follows:

- `kind` is `subagent`, `label` is the model-supplied description, and `owner` is the parent agent.
- `cancel(reason?)` aborts the task-owned controller. The same signal covers pending provider startup and the published run's remaining work.
- `done` awaits provider startup, the child result, and `run.dispose()`. Completed runs return final text, aborted runs become `killed`, and other stop reasons become `failed` with the Provider diagnostic when present. Startup, result, and disposal failures become failed outcomes rather than rejected task promises.
- `readOutput` is absent. While live, `job_output` returns status only; after settlement, it returns final output idempotently. Intermediate child activity remains in the child session.

## Lifecycle

A background subagent belongs to its parent agent and is not durable across owner closure. The job runtime attaches cleanup to the exact owner's scope. Agent disposal cancels the task and awaits startup rollback or child disposal before `AgentHandle.dispose()` resolves, preventing leaked child agents and sessions.

Completion notices target the exact owner captured at start. If owner teardown has already disposed the injection target, the notice is dropped; cleanup, not notification, is the lifecycle guarantee.

## Model guidance

The generic task prompt teaches the shared habit: retain ids, continue independent work instead of busy-polling, collect relevant tasks before answering, and kill irrelevant work. The subagent schema adds only that background mode returns a job id and that `job_output` collects the result. Authorization and owner cleanup enforce the runtime boundary independently of prompt compliance.

## Alternatives considered

### Subagent-specific wait, output, and stop tools

Capability-specific tools would duplicate the task protocol, teach another collect-and-stop habit, and complicate multiple provider instances. The generic runtime provides the required behavior without changing the tool's one-provider-per-instance shape.

### Survival after owner closure

Survival requires persistent task state, child-session recovery, a late-result delivery channel, and policy for abandoned owners. Owner-scoped cleanup gives process-local work a clear lifetime. Durable jobs require a separate design.

### No owner checks for isolated clients

Agents and logs may be session-scoped, but the job registry and predictable ids are runtime-global. The generic owner fence therefore applies to subagents like every other producer.

### Incremental child transcript output

Streaming child history into the parent would blur the log boundary and make provider behavior diverge. This tool exposes final output only; richer observation belongs to session or UI tooling.

## Testing

Unit coverage pins stop-reason mapping, dispose-before-report behavior, startup and result failures, pre-aborted refusal, detachment from the starting call's signal, cancellation before and after provider publication, collection through the real task tools, the no-controller preflight fence, missing-runtime failure, and per-instance schema gating. Snapshot coverage pins the model-facing schemas.

## Consequences

The parent can fan out slow delegations and collect them through the same task controls used by bash. Child work no longer occupies the starting tool call, but it can consume resources until collected, killed, or owner-disposed. Prompt guidance encourages collection; owner cleanup provides the hard lifetime boundary. Deployments that require synchronous delegation can disable background mode per tool instance.
