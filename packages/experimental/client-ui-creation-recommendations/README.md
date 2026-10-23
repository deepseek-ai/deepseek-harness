---
description: "Show completed-answer creation cards with location choice, Keep and Undo."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-creation-recommendations

English | [中文](README.zh.md)

## Summary

Users see one creation proposal below the completed answer. Short plans appear in full; longer ones fold after about two lines and expand on request. A dropdown offers Right sidebar, Session tab, Global page, or Write your own. The cost notice opens until dismissed; this browser remembers the choice across sessions. The information button reopens it. Only Create starts background work; chatting can continue. Progress appears in the header. Keep confirms retention; Undo removes the plugin, and Restore reinstalls it.

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

Enable the [Personalized recommendations bundle](../personalized-recommendations/README.md). This browser contribution has no configuration fields; it fills the shared [action card frame](../client-ui-action-cards/README.md) for `create_personalized_page` cards.

### Outcomes and recovery

An unstarted card stays available until a newer proposal in the same conversation replaces it. The replaced card keeps its history with a Replaced label and no creation or location controls. Supplied initial content appears below the plan as folded data, so the user sees what the Creator will receive. Started tasks retain their progress and retry actions. The shared card projection owns this state, so reload does not reactivate a card.

Creation, installation, retention and removal receipts come from the Session projection. The card restores them after reconnecting. A lost action reply shows an actionable error; retry uses the Host’s recorded state. Pending requests disable repeated actions. During generation, Cancel stops the child and waits for cleanup before retry. Accepted installations finish without cancellation. The information disclosure contains the source directory and explains that Undo keeps those files. The removed card offers Restore; when the retained files are gone, it asks for a new proposal.

Write your own reveals a placement field, limited to 1,000 characters; blank input cannot start creation. Choosing a preset ignores that custom text. Accepted requests persist it with the receipt for reconnect and retry, and Creator receives it with the full brief. Editing the draft, opening the menu and reading the cost notice make no model request. Dismissing the notice or choosing Create/Not now acknowledges it in browser-local storage; a new browser or cleared/unavailable storage can show it again. Historical settled cards keep the notice collapsed.

Plan disclosure depends on omitted text, not rendered height. Long previews collapse whitespace and preserve grapheme boundaries, including combined emoji; expanding restores the original brief. Short plans remain complete at every viewport width. Lines wrap naturally, with no fixed three-line limit, DOM measurement, or ResizeObserver.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin registers its body with the shared card frame, which places the card after its Turn and supplies the title, the folded brief, the fold component and card-bound actions. The body validates the card's details and recorded data, then renders the header with the cost notice toggle, the location picker, written placement, folded initial content, progress, Keep, Undo and Restore. The cost notice preference is a browser-local store owned by the plugin. The shared Menu handles portal positioning, keyboard selection and dismissal. The body registration and its dictionaries share one plugin lifetime.

- [Source](src/client/Card.tsx)
- [Tests](tests/)

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Creation service](../creation-recommendations/README.md) — creation ownership and persistence.
- [Action card display](../client-ui-action-cards/README.md) — the frame, fold and actions this body uses.
- [Slots](../../client/ui-slots/README.md) — completed-Turn presentation.

<a id="model-experience"></a>
## Model Experience

Indirectly, through an accepted Create action: the Host starts Creator with the full brief and selected or human-written placement, without adding browser tools or resuming the parent model.

#### KV Cache effect

Rendering and changing the location do not affect the model cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The displayed brief is model-authored. Necessary existing data travels separately in the proposal’s optional `initialContent`.
- Historical receipts do not continuously track later manual changes on the Plugins page.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
