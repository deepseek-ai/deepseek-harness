# Agent Note: Plugin-owned settings surface

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-12-plugin-owned-settings-surface.zh.md)

## Problem

A plugin that registered a settings namespace could not reach the browser configuration page, and both gates that stopped it lived in this repository.

`packages/host/apiproxy` held two hardcoded namespace lists. `settings.describe` filtered its answer through them and every write checked them first, so a namespace outside them answered `settings-not-exposed` even when its owner had registered it. Adding a plugin to the configuration page therefore meant editing a package the plugin author does not own.

The plugin configuration section rendered an unordered list of whatever cards were registered into `settings.plugin.item`. A card carried an opaque `id`, never the namespace it edited, so the section could not tell which served namespaces already had a home. That left every question about "who renders this namespace" unanswerable from the ledger the section could see.

Together the two meant a user-authored plugin was configurable only by hand-editing `settings.yaml`. The [web plugin configuration note](../feature/2026-08-10-web-plugin-configuration.md) recorded the allowlist as deliberate, and the [config-plane boundaries note](2026-07-30-config-plane-boundaries.md) tied web-configurability to membership in the configurable-provider directory. Both conclusions blocked exactly the plugin authors the general seam was built for.

## Decision

**Registering is exposing.** The api-proxy serves every namespace `ctx.settings.describe()` returns and gates no write. `WEB_SETTINGS_NAMESPACES`, `PRODUCT_SETTINGS_NAMESPACES`, the union with `ctx.llm.listConfigurableProviders()`, and the `settings-not-exposed` error code are gone. A name no registration answers — unknown, or malformed and therefore unable to address one — folds into the seam's own `settings-rejected`, so the proxy contributes no boundary and no vocabulary of its own.

**The settings seam is untouched.** Which client may read a namespace, and which page renders it, are facts about consumers; a Service Definition that carried either would let one Consumer dictate its contract. `SettingsRegisterOptions` gains nothing.

**`settings.plugin.item` is keyed on the settings namespace.** The slot moved from `list` to `keyed`, the key being the namespace the card edits, following the `tool.call.toolview` precedent where each tool plugin registers its renderer under the tool name. A card declares `key`, not `id`/`order`. The slot is declared by the Plugins section's `configurable` tab, which owns the card list.

**The tab drives dispatch from the served namespaces.** It derives the current served set from `ctx.settingsScope.describe()` and follows that shared settings mirror, while its own listener follows the card slot ledger. It dispatches one key per served namespace. What renders is the intersection of two ledgers — namespaces a live Host plugin registered, and cards registered under those keys — computed in the tab's controller from the slot ledger (`ctx.slots.entries`, `ctx.slots.subscribe`) and the mirror answer. The later [settings describe mirror decision](2026-08-17-settings-describe-mirror.md) owns the browser-wide read and invalidation lifecycle.

Keying makes absence the signal, and that is what removes the bookkeeping the previous shape needed. A namespace another surface owns (`ui-theme`, `permission`, `llm-*`, `agent-presets`) has no card under its key, so it renders nothing without declaring anything anywhere. A card whose namespace this deployment does not serve is never dispatched, which also fixes the old empty-state defect: the tab counted registered cards, including ones rendering nothing, so a deployment exposing none showed an empty list instead of its empty line.

**Nothing renders a form it was not given.** The tab supplies no fallback card. A plugin's browser half owns its card completely — chrome, controls, and copy — which is what the slot's `fallback` option would have replaced with a schema-reverse-rendered form.

## What the allowlist protected

The gate did keep one thing off the wire, and this note states it plainly because the decision has to survive the accurate version: a registered namespace the list did not name never had its resolved, `base`, or `user` values reach the browser at all. The plugin inventory page is not a substitute — `PluginInventoryEntry` carries `entryId`, `moduleName`, `enabled`, and `fiberPhase`, and its "configuration" row renders an enabled/disabled tag, never a stored value.

What the gate was not is the security boundary its position suggested. Connection authenticates every Host API request before reaching this code; `role('secret')` fields are structurally stripped from every layer of every response; and the document the plane edits is the user's own `settings.yaml`, which the same settings page offers to open. The writes it did not block were also the consequential ones: `permission` (which can widen the approval preset) and `agent-presets` (which decides what a session mounts) were both already served.

