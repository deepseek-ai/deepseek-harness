# Agent Note: Symmetric message feedback submission

Status: implemented

English | [中文](2026-09-10-symmetric-message-feedback-submission.zh.md)

## Problem

The assistant-message rating controls used different commit points. Like recorded a positive rating immediately, while Dislike opened the feedback dialog and recorded only after Submit. The asymmetry made an accidental Like durable before confirmation and prevented positive feedback from carrying the same optional category and description as negative feedback.

## Decision

The [feedback dialog and categories](2026-09-08-feedback-dialog-and-categories.md) decision owns the shared form and durable taxonomy. Both unrecorded ratings open the shared feedback dialog and record only after Submit. A message `FeedbackDialogTarget` carries the selected `positive` or `negative` rating, and `FeedbackSurface` passes that rating with the dialog entry to `MessageFeedbackController.rate`. The action row reads the committed item before either action: clicking its current rating calls the injected `retract` operation, while clicking an absent or opposite rating opens the dialog. `retract` rechecks the committed rating inside the controller's serialized mutation queue and becomes a no-op after a concurrent change, so it cannot turn stale UI intent into a bare rating put. The dialog remains optional-input: submitting without a category or description records the selected rating and raises the acknowledgement toast; dismissing it records nothing.

## Alternatives considered

**Keep Like as an immediate action.** This preserves one fewer click for positive feedback, but keeps two submission models beside each other and prevents positive reports from carrying context.

**Require the dialog to retract a recorded rating.** Retraction has no category or description to collect, and an extra confirmation would make the existing undo action less direct.

**Create separate positive and negative forms.** The fields, validation, failures, and acknowledgement are identical; carrying the rating in the existing target keeps one draft and submission lifecycle.

## Consequences

Neither rating creates a `feedback/message-put` event until the user submits the dialog. Positive and negative records can both include a category and note, while clicking the active rating continues to create `feedback/message-delete` without opening the dialog. Unit coverage pins the shared action path and target routing, and the keyless Web scenarios submit both ratings through the real dialog before checking durable events and telemetry release.
