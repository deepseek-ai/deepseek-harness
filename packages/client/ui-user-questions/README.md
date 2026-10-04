---
description: "Web ask_user_question feature for the dsh web client: the attached question card, timed wait, drafts, late replies, and the plan-review approval card."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-user-questions

English | [中文](README.zh.md)

## Summary

The Web client shows an agent's question beside the chat input. Users choose options, enter text, skip questions, and submit one answer batch. A timed card counts down; focus pauses it, editing or `Take time` holds it, and expiry lets the agent continue while the question stays answerable. Closing a card linked to a tool call hides it; its tool row reopens it and later shows recorded answers. The Host preserves the question across restart, while this browser preserves unfinished input across reload.

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

When the agent asks a question, the attached card temporarily occupies the composer seat: answer each question, navigate with the pager, or skip it. A first choice marked “Recommended” starts selected, but remains an unsubmitted draft and does not pause a timed countdown. Clicking a single-select choice advances immediately. Enter on a focused option attempts to submit the batch without selecting that option; missing answers return to the first incomplete question. Enter in a text answer continues the flow, while Shift+Enter breaks a line instead (during IME composition Enter only confirms the input candidate without advancing).

### Answering

A multi-select draft keeps its selected labels while the user opens or edits the custom answer, so its submitted item may carry both `selected` and `custom`; a single-select custom answer remains exclusive. Question detail reuses the assistant-output `MarkdownText` primitive, including its GFM rendering and untrusted-content policy. The capped card keeps its title, navigation, and submission actions fixed while long detail and choices share an internal scroll region. "Skip" retains other drafts and emits the existing blank `{ selected: [] }` result for that item. Close is not an answer: a question the Host named by tool call only leaves the composer seat, and its `ask_user_question` tool call row brings the panel back; a request that carries no tool call has no row to return from, so closing it rejects the whole wait as `ASK_CANCELLED`.

### Reading a settled question back

Each late reply is shown once, including when it opens a new Turn. Replies follow normal Chat process grouping and whole-Turn folding. Expand the containing Turn and work group to read a reply that has been folded away.

A question that already settled opens as a read-only card: the same pager over the recorded answers, marked `Answered`. Every option and text field is disabled, Skip and the submit action are gone, a question the user skipped says so in place of its empty answer, and a free-text field appears only where the recorded answer used one. Closing it removes the card, and the tool call row builds another from the same record.

### The plan-review card

A `plan-review` intent — set by `dsh-plan-mode` on the `exit_plan_mode` review — renders a compact approval card: a `Plan review` strip with a `View full plan` link, the plan title and a two-line plain-text summary, and `Request changes` / `Approve` actions. The strip uses the shared warning dot and changes it to the ongoing loader while either action settles. The complete plan opens in the sidebar through the link or its permanent Chat card. Approve answers with the asker's approval label; `Request changes` rejects the wait as `ASK_CANCELLED`, returning the composer for the user's feedback without submitting an approval. The card has no separate refusal button.

### Failure and recovery

An answer field autofocuses only when its answer channel is ready and no countdown exists. Manual focus and blur during the claim handshake are retained: the countdown starts paused only if the answer surface still has focus when the remaining duration arrives.

Returning a local answer does not release its foreground claim: the Host closes that stream after accepting the waterfall outcome. The plugin owns the claim through this delivery interval. Explicit delegation releases it before calling the next answerer, and plugin disposal cancels any remaining claims.

The card has two sources. A live Host request creates it and carries the answer back. For a timed request, the Client first opens the question-owned `attachWait` stream and derives a local deadline from its remaining-duration frame. The card remains live while that first frame is pending. The claim lasts until the request settles or the Client disconnects, including while the panel is hidden. The card owns the countdown; at zero it rejects with `ASK_TIMED_OUT` and stays available. Once the projection lists the call as continued, answers use the `answer` Remote method. Card removal follows the projection, and plugin teardown releases its requests and claims.

A submission through the pending request is sent, not confirmed: when another browser settled the same request first, the gateway drops the late outcome silently. The card therefore keeps its draft until the projection closes it, and if the call turns continued while a submission is in flight, the controls re-arm with a hint so the same draft goes through the Remote path. An accepted Remote answer steers the agent at its nearest step. While its steer waits in the durable Inbox, the editable card closes and the question row shows the submitted answers read-only, including after a browser reconnect. Multiple pending steers are admitted together at that boundary; an active tool wait must finish before the agent can read them. Discarding a pending steer leaves the question answerable, and the user can reopen its row to submit again. A second answer while the first remains pending reports `REPLY_QUEUED`. Pristine focus freezes this browser's remaining countdown and blur resumes that remainder. The first answer mutation changes the local wait to indefinite, and `Take time` does the same explicitly. Those choices persist with this browser's draft across Session navigation and, for tool-call-keyed requests, reload. Another browser has its own countdown and can still settle the shared request; the Host projection remains the authority for whether the question is open or continued.

