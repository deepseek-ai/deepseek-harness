---
description: "Show official plugin recommendation cards after completed answers."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-plugin-recommendations

English | [中文](README.zh.md)

## Summary

Users see one plugin recommendation below the completed answer, with the plugin's current title and description in the interface language. The title and description form one target that highlights on hover; clicking it opens that plugin's details in Plugins without enabling it or changing the current Session. Enable and Not now remain separate choices. Decisions and the details link remain available after reconnecting.

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

Enable the [Personalized recommendations bundle](../personalized-recommendations/README.md). This browser contribution has no configuration fields; it fills the shared [action card frame](../client-ui-action-cards/README.md) for `enable_official_plugin` cards.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin mounts its catalog-text Remote, then registers its body with the shared card frame, which places the card after its Turn and supplies the card, its recorded decision and card-bound actions. The body asks the Host for the plugin's current catalog text and selection and renders the header with the Official badge, the details target, status, and Enable and Not now through the frame's action. The details target is named View details with the plugin title, and the catalog description remains its accessible description. A refused lookup shows its reason and a lost reply says the details could not be loaded; both offer Not now and Try again, which repeats the lookup, but no Enable. A recorded outcome stays as recorded even after its plugin leaves the catalog. While an action runs, only its own button reads Working, and both stay disabled. The plugin keeps returned catalog text by plugin name for its lifetime, so a revisited card renders it at once while its own lookup refreshes the selection. Until a plugin's first lookup returns, the card shows the proposed title, a placeholder description line and the disabled actions, so its layout holds. The Remote, the body registration and its dictionaries share one plugin lifetime.

Cards use the application font, a distinct title and compact body scale, and a separate action footer. The built entry supplies generated Remote descriptors to the source-tested mount lifecycle.

- [Source](src/client/index.ts)
- [Tests](tests/)

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Recommendation service](../plugin-recommendations/README.md) — eligibility, enabling and decisions.
- [Action card display](../client-ui-action-cards/README.md) — the frame, kind bodies and the process row.

<a id="model-experience"></a>
## Model Experience

Indirectly, through card actions: the shared Host card service adds a logged status notice to the next model request. The browser contribution adds no model tools or prompt content.

#### KV Cache effect

The card adds no model context. Its Enable action can change subsequent tool declarations through the Host.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only the first proposal in a Turn appears.
- Before a plugin's first lookup returns, the card reserves one description line; a longer description still extends the card when it arrives.
- Historical decisions do not track later changes made from the Plugins page.
- After a refused or lost lookup, Enable returns only when Try again gets the plugin's catalog text.
- A card whose plugin has left the catalog shows the proposed title instead of catalog text.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
