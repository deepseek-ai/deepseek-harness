# Agent Note: Settings-driven MCP server manager

Status: implemented

English | [中文](2026-08-31-mcp-manager-plugin.zh.md)

## Problem

One MCP server was one `dsh-mcp-client` row in `cordis.yml`. That is right for composition-pinned servers and wrong for the product goal of managing servers from a Web surface: adding, editing, testing, enabling, disabling, deleting, and recovering servers at runtime, with connection status visible per server. The client plugin exposed no status beyond log lines, activation inherited an unbounded SDK startup wait, and there was no way to test a configuration without mounting it. A survey of six peer agent products (Claude Code, Codex, OpenCode, Kimi Code, DeepSeek-Reasonix, Pi) converged on the same shape: a config registry, a management facade, and a connection-state machine with a status-to-action mapping, secrets never round-tripping to the surface.

Installed application plugins also bring their own servers. Each must add its server without editing the user's configuration or depending on another application, and disabling or uninstalling the plugin must withdraw the server's tools.

## Decision

`packages/mcp/mcp-manager` is a service plugin (`ctx.mcpManager`) that owns the volatile `servers` configuration and reconciles a fleet of ordinary `dsh-mcp-client` child instances; `packages/mcp/mcp-client` owns connection supervision, status, probing, and per-attempt startup budgets.

**Configuration is volatile Config, and CRUD needs no new API.** Settings projects the manager entry’s Config under its Loader id; ConfigEditor owns profile persistence, inheritance, and revision checks. Settings edits retain inherited servers, and resetting an inherited entry restores its base value. Direct profile patches replace the complete `servers` map. Loader commits the reference before notifying the manager’s existing reconcile queue.

**Plugins register servers as effects.** `register(name, entry)` adds one server for the calling plugin's lifetime and returns the effect disposer; the entry takes every configured field except `enabled` and passes the same validation. The plugin manager's existing enable, disable, and uninstall operations therefore decide when a plugin's server exists, and the registration's disposal awaits the instance's unmount so the tools are gone when the plugin's disposal settles. Registered and configured names share one namespace: a registration refuses a configured name, and a settings write refuses a registered name. Registrations stay out of Settings.

**A flat entry schema, validated cross-field.** The entry is flat with a `transport` discriminant, and write-time validation enforces the per-transport requirements and rejections (missing `command`/`url`, cross-transport fields, malformed templates) at the write — a schema-valid-but-unserviceable entry is never stored, and refusals name the offending field where a union's shape error would not.

**Children are plugin instances, not library calls.** Each enabled entry mounts `dsh-mcp-client` under the manager's fiber via `ctx.plugin()`. That reuses the tested activation/disposal semantics, makes `serverName` reservations collide correctly with statically composed instances (surfaced as a `failed`/`load` status with the actionable message), and lets manager disposal unwind every instance and its tools through ordinary fiber teardown.

**Whole-entry identity; `enabled` controls mounting.** A changed entry rebuilds the child instance; disabling or deleting it disposes the child. Reconciliation and `restart` serialize on one operation tail. Probes run independently, and configuration changes cancel affected probes before queued cleanup waits for them. The manager retains a failed cleanup record and refuses a replacement until the Host restarts, preventing overlapping server lifetimes.

**Status belongs to the child Fiber.** The supervisor publishes a cell read through `connectionStatusOf(fiber)`. It survives reloads of that Fiber and remains readable after disposal, which detaches observers. Fiber identity distinguishes instances across registration scopes without identity tokens in status payloads. The manager aggregates cells into `list()` and the `mcp-manager/status` event, absorbing equal statuses and remaining silent after disposal. Removed entries with incomplete cleanup remain listed with `configured: false`. The first reconcile waits for the manager’s own Fiber activation because strict service reads require an active Fiber.

**Templates keep secrets out of configuration.** Stored env and header values remain readable; a value that must stay hidden belongs in a template. The manager passes raw templates into the child Fiber. Opt-in mcp-client expansion resolves `${credential:REF}` from the current provider, whose local implementation also reads the inherited environment, so there is no separate environment scheme. Missing values leave non-strict clients waiting for credentials; referenced credential notifications can recover them. A changed value replaces the connection only after cleanup succeeds, while a same-value notification preserves the connection and retry budget. Diagnostics, tool-call failures, and `isError` results keep upstream text with every resolved value replaced by `[redacted]`, so the model can act on a server's error without seeing a secret the instance sent.