Each Session and pending request has an independent draft in browser storage. A tool-call-keyed request restores unfinished input after Session navigation, page reload, or browser restart; progress that no longer matches the question batch is ignored. An unnamed legacy request has a unique card key and cannot be restored after reload. A hidden panel keeps its draft for the next opening; a mounted closed card clears its own draft, and the next mounted card prunes drafts no live card owns. Drafts do not synchronize to another browser or device; the Host-projected question does.

A browser that reconnects while the tool call is open receives the pending request again and can still complete it with the remaining time. A Session reopened after the agent or process ended shows the card as continued; submitting resumes the Session's root agent and enters the answer as a new user turn.

Settled question replies remain compact in chat history. A caret marks the bubble as a disclosure; clicking it reopens the read-only question and answer details, and never reopens the settled tool call for a second submission. Its copy action writes each question with the answer the user gave, the same text whether the bubble is open or closed.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is one ownership rule: rendering a question is a host UI capability, having the tool is an agent capability, so the `tool-ask-user` row belongs to the presets that want it (and to the TUI composition, which has no presets).

### Reopening a panel

This package fills `userQuestionPanels`, the optional capability `dsh-client-ui-tool` declares for its `ask_user_question` row. `reveal(sessionId, callId)` republishes that call's card as the last equal-precedence pending interaction, so the composer seat shows it again, and returns `false` when this Client holds no card for the call — a legacy unkeyed request, another browser's question, or a card the projection already closed. Whether a question still takes an answer comes from the `userQuestions` Session projection, which the row reads directly, so the capability carries no state of its own.

`review(sessionId, callId, record)` builds a card from the questions and answers the row parsed out of its own transcript, because the projection lists only answerable calls. That card has no answer channel and no countdown, the projection sweep leaves it alone, and closing it removes it rather than parking it in the registry. A call that still holds a live card shows the live one, so a stale copy never replaces a standing request; for the same reason a review card renders the record itself and takes only the page position from a draft its live card left behind.

### Intent surface election

The card accepts one question declaring the intent, carrying the plan as `detail`, and offering the named approve label, with at most one alternative and no multi-select. Its secondary action returns to the composer for change requests. Larger choices and multi-select questions remain in the generic flow. A plan review exposes `conversation.plan-review.actions` with its request key, full text, and optional invocation identity; the plan plugin opens logged plans from history and unlogged reviews as temporary sidebar previews, and opening a document does not answer or dismiss the review.

### Copy and locale

Composer chrome copy (pager, buttons, placeholders, validation feedback) is bilingual: the plugin registers zh/en dictionaries under the `question` namespace of `dsh-client-locale` and hands the entry its bound translator plus the locale snapshot source through the inject face, so a locale switch re-renders a mounted composer. Question and option text arrives from the model and renders verbatim; carrier failure messages also display untranslated.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the composer host, the tool seam, and the plan-mode consumer.

- [ui-conversation](../ui-conversation/README.md) — the chat surface owning the `conversation.composer` slot.
- [ui-tool](../ui-tool/README.md) — the tool call transcript whose `ask_user_question` row reopens a hidden panel.
- [tool-ask-user](../../interaction/tool-ask-user/README.md) — the model-facing tool whose schema and answers this UI renders.
- [ui-plan](../ui-plan/README.md) — the plan-mode surface that sets the `plan-review` intent.
- [user-questions](../../interaction/user-questions/README.md) — the Host-side question seam and its answerer waterfall.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-ask-user`, whose model-visible schema and answer rendering this package presents in the Web client.

#### KV Cache effect

No direct invalidation; `dsh-tool-ask-user` owns the model-visible tool call and result.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define question-card ownership and cross-client behavior; they are current package constraints.

- **Unsubmitted drafts are local to one browser** — Session navigation, page reload, and browser restart preserve them, but another browser or device reconstructs only the Host-stored question.
- **One request owns the question card at a time** — later pending requests remain in the session snapshot and become visible after the earlier request resolves.
- **Questions appear in the active Session composer** — durable pending questions do not add a separate sidebar inbox; reopen the owning Session to answer one.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

The Host Session projection is authoritative for durable timed questions. Browser storage only preserves unfinished input and never creates or keeps a question open.
