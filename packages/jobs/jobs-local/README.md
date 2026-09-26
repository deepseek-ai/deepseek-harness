---
description: "The process-local background-job registry for users and maintainers composing, sizing, or debugging in-process jobs: per-owner admission, lifecycle, and teardown."
kind: "package-reference"
---

# @deepseek-ai/dsh-jobs-local

English | [中文](README.zh.md)

## Summary

`dsh-jobs-local` runs background jobs inside the harness process while the agent continues. The owning agent can read, wait on, list, and cancel its jobs; mounting `dsh-tool-jobs` also delivers completion notices in-session. Configurable concurrency and output-retention limits bound resource use. Producers can supply output for periodic reading or append it directly; users can observe retained output without consuming the agent's unread output. Jobs end when their owner or the harness shuts down.

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

Load this plugin when a composition needs in-process background jobs: long-running tools register their work, and the owning agent reads, waits on, lists, and cancels it without blocking its own turn. It implements the [`dsh-jobs`](../jobs/README.md) contract; the model-facing `job_output`, `job_list`, and `job_kill` tools come from [`dsh-tool-jobs`](../tool-jobs/README.md).

### When to choose it

Choose it when jobs should live in the harness process and die with it. Avoid it when work must survive a restart or span processes: records are in-memory, so a durable or cross-process backend must implement the same contract differently.

### Minimal configuration

Loading the plugin registers `ctx.jobs`; every field is optional.

```yaml
- name: '@deepseek-ai/dsh-jobs-local'
```

| Field | Default | Meaning |
|---|---|---|
| `maxConcurrentJobsPerOwner` | `10` | Maximum `running` plus `stopping` jobs per exact owner, or in the shared unowned bucket |
| `retainBytes` | `262144` | Live ring retention per job, in UTF-8 bytes |
| `settledRetainBytes` | `16384` | Ring retention kept after a job settles, in UTF-8 bytes; bytes the model has not read stay until its first terminal read |
| `pumpPollMs` | `150` | Poll interval for a job's pull sources, in milliseconds |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-jobs-local) is the exhaustive source for the accepted fields.

### What each owner gets

The limit counts the exact owner's `running` and `stopping` records; all unowned jobs share one separate service-level bucket. Terminal history does not occupy capacity, and only a producer's `done` settlement releases a stopping job's place. At capacity, `start()` fails before the producer runs, with an error that names the limit and tells the agent to kill an unneeded job, wait for it to finish, and retry — the registry neither queues nor preempts.

### Lifecycle

Jobs belong to their owner and backend, not to the producer tool, so producer or controller reloads do not stop them. When an agent that owns jobs is disposed, its jobs are cancelled, their producers awaited, and their snapshots removed; service disposal does the same for every remaining job. A cancellation that throws during teardown force-fails the record and warns that the work may be orphaned, so teardown never deadlocks.

### What can go wrong

