---
description: "Shared Host service of optional action cards: cards read from action-card blocks in answers, card state, user actions and status notices that experiment packages register card kinds into."
kind: "package-reference"
---

# @deepseek-ai/dsh-action-cards

English | [中文](README.zh.md)

## Summary

An experiment can offer one optional action below an answer, such as creating a page, without adding a tool. The model loads the experiment's skill and ends its answer with an `action-card` block that names the action; the [browser half](../client-ui-action-cards/README.md) hides the block, the card appears after the turn ends, and nothing runs until the user acts on it. Each choice is recorded and reported to the model on its next request.

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

The [Personalized recommendations](../personalized-recommendations/README.md) bundle inserts this service and its [browser half](../client-ui-action-cards/README.md). The service has no configuration fields.

### Register a card kind

A kind package injects `actionCards` and calls `ctx.actionCards.register(kind)` from its own plugin; unloading that plugin removes the kind, and actions on its cards are then refused as unavailable, except that Not now still dismisses an unstarted card. Its own skill tells the model when to offer the card and what the block holds. The kind names its action, a zod schema for the card's `details`, the user actions it accepts and the shared checks each needs (`global` Remote access, `writes` refused in a read-only Session), the recorded phases that still offer dismissal, optional status guidance, the decision data fields the status notice reports, an optional `reconcile` that updates the card's recorded decision from state outside the Session before every action, and the handler for every action except `dismiss`. The handler records each new decision with `ctx.actionCards.record()`, which refuses an action no kind registered and the derived `replaced` phase, and returns `accepted`, `settled` with the decision in effect, `refused` or `unconfirmed`.

### Card rules

- A card is a fenced block whose language is `action-card` and whose content is one JSON object with `action`, `title`, `brief` and an object `details`. A block counts when its fence follows at most three spaces, or at most three spaces and a list item marker; a block in a block quote, one indented four or more spaces and one inside another fenced block offer no card. The first such block of a turn that parses becomes the card, named by the id of the assistant message that holds it. Later blocks of that turn, blocks in reasoning, blocks in an interrupted answer, blocks with a blank title or brief, and every block of a subagent Session create no card, and nothing reports this to the model.
- Admission does not check the kind: a card whose action no kind registered, or whose `details` fail the kind schema, still appears, replaces every unstarted earlier card, and refuses every action except Not now as unavailable.
- A newer card of any kind replaces every unstarted earlier card. Replacement is derived from the log and never recorded.
- Events a forked Session inherits create no cards.
- Before every action, including Not now, the kind's `reconcile` updates the card from state outside the Session. Not now is then recorded for an unstarted card and for the phases the kind lists; dismissed and replaced cards accept no further action. Without its registered kind, Not now still dismisses an unstarted card, and every other action is refused as unavailable.
- Concurrent actions on one card share one operation. Actions require the exact live Agent for the card's Session, whose `origin` must not be `subagent`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package default-exports the `actionCards` Remote service and registers no tool. The logged answer is the durable proposal: the `actionCards` Session projection (state version 3) reads the text blocks of each `assistant/message` with [`src/fence.ts`](src/fence.ts), which finds fenced blocks at the top level and in list items by the CommonMark fence rules and matches their language the way the Chat client dispatches fences, and admits the first valid block of the turn. It also records decisions from `plugin:action-cards/decision`, and keeps unreported decisions until a status notice whose `through` covers them enters the log. The header's `origin` marks a subagent Session, whose projection admits nothing. Its Client view `{ proposals, decisions }` is excluded from Session summaries.

The Remote `act(sessionId, cardId, verb, payload?)` checks the owner, the live root and the card; Not now continues without a registered kind, while other verbs need the kind, the verb and Remote access. It then shares one operation per card. The kind's `reconcile` runs first and the live root is checked again; a dismissed or replaced card then settles unchanged, Not now is recorded, a writing verb is refused in a read-only Session, and every other verb goes to the kind handler under the Agent's initiator. `record()` also accepts an action whose kind has unregistered, because Cordis disposes a plugin's effects concurrently and an unloading kind still records the outcome of work it started. An `agent/pre-step` listener adds the status notice after later listeners prepared the step.

