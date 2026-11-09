---
description: "MCP client bridge for deployments and maintainers choosing, configuring, or debugging connections to external MCP servers whose tools register on ctx.tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-client

English | [中文](README.zh.md)

## Summary

`dsh-mcp-client` lets the model use tools and resources from external Model Context Protocol (MCP) servers. Configure one server per entry; its tools use names such as `mcp__github__create_issue`. No server is enabled by default. Shipped profiles already provide [shared resource discovery and reading](../mcp-resources/README.md). An empty caller scope adds no MCP tools or prompt text. Server instructions join the logged system prompt as literal text; MCP prompt templates are unsupported. Slow or crashed servers can delay startup or fail calls until recovery.

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

Add `dsh-mcp-client` when the model should call tools from an external MCP server as if they were native. Give each server a unique name and transport. The official SDK selects the 2026-07-28 protocol when available and falls back to supported legacy revisions. Choose stdio for a local program and Streamable HTTP for a service; stdio negotiation starts a temporary probe process before the serving process.

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
| `toolCallTimeoutMs` | `60,000` | Timeout per `tools/call` or resource request |
| `startupTimeoutMs` | unset | Optional budget for template resolution, negotiation, connection, and the initial tool sync |
| `closeTimeoutMs` | `5,000` | Budget for transport closure and pending local work to settle |
| `expandTemplates` | `false` | Resolve `${credential:REF}` in transport strings at runtime and redact resolved values from diagnostics |
| `maxInstructionBytes` | `32,768` | Maximum UTF-8 bytes of server instructions including attribution; an oversized value rejects the connection |
| `failOnStartupError` | `false` | Reject plugin activation when the initial connection or tool synchronization fails |
| `reconnect.enabled` | `true` | Reconnect automatically after a lost connection |
| `reconnect.initialDelayMs` | `500` | First reconnect delay; doubles per consecutive failed attempt |
| `reconnect.maxDelayMs` | `30,000` | Backoff ceiling; also the uptime after which the attempt budget resets |
| `reconnect.maxAttempts` | `10` | Consecutive failed attempts per outage before giving up |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-mcp-client) is the exhaustive source for every accepted field.

After startup, the server's tools appear as `mcp__<serverName>__<tool>` — try a prompt that uses one. If the initial connection fails, the harness still starts but no tools from that server appear, and an error is logged. Setting `failOnStartupError: true` rejects plugin activation; [app-boot's startup policy](../../boot/app-boot/README.md) still permits an optional MCP entry to fail without aborting the harness.

### Tool naming and coexistence

The model sees each tool under a stable server-qualified name: `mcp__<serverName>__<rawName>`, for example `mcp__github__create_issue` — the same naming shape Claude Code and Codex use. Names stay stable while the server keeps the same tool name, so session history and permission rules survive restarts and reloads. Two servers can both offer a tool named `search` and coexist as `mcp__github__search` and `mcp__web__search`.

- Two servers publishing the same tool name (for example `search`) coexist under their own namespaces.
- Two entries using the same server name: the later one fails to load with a clear error.
- A server that lists the same tool twice gets its tool list rejected as invalid, and the previous tool set stays active.
- The SDK owns discovery pagination and its page limit. A discovery failure preserves the previous tools; malformed cursor chains follow the SDK's behavior.
- An update that conflicts with an already-registered tool name is rejected entirely — you never get a partial tool set from that server.

### Calling tools and reading results

When the model calls an MCP tool, the call runs against the remote server with a per-call timeout (default 60 seconds) and can be cancelled like any other tool call. The result comes back as ordinary text in block order; resource links appear as text with their name and URI. If the server reports an error, the call fails visibly — the model does not see a fake success.

Images are supported when the current model accepts image input and the harness attachment feature is enabled; they then appear in the conversation like other images. Otherwise — and for audio or embedded resources — the model sees a clear diagnostic message instead of nothing.

### Startup, updates, and reconnection

The server's tools appear before the harness starts its first turn. Set `startupTimeoutMs` to bound each connection attempt, including template resolution and initial tool discovery; an omitted value adds no whole-attempt deadline. Tool-list notifications refresh the registered tools; discovery failures preserve the previous set, while registration conflicts close the connection and apply the reconnect policy.

