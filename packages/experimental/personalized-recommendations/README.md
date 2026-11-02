---
description: "Enable personalized page proposals and built-in plugin recommendations below answers with one experimental bundle."
kind: "package-bundle"
---

# @deepseek-ai/dsh-personalized-recommendations

English | [中文](README.zh.md)

## Summary

Get an optional card below an answer for two kinds of need: a page or small tool you want to keep, and a built-in plugin that provides a capability you ask about. Nothing is built or enabled until you click Create or Enable on the card. Enable Personalized recommendations on the Web or Desktop Plugins page; shipped profiles leave it disabled. Its page lists both features and their card rows, each with its own switch.

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

Open Plugins → More → Experimental plugins and enable Personalized recommendations. Enabling pins it to the main Plugins list; disabling returns it to the secondary page only. While the bundle is on, its page lists six rows in this order, each with its own switch:

| Row | Package | Contributes |
|---|---|---|
| Action cards | [`action-cards`](../action-cards/README.md) | The card tool, card state, user actions and status notices |
| Action card display | [`client-ui-action-cards`](../client-ui-action-cards/README.md) | The card frame below answers |
| Personalized pages | [`creation-recommendations`](../creation-recommendations/README.md) | Page proposals and their background creation |
| Personalized page cards | [`client-ui-creation-recommendations`](../client-ui-creation-recommendations/README.md) | The page card body |
| Plugin recommendations | [`plugin-recommendations`](../plugin-recommendations/README.md) | Built-in plugin recommendations and enabling |
| Plugin recommendation cards | [`client-ui-plugin-recommendations`](../client-ui-plugin-recommendations/README.md) | The plugin card body |

Switch off Personalized pages or Plugin recommendations to keep only the other feature: the switched-off feature withdraws its skill and card kind, and its earlier cards accept only Not now. Both features need the Action cards row; switching it off stops both until it is on again. Without a card body row, a card shows its proposal title and brief with Not now only. The Action cards row's `queuedMessageLimit` field sets how many queued next-turn messages make the card tool refuse the current turn's card. The Plugins page has no settings page for that row, so change the field with an `id: action-cards` override in the profile's `cordis.patch.yml`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The static `cordis.patch.yml` inserts the six rows with their package-owned ids and no configuration. This bundle is the only layer that declares these ids, so the plugin manager addresses each row by its id and the Plugins page can switch it. Both feature plugins inject `actionCards` and register their card kinds with it; the three browser rows register the card frame and the two card bodies. `src/index.ts` exports nothing.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Action cards](../action-cards/README.md) · [Personalized pages](../creation-recommendations/README.md) · [Plugin recommendations](../plugin-recommendations/README.md) · [Plugin manager page](../../client/ui-plugin-manager/README.md)

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the two features' skills, the shared `propose_action` tool and the card status notice, which the row packages document.

#### KV Cache effect

Enabling the bundle adds the two skills' catalog entries to requests; the card tool joins the declarations only after a card skill loads, as described on the [action cards](../action-cards/README.md#model-experience) page.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The bundle page lists every row the patch inserts, including the four card rows that only support the two features; it cannot mark a row as supporting or hide it.
- Each feature's own limitations are on its page: [Personalized pages](../creation-recommendations/README.md#known-limitations-and-deferred-work) and [Plugin recommendations](../plugin-recommendations/README.md#known-limitations-and-deferred-work).

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
