# Agent Note: Registry bundle updates

Status: implemented

English | [中文](2026-10-14-registry-bundle-updates.zh.md)

## Problem

Third-party bundles installed from a registry had no update path. The plugin page offered **Update** only for Official bundles, whose target is the running DSH version, so a person learned of a newer third-party release outside DSH and replaced it by uninstalling and installing again. With HMR an install over an installed package is refused, and a manual removal followed by a failed installation leaves the plugin uninstalled.

## Decision

**Versions are read through `pnpm view` in the profile directory.** `listVersions` runs `pnpm view <name> versions time dist-tags` over the same registry plan as `inspect`, so the `.npmrc` chain, proxy, and authentication that the installation uses also decide what the list shows, and a registry that cannot be reached moves the lookup to the next one. pnpm prints a range lookup as its highest match only, so each listed version takes its own `pnpm view <name>@<version> name version engines peerDependencies deprecated dsh` on the registry that answered. `versionListLimit` bounds how many newer versions are read and `versionLookupConcurrency` bounds the subprocesses in flight. Compatibility reuses `evaluatePluginCompatibility` with the profile's exemptions, so the list and the installation judge peers the same way.

**The Host owns the update and its recovery.** `updateBundle` views the target first and refuses a missing version, one that declares no bundle, or one whose `engines.dsh` or DSH peers reject the running version before anything changes. With HMR it then calls `removeBundle` and `installBundle(name@version, { saveExact, registry, enabled })`; when that installation fails, is cancelled, or installs but cannot start, it removes a target that stayed and installs the removed version again from the registry it came from, else over the configured plan. The reinstallation carries no request id, so a cancellation of the update cannot stop it. Without HMR it installs over the running version, which `installBundle` allows there and reports as `restart-required`. `plugin-manager/update-state` announces each step for the dialog's progress list.

**Eligibility is a listed fact.** `BundleInfo.updatable` marks a third-party profile dependency saved as a registry spec under its own name and not as an `npm:` alias, with a semver version and no plugin management; the page shows the Versions section only for those, and both methods refuse every other bundle. The `plugin_manager` tool, which has no update action, omits the field.

**Updates only move forward.** The page lists versions newer than the installed one and `updateBundle` refuses any other, so an update never asks a plugin to read data a newer version wrote.

## Alternatives considered

**Fetch the abbreviated packument over HTTP.** One request returns every version's `peerDependencies` and `deprecated`, but the Host would have to resolve registry, scope, authentication, and proxy settings from the `.npmrc` chain itself and keep that resolution identical to pnpm's. A list from a registry pnpm would not install from shows versions that cannot be installed.

**`pnpm outdated`.** It reports current, wanted, and latest only, judges no DSH peers, and with exact saves wanted equals current.

**Orchestrate removal and installation in the browser.** The Official update did so. A browser that closes or loses its connection between the two calls leaves the package removed with nobody to reinstall it, and the target check before removal would be a second, bypassable copy of the Host's rule.

**List versions while reading bundles.** `listBundles` is offline; adding registry lookups would make opening the plugin page a network operation with one subprocess per version.

## Consequences

- Checking a package costs one `pnpm view` plus one per listed version, each bounded by `inspectTimeoutMs`.
- A target saved by an update, and a reinstallation after a failed one, are exact versions even when the profile had saved a range; with HMR the bundle joins the end of the selection.
- Removal and installation take the profile lock separately, so another operation can run between them; an installation that rejects, for example on a lock timeout, still triggers the reinstallation.
- A version whose dependencies need a new build-script approval fails to install and is reinstalled at the previous version; its scripts are approved through an ordinary installation.
- A reinstallation that also fails leaves the package uninstalled, and the dialog says so.

## Verification

| Coverage | Location |
|---|---|
| Listing, registry fallback, refusals, compatibility, prereleases, deprecation, and the version limit | `packages/boot/plugin-manager/tests/manager.spec.ts` |
| Update through removal and installation, reinstallation after a failed, cancelled, or rejected target, a failed reinstallation, refusal before any change, removal failure, and the no-HMR path | `packages/boot/plugin-manager/tests/manager.spec.ts` |
| `pnpm view` answer parsing | `packages/boot/plugin-manager/tests/versions.spec.ts` |
| Version checks, update state, and step progress in the store | `packages/client/ui-plugin-manager/tests/manager-store.client.spec.ts` |
| Versions section, toolbar check, and every update outcome | `packages/client/ui-plugin-manager/tests/components.client.spec.tsx` |
