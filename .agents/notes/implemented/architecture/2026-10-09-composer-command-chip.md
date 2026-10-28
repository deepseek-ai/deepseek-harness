# Agent Note: Claimed commands as atomic composer chips

Status: implemented

English | [中文](2026-10-09-composer-command-chip.zh.md)

## Problem

The [Lexical composer decision](../../archived/architecture/2026-08-20-web-composer-lexical-editor.md) kept a claimed command as literal leading text. A TextNode transform styled the token and split typed overflow back out of it, and the submit machine held the claim while the draft string started with the token. Every edit at the token boundary ran through that transform. Lexical merges same-style neighbours before the overflow node's own transform runs, so the split and the merge looped until Lexical aborted the update with error #14 and the DOM diverged from the editor state (issue #4490). PR #5480 cleared the copied style for the reported gesture; pasting an image after a claim and IME composition reach the same transform and remained unverified. The plain-text reference entity also needed a precedence rule to leave the claimed token alone.

## Decision

A claim replaces the leading trigger span with `CommandChipNode`, an atomic inline `DecoratorNode`, followed by the token's argument separator as an ordinary text node.

- The node carries the `CommandClaim`, including its submit closure. History restores nodes with their fields, so undoing a chip deletion restores the claim. JSON export writes the token text; JSON import yields a plain text node because the closure has no JSON form.
- The detect projection counts the chip as one U+FFFC, so trigger detection never re-reads the command name. The clipboard projection is the token without its separator. The chip is not a reference occurrence. `EditorProjection.command` is the claim of a chip that opens the document.
- Outside a submit transaction, the machine's claim follows the document: `draft-changed` carries the leading chip's claim, so deleting or displacing the chip releases the claim and a history restore re-enters claimed. A failed command submission settles to the same rule, so it returns to claimed exactly when a chip still leads; a claim adjudicated from typed text at Enter has no chip and returns to plain.
- Node transforms keep the chip on the leading seat. A chip with a preceding sibling or inside a later block becomes its literal token, which releases the claim as typing before the old token did. The chip's own transform sees sibling insertions and moves between blocks; a paragraph transform sees a block inserted before the chip's block, so no update walks the whole document.
- Deletion takes two steps. A character deletion that reaches the chip from a collapsed caret marks it selected (`data-selected` on its host; the root's `data-composer-chip-selected` hides the caret), and the next deletion in the same direction removes it whole. Deletions are decided both on the character-deletion command and on deletion input events, because iOS applies a ranged `deleteContentBackward` without that command. A key whose dispatch produced no character deletion, a click, blur, or a caret that leaves the chip clears the mark, so platform deletion shortcuts such as macOS Ctrl+H keep it. The editor selection stays a collapsed range and `isKeyboardSelectable()` stays false for the reason recorded on reference chips. Escape still does not release a claim.
- The persisted draft records the leading chip's claim token (`DraftSnapshot.command`), never the claim. On restore the input asks the trigger pipeline's `resolveClaim`, which polls the optional source hook `matchClaim`: it awaits the source's catalog and answers only a claim, never invoking or executing the command, unlike Enter's `matchEnter`. The chip is rebuilt only at the revision the restore produced and merged into the seed's history entry; an earlier edit, an unclaimed token, or a catalog failure keeps the literal token, which Enter still adjudicates.
- `claim-decor.ts` and the text-reference precedence rule are deleted.

The `slash/input-*` events, `CommandClaim`, `InputState.claim`, and trigger sources keep their fields. `CommandClaim.token` still ends with the separator, and command arguments are still read from the clipboard text after it.

## Alternatives considered

**Keep literal text and repair each gesture.** Every gesture that reaches the boundary node needs its own proof, as #5480 showed, and the precedence rule with text references remains.

**Reuse `ReferenceChipNode`.** Reference chips are occurrences serialized through their owner codec at submit; a command is not model content and must not enter `occurrences`.

**Put the separator inside the chip text.** Lexical appends a managed line break after an inline decorator that ends its block, so the blank-arguments hint rendered by `p:last-child::after` would move to the next line. A separate text node keeps the hint on the chip's line.

**Select the chip with a NodeSelection.** The plain-text binding's arrow, typing, and deletion handlers ignore non-range selections, so each of those gestures would need its own handling at the chip.

**Keep claims in a shell map keyed by NodeKey.** The map duplicates the field the node already carries and needs pruning whenever history is cleared.

## Consequences

- Backspace no longer edits the command name character by character to reopen the menu. At the chip's edge, two Backspace or Delete presses remove the chip and leave the arguments as plain text.
- A reload restores the chip after the command catalog loads; until then, and when restoration does not apply, the draft shows the literal token.
- Whole-chip deletion through a real key event is observable only in the browser lane because jsdom lacks `Selection.modify`; `lifecycle-chrome.e2e.ts` pins the separator, select, and delete presses.
