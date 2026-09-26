# Agent Note: Derive Desktop test versions from the complete dsh version

Status: implemented

English | [中文](2026-09-16-desktop-release-version-derivation.zh.md)

## Problem

Replacing a dsh prerelease identifier with the update channel name loses the base release identity and changes SemVer ordering. A date alone cannot distinguish multiple test builds of the same base.

## Decision

The [Desktop release rules](../../../../apps/desktop/README.md#release-versions) preserve the complete dsh base for production and derive dated, indexed test versions from that base. The derived version is [passed to packaging as an argument](2026-09-21-desktop-build-version-as-input.md) rather than written into manifests, and it is derived from the dsh base so another test release cannot append a second date suffix.

The fixed Nightly feed is a distribution address, independent of version derivation. Existing clients continue to use that address with prerelease updates enabled and downgrades disabled. Test distribution does not publish the unsuffixed base. Operators check existing release records and objects before assigning an index.

The installed-update materials decision retains private identities and data isolation. Its Nightly naming examples do not define the test version policy. Historical release receipts and frozen archived records remain evidence of what was actually built.

## Alternatives considered

**Replace alpha, beta, or rc with nightly.** This discards the base prerelease and can sort above its later releases, preventing updates to the intended version line.

**Rename the feed with the prerelease identifier.** Installed clients would continue checking their existing feed and miss the replacement publication.

**Enable downgrade to repair an incorrectly numbered release.** A global downgrade allowance changes ordinary update safety. Affected installations use a manual installer; correcting the feed alone cannot migrate them.

## Consequences

A test build has an unambiguous base and creation date without changing production version identity. Signing and upload still validate the final equal package versions. Installed-update material allocation accepts dated prerelease versions; retained legacy Nightly material remains readable for audit.
