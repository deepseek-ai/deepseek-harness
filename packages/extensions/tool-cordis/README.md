---
description: "Model-facing Cordis runtime tools for agents and maintainers choosing, composing, or debugging dynamic-package workflows."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-cordis

English | [中文](README.zh.md)

## Summary

`dsh-tool-cordis` gives the model seven tools over the live Cordis runtime of the current DSH process: inspect what is loaded and what a dynamic package may use, define a package with a host half, a browser half, or both, run it, stop it, and remove it. Packages are versioned — a plugin holds immutable package versions, and the model can append a corrected package and update to it after a failure. Definitions live only in process memory and vanish on DSH restart; nothing here writes repository files, installs packages, or changes `cordis.yml`. It also adds a system-prompt section that teaches the workflow; compose it with `@deepseek-ai/dsh-cordis-host-runner`, the package that runs the sandbox and the run round trip.

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

Mount this plugin when a session should be able to extend its own runtime temporarily — for example, a model-written tool, service, or browser UI that helps the current work but should not become a repository plugin. Compose it with the host runner; without the runner the tools never activate, and no shipped bundle mounts the toolset (the web profile already mounts the host runner and the browser faces), so add the tool row explicitly.

### Minimal composition

```yaml
- name: '@deepseek-ai/dsh-cordis-host-runner'
  config:
    vmTimeoutMs: 5000
- name: '@deepseek-ai/dsh-tool-cordis'
```

The CLI example [`apps/cli/config/examples/cordis/cordis.yml`](../../../apps/cli/config/examples/cordis/cordis.yml) composes both. A package with a browser half additionally needs the browser runner and the UI package in the client composition; a host-only package needs none of them.

### What the tools do

The three inspect tools are read-only; the four lifecycle tools define and manage packages. All results are JSON rendered as text.

- `cordis_inspect_list` — list the Inspect Providers (host and client) and their query methods.
- `cordis_inspect_query` — run one provider query: exact service methods, event modes, builtin signatures, tool schemas, theme tokens, or live slot trees.
- `cordis_inspect_self` — this session's dynamic plugins: version pointers, latest run, and, for one exact package, its source and runtime diagnostics.
- `cordis_define` — record a package: a new plugin (`plugin.kind: "new"` with a 3–6-letter `idPrefix`) or a new version of an existing plugin (`plugin.kind: "existing"` with its `pluginId`). It validates parameters and syntax only; nothing runs and no approval is requested.
- `cordis_run` — activate one package (`mode: "run"` for the first activation or restart, `mode: "update"` to switch versions). A package with a browser half may return `awaiting-approval` until a person allows it; the tool never waits for the final outcome.
- `cordis_stop` — stop the current run and cancel any pending approval, keeping the plugin and every package version.
- `cordis_undefine` — stop and permanently remove a plugin and all of its packages.

### A typical workflow

Inspect before writing, then define, then run: `cordis_inspect_query` reads the exact contract of the service or slot the package will use, `cordis_define` records the source (and the conversation shows a define card pointing to the panel where the run control lives), and `cordis_run` activates it. When the user types `@pluginId`, this package injects a context message that pins the referenced plugin, its base package, and the update path. After a technical failure, read the diagnostics with `cordis_inspect_self`, append a corrected package to the same plugin, and update to it.

### Boundaries to plan around

Definitions are session-scoped and process-local: a package is visible and controllable only in the session that defined it, stays active across later turns, and can affect other sessions in the same process while running. Stopping, removing, unloading the toolset, or restarting DSH clears it. The sandbox isolates globals but is not a security boundary — treat a dynamic package like bash access, and load this plugin as deliberately as you would grant one.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the tools; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The toolset is built on one separation: the tools are a thin, model-facing layer over the runner service. Inspection data comes from generated catalogs intersected with the live service store; definition and lifecycle verbs delegate to `ctx.dynamicCordisRunner`, which owns the registry, the vm sandbox, and the browser round trip. The tools add the model-facing judgments: only callable methods are shown, only keys a host half can reach are named, and every refusal is a teaching error the model can act on.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: tool registration, system-prompt section, `@pluginId` context injection |
| [`src/inspect.ts`](src/inspect.ts) | Report rendering: joins the generated API catalog with the live service store |
| [`src/api-catalog.ts`](src/api-catalog.ts) | Generated projection of the workspace's Cordis declarations (regenerated by `pnpm run gen-cordis-api`, gated by `verify-cordis-api`) |
| [`src/prompt.ts`](src/prompt.ts) | The `tool:cordis` system-prompt section |
| [`src/providers.ts`](src/providers.ts) | First-party host Inspect Providers: Service, Event, Builtin, Tool |
| [`src/present.ts`](src/present.ts) | Replay-safe generic card render intents |

