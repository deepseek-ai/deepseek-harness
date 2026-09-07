# Tool authoring reference

English | [中文](adding-a-tool.zh.md)

Reference for the contracts a model-facing tool must satisfy. For an ordered first tool, follow [Build a tool](../user/develop/basic/tool.md). `packages/shell/tool-bash` is the production-grade three-package example.

## The minimal shape

```ts
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'my-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'read_file',
    description: 'Read a file from disk.',          // what the model sees
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path' },
      limit: { type: 'number' },                     // optional by default
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      // args is TYPED from the schema: { path: string; limit?: number }
      // exec carries immutable identity + token; signal is the operational field
      return readFile(args.path, { encoding: 'utf8', signal: exec.signal })
    },
  }))
}
```

Registration is effect-based: disposing the plugin fiber unregisters the tool. Schemas flow into the system-prompt assembly automatically.

## Rules of the execute() contract

- **Args are validated for you.** `defineTool` validates model-generated `arguments` against the unified `ParameterSchemaSpec` before `execute` runs (types, required keys, literal constraints, exact-one unions, and nested values), so inside `execute` the args match `InferArgs`. Explicit object nodes declare `additionalProperties: true | false`; the implicit parameter root stays open. You still hand-check constraints the DSL does not express, such as non-empty strings, positive numbers, or cross-field rules. Raw JSON-Schema tools registered directly own their input validation.
- **Registration borrows your readonly definition.** A typed same-process contribution is not a serialization boundary; do not mutate its schema or replace callbacks after registration. `schemas()` materializes only the explicit model-facing projection. To hot-swap a tool, dispose its owning effect and register the replacement; mutable state inside the callback's closure remains ordinary plugin state.
- **Execution identity is protected.** The registry materializes `arguments` as detached lossless JSON in one recursive pass, freezes that value before policy starts, and assigns an opaque `exec.token`; `callId`, `name`, `arguments`, `agent`, `token`, the required caller-owned `signal`, and an optional enclosing-transport `parent` token stay immutable through dispatch. `parent` is identity-only and exposes no live outer execution. Treat `args` as readonly input. Only an around-dispatch wrapper receives a mutable view, and it may replace and restore the required `exec.signal` to impose a deadline but cannot remove it.
- **Declare and return one canonical JSON value.** `output.schema` uses `ValueSchemaSpec` and may have an object, array, scalar, or null root. `execute` returns only the inferred value; the registry snapshots it as lossless JSON, validates it, freezes it, and passes it to `output.render(args, value)`. Do not return content blocks from the body or make callers parse prose for ids and fields.
- **Throwing or returning an invalid value means `isError`.** The registry catches throws and contains schema, renderer, metadata-projector, and lossless-JSON failures before observers run. Throw for infrastructure failures. Represent a successful domain outcome in the canonical value even when its Native renderer explains a non-ideal state, such as a non-zero process exit.
- **Honor `exec.signal`.** Cancel in-flight work when it fires.
- **Project durable card data with `presentationMeta` (optional).** `output.presentationMeta(args, value)` derives replayable JSON from the same canonical value. The core persists it on `tool/result` and hands it to `presentResult`, so a card that needs result-time facts—such as `write`/`edit` applied hunks—survives replay without persisting the canonical value. The projector is skipped for nested Code dispatches because they have no cards.
- **Use `exec.agent` for async notifications.** `agent.inject({ content, source: { kind: 'plugin', plugin: '<name>' } })` appends durable context the NEXT model request sees — it is not a wake-up (an idle agent stays idle). Guard against disposed agents (try/catch).

## Long-running work

Gate `run_in_background` with producer config, then register through `ctx.jobs.start({ kind, label, owner: exec.agent, run })`. The registry rejects a pre-aborted invocation before the producer body; the runtime validates ownership and task-controller availability before `run()` starts work, then supplies the id, session fence, generic control tools, notices, and owner cleanup. A successful background branch returns a typed canonical handle such as `{ kind: 'background', jobId }`; its Native renderer may keep human prose such as `started background job bash-1`, but PTC mode must never parse that prose to recover the id.

The producer supplies synchronous `cancel`, non-rejecting `done` that settles after resource cleanup, and optional consuming `readOutput` with bounded-output formatting. A pre-aborted call is a failure because no task exists whose id could satisfy the successful output schema. Once `ctx.jobs.start()` publishes the id, use a task-owned cancellation signal rather than `exec.signal`: later outer-call cancellation stops waiting for the call but does not kill published work; `job_kill`, owner disposal, and service teardown own that lifetime. Foreground work remains coupled to `exec.signal`. See the [background job runtime Agent Note](../../.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.md) and `dsh-tool-bash` for a stream producer.

## Execution policy and observation

