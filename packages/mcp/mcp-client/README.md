---
description: "MCP client bridge for deployments and maintainers choosing, configuring, or debugging connections to external MCP servers whose tools register on ctx.tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-client

English | [中文](README.zh.md)

## Summary

`dsh-mcp-client` attaches external Model Context Protocol (MCP) servers to the harness so their tools work like any native tool. With one configuration entry per server, the model can call that server's tools — a filesystem, GitHub, database, or memory server — under stable names such as `mcp__github__create_issue`. Add it when the model should work with an external tool server; nothing ships enabled, so you opt in. The main cost is the tokens those tool definitions add to every request, and a slow or crashed server can delay startup or leave its tools failing until it recovers. Only tools are bridged: MCP resources and prompts are not supported.

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

Add `dsh-mcp-client` when the model should call tools from an external MCP server as if they were native. One configuration entry per server is the entire setup: give the server a short unique name and a transport, and its tools appear as `mcp__<serverName>__<tool>`. Choose stdio when the server runs as a local program and Streamable HTTP when it runs as a service. If you already use MCP tool servers from another client, the same server rows work here.

### Minimal configuration

Add one entry per server; nothing else is required. After the harness starts, the server's tools appear in the model's tool list.

```yaml
- id: mcp-github
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: github
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN

- id: mcp-web
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: web
    transport: streamable-http
    url: http://localhost:3000/mcp
    headers:
      Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'
```

| Field | Default | Meaning |
|---|---|---|
| `transport` | required | `stdio` or `streamable-http` |
| `serverName` | required | Namespace for the server's tool names; `[A-Za-z0-9_-]{1,32}`, unique inside one registration scope |
| `command` / `args` / `env` / `cwd` | — | stdio: executable, arguments, extra env merged over scrubbed ambient env, working directory |
| `url` / `headers` | — | streamable-http: endpoint URL and extra request headers |
| `toolCallTimeoutMs` | `60,000` | Timeout per `tools/call` invocation |
| `startupTimeoutMs` | `30,000` | Budget for one connection attempt plus its initial tool sync |
| `failOnStartupError` | `false` | Reject plugin activation when the initial connection or tool synchronization fails |
| `reconnect.enabled` | `true` | Reconnect automatically after a lost connection |
| `reconnect.initialDelayMs` | `500` | First reconnect delay; doubles per consecutive failed attempt |
| `reconnect.maxDelayMs` | `30,000` | Backoff ceiling; also the uptime after which the attempt budget resets |
| `reconnect.maxAttempts` | `10` | Consecutive failed attempts per outage before giving up |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-mcp-client) is the exhaustive source for every accepted field.

After startup, the server's tools appear as `mcp__<serverName>__<tool>` — try a prompt that uses one. If the initial connection fails, the harness still starts but no tools from that server appear, and an error is logged; set `failOnStartupError: true` to make a startup failure abort the harness instead.

### Tool naming and coexistence

The model sees each tool under a stable server-qualified name: `mcp__<serverName>__<rawName>`, for example `mcp__github__create_issue` — the same naming shape Claude Code and Codex use. Names stay stable while the server keeps the same tool name, so session history and permission rules survive restarts and reloads. Two servers can both offer a tool named `search` and coexist as `mcp__github__search` and `mcp__web__search`.

- Two servers publishing the same tool name (for example `search`) coexist under their own namespaces.
- Two entries using the same server name: the later one fails to load with a clear error.
- A server that lists the same tool twice gets its tool list rejected as invalid, and the previous tool set stays active.
- An update that conflicts with an already-registered tool name is rejected entirely — you never get a partial tool set from that server.

### Calling tools and reading results

When the model calls an MCP tool, the call runs against the remote server with a per-call timeout (default 60 seconds) and can be cancelled like any other tool call. The result comes back as ordinary text in block order; resource links appear as text with their name and URI. If the server reports an error, the call fails visibly — the model does not see a fake success.

Images are supported when the current model accepts image input and the harness attachment feature is enabled; they then appear in the conversation like other images. Otherwise — and for audio or embedded resources — the model sees a clear diagnostic message instead of nothing.

### Startup, updates, and reconnection

The server's tools appear before the harness starts its first turn. Every connection attempt — the first one and each reconnect — is bounded by `startupTimeoutMs` (default 30 seconds) covering the connection plus the initial tool discovery, so an unresponsive server cannot hold startup open. When the server changes its tool list, the model's tool set updates automatically; if the update fails, the previous tool set keeps working.

