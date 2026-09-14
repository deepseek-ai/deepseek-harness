---
description: "User-facing permission presets for users and maintainers choosing, configuring, or debugging the Permissions selector that bundles sandbox mode with an approval policy."
kind: "package-reference"
---

# @deepseek-ai/dsh-permission-presets

English | [中文](README.zh.md)

## Summary

Offer named permission modes that set sandbox and approval together while each enforcement service keeps its own value. Configured presets supply future-session defaults; an explicitly loaded Auto review integration can add one current-session-only option. Clients read selectable entries from a process catalog and the current choice from the Session projection. Unmatched knob combinations appear as `custom`, which users can leave but cannot select. This package owns selection and defaults; the sandbox, approval, and Auto integration own execution.

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

Choose this service when a deployment wants to offer users one Permissions selector instead of separate sandbox and approval controls. It bundles the knobs; execution and approval keep their own values, so removing the package later leaves the last selection in effect.

### Configuring presets

The plugin config defines the preset table and the default for fresh sessions. Each preset name bundles one sandbox mode with one approval policy; `name` and `description` are optional client presentation. The reserved names `custom` and `auto` cannot appear in this table.

```yaml
- name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
    defaultPreset: workspace-write
```

| Field | Default | Meaning |
|---|---|---|
| `presets` | `workspace-write`, `danger-full-access` | Table of preset name → sandbox/approval bundle |
| `defaultPreset` | inferred | Preset pinned into fresh sessions; required when composition defaults match no preset |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-permission-presets) is the exhaustive source for every accepted field and its JSDoc. `custom` is reserved for the derived not-a-preset state, while `auto` is reserved for the Auto review integration. Mounting requires a confining bash executor (one that reports a `sandboxMode`) and the approval service.

### Switching presets

Switching to Auto first runs its synchronous admission check; every preset switch then changes only the knobs whose effective value differs, and selecting the preset already in effect changes nothing. The current value resolves as the still-matching last recorded selection, else the first matching configured entry, else `custom`. Users switch through the `/permission` command: a bare invocation reports the current preset and every available entry, and a preset argument switches to it.

### What users see

Clients render selectable entries from the process catalog: configured presets in table order followed by Auto while its integration is live. They join that snapshot with the Session's current value; an unmatched `custom` value may label the current control but never appears as a selectable catalog row. Auto's identity and Full access knob bundle are fixed inside this service. The shipped client locale dictionaries own Auto's label and description, while configured presets retain Host-supplied presentation. Callers cannot publish another preset through a generic contribution API, and they can switch away from `custom` but cannot select or persist a named custom preset through this service.

### Session defaults

The `permission` settings namespace holds `defaultPreset` for future sessions and accepts configured presets only. Session creation reads it, applies it to the sandbox mode and approval policy, and records the applied preset as a `permission/preset` selection. Later settings changes never alter an existing session. A resumed seed, including an explicitly empty one marked by `session/end-seed`, preserves its effective permission and receives only missing durable facts rather than the latest user default; a persisted `auto` identity requires the live Auto registration and its admission before publication.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The observable behavior is covered in [Use this package](#use-this-package); this section explains the write path, the process catalog, the projection-backed current value, and the optional command.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `PermissionPresetService`: configured table, fixed Auto registration, write path, settings namespace, session pinning, children |
| [`src/types.ts`](src/types.ts) | Process catalog, catalog-change event, and `permissions` current-selection types |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion validating configured preset names; Auto restore is checked before publication |

### Write path

`set()` resolves the preset and synchronously runs Auto admission when applicable. Transitions append `permission/preset` only when the effective preset changes, then write each changed knob through its canonical setter — `setSandboxMode` from `dsh-sandbox-policy` and `setApprovalPolicy` from `dsh-user-approval`. The selection event therefore preserves user intent when two presets share a bundle: switching between Auto and Full access records only the new identity because their sandbox and approval values already match. A net-zero selection appends nothing.

### Read side and `custom`

`current(session)` reads the required `permissions` projection, whose unit folds the three whole-value knob events over the composition defaults (`ctx.shell.sandboxMode` and the approval config). The host state also retains whether `session/end-seed` has occurred, so session pinning distinguishes an explicitly empty restored seed from a genuinely fresh session without rescanning the log. A still-matching last selection wins shared-bundle ties; otherwise the first configured match wins; otherwise the derived `CUSTOM_PRESET` is returned. A missing projection key fails explicitly.

`optionOf(name)` returns a configured entry, the live Auto entry, or the display-only `custom` entry. It throws only when the name matches none of those; a withdrawn Auto entry is unavailable.

### Session pinning and blank reuse

Mounting pins every live and future session: a genuinely fresh session gains the configured default preset and both knob facts, while seeded or partially initialized sessions keep their effective knob values and gain only missing durable facts. The projection-owned seed marker makes this decision from the same incremental state as the knob values. A stored `auto` identity fails publication when the Auto integration is absent or rejects admission; the service neither rewrites it nor silently derives Full access.

### Catalog, projection, and optional command

The service requires `ctx.sessionProjections` and registers a `permissions` projection containing only `currentValue`. Its process-level `catalog()` Remote returns one complete selectable snapshot. Registering or removing Auto emits the payload-free `permission-presets/catalog-changed` notification, so clients subscribe first and then re-read the catalog without appending a Session event, publishing a Session projection frame, or changing Session sequence. The `/permission` command registers only when a `ctx.commands` registry is composed. Calls that derive the current preset or pin an initial selection fail explicitly when the projection key is absent.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the preset vocabulary to the enforcement knobs and the design rationale.

- [Permission presets subsystem reference](../../../docs/subsystems/permission-presets.md) — the preset table, process catalog, current selection, and `ctx.permissionPresets` Cordis API.
- [Sandbox switching design Agent Note](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.md) — how sandbox mode and approval policy compose and switch.
- [Approval subsystem reference](../../../docs/subsystems/approval.md) — the approval policy knob this service bundles.
- [Interaction group map](../README.md) — adjacent command, approval, and question packages.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-user-approval` and `dsh-tool-bash`, which render the approval-policy prompt, switch notice, and sandboxed tool outcomes selected by this service's knob events; `permission/preset` itself is log-only.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the preset service does not offer. They are current package constraints, not a permission-system comparison.

- **Only two mechanism knobs are bundled** — presets select sandbox mode and approval policy; the fixed Auto integration adds admission behavior, but an agent/profile choice is not part of `PresetSpec`.
- **`custom` is derived-only** — callers can switch away from an unmatched knob combination but cannot target or persist a named custom preset through this service.
- **The configured preset table is fixed for the plugin lifetime** — only the fixed Auto contribution can change the live process catalog without reloading this service.
- **Auto cannot become a default** — it exists only while its integration effect is live and is intentionally absent from the `permission` settings schema.
- **Stored defaults must remain in the preset table** — removing the referenced preset makes Permission settings registration fail until the `permission` section in `settings.yaml` is updated or reset.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
