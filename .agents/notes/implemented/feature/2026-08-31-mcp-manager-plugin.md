# Agent Note: Settings-driven MCP server manager

Status: implemented

English | [中文](2026-08-31-mcp-manager-plugin.zh.md)

## Problem

One MCP server was one `dsh-mcp-client` row in `cordis.yml`. That is right for composition-pinned servers and wrong for the product goal of managing servers from a Web surface: adding, editing, testing, enabling, disabling, deleting, and recovering servers at runtime, with connection status visible per server. The client plugin exposed no status beyond log lines, activation inherited an unbounded SDK startup wait, and there was no way to test a configuration without mounting it. A survey of six peer agent products (Claude Code, Codex, OpenCode, Kimi Code, DeepSeek-Reasonix, Pi) converged on the same shape: a config registry, a management facade, and a connection-state machine with a status-to-action mapping, secrets never round-tripping to the surface.

## Decision

`packages/mcp/mcp-manager` is a service plugin (`ctx.mcpServers`) that owns the volatile `servers` configuration and reconciles a fleet of ordinary `dsh-mcp-client` child instances; `packages/mcp/mcp-client` gained the three primitives the manager needs — a status surface, a probe, and a startup budget — with no change to its reconnect semantics.

**Configuration is volatile Config, and CRUD needs no new API.** Settings projects the manager entry’s Config under its Loader id; ConfigEditor owns profile persistence, inheritance, and revision checks. Settings edits retain inherited servers, and resetting an inherited entry restores its base value. Direct profile patches replace the complete `servers` map. Loader commits the reference before notifying the manager’s existing reconcile queue.

**A flat entry schema, validated cross-field.** The entry is flat with a `transport` discriminant, and write-time validation enforces the per-transport requirements and rejections (missing `command`/`url`, cross-transport fields, malformed templates) at the write — a schema-valid-but-unserviceable entry is never stored, and refusals name the offending field where a union's shape error would not.

**Children are plugin instances, not library calls.** Each enabled entry mounts `dsh-mcp-client` under the manager's fiber via `ctx.plugin()`. That reuses the tested activation/disposal semantics, makes `serverName` reservations collide correctly with statically composed instances (surfaced as a `failed`/`load` status with the actionable message), and lets manager disposal unwind every instance and its tools through ordinary fiber teardown.

**Whole-entry identity; `enabled` is the one exception.** Any field change rebuilds the instance (instance config is captured at plugin load; in-place update does not exist); `enabled` only mounts or unmounts. All lifecycle operations — reconciles, `restart`, credential rebuilds — serialize on one operation tail, and a mount re-checks its entry against the current configuration after its asynchronous template resolution, so an entry deleted mid-resolution leaves no orphan instance.

**Status is a per-scope handle, not a broadcast.** mcp-client's supervisor publishes a status cell (`connecting`/`connected`/`reconnecting`/`failed` with payloads) registered beside the `serverName` reservation and read via `connectionStatusOf(ctx, name)` — scope-keyed exactly like the reservation, so an Agent-scoped instance never leaks into the global plane and attribution needs no identity tokens in payloads. The manager aggregates cells into `list()` plus the `mcp-manager/status` event (absorbing equal statuses, dropping names the configuration no longer carries, silent after disposal); its invariant companion asserts every emission names a listed server on a live manager. The first reconcile waits for the manager's own fiber activation because strict service reads answer only from an active fiber.

**Templates keep secrets out of the document, and the document stays readable.** Stored env and header values are not wire-redacted: an editor echoes exactly what the document stores, and a value that must stay hidden belongs in a template. `${env:NAME}` and `${credential:REF}` resolve at mount; a missing referent fails that one server with the fix in the message. Credential rotation rebuilds affected servers by statically scanning the raw configuration rather than tracking mounted instances' refs, so a server whose earlier mount failed on the missing credential heals when the credential is stored.

**mcp-client additions.** `startupTimeoutMs` (default 30 s) bounds every connection attempt plus its initial tool sync, closing the inherited-SDK-timeout gap; `probeServer()` connects, reads the server identity, lists tools (16 pages / 512 names, truncation reported), and closes without reserving a name or touching `ctx.tools` — the "test this server" affordance for stored entries and unsaved drafts alike.

OAuth is deliberately out of scope: the credential-record and authorization seams plus the MCP SDK's `OAuthClientProvider` are the intended home, and a `needs-auth` status state is reserved for that change.

## Alternatives considered

**Manage each server as a separate Loader entry.** Rejected: the manager needs one server list with status, restart, and probe. Settings and ConfigEditor already edit its dictionary with inheritance, validation, and revision checks; the runtime child instances need no separate persisted entries.

**Call `startConnection()` as a library instead of mounting child plugins.** Rejected: it forks the lifecycle from statically composed instances, loses the reservation collision check, and re-implements activation/disposal quiescence the plugin already proves under test.

**Broadcast per-instance status as a Cordis event from mcp-client.** Rejected: preset-scoped instances would emit under the same names and force identity tokens into payloads; the scope-keyed handle gives precise attribution with the reservation's own lifetime. The manager's single aggregated event is the only broadcast surface.

**Poll status from the management surface.** Rejected: the Remote plane already forwards Host events; peers that shipped polling (Reasonix) or lacked a status event (OpenCode v1) treat it as a defect to fix.

**A capability seam (Definition/Provider/Consumer) for "MCP management".** Rejected: one implementation and no independently evolving roles; a seam without a second provider is structure without an owner.

## Testing

mcp-client unit (`tests/status.spec.ts`, `tests/probe.spec.ts`, mocked SDK): every status transition including budget exhaustion, disabled reconnect, both startup-budget phases, the errorless close-during-connect outage, observer containment, disposal removing the handle, and probe stage classification, caps, budget, and close containment. Manager unit (`tests/manager.spec.ts`, real Cordis + profile-backed Settings and an in-memory credential provider): base-layer fallback without settings, settings-driven add/rebuild/disable/delete, restart semantics, template resolution and failure, credential rotation rebuilds including the heals-a-failed-mount case, the serverName collision surfaced as `failed`/`load`, the mid-resolution delete abort, stale activation callbacks, disposal unwinding tools then refusing operations, and a queued reconcile losing to disposal being contained and logged. Invariant spec proves the emission contract can fail. Real composition (`tests/composition.spec.ts`): Loader-booted profile configuration — the inherited server mounts, an external profile patch hot-adds a second server, Settings edits survive restart, and invalid writes leave the patch unchanged. E2E (`mcp-client.e2e.ts`, keyless): probe against the real stdio fixture server and against a dead command. Coverage holds the per-file 100% gate on both packages.

## Consequences

- The eight management-surface operations decompose as: add/edit/delete/enable/disable = settings writes (no new API); status = `list()` + one forwarded event; test = `probe`; recovery = mcp-client reconnect plus `restart` as the manual escape from terminal `failed` states. The follow-up Remote controller and Web section consume exactly this surface.
- A rebuilt server's tools disappear until the new instance's first sync completes; rolling replacement (new generation before old disposal) is a known open direction.
- The manager governs the global plane only; preset-scoped and static instances stay outside its list.
- `startupTimeoutMs` bounds startup attempts, while notification-driven re-sync requests still ride the SDK's request default — recorded as an mcp-client limitation.
