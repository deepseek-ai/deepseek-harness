# Agent Note: Context menu contributions

Status: implemented

English | [中文](2026-10-21-context-menu-contributions.zh.md)

## Problem

Session and tab menus already accept React Slot entries. Reusing only those entries would require external plugins to supply React components and would leave action discovery, target capture, and cancellation coupled to each trigger.

## Decision

[Context menus](../../../../packages/client/ui-context-menu/README.md) own typed target families, contribution resolution, and callback lifetime. Feature plugins register actions through the same service available to external Client plugins. Plain presentation fields let a renderer consume resolved actions without loading contributed React components. Existing Session and tab Slots remain in feature-owned adapters, preserving those extension positions.

[File actions](../../../../packages/client/ui-file-actions/README.md) own original-content transfer separately from menus and image components. Saving retains original encoding; clipboard interoperability may require PNG conversion. A browser download supplies no local path, so reveal requires a verified Host file or the destination returned by a native save.

The menu plugin contributes `useContextMenu` through the existing Slot root binding. Its ordinary `getTriggerProps` factory centralizes DOM gestures while business owners still provide captured targets. Plain children receive props or existing delegates; a separate React Context or utility package would duplicate the established lifetime and injection mechanism.

## Alternatives considered

**React Slots alone.** They preserve arbitrary visual content but cannot supply a presentation-independent action model. They remain available for existing component contributions.

**A central switch over built-in target kinds.** It would make each new plugin-owned target require changes to the menu implementation. Declaration merging and registered providers instead keep target-specific behavior with its owner.

**Native menus first.** It would duplicate the existing keyboard, placement, and dismissal implementation while excluding component-only legacy entries. The shared Web renderer serves Desktop too; another renderer can consume the plain action view independently.

## Consequences

An opening captures its target and contribution set. Dismissal cancels metadata work; unloading withdraws that provider's actions. Selected actions own execution and must recheck mutable resources. Legacy React entries are absent from plain-data resolution, so native rendering cannot assume complete parity. These lifetimes are covered by registry tests; browser scenarios cover unchanged selection, original bytes, and nested-overlay dismissal.