So the exposure this change actually adds, in this repository, is one namespace: `agent-default-model`, whose two fields name a provider and a model and which no browser half renders. A future namespace whose values genuinely must not cross the wire is answered per field by `role('secret')` — finer than a namespace switch, and already enforced.

## Alternatives considered

**A declaration on `settings.register()`** (`client: { surface: 'plugin-config' | 'custom', title, description }`), which the removed `WEB_SETTINGS_NAMESPACES` comment named as the intended direction. It keeps registration from crossing the transport by default and lets a plugin author self-serve in one line. Rejected because `surface` is browser-page vocabulary and `title`/`description` are presentation: a Service Definition carrying them is a seam shaped by one Consumer. Its fail-closed property is also worth less than it reads — see what the allowlist protected, above.

**A separate exposure catalog**, a registry of its own that plugins join beside their settings registration, generalizing `ctx.llm.registerConfigurableProviders()`. Rejected because it makes one fact require two registrations that can drift: registering a namespace and forgetting the catalog entry produces a section nothing can edit, with no gate able to see the mistake.

**A deny-list `Config` field on the api-proxy**, so a deployment could withhold a namespace. Rejected for having no consumer: every currently registered namespace is one a user may edit, and a genuinely sensitive field is answered per-field by `role('secret')`, which is the finer instrument. A namespace-wide switch invented ahead of its first use is the speculative option the package rules forbid.

**A schema-driven generic card as the slot's `fallback`**, so a plugin with no browser half still got a form from `schema.toJSON()` (schemastery already carries `description`, `role`, `min`/`max`/`step` and serializes them). Rejected because client plugins load at runtime from mounted Loader entries, so a plugin author can ship a real card, and a reverse-rendered form was already judged worse than a hand-written one for the Models page. The `fallback` option remains available without a contract change if that judgment changes.

**A client-side claim registry**, where each surface owning a namespace declares it so a generic card knows what is already covered. Rejected with the generic card: keyed dispatch already makes an unclaimed key render nothing, so the registry would restate what the slot ledger says.

**Keeping the list slot and adding a namespace field to its options.** Rejected because the section would still enumerate entries rather than namespaces, keeping the empty-state defect and leaving a card for an uncomposed plugin to suppress itself.

## Consequences

A plugin distributed outside this repository is configurable from the settings page with no change here: it registers its namespace on the Host and its card under that key in the browser, and the section pairs the two. Cards now appear in card registration order rather than by hand-assigned `order`. That is stable for the cards this package registers, which install from one generator, and **not** stable across plugins: apply order between packages is unconstrained (`packages/client/AGENTS.md`), so several external cards can still reorder between boots. Ordering them needs an explicit key the section can sort on, which the keyed registration does not carry.

Deferred, and larger than this change: the redactor returns a `role('secret')` reachable only through a union, intersection, or transform verbatim (its own `TODO(settings-wire-redaction)`), and `schema.toJSON()` carries a secret's default. That gap predates this change, but serving every registered namespace widens its blast radius from schemas audited in this repository to any third-party schema, so the wire should refuse a namespace it cannot prove it can redact. Also deferred: an assembled-composition test of the headline capability — an overlay-mounted fixture plugin whose Host half registers a namespace and whose `dsh.client` half registers a card, asserted end-to-end. The current coverage proves each half separately; the shipped cards' unchanged output cannot prove the new path.

The section and its cards add no `settings.describe` reads: both derive from the browser-wide mirror. Its invalidation is imprecise in one direction: the wire announces document commits and connection resets, not registrations, so a namespace registered after the mirror's current answer joins on the next commit or reconnect.

Two frictions remain for an author outside this repository, both recorded in the section's README. The browser half must be a `dsh.client` package built in the client module system's lazy-CJS factory format, and the `clientBundle` preset that emits it lives in `packages/client/tsdown.client.ts` rather than a published package. The bundle-purity gate forbids importing this package's card chrome or staged-form model as values, so such a card reimplements staging and revision fencing. Sharing them would mean either publishing the preset or declaring a child slot inside the card so the section supplies the chrome; neither is built.
