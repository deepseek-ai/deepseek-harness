---
description: "The agent-plane presentation selector for users and maintainers choosing, configuring, or debugging which form of its tools an agent preset's models see."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-tool-presentation

English | [中文](README.zh.md)

> **Deprecated:** For new configurations, mount `@deepseek-ai/dsh-tool-executor-native` or `@deepseek-ai/dsh-tool-executor-ptc` directly. Existing configurations remain supported. To migrate, replace this selector row with the corresponding executor row and remove `config.mode`; do not load both in the same scope.

## Summary

Existing [agent presets](../../preset/agent-preset-registry/README.md) can keep using `dsh-agent-tool-presentation` to select whether models see every native tool schema or only `run_code` with a generated SDK. Each preset can choose independently, so native and PTC agents can share one process without sharing tool catalogs. Selecting `ptc` requires a compatible PTC runtime. The `mode` field is required when this package is present, while omitting the package keeps the deployment default.

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

Add this row to an agent preset to fix how every agent joined to that preset sees its tools. `native` presents each visible tool schema as a function definition; `ptc` presents only the `run_code` transport plus a generated SDK and the rule that only `run_code` may be called directly. Agents that declare nothing inherit the nearest executor mounted in their composition.

### Add the row to a preset

```yaml
- name: '@deepseek-ai/dsh-agent-tool-presentation'
  config:
    mode: ptc
```

| Field | Default | Meaning |
|---|---|---|
| `mode` | required | `native` — every schema; `ptc` — `run_code` plus generated SDK |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-agent-tool-presentation) is the exhaustive source for every accepted field. `mode` is required rather than defaulted because a preset without this row inherits the deployment default.

### What PTC mode requires

Selecting `ptc` needs a composed PTC runtime (`ctx.ptcRuntime`) whose language has a registered SDK renderer — the TypeScript runtime ships via [`dsh-ptc-runtime-node`](../../ptc-runtime/ptc-runtime-node/README.md), and both the TypeScript and Python SDK renderers are built into `dsh-tool-executor-ptc`. Before the runtime first becomes available, this compatibility selector leaves the inherited executor active. Mount `dsh-tool-executor-ptc` directly when preset activation must reject a missing runtime.

### One presentation per agent

One agent declares one presentation. A second declaration in the same composition is refused rather than merged: two answers to "which form does the model see" is a contradiction, not an override.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the package realizes the behavior above; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The tool registry cannot move into a preset: its consumers are all host-plane — the agent loop resolves its executor, the API proxy reads its presenters, and every tool plugin registers into it — and a service only moves down when all of its consumers move with it. What a preset can own is the presentation of that registry. `ctx.tools.setExecutor()` declares an executor for the mounting scope, which is the preset's standing mount, so the declaration covers every agent joined to that preset and a PTC mode preset runs beside native ones in one process. One row per composition, not one per session.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `mode` config, `apply` wiring `ctx.tools.setExecutor` for the mounting scope |

### Behavior notes

The selected child plugin registers its executor when its required services are available. After registration, unloading the child or its runtime makes the selected executor unavailable until a replacement registers; calls do not fall back to an inherited executor.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The package-level contract is enough for most consumers; read these when you need the surrounding domain.

- [tools package](../tools/README.md) — the scoped registry and executor API.
- [agent-presets package](../../preset/agent-preset-registry/README.md) — how presets compose agents and their standing mounts.
- [Node ptc-runtime package](../../ptc-runtime/ptc-runtime-node/README.md) — the TypeScript runtime a PTC mode needs.
- [historical PTC mode executor-collapse note](../../../.agents/notes/archived/bug-fix/2026-08-07-ptc-executor-collapse.md) — why the announced and callable surfaces stay the same.
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

- **The runtime stays host-plane** — a preset can select PTC mode but cannot supply the TypeScript runtime it needs; PTC selection remains pending until the deployment supplies a runtime.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
