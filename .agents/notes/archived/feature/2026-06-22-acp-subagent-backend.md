# Agent Note: ACP subagent backend (out-of-process delegation)

Status: implemented
Archived: 2026-09-04

English | [中文](2026-06-22-acp-subagent-backend.zh.md)

## Problem

The subagent seam ([the seam Agent Note](2026-06-21-subagent-capability-seam.md)) was built so multiple backends coexist by name on `ctx.subagents`. The in-process backends (`-spawn`/`-fork`) run a child as a second `Agent` on the SAME cordis context — cheap, but the child shares the parent's process, model client, and tools. The seam's whole point was to also support an OUT-OF-PROCESS child reached over a protocol, proving the abstraction generalizes across a process boundary. This Agent Note adds the first such backend: an Agent Client Protocol (ACP) client.

## Decision

`@deepseek-ai/dsh-subagent-acp` registers a `SubagentProvider` that runs each child agent in a SPAWNED SUBPROCESS, driven over ACP as the *client*. It is the direction-inverted twin of the existing server-side bridge `@deepseek-ai/dsh-acp` (the ACP *agent*): the bridge ANSWERS `initialize`/`newSession`/`prompt`; this backend CALLS them and IMPLEMENTS the `Client` callbacks (`sessionUpdate`, `requestPermission`). Pointing the configured spawn command at the `acp-agent` example makes the harness talk to its own process.

### Fresh process per run

Each `start` spawns a new child, runs exactly one ACP session (`initialize` → `newSession` → `prompt`), and `dispose` kills the subprocess and awaits its exit. This is the simplest lifecycle and mirrors the in-process one-child-per-run shape.

### Minimal client stub

The client advertises NO optional capabilities (no `fs`, no `terminal`): the child self-serves file/terminal access in its own process. `session/update` notifications are consumed — the backend accumulates `agent_message_chunk` text as the result output and ignores the rest (thoughts, tool-call cards), so only the child's final answer surfaces. `session/request_permission` is auto-answered by a configured policy (`reject` declines every prompt, `allow` approves via the first allow-shaped option) — no prompt is surfaced to a human. Proxying `fs`/`terminal` back to the parent (a shared-workspace mode) remains future work, as the seam Agent Note noted.

### No start-time capabilities

The provider's `capabilities` are all `false`. An out-of-process child cannot honor the parent's `maxDepth` (it has no access to `parent.options.subagentDepth`) or `toolFilter` (it owns its own tool registry), and the first cut does not implement `outputSchema`. The service rejects a request needing any of them before `start` runs. The backend injects only `subagents` (not `ctx.agents`); the ONE thing it reads off `request.parent` is the session header's cwd (see the workspace resolution below) — no conversation context, depth, or tool state crosses the process boundary.

### Workspace cwd resolution

The child's working directory is an explicit resolution, never the harness process cwd: the deployment `cwd` override when configured (made absolute against the launch directory and validated at load), else the parent session header's cwd (validated at start), and a loud rejection before anything spawns when neither exists. One ACP server process serves sessions from many workspaces, so `process.cwd()` cannot stand in for a session's workspace — the old implicit fallback ran children in the server's launch directory. A candidate must be an absolute path naming a directory the harness can ENTER (`X_OK` — `statSync().isDirectory()` alone accepts a mode-600 directory that spawn would fail with EACCES), and the same resolved path becomes both the subprocess cwd and the ACP `session/new` workspace.

### StopReason mapping

ACP `StopReason` → harness `SubagentStopReason`: `end_turn`→`completed`, `max_tokens`→`max-tokens`, `refusal`→`refusal`, `cancelled`→`aborted`, `max_turn_requests`→`error` (no clean equivalent — the task did not finish), unknown→`error`. Spawn, initialize, and session-creation failures reject `start()` before publication after provider-owned cleanup; prompt/RPC/transport failures after publication settle `result` as `error` (or `aborted` after local cancellation), and `result` never rejects on a child-level failure. Non-completed and lifecycle failures add only the bounded provider stage, coarse category, closed permission decision, and observed process facts defined by the [out-of-process diagnostics decision](2026-08-21-out-of-process-subagent-minimal-diagnostics.md); raw ACP errors and stderr remain Host-only.

### Security: scrubbed child environment

The child is a separate process, so it inherits an environment. Credential-shaped ambient vars (`/KEY|PASSWORD|SECRET|TOKEN/i`) are NOT forwarded by default — the parent harness's own secrets must not leak into a spawned process implicitly (the same policy the bash executor applies). The child's OWN credentials (it needs a model key) are supplied EXPLICITLY via `config.env`, layered AFTER the scrub, so an intended `DEEPSEEK_API_KEY` survives while an incidental `AWS_SECRET_ACCESS_KEY` does not. Child stderr is inherited to the parent's stderr (diagnostics surface naturally); a spawn-level `error` event (e.g. ENOENT for a bad command) is captured and raced against the ACP drive, so a bad command settles `error` instead of crashing the parent with an unhandled error.

## Testing

- **Keyless unit/integration:** A scripted ACP subprocess exercises real stdio for prompt/output flow, every stop-reason mapping, signal and disposal cancellation (including pre-abort, pre-session race, and torn-pipe cases), both permission policies, ignored non-message updates, missing-command cleanup, provider reload, and namespace exports.
- **Keyless Loader composition:** A test-only cordis.yml boots the stdio app through the real Loader with the backend's `cwd` omitted; a scripted model delegates once and the scripted child proves it ran in — and was announced — the parent session's workspace (the cwd-inheritance branch end to end).
- **With-key e2e:** The backend spawns the real ACP example; its model answers `PONG`, writes `proof.txt`, and the parent verifies the file.
- **Keyless snapshot:** The ACP example boots the real provider and scripted child through Loader-backed replay, pinning foreground and one-shot background diagnostics while keeping the child process, permission decision, partial output, and cleanup lifecycle deterministic.
- **Snapshot gap:** Each ACP child still has its own replay session; `TODO(acp-subagent-replay)` continues to track parent replay against a replaying child harness rather than the scripted protocol child used by the diagnostic scenario.

## Alternatives considered

### Why stay on SDK 0.25.1?

The backend needs only `ClientSideConnection`, `ndJsonStream`, `PROTOCOL_VERSION`, and the client protocol types, all supported in 0.25.1. The 0.28 fluent API would require migrating both client and server connection classes across the ACP layer without improving this backend, so that upgrade remains a separate change.

### Why not a persistent child process?

Persistent-process pooling (reuse a warm child across runs) is a performance optimization deferred to future work — it adds session-lifecycle and crash-recovery complexity the first cut does not need; each `start` spawning a fresh child mirrors the in-process one-child-per-run shape.

## Consequences

Every run pays a fresh subprocess (spawn + `initialize` + `newSession`). The parent surfaces only the child's final answer: `session/update` thoughts and tool-call cards are consumed and dropped, and permission prompts never reach a human — the configured policy answers them. The child's environment is credential-scrubbed by default, so its own model key is supplied explicitly via `config.env`.

## Product-provider siblings

The [Codex app-server and Claude Code Agent SDK providers](2026-08-04-claude-code-and-codex-subagent-backends.md) apply the same out-of-process spawn/prompt/settle/cancel boundary as siblings registered by name. A2A remains a future sibling transport; the ACP backend proves that the subagent seam supports this boundary without owning product-private protocols.
