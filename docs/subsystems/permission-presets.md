# Permission Presets

English | [中文](permission-presets.zh.md)

The permission-preset layer of [dsh-permission-presets](../../packages/interaction/permission-presets) (`ctx.permissionPresets`, `PermissionPresetService`) bundles the two independent enforcement knobs — [sandbox mode](sandbox.md) (`sandbox/mode`) and [approval policy](approval.md) (`approval/policy`) — into named presets a client offers as one Permissions selector. The configured table owns future-session defaults, while the fixed `registerAuto(admit)` hook lets the [Auto review](../../packages/experimental/auto-review/README.md) integration publish its current-session-only option for one effect lifetime. The layer is optional and owns no execution policy: prompt narration and replay keep reading their knob folds, while Auto review owns the additional enforcement. The [package README](../../packages/interaction/permission-presets/README.md) owns composition status and limitations; the [sandbox switching design](../../.agents/notes/implemented/feature/2026-07-06-sandbox.md) owns the original knob rationale.

Source: [`packages/interaction/permission-presets/src/index.ts`](../../packages/interaction/permission-presets/src/index.ts)

## The preset table

A preset maps one stable key to a sandbox/approval bundle plus optional client presentation. The default configured table ships `workspace-write` (`workspace-write` + `ask`) and `danger-full-access` (`danger-full-access` + `never`); `custom` and `auto` are reserved and cannot be configured.

```ts type-equiv
/** One preset's sandbox/approval bundle and optional client presentation. */
interface PresetSpec {
  /** The `sandbox/mode` value the preset writes through. */
  sandbox: SandboxMode
  /** The `approval/policy` value the preset writes through. */
  approval: ApprovalPolicy
  /** The display label a client shows for this preset; the raw table key when omitted. */
  name?: string
  /** One user-facing sentence on what the preset means; omitted when not configured. */
  description?: string
}
```

```ts type-equiv
/** The {@link PermissionPresetService} config: preset table and composition default. */
interface Config {
  /**
   * The preset table: name → knob bundle. Defaults to `workspace-write`
   * (workspace-write + ask) and `danger-full-access` (danger-full-access +
   * never). The names `custom` and `auto` are reserved for derived state and
   * the Auto review integration respectively.
   */
  presets: Record<string, PresetSpec>
  /**
   * Default for new sessions. When omitted, the preset matching the composed
   * sandbox and approval defaults is used.
   */
  defaultPreset: Volatile<string | undefined>
}
```

The service requires a confining `ctx.shell` executor and `ctx.approval`, and misconfiguration fails at plugin load: configured entries named `custom` or `auto` throw, and composing over a bash executor that does not confine (no `sandboxMode` capability fact) throws because presets bundle a sandbox mode.

## Fixed current-session Auto registration

The Auto integration calls `registerAuto(admit)` for its effect lifetime. This service fixes the `auto` identity and its `danger-full-access` plus `ask` bundle, and a recorded Auto selection also matches the `never` policy that delegated children pin; the shipped client locale dictionaries own Auto's label and description, while configured preset presentation remains Host-owned. Callers cannot publish another preset through a generic contribution API. Auto appears after configured presets, never enters the `permission.defaultPreset` settings schema, and disappears when the effect is disposed. The synchronous `admit` callback runs before Auto selection mutates the Session and before a stored Auto Session publishes, so a missing or closing integration does not rewrite the durable identity.

Registering or removing Auto emits the payload-free `permission-presets/catalog-changed` notification. Process consumers subscribe before calling `catalog()`, then re-read the complete selectable catalog after each notification. The `permissions` Session projection contains only `currentValue`, so catalog changes append no Session event, publish no Session projection frame, and leave the Session sequence unchanged.

## Current preset and the derived `custom`

`current(session)` derives the effective preset from the required `permissions` projection. The unit folds the session's sandbox mode, approval policy, and recorded selection; values absent within that state fall back to the executor's configured mode and the approval service config, then `ask`. A missing projection key fails explicitly. The service prefers a still-matching selection, including a recorded Auto selection under the `never` approval policy, then the first matching configured entry, and otherwise returns `CUSTOM_PRESET` (`'custom'`). `custom` is derived-only: clients may display it as the current value, but it is never a switch target or an event payload.

`names` lists configured presets in declaration order followed by Auto while its integration is live. `catalog()` returns those selectable entries as one process-level snapshot. `optionOf(name)` builds an available entry (its label falls back to the key) or the derived `custom` presentation, and throws for any other name. Clients join the catalog with the Session projection; `custom` may label the current value but never becomes a catalog entry.

