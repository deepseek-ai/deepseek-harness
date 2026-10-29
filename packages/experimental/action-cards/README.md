---
description: "Shared Host service of optional action cards: the propose_action tool, card state, user actions and status notices that experiment packages register card kinds into."
kind: "package-reference"
---

# @deepseek-ai/dsh-action-cards

English | [中文](README.zh.md)

## Summary

An experiment can offer one optional action below an answer, such as creating a page, without adding a tool of its own. The model loads the experiment's skill, then calls `propose_action`; the card appears after the turn ends, and nothing runs until the user acts on it. Each choice is recorded and reported to the model on its next request. The tool costs nothing until a card skill loads in the conversation.

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

The [Personalized recommendations](../personalized-recommendations/README.md) bundle inserts this service and its [browser half](../client-ui-action-cards/README.md). The service has one configuration field:

| Field | Default | Meaning |
|---|---|---|
| `queuedMessageLimit` | `2` | Queued next-turn user messages at or above which `propose_action` refuses the call, so no card is offered. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-action-cards) is the exhaustive source for accepted fields.

### Register a card kind

A kind package injects `actionCards` and calls `ctx.actionCards.register(kind)` from its own plugin; unloading that plugin removes the kind, and actions on its cards are then refused as unavailable, except that Not now still dismisses an unstarted card. The kind names its action, the skill that proposes it, the closing invitation guidance that an accepted call's result gives the model, a zod schema for the card's `details`, the user actions it accepts and the shared checks each needs (`global` Remote access, `writes` refused in a read-only Session), the recorded phases that still offer dismissal, optional status guidance, the decision data fields the status notice reports, an optional `reconcile` that updates the card's recorded decision from state outside the Session before every action, and the handler for every action except `dismiss`. The handler records each new decision with `ctx.actionCards.record()`, which refuses an action no kind registered and the derived `replaced` phase, and returns `accepted`, `settled` with the decision in effect, `refused` or `unconfirmed`.

### Card rules

- The first accepted `propose_action` call of a turn becomes the card. The tool refuses a second call in the same turn, an unregistered action, a call whose kind skill was not loaded in the current turn, a blank title or brief, details that fail the kind schema, calls dispatched from code, calls from a subagent, and any call while `queuedMessageLimit` or more user messages wait for later turns.
- A newer card of any kind replaces every unstarted earlier card. Replacement is derived from the log and never recorded.
- Events a forked Session inherits create no cards.
- Before every action, including Not now, the kind's `reconcile` updates the card from state outside the Session. Not now is then recorded for an unstarted card and for the phases the kind lists; dismissed and replaced cards accept no further action. Without its registered kind, Not now still dismisses an unstarted card, and every other action is refused as unavailable.
- Concurrent actions on one card share one operation. Actions require the card's live root Agent.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package default-exports the `actionCards` Remote service. It registers `propose_action` once, globally, with a `when` condition: a live root Agent becomes eligible when its own direct `skill` call loads the skill of a registered kind, while loads by subagents or from code are ignored. The flag lives in memory until the Agent is disposed. The call's `execute` checks the live root, the queued messages the projection counts against `queuedMessageLimit` and the current turn's skill loads through the turn boundary, and keeps an in-memory mark of the turn's accepted call; the logged `tool/call` and its successful `tool/result` are the durable proposal.

The `actionCards` Session projection (state version 2) pairs each `propose_action` call with its successful result, records decisions from `plugin:action-cards/decision`, counts queued next-turn messages from inbox splices for the tool's limit, and keeps unreported decisions until a status notice whose `through` covers them enters the log. Its Client view `{ proposals, decisions }` is excluded from Session summaries.

The Remote `act(sessionId, callId, verb, payload?)` checks the owner, the live root and the card; Not now continues without a registered kind, while other verbs need the kind, the verb and Remote access. It then shares one operation per card. The kind's `reconcile` runs first and the live root is checked again; a dismissed or replaced card then settles unchanged, Not now is recorded, a writing verb is refused in a read-only Session, and every other verb goes to the kind handler under the Agent's initiator. `record()` also accepts an action whose kind has unregistered, because Cordis disposes a plugin's effects concurrently and an unloading kind still records the outcome of work it started. An `agent/pre-step` listener adds the status notice after later listeners prepared the step.

