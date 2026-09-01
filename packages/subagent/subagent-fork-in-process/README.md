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

One tool call starts one child seeded with the completed turns and waits for its result: the child sees the conversation up to the parent's last completed turn, works in its own session, and the parent receives only its final output — or an errored tool result for cancellation, refusal, token-limit truncation, or startup rejection. The seed is captured once at start; later parent turns never reach the child.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the backend and where the behavior in [Use this package](#use-this-package) comes from.

### Design concept

One difference from spawn, expressed as data: the backend computes the balanced completed-turn prefix of the parent's log and hands it to the shared in-process driver as the child's session seed. Because live sequence numbers equal array indexes, the prefix stays a valid seed beginning at sequence zero, and the driver records its length so the result reader never mistakes a seeded parent message for child output.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Provider registration: prefix computation, `Config` schema, capability declaration |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Run flow

On `start`, the prefix is sliced from the parent's event log up to and including the last `turn/end`; the shared driver then creates the child with that seed, applies the same persona, tool-filter, and structured-output setup, drives one task, reads the child's own final output, and disposes quiescently. The provider advertises `agentOptions` plus the same output, depth, filter, and persona capabilities as spawn. `prepareContinuable` captures the prefix once, at creation, because it becomes part of the child's own durable transcript.

### Lifecycle binding

The base bundle and ACP/headless examples bind this provider to `backgroundMode: one-shot`, while the CLI presets select `continuable`. Both preserve the inherited request prefix: parent and child receive the same messaging tool definition and ordering, and the continuable child's parent id and return guidance live in its initial user task after inherited history ([cache-preserving fork Agent Note](../../../.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.md)).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the shared subagent model to the sibling backends and the design evidence for the one-shot binding.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — start requests, results, provider contract, and in-process depth and seed.
- [dsh-subagent-in-process-driver](../subagent-in-process-driver/README.md) — the shared run driver this backend calls.
- [dsh-subagent-spawn-in-process](../subagent-spawn-in-process/README.md) — the fresh-child sibling backend.
- [dsh-tool-subagent](../tool-subagent/README.md) — the model-facing delegation tool that reaches this provider.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-fork-in-process) — every accepted config field and its source declaration.
- [Fork children stay one-shot](../../../.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.md) — why shipped compositions bind fork to one-shot.

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

The parent receives only the child's own final output through `dsh-tool-subagent`, not the inherited prefix or intermediate work.

#### Token effect

Parent input grows by one data-dependent final result retained until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the backend is the wrong choice; they are current package constraints.

- **The seed is a one-time snapshot** — the child sees the parent's completed turns as of the fork and nothing the parent logs afterwards; there is no live context sharing.
- **Fork lifecycle policy differs by composition** — the base bundle and ACP/headless examples use one-shot fork, while the CLI presets use continuable fork. Both keep the inherited prefix eligible for reuse because parent and child messaging definitions match byte for byte; explicit persona, tool filtering, generated-SDK, or route changes can still break equality. Rationale: the [cache-preserving fork Agent Note](../../../.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.md).
- **Shipped fork tools do not expose child LLM route selection** — they inherit the parent's provider and model so the copied history remains eligible for KV Cache reuse. Route selection stays disabled until a change can preserve reuse or expose a bounded recomputation cost; the [model-selected route Agent Note](../../../.agents/notes/implemented/feature/2026-08-18-model-selected-subagent-routes.md) owns that restriction.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
