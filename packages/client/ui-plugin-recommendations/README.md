---
description: "Show official plugin and connector recommendation cards after completed answers."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-plugin-recommendations

English | [中文](README.zh.md)

## Summary

Users see one plugin recommendation below the completed answer, with the plugin's current title and description in the interface language. The title and description form one target that highlights on hover; clicking it opens the plugin's details in Plugins without enabling it or changing the Session. Enable and Not now remain separate choices. A connector the profile lacks shows its own title and description as plain text, offers Install and enable, and lists install scripts pnpm blocked for approval. An enabled connector's card offers Connect account beside its status unless dismissed or failed. Decisions and the details link survive reconnecting.

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

The Web composition ([`dsh-web-app`](../../bundle/web-app/README.md)) mounts this package. This browser contribution has no configuration fields; it fills the shared [action card frame](../ui-action-cards/README.md) for `enable_official_plugin` cards.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin mounts its catalog-text Remote, then registers its body with the shared card frame, which places the card after its Turn and supplies the card, its recorded decision and card-bound actions. The body asks the Host for the plugin's current catalog text and selection, again after each action, and renders the header with the Official badge, the details target, status, and Enable and Not now through the frame's action. The details target is named View details with the plugin title, and the catalog description remains its accessible description. A refused lookup shows its reason and a lost reply says the details could not be loaded; both offer Not now and Try again, which repeats the lookup, but no Enable. A card that names no plugin shows the frame's fallback, which offers only Not now. A connector the profile does not hold has no details page before installation, so the card shows the title and description the Host reads from the connector catalog as plain text in the same layout, without a details target. Its primary action reads Install and enable; after a failed installation recorded blocked install scripts, the card lists them and the action reads Allow these scripts and retry. That permission text and the action use the Plugins page's words for allowing install scripts in every language, so one consent reads the same wherever it is asked. A failed installation's status names its own recovery instead of the management error, except for a version conflict. The card of an enabled connector shows its status and Connect account in one footer row, unless the card was dismissed or its last attempt failed; Connect account opens the connector's page through the same navigation as the details target. A recorded outcome stays as recorded even after its plugin leaves the catalog. While an action runs, only its own button reads Working, or Installing for an installation, and both stay disabled. The plugin keeps returned catalog text by plugin name for its lifetime, so a revisited card renders it at once while its own lookup refreshes the selection; a lookup that finds a connector missing replaces the remembered text for that card. Until a plugin's first lookup returns, the card shows the proposed title, a placeholder description line and the disabled actions, so its layout holds. The Remote, the body registration and its dictionaries share one plugin lifetime.

Cards use the application font, a distinct title and compact body scale, and a separate action footer. [`api-remotes`](../../api/remotes/README.md) mounts the catalog-text Remote. The Plugins page provides `pluginNavigation` only while the current Peer may use it; the plugin registers its body for that time, and otherwise the [shared frame](../ui-action-cards/README.md) offers Not now alone.

- [Source](src/client/index.ts)
- [Tests](tests/)

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Recommendation service](../../extensions/plugin-recommendations/README.md) — eligibility, enabling and decisions.
- [Action card display](../ui-action-cards/README.md) — the frame and kind bodies.

<a id="model-experience"></a>
## Model Experience

Indirectly, through card actions: the shared Host card service adds a logged status notice to the next model request. The browser contribution adds no model tools or prompt content.

#### KV Cache effect

The card adds no model context. Its Enable, Install and enable, and Allow these scripts and retry actions can change subsequent tool declarations through the Host.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only the first proposal in a Turn appears.
- Before a plugin's first lookup returns, the card reserves one description line; a longer description still extends the card when it arrives.
- Historical decisions do not track later changes made from the Plugins page.
- After a refused or lost lookup, Enable returns only when a later lookup, from Try again or after an action, gets the plugin's catalog text.
- A card whose plugin has left the catalog shows the proposed title instead of catalog text.
- Before installation, a connector's card shows the proposed title with a placeholder line until its first lookup returns.
- Connect account only opens the connector's page; the card does not show whether the account is connected.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
