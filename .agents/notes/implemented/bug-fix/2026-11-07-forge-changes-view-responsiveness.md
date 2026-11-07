# Agent Note: Forge changes view responsiveness

Status: implemented

English | [中文](2026-11-07-forge-changes-view-responsiveness.zh.md)

## Problem

The forge changes view of a large change request froze the browser. Opening #7985 (366 files, 37,563 drawn lines) kept the main thread busy for about five seconds, "expand all" for fifteen, and every later state change, such as a poll result, a tool result, a file jump, or a keystroke in the file filter, re-rendered every file section. While the view was visible, the whole app slowed down: two subject-less `:has()` rules in `ui-sidebar-files` made each DOM change restyle the entire document, and the view's hundred thousand nodes made each restyle cost 170–260 ms, so a streaming Agent turn kept the main thread saturated.

## Decision

**Scoped `:has()` rules.** The navigator's covering rules name their row through `data-files-navigator-row`, which both hosts of `sidebar.files.navigator` set, so a DOM change outside such a row schedules no document-wide invalidation.

**Sections draw what changed and what the reader reaches.** `ChangesTab` passes each memoized `DiffFile` values whose identity survives its renders: one handler object, one comment-actions object, and per-file strings and booleans. Tab visibility reaches only the menus and the composer through a context. An expanded file holds a 22 px row per drawn line until its section first comes within 1200 px of the scrollport, then draws its lines and keeps them. A jump keeps its target aligned for one second while nearby sections draw.

**Idle-time highlighting.** Lines draw as plain text and take their tokens once the page is idle and the scrollport has been still for 200 ms, so tokenization never interrupts a scroll in progress. A pass highlights 100-line fragments while each idle period lasts and runs again only when the file's segments change or its own language's grammar loads; the shared highlighter's identity, which changes on every grammar load, no longer triggers one.

**Fewer serial reads.** A panel state equal to the published one reaches no follower. `changeRequestDiff` reads the patch and `.gitattributes` together. Snapshots carry the base commit as `baseSha`; `ForgeService.diff` passes it to the provider, and forge-github starts the compare read while its GraphQL read confirms the head.

## Alternatives considered

**`content-visibility: auto` alone** cut style work as much as scoping the rules did, but kept the React render and Shiki tokenization of every expanded file at open, about 3 s of script, and its placeholder sizes would need estimates for every collapsed and expanded section.

**Full virtualization that also unmounts far sections** would bound the DOM after long scrolls, but a section holds a comment draft and a text selection, which unmounting loses.

**Highlighting in a Web Worker** removes tokenization from the main thread entirely, including a heavy grammar's first use, but the shared highlighter in `ui-primitives` owns Shiki; moving it is a separate change for every consumer.

**A provider-private cache of base commits** would avoid the optional `baseSha` field, but it adds retained state without an owner that knows when a change request stops being watched.

## Consequences

Opening #7985 now takes 0.5 s of main-thread work instead of 5.2 s, and file jumps, filtering, polling, and Agent turns no longer produce long tasks. In exchange, the browser's find in page does not see lines of files the reader has not approached, highlighting restarts at 100-line fragment boundaries, so a multi-line comment or string crossing one can be mis-colored, and the first use of a slow grammar, such as C++, still produces a 400–550 ms long task while scrolling. A diff read costs a second compare request when the base commit changed after the latest status.
