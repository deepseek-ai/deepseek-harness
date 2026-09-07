# Agent Note: Web details follow the current Session lifecycle

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-29-web-details-session-lifecycle.zh.md)

## Problem

The details entry is Session-scoped, but its preferred grid width is root-scoped. Selecting a different Session replaced the details content without closing that root preference, so the new owner inherited stale viewing geometry. Hero and other unselected states render no Session-scoped details; they need a derived zero track without becoming false owners in the comparison.

## Decision

`AppFrame` reads the current Session id and its `blank` summary flag from the authoritative Session projection. It records the last non-blank selected id only when that Session can own details, so hero and other unselected states neither trigger closure nor replace the last Session owner; their rendered details track derives as zero without changing the stored preference. The first Session preserves the layout store's initial preference, whose [archived visibility-default decision](../../archived/bug-fix/2026-07-30-web-details-default-closed.md) chose closed; returning to the same Session restores its current width, and selecting a different Session closes the root-scoped details preference through the layout store before paint. The per-Session chat selection remains owned by the session-scoped store described by the [slot system standard](../architecture/2026-07-22-slot-type-chain-implementation.md).

The layout store is transient and starts details closed. It neither reads nor writes `localStorage`, so reload restores the sidebar default and details closed and needs no Session-baseline exception. Manual close and reopen inside one unchanged Session retain their existing behavior. The lifecycle effect changes neither the [Workspace-owned New Session flow](../feature/2026-07-25-workspace-ui-product-flow.md), composer drafts, Session navigation, nor concession-chain resizing.

## Alternatives considered

**Close details in the New Session click handler.** Rejected because an unselected surface has no Session-scoped details and must not mutate geometry. Closure belongs to the later comparison between two defined Session owners.

**Persist panel geometry per Session.** Rejected because the product contract needs stale context removed, not a new map of remembered widths. Per-Session geometry would also reopen details when users return, contrary to the chosen close-on-leave behavior.

**Preserve persisted layout after the Session baseline is ready.** Rejected because it duplicates startup lifecycle in a presentation component solely to validate stale viewing state. Transient defaults make reload deterministic without a readiness flag.

**Treat every current-projection change as a Session switch.** Rejected because startup materialization, hero, clearing selection, and invalidation are not transitions between two Session owners.

## Consequences

Details starts closed, including when the first Session materializes. An explicit open action uses the contract default width. Switching to a different Session forgets a dragged details width because close writes zero and reopen uses that default. Unselected states derive a zero rendered track while leaving the preferred geometry unchanged; returning to the same Session through one of those states restores its width. Reload forgets sidebar geometry and restores details closed. The layout behavior test covers initial defaults, first materialization, direct and hero-mediated Session switches, same-Session return, and the absence of layout storage; the keyless browser e2e drives the same owner transitions through the shipped composition while checking the full grid track and browser errors.
