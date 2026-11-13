---
description: "Program-based tool execution, generated SDKs, and nested-call limits."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-executor-ptc

English | [中文](README.zh.md)

## Summary

Use this executor when models should call tools through `run_code` programs. Mount a compatible PTC runtime and tool registry first. Scoped restrictions determine the generated SDK; only `run_code` is directly callable. Configure the total tool-call limit per program and concurrency for parallel-safe subcalls.

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
    maxSubCallsPerMinute: 1024
    maxParallelSubCalls: 10
```

Root `run_code` calls are exclusive and execute serially. `maxParallelSubCalls` limits parallel-safe nested calls within each program and defaults to `10`; it must be a positive integer, with `1` selecting serial execution. Exclusive calls form barriers.

`maxSubCallsPerMinute` defaults to `1024` and must be a positive integer. Each `run_code` gets `floor(resolved timeoutMs / 60000 × maxSubCallsPerMinute)` tool-call attempts: the default Node timeout of two minutes allows 2048. Runtime defaults and timeout caps apply before this calculation; no deadline means no finite call allowance. This is a total allowance, not a rolling window, so calls may happen in a burst. All tool bindings share the count, including queued calls, invalid arguments, and failed tools. The next attempt terminates the entire program through the runtime abort path, cancels active subcalls, and abandons queued calls before returning `CODE_RUN_FAILED`. As with a timeout, catching a binding error cannot keep the program running; retained runtime state is discarded. Completed tool effects remain, and the next program starts a fresh count.

`PtcRuntime` providers must report `language: 'typescript'`. The selected executor rejects other languages during prompt assembly and execution, without falling back to native tools; the `/run-code` factory rejects them when creating a program tool. Schema reads and execution also validate the current provider. The executor generates a TypeScript SDK and tool schema; the provider supplies execution.

This package declares `ctx.ptcRuntime` and `ctx.systemPrompt` as required injections; Agent-owned programs need `ctx.workingDirectory`. The executor activates only after its runtime is available and withdraws when that runtime unloads. An enabled PTC executor without a runtime stops application startup. A withdrawn PTC selection never falls back to native execution.

Shared dispatch events and the `ptc-mode` message-source declaration live in `@deepseek-ai/dsh-tool-executor-ptc/types`; Client code imports the same declarations through `@deepseek-ai/dsh-tool-executor-ptc/client`. Both entries exclude Host service declarations. Host policy extensions use `import type` from the package entry for `PtcDispatchLog` and `tools/ptc-dispatch-log` without mounting the executor.

The `/run-code` entry exports `createRunCodeTool` for plugins that register a named program tool alongside native tools. Supply an explicit runtime and the complete private `ToolDefinition` list, then register the returned definition in the owning scope. Programs can call only that list, even when the Agent can call other native tools; the private definitions do not enter the tool registry. Nested calls retain normal approvals, guards, dispatch logs, screenshots, deferred context, and turn completion. `RunCodeConfig` exposes the same validated call-allowance and concurrency settings as this executor.

The caller owns the supplied runtime and must keep it available until the factory's context finishes disposal. For runtimes that retain state or enforce a sandbox, disposal cancels active Agent programs and waits for nested calls; Agent disposal releases its retained environment. Environment initialization belongs to the supplied [runtime's registration API](../../ptc-runtime/ptc-runtime/README.md#choose-a-backend); register it before exposing the program tool. The factory appends runtime syntax and execution guidance to the caller's description; the caller supplies instructions for the private bindings.

[Configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-executor-ptc)

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The executor receives the entire raw call batch and owns parsing, scheduling, cancellation, and optional model-step logging. It reuses the shared invocation pipeline for policy, tool bodies, and result notifications. After abort, it waits for started work and returns ordered error results for skipped calls. Unloading the executor aborts active Agent-owned programs whose runtime supports sandboxing or retains state, and waits for their nested calls to settle. Accepted batches still settle through that executor, potentially with cancellation errors.

### PTC mode

The PTC executor exposes the reserved `run_code` transport and a deterministic TypeScript SDK. Each SDK binding captures a frozen ToolSchema and passes it through the scheduler to its execution context. Before policy, a started call records only pairing ids, name, and normalized arguments; its settle event preserves the rendered result, optional presentation metadata, and structured error. Metadata is projected from that call’s canonical value and frozen; it changes neither the program value nor model content. Description and parameters remain transient and never enter Session events or SDK output. Calls are scheduled through a per-run pool that reuses the native concurrency contract. Under `ptc` alone, a model-direct call naming a program-only SDK tool resolves to `UNKNOWN_TOOL` before policy — the announced surface and the callable surface stay the same. Intermediate binding values are execution-local; only the outer `run_code` result has a hard size cap.

New sub-calls use `<parent>:ptc:<n>` ids. Consumers treat these ids as opaque and correlate events by exact equality; restored historical ids retain their original bytes. The [PTC mode decision](../../../.agents/notes/implemented/feature/2026-06-15-ptc.md) owns durable naming and restoration rules.

TypeScript bindings for `read_image` and CUA screenshot operations return an `Image` with a readable `path`, `width`, and `height`. Passing it to `inspect` places its durable attachment among the captured text in the `run_code` result. Images nested in arrays and objects are displayed with their containing value. On program failure, inspected output accompanies the original diagnostic; outer result replacements remain authoritative. If an output policy removes a screenshot or read_image image, the binding rejects with ToolCallError and includes the retained text notice. Additional contexts retain their producing tool’s attribution.

When the caller cancels and the runtime reports `abort`, `run_code` waits for cleanup and returns the native tool cancellation result: `AbortError` / `ABORTED`, with `Error: tool call aborted` as its content. Retained runtimes append their cancellation diagnostic, including whether variables were preserved or cleared. The Agent records the specific cancellation cause in `turn/end`, including a hook's reason. Other runtime failures retain `CODE_RUN_FAILED` and their diagnostics, even if the caller also cancels. A runtime rejection keeps a `PtcRuntimeError` code and otherwise becomes `CODE_RUN_FAILED` with the rejection as `cause`. A blank `description`, an invalid `timeoutMs`, or `timeoutMs` or `sandbox_permissions` on a runtime that does not support it fails as `ToolArgsError` with `INVALID_ARGS`; a call after executor disposal fails with `CODE_RUN_UNAVAILABLE`; and a missing runtime, `workingDirectory`, or `sandboxPolicy` fails as `ToolContextUnavailableError`. Cancellation can discard retained runtime state and does not undo completed tool effects.

`run_code` accepts `timeoutMs` when the mounted runtime supports an override; its schema reports the configured default and maximum, and the runtime's usage instructions. The Node default is 120,000 ms with a 600,000 ms cap, including nested tool and approval waits. A wider `sandbox_permissions` mode requires a non-empty `justification` and approval before the program starts. The schema asks the model to write that reason in the current user's language. The grant applies to that complete execution; standing Session policy and nested tools retain their own authority. Programs are never replayed automatically: inspect earlier effects before explicitly retrying a denied program. Retained PTC environments follow the standing file policy. PTC observes committed Session mode changes and immediately cancels affected calls in all Node modes. Later PTC calls wait for their nested-tool cleanup before resolving the latest policy. The runtime owns process invalidation and cleanup; permission setters remain synchronous. One-time escalations omit the state owner and complete in a temporary environment; standing variables remain available to ordinary calls.

Custom host integrations retain their `PtcExecutor` instance and call `reset(agent)` to clear that Agent's environment; reset is not a model tool or SDK binding. It requires a state-retaining runtime, cancels active calls, invokes `release(agent)`, and waits for process and started nested-tool cleanup without requiring the program to respond. Before admitting new programs, it queues `Program environment reset; retained variables cleared. Completed tool effects remain.` The notice is logged when consumed; cancellation or Agent disposal can discard it after state is cleared. Concurrent resets share cleanup. Missing or unsupported runtimes reject without blocking admission. Cleanup or notice-admission failure throws `CodeResetFailedError`; later programs report `CodeRunFailedError` with host-reset guidance until an explicit retry succeeds. Reset does not undo completed tool effects.

- [`src/index.ts`](src/index.ts) — Scoped registration, tool descriptions, batch execution and host environment reset.
- [`src/ptc-calls.ts`](src/ptc-calls.ts) — Call admission and cancellation; reset waits for runtime release and nested-tool cleanup before admitting new calls.

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

PTC mode exposes the generated [`run_code` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-executor-ptc), the SDK instructions below, and the generated exact TypeScript SDK block. The schema lists `code` before `description`; this is presentation order, not an enforced JSON member order. REPL and Script runtimes share the generic tool description and SDK instructions; their `executionInstructions` supply syntax and state rules. The TypeScript SDK declares `inspect(...values)` and uses it in the bash example for every execution mode. The instructions identify generated declarations as program-only bindings. When the current `bash` parameter schema accepts the example arguments, they also show a complete `run_code` call around `tools.bash(...)`. The `tools:sdk` section uses first-party order 5000 and disables prompt-variable interpolation, preserving literal `{{…}}` text in tool descriptions and schemas in TypeScript programs. Under `ptc`, the prompt also carries the `tools:ptc-only` rule earlier in the first-party order, so the model reads which tools it may call before it reads what each one is for. Exhausting the tool-call allowance returns a failed `run_code` result with the limit, rejected call number, termination notice, and possible infinite-loop warning. Runtime cleanup diagnostics and captured output remain visible. TypeScript programs show selected values with `inspect(...values)`. Each argument is rendered independently. The executor omits function returns and final expression values. The Node provider retains the complete native console and captures its stdout and stderr writes; model instructions direct programs to use `inspect`.

##### TypeScript PTC mode SDK instructions with bash

```markdown
## Writing code for run_code

