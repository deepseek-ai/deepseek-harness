# Agent Note: Last-tab close rules on the Sidebar's docked surface

Status: implemented

English | [中文](2026-09-08-sidebar-last-tab-close-rules.zh.md)

## Problem

The settle planner guarantees the docked surface is never empty: closing the last tab reseeds the current default page. That guarantee made the last tab's close control a dead end in both directions. Closing the guide standing alone put the same guide straight back — a control that does nothing. Closing any other lone tab left the user with a column showing only the default page — after "close the last thing", an expanded panel with nothing in it is not what the gesture meant. The guide's chip also drew a hover capsule and a context menu whose only item was that no-op close.

## Decision

The docked surface's last tab carries one rule, decided in the Sidebar store's `closeTab` and mirrored to the kit through a new `canCloseTab(tabId)` control-policy prop (joining `canSplit` and `canAddTab`): the guide standing as the only docked tab is unclosable — no chip close control, no menu close item, and a programmatic close records nothing; any other lone tab closes together with the column in one history entry, resets fullscreen to push mode, and leaves the layout empty until the next expansion seeds the then-current default page. `soleDockedTab(state, tabId)` in [stores.ts](../../../../packages/client/ui-sidebar-right/src/client/stores.ts) names the condition; floating panels take no part in it. Per the packages rule "enforce a decision in the operation that makes it", the store's `closeTab` is the enforcement and `canCloseTab` only mirrors it into the chrome. This rule supersedes the close-protection part of [the default-page decision](2026-09-08-sidebar-default-pages.md); its selection rule remains active.

Two kit-side presentation rules complete it in [TabPanel.tsx](../../../../packages/client/ui-dockkit/src/components/TabPanel.tsx) and [TabMenu.tsx](../../../../packages/client/ui-dockkit/src/components/TabMenu.tsx): a pane's lone chip whose close is withheld draws quiet — no capsule, no hover fill — since there is nothing to select against and nothing to do to it; and a menu that would hold no item at all produces no visible popup, so a secondary press on such a chip shows nothing rather than an empty box.

## Alternatives considered

**Keep the guide closable and let settle reseed it.** The visible result is a close control that does nothing; the control lies about what a press will do.

**Hide the close in the Sidebar's renderer instead of a kit prop.** The kit draws the chip's close and the menu's close item, so the embedder cannot withhold them without a seam; a CSS override would leave the menu item live and split one decision across two owners.

**Collapse the column from the kit when the last tab closes.** The kit has no concept of the column or its expansion; the collapse is the embedder's intent, recorded by the store alongside the close in the same entry.

## Consequences

`canCloseTab` is a third control-policy prop every embedder may set; leaving it out keeps every tab closable. The quiet-chip and empty-menu rules are unconditional kit behavior keyed on the same policy, so any embedder withholding a lone tab's close gets the same presentation. Reopening the column after a lone-tab close shows the default page selected from the current guide entries. Kit specs cover the withheld control, the quiet chip, and the self-dismissing menu; Sidebar unit specs cover `closeTab`'s refusal and the close-with-column entry; a [browser case](../../../../apps/web/tests/sidebar-right.e2e.ts) walks the whole rule on the rendered panel.
