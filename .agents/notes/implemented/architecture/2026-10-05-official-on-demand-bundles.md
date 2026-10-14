# Agent Note: Discover Official bundles without installing their runtimes

Status: implemented

English | [中文](2026-10-05-official-on-demand-bundles.zh.md)

## Problem

Native subagent integrations bring their own runtimes. Shipping those dependencies with every DSH installation charges that cost to people who never delegate to them, while requiring a package name hides the integrations from the Plugins page.

## Decision

`ON_DEMAND_BUNDLES` admits the Claude Code and Codex bundles to an installation-owned catalog. The catalog embeds their package-owned localized metadata and icons, so discovery works offline without resolving or importing either package. Official identifies project maintenance; optional delivery and experimental maturity remain independent properties.

Selection uses the ordinary third-party bundle installer, profile dependency, Host row patches, compatibility evaluation, progress, cancellation, registry fallback, and build-script approval. Native authentication and configuration remain provider-owned.

The running installation owns the target. Published applications offer the exact DSH release version and save an exact registry dependency pin. Source Web and development Desktop offer ordinary `link:` dependencies into the same checkout as the running CLI, using its prepared workspace dependencies and peers. The source target follows the actual installation, never the current working directory or a prerelease suffix; an incomplete checkout does not fall back to the registry. A development checkout can share a version string with different published code, so replacing an installed registry copy or another checkout’s link compares the source as well as the version. Replacement is explicit, preserves selection, and reports required restarts; startup does not download providers. [Plugin Manager](../../../../packages/boot/plugin-manager/README.md#use-this-package) owns the operational details.

Every Official package remains in the DSH release family. Packed DSH dependencies, optional dependencies, and peers use the exact family version. Publication prerequisites place catalog packages before the DSH package advertising them without adding their runtimes to DSH production dependencies. Catalog verification rejects missing metadata, unsupported membership, and stale generated content.

The [shipped optional-bundle policy](../process/2026-09-15-shipped-optional-bundles.md) still owns lightweight installation-provided bundles. The [optional-composition decision](2026-09-21-experimental-capabilities-as-optional-bundles.md) owns shared patch behavior and global optional tools. Native bundles insert ordinary Host rows, so any profile can select them; profiles that keep the package without its bundle mount the same rows explicitly. The [identity compatibility decision](2026-10-06-web-desktop-plugin-identity-compatibility.md) owns retained names, selectors, and deferred naming cleanup.

## Alternatives considered

**Ship the native runtimes with every installation.** This makes first activation offline, but increases the default download for unused integrations.

**Query the registry to build the discovery list.** This avoids embedded metadata, but makes discovery depend on network availability and does not bind the offered package version to the running application.

**Give Official packages a separate installer or activation registry.** A second path would duplicate package-operation and profile-composition behavior. Installation-owned discovery data can reuse the existing third-party mechanisms.

**Always install the registry package with the running version.** Version equality identifies a published release, but cannot identify unreleased source changes. It can deliver an older provider API and a provider-only patch to a development Host that expects current tool contributions.

**Build a separate development registry or artifact cache.** Ordinary local links already keep provider code and its dependencies in the running checkout. A second delivery system would add lifecycle and invalidation work without improving that development promise.

## Consequences

Registry delivery requires a reachable registry; development delivery requires a prepared, built checkout and normal rebuild/restart discipline. Equal source version strings do not certify identical build outputs. Off only deselects; Remove remains separate and refuses while the bundle's rows are in use. Activation failure can retain the saved dependency and selection; there is no rollback. Offline metadata, release pins, source-target selection, same-version source mismatches, clean installed artifacts, and release ordering have dedicated checks. Native-provider authentication is not part of catalog discovery.
