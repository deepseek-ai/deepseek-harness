# Cookbook: extension plugin shapes

English | [中文](extension-cookbook.zh.md)

Reference patterns for harness extensions. The snippets omit imports and helper implementations and are not copy-paste-complete. For concrete authoring paths, see the [package checklist](adding-a-package.md), [first-tool tutorial](../user/develop/basic/tool.md), [tool reference](adding-a-tool.md), and [LLM adapter guide](adding-an-llm-adapter.md); the [architecture](../architecture.md) owns the system and extension-point map.

## A tool plugin

A tool registers on `ctx.tools`. The annotated `defineTool` example (typed `execute` arguments, result construction, the `run_in_background` pattern) lives in [adding-a-tool.md](adding-a-tool.md) — that guide is the source of truth for tool definitions. Raw JSON-Schema `ToolDefinition`s are also accepted by `ctx.tools.register()` directly (that is how MCP-sourced tools arrive); `defineTool` is the typed helper for first-party tools.

## A hook plugin (permission-gate example)

This permission gate is one example of a hook plugin. It returns a typed decision from the `tools/pre-execute` gate to allow or deny a call; sandbox, permission, and plan-mode plugins can use this extension point. Hook plugins can intercept other extension points and are not inherently permission gates. A "native hook" is an ordinary Cordis plugin on an interception point; it needs no external protocol.

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

declare function isAllowed(exec: ToolExecution): Promise<boolean>

export const name = 'permission-gate'

export function apply(ctx: Context) {
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (!(await isAllowed(exec))) {
      return { kind: 'deny', reason: 'Denied by policy.' }
    }
    return next()
  })
}
```

This waterfall is the reorderable policy layer. Use `ctx.tools.guard()` when an invariant needs a monotonic final denial, `tools/execute` when a plugin must wrap the dispatch lifetime (timeouts/retries/metrics; only `exec.signal` is replaceable), `tools/post-execute` for explicit result transformation, and `tools/result` for contained observation of the immutable final outcome. The [adding-a-tool guide](adding-a-tool.md#execution-policy-and-observation) gives the selection rule.

## A UI plugin

A UI plugin combines durable `session/event` records (Assistant settlements, turn/step boundaries, and tool activity) with transient `agent/assistant-stream` frames for live token presentation, and drives input back in via `agent.followup()` / `agent.steer()`. A browser plugin contributing a business row to the built-in Web Client instead registers a `ConversationNodeDefinition` and keyed Chat renderer; follow the [Conversation subsystem reference](../subsystems/conversation.md).

```ts
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

declare function render(text: string): void
declare function onUserInput(handler: (text: string) => void): void

export const name = 'my-ui'
export const inject = ['agents']

export function apply(ctx: Context) {
  ctx.on('agent/assistant-stream', ({ frame }) => {
    if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') {
      render(frame.chunk.text)
    }
  })
  onUserInput(text => ctx.agents.get(brandString<SessionId>('client-session'))?.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })))
}
```

## An external protocol driver

A *protocol driver* adapts a wire peer to `ctx.agents`; it may serve a UI or an automation client. A stdio driver owns stdout, creates or resumes agents through the factory, and maps protocol requests to `followup()` or `cancel()`. A low-level prompt request returns its durable enqueue receipt; it does not acquire a result by correlating `MessageId` with `turn/end`. Publish whole-agent status separately. An automation method may wait from its receipt through the next idle and summarize that explicitly owned interval, while a UI normally keeps observing the open-ended event stream. Tear agents down with `AgentHandle.dispose()` so disposal reaches quiescence.

[`packages/acp/acp`](../../packages/acp/acp) is the automation-only worked example: it exposes fresh text sessions over Agent Client Protocol JSON-RPC stdio, emits committed assistant text, and registers a one-shot machine permission answerer for agents it owns. Its [README](../../packages/acp/acp/README.md) defines the exact methods, event order, and lifecycle contract.

```ts
import type { Context } from '@deepseek-ai/cordis'
import { expandAssistantStream } from '@deepseek-ai/dsh-llm'

export const name = 'my-protocol-bridge'
export const inject = ['agents', 'sessions', 'sessionPersistence']

