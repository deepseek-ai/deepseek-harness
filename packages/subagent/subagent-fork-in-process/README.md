---
description: "In-process fork subagent backend for users and maintainers choosing, configuring, or debugging children seeded with the parent's completed turns."
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-fork-in-process

English | [中文](README.zh.md)

## Summary

`dsh-subagent-fork-in-process` is an in-process subagent backend that seeds each child with the parent's completed conversation turns: the child sees every finished turn and none of the in-flight one, so follow-up work builds on the conversation without duplicating it. A delegation tool reaches it under the `fork` provider name, and its behavior matches the spawn backend except for the session seed. Choose it when a subtask continues this conversation; choose spawn when the child must stand alone. The seed is a one-time snapshot taken at fork time: later parent turns never reach the child.

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

Mount this backend when delegated work must build on the parent's conversation. The common path mirrors spawn: load the subagent service and this backend, then point a delegation tool such as `dsh-tool-subagent` at the `fork` provider.

### When to choose it

Choose fork when the child needs the conversation's completed turns — a follow-up analysis, a review, a continuation. Choose spawn when the child should start clean, or an out-of-process backend when the child must not share this process. The seed carries conversation history only: the child still gets a fresh tool scope and none of the parent's authority.

### Seed boundary

The seed ends at the parent's last completed turn. A parent's current tool-calling turn is still open when a subagent starts, so that in-flight turn is never included; before the first completed turn the seed is empty and the child behaves like a fresh spawn.

### Minimal configuration

Load the subagent service and this backend, then configure a delegation tool. This composition exposes a `subagent` tool backed by fork:

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-fork-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: fork
```

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `fork` | Provider name registered on `ctx.subagents` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-fork-in-process) is the exhaustive source for every accepted field and its JSDoc.

### What a fork delegation does

One tool call creates a background child and returns its session id immediately. The child works in its own session; the parent receives its final answer in a completion notice. The child can also send messages through `send_message`. A rejected start leaves no published child. Programmatic callers such as workflows can await the activation result directly.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the backend and where the behavior in [Use this package](#use-this-package) comes from.

### Design concept

This backend supplies the balanced completed-turn prefix of the parent log as the child session seed. The subagent service records the inherited range so results contain only the child’s own output.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Provider registration: prefix computation, `Config` schema, capability declaration |

### Run flow

`prepareContinuable()` captures the parent’s completed-turn prefix once at creation. `startActivation()` creates the child with that seed, and the subagent service applies persona, tool filtering, and structured output for this activation. The provider advertises the same agent options, output, depth, filter, and persona capabilities as spawn.

### Lifecycle binding

The delegation tool creates a background activation and returns a stable child session id. Parent and child share the same messaging tool definitions and ordering; the parent id and return guidance follow inherited history in the initial task. Workflows await results with caller delivery and send no completion notice to the parent.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the shared subagent model to the sibling backends and the design evidence for preserving the inherited request prefix.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — start requests, results, provider contract, and in-process depth and seed.
- [dsh-subagent-spawn-in-process](../subagent-spawn-in-process/README.md) — the fresh-child sibling backend.
- [dsh-tool-subagent](../tool-subagent/README.md) — the model-facing delegation tool that reaches this provider.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-fork-in-process) — every accepted config field and its source declaration.
- [Forked children preserve the parent request prefix](../../../.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.md) — why continuable fork preserves the inherited request prefix.

-----

<a id="model-experience"></a>
## Model Experience

### Child-agent history and envelope

#### What the model sees

The child receives the parent's balanced completed-turn prefix, then the new task content verbatim. A configured persona shadows prompt text in the child's fresh scope; a tool restriction filters its global wire schemas, executable lookup, and PTC mode SDK bindings but not standalone guidance. The parent's tool view and authority are not inherited; an optional structured-output request adds a child-only contract; the parent's current in-flight turn is excluded.

#### Token effect

Forking duplicates retained completed history into the child's request, which then accumulates its own tokens independently. A persona changes repeated prompt cost; filtering changes schema or generated SDK cost; a first-turn fork has no inherited history.

#### KV Cache effect

The child may reuse the inherited byte-identical prefix under the same provider and model. Persona, tool-filter, generated-SDK, or route changes may invalidate reuse before inherited history; later child history is append-only. Continuable messaging adds no child-only system-prompt section or tool schema; the parent id and return guidance follow inherited history in the initial user task ([cache-preserving fork Agent Note](../../../.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.md)).

### Parent tool result, indirectly

#### What the model sees

Through `dsh-tool-subagent`, the parent first receives the child session id, then a completion notice with its final answer. Child-authored messages arrive through `send_message`; the inherited prefix and internal work remain in the child session.

#### Token effect

Parent input grows by one data-dependent final result retained until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the backend is the wrong choice; they are current package constraints.

- **The seed is a one-time snapshot** — the child sees the parent's completed turns as of the fork and nothing the parent logs afterwards; there is no live context sharing.
- **Prefix reuse depends on matching request inputs** — parent and child messaging definitions match byte for byte; explicit persona, tool filtering, generated-SDK, or route changes can still break equality. Rationale: the [cache-preserving fork Agent Note](../../../.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.md).
- **Shipped fork tools do not expose child LLM route selection** — they inherit the parent's provider and model so the copied history remains eligible for KV Cache reuse. Route selection stays disabled until a change can preserve reuse or expose a bounded recomputation cost.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
