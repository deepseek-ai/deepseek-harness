---
description: "Recommend built-in official plugins and official connectors for explicit user needs, and enable or install them from conversation cards."
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-recommendations

English | [中文](README.zh.md)

## Summary

Users discover a relevant built-in plugin when they discuss a need or ask how to do something in DSH, and an app's official connector, such as Feishu's, when a task needs that app. The Agent answers first, then offers one card after the completed Turn: open details, Enable, or Not now; for a connector the profile lacks, Install and enable. Enabling changes the whole profile and persists across restarts. The Agent learns the result with the next request; a click starts no model turn. An enabled connector's card offers Connect account, which opens its page in Plugins.

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

The Web and Desktop composition ([`dsh-web-app`](../../bundle/web-app/README.md)) mounts this package with the shared [action card service](../../interaction/action-cards/README.md) and its browser half. Settings → General → Personalized recommendations turns new cards off. This plugin has no configuration of its own.

Plugin recommendations keep working when the Personalized pages row (`creation-recommendations`) is disabled, and neither package depends on the other. A Turn shows at most one card across both kinds: the first valid `action-card` block of the Turn becomes the card. For several independent needs, guidance follows an explicit user priority and otherwise prefers an existing plugin over a new page; other needs stay in the answer.

### Outcomes and recovery

The card appears below the answer after the Turn that holds its block ends. Enable requires permission to modify the profile. The card reads the plugin's catalog text when shown and again after each action; a refused lookup shows its reason, a lost reply says the details could not be loaded, and both offer Not now and Try again but no Enable. The Host rechecks the plugin's catalog eligibility when the user acts. A saved selection can require a restart. A failed change can be retried from the same card, and so can an enable whose result a plugin reload cut off, which the card shows as unconfirmed; once that enable has landed, the next click on the card shows Enabled. A plugin already selected elsewhere settles as already enabled without another change. An undecided card still offers Enable and Not now after a later proposal. A lost response leaves the outcome uncertain until the Session projection reconnects; repeated card actions are idempotent.

Install and enable first switches on the Connectors tab of Plugins when that shipped bundle is off; a failure there is logged and the installation continues. It then installs the connector package at the running DSH version, saves that exact version, and enables the connector; an installation that adds another package or version is undone, and when another card or the Plugins page installed the connector while this installation waited, the card enables that installation instead. When pnpm stops the installation on install scripts of the connector's dependencies, the card lists them and offers Allow these scripts and retry, which allows exactly the listed scripts in the profile and installs again. Another failed installation can be retried from the card or done from Connectors in Plugins, and one that a plugin reload cut off is unconfirmed, as an enable is.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host entry is a function plugin. Its `apply` assembles the internal `pluginRecommendations` Remote service with `ctx.plugin`; the service reads catalog text for cards and enables plugins for its card kind. It is not a separately configurable or replaceable YAML entry and adds no service to `dsh-base`. Disabling the feature removes its skill, card kind and Remote and drains its owned enabling work.

The plugin adds no model tool and no system-prompt section. It registers the `official-plugins` skill; loading it appends the current eligible catalog from `pluginManager`, followed by the official connectors of the generated `OFFICIAL_CONNECTOR_CATALOG` in [`dsh-official-bundles`](../../util/official-bundles/README.md), each with whether the profile holds (`installed`) and selects (`enabled`) it, classified as a card classifies it: a connector the profile does not hold reads as neither, and an installed one that a card cannot enable is left out, as an ineligible plugin is. The skill's catalog entry is composed from one `listBundles()` result: a fixed opening and closing around a clause that names, by their English titles in the connector catalog's order, the apps whose connector a card could offer now, because the profile does not hold it or holds it usable and switched off; without such a connector the clause is left out. The first lookup composes the entry, and every later lookup reuses it, whatever its working directory or scope, until `plugin-manager/changed`, which Plugin Manager emits after every operation, discards it and invalidates the cached catalogs. A failed `listBundles()` is not kept: that lookup leaves the skill out, which the skill registry logs and marks incomplete, and the next lookup reads the listing again. A lookup cancelled while the shared read runs stops without ending the read for the other lookups. The loaded definition carries the entry its lookup listed.