Prefer not to build deployment policy into the tool. Use `tools/pre-execute` for extensible allow/deny/ask policy (the [permission-gate example](extension-cookbook.md#a-hook-plugin-permission-gate-example)), `ctx.tools.guard()` for a final monotonic deny that later listeners cannot undo, `tools/execute` to wrap dispatch with a deadline, retry, or metrics collection, `tools/post-execute` to replace presentation content or the returned value, block the result, or attach model-facing context, and `tools/result` to observe the immutable normalized outcome. A content replacement leaves programmatic access to `value` intact; confidentiality policy blocks or replaces the value. A sandboxing implementation can also run inside the tool's executor implementation; the [`dsh-tools` README](../../packages/core/tools/README.md#extension-points) defines each extension point's inputs, order, return values, and failure behavior.

## PTC mode reaches your tool for free

In [PTC mode](../../packages/core/tools/README.md), every visible registered tool is available as `await tools.<name>(args)` without extra integration. The generated `ToolArgsMap` and `ToolOutputMap` derive exact argument and canonical-return types from the same schemas, and calls re-enter the normal execution pipeline. A successful call resolves to the final canonical JSON value after policy, not to rendered Native content. A failed call rejects with the real `ToolCallError`; programs can inspect only its `name`, `toolName`, and human-readable `message`, not internal error codes or a failure union.

Design `output.schema` as a useful programmatic API: return handles and fields directly, allow scalar/array/null roots when they are the honest value, and keep human explanation in `output.render`. Intermediate values are execution-local, are not persisted or prompt-truncated, and have no byte cap, so the producer's truthful acquisition bounds and process memory still matter. Only the outer `run_code` logs/result cross the configurable output cap and model-facing spill pipeline.

## How your tool renders in a UI

Your tool's `output.render` returns model-facing content; its **UI card** is a separate concern declared through pure presentation projections and optional `presentCall` / `presentResult` methods. Design these alongside the canonical value. A tool with no UI presentation falls back to a generic card (title = tool name, raw args as input).

Both methods return a **`card`-tagged render intent** — pick the card kind that matches what your tool does:

- `presentCall(args)` → a `ToolCallView` (the PENDING card):
  - `{ card: 'generic', title, kind?, rawInput?, content?, locations? }` — the default. Set `kind` for an icon (`read`/`search`/…); set `locations: [{ path, line? }]` for any file your tool touches so a capable editor follows along / jumps to it.
  - `{ card: 'terminal', title, description?, cwd? }` — your call IS a shell command. `title` is the command, `description` renders above the terminal card. (tool-bash.)
  - `{ card: 'diff', title, diffs, locations? }` — your call creates or modifies a file. `diffs: [{ path, oldText, newText }]` (`oldText: null` for a new file) renders as an inline diff card. (tool-fs `write`/`edit`.)
- `presentResult(args, { content, isError, meta? })` returns the completed card:
  - `generic` supplies an optional title and content.
  - `terminal` supplies raw output and optional exit metadata; each UI renders its capable or fallback view.
  - `diff` supplies applied hunks, often derived by `output.presentationMeta` and carried in persisted `result.meta` so replay reproduces them. Mutation tools keep a diff result because the completed view replaces the pending card.
  - `read` supplies a completed file window reconstructed from persisted `result.meta`: the file `path`, a 1-based `offset`, the returned `lines` (each keeping its file line number), `totalLines`, and an optional `lang` highlight hint; a UI without the `read` capability falls back to the raw result content. There is no `read` call view — a read call's pending state stays a generic card, since content exists only after `execute`. (tool-fs `read`.)
  - `search` supplies a discovery result reconstructed from persisted `result.meta`: grouped-by-file matches (`shape: 'matches'`, grep) or a flat path list (`shape: 'paths'`, glob), plus `truncated`/`total` so a UI never presents a capped result as complete. The view carries no result text (a UI without a search card falls back to the raw result content), and there is no `search` call view — a discovery call's pending state stays a generic card, since matches exist only after `execute`. (tool-fs-search `grep`/`glob`.)
  - `web` supplies a completed web retrieval, discriminated by `kind: 'search' | 'fetch'` (the structured search sources or the fetch summary), derived from `result.meta`; it carries no body copy, so a UI without the `web` capability falls back to the raw result content. (tool-web `web_search`/`web_fetch`.)

Hard rules (they bite if broken):

- **Purity.** These run on live streaming AND on session-log REPLAY, so they must be pure functions of `args` (+ the result) — NO I/O, NO reading session state, NO clock/random. A diff is derived from the args (`write` uses `oldText: null` because a call-time presenter has no prior file content); the UI adapter, not the tool, supplies session context. If you find yourself wanting the file's old content or the working directory inside `presentCall`, stop — that belongs in durable result metadata or the adapter, not the presenter.
- **UI-only formatting stays out of the model result.** A fenced ` ```console ` block, a diff, a relativized path—none of these belongs in the canonical value or Native content merely to serve a UI. `output.render` owns model-facing prose; `presentationMeta` plus the card presenters own replayable UI state. A `terminal` result view carries raw output and the adapter adds any fallback framing.
- **`defineTool` soft-validates the display path.** Malformed or older logged arguments make the wrapper return `undefined` (a generic fallback) rather than throw — display must never crash a replay.

The neutral vocabulary lives in `dsh-tools`; tools never import a UI or transport type. Consumers of this API map each `card` into their own view. The design and the why are in [the render-intent-union Agent Note](../../.agents/notes/implemented/architecture/2026-07-02-tool-render-intent-union.md); `dsh-tool-fs` (generic/diff) and `dsh-tool-bash` (terminal) are the reference implementations.

## Web Client presentation

The built-in Web Client does not consume `presentCall` or `presentResult`. Session `page` and `follow` transport raw `tool/call` and `tool/result` events, including persisted `result.meta`. A Client plugin registers its wire tool name in the `tool.call.toolview` keyed slot and derives component props from the `ToolCallBlock` arguments, content, error, metadata, existing Code Dispatch `parentCallId`, and Session path facts. It validates these wire values locally and returns the generic row for malformed or unsupported input.

Use `output.presentationMeta(args, value)` when an existing Web card needs bounded structured result facts that model-facing content cannot preserve losslessly. Do not store React props or a selected card in metadata, import a Host tool implementation into a browser bundle, or create another Client presenter registry. Defining Host presentation methods alone does not add a specialized Web card. The [Client-derived presentation Agent Note](../../.agents/notes/implemented/architecture/2026-08-23-client-derived-tool-presentation.md) defines ownership, fallback, and equivalence requirements.

## Verification

Follow the [repository testing policy](../testing.md) and the owning package's test documentation. A shipped model- or UI-visible change requires the assembled coverage specified there.
