# Agent Note: API extractor reports

Status: proposed

English | [中文](2026-06-11-api-extractor-reports.zh.md)

> The doc-block-typechecking and event-taxonomy parts shipped ([doc-sync enforcement](../../archived/process/2026-06-11-doc-sync-enforcement.md)); this remaining API-report part is deferred as a standalone proposal.

## Problem

Public API changes are invisible — nothing makes "this commit changed the public API" an explicit, reviewable fact. A reviewer reading a diff can miss that an exported type gained a field or a method signature shifted.

## Proposal

api-extractor (or `tsc --emitDeclarationOnly` + a normalized public-API dump) producing a checked-in `etc/<pkg>.api.md` per package; CI fails if regeneration differs. Every public-API change becomes a diff line a reviewer (or review agent) must see.

## Alternatives considered

**`tsc --emitDeclarationOnly` plus a normalized public-API dump** — the lighter mechanism if api-extractor proves too heavy; either satisfies the checked-in, diffable report shape the proposal needs.

## Acceptance criteria

- Every package has a checked-in `etc/<pkg>.api.md`; CI fails when regeneration differs from the committed report.
- A public-API change (a new export, a widened field, a shifted signature) is visible as a report diff line in review.

## Risks

The dependency is heavy and finicky — the reason this was deferred — and the report format churns with compiler upgrades, adding a maintenance burden that buys little while the packages stay unpublished.

## Why deferred

Deferred when doc-sync landed: low value for an internal monorepo where reviewers already see the source diff, and a heavy, finicky dependency. Revisit if the packages are ever published externally — at that point a stable, diffable public API earns its keep.

The packages are now published to npm, so the revisit condition holds. The [stable API policy](2026-11-05-stable-api-policy.md) proposal replaces the per-package reports with one report covering exports, services, and events, and adds stability levels and per-seam versions; its acceptance criteria apply if it is accepted.
