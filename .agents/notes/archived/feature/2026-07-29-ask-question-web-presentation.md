# Agent Note: Ask-question Web presentation

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-29-ask-question-web-presentation.zh.md)

## Problem

The Web GUI could already collect answers through the `QuestionComposer` composer takeover, but the transcript around it was wrong on three counts. A pending question rendered twice: once as the composer takeover and once as the read-only `PendingCard` placeholder that predates the takeover. A settled `ask_user_question` call rendered as the generic "Tool call" row dumping raw args JSON, so the two composer verdicts — the user dismissing the whole set (`ASK_CANCELLED`) and a turn interrupt landing while the question was pending (`ASK_ABORTED`) — both read as anonymous red-dot failures. And the composer's own chrome copy (pager, buttons, placeholders, validation feedback) was hardcoded Chinese while the surrounding client is bilingual through `dsh-client-locale`.

Separately, the composer visuals had drifted from the current design: an expand-to-open custom answer entry, no multi-select affordance beyond a trailing check, header-mounted paging, and a `（可多选）` title-suffix convention parsed out of model text.

## Decision

A pending question owns exactly two surfaces: the composer takeover collects the answers, and a dedicated `ask_user_question` toolview row in the transcript names the interaction outcome. The row registers into the keyed `tool.call.toolview` hole exactly like `todo_write` and composes the shared `ToolRow` (chrome, running sweep, leading expansion). Its summary is the interaction verdict rather than args: `waiting` while running, `N/M answered` from the result JSON once settled (a skipped answer — empty `selected`, no `custom` — stays out of the count), `cancelled` for `ASK_CANCELLED`, and `interrupted` with the shared amber stopped semantics for `ASK_ABORTED`. Malformed or truncated results fall back to the generic summary. `PendingCard` narrowed to `PendingWait<'approval'>` and `ChatView` filtered the pending list to approval waits, leaving the placeholder card to approvals alone; the approval composer takeover ([web permission and approval](2026-07-23-web-permission-and-approval.md)) has since removed it entirely.

A successful row keeps the collapsed transcript to its one-line verdict and replaces generic JSON in the expanded body with a read-only question transcript. The presenter validates questions from call args and answers from result content, pairs them by the echoed stable `id`, preserves call order, and renders each model-authored question in a muted label followed by its selected and custom answer lines in primary text. A skipped question shows the localized `Not answered` verdict. The card caps its height and scrolls internally. Invalid JSON, duplicate ids, missing ids, count mismatches, unknown answer ids, and invalid visible fields all retain the generic input/output card instead of presenting a partial or incorrectly paired transcript.

A cancelled or interrupted row has no answer payload to pair. Its expanded card shows a localized set-level verdict that no answers were submitted followed by the original model-authored questions; it does not label cancellation as a per-question skip or fabricate answer records. Invalid call args retain the generic diagnostic card. Cancellation uses the neutral settled state because the user chose it deliberately; interruption keeps the amber stopped state.

The composer redesign moves paging into the footer next to the actions, renders multi-select options with explicit checkboxes, keeps single-select numbered rows, and replaces the expand-to-open custom entry with an always-visible custom input row (textarea for optionless questions). The `parseQuestionTitle` multi-select suffix convention is deleted; `multi_select` is already structured metadata, so the title renders verbatim.

Composer chrome copy becomes bilingual: the plugin registers zh/en dictionaries under the `question` namespace of `dsh-client-locale` and hands the entry a namespace-bound translator plus the locale snapshot as a hooks-compartment source through the slot inject face, so a locale flip re-renders a mounted composer. Validation feedback is stored as a dictionary key and re-translated on flip; carrier failure messages and all model-authored question/option text render verbatim.

Two adjacent fixes ride along. All generic toolview leading icons (and the hover chevron) now inherit the single tertiary label color — the others-variant secondary override and the separate chevron color rule are deleted, leaving only the intentional cordis business-primary accent. And the client dev-watch bundler registers each CSS module with `addWatchFile`, because the virtual-module indirection previously hid css-only edits from the watcher.

## Alternatives considered

**Keep rendering questions through `PendingCard`.** Rejected: the card was a read-only placeholder from before the takeover existed, so a pending question showed the same content twice with one copy not answerable. The toolview row plus takeover covers both the transcript record and the collection surface.

**Show the questions or answers in the collapsed transcript row.** Rejected: the composer takeover owns answer collection, and the row convention (`todo_write`) keeps the collapsed line scannable. The row therefore reports only the outcome until expanded; its expanded body owns the read-only question transcript.

**Keep raw input and output JSON in the expanded body.** Rejected: the payload preserves all information but makes the user's own answers or the cancelled questions difficult to scan. The structured view presents the same authored text while retaining raw JSON as the fail-closed fallback when question parsing or answer pairing is not trustworthy.

**Render `ASK_CANCELLED`/`ASK_ABORTED` through the generic error shape.** Rejected: dismissal is the user's own deliberate action and an interrupt is the shared stop gesture; both are expected outcomes, not tool failures. Naming the verdict (and keeping amber stopped semantics for the abort) matches how interrupted tool calls read elsewhere.

**Keep the row verdicts in English.** Initially deferred, then superseded when Client UI copy became locale-owned: the current conversation dictionaries localize the row verdicts and the expanded card's skipped-answer label, while model-authored questions and answers remain verbatim.

**Keep the title-suffix multi-select convention.** Rejected: `multi_select` is structured request metadata and the checkbox affordance now carries the signal, so parsing `（可多选）` out of model text was a fragile duplicate channel.

## Consequences

`ask_user_question` and `todo_write` now demonstrate the intended toolview pattern: compose `ToolRow`, summarize from call args or result JSON with shape-checked fallbacks, and register through the keyed slot. The bespoke `todo-row.module.css` is gone.

The expanded transcript adds a typed, plain-data question-card model to the shared `ToolRow`; other tool views retain their existing generic or specialized cards. The question row reads only persisted call and result fields and does not add a Host presentation field. The approval composer takeover shipped ([web permission and approval](2026-07-23-web-permission-and-approval.md), height-capped per the [approval-panel note](../bug-fix/2026-07-30-approval-panel-command-cap.md)), and `PendingCard` no longer exists.

`ui-user-questions` gains a `dsh-client-locale` dependency and an inject face where it previously had none; its contract (`QuestionComposerInjected`) lives with the consumer in `contract/slots.ts`.

## Verification

`ui-tool` tests pin the row's waiting/answered/skipped/cancelled/interrupted matrix, readable id-based pairing, selected and custom answer lines, no-answer verdicts, and fail-closed fallback. Keyless assembled-Web snapshots expand successful and cancelled question rows and record their readable transcripts. `ui-user-questions` tests pin the redesigned composer (checkbox multi-select, always-visible custom row, footer pager, dictionary-key feedback re-translation, IME-safe Enter) and the plugin's dictionary registration plus inject face; `ui-primitives` tests pin the icon set. The assembled Web GUI was exercised against a live session covering answer, cancel, and turn-interrupt paths.
