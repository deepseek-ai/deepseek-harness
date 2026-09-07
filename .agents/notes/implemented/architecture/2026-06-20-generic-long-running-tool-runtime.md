# Agent Note: The background job runtime (`ctx.jobs`) and generic task control tools

Status: implemented

English | [中文](2026-06-20-generic-long-running-tool-runtime.zh.md)

## Problem

Background bash originally combined two responsibilities: the bash executor ran processes and also managed job ids, ownership, incremental reads, cancellation, completion listeners, and model-facing control tools. Adding background subagents required the same lifecycle and interaction contract. Implementing that contract independently for every long-running capability would duplicate isolation, cleanup, notification, and prompt behavior while teaching the model a different collect-and-stop protocol for each producer.

The job registry, control tools, and completion notices form one harness capability. Bash and subagents should supply execution-specific hooks without owning generic task behavior.

## Decision

The `jobs/` package group owns background-job semantics:

- `@deepseek-ai/dsh-jobs` registers running work as `ctx.jobs` and owns job ids, authorization, snapshots, reads, cancellation, waiting, completion listeners, and cleanup.
- `@deepseek-ai/dsh-tool-jobs` exposes `job_output`, `job_list`, and `job_kill`, injects completion notices, and supplies the background-job system-prompt guidance.

Long-running tools are producers. `dsh-tool-bash` adapts a `ShellProcess` into incremental output and process cancellation; `dsh-tool-subagent` adapts a child run into final output and child disposal. The bash and subagent capability seams remain independent of sessions and the job registry.

`JobRegistry` is the Service Definition in `@deepseek-ai/dsh-jobs`; the process-local provider is `LocalJobRegistry` in `@deepseek-ai/dsh-jobs-local` (the [task-registry contract Agent Note](../../archived/architecture/2026-07-26-job-registry-seam.md) records that split).

## Runtime contract

The literal types live on the [tasks subsystem page](../../../../docs/subsystems/jobs.md). A producer calls `ctx.jobs.start()` with a kind, label, optional owning `Agent`, optional positive `outputLimitBytes`, and a `run()` function. The runtime completes all failable preflight work before calling `run()` and invokes it once. After `run()` returns hooks, registration commits without another failable step; a producer cannot start work that lacks a collectable job id.

The process-local provider also owns bounded admission, whose rationale is recorded in the [bounded background job admission decision](../../archived/bug-fix/2026-08-11-bounded-background-job-admission.md). Its positive-safe-integer `maxConcurrentJobsPerOwner` config defaults to `10`; `start()` derives each exact `Agent` object's active count from `running` and `stopping` records, while every unowned task shares one service bucket. Capacity rejection occurs before `run()` and id allocation, and producer `done` settlement is the only event that releases a stopping task's place. The provider does not queue, preempt, or retain a second mutable count.

`outputLimitBytes` is producer-owned presentation policy, not a registry buffer. The registry validates and projects it unchanged into `JobSnapshot`; generic control APIs apply the cap to complete model-facing output after adding their own status or notice metadata. Omitting it preserves the existing controller behavior, so the runtime does not impose a hidden default on unrelated producer families.

A model-facing producer exposes that committed id in its canonical success value, normally `{ kind: 'background', jobId }`; Native rendering may keep human-readable prose. A pre-aborted background call fails rather than returning a no-op because no task exists to satisfy the promised handle. Once registration publishes the id, cancellation belongs to the task's own controller and the job runtime: later cancellation of the producing tool call must not kill the published task. `job_kill`, owner disposal, and service teardown request cancellation; foreground execution remains coupled to the call's `exec.signal`.

The producer hooks define three responsibilities:

- `cancel(reason?)` synchronously requests termination, is idempotent, and must cause `done` to settle.
- `done` never rejects and settles only after the producer has released the task's resources.
- Optional `readOutput()` returns the next consuming output delta. Omitting it declares a final-output task whose terminal result comes from `JobOutcome.output`.

Statuses are `running`, `stopping`, `completed`, `killed`, and `failed`. Producer-specific information such as an exit code or stop reason belongs in `detail`; the registry does not interpret it. Task kinds form a merge-extensible string union, and job ids are branded and generated as `<kind>-N`, with a counter per kind.

The runtime attaches one continuation to `done`, records the first terminal outcome, resolves waiters, and invokes completion listeners with per-listener error containment. First-wins settlement matters during teardown: if `cancel` throws, the runtime force-fails the record and warns that work may be orphaned rather than waiting forever for a promise that may never settle. A later producer outcome cannot overwrite that diagnosis or notify twice. A `cancel` that returns without eventually settling `done` still blocks teardown because the runtime cannot distinguish it from a slow, valid stop.

Task registrations are not effects of the producer tool fiber. Reloading a tool or controller plugin therefore does not kill work owned by an agent and backend. The task service's own disposal cancels all live tasks and awaits contract-compliant producers.

