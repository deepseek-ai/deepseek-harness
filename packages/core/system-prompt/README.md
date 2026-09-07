---
description: "System-prompt assembly for users and maintainers adding prompt sections, variables, tool-schema sources, or configuring the model-facing prompt."
kind: "package-reference"
---

# @deepseek-ai/dsh-system-prompt

English | [中文](README.zh.md)

## Summary

`dsh-system-prompt` assembles the system prompt and tool schemas the model receives before each step. Plugins contribute ordered prompt sections, dynamic runtime context, tool-schema providers, and named variables; the loop calls `assemble()` once per step and renders the result into the complete model prompt. The package provides the fixed harness identity and the global deployment persona prefix and suffix, while an agent-scoped contribution shadows the global default for one agent. Config controls the harness identity opener, dynamic runtime context, the deployment persona prefix and suffix, and an explicit model-facing tool order. Choose it when you need to add a prompt section, a prompt variable, or a tool-schema source — it is the assembly point all model-facing prose flows through.

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

Mount `dsh-system-prompt` wherever agents run: it provides `ctx.systemPrompt`, the registry every prompt contribution lands in. Contributions are scoped — registering through `agent.ctx` affects that agent alone and shadows a same-named global.

<a id="configure-the-prompt"></a>
### Configure the prompt

The config owns the fixed opener, runtime context, deployment persona prefix and suffix, and tool order; everything else comes from registered contributions.

```yaml
- name: '@deepseek-ai/dsh-system-prompt'
  config:
    includeHarnessIdentity: true
    includeRuntimeContext: true
    personaPrefix: 'You are the deployment assistant.'
    toolOrder: ['<unlisted-tools>']
```

| Field | Default | Meaning |
|---|---|---|
| `includeHarnessIdentity` | `true` | Include the fixed `You are an AI agent powered by DeepSeek Harness.` first-party opener at order −1000. Set false only when a compatibility deployment owns the complete system prompt. |
| `includeRuntimeContext` | `true` | Include ordered dynamic runtime context in assembly |
| `personaPrefix` | `''` | Global persona prefix template at order `0`, before first-party guidance |
| `personaSuffix` | `''` | Global `deployment:persona-suffix` template at order `10200`, after first-party guidance |
| `toolOrder` | — | Explicit model-facing tool order with one `'<unlisted-tools>'` rest entry |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-system-prompt) is the exhaustive source for every accepted field. A `toolOrder` list without exactly one rest entry or with duplicates fails at load; a listed name with no registered tool rejects every `assemble()`.

### Contribute a prompt section

Sections carry static or context-resolved text with an `order`; they are concatenated in ascending order and equal orders use code-unit name order. Repository-owned contributors resolve centrally allocated positions through `ctx.systemPrompt.getSectionOrder(name)`; runtime-context contributors use `getContextOrder(name)`. External contributions may use any finite order. A `complete: true` section becomes the exact complete prompt after assembly; more than one effective complete section makes assembly fail.

```text
ctx.systemPrompt.section({
  name: 'tool:bash',
  order: 100,
  text: 'Prefer bash for file and process operations.',
})
```

### Contribute a prompt variable

Variables are referenced from section text as `{{name}}` and resolved at each assembly; scoped variables shadow a same-named global for that agent. The loop supplies `model` and `cwd`; any plugin can register the facts it owns.

```text
ctx.systemPrompt.variable('cwd', ({ agent }) => agent?.session.header.cwd)
```

### Contribute tool schemas

Tool-schema providers are evaluated per assembly and contribute the model-visible `ToolSchema` set; `ToolRuntime` registers itself automatically, so most tools need no manual wiring here. A provider returns the post-restriction visible set plus the pre-restriction name universe used by `toolOrder`.

### Suppress runtime context

`suppressRuntimeContext()` removes every dynamic runtime-context contribution for the calling scope without disabling the services that own the underlying facts; multiple suppressors compose and the effect restores context when none remains.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the package realizes the behavior above; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The package is a registry plus a cooperative assembly pipeline. One `assemble()` call merges the global layer with the requested scope's layer, detaches tool parameters, canonicalizes section order by number and then name, runs the scope-filtered `system-prompt/assemble` waterfall, restores an effective complete section as the sole prompt section, and applies any active runtime-context suppressor. Sections and dynamic contexts are separate inputs: sections become prompt text, while contexts become sourced user-role snapshots in model history under the loop. Tool schemas are part of the assembly by design — "what the model is told it can do" is one coherent thing, even though adapters transmit schemas as a separate wire field.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `SystemPrompt` service, config, assembly pipeline, `renderPrompt` |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion |

