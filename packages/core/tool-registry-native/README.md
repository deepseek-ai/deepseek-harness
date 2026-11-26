---
description: "Native function calls with scoped tools and bounded batch execution."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-registry-native

English | [中文](README.zh.md)

## Summary

Use this root registry when models should call each visible tool directly. Mount it beside the tool registry in the deployment, a preset, or an Agent scope. Parallel-safe calls can overlap; exclusive calls form barriers, and results remain in model order.

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

Add this row to a composition with `dsh-tools` mounted. The plugin installs a native root in the mounting scope: `ctx.tools.setRoot()` gives the root the registrations the scope's Agents see, and the root offers each of them as a directly callable entry. Agents use the nearest root, and each scope allows one; the [tools package](../tools/README.md#compose-registries) owns root selection and unavailable roots.

```yaml
- name: '@deepseek-ai/dsh-tool-registry-native'
```

Configure [agent-loop concurrency](../agent-loop/README.md) for Agent steps; the loop reads the limit once per batch, and `ctx.tools.execute()` runs a batch without a limit at `DEFAULT_MAX_PARALLEL_TOOL_CALLS` (10). Limits must be positive integers; `1` selects serial execution. This plugin has no configuration fields. A plugin that installs its own native root constructs `NativeToolRegistry`, whose only argument is a label for diagnostics, and passes it to `ctx.tools.setRoot()`, which gives it the registrations. A root must not include `ctx.tools`: the inclusion would read the root back, so `setRoot()` rejects such a root with `INVALID_TOOL_COMPOSITION`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The registry's entries are its registrations plus the entries of the registries it includes, read at every query; as a root it includes the registrations that `setRoot()` gives it, so it always offers the scope's current tools. `ctx.tools.execute()` receives the raw call batch, resolves each call through the selected root, and owns parsing, scheduling, cancellation, and optional model-step logging. A call carrying a `ToolStep` runs only the definition that step declared, so a same-name replacement fails as `UNKNOWN_TOOL` until the next step. It reuses the shared invocation pipeline for policy, tool bodies, and result notifications. After abort, it waits for started work and returns ordered error results for skipped calls. After the plugin unloads, the scope's root selection stays unavailable, and accepted batches still settle their calls.

- [`src/index.ts`](src/index.ts) — the root plugin; `NativeToolRegistry` is defined in [`dsh-tools/pipeline`](../tools/src/native-registry.ts).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Tool registry](../tools/README.md)
- [Agent loop](../agent-loop/README.md)
- [PTC tool registry](../tool-registry-ptc/README.md)
- [Composable tool registries decision](../../../.agents/notes/implemented/architecture/2026-11-19-composable-tool-registries.md)

-----

<a id="model-experience"></a>
## Model Experience

### Visible tools

#### What the model sees

Each visible tool’s `name`, `description`, and JSON Schema parameters; no additional prompt section.

#### Token effect

Request cost grows with visible definitions; hiding a definition removes its schema cost.

#### KV Cache effect

The prefix remains stable while tool descriptions and ordering stay unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These constraints apply to accepted calls.

- Same-process tools must observe cancellation; the registry cannot forcibly terminate a tool that ignores its signal.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
