---
description: "MCP client bridge for deployments and maintainers choosing, configuring, or debugging connections to external MCP servers whose tools register on ctx.tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-client

English | [中文](README.zh.md)

## Summary

`dsh-mcp-client` lets the model use tools and resources from external Model Context Protocol (MCP) servers. Configure one server per entry; its tools use names such as `mcp__github__create_issue`. No server is enabled by default. Shipped profiles already provide [shared resource discovery and reading](../mcp-resources/README.md). An empty caller scope adds no MCP tools or prompt text. Server instructions join the logged system prompt as literal text; MCP prompt templates are unsupported. With `toolLoading: on-demand`, the system prompt lists the tools and each agent loads the ones it needs. Slow or crashed servers can delay startup or fail calls until recovery.

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
| `toolLoading` | `eager` | `on-demand` keeps the server's tools out of every tool list until an agent loads them with `mcp__<serverName>__load_tools` |
| `catalogDescriptionMaxLength` | `160` | Maximum characters of each tool summary in an on-demand server's prompt catalog |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-mcp-client) is the exhaustive source for every accepted field.

After startup, the server's tools appear as `mcp__<serverName>__<tool>` — try a prompt that uses one. If the initial connection fails, the harness still starts but no tools from that server appear, and an error is logged. Setting `failOnStartupError: true` rejects plugin activation; [app-boot's startup policy](../../boot/app-boot/README.md) still permits an optional MCP entry to fail without aborting the harness.

### Host for a server manager

A plugin that manages servers at runtime, such as the [MCP manager](../mcp-manager/README.md), creates its own `McpClientHost` with `new McpClientHost(ctx)`. The host provides `ctx.mcpClientHost`, the only way such a plugin uses this package: it validates a server configuration, mounts server instances, probes servers, and creates explicit OAuth authorization owners. Instances the host mounts run below the managing plugin's fiber and end with it.

`validate` resolves a server configuration through its transport's own schema and also refuses an invalid template token, reconnect policy, or OAuth beside an `Authorization` header, so each refusal names the field after the configuration path the caller passes.

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

When a server connection drops — for example a local server process crashes — the plugin reconnects automatically with delays that double from 500 ms up to 30 s and then refreshes the tool set; reconnect progress is visible in the logs. During an outage the last known tools stay listed but calls to them fail until the server recovers. The plugin reconnects the same way when a remote server no longer accepts the connection's session, for example after the server restarts: a call the server rejected did not run and is sent once more after the reconnect, calls still waiting for an answer when the reconnect starts fail and are not sent again, and later calls use the new session. After ten consecutive failed attempts the server's tools are removed and reconnection stops until you reload the configuration or restart the harness; a server that stays connected for a while resets that counter. Set `reconnect.enabled: false` to disable automatic reconnection — tools then stay listed but fail until you reload. Editing the configuration entry reloads the server connection in place, and unchanged names stay unchanged.

<a id="on-demand-tool-loading"></a>
### On-demand tool loading