## Authorization and owner lifecycle

Job ids are runtime-global and predictable, so every access is authorized by the registry. `get`, `read`, `wait`, and `kill` accept the calling `Agent`; `list` returns only tasks visible to that caller. An owned task is accessible only to the exact owning session. Unowned tasks are open to non-agent callers and die with the task service.

The snapshot stores the owner's branded `SessionId` for authorization, while lifecycle operations retain the exact live `Agent` instance. These identities serve different purposes: session equality grants access, but exact object identity selects cleanup and completion delivery. Reusing an agent or session id cannot redirect an old scope's cleanup or notices to a replacement.

The first task for an owner attaches one asynchronous effect to `owner.ctx`. Agent-scope disposal cancels that owner's live tasks, awaits their terminal records, and removes their snapshots. This effect survives producer reloads and joins the agent's existing quiescence boundary. The task service retains the effect disposer so service reload can detach callbacks from still-live agent scopes after global teardown.

For contract-compliant producers, `AgentHandle.dispose()` resolves only after owned background work has stopped. Work intended to outlive an agent must be started unowned; survival across runtime restarts requires a separate durable-job design.

## Service API

`JobRegistry` provides:

- `start(spec)` for preflighted, provider-admitted, atomic registration.
- `get(id, caller?)` and `list(caller?)` for non-consuming snapshots.
- `read(id, caller?)` for a consuming stream delta or an idempotent final result.
- `kill(id, caller?, reason?)` for cancellation.
- `wait(id, timeoutMs, caller?, signal?)` for bounded terminal waiting.
- `onJobDone(listener)` for effect-scoped observation with exact-owner delivery and listener containment.
- `attachController(name)` for the task-controller availability fence.

`wait` returns the terminal snapshot when the task settles or the live snapshot when its timeout expires. Aborting a wait cancels only that wait. If settlement has already assigned terminal delivery to the waiter, the terminal snapshot still wins. Waiters unregister synchronously on abort so a same-tick settlement cannot suppress a completion notice on behalf of a reader that receives nothing.

A producer loaded without any controller would let callers start work they cannot collect or stop. `dsh-tool-jobs` therefore calls `attachController()` for its lifetime, and `start()` fails before producer execution when no controller is attached. This check occurs at start rather than plugin load because sibling plugins may activate concurrently. Custom non-model controllers can attach themselves without teaching the registry tool names.

## Model-facing control API

`dsh-tool-jobs` registers three kind-independent tools with generic UI cards:

- `job_output(job_id, wait?, timeout_ms?)` reads output and always appends `[status: ...]`. Stream tasks return only output since the previous read; final-output tasks return their result after settlement. Reads are non-blocking unless `wait: true`, whose timeout is defaulted and capped by plugin config. A wait timeout reports the still-running status and does not stop the task.
- `job_list()` returns caller-visible tasks as `<id> [<kind>] <status> — <label>`, or `(no background jobs)`.
- `job_kill(job_id, reason?)` requests cancellation immediately. The optional logged reason is forwarded to the producer. Terminal tasks report their existing status; a throwing producer cancel fails the call and leaves the task running.

Stream reads share one task-scoped consuming cursor because the owning model is the intended reader. A UI or multiple independent readers need a separate non-consuming observation API; sharing this cursor would let readers consume one another's output.

The system prompt tells the model to retain job ids, continue independent work instead of busy-polling or duplicating a running task, collect relevant tasks before its final answer, and kill work that no longer matters. Completion delivers a logged message to the exact owner's session. A busy owner is injected; an idle owner is woken, under the bounded policy the [idle-owner wake decision](../feature/2026-08-11-background-job-completion-wakes-an-idle-owner.md) owns.

The runtime marks a terminal task `reported` when a read or wait delivers it, when a live waiter has claimed delivery at settlement, or when the model explicitly kills it. Reported tasks do not inject redundant completion notices. Listener failures are logged independently, do not stop later listeners, and are not awaited by waiters or teardown. When a snapshot carries `outputLimitBytes`, `dsh-tool-jobs` preserves UTF-8 boundaries and reuses an existing producer truncation marker rather than duplicating it. Reads reserve status suffixes and retain the output tail; completion notices reserve the stable `background job <id>` prefix and `job_output` instruction before truncating variable kind, label, status, detail, or the truncation marker itself, so the minimum PTY cap still identifies the task to collect. The job controller resolves the caller-visible producer cap in a prepended pre-execute listener before policy can deny or short-circuit dispatch, then applies it through the task definitions' last-mile `finalizeContent` callback so normalized tool errors, outer pipeline failures, and single-text policy results cannot escape the bound; deliberately structured multi-block policy results retain policy ownership of their shape and size.

## Producer opt-in

