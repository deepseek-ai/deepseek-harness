---
description: "Settings domain base plugin: shared configuration forms, schema service, and the canonical settings slot-type contract for the dsh web client."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings

English | [中文](README.zh.md)

## Summary

This package lets web-client features expose editable preferences backed by the Host settings document without implementing their own transport or schema handling. Each feature gets namespace-scoped reads and writes, atomic multi-field updates, schema validation, and protection against silently overwriting concurrent changes. It also provides the standard extension points for settings chrome, pages, header actions, plugin tabs, and onboarding while rendering no interface itself. Any preference-owning feature can use it without depending on a presentation package; a separate package provides the settings shell.

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

### Configuration forms

`ctx.configForms.developerTools` owns the Coding Tools switch and the shared Web and desktop preference `ui-settings.enabled`, defaulting to `true`. Its `enabled` observable publishes accepted choices and `setEnabled` uses the same ordered settings writes. Desktop and loopback Web persist to the Host document; remote Web keeps this choice in one browser-local observable until reload without issuing Host writes. This controls presentation and HTML preview permissions, not Host authorization or Session recording. Host-backed clients keep developer features disabled until the first accepted schema-resolved value arrives; missing or failed initial responses do not enable them. Later refreshes retain the last accepted choice.

Feature adapters use `ctx.configForms.get(entryId)` to obtain accepted values and a write queue shared by every editor of that Host entry. Snapshots contain resolved `value`, inherited `base`, raw `user`, revision, writability, and persistence mode. `set` and `unset` submit one operation; `mutate` submits one atomic operation list. Staged editors pass the revision read before editing; conflicts preserve their drafts. Unsetting removes the override and restores inheritance.

### Following served namespaces

A page that edits a namespace another plugin owns registers through `ctx.configForms.whileServed(namespaces, register)`: `register` runs once any listed namespace is in the shared mirror, receives the set of namespaces the Host serves, and returns the registration's disposer, which runs when none of them is served any more or when the disposer `whileServed` returns runs. The caller owns that returned disposer and wraps it in `ctx.effect`; unlike `get`, the service registers nothing on the caller's context. A deployment that never composed the owner therefore shows no trace of the page, and a namespace the Host stops serving withdraws it. The four official pages on the Plugins page ride it, one companion package each.

### Filling the settings slots

A settings surface registers into the slot types this package declares. The shell (`sidebar.settings` occupant, navigation, chrome) lives in ui-settings-general; feature pages register `settings.section` contributions; the Plugins section hosts `settings.plugins.tab` pages; onboarding steps register `settings.onboarding`. Cross-namespace surfaces (schema introspection, the served-namespace directory, `hasDocument`) read the same mirror through `ctx.configForms.describe()`.

### Observable success and failures

A committed write folds its answer into the shared mirror. Refused writes refresh the latest Host values. Browser validation uses the serialized Config schema; the Host validates complete configuration, including checks that cannot be serialized.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The optional `settings.launcher` contribution receives sidebar geometry, whether the open Settings panel covers the sidebar, the settings navigation callbacks, and the effective Settings key labels and accessible combination. The shell omits shortcut presentation for an unbound command and retains its plain Settings trigger when no launcher is registered.

<details>
<summary>Implementation internals — click to expand</summary>

The package realizes one ownership rule: the browser keeps one shared mirror of the settings document, and every derived surface reads that single source, so any moment in time shows the same document revision.

### The describe mirror

The Host Config of the `ui-settings` entry declares the default-on `enabled` preference. The Client plugin injects `remote` with its `settings` namespace, resolves Host persistence once from the fixed `remote.$host` facts, and owns the one `settings.describe` reader in the browser: a shared mirror refreshed on every forwarded `settings/document-updated` event and on `connection/reset` (the first connection included, closing the window where a commit lands between the eager read and the SSE subscription). Cross-namespace surfaces read it through `ctx.configForms.describe()`, a read/fold face (`getSnapshot`/`subscribe`/`ensure`, plus `acceptView` folding a write answer in).

### Shared entry writes

The provider owns one controller per Host entry, including its subscription and write queue; repeated `get(entryId)` calls return the same form. Consumers release their own view subscriptions. No caller-scoped configuration binding is created. The startup RPC budget covers the shared describe reader.

### Schema service

`ctx.settingsSchema` rehydrates schemas, validates drafts, and edits nested values. Invalid wire values do not replace accepted values.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the settings surface family and the durable seam behind it.

- [ui-settings-general](../ui-settings-general/README.md) — the settings shell: trigger chrome, navigation, General section, onboarding projection.
- [ui-settings-plugins](../ui-settings-plugins/README.md) — the Built-in plugins section shell around the inventory tab.
- [ui-settings-shell](../ui-settings-shell/README.md), [ui-settings-agent-loop](../ui-settings-agent-loop/README.md), [ui-settings-subagent](../ui-settings-subagent/README.md), [ui-settings-web-search](../ui-settings-web-search/README.md) — the official configuration pages on the Plugins page, each following its namespaces through `whileServed`.
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

- **Non-loopback pages get no durable settings** — this Client keeps Host persistence disabled there, so a form starts `unavailable` and never crosses the wire; form writes are inert even though Connection authentication covers the API. The shared Coding Tools preference instead provides browser-local changes.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. A presentation shell projecting the settings.section ledger into navigation — it emits no cordis events and owns no cross-plugin mutable relation; slot declaration/registration conflicts already fail loud in the slot core at load time.
