---
description: "The tool registry and execution pipeline for tool authors and maintainers registering, restricting, presenting, or debugging model-facing tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-tools

English | [中文](README.zh.md)

## Summary

Use `dsh-tools` to expose typed capabilities to models, validate calls, enforce allow/deny/ask policy, and return finalized results without ending a turn on ordinary tool failures. Choose native Function Calling, [PTC mode](#ptc-mode), or both with `mode`; an agent can override the default through `presentAs`. Tool authors use `defineTool` to declare typed parameters and outputs, cooperative timeouts, parallel-safety, and optional UI presentation. Models see each permitted tool's declared name, description, and parameter schema; per-agent restrictions can narrow that visible set.

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

Mount `dsh-tools` wherever agents call tools: it provides `ctx.tools`, the registry every tool plugin registers into and the loop dispatches through. Registering a tool is enough to make it visible — the registry feeds its schemas into the system-prompt assembly automatically.

### Register a tool

`defineTool` builds a typed tool definition: a model-facing name, description, and parameter schema, a canonical output declaration, and an `execute` body that returns only the declared JSON value. Model arguments are validated before execution; invalid input becomes a normal error result.

```ts
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

declare const ctx: Context

ctx.tools.register(defineTool({
  name: 'read_file',
  description: 'Read a file from disk.',
  parameters: {
    path: { type: 'string', required: true, description: 'Absolute file path' },
    offset: { type: 'number' },
    limit: { type: 'number' },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args, exec) {
    // args is typed: { path: string; offset?: number; limit?: number }
    return readFile(args.path, { encoding: 'utf8', signal: exec.signal })
  },
}))
```

The unified schema DSL supports `string`, `number`, `integer`, `boolean`, `null`, `array`, `object`, author-only `json`, and exact-one `oneOf`; `InferValue` preserves exact types through 16 container levels before widening to `JsonValue`. A raw JSON Schema (`JsonSchemaNode`) is the wire-level counterpart shared with subagents, workflows, and MCP.

### Configure the presentation mode

The `mode` config decides what the model sees: `native` (every visible schema), `ptc` (only `run_code` plus a generated SDK), or `both`.

```yaml
- name: '@deepseek-ai/dsh-tools'
  config:
    mode: native
```

| Field | Default | Meaning |
|---|---|---|
| `mode` | `native` | How visible tools are presented to the model: `native`, `ptc`, or `both` |
| `maxParallelSubCalls` | `10` | Concurrency cap for a `run_code` program's overlapping sub-calls; `1` restores strictly serial dispatch |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tools) is the exhaustive source for every accepted field. Non-native modes require a composed `ctx.ptcRuntime` whose language has a registered SDK renderer; an agent preset selects its own presentation with [`dsh-agent-tool-presentation`](../agent-tool-presentation/README.md), and one agent can shadow the default with `presentAs(mode)`.

### Restrict tools per agent

`ctx.tools.restrict(filter)` applies an allow or deny mask to the global tools one agent inherits; masks intersect, scoped registrations stay visible, and the restriction lifts when disposed. `ctx.tools.get(name, scope)` resolves a tool as one scope sees it. A Host-local presenter consumer passes the calling agent when it must match the definition that executed. `ctx.tools.schemas(scope)` returns the visible schemas without the `execute` functions.

### Enforce policy on calls

`ctx.tools.guard(guard)` registers a monotonic synchronous guard after the extensible `tools/pre-execute` waterfall: a returned reason denies the call, and no later listener can turn that denial back into permission. The pipeline's events give plugins more control — `tools/pre-execute` decides allow/deny/ask, `tools/execute` wraps dispatch for timeout or retry, `tools/post-execute` inspects or replaces the result, and `tools/result` observes the frozen final outcome.

A tool’s `projectContent` installs execution-prepared content before post-execute policies. Policies may still replace or block it; `finalizeContent` remains the final content transform after those policies.

### Host presentation descriptors

A tool can retain pure `presentCall()` and `presentResult()` methods for Host-local consumers. The built-in Web Client does not consume those values. It selects a renderer through `tool.call.toolview` and derives card props from raw call arguments, result content, failure state, and persisted metadata. The [Client-derived presentation decision](../../../.agents/notes/implemented/architecture/2026-08-23-client-derived-tool-presentation.md) owns this transport split.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the package realizes the behavior above; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The registry holds typed `ToolDefinition`s in scoped layers and projects them onto the model-facing `ToolSchema` set at request time — `output`, `execute`, `finalizeContent`, `timeoutMs`, and presentation callbacks never leak onto the wire. Every call runs a fixed pipeline: `tools/pre-execute` (extensible allow/deny/ask) → registered monotonic guards → `tools/execute` (around-dispatch wrappers) → `tools/post-execute` (inspect/replace, attach context) → definition-owned `finalizeContent` → the observe-only `tools/result` event. Only the `tools/execute` view may replace the required signal, and the registry re-fuses the caller signal before the body.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `ToolRuntime` service, config, registry, execution pipeline |
| [`src/types.ts`](src/types.ts) | `ToolDefinition`, `ToolExecution`, `ToolExecutionResult`, guard and decision types |
| [`src/schema.ts`](src/schema.ts) | The `defineTool` DSL: `ValueSchemaSpec`, `ParameterSchemaSpec`, `InferValue`, `InferArgs` |
| [`src/json-schema.ts`](src/json-schema.ts) | The enforced raw JSON Schema subset and validation |
| [`src/presentation.ts`](src/presentation.ts) | The `card`-tagged UI render intents |
| [`src/ptc.ts`](src/ptc.ts) | PTC mode: SDK generation, `run_code` dispatch bridge, settlement |
| [`src/ts-types.ts`](src/ts-types.ts) | TypeScript SDK type rendering |
| [`src/py-types.ts`](src/py-types.ts) | Python SDK type rendering |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion |

### Execution and cancellation

Each typed invocation materializes and freezes parsed arguments, assigns an opaque correlation token, and runs policy and dispatch. A pre-execute denial may attach `ToolErrorInfo` beside its model-facing reason; the native and PTC durable projections preserve the structured name, code, and optional user-facing reason without adding that detail to model content. Cancellation is cooperative and quiescent: every tool body receives the caller-owned `exec.signal` and must observe it; cancellation before body invocation is `ABORTED_BEFORE_DISPATCH`, after invocation it replaces only a successful outcome with `ABORTED`. Denials, wrapper failures, tool failures, post-policy failures, and timeout-owned `TOOL_TIMEOUT` remain more specific. Unknown and throwing tools become structured errors (`UNKNOWN_TOOL`), so a call fails without ending the turn.

### PTC mode

Under `ptc` or `both`, the registry exposes the reserved `run_code` transport plus a deterministic SDK generated in the loaded runtime's language. Each SDK binding captures a frozen ToolSchema and passes it through the scheduler to its execution context. Before policy, a started call records only pairing ids, name, and normalized arguments; its settle event preserves the rendered result and optional structured error. Description and parameters remain transient and never enter Session events or SDK output. Calls are scheduled through a per-run pool that reuses the native concurrency contract. Under `ptc` alone, a model-direct call naming any other visible tool resolves to `UNKNOWN_TOOL` before policy — the announced surface and the callable surface stay the same. Intermediate binding values are execution-local; only the outer `run_code` result has a hard size cap. The [executor-collapse note](../../../.agents/notes/implemented/bug-fix/2026-08-07-ptc-executor-collapse.md) owns the collapse contract.

New sub-calls use `<parent>:ptc:<n>` ids. Consumers treat these ids as opaque and correlate events by exact equality; restored historical ids retain their original bytes. The [PTC mode decision](../../../.agents/notes/implemented/feature/2026-06-15-ptc.md) owns durable naming and restoration rules.

Successful image-bearing subcall results become deferred user-message context with `source.kind` set to `ptc-mode`. Other additional contexts retain their producing tool's attribution.

`run_code` accepts `timeoutMs` when the mounted runtime supports an override; its schema reports the configured default and maximum, the runtime's usage instructions and the Session working directory. The Node default is 120,000 ms with a 600,000 ms cap, including nested tool and approval waits. A wider `sandbox_permissions` mode requires a non-empty `justification` and approval before the program starts. The schema asks the model to write that reason in the current user's language. The grant applies to that complete execution; standing Session policy and nested tools retain their own authority. Programs are never replayed automatically: inspect earlier effects before explicitly retrying a denied program.

<a id="extension-points"></a>
### Extension points

Tool plugins call `ctx.tools.register()` and their schemas flow into prompt assembly automatically. `tools/pre-execute` is the reorderable allow/deny/ask gate; `ctx.tools.guard()` adds monotonic owner policy after it; `tools/execute` wraps normalized canonical dispatch for timeout, retry, or metrics; `tools/post-execute` may replace content or value, block with feedback, or attach ordered contexts; `tools/result` observes the immutable final outcome. MCP servers discover tools and register them with the server's schemas.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The package-level contract is enough for most consumers; read these when you need the surrounding domain.

- [Tools subsystem](../../../docs/subsystems/tools.md) — the full pipeline types, schema DSL, and generated service API.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tools) — the shipped tools' schemas the model receives.
- [Tool execution pipeline](../../../docs/tool-execution-pipeline.md) — the pipeline visualized.
- [Adding a tool cookbook](../../../docs/cookbook/adding-a-tool.md) — step-by-step tool authoring.
- [Cooperative cancellation Agent Note](../../../.agents/notes/implemented/architecture/2026-07-19-cooperative-tool-cancellation.md) — the full cancellation contract.
- [Core group map](../README.md) — how the core packages compose.