| Source | Contents |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, kind registry, Remote action and status notice |
| [`src/projection.ts`](src/projection.ts) | Session projection |
| [`src/fence.ts`](src/fence.ts) | Reading `action-card` blocks from answer text |
| [`src/types.ts`](src/types.ts) | Card id, block language, proposal, decision, view and result types |
| [`tests/`](tests/) | Block reading, projection, action and notice tests |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Action card display](../client-ui-action-cards/README.md) — the browser frame, kind bodies and the hidden block.
- [Personalized pages](../creation-recommendations/README.md) and [Plugin recommendations](../plugin-recommendations/README.md) — the shipped card kinds.
- [Chat](../../client/ui-chat/README.md) — the Markdown fence slot through which the browser half hides the block.
- [Session projection](../../session/session-projection/README.md) — the card state the browser reads.

<a id="model-experience"></a>
## Model Experience

### Card block

#### What the model sees

No tool. A kind's skill, loaded with the existing `skill` tool, tells the model when to offer its card, the fields of `details`, and the invitation sentence that comes before the block; the model then ends its final answer with one `action-card` block. The block stays in the logged answer, so later requests carry it as ordinary answer text. Nothing reports whether a block became a card.

#### Token effect

A card adds no request, tool declaration or tool result. Its block is part of the final answer: the replayed Plugin recommendations block is 237 characters and the replayed Personalized pages block 525, about 59 and 131 tokens at the token meter's four characters per token.

#### KV Cache effect

None. The block is answer text, and nothing is added to or removed from the request prefix.

### Card status notice

#### What the model sees

After a decision is recorded, the next request carries one `action-cards` notice: the preamble below, the guidance sentences of each involved kind, `Continue with the user’s current request.`, and a JSON array of the changed cards with `action`, `title`, `phase` and the data fields their kind reports.

##### Notice preamble

```markdown
Latest status of action cards from user actions and background work. These are status facts, not a request to start or retry work. Use these receipts instead of the earlier proposal when describing progress.
```

#### Token effect

One notice per request that follows new decisions, sized by the changed cards; unchanged cards add nothing, and several decisions of one card collapse to its latest.

#### KV Cache effect

The notice is appended after the request's other new context and never rewrites earlier messages. The notice neither starts a turn nor wakes an idle conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The model learns nothing about a block that creates no card: a malformed block, a second block of the turn or a subagent's block shows nothing, while the answer may already invite the user to the card.
- The Host finds blocks line by line and reads only the literal language `action-card`, while the Chat client hides every `action-card` block it renders. A block in a block quote, one indented four or more spaces in a nested list item, or one whose language is written with an escape or a character reference, is hidden and offers no card; a block inside an HTML block or a `$$` or `\[ … \]` math block offers a card while its text stays visible. The skills ask for one top-level block at the end of the answer.
- Sessions recorded with the removed `propose_action` tool show no card for those calls, and decision records that name a card `callId` are skipped.
- A card that fails its kind schema or names no registered kind still replaces an unstarted earlier card, which then offers no action.
- Cards are offered in the main conversation only. A subagent Session, including a Creator child's, admits no card, because only a live root can act on one.
- Only one card is offered per turn across all kinds. A later card of any kind replaces every unstarted earlier card, so a second kind's card replaces an unstarted card of the first.
- Refusal reasons of user actions are plain strings by design: the service defines `closing`, `not-live-root`, `unknown`, `unavailable`, `access-denied` and `read-only`, each kind adds its own, and a browser body names the reasons it knows and treats others as unavailable.
- Each kind validates `details` on both sides, with its Host schema before each action and with its browser body's own schema, so the two schemas change together.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