```ts type-equiv
/** Presentation for an available preset or the derived `custom` current value. */
interface PresetOption {
  /** Stable option value: a configured preset key, live `auto`, or derived `custom`. */
  value: string
  /** The display label. */
  name: string
  /** One user-facing sentence on what the value means; omitted when not configured. */
  description?: string
}
```

## Switching and the `permission/preset` event

`set(session, name)` resolves the preset (unknown names throw), runs Auto admission when applicable, appends a log-only `permission/preset` event unless `name` is already the effective preset, then writes each knob through its own setter — `setSandboxMode` from [dsh-sandbox-policy](../../packages/sandbox/sandbox-policy) and `setApprovalPolicy` from [dsh-user-approval](../../packages/interaction/user-approval) — only when that knob's effective value changes. The selection event precedes the knob events in the same turn, and re-selecting the effective preset appends nothing.

`permission/preset` is durable, log-only user intent: it stays out of the model transcript (the knob events own the model-visible consequences through their consumers), and it exists so `current()` can preserve which preset the user chose when two presets share a bundle. The `permissions` projection folds that selection with both knob events and retains the `session/end-seed` boundary used to distinguish a restored empty seed from a fresh session; replay needs no catch-up state or raw-log rescan. A restored `auto` selection requires the live Auto registration before Agent publication. The complete event declaration is in the [persistence log event catalog](../persistence-catalog.md); the method signatures are in the generated [service catalog](#ctxpermissionpresets--permissionpresetservice).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxpermissionpresets--permissionpresetservice"></a>

### `ctx.permissionPresets` — `PermissionPresetService`

Owns the deployment's configured permission presets, the fixed Auto integration hook, and their write path. Requires a confining `ctx.shell` executor and `ctx.approval`; unmatched knob values are reported as CUSTOM_PRESET, not an error.

```ts cordis-catalog
/**
 * Read the complete process-level catalog exposed to current-session UI.
 * @returns every currently selectable preset in contribution order.
 */
@Remote('catalog') catalog(): PermissionCatalog

/**
 * Publish the fixed current-session Auto preset for the calling
 * integration's effect lifetime.
 * @param admit - synchronous gate run before live Auto selection or restore.
 * @returns the async effect disposer that removes Auto.
 */
registerAuto(admit: () => void): () => Promise<void>

/**
 * Resolve the preset matching the effective knob values. A still-matching
 * last selection wins shared-bundle ties, and a still-selected Auto also
 * matches the `never` approval policy; otherwise the first configured
 * match wins. Returns
 * {@link CUSTOM_PRESET} when no available preset matches.
 * @param session - the session whose knob state is read.
 * @returns the effective preset name, or `custom` when nothing matches.
 */
current(session: Session): string

/**
 * Resolve an available preset's knob bundle.
 * @param name - the preset name to resolve.
 * @returns the configured bundle.
 * @throws when `name` is neither configured nor the currently live Auto preset.
 */
resolve(name: string): PresetSpec

/**
 * Build the client option for an available preset or {@link CUSTOM_PRESET}.
 * A missing label falls back to the preset key.
 * @param name - a configured preset key, live `auto`, or `custom`.
 * @returns the option a client renders.
 * @throws when `name` is neither a configured preset, live `auto`, nor `custom`.
 */
optionOf(name: string): PresetOption

/**
 * Record a changed preset, then update each changed knob through its own
 * setter. Selecting the effective preset again appends nothing.
 * @param session - the session the switch belongs to.
 * @param name - the preset to switch to; unknown names throw.
 */
set(session: Session, name: string): void
```

Types: [Session](session.md)

Source: [`packages/interaction/permission-presets/src/index.ts`](../../packages/interaction/permission-presets/src/index.ts)

<a id="permission-presets-events"></a>

### `permission-presets/*` events

<a id="permission-presetscatalog-changed--emit"></a>

#### `permission-presets/catalog-changed` — emit

The selectable process catalog changed. Payload-free by design: consumers subscribe first, then re-read the complete catalog.

```ts cordis-catalog
/**
 * The selectable process catalog changed. Payload-free by design:
 * consumers subscribe first, then re-read the complete catalog.
 * @mode emit
 */
'permission-presets/catalog-changed'(): void
```

Source: [`packages/interaction/permission-presets/src/types.ts`](../../packages/interaction/permission-presets/src/types.ts)
<!-- END GENERATED cordis-surface -->