-----

<a id="model-experience"></a>
## Model Experience

### Normal tool schemas

#### What the model sees

In normal mode the model sees each visible definition's exact name, description, and JSON Schema; the shipped definitions are recorded in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tools). Agent-scoped restrictions, shadows, and extension registrations change that agent's end-tool set.

#### Token effect

Fixed per-request cost proportional to the visible definitions. Restrictions that hide tools remove their entire schema cost for that agent.

#### KV Cache effect

Prefix-stable while visible definitions and their order are unchanged. Registration, disposal, or scoped restriction may invalidate reuse from the first changed schema token.

### PTC mode schema and system prompt

#### What the model sees

PTC mode exposes the generated [`run_code` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tools), the SDK instructions below, and the generated exact SDK block for the loaded runtime's language. The TypeScript instructions identify generated declarations as program-only bindings. When the current `bash` parameter schema accepts the example arguments, they also show a complete `run_code` call around `tools.bash(...)`. The `tools:sdk` section uses first-party order 5000 and disables prompt-variable interpolation, preserving literal `{{…}}` text in tool descriptions and schemas for both runtime languages. `both` exposes normal schemas and this PTC mode API; under `ptc` the prompt also carries the `tools:ptc-only` rule earlier in the first-party order, so the model reads which tools it may call before it reads what each one is for.

