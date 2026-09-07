# Agent Note: Plan review as a decision, not a question

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-30-plan-review-presentation-intent.zh.md)

## Problem

`exit_plan_mode` presents a finished plan for review through `ctx.userQuestions.ask()`, the same seam `ask_user_question` uses. On the Web GUI that made a plan review render as the generic question flow of [the ask-question Web presentation](2026-07-29-ask-question-web-presentation.md): a `1 / 1` pager, the plan as a question's supporting detail, the two verdicts as numbered radio rows with descriptions, an "Other — enter a custom answer" row, and `Skip this question` / `Submit` in the footer.

Every one of those affordances is wrong for the surface. Reviewing a plan is one decision over one document, and the quiz chrome told the user they were being examined rather than asked to approve work — reported as "让人很困惑以为在做题". The paging controls page a set of one. Skipping is not an outcome the tool accepts (it folds into keep-planning). Worst, the surface gave no hint that this was the plan gate at all, while the adjacent waiting-approval takeover already had exactly the right shape for a decision: a tinted strip naming what is being decided, the subject as the body, and a right-aligned action row.

## Decision

A question may declare a **presentation intent**, and the Web composer renders a declared intent as its own surface. `AskUserQuestionItem` gains `intent?: AskUserQuestionIntent`, a tagged union whose one member is `{ kind: 'plan-review', approve: string }`; `plan-mode` sets it on the review question, naming `Approve` as the label that approves.

An intent changes presentation only. The answer protocol is untouched: a UI honouring the intent answers with the same option labels a generic UI would send, so `exit_plan_mode` reads the same answer fields regardless of which surface collected them, and a UI that does not know a tag renders the generic flow with nothing lost but the layout.

`approve` names the affirmative option instead of relying on option order, so no UI infers a verdict from a position. Two assertions an intent makes are beyond the types, and `UserQuestionService.ask()` rejects both as `BAD_INTENT` at the asker: an `approve` naming none of that question's own options — before any UI can answer a choice never offered — and an intent on a question with no `detail`, the thing it declares itself a review of, which would ask the user to approve something invisible. On the wire the intent is a discriminated union, so an unrecognised tag is a rejected frame rather than a silently generic render.

`ui-user-questions` renders the intent as `PlanReviewPanel`, in the waiting-approval card language: the amber strip carries `Plan review`, the plan is the scrolling markdown body, and the decision row holds three actions — `Chat about it`, `Refuse`, `Approve`. The question text becomes the card's accessible name rather than a headline, because the buttons already say what the decision is. Approve and Refuse answer with the asker's own option labels and keep the asker's descriptions as tooltips; `Chat about it` cancels the request, which returns the composer so the user can simply say what they want. All copy is bilingual under the existing `question` namespace.

Routing lives inside the single composer entry (`QuestionComposer` chooses the presentation) rather than in a second chain registration, and `planReviewOf` claims a request only when the card can send every answer that request allows: one question declaring the intent, the plan as its `detail`, the named approve label offered, and a binary single choice — at most one option besides approve, and not multi-select. A third option or a multi-select batch has answers two buttons cannot express, so the generic flow keeps it, and keeps anything else the card cannot render. "Presentation only" is therefore literal: an intent never costs the user a reachable answer, and the client — downstream of a wire boundary — leaves every request answerable.

Dismissal became its own model-facing outcome. `ASK_CANCELLED` previously reached the model as "the user cancelled ask_user_question", naming a tool it never called; `exit_plan_mode` now reports that the user dismissed the review to speak instead and to stay in plan mode and wait. Every other ask failure — an abort from turn cancel or provider teardown, where no user is coming — keeps its own message.

## Alternatives considered

**Make plan review its own pending kind (`plan-review/requested`).** Rejected as the wrong size for a presentation problem. It buys an honest response shape (approve / decline / discuss instead of an answer batch) at the cost of a third `PendingKind`, new requested/resolved frames and schemas, an api-proxy registry and respond branch, client session and baseline-replay handling, and a new three-package capability seam for a decision the question protocol already expresses. Worth revisiting only if plan review grows outcomes the answer shape cannot carry.

**Route the card on the question's `id` or `header` (`plan-review` / `Plan review`).** Rejected: string-sniffing a foreign package's copy across a wire boundary, which any wording change silently breaks. The intent is the declaration that makes the routing legible.

**Order the options and let the card read position 0 as approve.** Rejected: a positional contract at a package boundary, invisible in both the type and the wire frame, and unenforceable — a producer that reorders its options would invert a user's verdict. Naming the label costs one string.

**Register a second composer-chain entry for the plan card.** Rejected: two entries would select over the same pending question carrier, making the surface depend on chain priority and on whether the plan package's client half is composed at all. One entry that picks its own shape cannot race itself, and the generic flow is the built-in fallback.

**Put the panel in `ui-plan` beside the plan chip.** Rejected: the panel's whole behavior is the question carrier's answer encoding (`PendingQuestion`), which `ui-user-questions` owns; the intent is a question-protocol field, not plan-mode's private channel. Rendering declared intents belongs to the package that owns question rendering, as tool render intents belong to the tool renderer.

**Extract a shared takeover card with `ui-conversation`'s `ApprovalPanel`.** Not done: the two takeovers agree on tokens and geometry but not on content — this body is scrolling markdown, that one a headline plus a command line — and the shared shell would be two elements wide. They are kept in step by token, not by component.

**Give `Chat about it` its own protocol outcome.** Rejected: dismissing a request is a verb the generic flow already has (the `×` that cancels the batch). Promoting it to a labelled button is presentation; inventing a fourth wire outcome for it is not.

## Consequences

The question protocol now carries a presentation axis. Adding a second intent is a tag on the union, a producer that sets it, a schema member, and a panel — no new frame, service, or answer shape. The cost is that the question contract knows presentation exists at all, and that `ui-user-questions` knows the word "plan"; both are the price of one entry owning every question surface.

The plan gate reads as a plan gate: the plan is the card's content, the verdict is two labelled buttons, and taking the turn back is a third. The generic flow is untouched for every other question, and its committed goldens did not move.

A deployment whose client half predates this change still shows the quiz layout — correct, answerable, and merely unstyled — because the intent is additive and the fallback is the generic flow.

## Testing

`ui-user-questions` tests pin the narrowing (single-question batch, intent present, plan as detail, named approve label offered, binary single choice, decline absent when only approve is offered) and the panel (strip, markdown plan, accessible name, absence of pager/radio/skip/custom, approve and decline answering with the asker's labels, dismissal cancelling, one-shot latch with re-arm and message on a rejected receipt, tooltips present and absent, both locales). `user-questions` tests pin both `BAD_INTENT` rejections and intent pass-through; `plan-mode` tests pin the declared intent against its own option list and both failure messages; the apiproxy schema test pins wire acceptance and an unknown tag's rejection.

The `plan-review` Web e2e lane records `/plan` entering plan mode for real, the model calling `exit_plan_mode`, the decision card taking the composer (asserting the generic flow did **not** claim the request), and the card's own Approve completing the turn — two keyless goldens, the waiting card and the approved transcript.
