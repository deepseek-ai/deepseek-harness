---
description: "Program-based tool execution, generated SDKs, and nested-call limits."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-executor-ptc

English | [中文](README.zh.md)

## Summary

Use this executor when models should call tools through `run_code` programs. Mount a compatible PTC runtime and tool registry first. Scoped restrictions determine the generated SDK; only `run_code` is directly callable. Configure concurrency for parallel-safe program subcalls.

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
- name: '@deepseek-ai/dsh-tool-executor-ptc'
  config:
    maxParallelSubCalls: 10
```

Root `run_code` calls are exclusive and execute serially. `maxParallelSubCalls` limits parallel-safe nested calls within each program and defaults to `10`; it must be a positive integer, with `1` selecting serial execution. Exclusive calls form barriers.

This package declares `ctx.ptcRuntime` and `ctx.systemPrompt` as required injections; Agent-owned programs need `ctx.workingDirectory`. The executor activates only after its runtime is available and withdraws when that runtime unloads. An enabled PTC executor without a runtime stops application startup. A withdrawn PTC selection never falls back to native execution.

Shared dispatch events and the `ptc-mode` message-source declaration live in `@deepseek-ai/dsh-tool-executor-ptc/types`; Client code imports the same declarations through `@deepseek-ai/dsh-tool-executor-ptc/client`. Both entries exclude Host service declarations. Host policy extensions use `import type` from the package entry for `PtcDispatchLog` and `tools/ptc-dispatch-log` without mounting the executor.

[Configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-executor-ptc)

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The executor receives the entire raw call batch and owns parsing, scheduling, cancellation, and optional model-step logging. It reuses the shared invocation pipeline for policy, tool bodies, and result notifications. After abort, it waits for started work and returns ordered error results for skipped calls. Unloading the executor aborts active sandboxed programs and waits for their nested calls to settle. Accepted batches still settle through that executor, potentially with cancellation errors.

### PTC mode

The PTC executor exposes the reserved `run_code` transport plus a deterministic SDK generated in the loaded runtime's language. Each SDK binding captures a frozen ToolSchema and passes it through the scheduler to its execution context. Before policy, a started call records only pairing ids, name, and normalized arguments; its settle event preserves the rendered result, optional presentation metadata, and structured error. Metadata is projected from that call’s canonical value and frozen; it changes neither the program value nor model content. Description and parameters remain transient and never enter Session events or SDK output. Calls are scheduled through a per-run pool that reuses the native concurrency contract. Under `ptc` alone, a model-direct call naming any other visible tool resolves to `UNKNOWN_TOOL` before policy — the announced surface and the callable surface stay the same. Intermediate binding values are execution-local; only the outer `run_code` result has a hard size cap.

New sub-calls use `<parent>:ptc:<n>` ids. Consumers treat these ids as opaque and correlate events by exact equality; restored historical ids retain their original bytes. The [PTC mode decision](../../../.agents/notes/implemented/feature/2026-06-15-ptc.md) owns durable naming and restoration rules.

Successful image-bearing subcall results become deferred user-message context with `source.kind` set to `ptc-mode`. Other additional contexts retain their producing tool's attribution.

`run_code` accepts `timeoutMs` when the mounted runtime supports an override; its schema reports the configured default and maximum, and the runtime's usage instructions. The Node default is 120,000 ms with a 600,000 ms cap, including nested tool and approval waits. A wider `sandbox_permissions` mode requires a non-empty `justification` and approval before the program starts. The schema asks the model to write that reason in the current user's language. The grant applies to that complete execution; standing Session policy and nested tools retain their own authority. Programs are never replayed automatically: inspect earlier effects before explicitly retrying a denied program. Retained PTC environments follow the standing file policy. PTC observes committed Session mode changes and immediately cancels affected calls in both Node modes. Later PTC calls wait for their nested-tool cleanup before resolving the latest policy. The runtime owns process invalidation and cleanup; permission setters remain synchronous. One-time escalations omit the state owner and complete in a temporary environment; standing variables remain available to ordinary calls.

- [`src/index.ts`](src/index.ts) — Validated configuration and scoped registration; tool descriptions and batch execution.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Tool registry](../tools/README.md)
- [Agent loop](../agent-loop/README.md)
- [Alternative executor](../tool-executor-native/README.md)

-----

<a id="model-experience"></a>
## Model Experience

### PTC mode schema and system prompt

#### What the model sees

PTC mode exposes the generated [`run_code` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-executor-ptc), the SDK instructions below, and the generated exact SDK block for the loaded runtime's language. Both runtime languages list `code` before `description`; this is presentation order, not an enforced JSON member order. The TypeScript instructions use a return-value example for function-body runtimes and a printed-output example for REPL runtimes. They identify generated declarations as program-only bindings. When the current `bash` parameter schema accepts the example arguments, they also show a complete `run_code` call around `tools.bash(...)`. The `tools:sdk` section uses first-party order 5000 and disables prompt-variable interpolation, preserving literal `{{…}}` text in tool descriptions and schemas for both runtime languages. Under `ptc`, the prompt also carries the `tools:ptc-only` rule earlier in the first-party order, so the model reads which tools it may call before it reads what each one is for.

##### TypeScript PTC mode SDK instructions with bash

```markdown
## Writing code for run_code

`run_code` takes two required arguments: `code`, the body of an async TypeScript function (erasable syntax only — no `enum` or namespaces; type annotations are advisory, the code runs type-stripped), and `description`, a short summary of what the program does. The declarations below are SDK bindings for this program. A declaration does not make its name a directly callable tool; only names supplied as separate tool schemas may be called directly. When no separate `bash` schema is supplied, invoke a declared `bash` binding inside `run_code`:

`run_code({ code: "return await tools.bash({ description: 'Show current directory', command: 'pwd' })", description: "Show current directory" })`

Inside the program:

- Call tools as `await tools.name(args)` — quoted access for exotic names: `tools["my-tool"](args)`. Every call resolves to the tool's typed canonical JSON value. Tool arguments must be lossless JSON.
- A FAILED tool call rejects with `ToolCallError`, whose `toolName` identifies the failed tool and whose `message` is human-readable — `try/catch` it to handle and continue.
- Independent read-only calls MAY overlap under `Promise.all` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with `await`.
- Emit results with `return` and/or `console.log(...)`. Only what you print or return is program output. A successful tool result containing an image is attached after the run so you can inspect it on the next step; every other intermediate result stays out of the conversation, so extract just what you need.

Program-only SDK bindings:
```

#### Token effect

Fixed per-request cost proportional to the visible definitions. PTC mode trades end-tool schemas for generated SDK text plus one transport schema rather than promising a universal reduction.

#### KV Cache effect

Prefix-stable while the PTC mode selection, generated SDK, transport schema, and visible tool set are unchanged. Mode or filter changes may invalidate reuse from the first changed prompt or schema token.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These constraints apply to accepted calls.

- **PTC mode's SDK language follows the one loaded runtime, and a presentation is per agent rather than per tool** — PTC execution rejects prompt assembly unless `ctx.ptcRuntime.language` has a registered SDK renderer; within one agent no tool can be native-only while another is ptc-only.
- **PTC mode intermediate values are execution-local and unbounded by bytes** — they cannot be reconstructed from session replay and may exhaust process or worker memory; only the outer `run_code` output has the worker's configurable hard cap.
- **State depends on the runtime**: the default backend starts fresh; a REPL backend retains memory per live Agent. Agent disposal awaits release. Restart and execution failures can clear memory; model-visible guidance explains how to recreate missing variables. Programs and results remain in the Session log, without serializing live objects.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