When a server connection drops — for example a local server process crashes — the plugin reconnects automatically with delays that double from 500 ms up to 30 s and then refreshes the tool set; reconnect progress is visible in the logs. During an outage the last known tools stay listed but calls to them fail until the server recovers. After ten consecutive failed attempts the server's tools are removed and reconnection stops until you reload the configuration or restart the harness; a server that stays connected for a while resets that counter. Set `reconnect.enabled: false` to disable automatic reconnection — tools then stay listed but fail until you reload. Editing the configuration entry reloads the server connection in place, and unchanged names stay unchanged.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the bridge and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Server-qualified identity.** Every MCP tool has the stable identity `(serverName, rawName)`. The namespace is local configuration, never the remote `serverInfo.name` — the remote name is untrusted, not unique across deployments, and can change on upgrade, none of which may silently rename model-facing tools.
- **Naming is a pinned contract.** Public names are pure functions of `(serverName, rawName)` and satisfy the DeepSeek function-name contract; lossy normalization appends a 12-hex-char SHA-256 hash so distinct identities never collapse. Session history and permission rules therefore survive HMR swaps, re-syncs, and other servers' changes.
- **The raw name is the only wire name.** `tools/call` always receives the raw name; the public name is never sent to the server and never parsed to recover the raw name.
- **Full generation or none.** Syncs swap generations atomically: a fetch failure keeps the previous generation, and a registration conflict rolls back the entire attempted generation.
- **One canonical value, one projection.** The executor returns the protocol-complete canonical `McpResult`; a separate ordered projection prepares Native content, and `finalizeContent` installs it only when the registry's post-execute result is unchanged, so policy blocks and value replacements stay authoritative.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, `serverName` reservation, activation await |
| [`src/connection.ts`](src/connection.ts) | Connection supervisor: client generations, reconnect policy, attempt budget, disposal |
| [`src/tools.ts`](src/tools.ts) | Tool bridge: discovery, naming, registration swap, execution, image projection |
| [`src/transport.ts`](src/transport.ts) | Transport factory: stdio spawn with scrubbed env, Streamable HTTP |
| [`src/status.ts`](src/status.ts) | Status surface: the per-instance status cell and the per-scope lookup |
| [`src/probe.ts`](src/probe.ts) | One-shot probe: connect, identify, list tools, close — nothing registers |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; generations are observable only through the tool registry) |

### Lifecycle and sync

`apply` resolves the reconnect policy, reserves the `serverName` inside the current registration scope, starts the supervisor, and awaits the initial connection plus discovery. Independent Agent scopes may reuse the same namespace because their tools and transports are isolated; a duplicate inside one scope fails at load. The supervisor serializes every sync — initial, notification, and reconnect — through one queue so two syncs can never interleave their dispose-previous/register-next swap. Disposal cancels pending reconnects, closes the live client, waits for the in-flight attempt and queued syncs to quiesce, and unregisters the current generation. The [auto-reconnect Agent Note](../../../.agents/notes/implemented/feature/2026-08-06-mcp-client-auto-reconnect.md) owns the reconnect decision.

A manager composing instances (such as `dsh-mcp-manager`) observes one instance through `connectionStatusOf(ctx, serverName)`: a read-and-observe handle over the supervisor's status cell (`connecting`, `connected`, `reconnecting`, `failed`), registered and released with the `serverName` reservation. `probeServer(config)` answers a configuration surface's "test this server" without reserving a name or touching `ctx.tools`.

The supervisor listens for `notifications/tools/list_changed` and queues a re-sync; a fetch-phase failure keeps the previous generation registered, while a registration conflict rolls back the attempted generation. Each outage shares one attempt budget: after `maxAttempts` consecutive failures the tools are unregistered and reconnection stops, and a connection that stays up past `maxDelayMs` resets the budget.

### Tool execution internals

A tool call sends an uncached `tools/call` request carrying the raw MCP name, the JSON arguments, the abort signal, and the configured timeout; the public name is never sent to the server and never parsed back. Canonical success is `{ content: JsonValue[], structuredContent? }`, preserving the complete MCP JSON blocks for programmatic and PTC mode callers. A supported advertised `outputSchema` validates `structuredContent`; unsupported schema vocabulary falls back to unconstrained `JsonValue`. An MCP `isError` result throws before any image persistence, so the registry produces a failed tool result. Image batches are decoded and validated as a whole before any member is saved; any refusal projects every image as diagnostic text.

### Environment scrubbing (stdio)

