---
description: "The agent-plane presentation selector for users and maintainers choosing, configuring, or debugging which form of its tools an agent preset's models see."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-tool-presentation

English | [中文](README.zh.md)

## Summary

An [agent preset](../../preset/agent-presets/README.md) carries `dsh-agent-tool-presentation` to choose which form of its tools the model sees: `native` (every visible schema), `ptc` (only `run_code` plus a generated SDK), or `both`. The tool registry itself stays on the host plane — this row only declares the presentation for the mounting agent, so a PTC mode session runs beside native ones in one process, each seeing its own catalog. A PTC mode waits for a code runtime before mounting, so a preset selecting PTC mode against a deployment without one fails at mount instead of at the first prompt. The `mode` field is required: a preset without this row already gets the deployment default. Choose it when an agent preset needs to fix the tool form its agents' models see.

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

Add this row to an agent preset to fix how every agent joined to that preset sees its tools. `native` presents each visible tool schema as a function definition; `ptc` presents only the `run_code` transport plus a generated SDK and the rule that only `run_code` may be called directly; `both` presents both forms. Agents that declare nothing get the deployment-wide `mode` on the [`dsh-tools`](../tools/README.md) row.

### Add the row to a preset

```yaml
- name: '@deepseek-ai/dsh-agent-tool-presentation'
  config:
    mode: ptc
```

| Field | Default | Meaning |
|---|---|---|
| `mode` | required | `native` — every schema; `ptc` — `run_code` plus generated SDK; `both` — both forms |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-agent-tool-presentation) is the exhaustive source for every accepted field. `mode` is required rather than defaulted because a preset without this row inherits the deployment default.

### What PTC mode requires

Selecting `ptc` or `both` needs a composed code runtime (`ctx.codeRuntime`) whose language has a registered SDK renderer — the TypeScript runtime ships via [`dsh-code-runtime-worker-thread`](../../code-runtime/code-runtime-worker-thread/README.md), and both the TypeScript and Python SDK renderers are built into `dsh-tools`. A preset that selects a PTC mode against a deployment composing no such runtime refuses to mount, naming this row, so the failure lands where the operator can act instead of at the session's first request.

### One presentation per agent

One agent declares one presentation. A second declaration in the same composition is refused rather than merged: two answers to "which form does the model see" is a contradiction, not an override.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the package realizes the behavior above; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The tool registry cannot move into a preset: its consumers are all host-plane — the agent loop reads its scheduler, the API proxy reads its presenters, and every tool plugin registers into it — and a service only moves down when all of its consumers move with it. What a preset can own is the presentation of that registry. `ctx.tools.presentAs()` declares it for the mounting scope, which is the preset's standing mount, so the declaration covers every agent joined to that preset and a PTC mode preset runs beside native ones in one process. One row per composition, not one per session.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `mode` config, `apply` wiring `ctx.tools.presentAs` for the mounting scope |
| — | No runtime invariant companion is published; this package makes exactly one scoped call into `ctx.tools` and owns no event or snapshot of its own; the relation it establishes — which presentation one agent's assembly uses — is the tool registry's to hold, and `dsh-tools` observes it there. |

### Behavior notes

`native` applies immediately. A PTC mode instead waits for `ctx.codeRuntime`, a host-plane service: a preset selecting PTC mode against a deployment composing no runtime holds this row pending, and `dsh-agent-presets` refuses the mount naming this id. `presentAs` is itself the effect, so the declaration unwinds with this row without a second wrapper owning it.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The package-level contract is enough for most consumers; read these when you need the surrounding domain.

- [tools package](../tools/README.md) — the tool presentation modes and `presentAs` API.
- [agent-presets package](../../preset/agent-presets/README.md) — how presets compose agents and their standing mounts.
- [code-runtime worker-thread package](../../code-runtime/code-runtime-worker-thread/README.md) — the TypeScript runtime a PTC mode needs.
- [PTC mode executor-collapse note](../../../.agents/notes/implemented/bug-fix/2026-08-07-ptc-executor-collapse.md) — why the announced and callable surfaces stay the same.
- [Core group map](../README.md) — how the core packages compose.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the tool presentation it selects in `dsh-tools` — the row only chooses between the two projections `dsh-tools` owns and registers no prompt, schema, or result of its own.

#### KV Cache effect

No direct invalidation; the presentation is fixed when the agent is composed, so its request prefix is stable for the session's life.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this row needs special care. They are current package constraints, not a task backlog.

- **The runtime stays host-plane** — a preset can select PTC mode but cannot supply the TypeScript runtime it needs; a deployment that composes none can compose no ptc preset.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
