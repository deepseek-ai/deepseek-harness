---
description: "Browser half of optional action cards: the card frame below completed answers, the body registry that card kind packages fill, and the layer that hides the action-card blocks offering them."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-action-cards

English | [中文](README.zh.md)

## Summary

Users see an optional action card below a completed answer: its title, a brief that folds when long, and the controls of the feature that proposed it. The answer's `action-card` block that offers the card is never shown. A card whose experiment provides no controls in this browser, or whose fields those controls cannot read, offers only Not now. Showing, expanding and folding cards make no model request.

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

The Web composition ([`dsh-web-app`](../../bundle/web-app/README.md)) mounts this package beside its [Host service](../../interaction/action-cards/README.md). This browser contribution has no configuration fields. It adds the Personalized recommendations switch to Settings → General, which writes the Host service's `enabled` field.

### Register a card body

A kind's browser plugin injects `actionCards` and registers its body inside its own `ctx.effect`: `ctx.actionCards.register({ action, locale, Body })` returns the disposer. The frame renders `Body` for cards of that action with the card, its latest recorded decision, the Session id, the frame's title and folded brief as `summary`, the frame's dismiss-only content as `fallback`, the frame's fold component as `Folded`, an `act(verb, payload?)` bound to the card, and a translator `t` for the body's own locale namespace. The body places `summary` in its own layout, renders `fallback` instead when its schema rejects the card's `details`, and owns its header, controls, status and footer. A second body for the same action is a registration error.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One `conversation.chat.turnTail` entry reads the `actionCards` Session projection and shows the card admitted in its Turn after that Turn has ended with a final answer; a Turn that ends without answer text shows no card, and should several cards share a Turn, the lowest card id is shown. The frame sets `data-action-card` to the card id and names its region by the card title. Folding counts a wide grapheme, such as a Chinese character, as two Latin-letter widths and folds after about 260; it never measures layout or alters the full text.

A `conversation.chat.markdown.fence` layer keyed `action-card` renders nothing, so these blocks stay hidden wherever the Chat flow renders Markdown: in answers, reasoning and compaction summaries, including blocks the Host does not admit. The plugin provides the body registry at its top level and registers its dictionaries and slot entries for the same lifetime; [`api-remotes`](../../api/remotes/README.md) mounts the `actionCards` Remote. The General settings row exists while the Host serves the `action-cards` configuration, shows the accepted `enabled` value, and keeps it with an error when a write is refused or fails.

| Source | Contents |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Registry, dictionaries and slot entries |
| [`src/client/SettingsRow.tsx`](src/client/SettingsRow.tsx) | General settings switch |
| [`src/client/Card.tsx`](src/client/Card.tsx) | Turn tail, frame, fold, fallback body and block layer |
| [`src/client/registry.ts`](src/client/registry.ts) | Body registry and body props |
| [`tests/`](tests/) | Placement, frame, fallback, block and registration tests |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Action cards](../../interaction/action-cards/README.md) — the card blocks, card state and user actions behind the frame.
- [Personalized page cards](../ui-creation-recommendations/README.md) and [recommendation cards](../ui-plugin-recommendations/README.md) — the shipped card bodies.
- [Slots](../ui-slots/README.md) — Turn tail and Markdown fence layer registration.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the Host card service: card actions reach it as Remote calls, and it owns the card proposals read from answers, decisions and status notice.

#### KV Cache effect

Rendering cards and hiding their blocks does not change any model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A card whose action has no registered body offers only Not now, so its feature's other actions need that feature's browser plugin. Not now still works after the feature's Host plugin is turned off.
- The Turn tail shows one card per Turn, matching the Host rule of one card per turn.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
