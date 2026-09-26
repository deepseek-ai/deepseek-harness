# Agent Note: Open Sidebar-previewed files in the default application

Status: implemented

English | [中文](2026-09-16-open-in-default-app-for-sidebar-files.zh.md)

## Problem

Opening a file in its Host default application or showing it in the file manager existed only on the delivery cards, through routes and a fetch controller private to `ui-deliverables` and addressed by Session, declaration-event sequence, and file index. The right Sidebar's document preview offered no native handoff: a video, an archive, an office document, a file the reader rejected as non-text, or an oversized file dead-ended on an explanation, with Retry as the only control even where a second read could not help (issue #3932). Those files have no delivery event to address, so the existing plumbing could not serve a second surface. A first implementation (PR #4120, by Yifffan) added a new `ui-open-locally` package with its own Host routes and moved the delivery cards onto it; product review asked instead that file opening live in the existing open-in-app feature and accepted an intermediate state for this iteration.

## Decision

[ui-open-in-app](../../../../packages/client/ui-open-in-app/README.md) owns the browser controls. The document preview of [ui-sidebar-documentpreview](../../../../packages/client/ui-sidebar-documentpreview/README.md) declares two Session-scoped list child slots whose owner props carry the file’s absolute execution-environment path, rendered only once the file's metadata reports that path: `sidebar.right.tab.document.actions` after the header's own controls, in every state that shows the header, and `sidebar.right.tab.document.unpreviewable` where Retry would stand. The preview classifies an empty-state read failure: `not-text` and `too-large` are readable files the preview cannot render and offer the unpreviewable slot; `not-found` and `not-regular-file` offer only their explanation; every other failure keeps Retry because a second read may resolve it. The unsupported-suffix empty state, which never reads, offers the same slot.

ui-open-in-app fills both slots: an "Open ▾" split button whose main button opens the file in the default application and whose menu adds the file-manager reveal, and an "Open in default app" empty-state button. Neither control renders until the Host answered that a desktop exists. The controls call the Session Remote the Host already publishes, `session.canOpenWorkspacePath` once per page and `session.openWorkspacePath` per gesture with the absolute path and, for reveal, `action: 'reveal'`; no new Host route exists. Both controls share one gesture hook: only the control the user pressed disables while its call settles, a failed call resolves as a failure kind, and that control announces it once through a transient toast, so no failure state persists on a control.

## Alternatives considered

**A new `ui-open-locally` package with its own Host routes** (PR #4120) is where the slot pair, the failure classification, the split-button design, and the toast rule come from. It was set aside because the repository already has an open-in-app feature and a second package for opening things locally duplicates it; the shared Session Remote owns verification of the Host path through the composed filesystem.

**Host routes in `dsh-host-open-in-app`** serving desktop facts and a path open would let the Host name the file manager and distinguish a missing file from a failed launch. They would make the Host half depend on `sessionController`, `workspaceFiles`, and `fs` for two calls the Session Remote already publishes, so the Remote is used directly and the reveal label stays generic.

**Moving the delivery cards onto these controls now** would repeat the largest part of PR #4120, including the cross-plugin runtime import its review rejected and the recorded delivery scenarios it had to migrate. The cards keep their own routes this iteration.

## Consequences

Every previewed file with a verified Host mapping can be opened locally from the Sidebar, including files that were never delivered. Paths without that mapping are refused before native opening. The delivery cards and the preview run two openers over one Host capability; unifying them, and deciding per surface between the full application list and the default application only, is the next step the product direction names. The reveal menu item says "Show file location" on every platform because the Session Remote reports no file manager. Default-application open carries the Host's file-association execution semantics for what it opens; the guard is the explicit user gesture on a file the Session can already read, and no new Host authority was granted.

Unit tests cover the failure classification, the preview's rendering of each recourse and its withholding of the seats before a Host path is known, the path controller's desktop read and gesture outcomes, both controls' visibility, busy isolation, and toast, and the plugin's registration and fiber-disposal removal. The keyless Web document-preview scenario drives the unsupported-suffix controls against a stubbed opener on POSIX hosts, and the seeded-history file-preview golden pins the header control.