### Assembly and rendering

Assembly resolves and renders in two stages: `assemble()` returns sections with resolved-but-uninterpolated text, the ordered tool schemas, and every registered variable resolved against the context, while `renderPrompt()` interpolates `{{variable}}` references, drops empty sections, and joins with blank lines — strictly, an unknown reference, a registered-but-valueless reference, or a malformed complete group throws, because a malformed prompt is worse than a loud failure. `toolOrder` canonicalizes the collected tools before the waterfall (registration order is a plugin-load artifact); a waterfall listener that mutates the list owns the determinism of what it emits.

### Scoping

Scoped sections, variables, and tool providers shadow globals for one agent, and the assembly waterfall dispatches scope-filtered. Registry-change notifications (`system-prompt/change`) are deliberately unfiltered because a global change affects every scope.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The package-level contract is enough for most consumers; read these when you need the surrounding domain.

- [System-prompt subsystem](../../../docs/subsystems/system-prompt.md) — the exact cross-package types and generated service API.
- [tools package](../tools/README.md) — the tool registry whose schemas flow into assembly.
- [Prompt variables Agent Note](../../../.agents/notes/implemented/architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md) — who owns which prompt facts.
- [First-party prompt order Agent Note](../../../.agents/notes/archived/architecture/2026-08-25-sparse-first-party-prompt-section-orders.md) — the sparse named order allocation.
- [Core group map](../README.md) — how the core packages compose.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

First-party sections render the harness identity, deployment persona prefix (including the model-name introduction), reusable instructions (including the generated tools SDK and structured-output guidance), then the environment-bearing suffix: harness source (`10000`), Web surface (`10100`), and deployment persona suffix (`10200`). External section orders and assembly listeners remain authoritative. `includeHarnessIdentity: false` omits only that fixed opener. Empty sections disappear; scoped sections and variables can shadow globals for one agent. The `system-prompt/assemble` waterfall determines the delivered prompt and tool schemas unless one effective section declares itself complete — that exact section then becomes the whole system prompt while the waterfall's contexts, tools, and variables remain. Ordered dynamic contexts are separate from sections and become sourced user-role snapshots only when present; `includeRuntimeContext: false` or a scoped suppressor removes them all.

##### Harness identity

```markdown
You are an AI agent powered by DeepSeek Harness.
```

#### Token effect

Identity is a fixed per-request cost when enabled. Persona prefixes, suffixes, and plugin text are repeated per request and scale with their rendered content.

#### KV Cache effect

With the same model, persona prefix, tools, and preceding instructions, different source paths, local Web URLs, or persona suffix values leave the reusable first-party prefix unchanged. Persona prefix changes can alter the early prefix. Any change may invalidate reuse from the first changed token; provider cache sharing and measured hit rates are not guaranteed.

### Tool schemas

#### What the model sees

For shipped tools, the model receives the per-agent-visible subset of the [generated tool schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tools), ordered by configuration or lexicographically after restrictions and assembly interception. Extensions can contribute additional definitions through the same registry. Sections and schema providers are separate assembly inputs, so a tool restriction does not remove independently registered guidance.

#### Token effect

Schema tokens repeat on every request. Restricting a tool removes its entire schema cost for that agent but not a separate prompt section; reordering changes cache shape but not semantic content.

#### KV Cache effect

Prefix-stable while the visible schema set, rendering, and order are unchanged. Registration, restriction, or reordering may invalidate reuse from the first changed schema token.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when prompt assembly needs special care. They are current package constraints, not a task backlog.

- **Deployment-authored prompt text is config/composition only** — this plugin owns the global persona prefix and suffix defaults, creator plugins may register agent-scoped shadows, and other sections come from the plugin that owns the fact; there is no end-user prompt-editing API.
- **No escape syntax for literal `{{…}}` braces** — every complete group is interpolated against registered variables; an escape is deferred until a real prompt needs one.
- **`toolOrder` misconfiguration surfaces at prompt assembly (the first turn), not at boot** — only shape violations throw at config load.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
