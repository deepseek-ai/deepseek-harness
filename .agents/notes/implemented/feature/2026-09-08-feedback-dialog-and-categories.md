# Agent Note: Feedback dialog, categories, and the acknowledgement toast

Status: implemented

English | [中文](2026-09-08-feedback-dialog-and-categories.zh.md)

## Problem

The Web client had two disconnected feedback paths with no visible outcome. `/feedback <text>` recorded a Session remark and rendered an acknowledgement row in the transcript; the Like/Dislike pair recorded a rating at once, with a note popover anchored under the row for free text. Neither path told the user what was submitted or where it went, neither collected a category, and a Dislike, the case in which a user is most willing to explain, asked nothing. Issue #3515 and the design doc for it ask for one dialog reachable from the composer menu, from a bare `/feedback`, and from Dislike, with seven fixed categories, an optional description, a success toast, and a filled glyph for a recorded rating, while Like keeps recording at once.

## Decision

`command-feedback` owns the category taxonomy as the `FeedbackCategory` union and the `FEEDBACK_CATEGORIES` tuple in its client-safe `./types` export, and `feedback/record` becomes `{ text?, category? }`: blank text is recorded as absent, and an entry with neither member still records, because the log delivery that the feedback authorizes is the content. The same package publishes the `sessionFeedback.record` Remote through `TypertRemoteService`, resolving the live Session by id and calling the existing `recordFeedback` producer, so the dialog records the same event as the command without command bookkeeping. `message-feedback` adds the optional `category` to `MessageFeedbackItem` and `MessageFeedbackPutRequest`, validates stored values against the tuple, and counts a category change as a material edit.

`ui-message-feedback` becomes the Web feedback surface. A per-session `FeedbackSurface` owns the message-feedback controller, a `FeedbackDialogController` for the draft, the submission, and the toast sequence, and the routing between them: a message target puts its selected judgment with the dialog's category and note through the message controller, while the Session target records through `ctx.remote.sessionFeedback`. A `FeedbackDialog` entry of `conversation.input.overlay` renders the Modal and Toast primitives from the dialog store. A decoration on the Host's `feedback` command opens the dialog for the Session from a menu pick or a bare Enter while `/feedback <text>` still reaches the Host; it uses the `action` kind in `CommandUiSpec`, which consumes the trigger token and runs a client callback without submitting anything. The later [symmetric message feedback submission](2026-09-10-symmetric-message-feedback-submission.md) decision owns the rating entry rule: either unrecorded rating opens the dialog, while clicking the recorded rating retracts it. The note popover, `clearNote`, and `clear` remain absent because the dialog is the only note editor.

The dialog is the shared Modal card at the design's width; the design's checkbox for including the conversation log is not built, because the log travels with every feedback event and is not optional. An oversized description still fails on submit with `note-too-large`; the dialog stays open with its draft and a warning toast presents the localized failure.

## Alternatives considered

**Encode the category into the note text.** A prefix in free text is not filterable without parsing and would leak into the verbatim note that telemetry uploads; a durable id in the payload is what a consumer can group by.

**Submit the dialog through the command plane as `/feedback <text>`.** The command rejects empty text, cannot carry a category, and writes an acknowledgement row the design replaces with a toast; the Remote records the same event with neither constraint.

**Keep the note popover beside the dialog.** Two editors for one note with different reachability would leave the row two-line at some widths, the defect the popover was introduced to avoid, and the design shows only the thumbs.

**A Toast per message control.** The composer overlay already mounts once per Session, and the dialog owns the toast sequence, so one owner serves both message-rating paths and the Session dialog.

**A dialog kind in `CommandUiSpec`.** An action that consumes the token and runs a client callback is all the dialog needs; the File row uses the same `action` kind, so one definition serves both entries.

## Consequences

Adding a category means adding it to the union, to the Host tuple, to the dialog's chip record, and to the `feedback` dictionaries; the client bundle purity gate forbids a value import from a Host package, so the dialog restates the taxonomy as a `Record<FeedbackCategory, true>` whose key order is the chip order and whose completeness the compiler checks. The frozen released-v2 payload inventory still lists `feedback/record` as `text` only: it governs artifacts migrated from older generations, which cannot carry the new members, while equal-version restoration applies the installed vocabulary. The `message-feedback-layout` web scenario that pinned the popover's geometry is deleted with the popover. The message-feedback and feedback-release web goldens and the feedback subsystem doc changed in the same PR; the SDK feedback producer records a categorized Session remark and a categorized Dislike, so both SDK expected outputs carry the new members.
