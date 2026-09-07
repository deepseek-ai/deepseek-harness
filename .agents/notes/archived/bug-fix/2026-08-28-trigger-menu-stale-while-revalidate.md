# Agent Note: The trigger menu keeps previous rows through refinement

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-28-trigger-menu-stale-while-revalidate.zh.md)

## Problem

Every keystroke inside an open `@`/`/` trigger menu launches a new candidates fetch. The menu reducer's `hit` case used to reseed the groups to pending-empty, so the list collapsed to a skeleton for the 100–460ms fetch round trip and repainted on every character — a visible flicker on each refinement keystroke (#3234).

## Decision

The reducer's `hit` case (`core/menu.ts`) now retains the previous query's rows and highlight, marking each group `pending` — stale-while-revalidate. Fresh opens (`seedGroups`) still start empty, so the first paint keeps its skeleton; `allReadyEmpty` still auto-closes after settle.

Stale rows are display-only. `pick()` requires the candidate's group to be `ready`, and the `enter` arbitration checks the highlighted group's status before picking: during the pending window Enter is an explicit no-op (`'consumed'`) — it neither picks the stale row nor falls through to submit the draft. Tab already carried the same `ready` check for drilling.

## Alternatives considered

**Clear to a skeleton on every refinement.** Rejected; this was the flickering status quo. The production chat frontend's conversation search does clear (results and active index reset per debounced query), which keeps its Enter trivially safe — but its list is in a dedicated dialog, whereas this menu repaints directly under the caret on every keystroke, where the flicker is what users reported.

**Pass Enter through to submit during the pending window.** Rejected. Before this change the window showed an empty skeleton, so Enter falling through to send was visually consistent; with retained rows the user is looking at a highlighted candidate, and sending the whole draft under it is a worse mis-fire than a few hundred milliseconds of dead key. The production search's pending-window Enter is likewise a no-op.

**Queue the Enter and pick when the fetch settles.** Rejected. Acting on a keypress against rows the user has not seen yet reintroduces the stale-pick race with extra timing machinery.

## Consequences

Refinement keystrokes no longer flicker; the list content swaps in place when the fetch settles. The costs: Enter is dead for the pending window (pressing it again after settle picks normally), and rows are index-keyed, so a settle swaps DOM node content in place — pointer tests must wait for a stale-only row to disappear before clicking (`reference-composer.e2e.ts` polls `folderx/` away). A pre-existing highlight blink during refinement remains open and is deferred to a follow-up.
