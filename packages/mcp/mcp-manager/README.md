---
description: "MCP server manager for deployments and management surfaces that add, edit, enable, disable, delete, probe, and observe MCP servers through the mcp settings namespace at runtime."
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-manager

English | [中文](README.zh.md)

## Summary

`dsh-mcp-manager` turns the `mcp` settings namespace into a live fleet of MCP servers: declare servers under `mcp.servers` in `settings.yaml` (or let a management surface write them), and the manager mounts one `dsh-mcp-client` instance per enabled entry — adding, rebuilding, disabling, and removing instances as the document changes, without a restart. It aggregates every server's connection status behind `ctx.mcpServers`, offers `restart` as the manual recovery for a server whose reconnect budget ran out, and `probe` to test a configuration without touching the live instance set. Secret values stay out of the document through `${env:NAME}` and `${credential:REF}` templates, and a rotated credential rebuilds exactly the servers that reference it. Add it when servers should be user-managed at runtime; composition-pinned servers can stay as plain `dsh-mcp-client` rows.

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

Mount the manager once; from then on the `mcp.servers` section of the user settings document is the single place servers are managed.

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

Users add or override servers in `settings.yaml` under the same shape:

```yaml
mcp:
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
| `toolCallTimeoutMs` / `startupTimeoutMs` / `healthCheckIntervalMs` / `reconnect` | mcp-client defaults | Per-server overrides passed through to the instance |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-mcp-manager) is the exhaustive source for every accepted field.

### Managing servers at runtime

Every committed settings change reconciles the fleet: a new enabled entry mounts, a removed entry unmounts, `enabled: false` unmounts while keeping the entry listed, and any other field change rebuilds that one instance while unchanged siblings keep running. The base layer from the composition can be overridden or disabled from the user document but not deleted; only entries the user layer alone carries are removable. A broken entry — a missing `command`, a cross-transport field, a malformed template — is refused at the write, so the document never stores a server the manager cannot act on.

`env` values, `headers` values, `command`, `args`, `cwd`, and `url` accept `${env:NAME}` and `${credential:REF}` templates, resolved when the instance mounts, so the settings document never carries a secret; `env` and `headers` values are additionally schema-marked secret, so a wire read of the section redacts them. A missing referent fails that one server with a message naming the fix. Storing or rotating a referenced credential rebuilds the servers that use it — including one whose earlier mount failed because the credential did not exist yet.

### Observing and recovering

`ctx.mcpServers.list()` answers a management surface with one row per configured server: transport, durable intent, deletability, and the live status (`connecting`, `connected` with its tool count, `reconnecting` with the attempt budget, `failed` with the reason and last error, or `disabled`). Every transition also emits the `mcp-manager/status` event. Reconnection itself stays inside mcp-client (backoff from 500 ms to 30 s, ten attempts per outage); `restart(name)` is the manual recovery beyond it — a fresh instance with a fresh budget, which is the only way back from a `failed` terminal state short of a config change. `probe(name)` connects, lists tools, and disconnects without registering anything — the "test this server" affordance, and it works on a disabled entry.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions and points at the code; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Configuration is the only truth.** The manager never stores server state of its own: the resolved settings value (schema defaults → composition base → user layer) is read fresh for every decision, so external file edits and management-surface writes take the same path.
- **One serialized operation tail.** Reconciles, restarts, and credential rebuilds queue on one chain, so two lifecycle operations can never interleave one instance's unmount/mount, and disposal drains the tail before unwinding.
- **Whole-entry identity.** Any field change except `enabled` rebuilds the instance — instance config is captured at mcp-client load, so an in-place update cannot exist. `enabled` alone toggles mounting.
- **A flat entry schema, validated cross-field.** Settings-wire secret redaction follows `object`/`dict`/`array` containers only, so the secret-marked `env`/`headers` values must not sit inside a union branch; `validateServers` enforces the per-transport rules a union would have expressed and rejects them at the write.
- **Connection handling stays in mcp-client.** Children are ordinary plugin instances mounted under the manager's fiber: `serverName` reservations collide correctly with statically composed instances, teardown unwinds tools, and the manager reads each instance's status through `connectionStatusOf` rather than duplicating supervision.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The service: schema, validation, reconcile, restart, probe, status registry |
| [`src/templates.ts`](src/templates.ts) | `${env:…}` / `${credential:…}` syntax checks, resolution, and the static ref scan |
| [`src/types.ts`](src/types.ts) | The status union, list view, and the `mcp-manager/status` event declaration |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: status emissions name a server the live manager lists |

### Lifecycle notes

The first reconcile waits for the manager's own fiber to activate, because the service is visible to dependents only from that point and the status event asserts a reachable manager. A mount re-checks its entry against the current configuration after template resolution, so an entry deleted mid-resolution leaves nothing behind. Status publications are absorbed when equal, dropped for names the configuration no longer carries, and stopped entirely at disposal — late connection callbacks from an instance being torn down cannot emit for a manager that is gone.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [mcp-client README](../mcp-client/README.md) — the per-instance bridge: naming, reconnect policy, tool execution, status surface.
- [Settings package README](../../settings/settings/README.md) — the namespace registration, layering, and write semantics the manager builds on.
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
- **Probe output is capped** — a probe follows at most 16 listing pages and returns at most 512 tool names, reporting truncation beyond that.

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
