# Agent Note: Shared developer-tool settings

Status: implemented

English | [中文](2026-09-17-developer-tools-settings.zh.md)

## Problem

Diagnostic views, preset selection and changed-file summaries add complexity to routine tasks. Scripted HTML also grants capabilities that a basic document preview does not need. Desktop and Web share these renderers, so independent switches would let the same setting produce different results across clients.

## Decision

The settings-owned `ctx.configForms.developerTools` preference uses a shared entry form and exposes one accepted `ui-settings.enabled` preference. The initial default-off choice reduces routine-task complexity; [Developer tools default on after preference resolution](2026-09-20-developer-tools-default-on.md) supersedes that default and owns startup enablement. General Settings offers the same switch on Web and desktop. The existing settings transport owns validation, ordered writes, persistence and recovery; loopback Web and desktop follow Host acceptance. Remote Web owns one browser-local observable shared by all consumers until reload, with no Host writes.

Off hides the Trajectory View, hides tool Inspect actions when no visible View declares tool-call inspection, hides the conversation View tab bar while fewer than two Views are available, hides the new-session preset chip and refuses the Agent-preset cards' selection, and omits the changed-files card and its summary read. Views registered by other plugins stay available. Turning it off while Trajectory is active activates Chat. The preset composition, saved default, Session events and explicit delivery cards remain unchanged. This preference is presentation policy, not Host authorization.

Plugin assembly translates the shared preference into component-specific capabilities (`showCodeDiff`, the Agent-preset surfaces' `developerTools`, and `interactivePreview`). Conversation supplies the inspection callback using the visible target's `toolCallFocus`; Chat does not name the target. The builtin HTML renderer uses DOMPurify for complete-document sanitization and parser-mutation defenses. Off preserves root styling, removes active documents, resource hints, SVG animation and all `href` attributes, and mounts an iframe with no sandbox permissions and a CSP denying scripts and external resources. It reads no related files. On retains the opaque scripted Blob renderer and its bounded related-file reads. Switching modes replaces the browsing context and disposes pending reads. The [document-preview decision](../architecture/2026-09-08-document-preview-operations.md) and [filesystem-read authority](../architecture/2026-09-09-workspace-file-read-authority.md) remain authoritative for advanced rendering and Host read access.

## Alternatives considered

**Limit the switch to desktop.** The selected requirement contains no desktop-only restriction, and the affected UI is shared. A desktop check would leave the Web renderer with inconsistent visibility and preview behavior.

**Hide controls without changing the active View or iframe.** Previously selected diagnostic content and already-running scripts would survive the toggle. Filtering the available View roster and remounting the HTML context enforce the selected presentation immediately.

## Consequences

Basic HTML sacrifices JavaScript, external and related resources, and link navigation; inline styles and data images remain available. Advanced mode retains normal browser networking and does not gain parent-origin, popup, form or top-navigation privileges. The setting does not constrain third-party preview implementations or revoke Host filesystem authority.

Component and settings tests cover defaulting, schema rejection, accepted-state updates, chip disclosure, changed-file visibility and iframe disposal. The recorded-session [document preview](../../../../apps/web/tests/document-preview.e2e.ts) and [changed-files](../../../../apps/web/tests/changed-files-turn.e2e.ts) scenarios exercise the real settings control and the shared renderer. The browser scaffold uses the shipped default unless a scenario specifies a preference. Settings chrome, document preview and changed-files scenarios explicitly disable developer tools; together they cover hidden diagnostic controls, static previews, and switching back to Chat. Refused Host writes recover accepted state and show the localized retry message. Native Electron execution remains unverified.