Each producer owns whether its schema exposes `run_in_background` through defaulted config. `dsh-tool-bash`, `dsh-tool-terminal`, and each `dsh-tool-subagent` instance use `enableRunInBackground`, defaulting to true. A disabled instance omits the parameter and also rejects a forced background argument at execution because the generic argument validator permits undeclared keys. Schema omission advertises the capability; the execution check enforces it.

`ctx.jobs` does not rewrite producer schemas. A bundle forwards configuration only for producers it owns. If a background call reaches `start()` without an attached controller, the runtime fence fails before execution.

## Producer integrations

The bash seam exposes `resolve`, `run`, and `start`. `start(spec)` returns a `ShellProcess` with incremental reads, cancellation, exit facts, and a non-rejecting quiescence promise. The local executor retains live handles only so its own disposal can kill and join processes. Foreground callers continue to use `resolve` and `run` directly.

For background bash, `dsh-tool-bash` registers the calling agent as owner. Its hooks map `kill()` to cancellation, `done` to a completed or killed `JobOutcome`, and `readOutput()` to the process's bounded incremental output plus spill and sandbox notices. Generic task tools own ids, status lines, listing, waiting, and completion notices.

For background subagents, `dsh-tool-subagent` creates a task-owned `AbortController` and begins provider startup inside the task starter. Cancellation aborts the same signal before or after provider publication. `done` awaits both the child result and child disposal, maps completed output to a final result, maps abort to `killed`, and maps other stop reasons or infrastructure failures to `failed`. Intermediate child history remains in the child session and is not exposed through `readOutput()`.

## Alternatives considered

### Per-capability control tools

Separate bash and subagent output/stop tools duplicate ids, isolation, cleanup, notification, and guidance while increasing the model's schema and protocol burden. One runtime keeps execution-specific behavior in producers without cloning the task lifecycle.

### An immediate abstract task-runtime backend

The current `JobStart.run()` contract passes in-process callbacks and exact `Agent` objects. A durable backend changes identity, restart, ownership, and observation semantics, so at introduction time the registry stayed one concrete service rather than freezing the wrong boundary. The [task-registry contract Agent Note](../../archived/architecture/2026-07-26-job-registry-seam.md) later separated the contract from the process-local implementation without changing these in-process semantics.

### Consumer-owned authorization or cleanup events

Consumer-owned checks invite inconsistent or missing isolation on each new controller. A broadcast cleanup event makes every listener filter every agent and provides no registration disposer. Central authorization plus one owner-scoped effect gives every consumer the same fence and an awaited, removable lifecycle hook.

### Blocking output or a separate wait tool

Blocking by default would serialize the parent while background work runs. Waiting without reading would add another model call and schema without returning useful information. `job_output(wait: true)` makes blocking explicit and combines it with result delivery.

The wait uses the shared deadline primitives but not the generic tool-timeout policy. A wait timeout is a successful observation that returns `[status: running]`; the generic policy would replace it with a timeout error. No tool-call timeout controls task lifetime after a job id has been returned.

### Runtime-owned output sinks

A push sink would centralize buffering, but bash already owns bounded buffers, truncation, and spill files behind its executor seam. Pulling formatted deltas preserves that ownership. A durable backend that owns storage may justify revisiting the producer interface.

### Random ids, promotion, or lifecycle session events

Authorization, not unguessability, is the access boundary, and ids do not derive filesystem paths; sequential branded ids keep transcripts readable. Foreground-to-background promotion requires a user interaction contract the SDK does not prescribe. Starts, reads, and notices are already logged as tool and context events, so dedicated task session events would duplicate model-visible facts.

## Testing

Unit coverage pins preflight atomicity, per-kind ids, per-exact-owner and unowned-bucket admission, `stopping` occupancy, terminal release, output-limit validation and projection, complete UTF-8 result bounds, stream and final reads, wait timeout and abort races, cancellation, first-wins settlement, listener containment, notice suppression, owner isolation, stale owner instances, owner cleanup, service teardown, and the no-controller fence. Producer tests cover bash process mapping, subagent startup cancellation, terminal mapping, and disposal. Snapshot coverage pins the control-tool schemas, prompt guidance, and an assembled ACP path where the configured limit rejects a second real background Bash task with a `job_kill` recovery action.

## Consequences

Bash commands and subagents share one id vocabulary, listing, notice format, prompt habit, and set of control tools. New long-running producers implement execution hooks instead of another registry and tool family. The [tool cookbook](../../../../docs/cookbook/adding-a-tool.md) points producers to this contract.

One exact owner cannot grow process-local Task-backed work without bound, and another owner does not consume its allowance. A cancellation request keeps capacity occupied until the producer actually releases its resource, so replacing slow-stopping work cannot exceed the configured live-resource budget.

Owned background bash now stops with its agent instead of surviving it. Background processes have no executor timeout; callers must kill irrelevant work or rely on owner/service disposal. Stream reads support one consuming reader, and a producer that returns from `cancel` without settling `done` can still stall teardown. Durable jobs, independent observation cursors, and foreground promotion remain separate designs.