##### TypeScript PTC mode SDK instructions with bash

```markdown
## Writing code for run_code

`run_code` takes two required arguments: `code` — the body of an async TypeScript function (erasable syntax only — no `enum` or namespaces; type annotations are advisory, the code runs type-stripped) — and `description`, a short summary of what the program does. The declarations below are SDK bindings for this program. A declaration does not make its name a directly callable tool; only names supplied as separate tool schemas may be called directly. When no separate `bash` schema is supplied, invoke a declared `bash` binding inside `run_code`:

`run_code({ code: "return await tools.bash({ command: 'pwd', description: 'Show current directory' })", description: "Show current directory" })`

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

### Tool-call history and results

#### What the model sees

The loop retains model-emitted arguments and the registry's final content. Any thrown or denied call becomes exactly `Error: <message>`; structured user-facing failure detail is not added to that message. PTC mode renders the outer program's printed lines and return value, `(run_code completed with no output)` when both are empty, or `Error: code run failed (<kind>): <message>` followed conditionally by `Captured output:` and the captured lines. Inner dispatch events stay log-only, while a successful image-bearing sub-result is appended after the outer result as source-attributed context.

#### Token effect

Arguments, results, and additional context are data-dependent and resent until compaction. Restrictions that hide tools also remove their schemas before the model can call them.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV Cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the registry needs special care. They are current package constraints, not a task backlog.

- **Concurrency policy is not an event gate** — `executionMode()` reads the resolved tool definition directly; plugins can only declare a classifier on definitions they own.
- **`tools/pre-execute` deliberately cannot rewrite `exec.arguments`** — logged and rendered args would desync from what ran; the rewrite design is [a proposed Agent Note](../../../.agents/notes/proposed/feature/2026-06-30-pre-tool-input-rewrite.md).
- **Caller-defined subagent and workflow structured outputs remain object-rooted** — this is a consumer-level guard; the shared schema vocabulary and tool outputs support every JSON root.
- **`timeoutMs` on a definition is declarative only** — the registry never enforces deadlines; enforcement requires the `@deepseek-ai/dsh-tool-call-timeout-policy` wrapper.
- **PTC mode's SDK language follows the one loaded runtime, and a presentation is per agent rather than per tool** — `mode: ptc`/`both` rejects prompt assembly unless `ctx.ptcRuntime.language` has a registered SDK renderer; within one agent no tool can be native-only while another is ptc-only.
- **PTC mode intermediate values are execution-local and unbounded by bytes** — they cannot be reconstructed from session replay and may exhaust process or worker memory; only the outer `run_code` output has the worker's configurable hard cap.
- **`run_code` state is fresh per run** — a persistent REPL-style kernel is rejected for the MVP, because cross-call state would be invisible to the log.

`defineTool()`, registry schema projection, and system-prompt assembly preserve `deferLoading: true`. The marker requests deferred definition loading and does not imply a `tool-addition` record; the [LLM package](../../../packages/llm/llm/README.md#known-limitations-and-deferred-work) documents provider enforcement limits.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
