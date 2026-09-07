# Agent Note: Web composer as a Lexical editor (chips as atomic nodes)

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-20-web-composer-lexical-editor.zh.md)

> Scope: the composer's text surface (ui-conversation input/editor), the SubmitMachine that remains of InputMachine, and the projection contract feeding the untouched ui-input-trigger pipeline. Supersedes the draft/occurrence half of the [input machine note](2026-07-25-web-input-machine-and-slash-pipeline.md); its submit-plane, slot, and trigger-pipeline halves stay current.

## Problem

The textarea composer painted text in three coupled layers (hidden auto-grow mirror, decoration backdrop, transparent-text textarea) and held the draft twice (the textarea string and the machine's occurrence table). Both couplings produced structural bugs: reconciling occurrences against a string diff guessed the edit position, and a greedy scan sliding into a reference silently degraded it before the serialization guard could run (#2813); scan-derived decorations carried no identity, so typing ahead of one rebuilt its DOM every keystroke (#2793). The layer trick also taxed every chip style — nothing could change glyph advance, so no background, padding, radius, or label truncation.

## Decision

One Lexical editor per session shell replaces the three layers and the draft half of the machine.

- **Ownership**: `SessionInputShell` creates the editor outside React (`createEditor` + `registerPlainText` + `registerHistory`) and keeps it for the session's lifetime; React binds a resident contenteditable to it (`ComposerContentEditable`, ~40 lines) and portals decorators (`DecoratorPortals`). `@lexical/react` is deliberately not used: its composer owns editor creation inside React, which conflicts with per-session shell ownership, and it drags an unused dependency tree.
- **Chips are atomic `DecoratorNode`s** (`ReferenceChipNode`) carrying the owner's insert-time projections. NodeKey is the occurrence identity; `getTextContent()` answers the clipboard projection, so native copy/cut and the draft mirror need no expansion code.
- **One tree, three projections**: the detect projection (chip = one U+FFFC) feeds `detectTrigger` and TokenSpan coordinates, restoring the opaque-reference invariant #2769 broke; the clipboard projection (chip = clipboardText) feeds `InputState.draft`, persistence, and submit-plane decisions; the model form is produced per chip at submit through the owner codec. `span-map.ts` is the single place numeric spans map back to Lexical points.
- **The machine slims to the submit plane** (phase/claim/attempt); it never holds the draft — events carry the clipboard projection (`enter`, `submit-settled`), and the claimed integrity watch runs on `draft-changed`. Draft clearing became the `commit-draft` effect the shell executes in the editor (suffix retention included), followed by `CLEAR_HISTORY_COMMAND`.
- **Contract stability**: `TokenSpan {start, end, draftRev}`, `ReferenceInsert`, `CommandClaim`, the four `slash/input-*` bail events, every trigger source, the controller, and MenuView are unchanged. `draftRev` is now the editor update counter.
- **Claim tokens stay literal text** with a transform-styled leading leaf (backspacing the token remains the exit gesture); plain-text references ride `registerLexicalTextEntity` (`TextRefNode`); the ghost hint is a CSS `--dsh-composer-hint` variable rendered as generated content.

## Retired with the rewrite

The mirror/backdrop layers and their CSS coupling rules; the Safari soft-wrap repair (2026-08-13 note's workaround — the surface has no mirror to disagree with); mirror-Range caret measurement; the machine's undo ring and typing-merge clock (Lexical history, 1000ms merge delay preserved); manual boundary Backspace/Delete occurrence deletion (atomic nodes); manual copy/cut expansion; `EditRange`/`diffEdit`/`reconcile`. The paste-attempt plane (`paste-begin` components, `paste-upgrade`, `invalidate-paste`) and the `set-invalid` event had **no producers anywhere in the tree** and were deleted rather than ported; `Occurrence.invalid` stays on the node and the projection for the day a producer exists.

## Deliberate behavior changes

- Claimed command args now reach the source in clipboard form (references as canonical text, not display labels) — the parseable form.
- `InputState.draft` is the clipboard projection (was display text). Cross-package readers consume phase/queue-level fields; the occurrence table had zero external readers.
- Chip deletion follows the engine's native decorator gesture; jsdom lacks `Selection.modify`, so the keyboard path is asserted in the browser lane only.
- Folder text-refs render the folder glyph as an icon prefix before the intact literal token (a currentcolor mask of the bubble's asset); the old backdrop overpainted the trigger character instead, which a Lexical text node cannot express.
- The composer's accessible name is an explicit `aria-label` mirroring the placeholder (a div's `data-placeholder` does not name it the way a textarea's placeholder did) — caught by the reference-composer aria golden.
- Caret-only commits publish nothing: the shell advances `draftRev` and re-publishes `InputState` only when the projection's content changes. Caret motion still feeds menu tracking, but it neither invalidates snapshot-built CAS spans (apply.ts builds spans from the published `draftRev`) nor re-renders subscribers. The first cut re-published on every commit; review caught the drift from the old machine's text-only revision.
- A paste is its own undo boundary: the custom PASTE_COMMAND handler consumes the event before `@lexical/plain-text` could tag the update, so the shell attaches `PASTE_TAG` itself (via `$addUpdateTag` — the dispatch path always runs nested inside the command update). Without it, history merged a paste with typing inside the 1s window and one undo removed both.
- The claim decoration outranks text-ref entities on the leading-token seat: a claimed command name that is also on the trigger lexicon stays a plain warn-styled TextNode, because Lexical transforms register per concrete node class and an entity capture would silently drop the claim color (probe-confirmed before the guard: the entity node won and the style was lost).

## Alternatives considered

- **Patch the textarea** (record beforeinput selections to narrow the diff, #2813's proposed fix): shrinks the guessing window but keeps two truths and the style tax; every future decoration pays it again.
- **Hand-rolled contenteditable layer**: rejected by the dependencies-over-hand-rolling policy — IME, selection, and engine quirks are exactly what Lexical already owns.
- **Deleting the machine entirely** (editor state as the only machine): the submit plane (attempt CAS, anti-backwash, abort) is text-independent and battle-tested; rewriting it buys risk, not simplicity.
- **`@lexical/react`**: its composer creates the editor inside React, conflicting with per-session shell ownership, and pulls an unused dependency tree; the two bindings it would replace total ~80 lines.

## Consequences

- Bugs #2813 and #2793 are structurally unexpressible: no edit-position inference exists, and chip DOM identity rides NodeKey.
- Chips are real DOM (icon, capsule, `max-width` truncation, invalid strike-through) and enter the accessibility tree; the old backdrop was `aria-hidden`.
- The editor and its history survive session switches on the shell; unit tests drive the document headlessly, while true keyboard gestures (chip deletion, IME) belong to the browser lane.
- The ui-conversation client bundle carries lexical (+~70KB gzip); no other package imports a Lexical value, so no module-table row exists.
- The submit plane, trigger pipeline, and slash/input-* contracts are byte-compatible for every source plugin.

## Traps

- `editor.update` **defers** its fn when called from inside the same editor's update (command handlers land there synchronously); a nested discrete throws. `applyEdit` runs the `$`-body directly when `editor._updating` (legal in command handlers — the pattern Lexical itself uses for setEditable) and discretely at top level. A bail answer computed through a wrapped nested update reads stale state.
- Lexical's chord/space detection reads `event.keyCode` (undo `z`=90, space=32); synthetic tests must set it.
- A history restore (`UNDO_COMMAND`) commits on the next flush, not synchronously inside the dispatch.
- The client bundle needs the `production`/`development` exports condition pinned (tsdown preset `inputOptions.resolve.conditionNames`): lexical's `node` condition file selects its flavor with a top-level await a CJS bundle cannot carry.
- `registerHistory`'s merge delay reads `Date.now` at call time; fake-timer tests must install the mock before shell construction or advance past the window.
- `isKeyboardSelectable()` must be **false** on the chip. With the default `true`, an arrow at the chip edge creates a NodeSelection whose DOM projection collapses to an element point, and the plain-text binding's arrow/delete/insert handlers all bail on non-Range selections — arrows, typing, and Backspace deadlock at the chip until a pointer click. False restores the placeholder semantics: arrows step across in one move, Backspace/Delete remove the chip whole (browser-lane e2e pins the gesture; only a real key event reproduces it — CDP raw keydowns carry no engine default).
