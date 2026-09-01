---
description: "Settings domain base plugin: the settings-namespace scope service, schema service, and the canonical settings slot-type contract for the dsh web client."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-settings` is the base every preference surface in the dsh web client builds on: a feature plugin binds a namespace and stores or edits its preference rows in the Host settings document without re-implementing transport or schema handling. `ctx.settingsScope` derives a per-namespace scope from the shared document mirror with revision fencing, so a concurrent write from another surface is refused instead of silently overwritten; `ctx.settingsSchema` rehydrates and validates schemas and edits immutable paths synchronously. It declares the slot types settings surfaces fill — `settings.trigger`/`settings.header`/`settings.close` (chrome), `settings.action` (ordered header actions), `settings.section` (one page per feature), `settings.plugins.tab`, and `settings.onboarding` — and renders nothing itself. Because it depends on no `ui-*` presentation package, any feature that owns a preference can reach it; the settings shell itself lives in ui-settings-general.

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

Feature plugins use this package to store and edit their preferences without re-implementing transport or schema handling. Mount it once per composition; it injects the `remote` service with its `settings` namespace and owns the single `settings.describe` reader in the browser.

### Binding a namespace

A feature calls `ctx.settingsScope.bind(spec)` with a per-namespace spec and gets a scope derived from the shared document mirror. The scope snapshot carries the resolved section, composition `base`, raw `user`, revision, writability, and host/memory mode; a field is overridden when it is present in `user`, even when its value equals `base`, and `unset` clears that override. Writes go through the scope: `set` and `unset` submit one operation, while `mutate` submits several ordered operations atomically. Each write is fenced by the namespace revision as `expectedRevision`, so a concurrent write from another surface is refused instead of silently overwritten. A staged editor can supply the revision where its draft began as a fixed fence; otherwise the scope uses the latest queued or mirrored revision.

### Filling the settings slots

A settings surface registers into the slot types this package declares. The shell (`sidebar.settings` occupant, navigation, chrome) lives in ui-settings-general; feature pages register `settings.section` contributions; the Plugins section hosts `settings.plugins.tab` pages; onboarding steps register `settings.onboarding`. Cross-namespace surfaces (schema introspection, the served-namespace directory, `hasDocument`) read the same mirror through `ctx.settingsScope.describe()`.

### Observable success and failures

A bound scope reflects the current document revision immediately; a committed write folds its answer back into the mirror with no re-read. A rejected or failed latest write triggers one mirror recovery read; a superseded write leaves recovery to its successor. Without a `decode` in the spec, a section that is not a plain object or fails schema rehydration publishes no value, so a row renders its own absent state instead of a half-decoded one.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package realizes one ownership rule: the browser keeps one shared mirror of the settings document, and every derived surface reads that single source, so any moment in time shows the same document revision.

### The describe mirror

The plugin injects `remote` with its `settings` namespace, resolves Host persistence once from the fixed `remote.$host` facts, and owns the one `settings.describe` reader in the browser: a shared mirror refreshed on every forwarded `settings/document-updated` event and on `connection/reset` (the first connection included, closing the window where a commit lands between the eager read and the SSE subscription). Cross-namespace surfaces read it through `ctx.settingsScope.describe()`, a read/fold face (`getSnapshot`/`subscribe`/`ensure`, plus `acceptView` folding a write answer in).

### Scope derivation

`ctx.settingsScope.bind(spec)` returns a per-namespace scope derived from the mirror on the caller's context: the scope's disposer belongs to the calling fiber, binding adds no wire read, and a row's activation never blocks on the settings transport. Writes stay per-scope: `set` and `unset` are single-operation forms of `mutate`, which copies and queues several ordered field operations behind one namespace revision as `expectedRevision`. A committed mutation folds its answer in, a rejected or failed latest mutation triggers one recovery read, and a superseded one leaves recovery to its successor. The cold-boot read count is pinned by `../../../apps/web/tests/startup-rpc-budget.e2e.ts`; a new direct `settings.describe` caller in client code is a regression against it.

### Schema service

`ctx.settingsSchema` performs synchronous schema rehydration, validation, and immutable path editing for settings plugins. Without a `decode` in the spec, a section that is not a plain object, fails its rehydrated schema, or carries a schema envelope this client cannot rehydrate publishes no value at all.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the settings surface family and the durable seam behind it.

- [ui-settings-general](../ui-settings-general/README.md) — the settings shell: trigger chrome, navigation, General section, onboarding projection.
- [ui-settings-plugins](../ui-settings-plugins/README.md) — the Plugins section and its configurable host-plane cards.
- [ui-settings-models](../ui-settings-models/README.md) — the Models page and DeepSeek onboarding over this base.
- [settings](../../settings/README.md) — the durable user-settings seam and its file provider.
- [ui-sidebar](../ui-sidebar/README.md) — the sidebar shell whose bottom seat hosts the settings trigger.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the settings transport cannot reach; they are current package constraints.

- **Non-loopback pages get no durable settings** — this Client keeps Host persistence disabled there, so a scope starts `unavailable` and never crosses the wire; every row it backs is inert even though Connection authentication covers the API.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. A presentation shell projecting the settings.section ledger into navigation — it emits no cordis events and owns no cross-plugin mutable relation; slot declaration/registration conflicts already fail loud in the slot core at load time.
