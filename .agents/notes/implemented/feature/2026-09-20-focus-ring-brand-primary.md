# Agent Note: One keyboard-focus colour for every control

Status: implemented

English | [中文](2026-09-20-focus-ring-brand-primary.zh.md)

## Problem

Different explicit focus colours and browser-default outlines do not provide a consistent keyboard-focus cue. Browser defaults can also depend on the operating-system accent.

Focus feedback has separate interaction and geometry constraints. A browser's `:focus-visible` heuristic can reveal a pointer-focused button after a key that does not move focus, while editable text controls need focus feedback on click. Containers that clip their contents can hide an outer ring.

## Decision

[The theme's focus stylesheet](../../../../packages/client/ui-theme/src/styles/focus.css) owns the shared ring colour and standard width. [Input modality](../../../../packages/client/ui-primitives/README.md#input-modality) distinguishes tooltip input from keyboard focus navigation.

**One colour.** Global and component `:focus-visible` outlines and focus-ring shadows read `--dsw-focus-ring-color`, falling back to `--dsw-alias-state-business-primary`. The global fallback names the colour and the standard width but never the style, so it cannot create an outline where the component disables one. Naming the width is what keeps a control with no ring of its own at the standard geometry instead of Chromium's `auto 1px`.

**Context-owned geometry.** `--dsw-focus-ring-width` carries the standard 2px width. Dense tables and toolbars may keep 1px so the ring does not dominate compact content. Components own their offsets and use an inset ring where an outer ring would be clipped.

**Pointer focus does not imply keyboard navigation.** In pointer modality, `:focus-visible:not(:read-write)` controls use a transparent ring colour. Descendant and pseudo-element rings inherit it. Only focus-ring paint is suppressed: selected-state borders and elevation shadows remain, and editable text controls keep their own focus feedback on click. DOM focus stays on the control.

Tooltips follow the last input and treat any key as keyboard input. Rings instead resume keyboard styling on non-composing navigation keys, or on focus reaching a different control after a non-composing key. Refocusing the same control is not navigation; pointer input, composition keys, and window blur clear the pending key.

## Alternatives considered

**Rewrite only the component declarations.** Explicit rings would agree, but controls using a browser-default outline would retain its colour. Requiring every control to declare its own ring would also leave new controls inconsistent until their authors add that rule.

**Unify width and offset globally.** Positive offsets can be clipped by a scrolling ancestor, while a uniform thick ring can overwhelm dense content. Neither colour consistency nor input modality requires identical geometry.

**Suppress by moving focus instead of by style.** Calling `blur()` on a pointer-focused button would hide its ring but also remove the target for subsequent Enter or Space activation.

**Clear all shadows on pointer focus.** A `box-shadow` can contain elevation or selected-state paint as well as a focus ring. Suppressing its ring colour preserves those independent cues; exempting `:read-write` preserves text-entry feedback.

**Replace every `outline: none` with a shared ring.** Some controls use an inset shadow or container-level focus treatment instead; some containers deliberately show no ring. Replacing those declarations would change their focus treatment, not merely its colour.

**Give tooltips and rings the same modality rule.** A key can justify a tooltip on subsequent programmatic focus without justifying a ring on the same pointer-focused button. Keeping separate answers preserves both behaviours.

## Consequences

Focus rings share a theme colour while components retain their geometry and non-focus state cues. Ring visibility changes without changing the keyboard's active target. These rules do not guarantee identical browser rendering or eliminate component-specific clipping.

[Stylesheet-order checks](../../../../packages/client/ui-theme/tests/client-styles.client.spec.ts), [focus-style checks](../../../../packages/client/ui-theme/tests/focus-ring-styles.client.spec.ts), and [input-modality tests](../../../../packages/client/ui-primitives/tests/input-modality.client.spec.ts) cover stylesheet declarations and modality transitions. Static declarations and synthetic events do not establish rendered ring visibility or cross-platform behaviour.
