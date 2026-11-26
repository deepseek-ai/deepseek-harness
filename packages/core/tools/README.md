---
description: "The tool registry and execution pipeline for tool authors and maintainers registering, restricting, presenting, or debugging model-facing tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-tools

English | [中文](README.zh.md)

## Summary

Use `dsh-tools` to expose typed capabilities to models, validate calls, enforce allow/deny/ask policy, and return finalized results without ending a turn on ordinary tool failures. Mount a native or PTC root registry to choose whether models call tools directly or through programs. Tool authors use `defineTool` to declare typed parameters and outputs, cooperative timeouts, parallel-safety, and optional UI presentation. Models see each permitted tool's declared name, description, and parameter schema; per-agent restrictions can narrow that visible set.

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

`ctx.tools.execute()` runs a complete raw call batch against the entries of the Agent's selected root registry; every call record carries the `definition` it resolved. `agent` is absent for standalone service calls; `log` is absent for programmatic calls outside a model step, including initialization hooks. An Agent without `log` still supplies tool scope but does not produce root call/result events.

Mount `dsh-tools` and one root registry wherever agents call tools: `ctx.tools` routes every registration to the root the scope selects. Registering a tool is enough to make it visible: the root declares it to the model directly or binds it in programs. Describe a tool to the model in its description and parameter descriptions.

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

A definition's `guidance` is a system prompt section that existing tools show only while the tool is available: `ctx.tools.register()` registers it in the same effect as the tool and renders it, literally, only while the viewing scope's registrations resolve that definition, which under the shipped Native and PTC roots means while the scope can call the tool directly or in programs, so a restriction or a nearer same-name definition hides it. Tools that name the same `section` share one section, whose text receives the names of the tools the scope resolves; they must declare the same guidance, because the latest registration in the nearest registering scope decides it. Adding new guidance is discouraged ([rationale](../../../.agents/notes/implemented/architecture/2026-11-19-composable-tool-registries.md)); guidance may mention another plugin's tool without checking for it.

The unified schema DSL supports `string`, `number`, `integer`, `boolean`, `null`, `array`, `object`, author-only `json`, and exact-one `oneOf`; `InferValue` preserves exact types through 16 container levels before widening to `JsonValue`. A raw JSON Schema (`JsonSchemaNode`) is the wire-level counterpart shared with subagents, workflows, and MCP.

<a id="compose-registries"></a>
### Compose registries

`ctx.tools` and every root registry implement `ToolRegistry`: `register(tool)`, `include(registry)`, `get(name, scope?)`, and `getAll(scope?)`. `include()` reads another registry's entries at every query and returns its disposer; the source keeps ownership of its definitions. A source's `getAll()` can list several definitions under one name, so a registry that includes it resolves each name through `get()` or treats a repeated name as a conflict. A registration or inclusion on `ctx.tools` reaches the root its scope selects and the roots selected below it, including roots that load later: nearer registrations and inclusions shadow farther ones, and one scope offering two different definitions under one name fails as `INVALID_TOOL_COMPOSITION`. A conflict that appears later, such as an included registry adding a second definition for an Agent, or an included registry that reads `ctx.tools`, fails the lookups that reach it; in a batch only the affected call fails, its result tells the model that the tool is misconfigured, and the deployment log records the failure's message, which names the conflicting definitions when the failure is an ambiguity. `ctx.tools.get()` and `getAll()` return the selected root's entries for the viewing scope: every visible tool under a native root, only `run_code` under a PTC root. Without an available root they throw `TOOL_REGISTRY_UNAVAILABLE`, like `execute()`.

`ctx.tools.setRoot(registry)` installs the calling scope's root and hands it the registrations its scopes see; an unscoped call installs the deployment default. Agents use the nearest root, and each scope allows one. A root must not include or read `ctx.tools`; such a read fails with `INVALID_TOOL_COMPOSITION`, in `setRoot()`, which then keeps the scope's earlier selection, or in the later lookup or call that reaches it. Register tools through `ctx.tools`: a tool registered directly in a root skips the scope's conflict check, so another definition registered under its name through `ctx.tools` is accepted and the next `ctx.tools.getAll()` throws. A root selected again after it unloads keeps its single inclusion of the registrations. Selecting or unloading a root emits `tools/change`; an observer that throws fails the selection, which restores the earlier selection and emits `tools/change` again. An unloaded root stays selected as unavailable, so lookups, new batches, and prompt assemblies fail with `TOOL_REGISTRY_UNAVAILABLE` until a replacement is installed; an accepted batch settles through its root. Mount one root plugin:

