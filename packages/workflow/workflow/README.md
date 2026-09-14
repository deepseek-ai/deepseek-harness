---
description: "The workflow orchestration capability: run a model-written script that fans out subagents, for users and maintainers choosing or building on ctx.workflowEngine."
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow

English | [中文](README.zh.md)

## Summary

Run a plain-JavaScript orchestration script that fans work out to subagents and returns the script's final JSON value. Scripts can use `agent()`, `parallel()`, `pipeline()`, `phase()`, and `log()`; models normally access them through the `workflow` tool. Each run belongs to its caller, attributes every child to the invoking agent, resolves failures and cancellation without rejecting its result, and awaits script and child cleanup during disposal. The caller must supply an execution engine, allowing the isolation strategy to change without altering visible behavior.

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

Run a workflow when a task decomposes into many independent pieces that one script should coordinate — an audit across many files, a migration, multi-angle research — and the model explicitly asks for workflow-style orchestration. For one or two delegations, prefer a plain subagent call.

### The model-facing path

The model reaches the capability through the `workflow` tool from `dsh-tool-workflow`, which owns the call schema and result envelope; the engine supplies the execution underneath. A tool call submits `meta`, `script`, and optional `args` and returns `{ runId, agentsStarted, result }` when the run completes. The tool blocks the parent turn until the whole workflow settles, so the model sees one final outcome, never intermediate child messages.

### Running a workflow script

An orchestration script is a plain JavaScript body (not TypeScript) that runs with top-level `await` and ends with `return <json-value>`. The `meta` identity block and any `args` arrive as plain JSON data — never evaluated code. During execution the script calls the provided hooks: `agent(prompt, opts)` starts one subagent and resolves with its final text or, with a schema, a validated structured value; `parallel()` and `pipeline()` combine independent work; `phase()` and `log()` narrate progress for observers.

```text
// Script body — runs with top-level await, ends with a JSON return value:
const reviews = await parallel([
  () => agent('Review src/a.ts for correctness'),
  () => agent('Review src/b.ts for correctness'),
])
return { reviewed: reviews.length }
```

When the script settles, the run's result resolves with the returned value, the stop reason, and the number of children started. A script that returns nothing yields `null`.

### Programmatic runs

Plugin consumers can start a run directly: `ctx.workflowEngine.start({ script, meta, args?, parent, signal? })`. `parent` attributes every child to the invoking agent; `signal` cancels the run when aborted. `start()` validates the meta block and parses the script before a run exists, so a malformed request fails immediately with a violation list.

A returned run exposes `id`, `meta`, `result`, `cancel(reason?)`, and `dispose()`. The result never rejects: a script failure resolves with `stopReason: 'error'`, cancellation with `'cancelled'`. The caller owns the run — call `dispose()` on every path; it cancels remaining work and waits for script and child cleanup under the providers' lifecycle contracts.

### Failures and recovery

A script that does not parse, a malformed meta block, an unavailable provider route, or an unsupported per-run limit is rejected synchronously before a run exists; the `workflow` tool reports these as errors the model can correct from. During execution, hook misuse — bad arguments, unknown options, unsupported schemas, tripped caps — kills the script loudly rather than dissolving into a per-item `null`. An ordinary child failure is not an infrastructure error: `agent()` resolves `null` and the script decides how to handle it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the capability is split and where the contracts live; observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The package separates the script, run, result, and event contracts from execution: any engine can implement `ctx.workflowEngine` behind the same vocabulary, and one engine serves a context at a time — loading a second engine fails loudly, so swapping engines means changing which engine plugin the composition loads. The `workflow/*` events are observe-only: payloads carry run identity snapshots, never the live run, so listeners cannot acquire cancellation or disposal authority.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service definition, `workflow/*` event declarations, `WorkflowError` and its fatal flag |
| [`src/types.ts`](src/types.ts) | Browser-safe vocabulary: `WorkflowMeta`, `WorkflowResult`, run and agent event info |
| [`src/runtime-types.ts`](src/runtime-types.ts) | Host-only `WorkflowStartRequest` and `WorkflowRun` handles |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: event pairing and identity checks |

### Lifecycle and ownership

A run is holder-owned: engine-plugin unload prevents new starts but does not revoke accepted runs, and the caller must dispose every run it starts. `dispose()` cancels if needed and awaits script and child cleanup. The PTC engine aborts its managed process immediately; child disposal still follows each subagent provider's lifecycle contract.

`workflow/start` and `workflow/end` pair the run; `workflow/phase` and `workflow/log` carry script narration; `workflow/agent-start` and `workflow/agent-end` pair each child call by `seq`. Every listener is independently contained: a throwing listener is logged without starving peers or changing execution, and each receives its own payload clone.

### Failure discipline

`WorkflowError` carries a machine-routable code and a `fatal` flag; every code is fatal, and `parallel()` and `pipeline()` re-throw fatal errors instead of mapping the item to `null` — a typo'd option must kill the script loudly. Codes cover start failures, contract violations, exceeded caps, provider and result faults, unserializable values, and cancellation; the exact set and meanings live in [`src/index.ts`](src/index.ts).

The per-item `null` is reserved for child-run failures and ordinary in-stage script errors, so a child that resolves normally with a non-completed stop reason is not an infrastructure exception: `agent()` returns `null`, letting the script handle an ordinary child failure.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared workflow model to the current engine and the model-facing consumers.

- [Workflow subsystem](../../../docs/subsystems/workflow.md) — the full type vocabulary, start request, and event payloads.
- [Group map](../README.md) — the workflow capability family and its packages.
- [workflow tool](../tool-workflow/README.md) — the model-facing consumer that owns the call schema and result envelope.
- [PTC workflow engine](../workflow-ptc/README.md) — the current execution engine and its isolation boundary.
- [Dynamic workflows Agent Note](../../../.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.md) — the seam design and its decisions.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through its consumer `dsh-tool-workflow` and a workflow engine, which render the parent tool result and the child-agent requests.

#### KV Cache effect

No direct invalidation; the named consumer and engine own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the capability does not yet support. They are current constraints, not a task backlog.

- **Foreground collection only** — the caller owns one live run and awaits it; background start/poll, spill handles, and detached collection are deferred.
- **No journaling or resume** — scripts, child progress, and intermediate values are not checkpointed, so a process restart cannot continue a run.
- **No saved or nested workflows** — the capability starts caller-supplied scripts only, and a workflow script receives no `workflow()` hook for recursive orchestration.
- **No token-budget vocabulary** — engines cap concurrency, items, and children, but neither the request nor the result accounts for model tokens across children.
- **Runs are holder-owned, not service-tracked** — unloading the engine does not discover independent live handles; every consumer must dispose the run it started.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

Deferred directions: a background start/poll API with spill handles and detached collection; saved and nested workflows; and a token-budget vocabulary across children.

</details>