The plugin registers the `enable_official_plugin` kind with the shared [action card service](../../interaction/action-cards/README.md): `details` holding the plugin `name`, and the `enable` and `approve` verbs, which require global Remote access. The service owns the card projection, Not now, the Remote action and the status notice. This plugin enables the named plugin through Plugin Manager, or installs a connector the profile does not hold with `installBundle` at `<name>@<DSH version>`, saved exactly and refused for any other package or version, and records `enabled`, `already-enabled`, `failed` or `unconfirmed`; a change Plugin Manager reports as failed or cancelled records `failed`. `approve` is accepted only when the card's last decision is a failure that recorded `pendingBuilds`; it installs again with exactly the recorded scripts allowed, never names the browser sends, and when the profile holds the connector by then it enables the connector as `enable` does and allows nothing. Before `enable` or `approve` on a connector card, the plugin switches on the Connectors tab bundle when it is listed, eligible and off; after the switch it checks again, as before it, and refuses the action when the plugin is unloading (`closing`) or the card's conversation is no longer a live root conversation (`not-live-root`). `unconfirmed` records an enable or installation whose result a plugin reload cut off. Before every action, including Not now, such a card checks the profile, and a plugin found on records `enabled` instead of a retry or a dismissal. Not now is recorded for an unstarted, failed or unconfirmed card.

The decision data carries `application: restart-required` when the saved selection waits for a restart, the management `errorCode` of a failed change, or `operation-error` when Plugin Manager rejected the change without one, and `pendingBuilds` with the install scripts awaiting approval when pnpm stopped the installation on them (package failure kind `build-blocked`); any other failure records none, because Plugin Manager lists every undecided script in the profile after any failed run. The status notice reports `application` and `errorCode` only.

Shipped, optional, official plugins that are available, writable and error-free are eligible, and so are the listed connectors: one the profile does not hold is installed, and an installed one must be available, writable and error-free. The name is checked when the user acts, not when the model proposes. The Remote `describe(sessionId, cardId)` returns the current title, description and selection of a card's plugin, with `connector: true` for an installed connector, `installable` with the connector catalog's title and description in every shipped language for a connector the profile does not hold, or a refusal.

Concurrent actions on one card share one operation, and disposal stops local follow-up without waiting on a profile mutation queued behind its own HMR unload. Plugin Manager owns an accepted mutation; an unconfirmed card rechecks the profile when clicked again. Profile files own installation state; the card decision records only the historical outcome.

- [Source](src/index.ts) — registration and service entry.
- [Tests](tests/) — actions, recovery and lifecycle evidence.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Plugin manager](../../boot/plugin-manager/README.md) — profile changes.
- [Action cards](../../interaction/action-cards/README.md) — card blocks, card state and user actions.
- [Recommendation cards](../../client/ui-plugin-recommendations/README.md) — the card body.
- [Personalized pages](../creation-recommendations/README.md) — the other card kind.

<a id="model-experience"></a>
## Model Experience

### Official plugin recommendations

#### What the model sees

