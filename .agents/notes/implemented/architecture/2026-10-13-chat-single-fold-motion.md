# Agent Note: One fold motion for collapsing on the next message

Status: implemented

English | [中文](2026-10-13-chat-single-fold-motion.zh.md)

## Problem

When "When to Collapse Work Details" is "On next message", the previous exchange's process rows close when the next human input arrives. The scroll layer had two fold paths and chose one by `ownInput` ([use-chat-scroll.ts](../../../../packages/client/ui-chat/src/client/chat/use-chat-scroll.ts)):

- **Input fold path:** when the fold starts, it measures the closing rows, computes the final landing and the required bottom room, and moves the rows and the scrollport on one frame clock to a single landing.
- **Generic path:** scrollTop stays put, the closing height is reserved as bottom room in one block, and following scrolls once more after the fold ends. This holds only when the fold happens below the reader. When the folding region is above the reader, the content the reader is looking at moves up as a whole and the viewport shows only the room.

`ownInput` holds for three signals only: a local echo in the transcript (`submissionId`), a steer echo (`steeringId`), or a user message as the last list row (`lastIsUser`). In the commit where the Host records the opening input, the Turn's process control is ordered after that input, so `lastIsUser` does not hold. Every human input without a transcript echo on this page therefore took the generic path:

| Source | Echo on this page | Reader at the bottom | Reader in the middle of the body |
|---|---|---|---|
| Idle send from the main composer | Yes, in the transcript | Correct | Correct |
| Main-Session queued message delivered after the previous Turn | Yes, but in the queue, not consulted | Whole viewport blank | Whole viewport blank |
| Send from another tab | No | Whole viewport blank | Whole viewport blank |
| Send from a subagent child's composer in the right Sidebar | No (the composer skipped `beginSubmission`) | Whole viewport blank | Whole viewport blank |
| Human send after parent messages woke several child Turns | No | Whole viewport blank (about 6000 px of room) | — |

Notice-woken Turns no longer fold anything ([group-tree positions and exchanges](2026-10-11-chat-group-tree-exchanges.md)); the table above covers the human input that still folded through the generic path. The data comes from [fold-blank-matrix.e2e.ts](../../../../apps/web/tests/fold-blank-matrix.e2e.ts).

Subagent children showed no local echo because, when echoes were introduced, `subagents.prompt` carried no request id, so an echo could not be matched with the message the child recorded. Subagent control later moved to Remote, and the Host now records `SubagentPromptRequest.requestId` as the child message's `source.rpcId`; the client's `Session.prompt` still minted a separate id.

## Decision

"On next message" keeps a single fold motion: [flow-motion.ts](../../../../packages/client/ui-chat/src/client/chat/flow-motion.ts) hands every batch of closing rows to the `InputFoldDriver` that the viewport supplies, and [use-chat-viewport.ts](../../../../packages/client/ui-chat/src/client/chat/use-chat-viewport.ts) chooses one of two landings when the batch begins.

### Batches

- Rows that start closing in one commit, together with rows that start revealing in it, form one batch. The driver's four steps are:
  - `begin`: measure the boxes and choose the landing;
  - `prepare`: grow the room before box writes so the browser does not clamp an intermediate frame;
  - `frame`: write box heights and scrollTop together;
  - `finish`: install the final room.

  Content added during the batch updates the remaining movement by starting a new segment.
- A row that starts closing or revealing while a batch runs keeps its current size, without a transition of its own, until that batch settles; the next flush drives it in a new batch, or starts a held revealing row's own transition when nothing closes. Rows therefore never change outside a batch while following continues, which would follow the bottom room without the growth that should have consumed it. A batch takes over every member at its current size: a closing row shrinks from the height it has now, and a revealing row grows from the height its own transition already reached, so only the remaining growth enters the landing; a closing row with no size left finishes without animation, and so does a row whose ancestor finished closing, because `hidden="until-found"` keeps that row's own size while removing it from the flow.
- A batch with only revealing rows needs no room and keeps CSS transitions. When the viewport has no reading policy attached, closing rows also keep CSS transitions, and held rows finish immediately; under reduced motion closing rows finish immediately.
- Closing rows commit their hidden state first, the driver then installs the final geometry, and only then are fold-idle listeners notified (for example, clearing room after a display-mode change).
- The generic path is removed: the `reserve` callback, the `pendingReserve` and `pendingGrowth` reservation arithmetic, `reserveBelow`, and the post-fold `followAfterFold`. `reclaimBelow` (returning room after new content or reader scrolling) and `resetBelow` (clearing room after a display-mode change) remain.

