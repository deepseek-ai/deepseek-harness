# MCP

English | [中文](mcp.zh.md)

## Summary

Model Context Protocol (MCP) connects the model to tools supplied by external servers. Each configured server contributes ordinary harness tools with cancellation, permission checks, recorded results, and supported image output. Shared tools discover and read resources when a server is configured in the caller's scope, while server instructions join the logged system prompt. The official SDK negotiates modern or supported legacy protocol revisions. This reference covers the MCP package group's responsibilities, scope, and composition choices; the [client README](../../packages/mcp/mcp-client/README.md) owns server configuration.

## Table of Contents

- [Configuration](#configuration)
- [Responsibilities and scope](#responsibilities-and-scope)
- [Protocol and results](#protocol-and-results)
- [Resources and instructions](#resources-and-instructions)
- [Resource provider types](#resource-provider-types)
- [Limits](#limits)
- [Further reading](#further-reading)

-----

<a id="configuration"></a>
## Configuration

MCP servers are opt-in. Configure one `@deepseek-ai/dsh-mcp-client` entry per server in the intended Cordis scope. Every shipped profile supplies the [tool registry](tools.md) and mounts the shared resource service once; users configure only client entries. Callers with no visible configured server receive no MCP prompt text or tools in native or PTC mode.

| Choice | Configuration owner |
|---|---|
| Server identity, local process or HTTP endpoint, credentials, and process environment | [Client configuration](../../packages/mcp/mcp-client/README.md#use-this-package) |
| Tool and resource request timeout, startup failure policy, and reconnection | [Client configuration](../../packages/mcp/mcp-client/README.md#use-this-package) |
| Resource discovery and reading | The [MCP resource service](../../packages/mcp/mcp-resources/README.md#use-this-package) is included in shipped profiles; it has no configuration fields |
| Server instruction size limit | Client `maxInstructionBytes`; the composition supplies [system-prompt assembly](system-prompt.md) |
| Permission decisions and supported image output | [Tool execution](tools.md) and [attachments](attachment.md) |

Protocol negotiation follows the SDK's supported revisions; there is no product setting that forces a protocol revision. The [configuration catalog](../config-catalog.md#deepseek-aidsh-mcp-client) lists accepted client fields and defaults.

-----

<a id="responsibilities-and-scope"></a>
## Responsibilities and scope

The client is a per-server connection plugin and a consumer of the harness tool registry. It does not publish a shared `ctx.mcp` service. The external server implements MCP operations; the SDK owns protocol exchange; the client adapts discovered tools to harness execution.

`mcp-resources` owns the shared resource tools and selects providers in the caller's scope. Each MCP client supplies resource operations through its own connection. The first provider in a scope enables the local shared tools, and removing the last removes them; inherited providers remain visible. The service owns these tool registrations independently of any one client. Connection failures do not remove shared resource tools while a visible client entry remains active.

Configured `serverName` identifies a server in its registration scope. Two entries in that scope cannot reserve the same name; separate Agent scopes can reuse it. Public tool names include the configured server name, so equally named tools from different servers remain distinct. Registration effects own names and discovered tools; plugin disposal closes the connection and removes its contributions.

The [native Cua Driver provider](../../packages/experimental/computer-use-cua-driver-native/README.md) shares the client's exported result adapter without opening an MCP connection. Desktop provider selection belongs to the [computer-use subsystem](computer-use.md).

-----

<a id="protocol-and-results"></a>
## Protocol and results

Both stdio and Streamable HTTP use the official SDK's negotiation, discovery, protocol validation, and cancellation. Tool-list changes trigger discovery through legacy notifications or a modern subscription. A failed refresh retains the previous tool generation; connection recovery follows the [client lifecycle](../../packages/mcp/mcp-client/README.md#use-this-package).

The result adapter retains canonical MCP JSON for programmatic callers and prepares ordinary tool content. Supported images use the attachment system; unsupported rich content produces explicit text diagnostics. The tool registry remains authoritative for policy failures and replaced results. The [tool contracts](tools.md) own recording and final presentation; the [client result reference](../../packages/mcp/mcp-client/README.md#use-this-package) owns MCP-specific projection details.

-----

<a id="resources-and-instructions"></a>
## Resources and instructions

Resource calls require an explicit configured server name. When system-prompt assembly is available, the resource service lists caller-visible names from the same registry used for dispatch, including servers with no tools or instructions. The shared registry resolves that name in the calling Agent's scope before dispatch; unavailable servers fail without a network request. Discovery and reads are on demand, including for servers that expose resources without tools. The [resource package](../../packages/mcp/mcp-resources/README.md) owns pagination and content rendering; its generated tool schemas live in the [tool catalog](../tool-catalog.md#deepseek-aidsh-mcp-resources).

Resource providers remain connection-owned. Scope disposal removes registrations; the MCP client controls cancellation and recovery. Canonical results retain complete JSON for programmatic callers, while the text projection replaces binary blobs with descriptions. Returned text enters ordinary tool history; content is not fetched merely because a server connects.

When system-prompt assembly is composed, the client publishes nonblank server instructions as a scoped, server-attributed section. Instructions remain literal text and pass the configured size limit before publication. A replacement connection publishes instructions only after discovery succeeds; absent instructions add no section. The [system-prompt subsystem](system-prompt.md) owns assembly and recording.

-----

<a id="resource-provider-types"></a>
## Resource provider types

The connection provider receives one operation and the original tool execution, including its caller and cancellation signal.

```ts type-equiv
/** One supported resource operation, with server-owned cursors and URIs. */
type McpResourceRequest =
  | { method: 'resources/list' | 'resources/templates/list'; cursor?: string }
  | { method: 'resources/read'; uri: string }
```

```ts type-equiv
/** One configured server's resource access, owned by its MCP connection plugin. */
interface McpResourceProvider {
  /**
   * Run an operation against one live connection generation.
   * @param request - MCP resource method and parameters.
   * @param exec - caller identity and cancellation for this invocation.
   * @returns the protocol result as lossless JSON.
   */
  request(request: McpResourceRequest, exec: ToolExecution): Promise<JsonValue>
}
```

-----

<a id="limits"></a>
## Limits

MCP prompt templates, human-input elicitation, task-based execution, and resource subscriptions are unsupported. Resource tools require a caller-visible configured server; binary resources remain programmatic data with text descriptions for the model. Servers without a tools capability connect with an empty tool set. Connection and discovery timeouts follow the SDK; the client has no separate settings for them.

-----

<a id="further-reading"></a>
## Further reading

- [MCP package group](../../packages/mcp/README.md) — package entry points.
- [MCP resources](../../packages/mcp/mcp-resources/README.md) — shared tools and resource-provider semantics.
- [Resource visibility decision](../../.agents/notes/implemented/feature/2026-09-13-mcp-resources-in-profiles.md) — shared profile mounting and visibility from configured servers.
- [Third-party memory servers](../user/guide/mcp-memory.md) — product configuration guide.
- [Protocol negotiation decision](../../.agents/notes/implemented/feature/2026-09-12-mcp-sdk-protocol-negotiation.md) — SDK ownership and compatibility decisions.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmcpresources--mcpresourceruntime"></a>

### `ctx.mcpResources` — `McpResourceRuntime`

Scoped resource access plus three tools shared by configured MCP servers.

```ts cordis-catalog
/**
 * Register one server and expose resource tools while that scope has providers.
 * @param server - configured server name, unique in this scope.
 * @param provider - connection-owned resource operations.
 * @returns the effect disposer for this exact registration.
 */
register(server: string, provider: McpResourceProvider): () => void
```

Source: [`packages/mcp/mcp-resources/src/index.ts`](../../packages/mcp/mcp-resources/src/index.ts)
<!-- END GENERATED cordis-surface -->
