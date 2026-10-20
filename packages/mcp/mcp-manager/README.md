---
description: "MCP server manager for plugins that register MCP servers for their own lifetime and for management surfaces that observe and restart them."
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-manager

English | [中文](README.zh.md)

## Summary

`dsh-mcp-manager` manages a live fleet of MCP servers that installed plugins register for their own lifetime. The manager mounts one Streamable HTTP `dsh-mcp-client` instance per registration and unmounts it when the registration ends. `ctx.mcpServers` aggregates every server's connection status, `restart` recovers a server whose reconnect budget ran out, and `watch` streams the server list to Remote clients.

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

Mount the manager once per Host. The Web and Desktop profiles mount it as the `mcp-manager` row of [`dsh-web-app`](../../bundle/web-app/README.md).

### When to choose it

Choose the manager when an installed plugin brings its own MCP server, so the server exists exactly while that plugin is loaded. Keep plain `dsh-mcp-client` rows instead when a deployment pins its servers in the composition, or when a server belongs to one agent preset rather than the whole Host; the manager governs the global plane only.

### Minimal configuration

One `cordis.yml` row mounts the manager:

```yaml
- id: mcp-manager
  name: '@deepseek-ai/dsh-mcp-manager'
  config:
    startupTimeoutMs: 30000
```

| Field | Default | Meaning |
|---|---|---|
| `startupTimeoutMs` | `30,000` | Budget for each registered server's connection attempt plus its initial tool discovery |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-mcp-manager) is the exhaustive source for every accepted field.

### Registering a server from a plugin

A plugin that integrates an MCP service registers its server:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-mcp-manager'

export const name = 'example-app'
export const inject = ['mcpServers']

export function apply(ctx: Context): void {
  ctx.mcpServers.register('example', { url: 'https://mcp.example.com/mcp' })
}
```

`register(name, entry)` mounts a Streamable HTTP instance for `entry.url` whose `serverName` is `name` (`[A-Za-z0-9_-]{1,32}`). The instance uses the mcp-client defaults for tool-call timeout, cleanup budget, and reconnect policy, and the manager's `startupTimeoutMs`. A registration lasts for the calling plugin's lifetime: disabling or uninstalling the plugin through the plugin manager unloads it, and the registration's disposal unmounts the server and withdraws its tools before the plugin's disposal settles. An invalid name, or a name another registration holds, throws at registration.

### Observing and recovering

`ctx.mcpServers.list()` returns each server's `name` and live `status` in registration order. The list includes removed registrations whose cleanup failed; such a row stays until the Host restarts. Cleanup status retains the first diagnostic and reports `closeConfirmed: false` if an instance could not confirm closure.

Reconnection stays inside mcp-client. `restart(name)` replaces an instance and resets its reconnect budget, including after that budget runs out. Unconfirmed transport closure or a local cleanup error blocks replacement for that server; restart the Host to recover.

### Remote operations

Browser clients reach the manager as `ctx.remote.mcpServers` through [`dsh-api-remotes`](../../api/remotes/README.md). `watch(signal)` yields the complete server list on subscription and again after every status or registration change, coalescing changes the subscriber has not read yet; aborting the signal ends that stream, and manager disposal ends every stream. `restart(name)` runs the operation above. The manager adds no write method, so a browser cannot define a server.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions and points at the code; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Registrations are effects.** A registration is an effect of the calling plugin, so its owner's lifecycle decides when the server exists; no plugin writes another plugin's configuration or leaves an entry behind on removal. Runtime records retain instance ownership and cleanup failures.
- **One serialized operation tail.** Reconciles and restarts queue on one chain, so two lifecycle operations cannot interleave one instance's unmount/mount.
- **Connection handling stays in mcp-client.** Children are ordinary plugin instances mounted under the manager's fiber: `serverName` reservations collide correctly with statically composed instances, teardown unwinds tools, and the manager reads each instance's status through `connectionStatusOf` rather than duplicating supervision.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The service: registrations, reconcile, restart, watch, status registry |
| [`src/types.ts`](src/types.ts) | The status union and list view (`./types`) |

### Lifecycle notes

Child startup does not hold the operation queue open. A removed registration stops forwarding child status before queued cleanup; replacement waits for the child to finish cleanup. Equal status publications are absorbed. Cleanup failures remain observable after a registration's removal; disposal ends every `watch` stream.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [mcp-client README](../mcp-client/README.md) — the per-instance bridge: naming, reconnect policy, tool execution, status surface.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-mcp-manager) — every accepted config field.
- [MCP manager Agent Note](../../../.agents/notes/implemented/feature/2026-08-31-mcp-manager-plugin.md) — the design decisions, peer-product survey, and rejected alternatives.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `dsh-mcp-client` instances it mounts, whose server-qualified tools and schemas enter requests; the manager itself registers no prompt or tool content.

#### KV Cache effect

No direct invalidation; mounting, rebuilding, and unmounting instances changes tool definitions exactly as the mcp-client README documents, and the manager adds no request content of its own.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what you cannot do with this manager today. They are current package constraints, not a task backlog.

- **No OAuth flow** — a server answering with an authorization challenge surfaces as an ordinary connection failure and reconnect churn; there is no needs-auth state, token storage, or interactive sign-in.
- **Global plane only** — instances mounted by agent presets or static `cordis.yml` rows are neither listed nor governed; a static instance shows up only as a `serverName` collision when a managed entry tries to reuse its name.
- **A restart has a tool gap** — a restarted server is disposed and remounted, so its tools disappear from the model's set until the new instance finishes its initial sync; there is no keep-serving-until-replacement handover.
- **Registrations are Streamable HTTP endpoints with client defaults** — a registration sets only its URL, so the manager mounts no stdio server and applies the mcp-client defaults for tool-call timeout, cleanup budget, and reconnect policy; a plugin that needs other settings mounts its own `dsh-mcp-client` instance.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Note.

- OAuth belongs on the credential-record and authorization seams plus the MCP SDK's `OAuthClientProvider`; a `needs-auth` status state is reserved for it.
- Rolling replacement (start the new instance before disposing the old, keeping public tool names stable) would close the restart gap; peer products do this with a proxy generation.
- Per-server tool allow/deny lists are a natural registration extension once a consumer needs them.

</details>
