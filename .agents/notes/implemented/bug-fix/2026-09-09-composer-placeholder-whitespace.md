# Agent Note: Composer placeholder emptiness

Status: implemented

English | [中文](2026-09-09-composer-placeholder-whitespace.zh.md)

## Problem

Sharing the whitespace-trimmed submission check with placeholder rendering leaves guidance drawn over a draft containing spaces.

## Decision

The Composer hides its placeholder whenever the raw draft is nonempty. Submission keeps its trimmed-content check. Attachments and claimed commands retain their existing placeholder suppression.

## Alternatives considered

**Reuse the submission check.** Whitespace has no sendable message content, but it occupies the editor and moves its caret. A shared check conflates these two states.

## Consequences

All placeholder variants, including queued-message steering guidance, disappear after whitespace input and return after deletion. A whitespace-only draft without attachments remains unsendable. [Component tests](../../../../packages/client/ui-conversation/tests/input-bar.client.spec.tsx) cover visibility, composition, rerendering and submission; the [browser regression](../../../../apps/web/tests/composer-placeholder.e2e.ts) checks keyboard and clipboard gestures against built UI.