```yaml
- name: '@deepseek-ai/dsh-tools'
- name: '@deepseek-ai/dsh-tool-registry-native'
```

The [native](../tool-registry-native/README.md) root offers every visible tool directly; the [PTC](../tool-registry-ptc/README.md) root offers `run_code` and declares the tools as a generated SDK. Agent-step concurrency uses the [agent-loop configuration](../agent-loop/README.md). A PTC root's prompt sections follow ordinary [section lifecycle rules](../system-prompt/README.md): unloading the root retires them at the next assembly.

<a id="per-agent-tools"></a>
### Offer tools to individual Agents

Before each model step, AgentLoop captures `ctx.tools.getAll(agent)` as a `ToolStep`. The step's prompt declares those entries, and its batch and program calls execute only those exact definitions; a tool registered or replaced while the model responds takes effect in the next step, while calls to a declared tool that its provider removes or withdraws for the Agent fail as `UNKNOWN_TOOL`. A model-direct call to a tool the root binds only in programs fails as `UNKNOWN_TOOL` before `tools/pre-execute`, approval, guards, and execution wrappers, with a message naming the entries the step can call. A call to a name nothing registers, or to a tool a restriction or its provider withholds from the Agent, runs policy and then fails at dispatch. Dispatch runs exactly the definition captured when the call was prepared. Request retries keep the step's tools.

A provider whose tool depends on Agent state includes an `AgentToolRegistry` (exported with `ToolStep` and `NativeToolRegistry` from `@deepseek-ai/dsh-tools/pipeline`), registers the tool there, and calls `set(agent, names)` when the state changes: when the Agent is created or resumed, when the plugin loads for existing Agents, when the state itself changes, and when a blank Session's preset change (`agent-preset/selected`) moves a live Agent into the provider's preset. A step uses the tools set before it starts. The unscoped view lists every registered tool, so restrictions and `toolOrder` can name it before an Agent sees it; a call without an Agent reaches the tool's body, which checks `exec.agent` when it needs one. Web tools call `set()` when the Agent's model route, a credential, or the Web providers change; Plan, Office, and Team call it from their own state changes. A per-Agent provider decides its guidance for each Agent from its own registry, such as `registry.get(name, agent)`.

### Restrict tools per agent

`ctx.tools.restrict(filter)` applies an allow or deny mask to the tools one agent inherits, including tools an ancestor includes from another registry; masks intersect, the scope's own registrations and inclusions stay visible, and the restriction lifts when disposed. An `allow` name must be inherited, while `deny` accepts a name nothing offers yet. Roots apply the mask to their entries and program bindings, and a restricted tool's `guidance` stops rendering for that agent. A policy that must match the definition that executed reads `exec.definition`. `projectToolSchema()` returns a definition's model-facing schema without its callbacks.

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

The registry holds typed `ToolDefinition`s in scoped layers and projects them onto the model-facing `ToolSchema` set at request time — `output`, `execute`, `finalizeContent`, `timeoutMs`, and presentation callbacks never leak onto the wire. Built-in registries reuse the shared pipeline: `tools/pre-execute` (extensible allow/deny/ask) → registered monotonic guards → `tools/execute` (around-dispatch wrappers) → `tools/post-execute` (inspect/replace, attach context) → definition-owned `finalizeContent` → the observe-only `tools/result` event. Only the `tools/execute` view may replace the required signal, and the registry re-fuses the caller signal before the body.

### Source map