The child environment starts from the subprocess seam's `scrubbedParentEnv()` — ambient names matching `/KEY|PASSWORD|SECRET|TOKEN/i` and ambient `DSH_*` names are dropped — and the configured `env` merges on top, so explicit overrides survive. The MCP SDK owns the actual spawn; this package shares the scrub definition, not the spawn path.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared tool registry to the bridge's design evidence and worked example configurations.

- [Tools subsystem reference](../../../docs/subsystems/tools.md) — the `ToolRuntime` and `ctx.tools.register()` contract that receives the bridged tools.
- [MCP client plugin Agent Note](../../../.agents/notes/implemented/feature/2026-07-07-mcp-client-plugin.md) — the naming invariants, discovery and execution design, alternatives, and consequences.
- [MCP client auto-reconnect Agent Note](../../../.agents/notes/implemented/feature/2026-08-06-mcp-client-auto-reconnect.md) — the reconnect policy, attempt budget, and opt-out rationale.
- [Canonical tool output contract Agent Note](../../../.agents/notes/implemented/architecture/2026-07-20-canonical-tool-output-contract.md) — how MCP results map into the canonical tool-output contract.
- [Third-party memory MCP guide](../../../docs/user/guide/mcp-memory.md) — three memory-server overlays using this package.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-mcp-client) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Discovered MCP tools

#### What the model sees

After initial discovery succeeds, every advertised MCP tool appears as a native tool named `mcp__<serverName>__<rawName>` (or its deterministic normalized form) with the server-provided description and input schema. A successful re-sync — including the one after an automatic reconnect — replaces the generation; plugin disposal or an exhausted reconnect budget removes it.

#### Token effect

The tool descriptions and input schemas enter every request while the tools are registered; re-syncs replace rather than accumulate schemas, and the server-qualified name adds tokens to every tool definition and call.

#### KV Cache effect

The tool-definition prefix stays stable while the discovered set and schemas are unchanged. A re-sync that adds, removes, renames, or changes a tool replaces definitions and may invalidate reuse from the first changed schema token onward; a reconnect that recovers an unchanged list reproduces identical definitions and stays prefix-stable.

### Tool-call history and results

#### What the model sees

The public tool name and JSON arguments remain in assistant history. The canonical value retains the complete MCP JSON blocks and optional structured content for programmatic and PTC mode callers; supported image blocks project beside text in their original order after exact route-capability proof. Refused images, audio, embedded resources, resource links, and unknown blocks remain visible as bounded text diagnostics, and MCP `isError` rejects the call before image persistence.

#### Token effect

Arguments, mapped text, and durable image references are retained until compaction. Inline MCP base64 stays only in the execution-local canonical value and is never copied into a session event; the provider reads verified bytes from the attachment store. Audio and embedded-resource payloads stay out of model context.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe what you cannot do with this plugin and when it needs operational attention. They are current package constraints, not a comparison with other MCP clients or a task backlog.

- **Tools are the only bridged MCP capability** — Resources and Prompts have no harness consumer mechanism and are deferred.
- **Only startup attempts are budget-bounded** — `startupTimeoutMs` covers each connection attempt plus its initial tool sync; a notification-driven re-sync's `tools/list` requests still ride the MCP SDK's 60-second request default.
- **Reconnect triggers on transport close** — a crashed stdio child fires it; Streamable HTTP failures surface per request through the SDK transport's own recovery, so an unreachable HTTP server is retried per call rather than respawned by the supervisor.
- **Image is the only durable rich-result bridge** — PNG, JPEG, WebP, and GIF enter Native context after exact capability proof. Audio and embedded-resource payloads remain execution-local with explicit diagnostics, while resource links preserve only their name and URI as text.
- **Unsupported MCP output schemas are not enforced** — `structuredContent` falls back to `JsonValue` when the advertised schema uses vocabulary outside the harness subset.
- **Task-required MCP tools are rejected at call time** — a tool that requires the task-based execution extension throws instead of bridging; the extension is not implemented.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The public-name algorithm is a v1 contract pinned by tests; changing it after release would break session history and permission rules.
- Reconnect ownership for Streamable HTTP is open: per-request retry is SDK behavior, and the supervisor could also own the HTTP generation.
- Bridging MCP Resources needs a harness-side injection decision (system prompt, on demand, or model-triggered); bridging Prompts needs a prompt-template concept the harness lacks.
- The pinned MCP SDK is still evolving; a breaking upstream change requires updating the bridge.

</details>
