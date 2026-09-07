# Agent Note: Subagent capability seam

Status: implemented

English | [中文](2026-06-21-subagent-capability-seam.zh.md)

> The full seam is shipped: the `dsh-subagent` interface and `dsh-tool-subagent` consumer; the two in-process backends (`dsh-subagent-spawn-in-process`, `dsh-subagent-fork-in-process`); the nested-agent snapshot infrastructure ([per-session snapshot replay](../../archived/testing/2026-06-22-subagent-snapshot-replay.md)); and the out-of-process ACP, Codex, and Claude Code backends ([ACP Agent Note](../../archived/feature/2026-06-22-acp-subagent-backend.md), [product-provider Agent Note](2026-08-04-claude-code-and-codex-subagent-backends.md)).

## Problem

The harness has a long-deferred seam for **subagents** — an agent delegating work to another agent. The intent was sketched in the `Agent`/`AgentLoop` interfaces ([packages/core/agent/src/types.ts](../../../../packages/core/agent/src/types.ts), [packages/core/agent-loop/src/index.ts](../../../../packages/core/agent-loop/src/index.ts)): a creation option referencing a parent agent (fork = seed the child session with the parent's event log; spawn = fresh session), with the child returned as an `Agent` handle so steering and event subscription work uniformly.

**Multiple subagent implementations must coexist at runtime.** A parent may want a cheap in-process child for a scoped subtask AND an isolated out-of-process child (over ACP) in the same session. The transports:

- **in-process** — a child concrete `Agent` on the same `Context` (the cheapest, and nearly free given the existing agent factory);
- **ACP** — act as an ACP *client* driving another agent process (which can be another instance of ourselves);
- **Codex app-server and Claude Code Agent SDK** — current one-shot siblings that apply the same named-provider contract to official product processes ([product-provider Agent Note](2026-08-04-claude-code-and-codex-subagent-backends.md));
- later: **A2A** using the same out-of-process "start a child, prompt it, settle, cancel" shape.

## Alternatives considered

### Why not the bash seam shape

The bash seam ([capability seams](../architecture/2026-06-13-capability-seams.md)) registers exactly one `ShellExecutor` per context; loading a second throws. That is correct for bash (one machine, one way to run a command) but wrong here: coexistence is the requirement. So the subagent service is a **named-provider registry** — each implementation registers under a unique name and a caller picks one by name — mirroring the **LLM adapter registry** (`LlmRuntime.registerAdapter`), not the single-service bash executor. The seam is still three-package (Service Definition / Service Provider / Consumer); only the "one vs. many implementations" axis differs.

## Decision

### The three-package boundary

A new package group `packages/subagent/`:

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-subagent` | interface: `SubagentRuntime` (`ctx.subagents`), `SubagentProvider`, `SubagentRun`, the request/result/capability vocabulary, the `subagent/*` events |
| `@deepseek-ai/dsh-subagent-spawn-in-process` | implementation: a fresh in-process child via `ctx.agents.create` |
| `@deepseek-ai/dsh-subagent-fork-in-process` | implementation: an in-process child seeded with a snapshot of the parent's log |
| `@deepseek-ai/dsh-subagent-acp` | implementation: an ACP client driving a configured child process |
| `@deepseek-ai/dsh-subagent-codex` | implementation: a one-shot official Codex app-server process |
| `@deepseek-ai/dsh-subagent-claude-code` | implementation: a one-shot official Claude Code process through the Agent SDK |
| `@deepseek-ai/dsh-tool-subagent` | consumer: the model-facing `subagent` tool over `ctx.subagents` |

### The primitive: async `start → SubagentRun`

A provider exposes `start(request) → Promise<SubagentRun>`. Fulfillment publishes a child and transfers its run handle to the caller. Work that fails before publication rejects `start()`, while prompt, turn, cancellation, and infrastructure outcomes after publication settle through `run.result` without hiding the child id. One signal covers cancellation before and after publication; `dispose()` cancels remaining work and awaits quiescence. A rejected start cleans unpublished resources and emits no lifecycle event, while a post-publication result failure closes the published lifecycle pair. `start` is transport-neutral; `spawn` names only the fresh in-process backend.

### Two kinds of optional capability, discovered two ways

- **Start-time features** (`agentOptions`, `outputSchema`, `depthLimit`, `toolFilter`, `persona`) ride on a static `provider.capabilities` descriptor. The service checks every requested one BEFORE delegating and **rejects loud** (`SubagentError('UNSUPPORTED_CAPABILITY')`) if the provider lacks it — never accepted-then-ignored. They must be checked before a run exists, which is why they cannot be runtime methods.
- **Continuable creation** is the optional `SubagentProvider.prepareContinuable` method; presence is the capability and TypeScript narrowing is the discovery mechanism, so no separate flag can drift from the implementation. The continuation manager owns later delivery and cold resume directly through `AgentHandle`, while one-shot `SubagentRun` has no steering or resume operation, as refined by [continuable subagents](2026-07-28-continuable-subagent-conversations.md).

### Fork vs. fresh are separate backends, not a flag

Fresh and forked children are separate providers, not a request flag. `dsh-subagent-spawn-in-process` starts an isolated child; `dsh-subagent-fork-in-process` seeds a balanced prefix containing only completed parent turns. The in-flight turn is excluded because its subagent call has no result yet and cannot form valid replay history.

### Child isolation and the parent log

Each in-process subagent runs in its **own `Session`** (own id, `parentSession` lineage), persisted independently. Remote ACP and one-shot product providers instead mint a parent-scoped lifecycle id and expose no local `Agent` or child `Session`; their internal state remains in the remote process. Across both forms, the parent's log records only the spawn `tool/call` and its `tool/result` (the child's final output, or a failed result with optional provider diagnostic), while child steps and tool calls remain outside the parent log.

### Synchronous collect (first cut)

`dsh-tool-subagent` passes its execution signal to `start()`, awaits the child result, and disposes the run before reporting. Non-completed outcomes become error results rather than successful partial output; they present the optional safe diagnostic owned by the [non-interactive permissions decision](2026-08-15-product-subagent-noninteractive-permissions.md) separately from partial assistant text. Independent result and disposal rejections remain independently observable.

### Transport provider selection is config, not model-facing

`dsh-tool-subagent` binds to exactly one subagent transport provider name (`Config.provider`). To expose more than one transport, load the tool plugin more than once, each bound to a different provider and a distinct `toolName` (the tool registry rejects a duplicate name). The *service* holds the multi-provider registry; the *tool* picks one — its schema carries no subagent transport/type parameter. A later opt-in adds child LLM provider/model fields without changing this transport decision; see [model-selected subagent routes](2026-08-18-model-selected-subagent-routes.md).

## Testing

Registry and tool tests replace only the nondeterministic child with a package-local scripted provider while exercising the real `SubagentRuntime`, lifecycle, task integration, and model-facing tool. Loader regression tests still cover the provider and consumer exports for the failure described in [postmortem 0001](../../../../docs/postmortem/0001-acp-default-export-drops-inject.md). Registry tests cover reload safety, duplicate names, and start-time capability rejection; nested-agent scenarios replay keylessly through [per-session snapshot replay](../../archived/testing/2026-06-22-subagent-snapshot-replay.md); in-process backends also have real-loop unit tests and a with-key e2e.

## Consequences

- **Recursion.** Without a bound, an in-process child can see the delegation tool and recurse. The in-process backends implement the optional absolute depth limit and scoped live-global `toolFilter`; ACP advertises both capabilities off and rejects such a request. The [subagent composition-controls Agent Note](2026-07-12-subagent-persona-tool-filter-and-depth.md) owns their exact semantics and security limits.
- **Blocking the parent turn.** Foreground collection holds the parent's step open for the child's full duration. Background delegation uses the shared `ctx.jobs` runtime and generic `job_*` tools, the same collection mechanism as background bash; the subagent seam itself remains task-agnostic.
- **Live progress.** Only lifecycle + the final result surface; a per-chunk child→parent update stream is deferred with the background redesign.
- **ACP client surface.** Proxying `fs`/`terminal` from the ACP child back to the parent (a shared-workspace mode) is future work; the backend advertises neither capability, so the child self-serves in its own process.