- [`src/index.ts`](src/index.ts) — Plugin entry and public tool APIs; scoped registrations routed to the selected root, and batch execution.
- [`src/contracts.ts`](src/contracts.ts) — Tool definitions, invocation results, guards and decisions.
- [`src/registry.ts`](src/registry.ts) — `ToolRegistry` and batch input/output.
- [`src/entries.ts`](src/entries.ts) — Registrations and live inclusions of registries without scopes.
- [`src/step.ts`](src/step.ts) — `ToolStep`, the entries one model step declared.
- [`src/agent-tools.ts`](src/agent-tools.ts) — `AgentToolRegistry`, tools added per Agent.
- [`src/native-registry.ts`](src/native-registry.ts) — `NativeToolRegistry`, whose entries are model-callable tools.
- [`src/pipeline.ts`](src/pipeline.ts) — Shared `prepare`, `dispatch`, and `complete` stages, their result types, and the batch entry point.
- [`src/batch.ts`](src/batch.ts) — Concurrency, ordered results and optional Session logging.
- [`src/events.ts`](src/events.ts) — Shared execution policy events.
- [`src/schema.ts`](src/schema.ts) — Typed tool definitions and model-facing schema projection.
- [`src/json-schema.ts`](src/json-schema.ts) — Supported JSON Schema validation.
- [`src/presentation.ts`](src/presentation.ts) — Tool-card render intents.

### Execution and cancellation

Each typed invocation materializes and freezes parsed arguments, assigns an opaque correlation token, and runs policy and dispatch. A pre-execute denial may attach `ToolErrorInfo` beside its model-facing reason; the native and PTC durable projections preserve the structured name, code, and optional user-facing reason without adding that detail to model content. Cancellation is cooperative and quiescent: every tool body receives the caller-owned `exec.signal` and must observe it; cancellation before body invocation is `ABORTED_BEFORE_DISPATCH`, after invocation it replaces only a successful outcome with `ABORTED`, and a thrown signal reason or `Error` named `AbortError` without `HarnessError` identity keeps its message but carries `ABORTED`. A `tools/execute` wrapper that throws such a value after caller cancellation is classified the same way, as `ABORTED_BEFORE_DISPATCH` when the body never started. Denials, other wrapper failures, tool failures, post-policy failures, and timeout-owned `TOOL_TIMEOUT` remain more specific. Unknown and throwing tools become structured errors (`UNKNOWN_TOOL`), so a call fails without ending the turn.

### PTC mode

The [PTC registry](../tool-registry-ptc/README.md) owns program transport, SDK generation, nested dispatch, and image context.

<a id="extension-points"></a>
### Extension points

Tool plugins call `ctx.tools.register()` and their schemas flow into prompt assembly through the selected root. `tools/pre-execute` is the reorderable allow/deny/ask gate; `ctx.tools.guard()` adds monotonic owner policy after it; `tools/execute` wraps normalized canonical dispatch for timeout, retry, or metrics; `tools/post-execute` may replace content or value, block with feedback, or attach ordered contexts; `tools/result` observes the immutable final outcome. MCP servers discover tools and register them with the server's schemas.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The package-level contract is enough for most consumers; read these when you need the surrounding domain.

- [Tools subsystem](../../../docs/subsystems/tools.md) — the full pipeline types, schema DSL, and generated service API.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-registry-ptc) — the shipped tools' schemas the model receives.
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

In normal mode the model sees each visible definition's exact name, description, and JSON Schema; the shipped definitions are recorded in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-registry-ptc). Agent-scoped restrictions, shadows, and extension registrations change that agent's end-tool set.

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
- **Some tool prompt text stays when its tool is restricted** — only a definition's `guidance` follows the tool's availability. Sections registered apart from their tool with `systemPrompt.section()`, such as bash's, stay while their plugin is loaded. So do the sections of per-Agent providers (Web, Plan, Office, Team) and CUA, the delegation depth context, the `send_message` and `list_agents` lines of the subagent identity context, and the skill catalog message.

`defineTool()`, registry schema projection, and system-prompt assembly preserve `deferLoading: true`. The marker requests deferred definition loading and does not imply a `tool-addition` record; the [LLM package](../../../packages/llm/llm/README.md#known-limitations-and-deferred-work) documents provider enforcement limits.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
