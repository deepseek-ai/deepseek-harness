# Agent Note: Keep experimental packages outside the default product

Status: implemented

English | [中文](2026-09-12-default-product-experimental-isolation.zh.md)

## Problem

Public npm availability does not make an experimental package part of the default product. Direct manifest checks miss dependency aliases, transitive installation paths, runtime imports declared only for development, and plugins loaded by configuration. The release smoke installs every tarball together, so the presence of experimental packages in its consumer directory does not identify what the default product requires.

## Decision

[`verify-default-product-isolation`](../../../../scripts/verify-default-product-isolation.ts) runs in static CI and package hygiene. It follows runtime dependencies, optional dependencies, and peers from every app and the Python runtime, resolves workspace and npm aliases, and identifies experimental packages by their npm prefix or repository directory. Publication denylist membership has no effect on this classification.

The source check also reads runtime imports in the selected packages, installation-owned profile bundle lists, bundle patches, shipped agent presets, and declared configuration trees. It loads the default Web layers with the production patch parser and composes them with the same patch engine used at boot. The effective rows and patched Include trees are checked, so an id-only patch cannot hide a replacement group's plugins. Disabled plugin rows remain checked; ordinary plugin configuration data is not interpreted as another Loader entry list. Missing default roots fail the check.

The default Web source graph starts at the module scripts in its actual HTML entry, including inline modules and locally referenced Worker entries. The separate experimental preview can exist without joining this graph. Importing it from the default entry fails the check. Source references to Cordis configuration files include the Desktop patch in the same proof.

The [Host startup smoke](../../../../apps/cli/tests/profiles/web/tests/web-default-isolation.expected.e2e.ts) launches the real Web profile from built `dsh` exports in a private Harness home. Its test-only observer reads actual Loader rows, registered fibers, modules associated with registered callbacks, and Node's loaded-module cache after readiness. The [Chromium smoke](../../../../apps/web/tests/default-product-isolation.e2e.ts) boots the delivered page and reads the actual Client Loader, registry, and module cache, requiring every delivered entry to be active. Both checks reject a real experimental plugin mounted by their explicit negative-control command. The existing expected-output and Web CI lanes own these tests after the complete build.

Build-time input checks cover both browser bundling stages. The [client preset](../../../../packages/client/tsdown.client.ts) rejects experimental inputs in non-experimental outputs before their original paths disappear inside `lib/client.js`. The [Web graph check](../../../../scripts/web-product-bundle-isolation.ts) follows actual Vite output edges from `index.html`, including lazy chunks, workers, CSS dependencies, and assets. The separate preview remains outside the product graph. The build fails when required module or asset input records are missing; a failed Web build cannot produce a successful complete client-build record. The notices generator uses an explicit analysis marker for its partial graph; that marker requires output writing to be disabled. Other in-memory product builds retain the checks.

[`verify-packed-install`](../../../../scripts/release/verify-packed-install.ts) follows the installed dependency graph from `@deepseek-ai/dsh`, using resolved manifest names to detect aliases and external transitive dependencies. Development dependencies and unrelated tarballs installed beside the product are excluded. Missing required dependencies fail; omitted optional dependencies remain allowed unless they name an experimental package.

This check enforces the existing [experimental dependency isolation rules](../architecture/2026-08-18-experimental-agent-teams-packages.md). The [publication policy](2026-09-12-experimental-publication-denylist.md) independently determines which experimental packages explicit consumers may install.

## Alternatives considered

**Check only direct dependency names.** Aliases, runtime source imports, and configuration-loaded plugins can bypass that check.

**Reject every installed experimental tarball.** The release smoke intentionally installs the whole release family, including opt-in packages. Only the default entry's dependency graph answers whether those packages ship as product requirements.

**Scan every Web source as a default entry.** This would reject the separate experimental preview even when the default HTML and runtime imports never reach it.

**Check only the final Vite module paths.** A stable `lib/client.js` path can contain code bundled earlier from an experimental package. Each bundling stage must check its actual inputs.

## Consequences

Experimental packages may publish without joining default installations or compositions. Source, effective composition, build-input, installed-dependency, and runtime-registry checks provide independent evidence. The SDK's [source-launch compatibility patch](../../../../apps/cli/src/sdk-source.cordis.patch.yml) is selected by a computed filesystem path and is outside static configuration discovery. Runtime smokes observe startup and Client activation; they do not replace tests for every later user-triggered execution path or for explicitly installed profile extensions.
