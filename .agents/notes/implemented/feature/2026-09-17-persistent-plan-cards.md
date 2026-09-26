# Agent Note: Persistent plan cards and sidebar reading

Status: implemented

English | [中文](2026-09-17-persistent-plan-cards.zh.md)

## Problem

A plan review occupies the composer only until the user answers or dismisses it. A completed Turn also folds its tool calls into the process disclosure. Neither lifetime gives a submitted plan a discoverable place to read while implementation continues.

## Decision

`ui-plan` accumulates each Turn’s `exit_plan_mode` submissions, including native calls and PTC dispatches. Each invocation contributes a card to the completed Turn’s final artifact area. The `conversation.chat.turnTail` list admits file deliveries and plan cards together. Review dismissal, refusal, and approval do not delete the recorded plans.

The review intent may carry the tool-call identity. The question plugin declares an action slot, and the plan plugin contributes an opener there and on the historical card. When an invocation exists, both open the resource identified by its complete Session address and invocation. Subagent addresses retain the direct parent, child, and mode for snapshot reads, pagination, and reload. The resource address selects the document’s Session, while the mounted Sidebar selects where its preview opens; embedded child conversations do not require a child Sidebar store. Sidebar layout retains that address; the resource provider reads the existing Session history, paging backwards when the invocation is older than the opening window. Its temporary follow closes after the opening snapshot.

A review without an invocation opens a temporary address keyed by browser lifetime, Session, and pending request. The sidebar’s existing navigation parameters hold its Markdown without adding another document store or persisting text in layout. Closing and reopening from the pending card supplies the text again; restored tabs without navigation parameters report an expired preview.

The document is read-only. The pending review shows its status, View full plan link, title, two-line plain-text summary, and Request changes / Approve buttons; the complete text opens automatically in the sidebar. A transient Session-scoped store records each automatically opened invocation or unlogged request, so review remounts preserve manual closure. Historical cards never trigger automatic navigation. The cards use the file-delivery treatment with a Markdown icon, plan title, and Open action. Request changes cancels the pending wait and returns the composer for feedback. Approval stays in the pending-question owner; reopening a historical document does not revive a settled review or authorize implementation. Different submissions remain distinct even when they share a heading.

## Alternatives considered

**Keep only the pending review or an expandable tool row.** Both hide the document behind unrelated interaction or process state. The user needs a persistent artifact entry.

**Write a Markdown file or persist the document in sidebar layout.** The tool arguments already own the exact submitted text. Another durable copy would need synchronization and could disagree with the reviewed plan. The [plan-state decision](../simplification/2026-07-22-plan-specific-collaboration-state.md) remains the authority for that ownership.

**Select a single owner for the Turn tail.** Plans and file deliveries can occur in the same Turn. An additive list lets both plugins contribute without either knowing the other’s data or rendering.

## Consequences

Logged plans survive review closure and browser reload without a new Session event or file. Complete plan arguments retain a card even when the tool rejects the call, including calls outside plan mode; the card does not certify approval or execution. Reads of old plans may require several history pages. The provider validates saved addresses and logged arguments, and reports unavailable history explicitly. The recorded Web plan-review scenario covers both entry points, repeated opening, process collapse, approval, and reload; focused tests cover multiple submissions, PTC deduplication, cropped history, and resource failures.
