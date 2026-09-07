# Agent Note: npm access per release sequence: the vendored framework and the native packages publish publicly

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-13-public-vendor-and-native-sequences.zh.md)

## Problem

The [three release sequences](2026-08-10-npm-release-sequences.md) shipped with `publishConfig.access: restricted`, so every package published to the `@deepseek-ai` scope was visible only inside the organization. Five rehearsal publications ran that way, through `dsh@0.0.1-rc.5`, `vendor *-rc.4`, and `landlock-run@0.0.1`.

A restricted dependency is what actually blocks a public consumer. Every harness package declares the vendored framework as a `peerDependency`, and `dsh-sandbox-local` declares the Landlock entry as a `dependency`. A public package that requires a restricted one cannot be installed by anyone outside the organization, so those two sequences have to be public before the dsh family can be — and while the dsh family is still restricted, they are the only two whose artifacts an outside consumer would need to resolve.

## Decision

Access is a property of each release sequence, not of the scope:

| Sequence | Members | `publishConfig.access` |
|---|---|---|
| vendored framework | the nine `vendor/*` packages | `public` |
| native | the three `native/landlock-run/packages/*` packages | `public` |
| dsh | `packages/*/*` + `apps/*` (221 members) | `restricted` |

`check-workspace-constraints.ts` holds every manifest to its own sequence's level, which is what stops the scope from drifting: a new `vendor/*` package left at `restricted`, or a dsh member flipped to `public`, fails the workspace constraints.

**No publish path passes `--access`.** A single flag cannot serve sequences that disagree, and a flag overrides the manifest that owns the fact — so `publish.ts` passes none, and the native workflow continues to pass none. Each packed manifest decides.

Harness consumers reference the Landlock entry as `workspace:^` rather than `workspace:*`, so a published harness package accepts the entry's patch and minor releases instead of pinning one exact version. The entry keeps `workspace:*` for its two platform packages, where the binary must match the entry version exactly.

Access is a property of the package, not of a version: the twelve packages already published as restricted — `landlock-run@0.0.1` and the vendored `*-rc.*` versions — become world-readable at their next publication.

## Alternatives considered

**Flip the whole scope public at once.** Rejected: it would make a dsh release public as a side effect of a manifest change rather than a deliberate release decision. Opening the two dependency sequences first keeps every published package installable at each step and is a precondition for opening dsh.

**Keep everything restricted and grant a read-only team instead.** `npm access grant read-only <org:team> <package>` is per-package with no scope wildcard, so covering the set means one grant per package plus a standing reconciliation job for every package added afterwards. It also only reaches organization members, which does not serve an installable public artifact.

**Publish public from the publish path instead of the manifests.** Impossible for a mixed scope — one `--access` flag cannot express two levels — and it would override the manifest that the workspace constraint already checks.

## Consequences

- **The twelve packages are public from their next publication onward, and that is not cleanly reversible.** Returning to a restricted scope requires a paid plan plus per-package `npm access set status=private`, and anything already downloaded or mirrored stays out.
- **`@deepseek-ai/dsh` is still not installable from outside the organization.** Its manifests stay `restricted`; what changed is that its published dependencies no longer would be, so opening it later is a version decision rather than a dependency problem.
- **What ships from the two public sequences is now world-readable, so their payload policy carries more weight.** `vendor/cordis` publishes `src` deliberately, because its export map declares `./src/*`; the Landlock entry publishes `src/main.c` as a documented audit surface.
- **The private-packages plan is no longer required for these two sequences.** The `402 Payment Required` failure that blocked the first native publication cannot recur for a public package.
- **An unauthenticated `npm view` becomes a usable check for the public sequences.** While every package was restricted, a machine without credentials received `E404` for a package that existed, which is indistinguishable from an absent version.
