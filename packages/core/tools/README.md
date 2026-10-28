---
description: "The tool registry and execution pipeline for tool authors and maintainers registering, restricting, presenting, or debugging model-facing tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-tools

English | [中文](README.zh.md)

## Summary

Use `dsh-tools` to expose typed capabilities to models, validate calls, enforce allow/deny/ask policy, and return finalized results without ending a turn on ordinary tool failures. Mount a native or PTC executor to choose the model interaction and batch execution behavior. Tool authors use `defineTool` to declare typed parameters and outputs, cooperative timeouts, parallel-safety, and optional UI presentation. Models see each permitted tool's declared name, description, and parameter schema; per-agent restrictions can narrow that visible set.

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

`ctx.tools.execute()` accepts a complete raw call batch. `agent` is absent for standalone service calls; `log` is absent for programmatic calls outside a model step, including initialization hooks. An Agent without `log` still supplies tool scope but does not produce root call/result events.

Mount `dsh-tools` wherever agents call tools: it provides `ctx.tools`, the registry every tool plugin registers into and the selected executor resolves. Registering a tool is enough to make it visible — the registry feeds its schemas into the system-prompt assembly automatically.

### Register a tool

`defineTool` builds a typed tool definition: a model-facing name, description, and parameter schema, a canonical output declaration, and an `execute` body that returns only the declared JSON value. Model arguments are validated before execution; invalid input becomes a normal error result.

Canonical values belong to execution; the Session records rendered content and optional presentation metadata instead. Replacing or redacting that content does not remove the canonical value available to a programmatic caller; a policy that must deny that access must block execution or replace the value.

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

<a id="conditional-tools"></a>
### Conditional tools

`register(definition, { when })` evaluates a synchronous or asynchronous condition once for each model step. The condition receives `{ agent, modelSelection, signal }`; `modelSelection` is the provider, model, and reasoning effort that step preparation captured for every request attempt in the step, the same value as `AssembleContext.modelSelection`. False omits the tool from the executor's description, PTC bindings, and execution. A thrown condition fails step preparation as `TOOL_ACTIVATION_FAILED`; it is not treated as ordinary unavailability. Conditions must observe cancellation and must not change registrations or perform tool work.

`resolve({ agent, modelSelection, signal })` returns a step-owned `ResolvedToolSet`. Pass it as `toolSet` to prompt assembly and the step's `ctx.tools.execute()` batch, then dispose it after the batch settles; retries in the step reuse it. Executors apply the batch's set to every call, including PTC program subcalls. Registrations stay effect-owned; each selection admits only the original registration in its exact agent scope. Disposal, new restrictions, or same-name replacement prevent unstarted calls from using it; after cancellation, calls settle with the shared pipeline's cancellation results. Started operations retain their cooperative cancellation obligations. Conditional calls in a batch without a resolved set return `UNKNOWN_TOOL`.

`get(name, scope, toolSet)`, `definitions(scope, toolSet)`, and `schemas(scope, toolSet)` inspect an admitted set; omitting `toolSet` inspects registered definitions without evaluating conditions. `executable(name, scope, toolSet)` is the execution lookup: it applies the set, and without one it excludes conditional registrations. Executor descriptions and sections receive the same selection as `AssembleContext.toolSet`. A presentation transform cannot add or remove callable tools.

### Select an executor

Mount one executor in the deployment, preset, or Agent scope. The nearest scope selects the provider; duplicate providers in one scope fail. Native exposes visible capabilities directly; PTC exposes `run_code` and a generated SDK. Executor registration and disposal do not emit `tools/change`; prompt assemblies and batches resolve the current executor when they run.

```yaml
- name: '@deepseek-ai/dsh-tools'
- name: '@deepseek-ai/dsh-tool-executor-native'
```

Agent-step concurrency uses the [agent-loop configuration](../agent-loop/README.md). See the [native](../tool-executor-native/README.md) or [PTC](../tool-executor-ptc/README.md) package for executor settings. Custom providers implement only `describe(definitions)` and `execute(batch)`; the shared pipeline is optional. The registry selects the current scoped executor separately for prompt descriptions and each `ctx.tools.execute()` batch. An accepted batch settles through its selected provider even if that provider unloads; settlement may include cancellation errors according to the provider’s disposal policy. New batches reject until a replacement is registered.

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

