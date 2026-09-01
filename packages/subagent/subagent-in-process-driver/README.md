---
description: "Shared in-process subagent run driver for maintainers and backend authors understanding or extending the spawn and fork run lifecycle."
kind: "package-library"
---

# @deepseek-ai/dsh-subagent-in-process-driver

English | [中文](README.zh.md)

## Summary

`dsh-subagent-in-process-driver` is the shared run driver behind the two in-process subagent backends: it creates one child agent through the host's agent factory, applies per-child customization, drives one task to completion, and returns the child's own final output with a single quiescent disposal path. Spawn calls it with no session seed; fork calls it with the parent's completed-turn prefix. It is a library, not a standalone feature: provider backends call `startInProcessRun`, and nothing in a composition configures it. Read this page to understand the run lifecycle both in-process backends share.

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

You reach this package through a provider backend, not a composition: `dsh-subagent-spawn-in-process` and `dsh-subagent-fork-in-process` each call `startInProcessRun(request, options)` and own everything around it. This page documents the lifecycle both share so you can read one backend's behavior and reason about the other.

### What one run provides

One call starts and drives one one-shot child. Fulfillment means the child is already published in `ctx.agents` and the caller owns the returned run; a rejected start has already quiesced the unpublished creation, so no half-created child survives. The run exposes the child's id and live agent, a `result` promise, and a `dispose()` that stops the loop, removes the agent and session, and unwinds scoped registrations.

### The one input

`InProcessRunOptions` is `{ seed?: SessionEvent[] }` — a fork seed of balanced parent events. Spawn omits it; fork supplies the completed-turn prefix and records its length so the result reader never mistakes seeded parent messages for child output.

### What the child gets

The child receives the parent's working-directory/session lineage and inherits the parent provider, model, reasoning effort, and output-token cap unless `request.agentOptions` overrides them. It gets a fresh flat registration scope: parent tool restrictions and authority are not imported. A run carries the parent's explicit sandbox override and `'never'` approval pin into the child and appends a per-run descriptor inside the child's initial turn.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the driver's lifecycle contract and the structured-output runtime; the observable behavior is covered in [Use this package](#use-this-package).

### Start contract

The driver follows this sequence:

1. Validate the parent depth and optional absolute `maxDepth`, then derive child depth as parent depth plus one and persist it in the child session header.
2. Create the child through the host agent factory with the caller's required signal threaded into the creation transaction.
3. During that transaction's unpublished setup window, install the requested persona, tool restriction, and structured-output runtime.
4. Publish the child, retain the returned handle, and drive one task.
5. Read the child's own output — its last non-empty assistant message, or its accumulated assistant text when none exists — and the final durable turn reason from the complete owned run, excluding any fork seed.

### Cancellation and ownership

The required request signal covers both startup and the live run. Before publication, the creation transaction observes it, rolls back, and rejects; the driver re-checks once after publication to close the handoff race, then installs a minimal live-run listener. After fulfillment the caller owns the run: provider unload does not revoke it, and `dispose()` removes the abort listener, records cancellation, and delegates to the handle's memoized quiescence transaction, which stops the loop, removes the agent and session, and unwinds scoped registrations. Cancellation owns every non-completed in-flight outcome and reports `aborted`; an already-completed turn remains completed.

### Structured output

`attachStructuredRuntime(childCtx, schema)` installs the whole contract in the child's scope: a `structured_output` tool validates and stages the model's value against the requested schema; a trailing first-party order-9900 system-prompt section tells the child the tool call is the terminal answer; a `tools/result` observer commits a staged value only after the authoritative final tool result succeeds, including the enclosing `run_code` result for PTC mode sub-dispatch; and a monotonic tool guard blocks later calls after capture. A clean turn that never commits the required value reports `error`; the driver does not re-prompt. All registrations ride the child fiber and disappear with it.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Run driver: creation, one-turn drive, result reading, disposal |
| [`src/structured.ts`](src/structured.ts) | Structured-output runtime: capture tool, prompt section, guard, commit |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the shared subagent model to the backends built on this driver and the delegation-policy decision.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — start requests, results, provider contract, and in-process depth and seed.
- [dsh-subagent-spawn-in-process](../subagent-spawn-in-process/README.md) — the fresh-child backend built on this driver.
- [dsh-subagent-fork-in-process](../subagent-fork-in-process/README.md) — the seeded-child backend built on this driver.
- [Delegation-policy decision](../../../.agents/notes/implemented/feature/2026-07-25-subagent-policy-inheritance.md) — how parent sandbox and approval policy reach the child.

-----

<a id="model-experience"></a>
## Model Experience

### Child-agent request

#### What the model sees

The shared driver sends the task verbatim as the child's user message and, when requested, shadows the persona and restricts global tool schemas, lookup, execution, and PTC mode SDK bindings in the unpublished child's fresh scope; parent restrictions are not inherited, and standalone tool-guidance sections remain. Spawn supplies no history; fork supplies its balanced seed.

#### Token effect

Child input is isolated from the parent and grows through the child's own steps. A persona changes repeated prompt text; filtering changes schema or generated SDK cost but not independently registered guidance.

#### KV Cache effect

Independent of the parent request cache. The child's later history is append-only, while persona, tool-filter, generated-SDK, provider, or model changes establish a different child prefix.

### Structured-output system prompt, schema, and results

#### What the model sees

A structured run adds the structured-output instruction below. It also adds a child-scoped `structured_output` definition with the requested schema and the exact description `Report your final structured result. Call this exactly once, when your answer is complete; the arguments must match this tool's parameter schema exactly.` This runtime-only definition is outside the generated shipped [tool package map](../../../docs/tool-catalog.md#tool-package-map). Its canonical acknowledgement is `{ recorded: true }`, rendered as `Structured output recorded.`; a later call becomes ``Error: structured output already recorded: the run is complete, so `<tool>` is not executed``.

##### Structured-output instruction

```markdown
When you have your final answer, you MUST report it by calling the `structured_output` tool with arguments matching its parameter schema exactly. Do not finish with a plain text answer: only the tool call counts as your result.
```

#### Token effect

Fixed instruction and capability tokens are paid only by that child. Result text enters the child history, while the captured value alone becomes the parent result.

#### KV Cache effect

Prefix-stable inside the child while the structured-output instruction and schema are unchanged. Changing the schema or capability may invalidate the child's cache from that early segment; results append in child and parent histories.

### Parent start error, indirectly

#### What the model sees

Through `dsh-tool-subagent`, invalid depth state becomes exactly `Error: agent subagentDepth must be a non-negative safe integer`, `Error: subagent child depth exceeds the safe-integer range`, or `Error: subagent depth <attempted> exceeds maxDepth <max>`. A pre-publication cancellation passes its abort reason through the registry's `Error: <message>` wrapper.

#### Token effect

Zero tokens on a successful start; only the failed parent tool call retains this text.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Parent result, indirectly

#### What the model sees

The driver extracts only the child's own last assistant output or captured structured value; seeded parent messages and intermediate child work do not become the result.

#### Token effect

The parent receives one data-dependent result through the consumer; all other child tokens stay in the child session.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what an in-process one-shot run cannot do; they are current package constraints.

- **Runs expose no `sendMessage`/`resume`** — the optional runtime capabilities are absent on in-process one-shot runs.
- **Structured capture accepts the `defineTool` schema subset only** — unsupported JSON Schema constructs fail before the child is created; a provider needing a broader schema vocabulary requires a different runtime.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
