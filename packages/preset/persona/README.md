---
description: "The composable persona row presets mount to give one agent its own system-prompt persona, for users and maintainers configuring or debugging it."
kind: "package-reference"
---

# @deepseek-ai/dsh-persona

English | [中文](README.zh.md)

## Summary

`dsh-persona` supplies a persona prefix and suffix through ordinary system sections. Mount it in a preset to customize that preset’s sessions, or globally to override deployment defaults. It can also make the prefix the complete system prompt, suppressing every other section, and turn off optional runtime context for its scope.

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

Mount this row inside a preset composition to give that preset’s sessions their own persona. A global mount applies to every scope that does not override it. The `system-prompt` row supplies deployment defaults beneath these registrations.

### Configuration

```yaml
- name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a terse systems engineer who answers in short commands.
```

| Field | Default | Meaning |
|---|---|---|
| `prefix` | required | Persona prose rendered as the `deployment:persona-prefix` section |
| `suffix` | `''` | Template for `deployment:persona-suffix`; omitted or empty text clears the suffix for this scope |
| `complete` | `false` | Use only the rendered prefix as the system prompt; ignore the suffix |
| `includeRuntimeContext` | `true` | Include optional runtime context for this agent scope; false suppresses optional contributions without disabling their owning services; required contributions remain |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-persona) is the exhaustive source for every accepted field and its JSDoc.

### Persona behavior

The persona `prefix` and `suffix` are templates: complete `{{…}}` groups resolve strictly against registered prompt variables when the prompt renders. Empty templates clear the corresponding persona text. Omitted `suffix` defaults to empty; it does not inherit the global suffix. With `complete: true`, assembly still resolves contexts, tools, variables, and cooperative listeners, but the prompt registry restores this exact prefix as the sole section; no identity, suffix, tool guidance, or listener can append prompt text. With `includeRuntimeContext: false`, optional context providers are not evaluated for this scope, and assembly-listener contributions are discarded unless registered as required. Required providers remain active at assembly and request admission.

### When to use it

Use this row when a composition must change an agent’s identity as well as its tools. Preset and agent scopes override enclosing persona sections; within the same scope, the latest live registration wins. Unloading the row restores the next live definition for each section.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### How the row registers

The row calls `ctx.systemPrompt.section()` separately for `deployment:persona-prefix` and `deployment:persona-suffix`, using their registered order slots. The prefix carries `complete`; the suffix defaults to empty. Cordis owns both registrations, and disposal reveals earlier definitions through the ordinary section-resolution path. `includeRuntimeContext: false` calls `ctx.systemPrompt.suppressRuntimeContext()`.

### How overrides compose

Prefix and suffix are independent section names. This row registers both, so an omitted suffix clears inherited suffix text. A plugin that registers only the prefix leaves the suffix inherited. Removing one registration does not retire its logical source while another visible registration remains.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, persona section registrations, runtime-context suppression |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the preset composition to the prompt registry this row feeds.

- [agent-presets package](../agent-preset-registry/README.md) — the preset composition this row mounts into.
- [System prompt subsystem](../../../docs/subsystems/system-prompt.md) — sections, assembly, and the persona values this row configures.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-persona) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### The persona section

#### What the model sees

The `deployment:persona-prefix` section at order `0` carries this row’s `prefix`; `deployment:persona-suffix` at order `10200` carries its `suffix`, after first-party guidance. Both replace their deployment defaults and resolve prompt variables. Complete mode selects only the rendered prefix for admission; changing into or out of it appends a notice superseding earlier instructions. Earlier system messages retain their positions until compaction. Runtime context remains enabled by default. With `includeRuntimeContext: false`, required context such as the current working directory and subagent identity remains; optional context is omitted.

#### Token effect

Persona text contributes tokens to every request in its scope. Initial complete mode excludes other system sections; a later transition adds its notice and selected text while earlier messages retain their token cost until compaction. Empty initial text contributes nothing. Required runtime context still contributes tokens when optional context is disabled.

#### KV Cache effect

Unchanged rendered persona values add no messages. Changes append updated instructions and a notice while retaining earlier messages. Provider serialization determines whether that retained prefix is reusable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the row is a poor fit. They are current package constraints, not a task backlog.

- **No per-provider runtime-context filter** — `includeRuntimeContext: false` suppresses all optional contributions for the scope; it cannot suppress required contributions.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
