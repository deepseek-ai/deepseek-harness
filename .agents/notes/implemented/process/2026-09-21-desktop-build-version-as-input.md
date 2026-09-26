# Agent Note: Pass the Desktop build version as an argument instead of rewriting manifests

Status: implemented

English | [中文](2026-09-21-desktop-build-version-as-input.zh.md)

## Problem

[Deriving Desktop test versions](2026-09-16-desktop-release-version-derivation.md) fixed what a test build is called but not where that name lives. Publishing one meant running `release:dsh` to rewrite the version in every release-family manifest and the lockfile — 295 files — because packaging, the update feed, and upload validation each read the version from the checkout. Those edits are never committed, so a test build left the working tree dirty until someone reverted it, and a reverted tree no longer describes the artifacts that were published. The index in `<base>.YYYYMMDD.index` was also chosen by hand against the records and the bucket, which is a lookup a script can do.

Two more facts about a build were unrecoverable afterwards. A build handed to a colleague or pushed to a test feed is reachable from no tag, and the build tree it came from is not a checkout, so nothing connected an installer to its sources. A production release was likewise recorded only in the bucket.

## Decision

The version a build publishes is an argument. `--build-version` names it, `--build-version auto` proposes the next index for the day, and the value reaches electron-builder through `extraMetadata`, the update feed, and the upload validation as one input. Manifests keep the product version, so no packaging run modifies tracked files.

The version rules in the [Desktop release rules](../../../../apps/desktop/README.md#release-versions) are unchanged: production publishes the dsh base, a prerelease base takes `.YYYYMMDD.index`, and a stable base takes `-test.YYYYMMDD.index`. Validation uses `semver` itself, because `electron-updater` compares feed versions with `semver.gt` against the installed `app.getVersion()`.

This supersedes two requirements of that note. Release-family manifests are no longer rewritten, and the shell version no longer equals the bundled runtime version: the runtime is the dsh package at the product version, and `verifyDesktopRuntime` receives the version whoever prepared that tree wrote, which installed-update qualification rewrites for its own materials. The application already reported the two separately to the mandatory update policy.

Every artifact records `dshBuildCommit` and `dshBuildDirty` in its manifest. A production upload tags the packaged commit as `desktop-v<version>` after the artifacts are public, and reports the command to run by hand rather than failing an upload that already completed; a build from a modified checkout is not tagged. Test and local builds are deliberately left untagged, because a tag per test build would bury the releases.

Upload reads the published version from the completion record packaging wrote, not from a variable, so [release fields still come only from the target file](../../../../apps/desktop/README.md#release-versions).

## Alternatives considered

**Keep rewriting manifests and revert afterwards.** The dirty tree is the defect, and a revert races anything else reading the workspace. It also leaves the published artifacts describing a state the repository no longer has.

**Rewrite only the packed runtime's manifest in a temporary copy.** The bundled dsh would then claim a version that does not exist on npm, and the copy would have to be kept consistent with the lockfile for no gain.

**Number every build automatically without an argument.** Operators confirm the version with the user before packaging. Automatic numbering is offered as `auto`, which prints what it chose, rather than as the default.

**Tag every build.** Test feeds receive builds continuously; tagging each one would make `desktop-v*` useless for finding releases. Artifacts carry their commit instead.

## Consequences

A packaging run leaves the repository unchanged, so the tree that built an artifact is the tree the tag or the recorded commit names. `auto` contacts the destination bucket, including under `--check`, and falls back to the local output directory when no bucket is configured or the listing cannot complete within its deadline; a partial listing is discarded rather than risking a reused index that would overwrite a published installer. Uploading a production release now writes to the repository, which earlier release automation deliberately avoided; the write is one tag, performed by the operator's own command after the upload succeeds.