Starting work fails without a controller that serves the owner — loading `dsh-tool-jobs` attaches one, and `start()` otherwise refuses with a message naming it. A producer cancel that returns without settling `done` stays indistinguishable from a slow stop and can stall teardown while holding one capacity slot. Every record disappears when the harness process exits.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the registry and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **In-memory records, fresh projections.** `LocalJobRegistry` keeps one `TrackedJob` per job — lifecycle state, the output ring, and the model cursor — and projects a new read-only view or chunk copy per call; callers never receive live state.
- **Retention is bounded per ring.** Appends past the live cap drop the oldest retained chunks (a single oversized chunk keeps its UTF-8-safe tail); a reader below the retained window gets a lossy read, never an error. Settlement trims to the settled cap but never below the bytes the model cursor has not consumed, so a job that finishes before its first `job_output` hands over everything the live cap retained; that terminal read then trims to the settled cap.
- **Owner-relative layers, one process-wide registry.** Controllers and `{ owners: 'scope' }` subscriptions are filed into the scope that registered them (`ScopedLayers`), and reads union the global layer with the owner's scope chain — so one preset's job controls never hold `start()` open for an agent whose own composition loads none, and a scoped settlement reaches only the listeners its owner's composition registered.
- **Preflight before start.** `start()` checks controller service, spec validity, live ownership, and capacity before invoking the producer, so a rejection leaves no job id or execution resource; registration commits without a later failable step.
- **First-wins settlement, event last.** The earliest terminal outcome records once, waits for the pump's final drain, trims the ring, releases waiters, and then delivers one `settled` event with per-listener containment, followed by the ring's final `output` signal.
- **Teardown never deadlocks.** A throwing cancel force-fails the record and reports a possible orphan instead of stalling disposal.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, `LocalJobRegistry`, admission, lifecycle, teardown |
| [`src/events.ts`](src/events.ts) | Scope-layered event routing: `{ owner }`, `{ owners: 'all' }`, and `{ owners: 'scope' }` subscriptions |
| [`src/ring.ts`](src/ring.ts) | The bounded per-job output ring: append, retention trim, offset reads |
| [`src/pump.ts`](src/pump.ts) | The registry-owned pull pump: one timer per job, final drain before settlement |
| — | No runtime invariant companion is published; `@deepseek-ai/dsh-jobs/invariant` owns the event-protocol and event-versus-read checks. This provider's admission decision uses private configuration and must fail before a backend starter runs; `LocalJobRegistry.start()` enforces it synchronously for current producers. Repeating an aggregate after publication would expose private configuration solely to this companion and would not verify the fail-closed pre-start guarantee. |

### Scope layers

`attachController` and `{ owners: 'scope' }` subscriptions register into the calling context's scope layer; `{ owner }` and `{ owners: 'all' }` subscriptions are unscoped. The controller question (`servesOwner`) and scoped delivery walk the same chain: global layer first, then each scoped layer along the owner's chain. Registrations are anonymous tokens so duplicate labels stay independently disposable.

### Admission and settlement

`activeJobCount` counts authoritative records per exact owner or in the shared unowned bucket. `settle` records the terminal outcome once (merging a recorded kill reason into a `killed` detail), clears the progress line, trims the ring to the settled cap (keeping every byte the model cursor has not consumed), resolves every waiter, then emits `settled` with its cause and the ring's final `output` signal. The cause is `kill` after `JobRegistry.kill`, `teardown` after an owner or service cancel, and `producer` otherwise; `dsh-tool-jobs` uses it to skip notices nobody can read.

### Teardown

Owner disposal (`disposeOwned`) cancels the owner's jobs, awaits their settlement, removes their records, and announces each removal — the one visible-set change no per-job record carries. Service disposal (`disposeAll`) cancels all live jobs, awaits settlement, removes every record (announcing each removal, so a subscriber mounted outside the service drops its rows), then detaches the cross-fiber owner-cleanup effects.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the registry contract to the model-facing controls and the design records.

- [Background task runtime subsystem](../../../docs/subsystems/jobs.md) — the job types, projection fields, and `ctx.jobs` Cordis surface.
- [jobs group map](../README.md) — the sibling group page and its package table.
- [Registry contract](../jobs/README.md) — the abstract `ctx.jobs` service this package implements.
- [Model-facing job controls](../tool-jobs/README.md) — the `job_output`, `job_list`, and `job_kill` tools and completion notices.
- [Generic long-running tool runtime Agent Note](../../../.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.md) — the design behind the background-job runtime.
- [job-registry seam Agent Note](../../../.agents/notes/archived/architecture/2026-07-26-job-registry-seam.md) — the owner-fenced registry contract and its rationale.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through producer plugins and `dsh-tool-jobs`, to which the registry backend delegates all model rendering.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the registry is a poor fit. They are current package constraints, not a task backlog.

- **Jobs are process-local** — records die with the harness process; durable or cross-restart execution needs a separate backend implementing the seam.
- **A silently ineffective cancel can stall teardown and hold capacity** — if `cancel` returns without settling `done`, the registry cannot distinguish it from a slow stop; the job keeps one bucket slot for the rest of the service lifetime, and only an explicit throw can be force-failed safely.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
