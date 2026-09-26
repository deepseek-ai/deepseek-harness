# Agent Note: Compact translucent menu surfaces

Status: implemented

English | [中文](2026-09-17-compact-translucent-menu-surfaces.zh.md)

## Problem

Shared dropdowns and feature-owned menu panels used the same elevated color token but retained unrelated padding, row height, corner radius, and scrollbar geometry. The opaque menu fill also made nested and portalled surfaces read as solid cards rather than one elevation family, while narrowing individual menus locally would keep those differences distributed across packages.

## Decision

`ui-theme` defines `--dsw-specific-menu` as a translucent light or dark fill and defines `--dsw-menu-backdrop-filter` as `blur(40px) saturate(150%)`. Every elevated package surface that paints the menu fill also applies that backdrop filter, uses `border: 0`, and takes an elevation shadow with its rebindable hairline stroke. A surface containing fixed-position overlays paints the fill and filter on an isolated background pseudo-element, because a filtered ancestor would otherwise change those overlays' containing block. Descendant sticky rows may repaint the inherited fill without another filter. Browsers without backdrop filtering still render the theme-owned translucent fill.

The shared `Menu` and the composer input-trigger menu use the same compact baseline: a 16px outer radius, 3px frame padding, 34px ordinary rows, 13px primary text on a 20px line, 6px icon/text gaps, and 8px row radii. Dense and compact variants reduce from that baseline instead of retaining the former ordinary geometry. The composer menu keeps its feature-owned grouping and 400px height cap; its aliases and descriptions use 12px text on an 18px line.

The global WebKit scrollbar width is 5px. The composer menu overrides it with a 6px draggable rail and a 2px visible thumb through the existing scrollbar geometry variables; Firefox continues to use its standard thin scrollbar path. Track insets and elevated l2 thumb colors remain surface-owned rebindings.

## Alternatives considered

**Keep an opaque shared menu fill.** Rejected because every consumer would need a separate translucent override to share one material, recreating the theme branch outside `ui-theme`.

**Compact only the composer command menu.** Rejected because the shared `Menu` renders the same action, settings, and navigation vocabulary; keeping its former 40px rows would preserve two densities for the same control family.

**Use the 6px padded rail for every scrollbar.** Rejected because ordinary scroll regions need the direct 5px thumb, while the command menu needs a wider hit area around a visually quieter thumb. The existing geometry variables express that difference without another scrollbar implementation.

## Consequences

Elevated menu-fill consumers must pair the fill and backdrop-filter tokens in the same rule, either on the surface or on its isolated background pseudo-element; the stylesheet gate rejects a material layer that omits the filter. Shared menu geometry changes affect every `Menu` render site, while the composer menu retains its own content and interaction rules. Browser and component snapshots cover assembled structure, and theme specs pin the tokens, compact metrics, scrollbar geometry, and complete menu-filter pairing.
