---
description: "Browser half of optional action cards: the card frame below completed answers, the body registry that experiment packages fill, and the one-line process row of propose_action calls."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-action-cards

English | [中文](README.zh.md)

## Summary

Users see an optional action card below a completed answer: its title, a brief that folds when long, and the controls of the experiment that proposed it. In the process area, the proposal shows as one row with the card title and whether the call was accepted; a refused call expands to its reason. A card whose experiment provides no controls in this browser offers only Not now. Showing, expanding and folding cards make no model request.

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

Enable the [Personalized recommendations](../personalized-recommendations/README.md) bundle, which inserts this package beside its [Host service](../action-cards/README.md). This browser contribution has no configuration fields.

### Register a card body

A kind's browser plugin injects `actionCards` and registers its body inside its own `ctx.effect`: `ctx.actionCards.register({ action, locale, Body })` returns the disposer. The frame renders `Body` for cards of that action with the card, its recorded or derived decision, the Session id, the frame's title and folded brief as `summary`, the frame's fold component as `Folded`, an `act(verb, payload?)` bound to the card, and a translator `t` for the body's own locale namespace. The body places `summary` in its own layout and owns its header, controls, status and footer. A second body for the same action is a registration error.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One `conversation.chat.turnTail` entry reads the `actionCards` Session projection and shows the card admitted in its Turn after that Turn has ended with a final answer; a Turn that ends without answer text shows no card, and should several cards share a Turn, the lowest call id is shown. The frame sets `data-action-card` to the call id and names its region by the card title. Folding counts a wide grapheme, such as a Chinese character, as two Latin-letter widths and folds after about 260; it never measures layout or alters the full text.

A `tool.call.toolview` entry keyed `propose_action` renders the process row from the recorded call arguments and result. The plugin provides the body registry at its top level, then mounts the generated `actionCards` Remote and registers its dictionaries and slot entries for the same lifetime.

| Source | Contents |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Registry, Remote, dictionaries and slot entries |
| [`src/client/Card.tsx`](src/client/Card.tsx) | Turn tail, frame, fold and fallback body |
| [`src/client/ProposeRow.tsx`](src/client/ProposeRow.tsx) | Process row |
| [`src/client/registry.ts`](src/client/registry.ts) | Body registry and body props |
| [`tests/`](tests/) | Placement, frame, fallback, row and registration tests |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Action cards](../action-cards/README.md) — the tool, card state and user actions behind the frame.
- [Personalized page cards](../client-ui-creation-recommendations/README.md) and [recommendation cards](../client-ui-plugin-recommendations/README.md) — the shipped card bodies.
- [Slots](../../client/ui-slots/README.md) — Turn tail and tool row registration.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the Host card service: card actions reach it as Remote calls, and it owns the logged tool, decisions and status notice.

#### KV Cache effect

Rendering cards and process rows does not change any model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A card whose action has no registered body offers only Not now, so its experiment's other actions need that experiment's browser plugin. Not now still works after the experiment's Host plugin is turned off.
- The Turn tail shows one card per Turn, matching the Host rule of one card per turn.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
