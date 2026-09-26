---
description: "The background-job registry contract for users and maintainers composing, implementing, or debugging background work: ids, ownership, lifecycle, the output ring, and the event stream."
kind: "package-reference"
---

# @deepseek-ai/dsh-jobs

English | [中文](README.zh.md)

## Summary

`dsh-jobs` lets tools keep long-running work active while an agent continues. Each job receives a stable `<kind>-N` id, and its owning agent can read output, wait with a timeout, or request cancellation. Ownership is scoped to the agent session, so other agents cannot inspect or stop the job; completion arrives as an in-session notice without polling. Users can watch retained live output without consuming what the agent can read. Background jobs can start only when the deployment supplies job execution.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use this package when you are composing a background-job capability or writing a producer that registers long work. The package itself defines the contract; a composition gets the feature by loading an implementation such as `dsh-jobs-local` and, for the model side, `dsh-tool-jobs`.

### What a background job gives you

A producer registers work with a kind and a one-line label; the registry returns a `<kind>-N` id such as `bash-1`. Anyone who owns the job can read output, list jobs, wait up to a timeout for settlement, and request cancellation — each call returns a fresh projection of the job's status, from `running` and `stopping` to the terminal `completed`, `killed`, or `failed`. When a job settles, the registry's event stream announces it and `dsh-tool-jobs` turns the settlement into an in-session notice, so no polling is needed. A producer may attach an optional byte cap so each complete model-facing read or notice stays bounded.

A producer streams output by naming pull sources on its spec — non-consuming offset readers the registry pumps at its own cadence — or by pushing chunks through the `JobHandle` its starter receives; both land in the job's bounded ring, where `stdout` and `stderr` chunks reach the model and `log` chunks reach observers only. Observers read retained chunks at absolute byte offsets and are signaled on advancement; the settlement that ends the job also ends the stream, and `updateProgress` publishes a live progress line into every projection until then. Observation is invisible to the model: `readAt` consumes nothing and never touches notice state.

### The ownership boundary

A job belongs to the agent session that started it: another agent cannot read or stop it. Ids such as `bash-1` are predictable, so this fence is authorization, not secrecy. A job started without an owner is open to any caller and lasts until the service is disposed.

### Starting background work needs a controller

A producer can start work only while a controller that serves the owner is attached — loading `dsh-tool-jobs` attaches one. An agent whose composition loads no controller cannot start background work; `start()` fails with a message that names the missing controller rather than starting work the agent could never collect or stop.

### Smallest working composition

```yaml
- name: '@deepseek-ai/dsh-jobs-local'
- name: '@deepseek-ai/dsh-tool-jobs'
```

Loading these two plugins on a harness base that already provides the agent, tools, and system-prompt services gives the full feature: `dsh-jobs-local` provides the in-process background-job registry, and `dsh-tool-jobs` provides the `job_output`, `job_list`, and `job_kill` tools plus completion-notice delivery.

### What can go wrong

Any preflight rejection leaves no job id or registered work. Jobs managed by the shipped in-process registry die with the harness process; durable execution across restarts needs a different backend implementing this contract.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the contract and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Contract and implementation are separate packages.** `JobRegistry` is an abstract Cordis service; loading the class directly throws, so a misconfigured composition fails at load instead of registering an empty `ctx.jobs`.
- **One registry per process, owner-relative answers.** One instance serves every composition in the process, so registrations and deliveries are relative to the registering scope: a controller or listener registered from an unscoped context serves every owner; one registered under an agent composition's scope serves exactly the agents composed under it.
- **Access is fenced by the owner's session id.** Ids are predictable, so authorization — not secrecy — is the boundary.
- **Settlement is first-wins, and its event follows every released waiter.** One terminal record, released waiters, then one round of contained event delivery; the `settled` event reports whether it released a live `wait` (`awaited`), so `dsh-tool-jobs` never announces a completion a waiting caller already collected, whichever plugin was waiting.
- **Registrations outlive producer and controller fibers.** Owner and service disposal cancel live work and await compliant producers; a throwing teardown cancel force-fails only the record.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the abstract `JobRegistry` service and its contract |
| [`src/types.ts`](src/types.ts) | Shared vocabulary: `JobSpec`, `JobHandle`, `JobHooks`, `JobOutcome`, `JobEvent`, and the read results |
| [`src/view.ts`](src/view.ts) | Client-safe leaf: `JobView`, `JobChunk`, `JobStatus`, and the merge-extensible `JobKindMap` |
| [`src/brand.ts`](src/brand.ts) | `JobId` branded identifier, importable without the agent dependency |
| [`src/archive-admission.ts`](src/archive-admission.ts) | The `job` family of the Workspace registry's archive admission, installed by the seam's constructor for every implementation |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: checks the announced event protocol per job (registered first, one settlement, removal last) and each announced projection against the registry's own read |

### Service operations

Each read or control operation accepts an optional caller `SessionId`; omitting it permits only unowned jobs: `list` and `get` return fresh projections, `read` advances the model's cursor and hands out the producer's result once after settlement, `readAt` reads retained chunks at an absolute offset without consuming anything, `kill` invokes producer cancellation before changing status and records the reason for the terminal `detail`, `wait` blocks up to a timeout, `remove` drops a settled record a caller collected through its own wait and never handed out, and `start()` preflights access, validation, and admission before invoking the producer's `run()` once while refusing any owner no attached controller serves; `events.subscribe` delivers registration, progress, stopping, settlement, removal, and output commits at owner, scope, or process granularity.

Every implementation also answers the Workspace registry's archive admission ([seam](../../workspace/workspace/README.md)), installed by the seam's constructor through the abstract `list` and `kill` alone: `workspace/session-activity` reports the running or stopping jobs the asked Session owns as the `job` family, one item per job with its label; `workspace/session-stop` kills each of them with the reason `session archived`, one at a time, so a producer that throws on cancel is logged while the Session's other jobs still stop. Unowned jobs belong to nobody and are never reported or killed for a Session.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the job types to the shipped implementation, the model-facing controls, and the design records.

- [Background task runtime subsystem](../../../docs/subsystems/jobs.md) — the job types, projection fields, and `ctx.jobs` Cordis surface.
- [jobs group map](../README.md) — the sibling group page and its package table.
- [Process-local registry](../jobs-local/README.md) — the shipped implementation that runs jobs in this process.
- [Model-facing job controls](../tool-jobs/README.md) — the `job_output`, `job_list`, and `job_kill` tools and completion notices.
- [Generic long-running tool runtime Agent Note](../../../.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.md) — the design behind the background-job runtime.
- [job-registry seam Agent Note](../../../.agents/notes/archived/architecture/2026-07-26-job-registry-seam.md) — the owner-fenced registry contract and its rationale.
- [Jobs seam consolidation Agent Note](../../../.agents/notes/implemented/architecture/2026-09-03-jobs-seam-consolidation.md) — one output ring, one projection, one event stream.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through producer and controller plugins, which own all model rendering over the job registry.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the contract is a poor fit. They are current package constraints, not a task backlog.

- **The contract is in-process** — `JobSpec.run()` passes callbacks and the registry resolves the live `Agent` behind the owner session; a durable or cross-process backend must reshape identity, restart, ownership, and observation semantics before it can implement this seam.
- **The model's cursor is the only consuming read** — independent observers use the non-consuming `readAt` and never move it.
- **A settled record stays listed until it is removed** — by its owner's disposal, service disposal, or an explicit `remove` from the caller that collected it; the registry keeps no retention count of settled jobs.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
