# Agent Note: Question drafts survive Session switches

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-26-question-drafts-survive-session-switch.zh.md)

## Problem

`conversation.composer` is a strict Session-scoped slot, so selecting another Session unmounts its question entry. The generic `QuestionFlow` kept its current question index, selected labels, custom text, and skip flags in React component state. A still-pending request therefore returned with empty answers after an A → B → A Session switch even though the pending carrier remained owned by Session A.

The draft is transient presentation state: it must follow its Session within the current page, but it must not become mutable state on the pending business carrier or a user preference synchronized through Host settings.

## Decision

The question entry declares a non-persisted `createQuestionDraftStore` handle when it registers into `conversation.composer`. The renderer owns one instance per Session scope and retains that instance across selection changes, so remounting the same Session reads the same progress.

The store holds at most one request identity and one progress value: current question index plus one selected/custom/skipped draft per question. `QuestionFlow` reads the stored value only when the local pending-request key and question count match. A new request therefore renders empty immediately and its first write atomically replaces the older value instead of accumulating request records. Successful answer and cancellation settlements clear only their matching request key, so a stale completion cannot erase a later draft.

Busy state, failure feedback, collapse state, and focus bookkeeping remain component-local because they describe the mounted interaction rather than the unfinished answer. The `plan-review` presentation has no multi-question draft and does not read the store.

This realizes the existing [Session-scope rule](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.md) that remount-surviving state belongs in a Session-bound source, while retaining the [Host-backed preference decision](2026-08-06-host-backed-web-preferences.md): drafts remain page-local and never enter settings, `localStorage`, or disk. The answer semantics from [multi-select custom composition](2026-07-30-multi-select-custom-answer-composition.md) are unchanged.

## Testing

The store test pins keyed replacement and stale-cleanup isolation. The component test unmounts and remounts the strict entry over one store instance and requires its page, selected option, and custom text to return. The keyless assembled Web scenario types both answer forms, switches to a new Session, returns to the waiting Session, snapshots the restored composer, and submits the restored values through the real question waterfall.

## Alternatives considered

**Keep the state in `QuestionFlow`.** Rejected because a strict Session switch deliberately destroys that React instance; a component-local key cannot outlive the unmount it is intended to identify.

**Put mutable drafts on `PendingQuestion`.** Rejected because the carrier represents pending request settlement, not React presentation state, and mutations there would bypass the Slot store's subscribed read/write surface and lifecycle ownership.

**Use a module-level map keyed by Session and request.** Rejected because plugin reload and Session pruning would not own its disposal, and completed request entries could accumulate independently of the renderer's scope lifecycle.

**Persist drafts through Host settings or browser storage.** Rejected because switching Sessions within one page needs remount continuity, not cross-page or cross-process durability. Persistence would synchronize transient answer text beyond the interaction that owns it.

## Consequences

Unsubmitted generic-question answers survive ordinary Session navigation in the current page, including the current question and explicit skips. They still reset after a page reload, Session-scope prune, or replacement pending-request identity. The per-Session memory cost is bounded to one request progress value and is released with the Slot store's Session scope.
