# Agent Note: Plugin-registered MCP server manager

Status: implemented

English | [中文](2026-08-31-mcp-manager-plugin.zh.md)

## Problem

Installed application plugins bring their own MCP servers. Each must add its server without editing the user's configuration or depending on another application, and disabling or uninstalling the plugin must withdraw the server's tools. A management surface must show each server's connection status and recover a server that stopped reconnecting. One `dsh-mcp-client` row per server in `cordis.yml` cannot express a plugin-owned server, the client plugin exposed no status beyond log lines, and its activation inherited an unbounded SDK startup wait.

## Decision

`packages/mcp/mcp-manager` is a service plugin (`ctx.mcpServers`) that reconciles a fleet of ordinary `dsh-mcp-client` child instances from plugin registrations; `packages/mcp/mcp-client` owns connection supervision, status, and per-attempt startup budgets.

**Plugins register servers as effects.** `register(name, entry)` adds one Streamable HTTP server for the calling plugin's lifetime and returns the effect disposer. The plugin manager's existing enable, disable, and uninstall operations therefore decide when a plugin's server exists, and the registration's disposal awaits the instance's unmount so the tools are gone when the plugin's disposal settles. Registered names share one namespace; an invalid or taken name throws at registration.

**Children are plugin instances, not library calls.** Each registration mounts `dsh-mcp-client` under the manager's fiber via `ctx.plugin()`. That reuses the tested activation/disposal semantics, makes `serverName` reservations collide correctly with statically composed instances (surfaced as a `failed`/`load` status with the actionable message), and lets manager disposal unwind every instance and its tools through ordinary fiber teardown.

**The registration decides the instance.** Removing a registration disposes its child instance, and `restart` replaces the instance with a fresh reconnect budget. Reconciliation and `restart` serialize on one operation tail. The manager retains a failed cleanup record and refuses a replacement until the Host restarts, preventing overlapping server lifetimes.

**Status belongs to the child Fiber.** The supervisor publishes a cell read through `connectionStatusOf(fiber)`. It survives reloads of that Fiber and remains readable after disposal, which detaches observers. Fiber identity distinguishes instances across registration scopes without identity tokens in status payloads. The manager aggregates cells into `list()` and absorbs equal statuses. Removed registrations with incomplete cleanup remain listed.

**mcp-client startup budget.** `startupTimeoutMs` is optional for standalone clients; the manager supplies its own `startupTimeoutMs` (default 30 seconds) to every registration.

**The manager is its own Remote surface.** `McpServerManager` is a Typert Remote service: `watch` streams the complete server list on subscription and after every status or registration change, and `restart` calls the Host operation. The manager exposes no write method, so a browser cannot define a server.

OAuth is deliberately out of scope: the credential-record and authorization seams plus the MCP SDK's `OAuthClientProvider` are the intended home, and a `needs-auth` status state is reserved for that change.

## Alternatives considered

**Settings-configured servers.** Rejected: a volatile `servers` Config edited through Settings would also need stdio entries, `${credential:REF}` templates, write-time cross-field validation, an `enabled` flag, a probe, and a status event for a management page. No product surface writes that configuration, and every connector plugin registers its server.

**Call `startConnection()` as a library instead of mounting child plugins.** Rejected: it forks the lifecycle from statically composed instances, loses the reservation collision check, and re-implements activation/disposal quiescence the plugin already proves under test.

**Let plugins write their entry into a manager configuration.** Rejected: bundle patches replace the whole map, so two plugins cannot each ship an entry; a plugin must discover the manager's namespace and revision; a configuration write returns before reconciliation, so the plugin restarts the entry to wait and mounts it twice; and uninstalling the plugin leaves an enabled entry whose tools stay live.

**Broadcast per-instance status as a Cordis event from mcp-client.** Rejected: preset-scoped instances can share names, requiring identity tokens in event payloads. A Fiber-owned handle identifies the instance directly, and the manager aggregates the handles.

**Poll status from the management surface.** Rejected: `watch` pushes each change; peers that shipped polling (Reasonix) or lacked a status event (OpenCode v1) treat it as a defect to fix.

**A capability seam (Definition/Provider/Consumer) for "MCP management".** Rejected: one implementation and no independently evolving roles; a seam without a second provider is structure without an owner.

## Testing

mcp-client unit tests cover status transitions, startup budgets, same-Fiber reloads, final readable status, observer containment, cancellation, and separate close and cleanup outcomes. Manager tests use real Cordis to cover registrations and their name collisions, restart, the `watch` stream, failed-cleanup retention, and removal or disposal during pending work. A real Loader composition test mounts the server a composed plugin registers and withdraws it with that entry. Keyless e2e exercises real stdio and HTTP servers, including crash recovery. Both packages meet the per-file 100% coverage gate.

## Consequences

- Plugins own their servers through registrations; management surfaces use `list()`, `watch`, and `restart`. Reconnect and `restart` recover connection failures; incomplete cleanup requires a Host restart.
- Liveness relies on transport closure and request failures; a Streamable HTTP server that stalls without closing is noticed when a request fails.
- A restarted server's tools remain unavailable until the replacement completes its initial sync. Replacement waits for confirmed transport closure and successful local cleanup.
- The manager governs the global plane only; preset-scoped and static instances stay outside its list.
- `startupTimeoutMs` bounds startup attempts, while notification-driven re-sync requests still ride the SDK's request default — recorded as an mcp-client limitation.
