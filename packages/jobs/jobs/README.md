---
description: "The background-job registry contract for users and maintainers composing, implementing, or debugging background work: ids, ownership, lifecycle, and completion listeners."
kind: "package-reference"
---

# @deepseek-ai/dsh-jobs

English | [中文](README.zh.md)

## Summary

`dsh-jobs` lets tools run long work as background jobs: the work gets a stable `<kind>-N` id, keeps running while the agent moves on, and the owning agent can read its output, wait for it with a timeout, or request cancellation at any time. Jobs belong to the agent session that started them, so one agent's work is never visible to another, and completion reaches the owner as an in-session notice rather than by polling. This package ships the contract only: the process-local registry lives in `dsh-jobs-local`, and the model-facing controls and completion notices live in `dsh-tool-jobs`. Load an implementation to get background jobs; without one, `ctx.jobs` does not exist and `start()` cannot run.

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

A producer registers work with a kind and a one-line label; the registry returns a `<kind>-N` id such as `bash-1`. Anyone who owns the job can read output, list jobs, wait up to a timeout for settlement, and request cancellation — each call returns a fresh snapshot of the job's status, from `running` and `stopping` to the terminal `completed`, `killed`, or `failed`. When a job settles, the owning agent is notified through the completion listener that `dsh-tool-jobs` turns into an in-session notice, so no polling is needed. A producer may attach an optional byte cap so each complete model-facing output read or completion notice stays bounded.

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
- **Settlement is first-wins, and completion is announced last.** One terminal record, released waiters, and one round of contained listener notification; completion is announced after the record is committed and every other observer has seen it, because a reporter may open a model turn synchronously.
- **Registrations outlive producer and controller fibers.** Owner and service disposal cancel live work and await compliant producers; a throwing teardown cancel force-fails only the record.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the abstract `JobRegistry` service and its contract |
| [`src/types.ts`](src/types.ts) | Shared vocabulary: `JobKindMap`, `JobStart`, `JobHooks`, `JobSnapshot`, listener types |
| [`src/brand.ts`](src/brand.ts) | `JobId` branded identifier, importable without the agent dependency |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: validates snapshot identity, status, timestamps, and owner fields |

### Service operations

Every operation is a thin projection over the registered jobs: `get` and `list` return non-consuming snapshots, `read` advances the single stream cursor, `kill` invokes producer cancellation before changing status, `wait` blocks up to a timeout, and `start()` preflights access, validation, and admission before invoking the producer's `run()` once while refusing any owner no attached controller serves; listeners observe terminal records and visible-set changes at owner granularity, and `attachController` scopes controller availability to its effect lifetime. Exact signatures and behavior live in the JSDoc on [`src/index.ts`](src/index.ts) and the generated [`ctx.jobs` cordis surface](../../../docs/subsystems/jobs.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the job types to the shipped implementation, the model-facing controls, and the design records.

- [Background task runtime subsystem](../../../docs/subsystems/jobs.md) — the job types, snapshot fields, and `ctx.jobs` cordis surface.
- [jobs group map](../README.md) — the sibling group page and its package table.
- [Process-local registry](../jobs-local/README.md) — the shipped implementation that runs jobs in this process.
- [Model-facing job controls](../tool-jobs/README.md) — the `job_output`, `job_list`, and `job_kill` tools and completion notices.
- [Generic long-running tool runtime Agent Note](../../../.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.md) — the design behind the background-job runtime.
- [job-registry seam Agent Note](../../../.agents/notes/archived/architecture/2026-07-26-job-registry-seam.md) — the owner-fenced registry contract and its rationale.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through producer and controller plugins, which own all model rendering over the job registry.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the contract is a poor fit. They are current package constraints, not a task backlog.

- **The contract is in-process** — `JobStart.run()` passes callbacks and exact `Agent` objects; a durable or cross-process backend must reshape identity, restart, ownership, and observation semantics before it can implement this seam.
- **Stream output has one consuming cursor** — independent observers need a cursor or snapshot API.
- **Foreground work cannot be promoted** — producers choose foreground or background before starting.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
