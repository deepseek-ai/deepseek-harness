# Agent Note: The drill claim is published before the edit that re-enters tracking

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-29-drill-claim-precedes-the-drill-edit.zh.md)

## Problem

A pointer descent in the `@` menu produced no breadcrumb, while the keyboard descent into the same directory produced one (#3310). Clicking a crumb — the gesture the breadcrumb exists for — dropped the header entirely instead of re-listing the step it named. Rows in a pointer-drilled listing also repeated the parent directory the header was supposed to carry.

The three faults are one ordering defect in `InputTriggerController.settle`. The drill claim (`drilled`) was assigned after `execute()` returned, on the assumption that the input applies a descent edit and re-tracks later. That holds only for the keyboard: `KEY_TAB_COMMAND` handlers run inside a Lexical update, so `SessionInputShell.applyEdit` joins the enclosing update and the commit — with the `track()` call its update listener drives — lands after `settle` has returned. A pointer `mousedown` handler is outside any update, so `applyEdit` runs `editor.update(fn, { discrete: true })`, which sets `_flushSync` and commits synchronously; `track()` therefore re-enters the controller *during* `execute()`, and both readers of the claim — `refreshHeaders` and `fetchCandidates` — saw it still clear. Every existing test modeled the keyboard ordering: the fake insert listener returned `true` and the spec re-tracked afterwards by hand, so the pointer ordering was never exercised.

## Decision

`settle` claims the drill before dispatching the edit, and withdraws the claim only when the edit is refused:

```ts ignore-check
this.reduce({ type: 'close' })
this.drilled = action === 'drill'
if (!this.execute(outcome, hit.span)) this.drilled = false
```

The claim still follows `reduce({ type: 'close' })`, whose teardown clears it. Withdrawal remains exact because a refused edit mutates nothing and so drives no re-entrant `track()`: `insertText` fails its `draftRev` CAS before touching the editor, and `$replaceDetectSpanWithText` returns `false` from `selectSpan` ahead of `$setSelection`. The observable guarantee the [breadcrumb decision](../feature/2026-08-27-web-at-mention-discovery-and-row-content.md) states is unchanged — a header never names a directory nobody descended into — and both descent gestures now reach `header` and `candidates` as a drill.

## Alternatives considered

**Re-publish the header after `execute` returns.** Rejected: it treats the visible half of one defect. `fetchCandidates` reads the same claim, so the candidate request would still report `drilled: false` and `ui-reference` would keep repeating the parent directory on every row of a pointer-drilled listing.

**Defer `execute` to a microtask so the re-entrant track always lands after `settle`.** Rejected: the edit carries `hit.span` for revision CAS, and postponing it past the current task lets an intervening keystroke invalidate the span, turning a working descent into a silently refused one.

**Make `applyEdit` never flush synchronously.** Rejected: `discrete` is what keeps a programmatic edit and the detect coordinates computed from it in one task; relaxing it to fix a menu flag would loosen the whole input machine's ordering for every caller.

## Consequences

- Tab, the row chevron, and a crumb reach one behavior, so the breadcrumb no longer depends on which gesture opened the listing.
- Any future state a source reads through `header` or `candidates` must be published before `execute`, because the input can re-enter `track()` inside it. The claim is instance state on the controller, so the ordering is the only thing enforcing it.
- Coverage: a controller spec whose insert listener re-tracks synchronously — the pointer ordering — asserts both readers, and `reference-composer.e2e.ts` asserts the breadcrumb and the trimmed rows after a chevron drill and walks a two-level trail back through a crumb click. The keyboard ordering keeps its existing spec, so a regression that fixes one gesture by breaking the other fails.
