---
description: "In-process spawn subagent backend for users and maintainers choosing, configuring, or debugging fresh-child delegation."
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-spawn-in-process

English | [中文](README.zh.md)

## Summary

`dsh-subagent-spawn-in-process` is an in-process subagent backend: it runs each delegated task in a fresh child agent that shares this process and its agent factory, LLM, and tool services. The child starts with an empty conversation, so a task prompt must stand alone; it inherits the parent's working directory, session lineage, provider, model, reasoning effort, and output-token limit unless `request.agentOptions` overrides them. A delegation tool or API call reaches it under the `spawn` provider name. Choose it for the cheapest delegation transport; choose the fork backend when the child must build on the parent's completed conversation turns.

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

Mount this backend in a composition that delegates work to fresh in-process children. The common path is explicit: load the subagent service and this backend, then point a delegation tool such as `dsh-tool-subagent` at the `spawn` provider.

### When to choose it

Choose the spawn backend when the child needs no parent conversation and running in this process is acceptable. Avoid it when the child must build on completed parent turns — the fork backend seeds that history — or when the child must run outside this process, which the out-of-process backends provide. Because the child inherits the parent's working directory and LLM selection by default, a self-contained prompt behaves exactly as written.

### Minimal configuration

Load the subagent service and this backend, then configure one delegation tool per target. This is the smallest composition that exposes a `subagent` tool backed by spawn:

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
```

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `spawn` | Provider name registered on `ctx.subagents` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-spawn-in-process) is the exhaustive source for every accepted field and its JSDoc.

### What a delegation does

One tool call starts one child and waits for its result: the child works in its own session and the parent receives only its final output, or an errored tool result when the run is cancelled, refused, truncated by its token limit, or rejected at startup. A rejected start leaves no published child; a completed run is disposed after its result is collected.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the backend is built and where the behavior in [Use this package](#use-this-package) comes from; the shared mechanics belong to the in-process driver.

### Design concept

One separation: this backend contributes only the provider registration and the decision to start fresh, while every run mechanic — depth checking, child creation, per-child customization, structured output, cancellation, result reading, and disposal — lives in `dsh-subagent-in-process-driver`. The agent factory's creation transaction owns the unpublished setup window and its rollback; after publication the caller owns the run.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Provider registration: `Config` schema, capability declaration, `start()` |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Run flow

A start request resolves through the subagent service, then the shared driver validates depth, mints a child session id, creates the child through the host agent factory with the caller's signal, applies persona, tool filter, and structured output inside the creation window, publishes the child, drives one task, reads the child's own final output, and disposes the handle quiescently.

### Ownership and scope

The child gets a fresh flat registration scope: parent tool restrictions and authority are never imported, and the filter the tool applies is composition, not a parent-derived grant. The backend advertises all five start-time capabilities, including `agentOptions`, because it controls the child's creation window and can enforce each one.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the shared subagent model to the sibling backends and exhaustive configuration.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — start requests, results, live runs, and the provider contract.
- [dsh-subagent-in-process-driver](../subagent-in-process-driver/README.md) — the shared run driver this backend calls.
- [dsh-subagent-fork-in-process](../subagent-fork-in-process/README.md) — the sibling backend that seeds completed parent turns.
- [dsh-tool-subagent](../tool-subagent/README.md) — the model-facing delegation tool that reaches this provider.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-spawn-in-process) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Child-agent request

#### What the model sees

The fresh child receives the task content verbatim as its only user message in a new empty conversation, with the parent provider, model, reasoning effort, output-token limit, and working directory by default. A configured persona shadows global prompt text in the child's scope; a tool filter removes named global tools from its schemas, executable lookup, and PTC mode SDK bindings while leaving independently registered guidance. No parent conversation message is included; the filter is composition, not an inherited authority grant.

#### Token effect

The child pays for a new independent context and history, and no parent-history token is duplicated. A persona changes the child's repeated prompt cost; a tool filter changes its schema or generated SDK cost.

#### KV Cache effect

The child's request cache is independent of the parent's. Child history grows append-only, while persona, tool-filter, generated-SDK, provider, or model changes establish a different child prefix.

### Parent tool result, indirectly

#### What the model sees

Through `dsh-tool-subagent`, the parent receives only the child's final output or an errored result for a non-completed stop reason; intermediate child work never reaches it.

#### Token effect

Parent input grows by one data-dependent result, retained until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the backend is the wrong choice; they are current package constraints.

- **Fresh means no parent transcript** — the child inherits cwd, lineage, provider, model, reasoning effort, output-token limit, and explicitly configured persona or tool restrictions, but none of the parent's conversation; use the fork backend when completed-turn context is required.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