**mcp-client budgets and probe.** `startupTimeoutMs` is optional for standalone clients; the manager explicitly supplies a 30-second default. `probeServer(ctx, config, options)` connects, reads server identity, lists tool names, and closes without reserving a name or registering tools. Its own budget and configurable listing caps are independent of runtime startup. Probe success and transport closure are separate results, so successful discovery cannot hide incomplete cleanup.

**The manager is its own Remote surface.** `McpServerManager` is a Typert Remote service: `watch` streams the complete server list on subscription and after every status or entry change, and `restart` and `probe` call the Host operations. Configuration writes remain on the Settings Remote, and the manager exposes no write method, so a browser cannot define a server command.

OAuth is deliberately out of scope: the credential-record and authorization seams plus the MCP SDK's `OAuthClientProvider` are the intended home, and a `needs-auth` status state is reserved for that change.

## Alternatives considered

**Manage each server as a separate Loader entry.** Rejected: the manager needs one server list with status, restart, and probe. Settings and ConfigEditor already edit its dictionary with inheritance, validation, and revision checks; the runtime child instances need no separate persisted entries.

**Call `startConnection()` as a library instead of mounting child plugins.** Rejected: it forks the lifecycle from statically composed instances, loses the reservation collision check, and re-implements activation/disposal quiescence the plugin already proves under test.

**Let plugins write their entry into the manager's Settings namespace.** Rejected: bundle patches replace the whole `servers` map, so two plugins cannot each ship an entry; a plugin must discover the manager's namespace and revision; a settings write returns before reconciliation, so the plugin restarts the entry to wait and mounts it twice; and uninstalling the plugin leaves an enabled entry whose tools stay live.

**Forward `mcp-manager/status` to clients instead of streaming lists.** Rejected: the Remote event carrier forwards only `emit` events, which do not contain listener failures, and a client would read `list()` after each event to see removals and authorization state.

**Broadcast per-instance status as a Cordis event from mcp-client.** Rejected: preset-scoped instances can share names, requiring identity tokens in event payloads. A Fiber-owned handle identifies the instance directly; the manager supplies the single aggregated event.

**Poll status from the management surface.** Rejected: the Remote plane already forwards Host events; peers that shipped polling (Reasonix) or lacked a status event (OpenCode v1) treat it as a defect to fix.

**A capability seam (Definition/Provider/Consumer) for "MCP management".** Rejected: one implementation and no independently evolving roles; a seam without a second provider is structure without an owner.

## Testing

mcp-client unit tests cover status transitions, independent startup and probe budgets, template binding and value redaction, same-Fiber reloads, final readable status, observer containment, cancellation, and separate close and cleanup outcomes. Manager tests use real Cordis, profile-backed Settings, and an in-memory credential provider to cover configuration changes, plugin registrations and their name collisions, credential rotation, probe cancellation, the `watch` stream, failed-cleanup retention, and deletion or disposal during pending work. Real composition tests verify inherited servers, profile patches, persisted settings edits, and write-time validation. Keyless e2e exercises real stdio and HTTP servers, including probes and crash recovery. Both packages meet the per-file 100% coverage gate.

## Consequences

- Management operations use Settings for configured add/edit/delete/enable/disable, registrations for plugin-owned servers, `list()`, `watch`, and one event for status, and `probe` for testing. Reconnect and `restart` recover connection failures; incomplete cleanup requires a Host restart.
- Liveness relies on transport closure and request failures; a Streamable HTTP server that stalls without closing is noticed when a request fails.
- A rebuilt server’s tools remain unavailable until the replacement completes its initial sync. Replacement waits for confirmed transport closure and successful local cleanup.
- The manager governs the global plane only; preset-scoped and static instances stay outside its list.
- `startupTimeoutMs` bounds startup attempts, while notification-driven re-sync requests still ride the SDK's request default — recorded as an mcp-client limitation.
