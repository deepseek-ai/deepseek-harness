# Agent Note: Running drafts take the primary Send action

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-20-running-draft-primary-send.zh.md)

## Problem

The ordinary Web composer remains editable while a Turn is running, and keyboard submission can queue or steer its draft. Its single primary pointer control nevertheless stayed on Stop for the entire Turn. A pointer user who entered a follow-up and activated that control stopped the current Turn instead of submitting the visible draft, so the control contradicted the composer's editable state and the user's current content.

## Decision

`InputBar` chooses the ordinary session's primary action from the running state, draft content, and owner block. An empty running composer shows Stop and routes it through the existing session cancellation callback. Non-whitespace text or at least one attachment changes that same control to Send; the click uses the existing Queue submission path. An owner-blocked running composer keeps Stop even when a retained draft exists, because the block disables both editing and submission. Clearing the draft or completing a successful submission restores Stop while the Turn remains active. Idle sessions continue to show Send, disabled while the draft is empty or submission is unavailable.

The pointer action does not inherit the `ui-conversation.busyEnter` preference. That preference continues to choose Queue or Steer only for the two keyboard gestures. Continuable subagents retain independent Send and Stop controls, and one-shot subagents retain their read-only behavior.

## Verification

The `InputBar` component test covers empty, text, cleared, submitted, attachment-only, and owner-blocked running drafts, including Queue submission while the keyboard preference selects Steer. The keyless assembled Web scenario parks a real composed Turn in the replay adapter, captures the running draft with Send, clicks it through the Host Queue path, observes Stop return after the draft clears, removes the queued row, and then cancels the Turn.

## Alternatives considered

**Keep Stop for the whole running Turn.** This preserves immediate cancellation but leaves the visible editable draft without a pointer submission action and makes the primary control act against the content beside it.

**Render Send and Stop simultaneously for every running session.** Continuable subagents need two independent operations because their cancellation route differs from continuation delivery. Ordinary sessions have one established primary seat; adding a permanent second control would spend more space and create a different hierarchy when the draft itself already identifies the immediate action.

**Apply the busy-Enter preference to pointer Send.** A button labeled Send would silently change between Queue and Steer according to a keyboard preference. Keeping pointer submission on Queue preserves the existing explicit distinction and avoids an invisible mode on the button.

## Consequences

Pointer users can submit a follow-up without waiting for the active Turn or using a keyboard shortcut. An actionable draft occupies the single primary seat, so Stop returns after the draft is cleared or accepted rather than remaining simultaneously visible; an owner block returns that seat to Stop because the retained draft cannot be edited or submitted. Keyboard delivery selection, cancellation transport, and subagent controls are unchanged. Issue #2850 records the user-facing defect and acceptance boundary.
