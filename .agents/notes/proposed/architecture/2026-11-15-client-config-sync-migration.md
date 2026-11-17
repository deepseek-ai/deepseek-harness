# Agent Note: Migrate existing browser configuration reads to configuration sync

Status: proposed

English | [中文](2026-11-15-client-config-sync-migration.zh.md)

## Problem

Before [browser plugin configuration sync](../../implemented/architecture/2026-11-15-client-config-sync.md), every package whose browser face needs Host configuration implemented its own read. These reads take effect only at page load, duplicate injection code, or use the settings editing channel as a runtime read channel. This Note inventories them and plans their migration; nothing runs before the architecture lands.

## Proposal

### Inventory

| Category | Use | Packages |
|---|---|---|
| A. Page globals carry Host configuration | `webserver/index-inject` writes `window.__DSH_*__`, read once when the browser loads | `shortcuts`, `ui-sidebar-documentpreview`, `ui-account-notifications`, `ui-settings-models` (onboarding), `ui-settings-account` (contact details), `connection` (recovery parameters) |
| B. Runtime values read through `configForms` | The browser subscribes to accepted values of its own or another entry through the settings mirror | `ui-chat`, `ui-conversation`, `locale`, `ui-theme`, `ui-settings-account`, `ui-settings-general`, `ui-agent-preset`, experimental `timeline`, `client-ui-cot-translation`, `client-ui-forge`, `cua` |
| C. `Config` declared only on the Client face | The browser exports a schema, but the entry never receives configuration | Done in the architecture PR: `ui-context-menu` `resolutionTimeoutMs` and `ui-conversation` `maxConcurrentFileUploads` are top-level volatile fields of their Host schemas, and the Client schemas are removed |
| D. First-paint pre-injection | The page HTML pre-injects values to avoid a first-paint flash | `ui-theme` palette and font sizes |
| E. Settings editing | Settings pages edit inherited values, overrides, revisions, and writability | every `ui-settings-*` card |

### Migration rules

| Category | Handling |
|---|---|
| A | Make the fields volatile and move the `Config` type to `src/types.ts`; the browser reads `SyncedConfig`; remove the matching `index-inject` row and global. Confirm per field that its meaning can become "changes at runtime"; `connection` needs its recovery parameters before Connection itself activates and is assessed separately |
| B | Plugins reading their own entry read `SyncedConfig`; `configForms` keeps only writes and settings presentation. Reads of another entry's values (for example `ui-agent-preset` reading `ui-settings`) can use the read-only `ctx.config.resolveConfigByPackage(packageName)` |
| C | Remove the browser schema and `Config` export, move the type to `src/types.ts`, and declare a volatile schema on the Host face |
| D | Unchanged; the runtime part can be migrated separately |
| E | Outside this migration; adjusting the settings package and `configForms` is discussed separately once the configuration sync architecture is stable |

### Order

1. The architecture Note is implemented and merged.
2. Category C (no behavior dependency; exercises the mechanism).
3. Category A, one package at a time.
4. Category B, own reads first, then cross-plugin reads.
5. A separate Note for the overall adjustment of settings and `configForms`.

### Open questions

- Which fields each package makes volatile.
- Whether cross-plugin reads move to types inferred per package name through declaration merging.
- The first-render timing of `connection` recovery parameters and bootstrap rows.

## Alternatives considered

| Rejected | Reason |
|---|---|
| Migrating in the architecture PR | Widens the review and mixes mechanism questions with per-package semantics |
| Keeping page globals as a long-term parallel channel | Keeps two configuration sources and duplicated injection code |

## Acceptance criteria

- Category A and C packages no longer export a browser `Config` schema or read Host configuration globals.
- Category B plugins that read their own configuration no longer rely on `configForms` for runtime reads.
- After migration, a Host change to the matching volatile field takes effect without a page reload.

## Risks

| Risk | Description |
|---|---|
| Changed meaning | Values that took effect only at load become runtime-changeable, and plugins must support live updates |
| Pinned configuration | Making a field volatile brings it into the settings form's profile row, subject to the pinning rules in [profile-owned live configuration](../../implemented/architecture/2026-09-19-profile-owned-live-configuration.md) |
| First-render timing | `connection` needs its recovery parameters before it activates, earlier than synced configuration can take part |
