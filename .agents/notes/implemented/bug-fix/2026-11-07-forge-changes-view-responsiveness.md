# Agent Note: Forge changes view responsiveness

Status: implemented

English | [中文](2026-11-07-forge-changes-view-responsiveness.zh.md)

## Problem

The forge changes view of a large change request froze the browser. Opening #7985 (366 files, 37,563 drawn lines) kept the main thread busy for about five seconds, "expand all" for fifteen, and every later state change, such as a poll result, a tool result, a file jump, or a keystroke in the file filter, re-rendered every file section. While the view was visible, the whole app slowed down: two subject-less `:has()` rules in `ui-sidebar-files` made each DOM change restyle the entire document, and the view's hundred thousand nodes made each restyle cost 170–260 ms, so a streaming Agent turn kept the main thread saturated.

## Decision

**Scoped `:has()` rules.** The navigator's covering rules name their row through `data-files-navigator-row`, which both hosts of `sidebar.files.navigator` set, so a DOM change outside such a row schedules no document-wide invalidation.

**Sections draw what changed and what the reader reaches.** `ChangesTab` passes each memoized `DiffFile` values whose identity survives its renders: one handler object, one comment-actions object, and per-file strings and booleans. Tab visibility is a prop of every section, so a visibility change redraws them all; leaving the view measured +57 ms against reading it from a React context, which the client packages forbid business components to do. The scrollport's reach tracker travels in the handler object. An expanded file holds a 22 px row per drawn line until its section first comes within 1200 px of the scrollport, then draws its lines and keeps them. After a jump, the browser's scroll anchoring keeps the target in place while the sections above it draw.

**Highlighting in the drawing render.** A section highlights its lines in the same render that draws them, as before, so the drawn text is always the file's current text and a native selection keeps its text nodes.

**Fewer serial reads.** A panel state equal to the published one reaches no follower. `changeRequestDiff` reads the patch and `.gitattributes` together. Snapshots carry the base commit as `baseSha`; `ForgeService.diff` passes it to the provider, and forge-github starts the compare read while its GraphQL read confirms the head.

**Pixel measurement.** Whether a section is near the scrollport decides whether React renders its lines at all, which CSS cannot express: `content-visibility` only skips layout and paint of nodes that already exist. The client packages offer no injected measurement hook, so one `IntersectionObserver` on the scrollport measures it off the main thread.

## Alternatives considered

**`content-visibility: auto` alone** cut style work as much as scoping the rules did, but kept the React render and Shiki tokenization of every expanded file at open, about 3 s of script, and its placeholder sizes would need estimates for every collapsed and expanded section.

**Full virtualization that also unmounts far sections** would bound the DOM after long scrolls, but a section holds a comment draft and a text selection, which unmounting loses.

**Deferred idle-time highlighting** drew plain text and applied tokens once the page was idle and the scrollport still. It kept fast scrolling smooth, but tokens carry their own text, so a file whose content changed at the same path showed its previous text until the next pass, and replacing the plain text nodes collapsed a selection made in the meantime. Against it, highlighting while drawing raised the blocking time of scrolling all of #7985 from 22 ms to 1,634 ms and its longest frame gap from 34 ms to 817 ms; other operations stayed within 0.1 s.

**The CSS Custom Highlight API** would paint token colors over unchanged text nodes and keep deferral without either defect, but it cannot apply the themes' bold and italic, and its cost over tens of thousands of ranges is unmeasured.

**Re-aligning a jumped-to section every frame for a second** kept the last file flush with the end of the list, but it also pulled back any scroll it did not start, such as one from find in page; scroll anchoring already holds every other target at the top.

**Highlighting in a Web Worker** removes tokenization from the main thread entirely, including a heavy grammar's first use, but the shared highlighter in `ui-primitives` owns Shiki; moving it is a separate change for every consumer.

**A provider-private cache of base commits** would avoid the optional `baseSha` field, but it adds retained state without an owner that knows when a change request stops being watched.

## Consequences

Opening #7985 now takes 0.5 s of main-thread work instead of 5.2 s, and file jumps, filtering, polling, and Agent turns no longer produce long tasks. In exchange, the browser's find in page does not see lines of files the reader has not approached, and scrolling onto files in a slow grammar's language, such as C++, highlights them during the scroll, up to about 0.8 s of main-thread work when that grammar is first used. A diff read costs a second compare request when the base commit changed after the latest status.
