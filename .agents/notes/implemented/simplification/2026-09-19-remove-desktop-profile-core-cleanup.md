# Agent Note: Remove the Desktop production profile core-package cleanup

Status: implemented

English | [中文](2026-09-19-remove-desktop-profile-core-cleanup.zh.md)

## Problem

Since 2026-09-15, production Desktop cleaned the profile before starting the Host, using the package names listed by the runtime descriptor: it deleted same-named entries under `$DSH_HOME/profiles/desktop/node_modules`, pruned the manifest's dependency declarations and pnpm overrides for those names, discarded the lockfile when package state changed, and removed development-time links once according to `desktop-runtime-state.json`. It targeted two kinds of residue: earlier Desktop builds had installed the core packages into the profile as local tarballs through pnpm, writing declarations, overrides, and a lockfile; and the development mode of the link backend had projected the installation closure into the same profile's `node_modules`. Under nearest-wins resolution those copies shadowed the runtime bundled with the application, combining an old Web frontend with new plugins.

Both kinds of residue exist only on internal development and test machines; Desktop has not been released. Since the runtime ships inside the application, new profiles no longer contain core packages, and after the [link backend removal](../architecture/2026-09-19-profile-resolution-lookup-order.md) development mode writes no links into the profile. The cleanup had to rerun on every production launch and fought the next pnpm operation, which reinstalled packages from the retained declarations.

## Decision

Delete `apps/desktop/src/profile-core-cleanup.ts`, `apps/desktop/src/profile-packages.ts`, and their two specs. `DesktopProjectManager.applyRelease` validates the runtime descriptor, migrates profile settings, creates the profile files, and removes the projections a link-backend launch wrote through the shared `removeLinkProjections`; beyond that, neither production nor development launches modify the profile's `node_modules`, manifest, overrides, lockfile, or `desktop-runtime-state.json`.

Resolution inside the profile follows the [lookup-order Note](../architecture/2026-09-19-profile-resolution-lookup-order.md): packages in the profile's own `node_modules` win as the nearest layer, and installation package names are occupied by the generation at `$DSH_HOME/profiles/node_modules`. When a package installed into the profile declares `@deepseek-ai/*` packages under `dependencies`, pnpm installs copies into the profile and those copies run at their own versions. Official packages keep only pure-function packages under `dependencies` and declare every package with module-level identity as a peer; a third-party plugin that declares an identity-bearing dsh package as a real dependency makes that packaging choice for itself.

Capability given up: core-package copies and their declarations that earlier Desktop builds installed into a profile need one manual removal; `desktop-runtime-state.json` is no longer read or deleted. Projections the link backend wrote are removed by the shared profile load, see the [lookup-order Note](../architecture/2026-09-19-profile-resolution-lookup-order.md).

Reintroduction conditions: a released Desktop wrote core-package copies into external users' profiles, or official packages change their dependency conventions so that profiles gain copies competing with the runtime for identity.

## Alternatives considered

**Keep the original cleanup.** The residue it served is no longer produced, yet it deleted directories, pruned declarations, and discarded the lockfile on every production launch, fighting the following pnpm operations.

**Delete only same-named directories under the profile's `node_modules`, leaving declarations and the lockfile alone.** The 2026-09-15 decision already rejected this: pnpm reinstalls the same old packages from the retained declarations and overrides.

**Give `@deepseek-ai/*` generation entries absolute precedence over same-named copies inside the profile.** That overrides versions plugins bring along and is a new resolution-rule decision outside the scope of removing the cleanup.

**Clean only in the installer.** The 2026-09-15 decision already rejected this: it misses other profiles and cannot reach copies recreated after installation.

## Verification

- [project-manager.spec.ts](../../../../apps/desktop/tests/project-manager.spec.ts) asserts that after one launch preparation the installed core package directory, the third-party plugin directory, the manifest declarations, `desktop-runtime-state.json`, and the lockfile are byte-for-byte unchanged.
- The repository has no remaining references to `cleanProfileCorePackages`, `migrateDesktopProfileLinks`, `CLEAN_PROFILE_CORE_PACKAGES`, or `DESKTOP_PROFILE_STATE`.

## Consequences

Bought: production launches no longer write into the profile, there is no temporary enable switch, and Desktop and the CLI apply one rule to copies inside a profile. Paid: core-package copies earlier Desktop builds installed into a profile are removed by hand; dsh copies that third-party plugins bring into the profile as real dependencies run at their own versions.
