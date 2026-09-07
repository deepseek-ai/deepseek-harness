# Agent Note: The hero input glow is removed

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-28-remove-hero-input-glow.zh.md)

## Problem

The New Session hero painted a decorative backdrop ellipse (`HeroGlow`, figma 313:14109) under the input card: a blurred blue gradient sized `1051/776` of the hero box so its `stdDeviation="50"` blur scaled with the card. On the shipped token sheets the ellipse read as stray blue tint rather than intentional chrome, and its by-construction bleed past the conversation column forced clipping scaffolding onto the column itself.

That scaffolding existed because a box that scrolls in one axis computes the other axis's initial `visible` to `auto`: the glow's overhang gave `[data-conversation-scroll]` a real 24–95px horizontal scroll range on laptop widths, patched by declaring `overflow-x: hidden` on `.scrollBody` (2026-08-04). This note supersedes and consolidates that bug-fix note.

## Decision

`HeroGlow` is deleted with its positioning scaffolding: the component and its seat in `EmptyHero.tsx`, the glow z-index carve-outs in `ConversationRoot.module.css`, and the `.scrollBody { overflow-x: hidden }` clip, which had no owner other than the glow's bleed. The scroll body's horizontal axis returns to its derived value, and nothing under the column currently bleeds past it.

The e2e scenario `conversation-column-overflow.e2e.ts` and its golden are deleted with the glow: the test's vacuity guard asserted the glow still bled past the column at narrow stops, so it cannot pass — by design — once nothing bleeds.

## Alternatives considered

**Keep the glow and retune its color.** Rejected. The tint was not a token mistake to correct; the product read is that the homepage input carries no backdrop chrome at all.

**Keep `overflow-x: hidden` as a defensive clip.** Rejected. With the glow gone the declaration has no current owner, and the repo requires one; a silent clip would also hide the next accidental bleed instead of surfacing it in review.

**Keep the overflow test against future bleed.** Rejected. Its vacuity guard requires a presently-bleeding element, so the scenario cannot express "nothing bleeds" without inverting into a different test; the composer geometry golden already pins the scroll body's `overflow` axes per tab.

## Consequences

The hero stack is plain chrome above the shared input card, and 67 lines of glow component, seat wiring, and clip scaffolding are gone. The cost is the standing guard: the conversation column is again a one-axis scroller only by construction, so a future decorative element that bleeds past the column will re-derive `overflow-x: auto` and surface a horizontal scrollbar. Whoever reintroduces bleed must restore an explicit one-axis clip on `.scrollBody` and a gesture-level regression test — asserting `scrollWidth === clientWidth` is not a substitute, because a clip hides the range without reflowing it away and only the refused wheel gesture distinguishes the states. The composer tab geometry golden records the current `overflow auto/auto` reading and will flag the derivation flipping back.