When a server connection drops — for example a local server process crashes — the plugin reconnects automatically with delays that double from 500 ms up to 30 s and then refreshes the tool set; reconnect progress is visible in the logs. During an outage the last known tools stay listed but calls to them fail until the server recovers. After ten consecutive failed attempts the server's tools are removed and reconnection stops until you reload the configuration or restart the harness; a server that stays connected for a while resets that counter. Set `reconnect.enabled: false` to disable automatic reconnection — tools then stay listed but fail until you reload. Editing the configuration entry reloads the server connection in place, and unchanged names stay unchanged.

<a id="runtime-templates-and-credentials"></a>
### Runtime templates and credentials

With `expandTemplates: true`, `command`, `args`, `env` values, `cwd`, `url`, and `headers` values accept `${credential:REF}`. The current credentials provider resolves each reference; the [local provider](../../credentials/credentials-local/README.md) also reads the Host's inherited environment. Raw plugin configuration retains its template strings. A credential reference requires a credentials provider at load. Missing values enter `waiting-credentials` without consuming reconnect attempts unless strict startup rejects activation; a referenced credential update retries resolution.

Credential notifications rebuild the connection only when the resolved values change; same-value notifications preserve the connection and its reconnect budget. The old connection must close and finish local cleanup before a replacement starts. Incomplete cleanup blocks replacement until the Host restarts.

With template expansion enabled, failure diagnostics, tool-call failures, and MCP `isError` tool-result text keep upstream messages but replace every value the instance resolved, including earlier rotations and URL-encoded forms, with `[redacted]`; the failure keeps its `name` and `code`. Successful tool results retain their content.

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
- **One canonical value, one projection.** The executor preserves the complete canonical MCP value and prepares ordered text/image content. `projectContent` installs that content before `tools/post-execute`, so retention sees real images. Subsequent content replacement, value replacement, and blocking remain authoritative.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, `serverName` reservation, activation await |
| [`src/connection.ts`](src/connection.ts) | Connection supervisor: client generations, reconnect policy, attempt budget, disposal |
| [`src/generation.ts`](src/generation.ts) | Transport ownership, cancellation, pending work, and confirmed closure |
| [`src/credentials.ts`](src/credentials.ts) | Runtime template binding and redaction of every resolved value |
| [`src/templates.ts`](src/templates.ts) | Credential template syntax, substitution, and reference discovery |
| [`src/server-context.ts`](src/server-context.ts) | Resource-provider registration and literal server instructions |
| [`src/tools.ts`](src/tools.ts) | Tool bridge: discovery, naming, registration swap, execution, image projection |
| [`src/transport.ts`](src/transport.ts) | Transport factory: stdio spawn with scrubbed env, Streamable HTTP |
| [`src/status.ts`](src/status.ts) | Status cell keyed by Fiber, retaining its final cleanup result |
| [`src/probe.ts`](src/probe.ts) | One-shot probe: connect, identify, list tools, close — nothing registers |
| [`src/deadline.ts`](src/deadline.ts) | Shared settlement deadline behind the startup and probe budgets |
| [`src/diagnostic.ts`](src/diagnostic.ts) | Cause-chain diagnostics and secret-value redaction |
| [`src/types.ts`](src/types.ts) | Client-safe connection status and probe outcome types (`./types`) |

The exported `createMcpToolDefinition(ctx, options)` adapts an upstream tool schema and raw-result callback to the same canonical values, errors, and durable image projection. Each callback receives the exact `ToolExecution`, including its Agent and cancellation signal; SDK spec-type validation checks its result before projection. Callers own registration, cancellation deadlines, and provider teardown. The native Cua Driver provider uses this adapter without opening an MCP transport.

### Lifecycle and sync

`apply` resolves the reconnect policy, reserves the `serverName` inside the current registration scope, starts the supervisor, and awaits the initial connection plus discovery. Independent Agent scopes may reuse the same namespace because their tools and transports are isolated; a duplicate inside one scope fails at load. The supervisor serializes every sync — initial, notification, and reconnect — through one queue so two syncs can never interleave their dispose-previous/register-next swap. Disposal cancels pending reconnects, closes the negotiating transport or attached client, waits for the in-flight attempt and queued syncs to quiesce, and unregisters the current generation.

