---
description: "MCP server manager for deployments, plugins, and management surfaces that add, edit, register, enable, disable, delete, probe, and observe MCP servers at runtime."
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-manager

English | [中文](README.zh.md)

## Summary

`dsh-mcp-manager` manages a live fleet of MCP servers from two sources: entries in `config.servers` on its profile entry (editable through Settings), and entries that plugins and `@deepseek-ai/dsh-mcp-manager/server` rows register for their own lifetime. The manager mounts one `dsh-mcp-client` instance per enabled entry, adding, rebuilding, disabling, and removing instances live as either source changes. `ctx.mcpManager` aggregates every server's connection status, `restart` recovers a server whose reconnect budget ran out, `probe` tests an entry without touching the live instances, and `watch` streams the server list to Remote clients. `${credential:REF}` templates keep secrets out of entries; mcp-client handles credential rotation inside each instance.

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

Mount the manager once per Host. It creates its own MCP client host, the only way it validates, mounts, probes, and authorizes servers. The Web and Desktop profiles mount it as the `mcp-manager` row of [`dsh-web-app`](../../bundle/web-app/README.md), and the SDK profile mounts the same row through [`dsh-sdk-app`](../../bundle/sdk-app/README.md). Its volatile `config.servers` holds configured entries; Settings uses the owning entry id as its namespace (`mcp` in the examples below). A server can instead be [its own row](#declaring-a-server-as-its-own-row) beside the manager row. Credential templates and OAuth grants resolve through the credentials provider, so compose the row with `inject: [credentials]` wherever entries may use them.

### When to choose it

Choose the manager when the server set changes at runtime: a settings edit or a management surface adds, reconfigures, disables, or deletes configured servers, or an installed plugin brings its own server. Keep plain `dsh-mcp-client` rows instead when a deployment pins its servers in the composition, or when a server belongs to one agent preset rather than the whole Host; the manager governs the global plane only. Among managed servers, declare a server as [its own row](#declaring-a-server-as-its-own-row) when composition layers add, change, or switch servers independently, and keep `servers` for the set that Settings edits.

### Minimal configuration

One `cordis.yml` row mounts the manager; `servers` in its config is optional and becomes the composition base layer:

```yaml
- id: mcp
  name: '@deepseek-ai/dsh-mcp-manager'
  inject: [credentials]
  config:
    servers:
      github:
        transport: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-github']
        env:
          GITHUB_TOKEN: '${credential:GITHUB_TOKEN}'
```

A profile’s `cordis.patch.yml` replaces the entry’s complete `servers` map. Use Settings for partial edits that retain inherited servers; a complete replacement targets the manager entry as follows:

```yaml
- id: mcp
  config:
    servers:
      internal:
        transport: streamable-http
        url: https://mcp.example.com/mcp
        headers:
          Authorization: 'Bearer ${credential:MCP_TOKEN}'
        enabled: true
```

| Field | Default | Meaning |
|---|---|---|
| `servers.<name>` | `{}` | One managed server per key; the key is the instance's `serverName` (`[A-Za-z0-9_-]{1,32}`) |
| `transport` | required | `stdio` or `streamable-http` |
| `command` / `args` / `env` / `cwd` | — | stdio: executable, arguments, extra child env, working directory |
| `url` / `headers` | — | streamable-http: endpoint URL and extra request headers |
| `enabled` | `true` | Durable intent: `false` unmounts the instance and keeps the entry |
| `startupTimeoutMs` | `30,000` | Budget for template resolution, negotiation, connection, and initial tool discovery |
| `toolCallTimeoutMs` / `closeTimeoutMs` / `reconnect` / `toolLoading` | mcp-client defaults | Per-server overrides; `toolLoading: on-demand` lets agents [load the server's tools when they need them](../mcp-client/README.md#on-demand-tool-loading) |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-mcp-manager) is the exhaustive source for every accepted field.

<a id="declaring-a-server-as-its-own-row"></a>
### Declaring a server as its own row

A `@deepseek-ai/dsh-mcp-manager/server` row declares one server beside the manager row. Its config is `serverName` and the fields of one `servers` entry except `enabled`:

```yaml
- id: mcp
  name: '@deepseek-ai/dsh-mcp-manager'
  inject: [credentials]

- id: mcp-server-github
  name: '@deepseek-ai/dsh-mcp-manager/server'
  config:
    serverName: github
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: '${credential:GITHUB_TOKEN}'
```

A later composition layer — a bundle patch, the profile’s `cordis.patch.yml`, or a `--patch` overlay — changes one server without restating the others, which a layer that sets `servers` cannot do. `insert` adds a row, and an entry naming an existing row’s `id` overrides the keys it lists: `disabled: true` switches that server off, and a listed `config` replaces that row’s complete config.

```yaml
- insert:
    - id: mcp-server-internal
      name: '@deepseek-ai/dsh-mcp-manager/server'
      config:
        serverName: internal
        transport: streamable-http
        url: https://mcp.example.com/mcp
        headers:
          Authorization: 'Bearer ${credential:MCP_TOKEN}'

- id: mcp-server-github
  disabled: true
```

A server row is an ordinary Loader entry that registers its server for the row's lifetime, so composition changes are the server operations. A new row registers and mounts its server. A row whose `config` changes restarts alone: the manager unmounts and remounts that one server while the other servers keep running. `disabled: true`, or a composition that no longer lists the row, unloads it: the manager unmounts the server, withdraws its tools, and stops listing it. A broken row — a missing `command`, a cross-transport field, a malformed template, or a `serverName` or `oauth.credentialKey` another server already uses — fails alone: the Host warns that the row did not activate, and the other servers start. [Profiles](../../boot/app-boot/README.md#profiles) documents the patch files and when a running Host applies them; [startup and reload failures](../../boot/app-boot/README.md#startup-and-reload-failures) documents the warning.

Rows and `servers` entries share one namespace of server names. A row that names a server a `servers` entry holds fails, including an entry with `enabled: false`, and the entry keeps serving; a `servers` write that names a server a running row holds is refused. A layer that deletes a `servers` entry and adds the row of the same name in one edit moves the server to the row. A row takes no `enabled` field and fails when its config carries one, so an `enabled: false` copied from a `servers` entry cannot start the server; the row's `disabled` is its switch. Settings lists no server row: a row has no volatile field, so every edit of a row restarts it.

### Managing configured servers

Settings writes persist through ConfigEditor with revision checks; Loader updates the volatile configuration without remounting the manager. Every committed configuration change reconciles the fleet: a new enabled entry mounts, a removed entry unmounts, `enabled: false` unmounts while keeping the entry listed, and any other field change rebuilds that one instance while unchanged siblings keep running. Through Settings, inherited servers can be overridden or disabled; deleting an inherited server restores its base configuration. Only servers added by the user layer are removable. A broken entry — a missing `command`, a cross-transport field, a malformed template, or a name a plugin already registers — is refused at the write, so the document never stores a server the manager cannot act on.

`env` values, `headers` values, `command`, `args`, `cwd`, and `url` accept `${credential:REF}` templates. The manager passes raw strings to mcp-client with template expansion enabled; configuration remains readable to management surfaces, so keep secret values in the credentials provider. Missing values put that instance in `waiting-credentials`; referenced credential updates retry resolution or replace its connection when the resolved values change. Diagnostics and tool failures replace every resolved value with `[redacted]`. See [runtime templates and credentials](../mcp-client/README.md#runtime-templates-and-credentials) for provider requirements and replacement ordering.

### Registering a server from a plugin

A plugin that integrates an MCP service registers its server instead of writing configuration:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-mcp-manager'

export const name = 'example-app'
export const inject = ['mcpManager']

export function apply(ctx: Context): void {
  ctx.mcpManager.register('example', {
    transport: 'streamable-http',
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: 'Bearer ${credential:EXAMPLE_TOKEN}' },
  })
}
```

`register(name, entry)` accepts every configured-entry field except `enabled` and applies the same validation; a server row makes this call for the server its config declares. A registration lasts for the calling plugin's lifetime: disabling or uninstalling the plugin through the plugin manager unloads it, and the registration's disposal unmounts the server and withdraws its tools before the plugin's disposal settles. Values the server resolved stay in the credentials provider. A registered name must differ from every configured entry and every other registration; the registration and a later settings write both refuse a collision. Settings does not edit registered entries.

### Observing and recovering

`ctx.mcpManager.list()` returns each server's `name`, `configured` flag, and live `status`, listing configured entries before registered ones. The list includes removed entries whose cleanup is still pending or failed, with `configured: false`; a cleanup failure retains the row until the Host restarts. Cleanup status retains the first diagnostic and reports `closeConfirmed: false` if any instance or probe could not confirm closure. Published status changes emit `mcp-manager/status` while the manager is live, including cleanup failures after an entry's removal. Lifecycle operations do not wait for listeners; synchronous throws and returned promise rejections are logged without skipping other listeners.

`whenSettled(signal)` resolves once `list()` reports no server as `connecting` with `attempt: 0`, the first attempt of a connection. Every later state counts, including a failed attempt, a reconnect attempt, and waiting for credentials or authorization; servers that join during the wait are included. It returns the names still in their first attempt when the signal aborts or the manager is disposed, and an empty list once settled. The [SDK server](../../sdk/server/README.md) uses it to hold `initialize` for at most its `startupWaitMs`. It is a Host method; Remote clients observe the same states through `watch`.

Reconnection stays inside mcp-client. `restart(name)` replaces an instance and resets its reconnect budget, including after that budget runs out. Unconfirmed transport closure or a local cleanup error blocks replacement and further probes for that server; restart the Host to recover. `probe(name, options)` resolves templates, connects, reads server identity and tool names, and closes without registering tools or reserving a namespace. Disabled entries can be probed; a switched-off server row is not loaded, so `probe` does not know its server. On an OAuth entry, a probe may refresh an expired grant and save the new tokens. The probe has its own deadline and cancellation signal, and reports connection/listing success separately from closure and cleanup results.

<a id="oauth-authorization"></a>
### OAuth authorization

Configure or register an entry with the [client OAuth options](../mcp-client/README.md#oauth). Each entry, including disabled entries, requires its own stable `oauth.credentialKey`: keep it when renaming or overriding an inherited entry, and choose a new key when copying. The manager rejects a key that another configured or registered entry owns. A plugin registering an OAuth server keeps one fixed key, so a reinstalled plugin reuses its saved grant.

With credentials, Authorization, and WebServer services loaded, `startAuthorization(name)` starts an attempt or returns the active one. `list()` exposes its progress and browser URL; `mcp-manager/status` also announces authorization updates and removal after successful cleanup. `cancelAuthorization(name, id)` cancels only that attempt. Failure or cancellation preserves the previous grant; an already admitted commit completes. Entry replacement retires authorization immediately, so a pending retry cannot start with obsolete configuration.

`signOut(name)` drains authorization, probes, and connections, then deletes the local grant while retaining compatible client registration. Starts and probes are rejected throughout that operation. A configuration change before deletion, such as a rename that keeps the key, preserves the grant and rejects the sign-out. Incomplete cleanup preserves the grant and requires a Host restart. Sign-out does not revoke tokens remotely. A rejected dynamic client registration is removed after an explicit authorization failure so the next explicit attempt can register again.

### Remote operations

Browser clients reach the manager as `ctx.remote.mcpManager` through [`dsh-api-remotes`](../../api/remotes/README.md). `watch(signal)` yields the complete server list on subscription and again after every status or entry change, coalescing changes the subscriber has not read yet; aborting the signal ends that stream, and manager disposal ends every stream. `restart(name)` and `probe(name, signal)` run the operations above. Authorization, cancellation, and sign-out stay on the Host: the Plugins page reaches them through [`dsh-mcp-account`](../mcp-account/README.md), so a browser never names a server to authorize. Configuration writes stay on the Settings Remote, and the manager adds no write method; a browser defines a server row's command only through the experimental [Connectors tab](../../experimental/client-ui-connectors/README.md), whose owner-only Remote writes server rows.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions and points at the code; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Two sources own the server set.** The current volatile Config value (schema defaults → inherited profile configuration → user patch) determines configured entries; registrations add the entries of server rows and other plugins. Runtime records retain instance ownership, active probes, and cleanup failures. External file edits and management-surface writes take the same path.
- **Registrations are effects.** A registration is an effect of the calling plugin, so its owner's lifecycle decides when the server exists; no plugin writes another plugin's configuration or leaves an entry behind on removal.
- **A server row is a registration.** The row plugin is a second entry of this package that calls `register()` with its config, so the Loader's handling of rows decides that server: composition layers add and remove it, `disabled` switches it, and the row validates and restarts alone. The manager adds no code for rows.
- **One serialized operation tail.** Reconciles and restarts queue on one chain, so two lifecycle operations cannot interleave one instance's unmount/mount. Probes run independently; entry changes and disposal cancel them before waiting for the operation tail and owned cleanup.
- **Whole-entry identity.** Any field change except `enabled` rebuilds the instance — instance config is captured at mcp-client load, so an in-place update cannot exist. `enabled` alone toggles mounting.
- **A flat entry schema, validated cross-field.** Write-time validation enforces the per-transport rules a union would have expressed and rejects them at the write, naming the offending field where a union's shape error would not. The MCP client host validates the fields mcp-client owns — the entry key as `serverName`, template tokens, `reconnect`, and `oauth` — through each transport's own schema, so those refusals name the field too; the manager's schema passes `reconnect` and `oauth` through unresolved.
- **Connection handling stays in mcp-client.** Children are ordinary mcp-client instances that the host mounts below its own Fiber: `serverName` reservations collide correctly with statically composed instances, teardown unwinds tools, and the manager reads each instance's status through the handle the host returns rather than duplicating supervision.
- **The host is the manager's only reach into mcp-client.** Besides mcp-client types, the manager imports only the `McpClientHost` class and creates the host at construction, so the host and every instance it mounts run below the manager's fiber and end with it.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The service: schema, validation, registrations, reconcile, restart, probe, watch, status registry |
| [`src/entry.ts`](src/entry.ts) | The fields of one entry and the schema that the service and the server row share |
| [`src/server-row.ts`](src/server-row.ts) | The server row plugin (`./server`): one row registers one server |
| [`src/types.ts`](src/types.ts) | The status union, list view, and the `mcp-manager/status` event declaration (`./types`) |

### Lifecycle notes

The manager starts only while the host is provided; withdrawing the host stops the manager, and providing a host again starts it with its configured and registered entries. The first reconcile waits for the manager's own fiber to activate, because the service is visible to dependents only from that point. Child startup does not hold the operation queue open. A changed or removed entry stops forwarding child status and cancels its probes before queued cleanup; replacement waits for both probes and the child to finish cleanup. Equal status publications are absorbed. Cleanup failures remain observable after an entry's removal; disposal stops all further events and ends every `watch` stream.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [mcp-client README](../mcp-client/README.md) — the per-instance bridge: naming, reconnect policy, tool execution, status surface.
- [Settings package README](../../settings/settings/README.md) — the Config forms, inheritance, revision checks, and profile writes the manager uses.
- [App-boot README](../../boot/app-boot/README.md#profiles) — the composition layers and patch files that add, edit, and switch off server rows.
- [Credentials group README](../../credentials/README.md) — the credential references `${credential:…}` templates resolve.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-mcp-manager) — every accepted config field.
- [MCP manager Agent Note](../../../.agents/notes/implemented/feature/2026-08-31-mcp-manager-plugin.md) — the design decisions, peer-product survey, and rejected alternatives.
- [Server rows Agent Note](../../../.agents/notes/implemented/architecture/2026-11-24-mcp-manager-server-rows.md) — why a server can be its own row beside `servers`, and the alternatives.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `dsh-mcp-client` instances it mounts, whose server-qualified tools and schemas enter requests; the manager itself registers no prompt or tool content.

#### KV Cache effect

No direct invalidation; mounting, rebuilding, and unmounting instances changes tool definitions exactly as the mcp-client README documents, and the manager adds no request content of its own.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what you cannot do with this manager today. They are current package constraints, not a task backlog.

- **OAuth sign-in ships only for plugin accounts** — [`dsh-mcp-account`](../mcp-account/README.md) shows the **Plugins** page account for servers that plugins register with it, and the experimental [Connectors tab](../../experimental/client-ui-connectors/README.md) registers each OAuth server row that is on; no browser surface authorizes any other server, because authorization runs only through Host callers.
- **Global plane only** — instances mounted by agent presets or static `cordis.yml` rows are neither listed nor governed; a static instance shows up only as a `serverName` collision when a managed entry tries to reuse its name.
- **A rebuild has a tool gap** — a changed entry is disposed and remounted, so its tools disappear from the model's set until the new instance finishes its initial sync; there is no keep-serving-until-replacement handover.
- **Registered entries are fixed by their plugin** — Settings cannot override a registered entry's budgets; the registering plugin exposes any tunable it needs in its own configuration.
- **Only the experimental Connectors tab edits server rows** — the [Connectors tab](../../experimental/client-ui-connectors/README.md), which shipped profiles leave disabled, adds, edits, switches, and removes server rows of the profile; without it, rows are edited in the composition files. Settings edits only the `servers` dictionary, and the manager's Remote has no method that writes a row.
- **A switched-off row is not listed** — a row with `disabled: true` is unloaded, so the manager cannot list, probe, or authorize its server until the row loads again; a `servers` entry with `enabled: false` stays listed as `disabled`.
- **An invalid `servers` entry stops every server** — the dictionary is validated as one value when the manager starts, so the manager row fails and its server rows wait for it; an invalid server row fails alone.
- **Probe output is capped** — a probe defaults to 16 listing pages and 512 tool names, reporting truncation beyond those limits; callers can set `maxPages` and `maxToolNames`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Note.

- Rolling replacement (start the new instance before disposing the old, keeping public tool names stable) would close the rebuild gap; peer products do this with a proxy generation.
- Per-server tool allow/deny lists are a natural entry extension once a consumer needs them.

</details>
