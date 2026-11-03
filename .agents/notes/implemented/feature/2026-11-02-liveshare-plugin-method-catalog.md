# Agent Note: LiveShare plugin method catalog

Status: implemented

English | [中文](2026-11-02-liveshare-plugin-method-catalog.zh.md)

## Problem

LiveShare used to expose plugin endpoints through a declaration API. The API let a plugin name arbitrary endpoints, so a catalog mistake could widen a viewer's reach without a corresponding Gateway check. The replacement needs one source of truth that says which plugin methods a share may expose.

## Decision

The catalog is enumerated from the Typert local registry at runtime. One entry is emitted per bundle, using the bundle's localized title when available and the component package title otherwise. Endpoint descriptions come from the registered Remote descriptors. A share stores only method-level policies: the Host intersects each policy with the catalog before the Gateway dispatches a call.

The catalog excludes the DSH core bundles. Their methods remain governed by the existing Session and Workspace sharing roles, not by plugin permissions. The core bundle names are derived from `PROFILE_TEMPLATES`, so the exclusion follows the shipped profile composition instead of a second hand-maintained list. LiveShare's own bundle is excluded because it is the sharing implementation, not a capability a share can grant itself.

## Alternatives considered

Keeping the declaration API would leave two sources of truth: a plugin-declared endpoint and the Gateway's own classification. A hand-maintained allowlist in LiveShare would drift from the shipped profile templates. Deriving the exclusion from the actual profile templates keeps the catalog aligned with composition without a second list.

## Consequences

A method that is not in the Typert local registry cannot be selected or called through plugin permissions. A plugin that uses an owner-only exact route is absent from the catalog; the viewer sees an `owner-route-not-shared` notice when it calls that route. Adding a shareable method is therefore a plugin-side registration decision, not a LiveShare catalog edit.
