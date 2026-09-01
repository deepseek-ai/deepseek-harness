---
description: "Automation-only Agent Client Protocol server for programmatic clients and maintainers driving DeepSeek Harness agents over JSON-RPC stdio."
kind: "package-reference"
---

# @deepseek-ai/dsh-acp

English | [中文](README.zh.md)

## Summary

`dsh-acp` lets trusted programs drive persistent DeepSeek Harness agents over the standard [Agent Client Protocol](https://agentclientprotocol.com): create or resume sessions, list resumable sessions, attach standard MCP servers, select a model and reasoning effort, prompt or cancel work, receive semantic execution updates, and close one session without affecting others. It is built for automation — out-of-process subagents, test runners, and scripted controllers — rather than the DSH user interface: it emits standard ACP messages, thoughts, generic tool lifecycle, configuration, and context usage, never private DSH presentation data or methods. Session persistence enables list, resume, and close across process restarts, while deletion, fork, transcript replay, additional directories, and interactive UI surfaces remain unsupported. The repository's own ACP client is `dsh-subagent-acp`, and `pnpm dsh --profile acp` starts a ready-to-use server. Setup and usage come first; the implementation details live in a collapsible developer section below.

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

Use this package when a script, test runner, or another harness needs to run agent work end to end through a standard automation protocol. The common path is: start the server, create or resume a session, optionally mount MCP servers and select model options, send a prompt, consume semantic updates, and close the session.

### When to choose it

Choose it when automation should own the interaction: an out-of-process subagent, test runner, or scripted controller that manages persistent sessions, tools, model selection, and permissions. Avoid it when a human needs DSH-specific presentation cards, plans, titles, todos, terminal views, or elicitation; this server intentionally exposes only the standard ACP v1 surface.

### Minimal configuration

Every session the server creates uses the provider and model configured here. Both fields are optional so another agent or request listener can supply them; the runnable demo composition sets both. Stdout carries only protocol traffic, so keep logging off it.

```yaml
- name: '@deepseek-ai/dsh-acp'
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | — | Provider route for every session's agent |
| `model` | — | Model for every session's agent |
| `sessionListPageSize` | `100` | Maximum summaries returned in one `session/list` page |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-acp) is the exhaustive source for every accepted field and its JSDoc.

### Start a server

`pnpm dsh --profile acp` starts the shipped stdio server. The `acp` profile mounts session persistence, so clients can list, resume, and close persistent sessions. [`@deepseek-ai/dsh-subagent-acp`](../../subagent/subagent-acp/README.md) starts the same profile for out-of-process delegation.

<a id="protocol-contract"></a><a id="standard-acp-v1-surface"></a>
### Protocol contract

One connection can run several sessions at once, each independent. The calls a client makes:

| Call | What you get |
|---|---|
| `initialize` | Stable ACP v1 plus `session/list`, `session/resume`, `session/close`, and Streamable HTTP MCP support; image prompts only when the durable attachment store and configured exact route support them. |
| `authenticate` | Immediate success; the server requires no authentication. |
| `session/new` | A fresh persistent agent whose absolute workspace and stdio or HTTP MCP servers are validated before publication, plus its complete configuration-option state. |
| `session/list` | Deterministic newest-first pages of persisted, resumable root sessions; an optional absolute `cwd` filter uses physical-directory identity where possible. |
| `session/resume` | A persisted inactive session whose canonical workspace is verified before composition; its log is restored without replaying old updates. |
| `session/close` | Quiescent cancellation, update draining, descendant disposal, persistence flush, and disposal of only the addressed Agent scope. |
| `session/set_config_option` | A serialized update to the advertised `model` or `reasoning_effort`, returning the complete resulting state. |
| `session/prompt` | Ordered text, resource links, and supported images, one prompt at a time per session; settlement follows Agent idle and ordered update delivery. |
| `session/cancel` / `$/cancel_request` | The prompt-owned cancellation path; without an ACP prompt in flight it cancels autonomous work, while unknown session ids are no-ops. |
| `session/update` | Committed assistant messages and thoughts, generic tool lifecycle, configuration changes, and context usage, serialized per session. |
| `session/request_permission` | A permission prompt with one-shot allow/reject choices; your client can answer automatically. |

Session configuration offers opaque provider/model choices from the live LLM service catalog and a `reasoning_effort` selector when the exact model declares one. A prompt snapshots that selection before asynchronous image admission and pins it across every model step in that turn; a concurrent option change applies to the next turn. ACP clients are trusted controllers: stdio MCP entries authorize their absolute commands and environment, HTTP entries authorize their absolute HTTP(S) URLs and headers, and any initial connection or discovery failure rolls back the unpublished Agent. Unsupported surfaces are omitted or reject: `session/load`, deletion, fork, additional directories, SSE or ACP-transport MCP, modes, commands, plans, terminals, client filesystem operations, and elicitation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the server realizes the behavior above and points at the code that implements it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The server is an automation transport with an intentionally standard public protocol. Three commitments shape it:

- **Standard semantic updates only.** The wire carries committed messages and thoughts, generic tool lifecycle, configuration, and context usage; raw provider deltas, retry attempts, DSH presentation data, and unsupported content stay off the wire.
- **Truthful capability and configuration state.** `initialize` advertises only mounted support, topology changes publish complete configuration options, and a prompt pins the exact route it admitted.
- **Quiescence before settlement.** Prompt and close operations settle only after their owned admission, Agent activity, ordered updates, descendants, persistence, and disposal have reached the required terminal state.

The decision history lives in the [ACP as an automation-only protocol note](../../../.agents/notes/implemented/simplification/2026-07-23-acp-automation-only-protocol.md) and the [multi-session note](../../../.agents/notes/implemented/feature/2026-06-14-acp-multi-session.md).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, `AgentSideConnection` wiring, per-session records, admission and settlement, teardown |
| [`src/content.ts`](src/content.ts) | Wire-content admission and projection: image validation, route recheck, prompt reconstruction, assistant block conversion |
| [`src/codec.ts`](src/codec.ts) | Pure turn-ending to ACP `stopReason` mapping |
| — | No runtime invariant companion is published; this transport owns no durable package-local event stream; protocol and lifecycle tests cover its mapping. |

### Admission and prompt settlement

Each session permits one in-flight prompt. Admission validates the whole prompt batch, snapshots the selected route, rechecks the exact Agent identity and image capability, persists image attachments, and only then queues the user message — a cancellation that wins admission never enqueues a late turn. Once queued, the session module associates the snapshot with the inbox message until claim and pins the same provider, model, and reasoning effort across prompt variables and every model step in that turn. Per-session update delivery is serialized; committed images are re-read and integrity-verified, so a missing or corrupt image fails the correlated prompt instead of emitting a placeholder. Settlement precedence is explicit cancellation, committed-output failure, interval-wide Agent failure, then the correlated turn ending.

### Teardown and connection ownership

Each session module owns its Agent handle, MCP mounts, future and turn-pinned model selections, prompt slot, update chain, and memoized close operation. Explicit close, client disconnect, and Cordis disposal use the same quiescent teardown: stop new work, cancel prompt admission and Agent activity, drain committed updates, dispose continuable descendants child-first, flush persistence, and release the owned Agent scope. A session close leaves persisted state available for list and resume, and other sessions or frontends sharing the Context remain untouched.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the matching client to the design records behind the automation contract.

- [dsh-subagent-acp](../../subagent/subagent-acp/README.md) — the out-of-process ACP client that spawns and drives this server.
- [ACP as an automation-only protocol](../../../.agents/notes/implemented/simplification/2026-07-23-acp-automation-only-protocol.md) — the design record for the automation contract and its wire boundaries.
- [Multiplex concurrent ACP sessions over one connection](../../../.agents/notes/implemented/feature/2026-06-14-acp-multi-session.md) — per-session isolation, ownership, and teardown decisions.
- [Extension cookbook](../../../docs/cookbook/extension-cookbook.md) — this package as the automation-only worked example for extension authors.

-----

<a id="model-experience"></a>
## Model Experience

### Prompt content

#### What the model sees

`session/prompt` preserves text and image order in one user message: adjacent text concatenates, and a resource link appears as a bracketed `[resource_link name=… uri=…]` reference the model may open with its own tools. Inline image base64 is discarded after batch admission, so the durable message contains only verified attachment references. Protocol metadata, client capabilities, permission choices, and session ids never enter the model request.

#### Token effect

Prompt content, tool calls/results, and durable image references remain in that session until compaction. Concurrent sessions retain independent contexts.

#### KV Cache effect

Append-only while the selected route and assembled prefix stay unchanged. A model change starts the next ACP turn on the new route.

### Permission decisions

#### What the model sees

Nothing directly. The owning tool records its allowed, rejected, cancelled, or unavailable outcome through the normal tool-result path.

#### Token effect

Only the owning tool result contributes tokens.

#### KV Cache effect

Append-only through the owning tool result.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this package is a poor fit or needs special operational care. They are current package constraints, not a protocol comparison or a task backlog.

- **One primary workspace** — additional directories remain unsupported.
- **Raster prompt images only** — PNG, JPEG, WebP, and GIF require a durable attachment store and an exact image-capable route.
- **MCP tools only** — MCP resources and prompts have no DSH consumer.
- **No transcript replay or interactive extensions** — session deletion, fork, `session/load`, modes, commands, plans, terminals, client filesystem operations, and elicitation remain outside this automation surface.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
