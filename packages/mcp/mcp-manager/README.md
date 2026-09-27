---
description: "MCP server manager for deployments and management surfaces that add, edit, enable, disable, delete, probe, and observe MCP servers through live plugin configuration at runtime."
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-manager

English | [中文](README.zh.md)

## Summary

`dsh-mcp-manager` manages a live fleet of MCP servers: declare `config.servers` on its profile entry (or edit it through Settings), and the manager mounts one `dsh-mcp-client` instance per enabled entry, adding, rebuilding, disabling, and removing instances as the document changes without a restart. `ctx.mcpServers` aggregates every server's connection status, `restart` recovers a server whose reconnect budget ran out, and `probe` tests a configuration without touching the live instances. `${env:NAME}` and `${credential:REF}` templates keep secrets out of the document; mcp-client handles credential rotation inside each instance.

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

Mount the manager once. Its volatile `config.servers` is the server configuration; Settings uses the owning entry id as its namespace (`mcp` in this example).

### When to choose it

Choose the manager when the server set should change at runtime — a settings edit or a Web management surface adds, reconfigures, disables, or deletes servers and the change applies live. Keep plain `dsh-mcp-client` rows instead when a deployment pins its servers in the composition, or when a server belongs to one agent preset rather than the whole Host; the manager governs the global plane only.

### Minimal configuration

One `cordis.yml` row mounts the manager; `servers` in its config is optional and becomes the composition base layer:

```yaml
- id: mcp
  name: '@deepseek-ai/dsh-mcp-manager'
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
          Authorization: 'Bearer ${env:MCP_TOKEN}'
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
| `toolCallTimeoutMs` / `closeTimeoutMs` / `healthCheckIntervalMs` / `healthCheckTimeoutMs` / `reconnect` | mcp-client defaults | Per-server overrides; health checks are off by default |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-mcp-manager) is the exhaustive source for every accepted field.

### Managing servers at runtime

Settings writes persist through ConfigEditor with revision checks; Loader updates the volatile configuration without remounting the manager. Every committed configuration change reconciles the fleet: a new enabled entry mounts, a removed entry unmounts, `enabled: false` unmounts while keeping the entry listed, and any other field change rebuilds that one instance while unchanged siblings keep running. Through Settings, inherited servers can be overridden or disabled; deleting an inherited server restores its base configuration. Only servers added by the user layer are removable. A broken entry — a missing `command`, a cross-transport field, a malformed template — is refused at the write, so the document never stores a server the manager cannot act on.

`env` values, `headers` values, `command`, `args`, `cwd`, and `url` accept `${env:NAME}` and `${credential:REF}` templates. The manager passes raw strings to mcp-client with template expansion enabled; configuration remains readable to management surfaces, so keep secret values in the referenced sources. Missing values put that instance in `waiting-credentials`; referenced credential updates retry resolution or replace its connection when the resolved values change. Environment values use the Host's launch snapshot. See [runtime templates and credentials](../mcp-client/README.md#runtime-templates-and-credentials) for provider requirements, HTTP request checks, and replacement ordering.

### Observing and recovering

`ctx.mcpServers.list()` returns each server's `name`, `configured` flag, and live `status`. Configuration fields remain available through Settings. The list includes removed entries whose cleanup is still pending or failed, with `configured: false`; a cleanup failure retains the row until the Host restarts. Cleanup status retains the first diagnostic and reports `closeConfirmed: false` if any instance or probe could not confirm closure. Published status changes emit `mcp-manager/status` while the manager is live, including cleanup failures after configuration removal. Lifecycle operations do not wait for listeners; synchronous throws and returned promise rejections are logged without skipping other listeners.

Reconnection stays inside mcp-client. `restart(name)` replaces an instance and resets its reconnect budget, including after that budget runs out. Unconfirmed transport closure or a local cleanup error blocks replacement and further probes for that server; restart the Host to recover. `probe(name, options)` resolves templates, connects, reads server identity and tool names, and closes without registering tools or reserving a namespace. Disabled entries can be probed. The probe has its own deadline and cancellation signal, and reports connection/listing success separately from closure and cleanup results.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions and points at the code; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Configuration owns the server set.** The current volatile Config value (schema defaults → inherited profile configuration → user patch) determines configured entries; runtime records retain instance ownership, active probes, and cleanup failures. External file edits and management-surface writes take the same path.
- **One serialized operation tail.** Reconciles and restarts queue on one chain, so two lifecycle operations cannot interleave one instance's unmount/mount. Probes run independently; configuration changes and disposal cancel them before waiting for the operation tail and owned cleanup.
- **Whole-entry identity.** Any field change except `enabled` rebuilds the instance — instance config is captured at mcp-client load, so an in-place update cannot exist. `enabled` alone toggles mounting.
- **A flat entry schema, validated cross-field.** Write-time validation enforces the per-transport rules a union would have expressed and rejects them at the write, naming the offending field where a union's shape error would not.
- **Connection handling stays in mcp-client.** Children are ordinary plugin instances mounted under the manager's fiber: `serverName` reservations collide correctly with statically composed instances, teardown unwinds tools, and the manager reads each instance's status through `connectionStatusOf` rather than duplicating supervision.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The service: schema, validation, reconcile, restart, probe, status registry |
| [`src/types.ts`](src/types.ts) | The status union, list view, and the `mcp-manager/status` event declaration |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: status emissions name a server the live manager lists |

### Lifecycle notes

The first reconcile waits for the manager's own fiber to activate, because the service is visible to dependents only from that point and the status event asserts a reachable manager. Child startup does not hold the configuration queue open. A changed or removed entry stops forwarding child status and cancels its probes before queued cleanup; replacement waits for both probes and the child to finish cleanup. Equal status publications are absorbed. Cleanup failures remain observable after configuration removal; disposal stops all further events.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [mcp-client README](../mcp-client/README.md) — the per-instance bridge: naming, reconnect policy, tool execution, status surface.
- [Settings package README](../../settings/settings/README.md) — the Config forms, inheritance, revision checks, and profile writes the manager uses.
- [Credentials group README](../../credentials/README.md) — the credential references `${credential:…}` templates resolve.
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
- **A rebuild has a tool gap** — a changed entry is disposed and remounted, so its tools disappear from the model's set until the new instance finishes its initial sync; there is no keep-serving-until-replacement handover.
- **Templates know two schemes** — `${env:NAME}` and `${credential:REF}` only; no default-value syntax and no other sources.
- **Probe output is capped** — a probe defaults to 16 listing pages and 512 tool names, reporting truncation beyond those limits; callers can set `maxPages` and `maxToolNames`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Note.

- A Remote controller and Web settings section over `list`/`restart`/`probe` and the settings namespace are the intended management surface; the service API here is shaped for them.
- OAuth belongs on the credential-record and authorization seams plus the MCP SDK's `OAuthClientProvider`; a `needs-auth` status state is reserved for it.
- Rolling replacement (start the new instance before disposing the old, keeping public tool names stable) would close the rebuild gap; peer products do this with a proxy generation.
- Per-server tool allow/deny lists are a natural entry extension once a consumer needs them.

</details>