| Source | Contents |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, tool, kind registry, Remote action and status notice |
| [`src/projection.ts`](src/projection.ts) | Session projection |
| [`src/types.ts`](src/types.ts) | Proposal, decision, view and result types |
| [`tests/`](tests/) | Activation, validation, projection, action and notice tests |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Action card display](../client-ui-action-cards/README.md) — the browser frame, kind bodies and the process row.
- [Personalized pages](../creation-recommendations/README.md) and [Plugin recommendations](../plugin-recommendations/README.md) — the shipped card kinds.
- [Tools](../../core/tools/README.md) — conditional registration and step admission.
- [Session projection](../../session/session-projection/README.md) — the card state the browser reads.

<a id="model-experience"></a>
## Model Experience

### Card tool

#### What the model sees

The [`propose_action` declaration](../../../docs/tool-catalog.md#deepseek-aidsh-action-cards) appears only to a live root Agent whose own direct call loaded the skill of a registered kind in this Session, from the next step on, for that Agent's lifetime. Subagents never see it, and neither do PTC presets, whose skill loads are dispatched from code, so they show no cards. A kind's skill names the action and the fields of `details`. An accepted call returns `Card shown below your answer. Do not restate it. <invitation>`, where `<invitation>` is the kind's one- or two-sentence guidance on inviting the user to the card in the user's language, so the model writes an invitation only after a card exists. A refused call carries no invitation and returns its reason, for example `Load skill <skill> first, then call propose_action.`, `One card per turn; the earlier card stands.`, `The user has queued more messages; show no card and answer briefly.`, `Cards are offered in the main conversation only.`, `Unknown action "<action>". Registered actions: <actions>.`, where the list reads `none` once the last kind unregistered, or the failing `details` fields.

#### Token effect

Before a card skill loads, the tool adds no tokens. Afterwards each request of that Agent declares it: 574 characters of JSON, about 144 tokens at the token meter's four characters per token. A card costs one extra model round trip, the call before the final answer, and its tool result: a 49-character prefix plus the kind's invitation. The Personalized pages result is 305 characters, about 77 tokens at the same rate.

#### KV Cache effect

Activation is append-only on routes that declare tool updates, such as DeepSeek-V4.1-Flash: when the condition turns true the loop logs a header change and a `tool-addition` developer message, and those routes receive the definition as a deferred declaration referenced at that position, so the cached prefix is kept. A route without tool updates receives the tool in its declaration list from that step on, which changes the request prefix once. Disposing the Agent drops the activation; a reopened Session declares the tool again only after a card skill loads again, logging a removal and a later addition.

### Card status notice

#### What the model sees

After a decision is recorded, the next request carries one `action-cards` notice: the preamble below, the guidance sentences of each involved kind, `Continue with the user’s current request.`, and a JSON array of the changed cards with `action`, `callId`, `title`, `phase` and the data fields their kind reports.

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

- Activation is per live Agent and kept in memory, so after a Session reopens the tool appears again only after a card skill loads again.
- PTC presets show no cards: skill loads and calls dispatched from code never activate or reach the tool, because the log records them as program dispatches rather than tool calls.
- Cards are offered in the main conversation only. A subagent's skill load, including a Creator child's, activates nothing and its calls are refused, because only a live root can act on a card.
- Only one card is offered per turn across all kinds. A later card of any kind replaces every unstarted earlier card, so a second kind's card replaces an unstarted card of the first.
- Refusal reasons of user actions are plain strings by design: the service defines `closing`, `not-live-root`, `unknown`, `unavailable`, `access-denied` and `read-only`, each kind adds its own, and a browser body names the reasons it knows and treats others as unavailable.
- Each kind validates `details` on both sides, with its Host schema when the model proposes and before each action, and with its browser body's own schema, so the two schemas change together.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
