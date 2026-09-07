# Agent Note: Remove the steering interjection caption

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-10-web-remove-steering-interjection-caption.zh.md)

## Problem

The [context-source and steer marks decision](../feature/2026-08-04-web-context-source-and-steer-marks.md) captioned every durable and pending steering bubble with `插话` / `Interjection` so the transcript could say which right-aligned bubble interrupted a running turn. The caption repeats what the flow already shows: a steering bubble sits mid-turn, between the assistant content it interrupted, while a turn-opening prompt sits at a turn boundary. A permanent line of tertiary text above every steer bubble buys no reading a position-aware reader does not already have, and it is the only chrome any user-style bubble carries, so it also breaks the otherwise uniform right-aligned rhythm.

## Decision

Steering renders exactly as a user bubble. `UserStyleBubble` has no steering flag, the `message.steering` locale key and the `.steeringMark` style are deleted, and `PendingSteeringBubble` and `UserMessageNodeView` pass only content and actions. A mid-turn steer is recognizable by its position inside the running turn's flow, and by nothing else.

The runtime distinction is untouched. `SteeringMessageNode` projection from durable `agent/inbox/spliced` history, the `data-pending-steering` attribute, and the pending-to-durable hand-off all remain: the pending lifecycle needs the node identity regardless of presentation, and tests still locate pending bubbles through the attribute.

This partially supersedes the steering clause of the [context-source and steer marks decision](../feature/2026-08-04-web-context-source-and-steer-marks.md); its context-source and recall naming stays current. The caption has flipped before: the [archived no-steer decision](../../archived/simplification/2026-07-31-web-ui-no-steer-entry-or-interjection-chrome.md) removed it while the composer could not steer, and the 2026-08-04 decision reintroduced it after the composer gained a Steer gesture. This removal does not revisit the gesture — steering entry, the Queue dock's steer-send action, and the pending lifecycle keep their owners — it judges only that the transcript need not name the result.

## Alternatives considered

**Keep the caption.** It is the status quo and cheap to keep, but it decorates every steer bubble forever to encode a fact the bubble's position already states. Chrome that carries no information a reader lacks is removed, not maintained.

**Remove the `SteeringMessageNode` distinction too.** The node kind is derived from durable inbox history and drives the pending-to-durable hand-off; it is a replay fact, not presentation. Folding it into `UserMessageNode` would change projection behavior for no UI gain.

**Distinguish steering with quieter chrome (tint, indent, hover-only label).** Any replacement re-raises the same question with a weaker vocabulary. The distinction the transcript needs is positional and already visible; adding subtler decoration keeps the cost and loses the one virtue the text caption had, being explicit.

## Testing

- `packages/client/ui-conversation` jsdom coverage pins the plain bubble: the pending hand-off test locates pending bubbles by `data-pending-steering` and asserts the single-bubble hand-off without any caption, and the MessageItem steering arm asserts copy-without-branch on an uncaptioned bubble.
- The keyless assembled-Web goldens (`steering/mid-steer`, `steering/settled`, `plan-review/approved`) replay the unchanged session fixtures with no caption text.

## Consequences

- A replayed transcript no longer names steering: a reader infers a mid-turn interjection from its position inside the turn. That inference is weaker than an explicit label for a reader skimming turn boundaries; the decision accepts this.
- A pending steer bubble is visually identical to an ordinary sent bubble until admission; only its missing clock time differs.
- Reintroducing steering chrome of any form requires a new product decision superseding this note.