`run_code` takes two required arguments: `code`, the body of an async TypeScript function (erasable syntax only — no `enum` or namespaces; type annotations are advisory, the code runs type-stripped), and `description`, a short summary of what the program does. The declarations below are SDK bindings for this program. A declaration does not make its name a directly callable tool; only names supplied as separate tool schemas may be called directly. When no separate `bash` schema is supplied, invoke a declared `bash` binding inside `run_code`:

`run_code({ code: "inspect(await tools.bash({ description: 'Show current directory', command: 'pwd' }))", description: "Show current directory" })`

Inside the program:

- Call tools as `await tools.name(args)` — quoted access for exotic names: `tools["my-tool"](args)`. Every call resolves to its declared value, which may be an Image. Tool arguments must be lossless JSON.
- A FAILED tool call rejects with `ToolCallError`, whose `toolName` identifies the failed tool and whose `message` is human-readable — `try/catch` it to handle and continue.
- Independent read-only calls MAY overlap under `Promise.all` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with `await`.
- Show selected values and images with `inspect(...values)`; every other intermediate result stays out of the conversation, so extract just what you need.

Program-only SDK bindings:
```

##### Tool-call allowance exhausted

```markdown
Error: code run failed (abort): run_code exceeded its limit of 2048 tool calls (1024 per minute of its timeout); call 2049 was not dispatched. The run_code program may contain an infinite loop. Check loop termination or split the work into smaller run_code calls.
```

#### Token effect

Fixed per-request cost proportional to the visible definitions. PTC mode trades end-tool schemas for generated SDK text plus one transport schema rather than promising a universal reduction. The allowance adds no SDK or schema text; its diagnostic contributes tokens through the failed run's result.

#### KV Cache effect

Prefix-stable while the PTC mode selection, generated SDK, transport schema, and visible tool set are unchanged. Mode or filter changes may invalidate reuse from the first changed prompt or schema token. Changing `maxSubCallsPerMinute` does not change prompt or schema tokens.

### Registered program tools

#### What the model sees

A factory-created tool presents its caller-supplied name and description with the same program parameters, runtime instructions, and result rendering as `run_code`. Its private bindings do not produce direct tool schemas or an SDK prompt section. The consumer owns its binding guidance.

#### Token effect

One program tool schema joins the existing native schemas. The caller's binding guidance adds its own prompt cost; intermediate values remain outside model history unless the program emits them or a nested tool defers context.

#### KV Cache effect

The schema remains stable while the caller's description and runtime settings remain unchanged. Initialization runs inside the runtime and does not add program source to model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These constraints apply to the host integration and accepted calls.

- **Program Images cover read_image and CUA screenshots** — other image-producing tools keep their declared values and automatically attach their pictures as additional model context.
- **Program Images require attachment path mapping** — the filesystem must map stored host attachments to readable program paths. `fs-ssh` has no such mapping, so image adaptation rejects in that composition.
- **No built-in reset control** — the shipped Loader plugin does not expose its executor instance through a service, GUI control or SDK endpoint. Hosts needing reset must mount and retain `PtcExecutor` in their own composition; that integration owns retries after a failed reset.
- **PTC mode uses TypeScript, and presentation is per agent rather than per tool** — PTC execution requires `ctx.ptcRuntime.language === 'typescript'`; within one agent no tool can be native-only while another is ptc-only.
- **PTC mode intermediate values are execution-local and unbounded by bytes** — they cannot be reconstructed from session replay and may exhaust process or worker memory; only the outer `run_code` output has the worker's configurable hard cap.
- **State depends on the runtime**: the default backend starts fresh; Node `persistent-in-memory` execution and Script mode with `scriptPersistence: true` retain memory per live Agent. Agent disposal awaits release. Restart and execution failures can clear memory; model-visible guidance explains how to recreate missing variables. Programs and results remain in the Session log, without serializing live objects.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
