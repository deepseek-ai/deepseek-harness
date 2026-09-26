---
description: "Changed files, deliveries, and clickable file references for the Web GUI: the changed-files card and delivery cards a finished turn ends with, the review tab that compares each changed file, and inline-code links in the closing prose; for users and maintainers of the deliverables experience."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-deliverables

English | [中文](README.zh.md)

## Summary

This package renders the changed-files card a finished turn ends with — the files the turn changed, with the Host's line counts, each opening the turn's review tab on that file — plus cards for explicitly delivered files, and links matching inline-code references in the closing prose so a mentioned file opens in the right Sidebar. Listed and linked paths come from the recorded summary, successful mutations, and explicit deliveries, never from the prose. Only the shipped Web patch loads this package; removing its cordis.yml entry removes the guidance, cards, and prose links together.

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

Mount this plugin alongside `ui-conversation` and the Host [workspace-changes](../../deliverables/workspace-changes/README.md) plugin; a finished turn then ends with the changed-files card between the closing message's body and its action footer. Without a served summary — a turn that changed no file, the plugin composed out, or a Host restarted since the turn ran — the card is absent and only deliveries and prose links remain; outside a git repository the summary lists file-tool edits only.

Changed-file and delivery entry cards, their file-icon tiles, and hover previews follow the [R16 preview-card rule](../../../docs/ui-radius.md#radius-scale), retaining the same contour on hover.

<a id="explicit-deliveries"></a>
### Explicit deliveries

The `present` tool's preparing stage is one non-expandable document-icon row. It does not show filenames, create delivery cards, or enable file actions before the recorded call supplies arguments.

The Web `standard`, `ptc`, and `cordis` presets expose `present` for final files accessible through the Session filesystem, including files created through Bash. Call it with `files: [{ path, description? }]` after creating the files. The [present tool](../../deliverables/tool-present/README.md) owns file-count limits and Session declarations. A single delivery fills the row; multiple deliveries form a two-column grid, collapsed after four files. Cards show the basename, description or file type, and a shared native opening control. Delivery and changed-file icon tiles use white at 50% opacity in the light theme and 5% in the dark theme. Icon tiles and single-file changed cards use the same border as delivery cards. Clicking the card previews the file in the right Sidebar. The control opens the default application and lists associated applications, with file reveal last. Matching inline-code references also open Sidebar previews. Duplicate declarations use the last description before the closing reply.

The `present` tool row retains its document icon and recorded result across progress, success, failure, and interruption. Native actions share pending state and publish progress or retryable errors on the card. Successful open or reveal feedback stays visible for five seconds, fades over 200ms, then restores the file description; failures remain visible until another attempt. Desktop metadata is loaded when cards mount and invalidated on connection replacement. Without a Host desktop, cards retain Sidebar preview but omit native controls; failed metadata reads offer Retry. Delivery cards and change review expose `deliverables.file.actions` and `deliverables.review.file.actions`, supplied by [ui-open-in-app](../ui-open-in-app/README.md). Association GET requests and native POST actions both validate the recorded file coordinates and Session filesystem mapping before using the Host desktop.

### The changed-files card

Coding Tools must be enabled to show this card or request its summary. Turning the preference off removes the card immediately while explicit delivery cards, inline file links, and recorded workspace changes remain available.

The card renders the summary the Host serves for the turn's latest `workspace/changes` announcement, read once per announcement through the authenticated summary route; while the read is pending, once the Host answers that the summary is gone, or when it lists no file, there is no card. A single changed file shows “Edited” and its basename with its file-type icon, without a file list; its header retains the counts or binary/oversized status and the file’s accessible full path. Multiple files use a code-file icon and a header naming the complete changed-file count and summed added and deleted lines; hovering or focusing it replaces the counts with “Preview in sidebar”. Each row shows one file's display path in the regular UI font with its own monospace counts, “binary” for a binary file, or “too large” for a file the Host did not capture. Rows appear in the recorded display order, so repository files above the working directory and files outside it sort first. Four rows show before a fold; the control reveals every recorded file and, once expanded, collapses the list again from the bottom. Each row opens the turn's review in the right Sidebar on that file, and the header opens it on the first file. Hovering a file row or the single-file header for 500ms opens a scrollable, single-column preview of the comparison, independent of the Sidebar’s view. Its full path uses muted monospace text and scrolls horizontally when needed. File-status notes accompanying code and hunk headers are hidden in the preview; comparisons without hunks retain their status text. Each row exposes the full path as its accessible description. The preview is 48px narrower than the card, inset 24px on each side, and at most 420px high, further constrained by the viewport. The whole preview fades in and out over 100ms. Moving into the preview keeps it open; leaving it, pressing Escape, or activating the row by pointer or keyboard dismisses it. Comparisons load only when the preview opens and share the review tab’s cache and retry states.

### The review tab

A row opens the turn's `changes-review` tab, addressed by the viewed Session and the announcing event's sequence and titled by the turn, on that row's file; another row of the same card reveals the same tab on its file. The header's file selector lists every recorded file with its counts and switches the comparison. A new tab selects the side-by-side view without wrapping. Comparisons containing only additions or only deletions render in one column, including surrounding context, without changing the selected view; mixed changes use the selected view. Its controls switch between unified and side-by-side comparison, toggle line wrapping, open the whole current file in the Sidebar, and, with a Host desktop available, open it in the default application with the same pending and retryable-error states as the cards; the view and wrap choices are kept per tab. The tab reads the summary and each comparison once through the authenticated routes. A text comparison lists its hunks with the old and new line numbers of every line, and highlights each rendered hunk side independently with the code preview's filename grammar and Shiki token colours. Additions and deletions use separate code and line-number backgrounds in each theme, with coloured line numbers, signs, and aligned edge markers; plain code text keeps the primary text colour. The tab also shows a note when the file was created or deleted in the turn, when both sides hold the same lines, when the Host's line comparison timed out and every line shows as replaced, or when the tab stopped drawing at 5,000 lines. A binary or oversized file, a comparison the Host no longer serves, and a failed read each show one line instead; a failed read offers Retry. The comparison is the turn's snapshot of the file, not its current content.

The selected-file title uses the shared `ui-primitives` [`PathLabel`](../ui-primitives/README.md#component-catalog): complete and left-aligned when it fits, otherwise clipped at the left with a fade that preserves trailing characters and the extension. Directories use subdued text, the filename uses primary text, and hovering reveals the complete displayed path. Resizing the pane or selecting another file updates the fade; the dropdown arrow, line counts, and toolbar actions retain their space.

Without wrapping, the two columns synchronize vertical scrolling and horizontal offsets up to each side’s available range. Line backgrounds, including empty alignment rows, cover each column’s full scrollable width. Both columns suppress elastic edge feedback and scroll chaining on both axes; the browser retains control of native momentum within each column’s scrollable range. Both horizontal scrollbars remain at the bottom of the visible comparison; scrolling vertically preserves a long line’s horizontal offset when the other side fits without horizontal scrolling.

### Inline-code links

The closing prose links produced or delivered paths: an inline-code token resolves by exact path, or by being exactly the basename of exactly one such path — a basename two paths share stays inert rather than guessing, so a mention can never open the wrong file. A resolved mention keeps its code chip and takes the markdown sheet's link language, with the full path as its title.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Node half registers the static `ui:deliverable-file-references` system-prompt section described under [Model Experience](#model-experience). Explicit Markdown links use the shared [Markdown renderer](../ui-primitives/README.md); inline-code matching remains limited to produced or delivered files. The browser half registers a wrapper around the changed-files card and explicit deliveries into the chat view's `conversation.chat.turnTail` list alongside other feature artifacts. `deliverablesDefinition` folds the sequence of each Turn's latest validated `workspace/changes` announcement into `DeliverablesTurnData.changes`, whose summary the card reads from the Host and caches until the connection is replaced, its `deliverables/presented` events into deliveries, and the successful first-party mutation calls of `write`, `edit`, and mutating `str_replace_editor` commands into produced paths from their validated raw arguments; the produced paths feed only the prose mention resolver. Reads, deletes, unsupported tools, malformed calls, malformed events, and failed results contribute nothing. Each row opens `dsh-resource://changes-review/session/<sessionId>/<seq>/<turn>` through `ctx.sidebarRight.openResource` with the file's index as the `changes-review` navigation parameter; the package registers the `changes-review` tab type at the `builtin` band for that pattern and its body under the keyed `sidebar.right.pane.tab` seat with an exclusive store of per-tab choices, and the body reads the summary and the comparisons through the authenticated routes into stores cleared on connection replacement. The package also provides the `chatFileMentions` service the chat view consults per closing message; composing the plugin out removes every surface and leaves the view's empty list at zero cost.

Native opening uses an authenticated POST addressed by the viewed Session, event sequence, and original file index; the review tab's native open of a changed file uses the same coordinates. For a declaration the Host reads the viewed Session header with the event and passes its cwd, or the deployment workspace root when absent, to `workspaceFiles.stat`; for a changed file it passes the working directory the served summary carries. This uses the same composed filesystem as Sidebar previews and does not activate an Agent, including for child Sessions. Native actions require the canonical process path to map from a Host path back to that same process path. Providers without this mapping return 422, after which the review tab hides its native open; a same-named Host file is insufficient. The same configured desktop availability governs metadata and execution. Edits affect subsequent opens; deletion returns an error. No file-content copy or attachment is created. Plugin disposal cancels and awaits pending native-open requests.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the deliverables surface is not enough. They move from the card to the Host recorder, the turn-tail hole, and the decisions behind the vocabulary.

- [workspace-changes](../../deliverables/workspace-changes/README.md) — the Host plugin that records and serves the summary the card renders.
- [ui-chat](../ui-chat/README.md) — declares the `conversation.chat.turnTail` hole and renders the closing prose.
- [Turn changed-files card](../../../.agents/notes/implemented/feature/2026-09-11-turn-changed-files-card.md) — the decision behind git-recorded summaries replacing the mutation-call row.
- [Workspace file links](../../../.agents/notes/implemented/feature/2026-07-31-web-workspace-file-links.md) — the decision behind the earlier produced-files row; its Host open path is superseded by the [right Sidebar](../../../.agents/notes/implemented/feature/2026-09-04-right-sidebar-docking-infrastructure.md).
- [Inline file mentions](../../../.agents/notes/archived/feature/2026-08-07-web-inline-file-mentions.md) — the decision behind clickable mentions in the closing prose.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

### Clickable file-reference guidance

#### What the model sees

The guidance prefers primary results in the final reply: inline images support explanations and comparisons, image links serve references and file lists, and image file cards serve separate deliverables. File destinations use angle brackets, including paths with spaces. It recommends separate `present` cards for complete file deliverables, especially Office files, usually selecting the most important one or two, with at most four files per call when more are needed. It discourages cards solely for code edits and extra commands to inspect diff visibility. This guidance applies even with Coding Tools disabled: it accepts fewer file surfaces to avoid duplicate presentation and unnecessary tool calls. It asks the model to link every existing-file mention outside commands, configuration expressions, and code blocks, including repeats and tables. Labels default to filenames or clear aliases, with only enough parent directories to distinguish files. Precise references display `filename:24` or `filename:24–30`; their destinations retain full relative or absolute paths with `#L24` or `#L24-L30` anchors. The display suffix contains neither `#` nor `L`.

#### Token effect

One fixed paragraph containing output-selection, rendering, and file-reference guidance whenever this package is loaded. The [present tool](../../deliverables/tool-present/README.md#model-experience) owns the delivery schema and result text.

#### KV Cache effect

The section is static at first-party order 9000 for the lifetime of the package mount, so it remains in the reusable prompt prefix and does not change across Turns.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current deliverables vocabulary. They are current package constraints, not a general file-linking comparison or a task backlog.

- **Inline local images require an HTTP(S) page**: Desktop’s `dsh-app:` pages do not support this file route. POSIX absolute paths and Windows drive-letter paths are supported; relative Chat image paths require the viewed Session’s workspace root. Separate image file links are optional.
- **Mention matching is exact path or unique basename only** — a suffix mention stays inert; widening the matcher is deferred until a real closing-message shape needs it.
- **Terminal-created files require explicit delivery** — the card lists them once git records the change, but delivery cards and inline-code references require `present`; explicit Markdown links can reference existing files directly.
- **Declarations do not preserve file contents** — reopening or transferring a Session requires source files accessible through the viewed Session’s filesystem. Missing files, directories, and final symbolic links return 404.
- **Native opening needs a Host desktop** — without one the review tab offers no native open; the comparison itself needs only the Host that recorded the turn.
- **Comparison highlighting is hunk-local** — each rendered old and new hunk side is tokenized independently because omitted source lines are unavailable; unknown suffixes remain plain, and the tab draws at most 5,000 lines before saying so.
- **Comparisons carry whole file text** — the comparison route serves a listed file's complete text wherever the Host recorded it, including ignored files and files outside the workspace root the Sidebar previews are confined to.
- **Files outside the workspace open by absolute path only** — the recorded path is the Host path at recording time; a moved workspace or a different viewing Session cannot relocate it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Prompt, slot, dictionary, file-action route, and optional service registrations are effect-owned; the Session log owns declarations and the filesystem owns file contents.