### Landings

Let `start` be the scrollTop when the batch begins, `above` the height of closing rows above the viewport top minus revealing rows there, `base = max(0, start − above)`, and `bottom` the floor after the fold.

| Landing | When | Target scrollTop | After the batch |
|---|---|---|---|
| **Tail** | This client's own input, or the reader was following the tail when the batch began and had no reading movement awaiting sampling | `max(base, bottom)` | Commit follow ownership |
| **Reader content still** | Otherwise | `base` | Keep the reader's reading state and acknowledge the new position |

- Both landings install only the exact deficit as room: `max(0, target + viewport height − folded height)`. The tail landing reads the committed layout when it finishes: it lands at the larger of the target and the real floor, and keeps only the room that target needs.
- Content never slides back down: content already above the viewport top does not return. When the retained body and the new message cannot fill the viewport, the deficit remains as room until new content fills it.
- Own input during a running batch starts a new segment from the current position toward the tail; it takes over even when a reading gesture cancelled the automatic target. A tail request counts only while a batch runs or is scheduled; rows still closing on CSS transitions after a batch leave own input to ordinary following.
- A reading gesture cancels a tail landing's automatic target and keeps the reader's position. During a reader-content-still landing, the reader's own scrolling between frames moves the position the batch keeps still.
- For the reader-content-still landing, the driver takes the first visible top-level row outside the batch as a reference, found by binary search over the ordered top-level rows. Neighbouring spacing changes instantly when the batch begins and when closing rows commit their hidden state; the driver measures the reference's displacement at those two points and offsets scrollTop by it.
- When a tail landing scrolls forward past closing rows that start below the viewport top, those rows stay opaque, scroll with the content, and clip while they shrink; nested closing rows keep their size until the batch ends. Other closing rows fade in place. A newer tail request that takes over a running batch adds the closing rows still below the viewport top; a row that has already faded becomes opaque again for its remaining height. Scrolling forward therefore never crosses space that is already transparent but not yet closed.

### Own input

| Source | Determination | Landing |
|---|---|---|
| Idle send from the main composer | Transcript echo | Tail |
| Idle send from a subagent child's composer | The child also registers a local echo; `subagents.prompt` uses the echo's `requestId` | Tail |
| Queued while running, delivered after the previous Turn | Not own input | Tail when following, otherwise reader content still |
| Send from another tab | Not own input | Same as above |
| Parent Agent messages a child | The notice opens no exchange and folds nothing | — |

"On completion" is outside the motion scope; its folds apply immediately and are unaffected.

## Testing

[fold-blank-matrix.e2e.ts](../../../../apps/web/tests/fold-blank-matrix.e2e.ts) covers 19 main-Session cases and 8 right-Sidebar child cases across reader position (bottom, middle of the body, top of the body, inside the steps, previous Turn), input source (composer, Turn failing before its message is recorded, another tab, queued delivery, steer, parent message, several Turns folding at once), body length, and Standard and "On completion" controls. The layout gap is the tallest band between the scrollport top and the composer that no visible row's box covers: at most 120 px once settled, and over that for at most one animation frame. It counts boxes, so a closing row that has faded but not finished shrinking still covers its space. Tail cases assert the floor landing; reader-content-still cases assert that the reader's anchor row moves at most 2 px on screen. Short-body cases assert only that no room remains after the reply arrives.

## Alternatives considered

**Keep the generic path and fix only own-input detection.** The two paths keep diverging geometry rules; for input that is not own input, a reader in the middle is either pulled to the bottom or still sees a blank.

**Compensate the generic path by reader position but implement it separately from the input path.** The compensation and room geometry would exist twice and could diverge again.

**Detect own input from the exchange-opening human node and keep children without echoes.** Input from another tab would count as own input and pull a reader in the middle to the bottom; child sends still would not show the sender's message immediately.

**Let content slide back to fill the deficit a short body leaves.** Content would move up and then down within one animation.

## Consequences

- Benefit: the source of whole-viewport blanks (the generic path) no longer exists; the landing depends only on whether the input is own input and whether the reader was following, not on which page sent the message or when it was delivered. Child sends show the sender's message immediately.
- Cost: with a short body, content never sliding back still leaves the deficit until new content fills it.
- When focus is inside a closing row, focus protection keeps that row open. If it is a height-capped process group, its body shrinks to the cap immediately. That shrink happens before the batch begins, so the reader-content-still landing cannot measure it and the reader's content moves once.
