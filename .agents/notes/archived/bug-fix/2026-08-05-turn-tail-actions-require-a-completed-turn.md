# Agent Note: Turn-tail IconActions require a completed turn

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-05-turn-tail-actions-require-a-completed-turn.zh.md)

## Problem

Assistant IconActions were derived from the finalized transcript alone: the last content-text assistant of each turn owned the row. That quantity is stable only after the turn closes. While a turn is still producing steps, the narration a model writes before a tool call *is* the last content assistant so far, so it took the row for as long as the tool ran and then lost it to the next step's text. Readers saw copy, branch, and a clock appear under an intermediate sentence, shift the flow by one 28px row, and disappear. The row was also incoherent in that state: its branch control was already disabled through `turnEnds`, and its `Ran for` label was already withheld through `turnTimings`, so only copy worked.

The [archived message-chrome decision](../../archived/feature/2026-07-29-web-message-icon-actions-and-clock.md) always claimed mid-turn narration stays chrome-free; the derivation never carried a completion signal to make that true.

## Decision

`assistantActionsSeqs` takes `ConversationSnapshot.turnEnds` and grants the row only within a turn that has a `turn/end` in the window. Ownership inside a completed turn is unchanged: its last content-text assistant. A turn still producing steps grants nothing, so its narration never mounts the row, and the seat appears once, under the settled answer, when the turn closes.

This is the same completion fact the branch control and the run-time label already use, so the three parts of one row now agree. Turn completion is read from the durable `turn/end` event rather than inferred from `running`, the streaming partial, or in-flight tool calls, matching the [completed-turn-tail decision](2026-08-02-message-fork-actions-require-completed-turn-tail.md). Every reason kind closes a turn, so an aborted turn's frozen tail keeps its footer, and a crash-orphaned turn receives its `turn/end` from log repair on load.

`hasContentText` moves to `chat-flow.ts` and `AssistantMarkdown` imports it, so the ownership gate and the mount gate cannot drift apart.

## Alternatives considered

**Withhold by naming the open turn from `running` plus the streaming partial or the first in-flight tool call.** This shipped briefly in the original change and was then dropped. It infers completion instead of reading it, needs a special case so a turn accepted before its first step does not strip the previous answer's seat, and is the inference the completed-turn-tail decision rejected for the branch control. `turnEnds` answers the same question per turn with no inference and no special case.

**Leave the row mounted mid-turn and disable its controls.** Rejected: mid-turn narration is not a degraded answer, it is not the answer. Copy would still write an intermediate sentence, and the row would still move to the real tail at turn end.

**Keep the row under every finalized content node permanently.** Rejected again here for the reason the original decision gave: repeating copy, branch, and a clock under every step clutters the flow. It also does not solve the reported problem, since the branch control is only meaningful on the tail.

## Consequences

A running turn carries no message footer below the user bubble that triggered it, while every earlier completed turn keeps its own; the seat appears once when `turn/end` lands, which adds one 28px row under the settled answer at that moment. A turn whose `turn/end` is outside the loaded window grants nothing, which cannot arise from paging because a turn's end follows its own nodes. `apps/web/tests/turn-tail-actions.e2e.ts` pins both states through the assembled application: a `hang` sidecar on the second model call parks a turn whose first step narrated before calling bash, and the two goldens hold the parked flow and the flow after stopping. Package tests cover the derivation directly and the running-turn render.