The existing `skill` tool loads `official-plugins` when the user asks how to do something in DSH, asks whether DSH can do something, or says a capability is missing or should change, such as input, displayed thinking or titles, session search, terminals, worktrees, desktop control, automation, access, approval prompts, output badges or signatures, and plugin sources, or when a task needs the app of a connector a card could offer. The catalog entry is composed from the profile's state: of Feishu, WeCom, DingTalk, Tencent Meeting, Notion, Tencent Docs and Linear it names only the apps whose connector the profile does not hold or holds switched off, so a task that needs the app of an enabled connector does not load the skill. The catalog entry tells the Agent that such a question is not a request to develop DSH and to load the skill before reading files. Loading returns matching policy, the submission rule and the current catalog with names, English titles and descriptions, and enabled state; connector entries also carry `installed`. An enabled match gets usage guidance without a card, except an enabled connector whose account is not connected; a partial match states its limit. A connector is offered when the user's own request in the Turn needs its app and the Agent cannot reach the app, ordinary tasks included: the connector is not enabled, or it is enabled but its account is not connected, and then the card's Connect account opens the connector's page. The answer says in one sentence that the task can continue once the account is connected; none is offered when one of the Agent's tools already belongs to that app, such as its MCP server, and the Agent uses that tool instead. Other tasks, quoted wishes, discussion-only and declined requests get no card. The proposal is one [`action-card` block](../../interaction/action-cards/README.md#model-experience) that ends the final answer, holding `action: "enable_official_plugin"`, the plugin's catalog `title`, a one-sentence `brief` in the user's language and `details` holding the catalog `name`; the block itself is the submission, the user does not see it, and nothing changes until the user clicks Enable. Because the card shows only the plugin’s catalog title and description, the answer before the block says in one sentence, in the user’s language, how the plugin meets the need; `brief` is that same sentence. At most one short invitation to click Enable below, Install and enable for a connector the profile does not hold, or Connect account for an enabled connector, comes right before the block and never calls a plugin that is off already on. The next request after a click carries the shared status notice with this kind's guidance: a fact, not a request for more work; enabling authorizes nothing beyond that plugin; and an enabled connector works once the user connects its account.

#### Token effect

With recommendations enabled, the skill catalog contains one entry composed from the profile's state: 408 characters when no connector can be offered and up to 498 with all seven apps named, within its 500-character limit. A change to the entry, such as the one enabling a connector causes, appends one replacement catalog, as [tool-skill](../../skill/tool-skill/README.md#model-experience) documents. The Creator preset excludes this entry. A skill load appends a body of about 10.4K characters: a 4,258-character policy plus the catalog, about 6.2K characters on macOS for 18 eligible plugins and the seven connectors with English titles and descriptions only; the connector entries take 1.3K, and the catalog grows with the number of plugins. A recommendation needs one skill load, and the `action-card` block in its final answer is part of that answer; the replayed block is 237 characters, about 59 tokens at four characters per token. A changed card appends one short status notice to the next request.

#### KV Cache effect

Skill contents and the proposal block append to the transcript; the common system prompt and the tool declarations are unchanged, as the [action cards](../../interaction/action-cards/README.md#model-experience) page describes. Enabling a recommended plugin or installing a connector can change later tool declarations and their cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The manual real-model input set is in `evaluation/intent-cases.json`; unit tests do not measure semantic intent accuracy. Matching, priority between needs and respect for a request not to recommend are skill guidance evaluated with real model runs, not keyword guards.

- Only shipped, optional, official plugins and the seven official connectors are eligible; third-party registries are excluded.
- Installing a connector from the card works whenever its package is published to npm at the running DSH version; a build whose version is not published cannot install one from the card.
- The account is connected on the connector's page in Plugins; the card opens that page and does not show the connection state.
- Composing the skill's catalog entry reads the plugin manager's listing, which takes 65–70 ms on a 28-bundle installation, once per start and per Plugin Manager change. A profile change made outside Plugin Manager, such as a hand edit or a CLI patch, announces nothing, so the entry follows it at the next Plugin Manager change or restart.
- The connector catalog is compiled into the installation, so a new connector reaches the cards only in a new DSH release. A connector package missing from the catalog fails a test until `CONNECTOR_BUNDLES` lists it and the catalog is regenerated.
- Recommendations require the exact live conversation Agent with an `origin` other than `subagent`; there is no unsolicited opportunity discovery.
- A historical decision does not continuously track changes later made on the Plugins page.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
