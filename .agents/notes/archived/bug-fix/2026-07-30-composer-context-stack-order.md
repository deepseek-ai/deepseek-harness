# Agent Note: Composer context stack order

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-30-composer-context-stack-order.zh.md)

## Problem

Goal, Todo, and Queue contribute independently to the same `conversation.input.dock` list, but their registration order and spacing rules did not encode the composition matrix. The renderer therefore placed Todo before Queue and Goal, while both Queue and Goal carried negative margins intended for the composer boundary. When all three were present, Queue joined to Goal and Goal joined to the composer, reversing the design's hierarchy.

## Decision

The [Todo-first alignment decision](2026-08-02-todo-first-composer-context-order.md) owns the current ascending order. This note retains the stack contract around that order: numeric gaps leave room for future entries to declare their intended position without relying on plugin activation order, and the composer bar follows the list.

`ConversationRoot` owns the 6px space between independent context cards. Goal is a standalone 752×36px card and collapsed Todo is a standalone 752×44px card. Queue is the terminal dock entry: its 776px wrapper contains the same 752px panel column and subtracts the shared gap plus a named 5px layout overlap, so the later composer card paints over only the queue edge. Empty entries render null and consume no gap.

The order and overlap are separate contracts. Registration order establishes semantic hierarchy; CSS variables on the stack establish shared geometry. Queue does not infer that it may overlap merely from being the last visible entry, because Goal or Todo can be the last visible context card when no queue exists and must remain separated from the composer.

## Verification

Registration tests pin all three order values. The keyless Queue browser scenario renders Todo, Goal, and Queue together, pins their accessibility order, and checks their visible card edges; focused Goal and Queue scenarios cover their independent states.

## Alternatives considered

**Keep independent negative margins on Goal and Queue.** Rejected because the affected neighbor changes with slot order; a local margin cannot express which relationship is allowed unless the semantic order is also fixed.

**Render each known dock id separately in `ConversationRoot`.** Rejected because it turns an extensible list slot into a hardcoded component inventory and forces the owner to change for every new registrant.

**Tuck whichever dock entry is last.** Rejected because Goal and Todo are standalone cards. Their absence matrix must not change the surface semantics of whichever card remains.

## Consequences

The visual hierarchy is stable for every presence combination, and Queue is the only context surface joined to the composer. New input-dock plugins must choose an order relative to Todo `0`, Goal `10`, and Queue `20`; an entry after Queue also requires an explicit decision about which surface owns the composer boundary.
