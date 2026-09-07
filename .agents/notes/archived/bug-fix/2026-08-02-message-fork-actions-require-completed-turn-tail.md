# Agent Note: Message fork actions require a completed turn tail

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-02-message-fork-actions-require-completed-turn-tail.zh.md)

## Problem

The Web conversation attached branch to the last assistant node with nonempty text in each turn. A later tool result, interrupted reasoning node, or terminal error did not take ownership because those rows have no content-text IconActions. The branch icon could therefore appear beneath an assistant response while more rows from the same turn remained below it. The Host correctly expanded that message anchor through the containing `turn/end`, but the placement made the action look like a message-level cut and the child visibly inherited the same-turn suffix.

## Decision

`ConversationSnapshot.turnEnds` retains the completed turn boundaries present in the raw event window. The conversation view walks transcript nodes through each boundary and enables branch only when the boundary's last node is a user message, a durable steering message, or a content-bearing assistant message. Open turns have no eligible message, and a later tool result, reasoning-only interruption, turn error, or other transcript node leaves branch unavailable on earlier messages. The unavailable control stays visible, focusable, and hoverable; `aria-disabled`, a tooltip, and `aria-describedby` explain the completed-tail requirement without sending a Host request. Copy and clock remain available under their existing message chrome, and the Host's completed-turn fork semantics remain unchanged.

The message-bubble half of this eligibility is superseded by the [user-bubble branch removal](../simplification/2026-08-06-user-bubbles-drop-the-branch-action.md): user and steering bubbles no longer render the control at all, so only content-assistant tails may fork; the assistant-side gate and its visible-but-unavailable presentation stand.

This narrows the message eligibility established by the earlier [Web session fork action decision](../feature/2026-07-27-web-session-fork-actions.md). Session-row forking still selects the latest completed turn, and eligible message actions still pass their event seq through the shared client runtime operation.

## Alternatives considered

**Cut the event log at the clicked assistant message.** Rejected because an assistant message can sit inside an open step and can contain tool calls whose results occur later. A raw prefix at that seq is not a balanced turn and may not be a valid provider transcript.

**Infer completion from `running` or the next user message.** Rejected because retry and steering turns need not align with the next visible user bubble, and a paged window may omit that later bubble. The durable `turn/end` event is the authoritative completion fact.

**Hide branch from every interrupted turn.** Rejected because an aborted turn is durably closed and its final interrupted text can be the true transcript tail. Eligibility depends on the completed boundary and node order, not the outcome kind.

**Hide ineligible message controls.** Rejected because a disappearing control does not explain the boundary requirement and shifts otherwise stable message chrome. A focusable unavailable control preserves the affordance while preventing the request.

## Consequences

An enabled branch icon denotes the same completed-turn boundary that the Host will copy. In the reported response → tool → interrupted Think shape, the response keeps copy, clock, and a disabled branch control that explains why it cannot act. This change deliberately does not provide same-turn transcript editing or a retry-before-turn operation; the Session-row action remains available when a reader wants to copy the latest completed turn in full. Runtime tests pin boundary projection and reference stability, while conversation tests cover assistant, user-only, and durable-steering tails plus unavailable controls caused by later tool and interrupted reasoning rows.
