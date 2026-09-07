# Agent Note: Folder references settle on pick; descent moves to an explicit drill verb

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-24-folder-reference-pick-vs-drill.zh.md)

## Problem

A directory row in the `@` menu had one verb doing two jobs. Picking it inserted literal `@dir/` text and kept the menu open — the descent path for reaching a file — so a user who wanted the folder *itself* as context never got a settled entity: the token kept its trigger character, stayed editable (typing `123` kept filtering children), and looked nothing like the atomic chip a file pick produces. Field feedback with a competitor screenshot made the expectation concrete: a chosen folder should be as settled as a chosen file.

## Decision

Split the two intents into two verbs on the same row, keyboard-mapped to shell-completion instincts:

- **Settle** (row click / Enter): the directory resolves as an atomic folder chip — the file chip's exact language: folder glyph, `dir/` label, no trigger character, one deletable unit — whose serialized and clipboard form is the canonical `@dir/` mention. Implementation is the `{ insert }` arm the folder path had simply never taken; `appearance: 'folder'` was already supported end to end.
- **Drill** (Tab / the row's trailing chevron): the previous behavior verbatim — literal editable `@dir/` text, menu open on the children.

The plumbing is one new dimension, not a parallel path: `InputTriggerCandidate.drill?: boolean` advertises the second verb (only `ui-reference` directories set it), `InputTriggerPick.action: 'pick' | 'drill'` reports which one ran, `ArbitrateKey` gains `'tab'`, and the composer keymap registers `KEY_TAB_COMMAND` through the same arbitration helper as the arrows — `'consumed'` prevents default, anything else leaves native focus traversal alone. MenuView renders the chevron only on drill rows (`role="button"` span inside the option, mousedown like the row so composer focus survives, `stopPropagation` so the row's settling pick stays out).

## Alternatives considered

- **Settle on menu close** (auto-fold a literal `@dir/` into a chip when the menu dismisses): rejected — the moment an editable token becomes an entity would be invisible and surprising; hand-typed mentions stay honest text.
- **Drill on click, settle via a dedicated row button** (the inverse mapping): rejected — settling is the common intent and deserves the primary gesture; descent is the power-user refinement, which matches Tab.
- **CSS-overpainting the trigger character** on the literal text instead of introducing an entity: rejected earlier for the same reason it failed the folder-glyph fix — a Lexical text node cannot split its trigger character out, and the literal text is not a settled entity anyway.

## Consequences

- A picked folder and a picked file are the same species: atomic, glyph-labeled, no `@`, whole-unit deletion; hand-typed `@dir/` remains a plain-text reference with the glyph prefix.
- `onPick` implementations that ignore `action` behave exactly as before (`'pick'` is what every pre-existing path reports); the only behavioral change sits in `ui-reference`'s directory arm.
- Tab is intercepted only while the menu highlights a drill row; everywhere else the browser keeps it, pinned by the keymap-routing spec.
- Coverage: controller arbitration (drill / plain / pick-action), MenuView chevron routing, `ui-reference` verb split, and a real-browser e2e driving all three gestures (Enter settle, Tab drill, chevron drill) against a real workspace directory.
