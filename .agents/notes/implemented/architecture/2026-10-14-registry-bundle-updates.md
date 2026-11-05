# Agent Note: Registry and Git bundle updates

Status: implemented

English | [中文](2026-10-14-registry-bundle-updates.zh.md)

## Problem

Third-party bundles installed from a registry had no update path. The plugin page offered **Update** only for Official bundles, whose target is the running DSH version, so a person learned of a newer third-party release outside DSH and replaced it by uninstalling and installing again. With HMR an install over an installed package is refused, and a manual removal followed by a failed installation leaves the plugin uninstalled. A bundle installed from Git had no update path either: a Git repository publishes no version list, and installing a newer commit from a plugin index over the installed copy resolves the package to another directory, which HMR cannot replace live, so the change waited for a restart and nothing reinstalled the old commit when it failed.

## Decision

**Versions are read through `pnpm view` in the profile directory.** `listVersions` runs `pnpm view <name> versions time dist-tags` over the same registry plan as `inspect`, so the `.npmrc` chain, proxy, and authentication that the installation uses also decide what the list shows, and a registry that cannot be reached moves the lookup to the next one. pnpm prints a range lookup as its highest match only, so each listed version takes its own `pnpm view <name>@<version> name version engines peerDependencies deprecated dsh` on the registry that answered. `versionListLimit` bounds how many newer versions are read and `versionLookupConcurrency` bounds the subprocesses in flight. Compatibility reuses `evaluatePluginCompatibility` with the profile's exemptions, so the list and the installation judge peers the same way.

**The Host owns the update and its recovery.** For a registry copy, `updateBundle` views the target first and refuses a missing version, one that declares no bundle, or one whose `engines.dsh` or DSH peers reject the running version before anything changes. With HMR it then calls `removeBundle` and `installBundle(name@version, { saveExact, registry, enabled, expected })`, where `expected` makes the installation undo itself, modules included, unless it installs `name` at `version`; when that installation fails, is cancelled, or installs but cannot start, it removes a target that stayed and installs the removed version again from the registry it came from, else over the configured plan. The reinstallation carries no request id, so a cancellation of the update cannot stop it. Without HMR it installs over the running version, which `installBundle` allows there and reports as `restart-required`. `plugin-manager/update-state` announces each step for the dialog's progress list.

**Eligibility is a listed fact.** `BundleInfo.update` is `registry` for a third-party profile dependency saved as a registry spec under its own name and not as an `npm:` alias, and `git` for one saved as a Git spec pinned to a full commit, whose reinstallation brings back the removed version; either needs a semver version and no plugin management. The page shows the Versions section only for `registry` bundles, `listVersions` refuses every other bundle, and `updateBundle` refuses every bundle without `update`. The `plugin_manager` tool, which has no update action, omits the field.

**A Git copy updates to a version a plugin index lists, from the repository directory it came from.** A Git repository has no version list, while a plugin index pins each Git version to a commit and a package directory. The `pluginMarket` Host service marks a version with `update` when it is newer than a `git` copy and pins a commit of the same repository and `path:` directory; Discover offers **Update** for it and hands the package, version, and spec to the Plugins page, whose update dialog calls `updateBundle(name, version, { spec })`. The Host requires such a spec for a `git` copy and refuses one for a `registry` copy; `pinnedGitOrigin`, which both services import from `@deepseek-ai/dsh-plugin-manager`, compares origins regardless of the form pnpm saved, because a profile saves the SSH form of an HTTPS repository it cannot read and the `github:` shortcut of a GitHub URL. pnpm reads a Git package only while installing it, so before the removal the Host checks only that the network reaches the target's repository host; an unreachable host would fail the target and the reinstallation alike. A check Git cannot run, or one refused for credentials, is left to pnpm, which installs a public hosted commit as a tarball without Git. The rest is checked during the installation: compatibility as for every installation, and `expected` undoes a target that installs another package or version, or no bundle, before its bundle loads, failing with `unexpected-package` or `not-bundle`. The removed copy is reinstalled from the spec the profile saved, and Discover never installs over an installed copy.

**Updates only move forward.** The page lists versions newer than the installed one and `updateBundle` refuses any other, so an update never asks a plugin to read data a newer version wrote.

## Alternatives considered

**Fetch the abbreviated packument over HTTP.** One request returns every version's `peerDependencies` and `deprecated`, but the Host would have to resolve registry, scope, authentication, and proxy settings from the `.npmrc` chain itself and keep that resolution identical to pnpm's. A list from a registry pnpm would not install from shows versions that cannot be installed.

