# Agent Note: Permission Settings default for new sessions

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-31-permission-default-for-new-sessions.zh.md)

## Problem

The Web General-settings page displayed Permission as a disabled skeleton even though `dsh-permission-presets` already owned the preset table and current-session switch path. The Settings seam could persist a plugin-owned value, but the Web settings API exposed only configurable LLM-provider namespaces. More importantly, treating a user preference as a live global permission would make an existing session's execution policy change outside its durable log.

## Decision

`dsh-permission-presets` owns a `permission` Settings namespace with one `defaultPreset` field. Its base value is `Config.defaultPreset`, or the preset matching the composed sandbox and approval defaults when the config omits it. The schema derives its enum from the configured preset table, so Settings validates stored values and the Web client discovers the deployment's actual choices without duplicating them.

The service reads the current Settings value synchronously at `session/created`. A genuinely fresh session receives three explicit events: `permission/preset`, `sandbox/mode`, and `approval/policy`. Those facts pin the permission selected at creation, so a later Settings change affects only later sessions. A seeded or partially initialized session preserves its effective knobs and receives only missing facts; it never adopts the latest user default while resuming. `Session` marks even an explicitly empty constructor seed with `session/end-seed`, so an empty persisted log cannot be mistaken for a fresh session. The `permissions` projection folds that boundary with the three permission facts, letting session pinning read one incremental state instead of rescanning the log.

The existing `/permission` command and `permissions` projection remain the current-session path. The browser plugin now contributes the Permission row to `settings.general.item`, reads the dynamic enum from the redacted Settings descriptor, and writes only `defaultPreset` through a revision-checked `settings.mutate`. The row injects its observable through the slot `hooks` compartment instead of binding a renderer-specific hook, and the Permission service sweeps already-live sessions when it mounts so HMR cannot leave an unpinned session. The ownerless General-settings package contributes no placeholder rows.

The Settings Controller exposes the registered `permission` namespace through its redacted Remote view. This is a local presentation decision, not a general registration flag or a `local-client` access model. Permission changes reach the client through forwarded `settings/document-updated` ([forwarded Remote events](../architecture/2026-08-10-remote-event-delivery.md)); they do not announce model topology.

## Consequences

Changing Permission in Settings updates `settings.yaml` and the selector immediately, but does not alter the open session. Every later session is reconstructable from its three pinned permission facts, including after the user changes the default again or the process restarts. Deployments whose composed sandbox and approval defaults match no preset must configure `defaultPreset` explicitly.

The assembled Web snapshot contains a functional Permission selector. Its keyless browser scenario writes `read-only`, verifies an existing `workspace-write` session is unchanged, and verifies a subsequently created session starts with the read-only event triplet.

## Alternatives considered

**Apply the Settings value live to every session.** Rejected because execution policy would change without a session event and replay could not reconstruct which permission governed an earlier tool call.

**Record only `permission/preset` on creation.** Rejected because sandbox and approval are independently owned whole-value knobs; pinning all three facts keeps their consumers independent of future composition-default changes.

**Expose all Settings registrations, or add a generic `local-client` declaration.** Rejected for this change because it expands a security boundary and the Settings contract beyond the one requested preference. The explicit `permission` allowlist entry is sufficient and leaves future namespaces to make their own exposure decision.

**Apply the latest default while resuming a seeded session.** Rejected because resume must preserve the session's prior effective execution policy; missing legacy facts are materialized from that policy instead.
