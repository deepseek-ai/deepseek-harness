# Agent Note: Web composer shared width axis and control-row polish

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-04-web-composer-shared-width-axis.zh.md)

## Problem

The web conversation column sized each surface independently: the transcript column, the input card, the todo/goal/queue dock cards, and the ask-question/approval/plan-review takeover cards each carried their own hardcoded max-width (736/752/776/800px variants) and their own side paddings. The surfaces drifted a few pixels apart at full width and diverged further on narrow viewports, where some panels kept clearance from the screen edge and others went flush. Separately, the composer's control row had no adaptive behavior — on a narrow card the permission trigger's label squeezed the row — and the overlay menus anchored to the card could render wider than the card itself, painting past its right edge.

## Decision

One content width variable owns the whole column. `--dsh-chat-content-width` (748px) is declared on ConversationRoot's `.root` — the transcript and the composer seat are sibling subtrees, so the declaration must sit on their common ancestor for CSS custom-property inheritance to reach both. Every other geometry derives from it: the input card caps at `content + 32px` (`--dsh-composer-card-max-width`), the dock cards subtract four dock insets (4 × 8px) from the card and land back on the content width, and the takeover cards use the content width directly. The narrow-viewport invariant is expressed structurally, not numerically: content-width surfaces pad `calc(var(--dsh-composer-side-clearance) + 16px)` per side while the input card clears the bare clearance (16px), so "input card = content + 32px" holds at every viewport width, not just at the cap.

The control row inside the card is a `container-type: inline-size` container, and the permission trigger drops its text label (keeping glyph + chevron) under a 460px container query. The query is anonymous on purpose: CSS modules hash `container-name` per module, so a name declared in InputBar's sheet can never match a query written in PermissionSelect's sheet — the two hashed names silently differ and the query never fires. Only triggers that carry a mode glyph collapse (`:has(.triggerIcon)`); a host-configured mode without one keeps its text as its sole identifier.

Overlay menus anchored to the card (slash menu, command popupSelect) clamp to the anchor's width (`max-width: min(<design cap>, 100%)`), truncating long rows with ellipses instead of overflowing the card. Tooltip bubbles keep a 12px viewport-edge safety margin in the clamp (ui-primitives Tooltip).

## Alternatives considered

**Keep per-surface widths and align the numbers by hand.** Rejected: the drift this change removes was exactly the residue of hand-aligned constants; any future width change would need five coordinated edits with nothing enforcing the relation.

**Declare the variables on `.composerStack`.** Rejected after trying it: the takeover panels are siblings of the stack in the composer seat and the transcript is a different subtree entirely, so the variables never reached them; the common ancestor (`.root`) is the only correct home.

**A named container query for the label collapse.** Rejected by measurement: CSS modules scope `container-name` per module, so the cross-module name never matched and the query was dead. The anonymous query resolves against the nearest ancestor container, which is unambiguous here (the row is the only container).

**JS ResizeObserver for the label collapse.** Rejected: a container query is declarative, needs no listener lifecycle, and the 460px threshold is a design choice either way.

## Consequences

Changing the column width is now a one-line edit with the ratio relations preserved by construction, which the 736 → 748 retune already exercised. The cost is indirection: the widths of five surfaces are no longer readable off their own stylesheets and require following the variable chain to ConversationRoot. The container-query collapse adds the constraint that InputBar's row stays a size container; removing that declaration silently disables the permission trigger's adaptive behavior. The anonymous query also means any future second container between the row and the trigger would capture it — if that happens, the query must move or the intermediate container must be avoided.
