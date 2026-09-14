---
description: "Run workflow orchestration through the shared sandboxed PTC Node process runtime, with workflow hooks, subagent routing and caller-owned cancellation."
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-ptc

English | [中文](README.zh.md)

## Summary

Run JavaScript workflows in fresh Node processes under the calling Session's file sandbox policy. Scripts keep the `agent()`, `parallel()`, `pipeline()`, `phase()` and `log()` hooks while subagents perform delegated work. The same execution provider serves PTC and workflows, including the opt-in Ralph loop. Runs have no overall elapsed deadline; cancellation stops the managed process and disposes child agents. The selected sandbox and subprocess providers determine enforcement and cleanup limits.

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

Mount this engine in a composition that provides subagents, sandbox policy and the [Node PTC runtime](../../ptc-runtime/ptc-runtime-node/README.md). It supplies workflow execution for `dsh-tool-workflow` and for `dsh-tool-ralph` when explicitly enabled. Ralph remains disabled in shipped defaults. The engine rejects non-TypeScript PTC providers when it loads. Python PTC compositions must disable the `workflow-ptc`, `tool-workflow` and any enabled `tool-ralph` rows.

### Minimal configuration

With those dependencies available, mount the engine and its model-facing consumer:

```yaml
- name: '@deepseek-ai/dsh-workflow-ptc'
- name: '@deepseek-ai/dsh-tool-workflow'
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | `spawn` | Host-side subagent provider used by `agent()` calls. |
| `maxConcurrentAgents` | `0` | Concurrent `agent()` ceiling; `0` resolves from available CPU parallelism. |
| `maxTotalAgents` | `1000` | Total `agent()` calls one run may start. |
| `maxItemsPerCall` | `4096` | Items accepted by one `parallel()` or `pipeline()` call. |
| `syncTimeoutMs` | `5000` | VM timeout for the script's initial synchronous slice, in milliseconds. |

An owning consumer may set `WorkflowStartRequest.subagentProvider` and lower `WorkflowStartRequest.maxTotalAgents` for one run. Script hooks cannot change either choice. Process heap, output, control and termination limits belong to the Node PTC provider; the engine adds no overall elapsed timer. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-workflow-ptc) defines accepted engine fields.

The Node PTC provider's `maxPendingCalls` also limits workflow concurrency: child startup, result waits and disposal use those slots. Progress batches use at most one additional slot. Leave headroom when setting `maxConcurrentAgents`.

### Results and failures

The script runs with top-level `await`; `meta` and `args` arrive as JSON data. Every `agent()` call uses the configured subagent provider and the run's fixed parent. The final lossless-JSON return value becomes the run result; an ordinary child failure resolves `agent()` to `null`.

Invalid metadata, an unparseable body, an unavailable provider route or a per-run cap above the ceiling is rejected before a run is published. During execution, hook misuse and tripped cooperative caps fail the workflow. Process failures, unavailable required confinement and PTC output or control limits also fail the run.

### File policy and cancellation

The engine resolves the calling Session's standing file policy and cwd for PTC execution. The VM retains the documented helper API, but it is not a security boundary: code that reaches Node remains subject to the selected OS file policy. The program-visible environment is empty. Network access is not restricted by the file policy.

The workflow requests `timeoutMs: null` from PTC. Its initial VM slice still has `syncTimeoutMs`, and a caller's abort signal still applies, including an enclosing tool deadline. Cancellation immediately aborts the PTC process and pending or active subagents. The caller must dispose every run and await child cleanup; there is no separate workflow cleanup timer.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The workflow engine owns orchestration; the PTC provider owns process launch, OS confinement, framed transport and managed process cleanup.

### Design concept

One self-contained guest program runs the existing VM and workflow helpers inside a PTC Node process. Host bindings connect that program to `ctx.subagents` and workflow observers. The engine captures the runtime and subagent services when a run starts, so an accepted run retains its dependencies through engine unload.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Engine configuration, request validation and run creation |
| [`src/host.ts`](src/host.ts) | PTC execution, child ownership, settlement and disposal |
| [`src/guest.ts`](src/guest.ts) | Guest adapter over PTC host bindings |
| [`src/guest-source.ts`](src/guest-source.ts) | Self-contained guest program source |
| [`src/runtime.ts`](src/runtime.ts) | VM evaluation, helper contracts and combinators |
| [`src/realm.ts`](src/realm.ts) | Lossless-JSON materialization across VM realms |
| [`src/meta.ts`](src/meta.ts) | Metadata validation and normalization |
| — | No runtime invariant companion is published; the workflow service owns event pairing and PTC owns managed-process observations. |

### Values and child ownership

The guest materializes outbound values as lossless JSON before PTC transport. Exotic prototypes, functions, symbols, cycles, sparse arrays, non-finite numbers and nested `undefined` are rejected. Child results cross back as JSON; same-process observer events retain their own cloning and callback-containment rules.

The host tracks pending provider starts separately from published children. A shared abort signal closes both paths; a child that becomes ready after cancellation is disposed. Each published child's disposal is shared by all cleanup paths. In-flight host bindings remain the workflow adapter's responsibility after PTC stops the program.

### Cancellation and outcomes

The first accepted terminal outcome owns the run result. Cancellation stops the process immediately rather than waiting for a guest acknowledgement. Process settlement and child cleanup remain separate obligations; public disposal waits for both. Existing workflow start/end pairing and child lifecycle projection remain intact.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Use these references for the shared execution guarantees and workflow contracts.

- [Workflow subsystem](../../../docs/subsystems/workflow.md) — request, result and event definitions.
- [Workflow service](../workflow/README.md) — caller-owned runs and cleanup.
- [Node PTC runtime](../../ptc-runtime/ptc-runtime-node/README.md) — file policy, process limits and deployment choices.
- [workflow tool](../tool-workflow/README.md) — model-facing scripted orchestration.
- [Ralph tool](../tool-ralph/README.md) — opt-in fixed fresh-agent iteration.
- [Workflow sandbox reuse](../../../.agents/notes/implemented/architecture/2026-09-13-workflow-ptc-sandbox-reuse.md) — execution ownership and tradeoffs.

-----

<a id="model-experience"></a>
## Model Experience

### Child-agent requests

#### What the model sees

Every script `agent()` call sends its prompt verbatim and optional model or structured-output schema to a subagent provider. Each child sees that provider's own context; phase and log narration stays on observer events.

#### Token effect

Each child consumes its own model context. Cooperative concurrency, total-agent and item caps limit ordinary script fan-out; child histories do not join the parent history directly.

#### KV Cache effect

Independent of the parent request cache and of sibling children. Each child can reuse only a byte-identical prefix under its own provider, model, prompt and schema.

### Parent tool result, indirectly

#### What the model sees

The tool consumer presents the final JSON value and child count, or a workflow failure. Intermediate child outputs remain available to the script. Script parsing, helper misuse, child infrastructure failures and PTC execution failures produce errors; ordinary child failure produces `null` for the script to handle.

#### Token effect

The engine adds no direct parent tokens. PTC bounds the outer program result, and the tool consumer owns its model-facing rendering and retention.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits qualify workflow execution and cleanup.

- **File confinement and cleanup inherit provider limits** — the Node PTC and subprocess providers define enforcement completeness and the managed process range.
- **Workflow caps are cooperative** — helper counters limit ordinary scripts; they are not host-enforced security quotas or descendant token budgets.
- **No overall elapsed deadline** — a run can remain active until it completes, fails or is cancelled. Caller deadlines still apply.
- **Child cleanup follows provider contracts** — the adapter awaits disposal and pending starts without a separate abandonment timer.
- **The VM is not a security boundary** — withheld globals guide script authors; OS policy governs code that reaches Node.
- **Cross-realm errors fail `instanceof Error` inside scripts** — branch on stable fields such as `name` and `code`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
