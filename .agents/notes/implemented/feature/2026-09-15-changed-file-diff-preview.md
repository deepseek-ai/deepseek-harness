# Agent Note: Turn review tab

Status: implemented

English | [中文](2026-09-15-changed-file-diff-preview.zh.md)

## Problem

The [changed-files card](2026-09-11-turn-changed-files-card.md) tells the user which files a turn changed and by how many lines, but not what changed. A row opened the file's current content in the Sidebar, or in a desktop application, which shows neither the turn's edit nor the state before it. Files git does not cover — ignored files, files outside the repository, and every file-tool edit in a working directory without a repository — had only the hunks the file tools persist with their results: partial context, counts summed over repeated edits, and no whole-file comparison at all.

## Decision

Each card row opens the turn's `changes-review` tab in the right Sidebar on that file, and the card's header opens it on the first file: one tab per turn, addressed by the viewed Session and the announcing event's sequence, with a file selector in its header that lists every recorded file and shows one file's turn-start and turn-end comparison at a time. The Host [workspace-changes](../../../../packages/deliverables/workspace-changes/README.md) recorder serves each comparison through `workspaceChanges.diff(sessionId, seq, index, signal)`; the [deliverables plugin](../../../../packages/client/ui-deliverables/README.md) registers the tab type, passes the row's file index as a navigation parameter, and reads the summary and the comparisons through authenticated routes. The header's tools switch between the unified view and a side-by-side view, switch line wrapping, open the whole current file in the Sidebar, and, with a Host desktop, open it in the default application; view and wrap choices are kept per tab. Rows and the header open the review with and without a desktop, so the earlier row-level native open and the header's folder open move into the tab and the card keeps one behavior.

Files git does not cover are compared the way Codex's turn diff tracker compares its `apply_patch` edits: from whole-file copies, not from hunks. Before a `write`, `edit`, or mutating `str_replace_editor` call runs, the recorder's `tools/pre-execute` step, which already waits for the baseline snapshot, copies the named file into the Session's temporary directory beside the snapshot objects, once per path per turn; at turn end it copies the path again. The copies are named by the SHA-1 of their bytes, so identical content is stored once, and they need no git. Paths the snapshots cover keep their git counts; every other captured path is listed from a line comparison of its two copies, which counts a repeatedly edited line once and includes a shell edit made after the file-tool edit. The persisted hunks and the argument-derived hunks are no longer read by the recorder.

Two bounds keep the copies and the comparisons small. `maxFileBytes` caps a copy and a snapshot blob read for a comparison; a larger file is listed with `oversized`, without counts, and its comparison is refused, which is what makes whole-file copies affordable. `diffTimeoutMs` bounds the line comparison, the same 100 ms Codex uses; past it the comparison degrades to one hunk that replaces every line, marked `coarse`, so a pathological file never stalls the turn's record or the tab. Both are Config fields.

The comparison is computed when asked for, on the Host, from the two content sources kept beside the served summary: a path in a snapshot tree, read with `ls-tree -l` and `cat-file blob` under the byte cap, or a copy read from disk. Snapshot sides git reported as binary and copies holding a NUL byte serve no lines. The tab renders the hunks with old and new line numbers and no syntax highlighting; the side-by-side view pairs each run of deletions with the additions that follow it row by row. A comparison the Host no longer serves, a failed read, a binary file, and an oversized file each show one line.

Content still lives only as long as the Session in this Host process, as the card decision settled; the comparison shares the card's lifetime, so a conversation reopened after a Host restart has neither.

## Alternatives considered

**Whole-file before and after text in the file tools' result metadata**, as Codex's `apply_patch` returns, would put every edited file twice into the Session log. The recorder captures the file itself instead, so the log keeps carrying only the turn number.

**Storing the copies in memory**, as Codex does for its per-turn tracker, grows with every turn because the records live for the Session; the copies go to the Session's temporary directory beside the snapshot objects and are read only when a comparison is asked for.

**Storing the copies as git blobs in the private object store** would have shared one read path with the snapshots but made the file-tool path depend on git, which the working directories without a repository or without git cannot provide; plain files under the same directory keep that path git-free.

**A shadow repository for working directories outside any repository** remains deferred; the copies cover the file-tool edits there, which is the part a user can act on.

**One tab per file**, titled by the file name, was the first implementation; reviewing a turn meant one tab per row. One tab per turn with a file selector keeps the turn's changes together and lets the row still land on its file.

**Syntax highlighting** in the tab is deferred until the plain view proves insufficient.

**Keeping rows opening the current file** would have left the comparison one click further away; the current file still opens from the prose links and the Files tab.

## Consequences

Every file-tool edit reads and writes its whole file once per turn on the Host, bounded by `maxFileBytes`, even for paths the snapshots also cover; a Session's temporary directory holds the copies until disposal. Comparison line counts for uncovered files are first-to-last, not sums, and two sides that both exceed the cap list the file as `oversized` rather than dropping it, since unread content is never known to be unchanged. A comparison costs at most two `ls-tree` and two `cat-file` commands plus one bounded line comparison; a comparison that timed out carries every line of both sides, up to twice `maxFileBytes`, and the tab draws at most 5,000 lines of it. The comparison route serves a listed file's complete text to the browser wherever the Host recorded it — ignored files, repository files above the working directory, and files outside the workspace — where the summary route served only paths and counts and the Sidebar's file previews stay under the workspace root; the user authorized those edits, so this is accepted and recorded in both READMEs.

The `WorkspaceChangedFile` type gains `oversized`, `WorkspaceChanges` gains `diff`, and two served types, `WorkspaceDiffHunk` and `WorkspaceFileDiff`, join the subsystem page. The Session log is unchanged. The changed-files card's rows are labeled as opening the file's changes in both languages, so the recorded Web scenario's golden changed; the same scenario now opens a shell-appended file's comparison from the snapshots and an ignored file's from its copies.

Focused tests cover whole-file capture classification, the timeout degradation, comparisons served from snapshot trees, renames, deleted files, oversized blobs, and copies, the comparison route, the tab's addresses, store, and states, and the card's row wiring.