A manager composing instances (such as `dsh-mcp-manager`) observes one instance through `connectionStatusOf(fiber)`. The handle survives reloads of the same Fiber and retains the final connection and cleanup result after disposal; final disposal detaches its observers. Status observers may dispose the Fiber during a reload; cleanup still covers that connection attempt. `probeServer(ctx, config, options)` tests a server without reserving a name or registering tools. Its `timeoutMs` bounds template resolution, connection, and listing together, independently of runtime `startupTimeoutMs`; cleanup uses `closeTimeoutMs` and reports `closeConfirmed` separately. Confirmed transport closure can still carry a `cleanupError`; either unconfirmed closure or a cleanup error blocks replacement.

The SDK receives tool-list changes through legacy notifications or a modern subscription. The supervisor queues each re-sync and republishes the connected tool count; a fetch failure keeps the previous generation registered, while a registration conflict rolls back the attempted generation and closes the connection before applying the reconnect policy. Each outage shares one attempt budget: after `maxAttempts` consecutive failures the tools are unregistered and reconnection stops, and a connection that stays up past `maxDelayMs` resets the budget.

With `expandTemplates` enabled, failure diagnostics name the operation and keep the cause chain with every resolved value replaced by `[redacted]`. With expansion disabled, diagnostics retain the full error text.

### Tool execution internals

A tool call uses the SDK with the raw name, complete tool definition, JSON arguments, abort signal, and configured timeout. The SDK owns protocol validation and modern request headers. The bridge checks structured content against the advertised output schema itself, with the SDK's Node Ajv validator, because the SDK reports its own check as a `ProtocolError` that cannot be told apart from a server's JSON-RPC error. Canonical success is `{ content: JsonValue[], structuredContent? }`, preserving valid MCP JSON blocks for programmatic and PTC mode callers. An MCP `isError` result throws `McpToolError` with `MCP_TOOL_ERROR` before image persistence. Other tool and resource request failures throw `McpToolError`: after `MCP_CONNECTION_CLOSED` or `MCP_TIMEOUT` the request's outcome is unknown, `MCP_SERVER_UNAVAILABLE` means the request was not sent, `MCP_INVALID_RESULT` rejects a result that violates the MCP result schema or the advertised output schema, or an output schema that cannot be compiled, `MCP_UNSUPPORTED_TASK_EXECUTION` rejects the tool, and `MCP_REQUEST_FAILED` carries the JSON-RPC or SDK code in its message. Closure of the connection generation surfaces as `McpLocalError` with `MCP_CONNECTION_CLOSED`, and caller cancellation as the tool registry's `ABORTED`. `McpLocalError` codes also report local connection failures: `MCP_TIMEOUT`, `MCP_CREDENTIALS_UNAVAILABLE`, `MCP_CREDENTIAL_NOT_FOUND`, `MCP_INSTRUCTIONS_TOO_LARGE`, and `MCP_TOOL_REGISTRATION_FAILED`. The bridge validates each image batch before saving it; a refusal projects every image as diagnostic text. For a server that does not advertise `resources`, resource and template lists return empty pages without calling the SDK, whose fallback writes a diagnostic to stdout, where the ACP profile carries JSON-RPC.

### Environment scrubbing (stdio)

The child environment starts from the subprocess seam's `scrubbedParentEnv()` — ambient names matching `/KEY|PASSWORD|SECRET|TOKEN/i` and ambient `DSH_*` names are dropped — and the configured `env` merges on top, so explicit overrides survive. The MCP SDK owns the actual spawn; this package shares the scrub definition, not the spawn path.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared tool registry to the bridge's design evidence and worked example configurations.

- [Tools subsystem reference](../../../docs/subsystems/tools.md) — the `ToolRuntime` and `ctx.tools.register()` contract that receives the bridged tools.
- [historical MCP client plugin Agent Note](../../../.agents/notes/archived/feature/2026-07-07-mcp-client-plugin.md) — the naming invariants, discovery and execution design, alternatives, and consequences.
- [Canonical tool output contract reference](../../core/tools/README.md) — how MCP results map into the canonical tool-output contract.
- [Third-party memory MCP guide](../../../docs/user/guide/mcp-memory.md) — three memory-server overlays using this package.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-mcp-client) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Discovered MCP tools