### How a call flows

An inspect call queries `ctx.cordisInspect`: host providers run locally, client providers wait for the first valid page response. Define prechecks each half's syntax by compiling it in the same wrapper the sandbox uses, so unparseable code is refused before an id exists. Run delegates to the runner, which activates host-only packages in-process and suspends browser-half packages on a `cordis/request-run` round trip; the tool returns the runner's receipt (`awaiting-approval`, `starting`, or `running`). When the user writes `@pluginId`, an `agent/pre-step` handler reads the reference and injects a user-role context message naming the base package and the required next steps.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared toolset to the runner internals, the generated schemas, and the subsystem surface.

- [Host runner](../cordis-host-runner/README.md) — the registry, sandbox, and run round trip these tools delegate to.
- [Client runner](../cordis-client-runner/README.md) — the browser half that answers run requests and loads browser-half code.
- [UI package](../ui-cordis/README.md) — the panel and tool cards users operate definitions with.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-cordis) — the exact schemas the model receives.
- [Extensions subsystem](../../../docs/subsystems/extensions.md) — the generated `ctx.cordisInspect` and `ctx.dynamicCordisRunner` API.
- [Self-referential Cordis toolset Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md) — design home: sandbox semantics, dynamic-package lifecycle, and composition.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

The conversation model sees the generated [`cordis_inspect_list`, `cordis_inspect_query`, `cordis_inspect_self`, `cordis_define`, `cordis_run`, `cordis_stop`, and `cordis_undefine` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-cordis) whenever this plugin is visible.

#### Token effect

Fixed schema cost on every request in that tool view.

#### KV Cache effect

Prefix-stable while this tool view is unchanged. Scoping or plugin-lifecycle changes that hide these definitions may invalidate reuse from the first changed schema token.

### System prompt section

#### What the model sees

This package registers one system-prompt section (`tool:cordis`, order 115) teaching when and how to use the dynamic-plugin workflow, the recommended tool sequence, and the high-frequency errors to avoid; the full text lives in [`src/prompt.ts`](src/prompt.ts). The section opens with:

##### Section opening

```markdown
# Dynamic Cordis Plugins

Dynamic Cordis plugins temporarily extend the current DSH process. A Plugin uses apply(ctx) to consume Services, listen to Events, provide Services, register model Tools, or register browser UI in Slots.
```

#### Token effect

The section's rendered text repeats on every request while this plugin is visible.

#### KV Cache effect

Prefix-stable while the section text and order are unchanged; editing the prompt or changing its order may invalidate reuse from the first changed token.

### Tool-call history and results

#### What the model sees

Inspect outputs are JSON rendered as text: `cordis_inspect_list` returns the provider directory, `cordis_inspect_query` the queried data, and `cordis_inspect_self` a plugin, version, and package summary with source and diagnostics for an exact package. Define answers that the package is defined and not running yet, with the ids to run. Run reports `awaiting-approval`, `starting`, or `running` with the run id and version pointers. Stop and undefine acknowledge in one line. Every refusal is a tool error carrying the runner's teaching text, and the submitted program stays in assistant tool-call history.

#### Token effect

Inspect output and submitted package code are data-dependent and resent until compaction; lifecycle acknowledgements are small.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Later requests after cordis_run

#### What the model sees

A running package may register tools, prompt contributions, or listeners that change later requests for the scopes it targets; `cordis_stop` and `cordis_undefine` remove those contributions after quiescence. When the user types `@pluginId`, the injected reference context also adds a user-role message naming the base package and the next steps.

#### Token effect

Indirect token impact equals the running package's contributions and lasts only for its process-local lifetime.

#### KV Cache effect

Running or stopping a prompt or tool contribution changes later request prefixes and may invalidate reuse from the first changed contribution; an unchanged running set remains prefix-stable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the toolset is a poor fit or needs special care. They are current package constraints, not a task backlog.

- **The sandbox is containment for honest code, not a security boundary** — host-realm helpers on the sandbox global are reachable, so package code can reach Node; load this plugin as deliberately as you would grant a bash tool.
- **Plain JavaScript only** — dynamic package code is not transformed: no TypeScript, JSX, or imports, and the sandbox withholds Node globals such as `require`, `setTimeout`, and `fetch`, redirecting filesystem, network, and process work to Cordis services.
- **The vm and approval bounds belong to the runner** — see its [Known Limitations](../cordis-host-runner/README.md#known-limitations-and-deferred-work); an async host-half body escapes `vmTimeoutMs`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This model-facing adapter has no independent lifecycle stream; execution relations are owned by the capability seam it calls.