**`pnpm outdated`.** It reports current, wanted, and latest only, judges no DSH peers, and with exact saves wanted equals current.

**Orchestrate removal and installation in the browser.** The Official update did so. A browser that closes or loses its connection between the two calls leaves the package removed with nobody to reinstall it, and the target check before removal would be a second, bypassable copy of the Host's rule.

**List versions while reading bundles.** `listBundles` is offline; adding registry lookups would make opening the plugin page a network operation with one subprocess per version.

**Read Git versions from repository tags in the Host.** A tag names no package directory in a monorepo and says nothing about the version an index vetted; the plugin index already pins commit, directory, and version.

**Install the newer commit over the installed copy.** It needs no removal, but with HMR the package resolves to another directory, so the live replacement is refused until a restart, and a failed installation reinstalls nothing.

**Check the package name before removing the installed copy.** pnpm reads a Git spec's manifest only by fetching it, and a second fetch before the installation would double the download; checking the installed package inside the run keeps one fetch, and the reinstallation recovers a wrong target.

**Remove a target that installed another package after the installation.** Its bundle would already have loaded and run, and when the other package was an existing dependency, `pnpm add` would have replaced it, so removing it would uninstall a plugin the person kept. Undoing the run with its lockfile restores that dependency too.

**Accept a target from another repository.** Index content is unsigned, and the update dialog carries no trust notice of its own, so any configured index could replace a plugin's code with code from a source the person never chose; a plugin that moved to another repository is uninstalled and installed again, with the install confirmation.

## Consequences

- Checking a package costs one `pnpm view` plus one per listed version, each bounded by `inspectTimeoutMs`.
- A registry target saved by an update, and a reinstallation after a failed one, are exact versions even when the profile had saved a range; with HMR the bundle joins the end of the selection.
- Removal and installation take the profile lock separately, so another operation can run between them; an installation that rejects, for example on a lock timeout, still triggers the reinstallation.
- A version whose dependencies need a new build-script approval fails to install and is reinstalled at the previous version; its scripts are approved through an ordinary installation.
- A reinstallation that also fails leaves the package uninstalled, and the dialog says so.
- A Git target whose commit is missing, that declares no bundle, rejects the running DSH, or installs another package or version is found only after the installed copy was removed; the reinstallation recovers it at the cost of a stop and a second installation.
- A Git copy saved with credentials in its URL is reinstalled from the saved spec without them, so a private repository needs a Git credential helper.
- A Git copy saved with a branch, a tag, or a range, or one whose plugin moved to another repository, updates only by uninstalling and installing again.

## Verification

| Coverage | Location |
|---|---|
| Listing, registry fallback, refusals, compatibility, prereleases, deprecation, and the version limit | `packages/boot/plugin-manager/tests/manager.spec.ts` |
| Update through removal and installation, reinstallation after a failed, cancelled, or rejected target, a failed reinstallation, refusal before any change, removal failure, and the no-HMR path | `packages/boot/plugin-manager/tests/manager.spec.ts` |
| `pnpm view` answer parsing | `packages/boot/plugin-manager/tests/versions.spec.ts` |
| Git eligibility, update through a commit of the same directory, reinstallation from the saved spec, a target that installs another package or version, the no-HMR path with a target without a bundle, an unreachable repository host, and spec refusals | `packages/boot/plugin-manager/tests/manager.spec.ts` |
| Git origin across the forms pnpm saves | `packages/boot/plugin-manager/tests/install-spec.spec.ts` |
| A run undone with its modules when it installs another package, another version, or no bundle where one is expected | `packages/boot/plugin-manager/tests/operations.spec.ts` |
| The connection check of a Git repository on any host | `packages/boot/plugin-manager/tests/github-connection.spec.ts` |
| Git versions of the installed copy's directory marked as updates in an index listing | `packages/boot/plugin-market/tests/market.spec.ts` |
| Version checks, update state, and step progress in the store, including a Git update another tab names | `packages/client/ui-plugin-manager/tests/manager-store.client.spec.ts` |
| Versions section, toolbar check, every update outcome, and a Git target's repository in the dialog | `packages/client/ui-plugin-manager/tests/components.client.spec.tsx` |
| Discover's **Update** on cards and version rows, and no installation over an installed copy | `packages/client/ui-plugin-market/tests/discover.client.spec.tsx` |