The registry holds typed `ToolDefinition`s in scoped layers and projects them onto the model-facing `ToolSchema` set at request time — `output`, `execute`, `finalizeContent`, `timeoutMs`, and presentation callbacks never leak onto the wire. Built-in executors reuse the shared pipeline: `tools/pre-execute` (extensible allow/deny/ask) → registered monotonic guards → `tools/execute` (around-dispatch wrappers) → `tools/post-execute` (inspect/replace, attach context) → definition-owned `finalizeContent` → the observe-only `tools/result` event. Only the `tools/execute` view may replace the required signal, and the registry re-fuses the caller signal before the body.

### Source map

- [`src/index.ts`](src/index.ts) — Plugin entry and public tool APIs; scoped tool service and executor selection.
- [`src/contracts.ts`](src/contracts.ts) — Tool definitions, invocation results, guards and decisions.
- [`src/executor.ts`](src/executor.ts) — Executor descriptions and batch input/output.
- [`src/pipeline.ts`](src/pipeline.ts) — Shared `prepare`, `dispatch`, and `complete` stages, their result types, and the batch entry point.
- [`src/batch.ts`](src/batch.ts) — Concurrency, ordered results and optional Session logging.
- [`src/events.ts`](src/events.ts) — Shared execution policy events.
- [`src/schema.ts`](src/schema.ts) — Typed tool definitions and model-facing schema projection.
- [`src/json-schema.ts`](src/json-schema.ts) — Supported JSON Schema validation.
- [`src/presentation.ts`](src/presentation.ts) — Tool-card render intents.

### Execution and cancellation

Each typed invocation materializes and freezes parsed arguments, assigns an opaque correlation token, and runs policy and dispatch. A pre-execute denial may attach `ToolErrorInfo` beside its model-facing reason; the native and PTC durable projections preserve the structured name, code, and optional user-facing reason without adding that detail to model content. Cancellation is cooperative and quiescent: every tool body receives the caller-owned `exec.signal` and must observe it; cancellation before body invocation is `ABORTED_BEFORE_DISPATCH`, after invocation it replaces only a successful outcome with `ABORTED`. Denials, wrapper failures, tool failures, post-policy failures, and timeout-owned `TOOL_TIMEOUT` remain more specific. Unknown and throwing tools become structured errors (`UNKNOWN_TOOL`), so a call fails without ending the turn.

### PTC mode

The [PTC executor](../tool-executor-ptc/README.md) owns program transport, SDK generation, nested dispatch, and image context.

<a id="extension-points"></a>
### Extension points

Tool plugins call `ctx.tools.register()` and their schemas flow into prompt assembly automatically. `tools/pre-execute` is the reorderable allow/deny/ask gate; `ctx.tools.guard()` adds monotonic owner policy after it; `tools/execute` wraps normalized canonical dispatch for timeout, retry, or metrics; `tools/post-execute` may replace content or value, block with feedback, or attach ordered contexts; `tools/result` observes the immutable final outcome. MCP servers discover tools and register them with the server's schemas.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The package-level contract is enough for most consumers; read these when you need the surrounding domain.

- [Tools subsystem](../../../docs/subsystems/tools.md) — the full pipeline types, schema DSL, and generated service API.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-executor-ptc) — the shipped tools' schemas the model receives.
- [Tool execution pipeline](../../../docs/tool-execution-pipeline.md) — the pipeline visualized.
- [Adding a tool cookbook](../../../docs/cookbook/adding-a-tool.md) — step-by-step tool authoring.
- [Tool testkit](../../test-support/tool-testkit/README.md) — tool-definition and execution fixtures for tests and benchmarks.
- [Cooperative cancellation Agent Note](../../../.agents/notes/implemented/architecture/2026-07-19-cooperative-tool-cancellation.md) — the full cancellation contract.
- [Core group map](../README.md) — how the core packages compose.

-----

<a id="model-experience"></a>
## Model Experience

### Normal tool schemas

#### What the model sees

In normal mode the model sees each visible definition's exact name, description, and JSON Schema; the shipped definitions are recorded in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-executor-ptc). Agent-scoped restrictions, shadows, and extension registrations change that agent's end-tool set.

#### Token effect

Fixed per-request cost proportional to the visible definitions. Restrictions that hide tools remove their entire schema cost for that agent.

#### KV Cache effect

Prefix-stable while visible definitions and their order are unchanged. Registration, disposal, or scoped restriction may invalidate reuse from the first changed schema token.

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

`defineTool()`, registry schema projection, and system-prompt assembly preserve `deferLoading: true`. The marker requests deferred definition loading and does not imply a `tool-addition` record; the [LLM package](../../../packages/llm/llm/README.md#known-limitations-and-deferred-work) documents provider enforcement limits.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
