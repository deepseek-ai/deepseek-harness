# Agent Note: MCP client plugin — connect to external MCP servers and bridge their tools

Status: implemented

English | [中文](2026-07-07-mcp-client-plugin.zh.md)

## Problem

The harness had no way to consume tools from the MCP (Model Context Protocol) ecosystem. MCP is the emerging standard for tool servers — GitHub, filesystem, databases, code search, and hundreds of community servers expose tools via MCP. Users want to point the harness at one or more MCP servers and have their tools appear as native model-facing tools, without writing per-server glue code.

The `ToolRuntime` already accepts raw JSON Schema tool definitions (documented in `dsh-tools` README: "Raw JSON-Schema tool definitions (from MCP servers) are still accepted by `ToolRuntime.register()` directly"), and the extension cookbook sketches the intended pattern ("MCP | one plugin per server: discover tools → `ctx.tools.register()`"). The infrastructure was ready; the bridge plugin was missing.

## Decision

### Package

A single package `@deepseek-ai/dsh-mcp-client` at `packages/mcp/mcp-client/`. No capability-seam three-package split — there is no foreseeable second MCP client implementation, and the convention is "don't split preemptively" ([capability seams Agent Note](../architecture/2026-06-13-capability-seams.md)).

### SDK

Use the official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) (`Client`, `StdioClientTransport`, `StreamableHTTPClientTransport`). The harness does not implement its own JSON-RPC — consistent with how ACP delegates to `@agentclientprotocol/sdk`.

### Scope

