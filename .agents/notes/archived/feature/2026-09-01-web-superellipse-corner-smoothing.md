# Agent Note: Web superellipse corner smoothing

Status: implemented
Archived: 2026-09-04

English | [中文](2026-09-01-web-superellipse-corner-smoothing.zh.md)

## Problem

Every rounded surface in the web client — cards, composer, buttons, popovers — draws its corners as plain circular arcs, which read as visibly harder than the smooth (squircle-like) corners current desktop chat UIs ship. That smoothness comes from CSS `corner-shape: superellipse(1.5)` applied behind an `@supports` guard, not from larger radii or masking tricks; utility-class implementations attach it to every rounded-corner class except full-round. This client has no utility classes: `border-radius` values are px literals spread across CSS Modules in every client package, so there is no single class list to attach the property to, and full-round shapes (`border-radius: 50%` circles, 999px pills) must keep circular arcs — a superellipse deforms a circle into a squircle, so a border-drawn spinner would visibly wobble, and it squares off capsule ends.

## Decision

`packages/client/ui-theme/src/styles/corner-shape.css` is a global sheet mounted by ui-theme's client entry (after `base.css`). Inside `@supports (corner-shape: superellipse(1.5))` it defines `--dsw-corner-shape: superellipse(1.5)` on `:root` and applies `corner-shape: var(--dsw-corner-shape)` through `*, *::before, *::after` — `corner-shape` does not inherit, so the universal selector is the mechanism that reaches every rounded surface without a utility-class system. Engines without `corner-shape` keep circular corners because both declarations live inside the guard. `superellipse(1.5)` sits between `round` (`superellipse(1)`) and `squircle` (`superellipse(2)`), matching the smoothing current desktop chat UIs ship.

Full-round shapes opt back out at their declaration: every `border-radius` of `50%`, `100%`, or a pill radius (≥ 99px) pairs `corner-shape: round` in the same rule of its owning component sheet. The pairing is enforced by `packages/client/ui-theme/tests/corner-shape-styles.client.spec.ts`, which scans every stylesheet under `packages/` (the shared scan helpers live in `tests/stylesheet-scan.ts`, extracted from the scrollbar spec); the same spec pins the guard and the universal application in `corner-shape.css`. Component-local radius indirections (`--dsl-*-radius`) all hold values far below the pill threshold, so the lexical scan covers current usage.

Token-based implementations pair the shape change with a 1.25× radius scale; this client has no radius tokens (px literals per component), so radii are unchanged and only the corner curvature moves.

## Alternatives considered

**A radius token system first, then per-token application.** Faithful, but converting ~130 px-literal radii across every client package into tokens is a large refactor serving no other current need; the universal selector reaches the same surfaces with one rule.

**Applying superellipse to full-round shapes too (no opt-outs).** Fewer declarations, but spinners built from `border-radius: 50%` borders wobble when the rotating shape is not a circle, and capsule ends square off.

**Subtree opt-out via `--dsw-corner-shape: round` instead of per-declaration `corner-shape: round`.** The custom property inherits, so a pill's rounded descendants would silently lose smoothing; the explicit per-rule declaration keeps the opt-out exactly as wide as the full-round shape and is what the pairing spec can check.

**Scaling radii by 1.25 alongside the curvature change.** Requires the token system above; the curvature change alone already delivers the smoothness, and radii stay as designed.

## Consequences

- On engines with `corner-shape` (Chromium ≥ 139 behind no flag), every rounded corner in the client curves along `superellipse(1.5)`; other engines render exactly as before, with no fallback code.
- New full-round shapes must pair `corner-shape: round` or the ui-theme corner-shape spec fails; the rule is stated in [docs/web-styling.md](../../../../docs/web-styling.md) and costs one extra declaration per circle or pill.
- The universal selector adds one non-inherited property to every element; the declaration is a constant and profiling concerns are theoretical at current tree sizes.
- A rounded box whose radius equals half its height (an implicit pill under 99px) still receives the superellipse; the scan cannot see computed geometry, and such ends read as intentional smoothing rather than distortion.
