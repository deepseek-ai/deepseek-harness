---
description: "Native function calls with scoped tools and bounded batch execution."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-executor-native

English | [中文](README.zh.md)

## Summary

Use this executor when models should call each visible tool directly. Mount it beside the tool registry in the deployment, a preset, or an Agent scope. Parallel-safe calls can overlap; exclusive calls form barriers, and results remain in model order.

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

Add this row to a composition with `dsh-tools` mounted. The nearest scoped executor selects tool behavior; one scope permits only one executor.

```yaml
- name: '@deepseek-ai/dsh-tool-executor-native'
```

Configure [agent-loop concurrency](../agent-loop/README.md) for Agent steps; the loop reads the limit once per batch. This plugin has no configuration fields. Direct `NativeToolExecutor` callers may pass a constructor callback, defaulting to `10`, which is sampled for each tool group when the batch omits `maxParallelToolCalls`. Limits must be positive integers; `1` selects serial execution.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The executor receives the entire raw call batch and owns parsing, scheduling, cancellation, and optional model-step logging. It reuses the shared invocation pipeline for policy, tool bodies, and result notifications. After abort, it waits for started work and returns ordered error results for skipped calls.

- [`src/index.ts`](src/index.ts) — Scoped executor registration; tool descriptions and batch execution.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Tool registry](../tools/README.md)
- [Agent loop](../agent-loop/README.md)
- [Alternative executor](../tool-executor-ptc/README.md)

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

- Same-process tools must observe cancellation; the executor cannot forcibly terminate a tool that ignores its signal.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
