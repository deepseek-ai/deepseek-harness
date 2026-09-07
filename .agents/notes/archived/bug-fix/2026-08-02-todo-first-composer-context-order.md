# Agent Note: Todo-first composer context order

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-02-todo-first-composer-context-order.zh.md)

## Problem

The composer context stack rendered Goal before Todo even though the Harness design orders the current task plan before its ongoing goal and pending Queue. Todo also used the Queue wrapper's 776px width as its visible card width, while Goal and the Queue panel rendered on the shared 752px card column. The result inverted the intended information hierarchy and left Todo wider than both adjacent panels.

## Decision

The `conversation.input.dock` list uses one ascending product order: Todo at `0`, Goal at `10`, and Queue at `20`, followed by the composer bar outside the list. Registration order remains the semantic source of truth; the renderer does not hardcode known component ids or repair their order with CSS.

Todo, Goal, and the visible Queue panel share the 752px card column inside the 800px composer cap. Queue retains a 776px wrapper with 12px transparent inset on each side because that wrapper owns the composer overlap. Todo is a standalone card rather than a wrapper, so its responsive width and maximum width subtract both inset layers directly. Goal uses the same responsive column and caps its inner bar at 752px, preserving matching edges below the desktop cap.

The [composer stack contract](2026-07-30-composer-context-stack-order.md) continues to own inter-card spacing and Queue's exclusive overlap with the composer. This decision supersedes only that note's Goal-first order.

## Verification

Todo and Goal registration tests pin orders `0` and `10`; Queue remains pinned at `20`. The keyless Queue browser scenario renders all three panels concurrently, records their Todo–Goal–Queue accessibility order, and compares their visible bounding boxes at the 1680px desktop baseline and a 640px sub-cap viewport before exercising Queue mutations.

## Alternatives considered

**Reorder the known panels inside `ConversationRoot`.** Rejected because `conversation.input.dock` is an extensible ordered list; a hardcoded component inventory would make plugin activation order and rendered order disagree.

**Use CSS `order` to move Todo visually.** Rejected because accessibility and keyboard order must match the visual hierarchy, and the slot ledger already owns semantic order.

**Keep Todo at the Queue wrapper width.** Rejected because the Queue wrapper's transparent inset is layout infrastructure for its composer overlap, not part of the visible panel column.

## Consequences

The standing task plan appears before the ongoing goal, pending Queue work remains closest to the composer, and all three visible cards share one horizontal edge. Future input-dock plugins choose an explicit position relative to Todo `0`, Goal `10`, and Queue `20`; only Queue owns the terminal wrapper overlap.
