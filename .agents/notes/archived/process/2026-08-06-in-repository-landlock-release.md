# Agent Note: In-repository Landlock release

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-06-in-repository-landlock-release.zh.md)

## Problem

The `@deepseek-ai/node-addon-landlock-run` source already lives beside its DeepSeek Harness consumers under `native/landlock-run`, but it previously kept a separate pnpm workspace and lockfile and depended on a standalone repository for npm publication. Harness packages consumed a fixed registry version, so one pull request could change the launcher contract and its consumer without testing those changes together. The source repository's native workflow could rehearse the package, but it did not publish the artifact it tested.

The mirror also duplicated release coordination: export the source, update another lockfile, run another release workflow, publish the native family, then return to this repository to bump registry dependencies. That split made it harder to match each binary to its source commit, roll back releases, and coordinate security fixes without changing what npm users actually needed.

The existing unscoped npm names are owned by the standalone publisher account rather than the `@deepseek-ai` organization. Moving only the workflow would therefore leave publication dependent on a personal credential outside the repository's release ownership.

The consolidation must preserve platform selection. The public distribution is deliberately one JavaScript entry package plus separate Linux x64 and arm64 binary packages; merging repository ownership does not imply putting every binary into one tarball or publishing every DeepSeek Harness package at the launcher version.

## Decision

`native/landlock-run` and `native/landlock-run/packages/*` belong to the repository's root pnpm workspace and use the root `pnpm-lock.yaml`. Harness consumers declare `@deepseek-ai/node-addon-landlock-run` with `workspace:*`, so development, type checking, builds, and pull-request tests resolve the entry package from the same checkout. The root TypeScript project graph builds that entry package before consumers, and the repository cleaner owns its direct `lib/` output.

The public npm boundary is three organization-owned packages with one launcher-family version: `@deepseek-ai/node-addon-landlock-run`, `@deepseek-ai/node-addon-landlock-run-linux-x64`, and `@deepseek-ai/node-addon-landlock-run-linux-arm64`. The entry package retains both platform packages as `optionalDependencies`; their `os` and `cpu` manifest fields let npm install only the compatible package. Repository constraints require `publishConfig.access: public` for those three names and require their versions to match the private launcher workspace root. The former unscoped names are not release targets of this repository. These three are no longer the only public packages: the [per-sequence access decision](2026-08-13-public-vendor-and-native-sequences.md) publishes the nine vendored framework packages publicly as well, while the dsh family stays restricted.

The main repository owns both native CI and publication. `Landlock Run` runs for relevant pull requests and `master` pushes and builds each platform on its matching native runner. The manually dispatched `Landlock Run Release` workflow builds both platform binaries, transfers them as workflow artifacts, assembles and verifies the complete package family, packs immutable npm tarballs, installs and exercises those tarballs, and only then permits the protected publish job. Platform tarballs publish before the entry tarball that optionally depends on them. Publication uses `landlock-run-vX.Y.Z` tags so launcher releases cannot collide with other release families in the monorepo; prereleases use the npm `next` dist-tag.

The sandbox packed-install rehearsal does not permit the npm registry to supply the launcher. It derives the harness closure transitively from current workspace `dependencies`, `optionalDependencies`, and required `peerDependencies`; the native family stays separate because its mode-preserving pack script supplies the entry and matching platform package. The rehearsal installs those local tarballs into an external plain-Node consumer and proves that the installed launcher is executable, byte-identical to the native build, and the correct ELF architecture before testing confinement or fail-closed behavior.

## Alternatives considered

- **Keep the standalone repository as a release mirror** — rejected because it preserves the split lockfiles, source export, stale-registry test window, and cross-repository release sequence after the source of record has already moved here.
- **Publish one npm package containing every platform binary** — rejected because users would download binaries they cannot run and npm could no longer use package-level `os`/`cpu` filtering. Repository ownership and npm package layout are separate choices.
- **Give the launcher the root DeepSeek Harness version and publish the complete monorepo recursively** — rejected because this change owns one three-package public family, not the independent `@deepseek-ai/dsh-*` baseline. The [artifact-first npm baseline proposal](../../proposed/process/2026-08-04-artifact-first-npm-baseline-publication.md) explicitly keeps native workspaces outside its target set.
- **Cross-compile both binaries in one release job** — rejected because the checked-in package matrix already assigns each architecture a native GitHub runner and avoids adding a cross-toolchain trust surface.

## Consequences

Launcher protocol, TypeScript entry code, native source, harness consumption, and publish-path tests can change in one pull request and resolve from one lockfile. A release tag now identifies the source, consumer integration, build instructions, and tarballs tested by the main repository. The standalone mirror is no longer part of the release path and can be archived after the first successful in-repository publication.

npm consumers install `@deepseek-ai/node-addon-landlock-run`; the old unscoped package names are not silently redirected. A supported Linux host downloads the scoped entry package and its matching architecture package; the other architecture package is skipped. An unsupported host receives no platform binary and follows the existing deterministic fail-closed probe path.

The implementation touches more files than a dependency-line edit because the repository must also own workspace constraints, TypeScript build order, cleanup, CI triggers, release tags, lockfile generation, comparison of installed binaries with workspace builds, release documentation, and generated notices. The behavioral boundary stays narrow: it changes only the Landlock package family and its three direct workspace consumers, not the version or publication state of other DeepSeek Harness packages.

The first scoped release must use an `@deepseek-ai` organization token through the `npm-publish` environment's `NPM_TOKEN`, because npm cannot configure trusted publishing until a package exists. After bootstrap, all three packages must authorize this repository's release workflow before the fallback token can be removed. npm still publishes packages sequentially and offers no cross-package transaction, so a failed publish can leave a partial version. Because npm rejects an already-published name and version, an operator must inspect the registry and publish only the missing tarballs rather than rerunning the workflow unchanged. Linux x64 and arm64 runners remain the authoritative binary and real-kernel checks; a macOS checkout can verify the entry package and unsupported-platform behavior but cannot replace those jobs.

This note supersedes only the release-mirror and registry-pinned source-development statements in the [sandbox Agent Note](../feature/2026-07-06-sandbox.md); that note continues to own sandbox behavior, runner selection, and enforcement semantics.