MCP Client only (no server side — ACP already covers the "expose harness as an agent" role). Bridge **Tools** only — Resources and Prompts are deferred (they require harness-side consumption mechanisms that don't exist yet, and design space is large).

### Plugin shape

Namespace plugin (named exports `name`/`inject`/`Config`/`apply`, no `export default`). `inject: ['tools']`. Each MCP server is one plugin instance in `cordis.yml` — the same package loaded N times with different configs, like `dsh-tool-subagent`.

### Configuration

Flat discriminated union on the `transport` field:

```typescript
interface StdioConfig {
  transport: 'stdio'
  serverName: string          // required namespace, ^[A-Za-z0-9_-]{1,32}$
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  toolCallTimeoutMs?: number  // default 60_000
}

interface StreamableHttpConfig {
  transport: 'streamable-http'
  serverName: string          // required namespace, ^[A-Za-z0-9_-]{1,32}$
  url: string
  headers?: Record<string, string>
  toolCallTimeoutMs?: number  // default 60_000
}

type Config = StdioConfig | StreamableHttpConfig
```

`serverName` is the stable local identity that namespaces this server's tools in the model-facing name (below). It is deliberately user configuration, NOT the remote `serverInfo.name`: the remote name is untrusted input, is not unique across deployments (prod and staging instances of one server report the same name), and may change on server upgrade — none of which may silently rename model-facing tools. A duplicate `serverName` across live instances is a configuration error: the later instance fails at load with an actionable message, never silent shadowing or skipping. A short `serverName` (`gh`) is also the knob for shortening public names.

Example `cordis.yml` usage:

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
      Authorization: !!js `Bearer ${process.env.MCP_TOKEN}`
```

The model sees `mcp__github__create_issue`, `mcp__github__search_code`, `mcp__web__search`.

### Lifecycle

Boot-time from `cordis.yml`. HMR (`@cordisjs/plugin-hmr`) provides hot-swap: editing the yml entry triggers dispose of the old instance (disconnects, unregisters tools) and creation of a new one (connects, discovers, registers). No runtime-dynamic API is provided. Public names are pure functions of `(serverName, rawName)`, so an HMR swap that keeps `serverName` recreates identical model-facing names — session history and permission rules stay valid — and adding or removing an unrelated server never renames an existing tool.

### Tool discovery and registration

Every MCP tool has two names:

- `rawName` — the exact MCP `Tool.name`, used only on the wire (`tools/call`).
- `publicName` — the globally unique model-facing name registered in the `ToolRuntime`:

      mcp__<serverName>__<rawName>

This server-qualified shape is the de-facto standard among multi-server agent clients — every surveyed end-user product qualifies MCP tools by server ([Claude Code](https://code.claude.com/docs/en/agent-sdk/mcp#tool-naming-convention) `mcp__github__list_issues`, [Codex](https://openai.com/index/unrolling-the-codex-agent-loop/) `mcp__weather__get-forecast`, [Gemini CLI](https://geminicli.com/docs/tools/mcp-server/#3-tool-naming-and-namespaces), [VS Code](https://github.com/microsoft/vscode/blob/ab9ec62c6a61e429a9abd612ff220c3f4834c9ea/src/vs/workbench/contrib/mcp/common/mcpServer.ts#L217-L260), [Cline](https://github.com/cline/cline/blob/52fdbb1d72f7324a28142a7ba7678d4b53c902f4/sdk/packages/core/src/extensions/mcp/name-transform.ts#L20-L35), [Roo Code](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/utils/mcp-name.ts#L117-L140), [Goose](https://github.com/block/goose/blob/b3a012cbdde854b0fe14f95b1c48543bf6517c0a/crates/goose/src/agents/extension_manager.rs#L1391-L1441), [OpenCode](https://github.com/anomalyco/opencode/blob/d199b1bff90282a4f9cd6251b5fc7b16875a52f6/packages/opencode/src/mcp/catalog.ts#L117-L120)); the exact `mcp__<server>__<tool>` spelling follows Claude Code and Codex. The `mcp__` marker keeps MCP registrations out of the native tools' namespace and gives permission/telemetry rules a stable shape (`mcp__*`, `mcp__github__*`).

1. On connect: drain `client.listTools()` pagination, derive every tool's `publicName`, then register each as a raw `ToolDefinition` via `ctx.tools.register()`. The MCP JSON Schema and description pass through unchanged (no `defineTool` DSL conversion); only the model-facing `name` is replaced.
2. Listen for `notifications/tools/list_changed` → re-run the same sync (dispose previous generation, register new). Deterministic names mean unchanged tools keep their names across re-syncs.
3. The executor closes over `rawName`; the public name is never sent to the server and never parsed to recover the raw name.
4. No `presentCall`/`presentResult` — UI consumers use the provider-neutral generic-card fallback.
5. Tools are transparent in the system prompt — no "[via MCP]" annotation beyond the name itself.

### Public name normalization

MCP allows tool names up to 128 characters including `.`; the DeepSeek function-name contract allows `[A-Za-z0-9_-]` and at most 64. Public names are normalized deterministically: invalid characters become `_`, and when replacement or truncation changed the name, a 12-hex-char SHA-256 hash of the `(serverName, rawName)` identity is appended so distinct MCP identities can never collapse into the same public name:

```typescript
function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (normalized === joined && normalized.length <= 64) return normalized
  const hash = sha256(`${serverName}\0${rawName}`).slice(0, 12)
  return `${normalized.slice(0, 64 - 13)}_${hash}`
}
```

### Name conflict handling

MCP guarantees tool-name uniqueness only [within one server](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool-names); cross-server collisions are the norm, not the exception (a [Microsoft Research survey](https://www.microsoft.com/en-us/research/blog/tool-space-interference-in-the-mcp-era-designing-for-agent-compatibility-at-scale/#namespacing-issues-and-naming-ambiguity) of 1,470 servers found 775 colliding tool names; `search` alone appears in 32 servers, and the official GitHub server publishes bare `create_issue`). The always-on namespace makes collisions structurally impossible instead of handling them at collision time:

- Two servers publishing `search` coexist as `mcp__github__search` and `mcp__web__search`.
- A native harness tool named `search` is unaffected.
- Duplicate `serverName` config fails the later instance at load (see Configuration).
- A server listing the same tool name twice is an invalid tool list: the sync throws and the previous generation stays registered.
- A registry conflict during the swap can only mean a foreign tool squats on this server's `mcp__<serverName>__` namespace: the partial generation is rolled back (zero tools from this server) and the error is logged loudly.

Tools are never silently skipped; which tools are available never depends on plugin load order.

### Naming invariants

1. Every MCP tool has the stable identity `(serverName, rawName)`; every active identity has exactly one public name.
2. Public names are deterministic, globally unique, and satisfy the DeepSeek 64-char `[A-Za-z0-9_-]` contract.
3. MCP `tools/call` always receives the original raw name.
4. Connecting, disconnecting, or re-syncing an unrelated server never renames an existing tool.
5. Registration order never determines which tool is available.

### Tool execution

A unified `execute` handler for all tools from one MCP server:

1. Resolve `rawName` (the executor closes over it) and call `client.callTool({ name: rawName, arguments }, { signal: exec.signal })` with the configured timeout — the public name is never sent to the server.
2. Preserve canonical success as `{ content: JsonValue[], structuredContent? }`; complete MCP JSON blocks remain the programmatic/PTC mode value. `isError: true` throws before any image persistence so the registry owns the failure path.
3. Prepare a separate ordered Native projection. Text runs join with `'\n'`; resource links preserve name and URI as text; audio, embedded resources, malformed blocks, and unknown types become explicit diagnostics. If any image exists, the bridge strictly decodes the complete batch, resolves the calling agent's latest exact route, requires an attachment store plus explicit model image input, and delegates all-member validation and ordered persistence to `AttachmentStore.saveImages()`. Any decode, capability, or storage refusal renders every image as diagnostic text and returns no partial references.
4. Keep `output.render` synchronous and pure. The executor stages its richer projection in a generation-local `WeakMap` keyed by the exact execution; `finalizeContent` installs it only when the registry's post-execute result still has the original canonical value and fallback content. A policy block, value replacement, or content replacement remains authoritative, and a re-sync cannot let an older generation consume new execution state.
5. PTC mode receives the untouched canonical value. Its generic dispatch bridge defers a successful final content sequence containing an image through the outer `run_code` result, so MCP requires no private parent-token special case.
6. Cancellation: `exec.signal` (from the agent loop's cancel) is passed through to the MCP SDK's `callTool`, exact-model lookup, and the pre-storage gate.

### Subprocess environment (stdio transport)

Build the child environment from the subprocess seam's shared `scrubbedParentEnv()` base, which removes ambient names matching `/KEY|PASSWORD|SECRET|TOKEN/i` and ambient `DSH_*` names, then merge `config.env` on top. Explicit env overrides survive the scrub.

### Disconnection / crash

A per-instance connection supervisor reconnects automatically after a lost connection with bounded exponential backoff and a per-outage attempt budget, re-running discovery on success; exhaustion unregisters the server's tools and stops until reload. The [auto-reconnect Agent Note](../../archived/feature/2026-08-06-mcp-client-auto-reconnect.md) owns that decision, including the `reconnect` config block and the `reconnect.enabled: false` opt-out that restores manual HMR/restart recovery.

## Alternatives considered

### MCP Server side (expose harness tools to external MCP clients)

Deferred. The ACP bridge already exposes the harness as an agent server. Adding an MCP server layer would duplicate that with a different protocol, and the primary user need is consuming external tools, not exposing them.

### Capability-seam three-package split (interface / impl / consumer)

Rejected. There is no foreseeable alternative MCP client implementation — MCP has one protocol, one SDK. The convention is "don't split preemptively" until a second implementation appears.

### Auto-reconnect with exponential backoff

Rejected by the connect-once design: it added a partial-availability state (tools registered but temporarily non-functional), and stdio crashes often indicate configuration problems retrying cannot fix; HMR was the recovery path. Operational feedback reversed the deferral — the [auto-reconnect Agent Note](../../archived/feature/2026-08-06-mcp-client-auto-reconnect.md) implements it with a bounded per-outage budget and an opt-out.

### Bridge Resources and Prompts

Deferred. Resources need a harness-side mechanism to decide WHEN to inject content (system prompt? on demand? model-triggered?). Prompts need a "prompt template" concept the harness lacks. Both require their own design; Tools are the high-value, low-risk starting point.

### Raw model-facing tool names with an optional `toolPrefix`

Rejected — this was the original proposal, built on the premise that "most MCP servers already use semantic prefixes in their tool names (e.g. `github_create_issue`)". The premise is false: the official GitHub server publishes `create_issue`, the reference filesystem server `read_file`, Sentry `search_issues` — and the Microsoft survey above shows collisions are common at ecosystem scale. Collision-time prefixing (or warn-and-skip) also makes the available tool set depend on plugin load order, and a tool could be silently renamed when an unrelated server is added — invalidating session history and permission rules mid-conversation. No surveyed multi-server agent product ships raw names.

### Server-only namespace (`github__create_issue`, no `mcp__` marker)

Rejected. It prevents cross-server collisions but does not separate MCP registrations from native harness tools, and it forfeits MCP-wide policy shapes (`mcp__*`). The marker costs 5 characters; the `mcp__<server>__<tool>` spelling matches Claude Code and Codex, maximizing model familiarity. If the ToolRuntime later grows source-aware namespaces, dropping the literal marker can be revisited as a naming-policy change.

### Deriving the namespace from the server-announced `serverInfo.name`

Rejected. The remote name is untrusted, non-unique across deployments, and changeable on upgrade; tool identity and permission rules must not silently follow it. The namespace is local configuration.

### Preserve multiple TextBlocks in tool result

Rejected. `flattenText()` in the DeepSeek serializer uses `join('')` (no separator) when flattening `ContentBlock[]` to wire format. Multiple text blocks would silently lose inter-block boundaries — a correctness bug. All existing tools return a single TextBlock; the MCP bridge follows suit.

### Replace the canonical MCP result with core `ContentBlock[]`

Rejected. Programmatic callers need protocol-complete MCP blocks and `structuredContent`, while Native consumers need durable core images rather than base64. One canonical protocol value plus a separate projection preserves both contracts.

### Add a generic RichContent service or perform I/O in `output.render`

Rejected. Core already owns the role-neutral content vocabulary, and a second service would duplicate its logging and ordering contracts. `output.render` is pure, synchronous, and replayable, so attachment I/O belongs in async execution with an exact finalization handoff.

### Let each image-returning tool special-case PTC mode parents

Rejected. That couples leaf tools to composite-tool internals and misses future rich tools. The generic PTC mode bridge observes the final post-policy content and forwards image-bearing results uniformly.

## Testing

Coverage is named per tier; each behavior lives at the cheapest tier that can express it.

- **Unit** (`tests/mcp-client.spec.ts`, `tests/apply.spec.ts`, mocked MCP SDK): the `publicToolName` algorithm (clean, normalize, truncate-and-hash, determinism, distinct-identity separation), raw-vs-public wire discipline, cross-server and native-tool coexistence, duplicate-`serverName` load failure and reservation release, invalid-tool-list rejection, generation swap/rollback, failed-re-sync retention, lossless canonical results, mixed rich ordering, atomic malformed batches, exact capability/store refusal, explicit non-image diagnostics, post-execute policy precedence, cancellation, and config schema validation. 100% per-file coverage gates the package.
- **E2E** (`tests/mcp-client.e2e.ts`, keyless): the real MCP protocol against the in-repo fixture server, `@modelcontextprotocol/server-everything`, and `@modelcontextprotocol/server-filesystem` over stdio, and against an in-process `StreamableHTTPServerTransport` server over Streamable HTTP — discovery under the namespace, dotted-name normalization end to end, execution round-trips, durable image save/read with base64 retained only in the canonical value, explicit refusal without an image route, duplicate-`serverName` rejection, and disposal.
- **Snapshot**: the assembled ACP example owns the transport-visible inline-image transcript and the PTC mode image-forwarding transcript; package E2E owns the real MCP wire because the runnable snapshot must stay keyless and deterministic rather than spawning third-party server packages. MCP tool cards still use the generic-card fallback and require no package-specific UI snapshot.

## Consequences

- A `cordis.yml` entry per MCP server is the entire integration cost: `serverName: filesystem` + a stdio command (or a Streamable HTTP URL) puts `mcp__filesystem__read_file` in the model's tool list, callable, with the raw `read_file` on the wire.
- Public names are part of session history and permission/configuration APIs; tests pin the naming algorithm, and changing it after release is a breaking change.
- The `mcp__<serverName>__` qualifier costs tokens on every name. Accepted: descriptions and JSON schemas dominate tool-definition tokens, and the qualifier buys stable identity, collision isolation, and MCP-wide policy shapes (`mcp__*`, `mcp__github__*`).
- **MCP SDK stability**: the `@modelcontextprotocol/sdk` is still evolving; breaking changes require updating the bridge. The version is pinned, and the SDK is widely adopted (Claude Desktop, Cursor, VS Code) so breaking changes are unlikely to be silent.
- **Tool schema quality**: MCP servers may expose poorly-described tools (vague descriptions, incomplete JSON schemas). The harness passes them through as-is — garbage-in-garbage-out; that is the server author's responsibility, not the bridge's.
- **Stdio process management**: a misbehaving MCP server that ignores signals could wedge dispose. The Cordis fiber disposal has bounded quiescence; a stuck transport eventually times out at the framework level.
- Crash recovery is automatic within the [reconnect budget](../../archived/feature/2026-08-06-mcp-client-auto-reconnect.md); manual reload remains the path after exhaustion or with `reconnect.enabled: false`.
- Image payloads can enter model context only through the shared durable attachment store and an exact positive route capability. Audio and embedded-resource payloads remain execution-local with explicit diagnostics.
