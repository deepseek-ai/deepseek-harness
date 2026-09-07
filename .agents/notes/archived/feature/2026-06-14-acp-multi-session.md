# Agent Note: Multiplex concurrent ACP sessions over one connection

Status: implemented
Archived: 2026-09-04

English | [中文](2026-06-14-acp-multi-session.zh.md)

> Written when ACP was an editor bridge, motivated by Zed's multi-session client model. [ACP as an automation-only protocol](../simplification/2026-07-23-acp-automation-only-protocol.md) removed the editor surfaces; the multiplexing decision itself is unchanged and this note now states it against the automation contract.

## Problem

An ACP automation client can keep several conversations alive over one agent subprocess. A single-active-session bridge would force extra processes and prevent one parent controller from driving independent children over one connection. Multiplexing introduces isolation risks: committed answers, prompt completion, cancellation, permission requests, and predictable background-job ids must never cross session boundaries.

## Decision

The ACP bridge stores live sessions in `Map<SessionId, AcpSession>`. Agent-scoped callbacks use `ownedRecord`: look up `agent.session.id` in that forward map and accept the module only when it owns the exact agent object, so a foreign same-id object cannot claim the session. The module owns its Agent handle, MCP mounts, model selection, ordered updates, memoized close, and optional in-flight prompt with the durable turn number that eventually settles it. The session header owns its cwd; the bridge keeps no parallel workspace or client-capability state.

Every `session/event` callback resolves the owning record before sending or settling anything. Each session permits one in-flight prompt independently. The prompt captures its own user-sourced message `turn/start` and settles only on the matching `turn/end`; injection turns, autonomous plugin or goal turns, and a late end from a cancelled prior turn cannot resolve it. `session/cancel` addresses one record and calls only that agent's queue-aware cancel path.

Permission ownership uses the same exact-agent check against the forward map. The ACP `approval/request` answerer sends a one-shot machine-policy request only for the session that owns the requesting agent and delegates foreign or call-less requests. The bridge has no elicitation, config-selection, or other human-interaction state.

Background bash tasks carry an opaque owner token equal to the owning session id. `job_output` and `job_kill` compare the caller's token with the executor's job ownership before reading or killing; a predictable job id alone grants no access. Ownership is stored with the executor task, so a tool plugin reload does not erase it.

Per-session close, connection teardown, and plugin disposal share each `AcpSession`'s memoized close. The bridge retains the live map while events and updates drain, settles each pending prompt as cancelled, drains continuable descendants, flushes the session while attached, and disposes Agent scopes in parallel. Exact records leave the map only after their close operation settles.

## Protocol and workspace scope

[ACP v1 expressly permits several concurrent sessions on one connection](https://github.com/agentclientprotocol/agent-client-protocol/blob/01beb5fb5eec60e9f516a80d85eb03594bac61e3/docs/get-started/architecture.mdx#L16-L24), and each new session carries its own primary `cwd`. This bridge implements that session-level multiplexing, including different primary workspaces as recorded by the [per-session cwd decision](../architecture/2026-07-02-fs-per-session-cwd.md); it does not create one agent subprocess per session.

A multi-root project inside one session is a separate optional capability: ACP defines the [effective roots as the primary `cwd` plus `additionalDirectories`](https://github.com/agentclientprotocol/agent-client-protocol/blob/01beb5fb5eec60e9f516a80d85eb03594bac61e3/docs/protocol/v1/session-setup.mdx#L313-L367). The automation bridge advertises no multi-root capability and rejects non-empty `additionalDirectories`; each session has exactly one workspace, as recorded in the [package contract](../../../../packages/acp/acp/README.md#standard-acp-v1-surface).

[The standard transport is one agent subprocess per stdio connection](https://github.com/agentclientprotocol/agent-client-protocol/blob/01beb5fb5eec60e9f516a80d85eb03594bac61e3/docs/protocol/v1/transports.mdx#L17-L42); multiple connections therefore require multiple subprocesses or a custom transport, while this decision guarantees multiple sessions within one connection. Within that connection, `ctx.sandboxPolicy` resolves every session's `cwd` as its own `workspace-write` root, so the shared bash and filesystem services can serve concurrent projects without granting cross-project writes. This does not add ACP `additionalDirectories`; it removes the process-wide root limit from the already-supported one-primary-root-per-session path.

## Alternatives considered

**One live session per connection** — rejected. It adds process overhead and prevents a programmatic parent from multiplexing independently cancellable work.

**A per-session `ctx.extend()`** — rejected. A child context does not by itself create a child plugin fiber, so listeners would still belong to the bridge fiber. The implemented bridge instead uses global listeners with explicit O(1) demultiplexing and per-session owned records; agent lifecycle is owned by `AgentHandle`.

**Agent object identity as bash-job ownership** — rejected. A resumed or replaced agent object may legitimately represent the same durable session. The opaque session token is the cross-boundary identity that should survive plugin reloads.

## Consequences

N sessions can return committed answers, prompt, request permission, and run background jobs concurrently without interleaving or cross-settling. A cancel in one session does not affect its neighbors. The bridge pays for explicit maps and isolation tests, but it does not add one listener set per session and therefore avoids listener fan-out during long-lived connections.

Standard `session/close` independently quiesces one live session and leaves its durable state resumable. `session/list` omits active records, and `session/resume` rejects an id that is still live, so an automation client cannot create two Agent objects for one durable session.

## Verification

The multi-session suite drives concurrent sessions through routed committed answers, independent in-flight prompts, targeted cancellation, and shared teardown; the approval and output-boundary suites cover permission routing and exact-agent rejection. Tool-bash tests prove one session cannot read or kill another session's background job.