#### What the model sees

After discovery succeeds, SDK-admitted MCP tools appear as native tools named `mcp__<serverName>__<rawName>` (or their deterministic normalized form), with the server description and input schema. A re-sync replaces the generation; disposal or an exhausted reconnect budget removes it. A server without the tools capability connects with an empty tool set.

#### Token effect

The tool descriptions and input schemas enter every request while the tools are registered; re-syncs replace rather than accumulate schemas, and the server-qualified name adds tokens to every tool definition and call. A configured client also enables the [shared resource tools and server-name prompt](../mcp-resources/README.md#model-experience).

#### KV Cache effect

The tool-definition prefix stays stable while the discovered set and schemas are unchanged. A re-sync that adds, removes, renames, or changes a tool replaces definitions and may invalidate reuse from the first changed schema token onward; a reconnect that recovers an unchanged list reproduces identical definitions and stays prefix-stable.

### Tool-call history and results

#### What the model sees

The public tool name and JSON arguments remain in assistant history. The canonical value retains the complete MCP JSON blocks and optional structured content for programmatic and PTC mode callers; supported image blocks project beside text in their original order after exact route-capability proof. Refused images, audio, embedded resources, resource links, and unknown blocks remain visible as bounded text diagnostics, and MCP `isError` rejects the call before image persistence.

#### Token effect

Arguments, mapped text, and durable image references are retained until compaction. Inline MCP base64 stays only in the execution-local canonical value and is never copied into a session event; the provider reads verified bytes from the attachment store. Audio and embedded-resource payloads stay out of model context.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Server instructions

#### What the model sees

One server-labeled section contains the nonblank instructions returned by each successful connection. Absent or blank instructions add no prompt text. Braces remain literal. A replacement connection publishes its instructions only after discovery succeeds; disposal or exhausted recovery removes the section.

#### Token effect

Server instructions contribute text to model requests while their scoped section is active. Resource documents enter history only through explicit resource reads.

#### KV Cache effect

Unchanged instructions retain identical prompt text. Updated or removed instructions change the next assembled system message and its reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe what you cannot do with this plugin and when it needs operational attention. They are current package constraints, not a comparison with other MCP clients or a task backlog.

- **Resources are read on demand** — shipped profiles provide the [shared resource service](../mcp-resources/README.md); resource subscriptions and MCP prompt templates are unsupported.
- **Whole-attempt startup budgets are opt-in** — `startupTimeoutMs` covers template resolution, negotiation, connect, and the initial tool sync when configured. A notification-driven re-sync's `tools/list` requests use the MCP SDK's 60-second request default and page limit. Plugin unload closes the transport to interrupt pending startup requests before awaiting teardown.
- **Reconnect handles failed negotiation and transport close** — a failed initial connection or a crashed stdio child uses the configured reconnect budget. Ordinary HTTP request failures use the SDK transport's recovery; credential changes replace the connection.
- **Image is the only durable rich-result bridge** — PNG, JPEG, WebP, and GIF enter Native context after exact capability proof. Audio and embedded-resource payloads remain execution-local with explicit diagnostics, while resource links preserve only their name and URI as text.
- **Invalid protocol results or output schemas fail through the SDK** — the bridge does not accept legacy `toolResult` substitutes or bypass advertised schema validation.
- **Task-required MCP tools are rejected at call time** — a tool that requires the task-based execution extension throws instead of bridging; the extension is not implemented.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The public-name algorithm is a v1 contract pinned by tests; changing it after release would break session history and permission rules.
- A DSH-owned budget for notification-driven re-syncs is an open direction; configured `startupTimeoutMs` bounds startup attempts, while the SDK's 60-second default bounds re-sync requests.
- MCP prompt templates need a separate user-selection and invocation mechanism.
- The pinned MCP SDK is still evolving; a breaking upstream change requires updating the bridge.

</details>
