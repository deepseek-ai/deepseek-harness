# Agent Note: Workspace dependency release ranges

Status: implemented

English | [中文](2026-09-22-workspace-release-ranges.zh.md)

## Problem

DSH packages share one product release. Cordis, its vendored libraries, and Node Addon System have independent releases; consumers need their patch updates without automatically accepting a new minor version.

## Decision

Every workspace consumer uses `workspace:*` for DSH targets and `workspace:~` for targets under `vendor/` or in the `native/system` package family. This includes root tooling, apps, peers, development dependencies, and the native entry's optional platform dependencies. Directory placement never exempts a consumer.

Packing substitutes the target package's current version: `workspace:~` becomes `~4.0.3` for Cordis at `4.0.3` and `~0.1.2` for Node Addon System at `0.1.2`. DSH references remain exact. Native family members still share one release version, while an installed entry may resolve a later platform patch.

This range policy refines [npm release sequences](2026-08-10-npm-release-sequences.md) and [published dependency faces](2026-08-26-published-dependency-faces.md). Their independent release families and dependency-section classification remain unchanged.

## Alternatives considered

**Caret vendor ranges.** For stable packages such as Cordis, caret ranges also admit later minor versions.

**Exact vendor and native ranges.** Exact ranges require a consumer declaration change to admit each patch release.

## Consequences

Vendor and native patch releases must preserve their consumer-facing APIs and binary interfaces. Local workspace linking and lockfile resolutions remain unchanged by the range conversion. The workspace gate rejects DSH tilde ranges and vendor/native caret or exact ranges; packed-manifest tests check the emitted versions.