export function apply(ctx: Context) {
  // Publish every committed Assistant text delta to the client.
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      for (const { chunk } of expandAssistantStream(event.data.stream)) {
        if (chunk.type === 'text-delta') {
          // sendToClient({ kind: 'message_chunk', text: chunk.text })
        }
      }
    }
  })
  // Inbound "prompt": create/resume an agent, feed it, and return its enqueue receipt.
  // Whole-agent status is a separate notification; no turn end belongs to this prompt.
  // Teardown reaches quiescence via AgentHandle.dispose() (stop + await exit).
}
```

## Runnable wirings

Shipped applications contribute profile layers through `packages/bundle/*/cordis.patch.yml`, and the product `dsh` launcher owns Web, ACP, SDK, and one-shot headless execution through named profiles. Optional user-facing overlays live under `apps/cli/config/examples/`; profile integration tests live under `apps/cli/tests/profiles/`, while package-specific Loader compositions stay with their package tests.

## The feature → mechanism map

Every product feature maps to a listener on a documented extension point — the microkernel claim made checkable ([microkernel Agent Note](../../.agents/notes/implemented/architecture/2026-06-11-microkernel-event-taxonomy.md)). No row modifies the loop.

`system-prompt/assemble` is an expert cooperative whole-assembly transform: its returned assembly is authoritative, so listener authors own preserving active PTC mode and structured-output protocol contributions. Prefer `ctx.tools.restrict()` for tool filtering that must stay aligned across presentation, lookup, and execution.

| Product feature | Plugin mechanism |
|---|---|
| Hook system (user + project level) | listeners on `agent/session-start`, `agent/pre-step`, `agent/request`, `tools/pre-execute`, `tools/post-execute`, and `agent/turn-stopping`; the waterfalls return typed decisions, while `agent/turn-stopping` may steer another step; the `dsh-hooks-claude-code` / `dsh-hooks-codex` bridges map hook config files onto these extension points |
| `/goal` | `ctx.goals` owns durable state, `dsh-goal-round-driver` schedules same-session rounds through the public `Agent`, and separate command/tool producers expose human/model control |
| `/loop` | on the `turn/end` session event, `followup()` the next iteration; or force-continue |
| Dynamic workflow | `ctx.workflowEngine` + the worker-thread engine + the `workflow` tool; structured in-process children enforce output with scoped prompt/tool registrations, a monotonic tool guard, final `tools/result` commit (including enclosing `run_code`), and the structured-output execution's monotonic `concludeTurn()` marker |
| Queued + steering messages | core `Agent.followup()` / `Agent.steer()` |
| Context compaction (auto + manual) | the `ctx.compaction` seam + `dsh-compaction-basic`; automatic pressure runs on serial `agent/pre-step`, canonical overflow recovery runs on `agent/request-error`, and manual callers use the same compact service ([compaction Agent Note](../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md)) |
| System prompt configurability | `ctx.systemPrompt.section()` with ordering and scope-local shadowing |
| AGENTS.md (root) | a section provider reading the file |
| AGENTS.md (subdir, on-touch) + file-change notices | `agent.inject()` from a watcher / tool-result listener |
| Built-in tools | `ctx.tools.register()`; schemas flow into the assembly automatically — the `dsh-tool-*` families (bash, fs, web, subagent, todo) are the shipped examples |
| ToolSearch / progressive disclosure | replace a scoped `ctx.tools.restrict()` registration as the visible set changes; the registry keeps presentation, lookup, and execution aligned |
| Tool deadline / retry / metrics | wrap core dispatch with `tools/execute`; a wrapper may replace `exec.signal`, delegate, and inspect the normalized result in one lexical lifetime |
| Final tool-result metrics / audit / capture | observe immutable authoritative outcomes with `tools/result`; use `tools/post-execute` instead only when the plugin must transform the result or attach context |
| Monotonic terminal turn policy | call `ToolExecution.concludeTurn()` from the successful terminal tool; later tool calls in the same response remain guardable, and the loop stops after the step |
| Subprocess sandbox (landlock / sandbox-exec) | use a `ctx.sandbox` backend through `dsh-bash-sandbox`; use `tools/pre-execute` for capability-level denial |
| Permission system / AskUserQuestion | return `ask` from `tools/pre-execute` and answer through `ctx.approval`; register a separate model-facing ask tool for ordinary user questions |
| Plan mode | [`@deepseek-ai/dsh-plan-mode`](../../packages/plan/plan-mode/README.md) — logged `plan/mode` state, the `plan:policy` guidance section, `/plan [message]` entry, `/plan off` direct exit, and the user-reviewed `exit_plan_mode` exit; enforcement stays on the independent sandbox/approval axes |
| Sub-agent delegation | the `ctx.subagents` provider registry (`dsh-subagent-spawn-in-process`/`dsh-subagent-fork-in-process`/`dsh-subagent-acp`/`dsh-subagent-codex`/`dsh-subagent-claude-code`/`dsh-subagent-dsh-sdk`) + `dsh-tool-subagent` exposing one configured provider to the model |
| MCP | one plugin per server: discover tools → `ctx.tools.register()` |
| Skills | section + tool registration; `inject()` skill content on invocation |
| Memory | section provider + tool |
| Scheduled tasks (cron) | a plugin registers model-callable scheduling tools; timer fires → `followup(…, {source: {kind: 'plugin', plugin: 'schedule'}})` when idle / `inject()` notification when busy |
| UI (GUI; CLI emits JSONL) | listen to `agent/assistant-stream` for live chunks and `session/event` for durable settlements, boundaries, and tool activity; input → `followup()` |
| Web Client Chat business node | register a `ConversationNodeDefinition` and `conversation.chat.node` keyed renderer |
| SessionTelemetryBackend / replayable trace | `session/event` → JSONL; replay = `sessions.create(id, { seed })` |
| Model adapters | `LlmAdapter` subclass via `registerAdapter` (`dsh-llm-deepseek`, `dsh-llm-pi-ai`) |
| Plugin hot-reload | every registration is a `ctx.effect` → vendored HMR just works |