Set `toolLoading: on-demand` for a server whose tool definitions are too large to send with every request. Its tools then stay out of the tool list: the system prompt lists each tool's raw name with the first line of its description, and the model loads the tools it needs with `mcp__<serverName>__load_tools`. A loaded tool joins only the calling agent's tool list; subagents, forks, and resumed sessions start without loaded tools. Each later sync, including one after a reconnect, re-registers the loaded tools the server still offers and removes the rest. A server tool named `load_tools` is left out of the catalog with a logged warning. Any agent that sees the loader can load every listed tool; see [Known Limitations](#known-limitations-and-deferred-work) for tool restrictions.

<a id="runtime-templates-and-credentials"></a>
### Runtime templates and credentials

With `expandTemplates: true`, `command`, `args`, `env` values, `cwd`, `url`, and `headers` values accept `${credential:REF}`. The current credentials provider resolves each reference; the [local provider](../../credentials/credentials-local/README.md) also reads the Host's inherited environment. Raw plugin configuration retains its template strings. A credential reference requires a credentials provider at load. Missing values enter `waiting-credentials` without consuming reconnect attempts unless strict startup rejects activation; a referenced credential update retries resolution.

Credential notifications rebuild the connection only when the resolved values change; same-value notifications preserve the connection and its reconnect budget. The old connection must close and finish local cleanup before a replacement starts. Incomplete cleanup blocks replacement until the Host restarts.

With template expansion enabled, failure diagnostics, tool-call failures, and MCP `isError` tool-result text keep upstream messages but replace every value the instance resolved, including earlier rotations and URL-encoded forms, with `[redacted]`; the failure keeps its `name` and `code`. Successful tool results retain their content.

<a id="oauth"></a>
### OAuth

Set `oauth.credentialKey` to a stable `mcp-client/<id>` record address for a Streamable HTTP entry and load a credentials provider. Declare `inject: [credentials]` on the owning plugin entry so startup waits for that provider. OAuth cannot be combined with an `Authorization` header. Connections and probes only use committed grants and never open a browser or register a client. Missing credentials, rejected tokens, or an explicit insufficient-scope response put connections in `waiting-authorization`; probes return a failed result. Its reason is `missing` without a saved grant, `expired` when the access token expired and no refresh token remains, `binding` when the grant no longer matches the resolved `url` or OAuth options, `rejected` when a server rejects the token, and `scope` when the server requires more scope. A tool call in flight when authorization is lost fails with that reason, for example `MCP OAuth requires authorization: scope`. Probes may refresh and persist expired grants. Ordinary HTTP 403 errors do not change authorization state. Diagnostics, tool-call failures, and `isError` results replace every access token the connection sent with `[redacted]`.

Explicit authorization uses the [manager](../mcp-manager/README.md#oauth-authorization) with Authorization and WebServer services. `oauth.clientId` selects a pre-registered public client; omission permits dynamic registration during explicit authorization. `oauth.scope` overrides the challenge scope; dynamic registration reuse requires the same configured scope. Changing the resolved `url`, `oauth.clientId`, or `oauth.scope` makes the saved grant unusable with reason `binding`, so the entry needs explicit authorization again. `oauth.requestTimeoutMs` defaults to 10,000 ms and `oauth.authorizationTimeoutMs` to 600,000 ms. Cancellation and retries wait up to `closeTimeoutMs` for unfinished authorization cleanup. Authorization-server requests and an OAuth entry's MCP requests require HTTPS, except for loopback HTTP, and reject redirects, so `url` must name the final endpoint. The browser callback is a `webserver/request` listener that exists only during an attempt and answers before route admission, because the authorization server's redirect arrives as a cross-site navigation, which [Connection](../../client/connection/README.md) refuses for every route. The listener handles only requests whose authority and path equal the redirect URI's and passes every other request on. The callback answers with a static Chinese and English page that says whether DSH received the authorization or asks the user to retry in DSH; it never echoes callback parameters. Resource headers are excluded from authorization-server requests. A failed attempt's `lastError` is a fixed or local message, such as `MCP OAuth request failed`; when that message omits the upstream cause, the Host logs the cause as a warning with resolved template values, the authorization code, the PKCE verifier, client secrets, and issued tokens replaced by `[redacted]`. Refreshes serialize through the credential provider, preserve the grant identity, and retain the registered token endpoint authentication method; successful reauthorization replaces the identity and connection without entering `waiting-authorization`.

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
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, `serverName` reservation, activation await, host startup |
| [`src/config.ts`](src/config.ts) | Schemas of the stdio, Streamable HTTP, and host configuration shapes, and the OAuth header rule |
| [`src/host.ts`](src/host.ts) | The MCP client host: validation, instances below the host, probes, and authorization owners |
| [`src/connection.ts`](src/connection.ts) | Connection supervisor: client generations, reconnect policy, attempt budget, disposal |
| [`src/generation.ts`](src/generation.ts) | Transport ownership, cancellation, pending work, and confirmed closure |
| [`src/credentials.ts`](src/credentials.ts) | Runtime template binding and redaction of every resolved value |
| [`src/templates.ts`](src/templates.ts) | Credential template syntax, substitution, and reference discovery |
| [`src/server-context.ts`](src/server-context.ts) | Resource-provider registration and literal server instructions |
| [`src/tools.ts`](src/tools.ts) | Tool bridge: discovery, naming, registration swap, execution, image projection |
| [`src/tool-loading.ts`](src/tool-loading.ts) | On-demand loading: loader tool with its prompt catalog as `guidance`, and each agent's loaded tools |
| [`src/transport.ts`](src/transport.ts) | Transport factory: stdio spawn with scrubbed env, Streamable HTTP |
| [`src/status.ts`](src/status.ts) | Status cell keyed by Fiber, retaining its final cleanup result |
| [`src/probe.ts`](src/probe.ts) | One-shot probe: connect, identify, list tools, close — nothing registers |
| [`src/deadline.ts`](src/deadline.ts) | Shared settlement deadline behind the startup, probe, operation, and cleanup budgets |
| [`src/diagnostic.ts`](src/diagnostic.ts) | Cause-chain diagnostics, OAuth failure classification, and secret-value redaction |
| [`src/oauth-options.ts`](src/oauth-options.ts) | OAuth configuration schema |
| [`src/oauth-credentials.ts`](src/oauth-credentials.ts) | Durable grant and client records, with refresh serialized by the credential provider |
| [`src/oauth.ts`](src/oauth.ts) | Explicit browser authorization: callback, flow, and in-flight work under one owner |
| [`src/types.ts`](src/types.ts) | Client-safe connection status, probe outcome, and OAuth attempt types (`./types`) |

The exported `createMcpToolDefinition(ctx, options)` adapts an upstream tool schema and raw-result callback to the same canonical values, errors, and durable image projection. Each callback receives the exact `ToolExecution`, including its Agent and cancellation signal; SDK spec-type validation checks its result before projection. Callers own registration, cancellation deadlines, and provider teardown. The native Cua Driver provider uses this adapter without opening an MCP transport.

### Lifecycle and sync

`apply` resolves the reconnect policy, reserves the `serverName` inside the current registration scope, starts the supervisor, and awaits the initial connection plus discovery. Independent Agent scopes may reuse the same namespace because their tools and transports are isolated; a duplicate inside one scope fails at load. The supervisor serializes every sync — initial, notification, and reconnect — through one queue so two syncs can never interleave their dispose-previous/register-next swap. Disposal cancels pending reconnects, closes the negotiating transport or attached client, waits for the in-flight attempt and queued syncs to quiesce, and unregisters the current generation.

The host's `mount` resolves each instance's status handle once activation finishes. The handle survives reloads of the same Fiber and retains the final connection and cleanup result after disposal; final disposal detaches its observers. Its `registers(definition)` answers whether a tool definition is one of the instance's live registrations — its current generation's tools or, with on-demand loading, its loader tool and the tools Agents loaded — so a plugin that mounts servers per Agent can tell its own tools from inherited ones. Status observers may dispose the Fiber during a reload; cleanup still covers that connection attempt. The host's `probe(config, options)` tests a server without reserving a name or registering tools. Its `timeoutMs` bounds template resolution, connection, and listing together, independently of runtime `startupTimeoutMs`; cleanup uses `closeTimeoutMs` and reports `closeConfirmed` separately. Confirmed transport closure can still carry a `cleanupError`; either unconfirmed closure or a cleanup error blocks replacement.

The SDK receives tool-list changes through legacy notifications or a modern subscription. The supervisor queues each re-sync and republishes the connected tool count; a fetch failure keeps the previous generation registered, while a registration conflict rolls back the attempted generation and closes the connection before applying the reconnect policy. Each outage shares one attempt budget: after `maxAttempts` consecutive failures the tools are unregistered and reconnection stops, and a connection that stays up past `maxDelayMs` resets the budget.

With `expandTemplates` or OAuth enabled, failure diagnostics name the operation and keep the cause chain with every resolved value and OAuth access token replaced by `[redacted]`. With both disabled, diagnostics retain the full error text.

### Tool execution internals

A tool call uses the SDK with the raw name, complete tool definition, JSON arguments, abort signal, and configured timeout. The SDK owns protocol validation and modern request headers. The bridge checks structured content against the advertised output schema itself, with the SDK's Node Ajv validator, because the SDK reports its own check as a `ProtocolError` that cannot be told apart from a server's JSON-RPC error. Canonical success is `{ content: JsonValue[], structuredContent? }`, preserving valid MCP JSON blocks for programmatic and PTC mode callers; each image block admitted to durable model context also carries its `attachment` reference, which PTC mode turns into an `Image`. An MCP `isError` result throws `McpToolError` with `MCP_TOOL_ERROR` before image persistence. Other tool and resource request failures throw `McpToolError`: after `MCP_CONNECTION_CLOSED` or `MCP_TIMEOUT` the request's outcome is unknown, `MCP_SERVER_UNAVAILABLE` means the request did not run, because it was not sent or the server rejected it for an expired session, `MCP_INVALID_RESULT` rejects a result that violates the MCP result schema or the advertised output schema, or an output schema that cannot be compiled, `MCP_UNSUPPORTED_TASK_EXECUTION` rejects the tool, and `MCP_REQUEST_FAILED` carries the JSON-RPC or SDK code in its message. Closure of the connection generation surfaces as `McpLocalError` with `MCP_CONNECTION_CLOSED`, and caller cancellation as the tool registry's `ABORTED`. `McpLocalError` codes also report local connection failures: `MCP_TIMEOUT`, `MCP_CREDENTIALS_UNAVAILABLE`, `MCP_CREDENTIAL_NOT_FOUND`, `MCP_INSTRUCTIONS_TOO_LARGE`, and `MCP_TOOL_REGISTRATION_FAILED`. The bridge validates each image batch before saving it; a refusal projects every image as diagnostic text. For a server that does not advertise `resources`, resource and template lists return empty pages without calling the SDK, whose fallback writes a diagnostic to stdout, where the ACP profile carries JSON-RPC.

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

After discovery succeeds, SDK-admitted MCP tools appear as native tools named `mcp__<serverName>__<rawName>` (or their deterministic normalized form), with the server description and input schema. A re-sync replaces the generation; disposal or an exhausted reconnect budget removes it. A server without the tools capability connects with an empty tool set. In PTC mode, each tool's SDK output declaration documents its `content` array: `MCP content blocks in order. An image block is an Image when the program can read it; otherwise it is the raw MCP block.`

#### Token effect

The tool descriptions and input schemas enter every request while the tools are registered, and PTC mode adds the one-line `content` comment to each output declaration; re-syncs replace rather than accumulate schemas, and the server-qualified name adds tokens to every tool definition and call. A configured client also enables the [shared resource tools and server-name prompt](../mcp-resources/README.md#model-experience).

#### KV Cache effect

The tool-definition prefix stays stable while the discovered set and schemas are unchanged. A re-sync that adds, removes, renames, or changes a tool replaces definitions and may invalidate reuse from the first changed schema token onward; a reconnect that recovers an unchanged list reproduces identical definitions and stays prefix-stable.

### Tool-call history and results

#### What the model sees

The public tool name and JSON arguments remain in assistant history. The canonical value retains the complete MCP JSON blocks and optional structured content for programmatic and PTC mode callers; supported image blocks project beside text in their original order after exact route-capability proof. When the program can read every image the final result keeps, a PTC program receives those image blocks as `Image`s that `inspect` shows as pictures, not base64, and the result's text and pictures enter the conversation only when inspected; otherwise the program receives the raw blocks and the complete result content is attached as additional context. Refused images, audio, embedded resources, resource links, and unknown blocks remain visible as bounded text diagnostics, and MCP `isError` rejects the call before image persistence.

#### Token effect

Arguments, mapped text, and durable image references are retained until compaction. Inline MCP base64 stays only in the execution-local canonical value and is never copied into a session event; the provider reads verified bytes from the attachment store. Audio and embedded-resource payloads stay out of model context.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### On-demand tools

#### What the model sees

An on-demand server contributes one tool, `mcp__<serverName>__load_tools`, and a system prompt section titled `On-demand tools from MCP server <serverName>` that lists each tool's raw name and summary. The section is the loader's `guidance`, so it appears only for an agent that can call the loader. When a generation is withdrawn, a Session that saw the section receives `The earlier instructions from mcp:<serverName>:tools no longer apply.`, and the next generation adds the section again; a Session resumed without the loader keeps the catalog it saw without that notice. A load returns the public names it added or found already loaded; the next request carries their definitions, and the session log records the tool addition.

#### Token effect

Until an agent loads a tool, the server costs the loader definition and one catalog line per tool, each summary capped by `catalogDescriptionMaxLength`, instead of every tool definition. Each loaded tool adds its full definition to that agent's requests.

#### KV Cache effect

A load changes the agent's tool list. Routes that declare tool updates append the addition and keep the prefix; other routes start a new request series. A changed server tool list appends the updated catalog section, as changed server instructions do.

### Server instructions

#### What the model sees

One server-labeled section contains the nonblank instructions returned by each successful connection. Absent or blank instructions add no prompt text. Braces remain literal. A replacement connection publishes its instructions only after discovery succeeds; disposal, lost authorization, or exhausted recovery withdraws them. In a Session that already received a server's instructions, a change or withdrawal appends a system message with the notice `The earlier instructions supplied by MCP server "<name>" no longer apply.`, followed by the new instructions when there are any. The earlier text stays in history until compaction.

#### Token effect

Server instructions contribute text to model requests while their scoped section is active. A change or withdrawal adds one short notice, and the superseded text remains until compaction. Resource documents enter history only through explicit resource reads.

#### KV Cache effect

Unchanged instructions retain identical prompt text. Changed or withdrawn instructions append a system message after the existing conversation prefix instead of rewriting the earlier prompt. Provider cache reuse depends on the adapter's representation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe what you cannot do with this plugin and when it needs operational attention. They are current package constraints, not a comparison with other MCP clients or a task backlog.

- **Resources are read on demand** — shipped profiles provide the [shared resource service](../mcp-resources/README.md); resource subscriptions and MCP prompt templates are unsupported.
- **Whole-attempt startup budgets are opt-in** — `startupTimeoutMs` covers template resolution, negotiation, connect, and the initial tool sync when configured. A notification-driven re-sync's `tools/list` requests use the MCP SDK's 60-second request default and page limit. Plugin unload closes the transport to interrupt pending startup requests before awaiting teardown.
- **Reconnect handles failed negotiation, transport close, and an expired Streamable HTTP session** — a failed initial connection, a crashed stdio child, or a request the server rejects for its session (HTTP 404, or HTTP 400 whose body mentions the session or an uninitialized server) uses the configured reconnect budget. A tool call whose own request the server rejected did not run and is sent once more on the new connection; it runs in the new session, and its result carries no notice that state the server kept for the old session may be lost. That call fails with `MCP_SERVER_UNAVAILABLE` instead when reconnection is disabled, the next connection attempt fails or takes longer than `toolCallTimeoutMs`, the tool is no longer listed, or the new session is rejected as well. The connection stays open for the reconnect delay after the first rejection, so each parallel call receives its own answer; a request still unanswered when the delay ends fails once with `MCP_CONNECTION_CLOSED` and is not sent again. A rejected resource request fails with `MCP_SERVER_UNAVAILABLE` and is not sent again. A server that reports an expired session with HTTP 200 and a JSON-RPC error is not detected. Other HTTP request failures use the SDK transport's recovery; credential changes replace the connection.
- **Image is the only durable rich-result bridge** — PNG, JPEG, WebP, and GIF enter Native context after exact capability proof. Audio and embedded-resource payloads remain execution-local with explicit diagnostics, while resource links preserve only their name and URI as text.
- **Invalid protocol results or output schemas fail through the SDK** — the bridge does not accept legacy `toolResult` substitutes or bypass advertised schema validation.
- **OAuth authorization needs a browser that reaches the Host web server directly** — the callback is that server's own origin: its bind address and port, over HTTPS when it serves TLS. A browser that reaches DSH only through a proxy or the Web app's `publicUrl` cannot finish authorization. A dynamic client registration is keyed by that callback, so a changed bind address or port, or a random port, registers a new client at the next explicit authorization; sign-out keeps the previous registration record.
- **On-demand loading is outside tool restrictions** — loaded tools live in the calling agent's own scope, which `tools.restrict()` allow and deny masks do not filter, and an `allow` mask rejects names absent from the inherited tool list. Deny a loadable tool by name with an execution guard (`tools.guard`). In PTC mode a program binds its tools when it starts, so a tool loaded inside `run_code` becomes callable from the next program.
- **A catalog can outlive its server across restarts** — a retirement is detected only for a source this process saw, so a Session resumed in a process without the server's loader keeps the catalog it saw without a notice ([source lifecycle](../../core/system-prompt/README.md#known-limitations-and-deferred-work)).
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
