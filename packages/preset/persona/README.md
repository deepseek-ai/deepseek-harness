---
description: "The composable persona row presets mount to give one agent its own system-prompt persona, for users and maintainers configuring or debugging it."
kind: "package-reference"
---

# @deepseek-ai/dsh-persona

English | [中文](README.zh.md)

## Summary

`dsh-persona` gives one agent its own persona: a preset mounts this composable row to register the `deployment:persona` system-prompt section, shadowing the deployment-wide persona for that session. It can also make that persona the session's complete system prompt, suppressing every other section, and can turn off dynamic runtime-context snapshots for the session. Mount it inside a preset composition — mounting it globally collides with the prompt registry's own persona registration and fails loud. Without this row, a preset could change an agent's tools but never its identity.

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

Mount this row inside a preset composition to give that preset's sessions their own persona. The row needs an agent scope: mounted outside one it collides with the prompt registry's own `deployment:persona` registration and fails loud — the deployment persona already has an owner, and the whole point of this row is to shadow it for one agent.

### Configuration

```yaml
- name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a terse systems engineer who answers in short commands.
```

| Field | Default | Meaning |
|---|---|---|
| `text` | required | Persona prose rendered as the `deployment:persona` section |
| `complete` | `false` | Restore this persona after assembly as the only system-prompt section |
| `includeRuntimeContext` | `true` | Include dynamic runtime-context snapshots for this agent scope; false suppresses every context contribution without disabling its owning services |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-persona) is the exhaustive source for every accepted field and its JSDoc.

### Persona behavior

The persona `text` is a template: complete `{{…}}` groups resolve strictly against registered prompt variables when the prompt renders, not when it assembles. Empty text still occupies the slot — it shadows the deployment persona away entirely, then disappears at render. With `complete: true`, assembly still resolves contexts, tools, variables, and cooperative listeners, but the prompt registry restores this exact persona as the sole section; no identity, tool guidance, or listener can append prompt text. With `includeRuntimeContext: false`, context providers are not evaluated for this scope and contexts added by assembly listeners are discarded.

### When to use it

Use this row when a preset must change an agent's identity and not only its tools. The deployment-wide persona itself is configured on the `dsh-system-prompt` row, not here; this row exists only to shadow or replace it for one agent.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### How the row registers

`apply` registers one prompt section through `ctx.systemPrompt.section({ name: PERSONA_SECTION, order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA'), text, complete? })` inside the mounting context's scope, so the section lands at order 0 — immediately after the harness identity opener — and only for agents joined to the preset. The shared section name makes a preset persona shadow the deployment's instead of landing beside it, while the service-owned order lookup keeps repository contributors on the central allocation. `includeRuntimeContext: false` calls `ctx.systemPrompt.suppressRuntimeContext()`.

### Why the row is scope-only

`dsh-system-prompt` owns the global persona as its own config and registers `deployment:persona` unconditionally, so a process has exactly one. This row collides with that registration outside an agent scope, by design: the row exists because a preset cannot mount the prompt registry itself.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, persona section registration, runtime-context suppression |
| — | No runtime invariant companion is published; this row owns no event stream or mutable runtime data — it registers one prompt section and the prompt registry owns identity, complete-prompt enforcement, shadowing, and disposal. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the preset composition to the prompt registry this row feeds.

- [agent-presets package](../agent-presets/README.md) — the preset composition this row mounts into.
- [System prompt subsystem](../../../docs/subsystems/system-prompt.md) — sections, assembly, and the persona slot this row shadows.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-persona) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### The persona section

#### What the model sees

The `deployment:persona` section at order 0, immediately after the harness identity opener, carrying exactly this row's configured `text` with prompt variables resolved. For an agent whose preset mounts this row, it replaces whatever persona the deployment configured. In complete mode, the model sees only this rendered section as its system prompt. Runtime context remains enabled by default; when disabled, a fresh agent receives no runtime-context snapshot from sandbox policy, approval policy, delegation, or another system-prompt context provider.

#### Token effect

Fixed for a given preset: the persona's own tokens on every request that agent makes, and none for any other agent. Empty text contributes nothing. Complete mode removes every other system-prompt token for that agent.

#### KV Cache effect

Prefix-stable for the life of an agent — the row mounts once, before the agent is published and therefore before its first request, and its text never changes while the agent runs. Two agents on different presets establish different prefixes from this section onward; neither can invalidate the other's reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the row is a poor fit. They are current package constraints, not a task backlog.

- **No global mount** — the prompt registry owns the unscoped persona slot, so this row is usable only from a scoped composition. A deployment-wide persona change belongs in the `system-prompt` row's own config.
- **Runtime-context suppression is all-or-nothing** — `includeRuntimeContext: false` turns off every context contribution for the scope, including sandbox policy, approval policy, and delegation; there is no per-provider filter.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
