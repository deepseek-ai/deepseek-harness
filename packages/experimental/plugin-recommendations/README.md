---
description: "Recommend built-in official plugins for explicit user needs and enable them from conversation cards."
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-recommendations

English | [中文](README.zh.md)

## Summary

Users can discover a relevant built-in plugin while discussing a concrete need or asking how to do something in DSH. The Agent answers first, then offers one card at the completed Turn’s end; the user can open its plugin details, choose Enable, or choose Not now. Enabling changes the whole profile and persists across restarts. The Agent learns the result with the next request; clicking starts no model turn. Users can later disable or remove the plugin from its details page.

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

Open Plugins → More → Experimental plugins and enable [Personalized recommendations](../personalized-recommendations/README.md); its Plugin recommendations row is this package. Shipped profiles leave this experimental bundle disabled. Enabling pins it to the main Plugins list; disabling returns it to the secondary page only. The Personalized recommendations bundle also enables the shared [action card service](../action-cards/README.md) and its browser half; that service's `queuedMessageLimit` sets how many queued next-turn messages stop the current turn's card. This plugin has no configuration of its own.

The experiment keeps working when the bundle’s Personalized pages row is switched off, and neither package depends on the other. A Turn shows at most one card across both kinds: the first accepted `propose_action` call of the Turn becomes the card. For several independent needs, guidance follows an explicit user priority and otherwise prefers an existing plugin over a new page; other needs stay in the answer.

### Outcomes and recovery

The card appears after the Turn of its accepted call ends. Enable requires permission to modify the profile. The card reads the plugin's catalog text when shown; a refused lookup shows its reason, a lost reply says the details could not be loaded, and both offer Not now and Try again but no Enable. The Host rechecks the plugin's catalog eligibility when the user acts. A saved selection can require a restart. A failed change can be retried from the same card, and so can an enable whose result a plugin reload cut off, which the card shows as unconfirmed; once that enable has landed, the next click on the card shows Enabled. A plugin already selected elsewhere settles as already enabled without another change. A later proposal replaces an undecided card, which then shows Replaced; while `queuedMessageLimit` or more messages are queued, the card tool refuses a proposal. A lost response leaves the outcome uncertain until the Session projection reconnects; repeated card actions are idempotent.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host entry is a function plugin. Its `apply` assembles the internal `pluginRecommendations` Remote service with `ctx.plugin`; the service reads catalog text for cards and enables plugins for its card kind. It is not a separately configurable or replaceable YAML entry and adds no service to `dsh-base`. Disabling the feature removes its skill, card kind and Remote and drains its owned enabling work.

The plugin adds no model tool and no system-prompt section. It registers the `official-plugins` skill; loading it appends the current eligible catalog from `pluginManager`. It registers the `enable_official_plugin` kind with the shared [action card service](../action-cards/README.md): the `official-plugins` skill, `details` holding the plugin `name`, and the Enable verb, which requires global Remote access. The service owns the `propose_action` tool, the card projection, Not now, the Remote action and the status notice. This plugin enables the named plugin through Plugin Manager and records `enabled`, `already-enabled`, `failed` or `unconfirmed`. The decision data carries `application: restart-required` when the saved selection waits for a restart, and the management `errorCode` of a failed change, or `operation-error` when Plugin Manager rejected the change without one. `unconfirmed` records an enable whose result a plugin reload cut off. Before every action, including Not now, such a card checks the profile, and a plugin found on records `enabled` instead of a retry or a dismissal. Not now is recorded for an unstarted, failed or unconfirmed card. Only shipped, optional, official plugins that are available, writable and error-free are eligible; the name is checked when the user acts, not when the model proposes. The Remote `describe(sessionId, callId)` returns the current title, description and selection of a card's plugin, or a refusal.

Concurrent actions on one card share one operation, and disposal stops local follow-up without waiting on a profile mutation queued behind its own HMR unload. Plugin Manager owns an accepted mutation; an unconfirmed card rechecks the profile when clicked again. Profile files own installation state; the card decision records only the historical outcome.

- [Source](src/index.ts) — registration and service entry.
- [Tests](tests/) — actions, recovery and lifecycle evidence.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Plugin manager](../../boot/plugin-manager/README.md) — profile changes.
- [Action cards](../action-cards/README.md) — the card tool, card state and user actions.
- [Recommendation cards](../client-ui-plugin-recommendations/README.md) — the card body.
- [Personalized pages](../creation-recommendations/README.md) — the other card kind.

<a id="model-experience"></a>
## Model Experience

### Official plugin recommendations

#### What the model sees

The existing `skill` tool loads `official-plugins` when the user asks how to do or use something in DSH, asks whether DSH can do something, or says a capability is missing or should change, such as tools, input, displayed thinking or titles, session search, terminals, worktrees, agent teams, desktop control, automation, access, approval prompts, output badges or signatures, and plugins or plugin sources. The catalog entry tells the Agent that such a question is not a request to develop DSH and to load the skill before reading files or source. Loading returns matching policy, the submission rule and the current catalog with names, localized titles, descriptions and enabled state. An enabled match gets usage guidance without a card; a partial match states its limit. Ordinary tasks, quoted wishes, discussion-only and declined requests get no card. The proposal is one [`propose_action`](../action-cards/README.md#model-experience) call in the same Turn as the skill load, with `action: "enable_official_plugin"`, the plugin's catalog `title`, a one-sentence `brief` in the user's language and `details` holding the catalog `name`; the call itself is the submission, and nothing changes until the user clicks Enable. Because the card shows only the plugin’s catalog title and description, the final answer says in one sentence, in the user’s language, how the plugin meets the need; `brief` is that same sentence. Only an accepted call's result says how to end the answer: `Card shown below your answer. Do not restate it. End with at most one short invitation in the user’s language to click Enable below; do not say the plugin is already on.` A refused call carries no invitation, so the Agent invites the user only to a card that exists. The next request after a click carries the shared status notice with this kind's guidance: a fact, not a request for more work, and enabling authorizes nothing beyond that plugin.

#### Token effect

While enabled, requests carry only the 495-character catalog entry, within the skill catalog's 500-character limit; the shared card tool is declared only after a card skill loads. A skill load appends about 26K characters: a 2.9K-character policy plus the catalog, about 22.9K characters for 14 eligible plugins with titles and descriptions in the eight shipped languages, growing with their number. A recommendation needs one skill load and one `propose_action` call before the final answer; the accepted call's result is 169 characters, about 42 tokens at four characters per token. A changed card appends one short status notice to the next request.

#### KV Cache effect

Skill contents and the proposal call append to the transcript; the common system prompt is unchanged, and the card tool joins the declarations only after a card skill loads, as the [action cards](../action-cards/README.md#model-experience) page describes. Enabling a recommended plugin can change later tool declarations and their cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The manual real-model input set is in `evaluation/intent-cases.json`; unit tests do not measure semantic intent accuracy. Matching, priority between needs and respect for a request not to recommend are skill guidance evaluated with real model runs, not keyword guards.

- Only shipped, optional, official plugins are eligible; missing packages and third-party registries are excluded.
- Recommendations require a live root conversation; there is no unsolicited opportunity discovery.
- A historical decision does not continuously track changes later made on the Plugins page.
- The catalog reports enabled state per bundle: Personalized recommendations shows as enabled while only its Personalized pages row is off, so the skill can tell a user who asks for a page that it is already on.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
