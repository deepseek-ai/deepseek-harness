---
description: "Discover and read MCP resources on demand with shared tools, explicit server selection, and agent-scoped access."
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-resources

English | [中文](README.zh.md)

## Summary

`dsh-mcp-resources` lets the model discover and read documents from configured MCP servers. Shipped profiles make its three shared tools available automatically when a server is configured in the caller's scope. Each tool requires an explicit server name and reads content only when called. Resource text enters conversation history; binary payloads remain available to programmatic callers and appear as descriptions to the model.

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

Shipped profiles already mount this package once. Configure only the [MCP client](../mcp-client/README.md) entries for the servers you need.

### Server configuration

Use the [client configuration](../mcp-client/README.md#use-this-package) to add a server in the intended scope. This package has no configuration fields.

A caller with no configured MCP server sees no MCP prompt text or resource tools in native or PTC mode. A configured server enables the three shared resource tools, including when another provider mounts its client or the server has no tools or instructions. Connection failures do not remove the shared tools while the client entry remains active; resource calls report the connection error.

### Discover and read

When system-prompt assembly is mounted, the prompt lists server names visible to the calling agent. Call `list_mcp_resources` or `list_mcp_resource_templates` with one of those names as `server`. Without a cursor, the MCP SDK collects the server’s pages. An explicit `cursor` requests that page; pass a returned `nextCursor` unchanged. Read a listed URI or an expanded template with `read_mcp_resource`, using the same `server` name and an explicit `uri`.

Every operation resolves the server in the calling agent's scope. A missing server argument or unavailable server fails before dispatch. The connection owner handles request cancellation, timeouts, and recovery; a failed request remains a failed tool call.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [base](../../bundle/base/README.md) and standalone [sdk-minimal](../../bundle/sdk-minimal/README.md) bundles each own this row:

```yaml
- id: mcp-resources
  name: '@deepseek-ai/dsh-mcp-resources'
```

The first provider in a scope registers its shared tools; removing the last removes those local registrations, while inherited providers and tools remain visible. The resource service owns the shared tool effects independently of the first provider's plugin, so unloading that provider cannot remove tools needed by another server. Provider selection and the server-name prompt use the same scoped registry. Each call resolves its server before dispatch.

Canonical results retain the complete JSON for programmatic callers. The pure text renderer adds server attribution and replaces string-valued `blob` fields with a description of their base64 length; URI, MIME type, and text fields remain in the rendered JSON. The tool pipeline owns recorded results. Server instructions belong to the MCP client and its logged system-prompt section.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Scoped provider selection and server-name prompt context |
| [`src/tools.ts`](src/tools.ts) | Shared resource operations and argument schemas |
| [`src/render.ts`](src/render.ts) | Attributed text projection without inline binary payloads |

No runtime invariant companion is published: tools, prompt names, and dispatch derive from the same effect-owned provider registrations. They supply no independent observation to reconcile; registry-effect checks are not runtime invariants.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover server configuration, execution, and the decisions behind resource access.

- [MCP client](../mcp-client/README.md) — server transports, instructions, and connection lifecycle.
- [Tools subsystem](../../../docs/subsystems/tools.md) — canonical values and model-visible results.
- [Resource visibility decision](../../../.agents/notes/implemented/feature/2026-09-13-mcp-resources-in-profiles.md) — shared profile mounting and visibility from configured servers.
- [Resources and instructions decision](../../../.agents/notes/implemented/feature/2026-09-12-mcp-resources-and-instructions.md) — scope, on-demand access, and excluded mechanisms.

-----

<a id="model-experience"></a>
## Model Experience

### Shared resource tools

#### What the model sees

The [generated tool schemas](../../../docs/tool-catalog.md#deepseek-aidsh-mcp-resources) define three tools shared by all caller-visible configured servers. With none, native schemas, PTC declarations and bindings, and the server-name prompt are absent. Connecting, disconnecting, or retrying an active client leaves these shared tool definitions unchanged. When system-prompt assembly is mounted and providers are visible, the `MCP resource servers` section says `Use list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names as the server argument: <JSON array>.` The names come from the same scoped registry, including servers with neither tools nor instructions. An empty registry contributes no section.

#### Token effect

With no caller-visible configured servers, this package adds no tool or prompt tokens. Otherwise, three shared definitions contribute a fixed schema cost and the server-name section adds a sorted JSON list of visible names. Resource listings and documents add content only when an operation returns them.

#### KV Cache effect

Adding the first caller-visible server or removing the last changes the next tool schema or PTC declaration prefix. Changes to visible names update the server-name section; replacing a provider under the same name leaves that text unchanged. Connection failures alone do not change the shared definitions or names.

### Resource results

#### What the model sees

A successful result starts with `MCP server: <server>`, followed by a newline and the returned JSON. Each string-valued `blob` becomes `[binary resource: <length> base64 characters; available to programmatic callers]`. Server-provided text, metadata, and continuation cursors remain visible.

#### Token effect

Rendered results add text to tool history. Binary descriptions replace the payload's base64 token cost; this package imposes no separate text-size limit.

#### KV Cache effect

Each result appends to history without rewriting earlier results. Later reads can return changed server content and append a different result; the package does not refresh previously recorded content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Resource access is explicit and on demand.

- A configured server without the MCP `resources` capability still appears in the server-name prompt and keeps shared resource tools available. The SDK returns empty resource and template lists; unsupported reads fail.
- `tools.restrict()` checks names supplied by global or ancestor scopes when the filter is registered. Naming a resource tool absent from those scopes fails as an unknown tool. Resource tools registered in the caller's own scope are outside allow/deny masks.
- Resource subscriptions and update notifications are unsupported; call the list or read tools again to obtain current content.
- Binary resources are not projected as native images or audio. Programmatic callers retain their canonical base64 values.
- The caller must supply a server name. The shared tools do not aggregate different servers; pagination follows the MCP SDK.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
