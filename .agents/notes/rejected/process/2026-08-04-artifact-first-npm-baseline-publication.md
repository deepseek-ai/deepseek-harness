# Agent Note: Artifact-first NPM baseline publication

Status: rejected — superseded by 2026-08-10-npm-release-sequences: numbered versions and pack→protected publish shipped; timestamp versions were not adopted

English | [中文](2026-08-04-artifact-first-npm-baseline-publication.zh.md)

## Problem

Runnable source in the monorepo does not prove that published packages are runnable. Workspace links, TypeScript paths, tsx source loading, and residual `lib/` files in the working tree can supply files or dependencies that are absent from a published tarball. Existing built-artifact tests still read `lib/` directly from the working tree, so they do not verify what `package.json#files` selects or the layout produced by package-manager installation. An execution that succeeds in development mode can therefore be published without a required bundle chunk, declaration, configuration file, or asset.

Publishing many mutually dependent `@deepseek-ai` packages also creates a set-consistency problem. If a script publishes each package immediately after packing it, a later pack or validation failure leaves the first part of an unusable baseline in the registry. The npm registry has no cross-package transaction, so “publish once” cannot promise an atomic commit. It can promise that the complete publication set is packed and validated before any remote write, then published from that immutable set by one resumable orchestration command.

The current baseline also requires a person to derive versions, authenticate, pack, publish, and retry from a local machine. A later GitHub Actions workflow must reuse the same release bundle and validation logic. It must not rebuild a different, untested set of tarballs after publication is approved.

## Proposal

The publication flow uses an immutable release bundle as its boundary. The pack phase builds every target package from one fixed Git commit, creates every tarball, validates tarball contents, and passes an installed-artifact integration test. The publish phase reads only those tarballs and their manifest and is forbidden from rebuilding or repacking.

The target set contains only `@deepseek-ai/*` workspace packages discovered from `packages/*/*/package.json` and `apps/*/package.json`. The root project, `website/`, vendor, Python, and native workspaces are outside this NPM baseline. Discovery must reject duplicate names, mixed base versions, an unexpected publication privacy state, and unknown packages in the bundle instead of relying on another hand-maintained package-name list.

The prerelease version consists of the package stable base version, a second-precision UTC timestamp captured when the command starts, and the target commit's 10-character short SHA: `<base>-<YYYYMMDDHHmmss>-<short-commit>`. The dist-tag is derived as `dev-<base>`. For example, base `0.0.1`, time `2026-08-04T00:32:00Z`, and commit `909292dd7b` produce version `0.0.1-20260804003200-909292dd7b` and tag `dev-0.0.1`. Retrying one release bundle must retain its version and manifest; repacking creates a version from the new command start time.

The pack phase runs in this order:

1. Resolve the ref to an immutable commit, capture the UTC timestamp, derive the version from that commit's root manifest, and display the commit, timestamp, version, tag, registry, and output path. Both `pack` and `release` wait for Enter at this point before expensive work; `--yes` skips this confirmation for automation.
2. Install the frozen lockfile in an isolated detached worktree and run source-manifest publication constraints before staging. Uncommitted files and old build output from the caller's working tree must not affect publication.
3. Stage every target manifest with the derived version, remove its publication-time `private` marker, and rewrite internal workspace dependencies in `dependencies`, `devDependencies`, `optionalDependencies`, and `peerDependencies` to the same exact version.
4. Build the target commit completely, then run publint and built-package invariants.
5. Pack every package in the target set without performing a registry write.
6. Inspect each tarball's package manifest, file inventory, internal dependency versions, name, and version, rejecting missing, duplicate, or extra tarballs.
7. Generate a release manifest and checksums containing the commit, version, tag, registry, and each package's tarball path, SHA-256, and npm integrity.
8. Install an isolated consumer from the local tarballs and run the installed-artifact probes available in the current implementation; expand those probes to the complete artifact-plane integration matrix defined below.
9. Print one directly executable publish command only after the complete set passes. The pack command itself always remains free of remote writes.

The local `release` command composes pack and publish. It first uses the pack confirmation above to fix the expected timestamp and version, then waits for Enter again after a successful pack before publishing the same manifest; `release --yes` skips both confirmations. Separate `pack` and `publish --manifest` operations remain the primitives used by split CI jobs and recovery.

## Current implementation boundary

The checked-in pack command implements fixed-commit staging, exact internal dependency pins, static and tarball payload checks, the immutable manifest, and an isolated npm installation with every release tarball as a local top-level dependency. It runs the installed `dsh --version` and `dsh --dump-default-config` entries under plain Node, then starts the installed default TUI in a POSIX PTY, waits for its `main-session-` ready signal, and exits through `/exit` before printing the publish command. Publish supports integrity-based resumption, separates read-only registry verification from the authenticated identity check, and finishes with a complete remote integrity and dist-tag verification pass.

Pull-request CI does not invoke the pack command; the installed-entry probes are local release checks rather than merge gates. Credential-free CI execution, package-owned probes for every other bin and public runtime entry, workflow-artifact transfer, and the protected publication job remain proposal scope.

## Publication payload contract

Published packages contain only build artifacts required by consumers. `package.json#files` must not include `src` or `lib/types/**/*.d.ts.map`; an independent tarball-content gate must also confirm that no `package/src/**` or `package/**/*.d.ts.map` entry exists, preventing manifest patterns or pack behavior from bypassing the static constraint. Runtime JavaScript, `.d.ts` declarations, configuration, assets, worker files, and dynamic bundle chunks must cover the actual entrypoint closure.

Source manifests may retain `exports["./src/*"]` for this repository's source-plane resolution. That export does not place source in the publication payload and is not a consumer contract of the published package. Static gates must check the source plane and publication payload separately: deleting the source export must not hide broken workspace resolution, and publishing `src` must not repair missing build artifacts.

Every tarball must be free of `workspace:` specifiers, and every internal dependency and peer dependency that points into the publication set must equal the exact derived version; `^`, `~`, and other semver ranges must not cross commit baselines. Except for `exports["./src/*"]`, which is explicitly source-plane-only, every consumer entry declared by the package manifest must point to a file present in the tarball. Dynamic imports, runtime-computed paths, and non-exported assets cannot be validated solely from the manifest and require installed execution.

## Artifact-plane integration test

The integration test runs after all tarballs exist and before any publish. It creates a fresh temporary project outside the monorepo, installs the declared dependency closure through local `.tgz` files from the release manifest, and executes from that installation. The test must use plain Node and package-manager-produced `node_modules`; tsx, tsconfig paths, workspace links, repository source paths, working-tree `lib/`, and the same version from the published registry are forbidden resolution inputs. The test also asserts that critical modules and bins resolve to real paths inside the temporary consumer.

Installation uses the client behavior selected for this publication. Registry uploads must use the `npm` CLI because the private registry accepts only the npm client; pnpm may still orchestrate builds. Tarball tests must neither publish these packages to the real registry first nor repack after testing.

The test covers at least these execution surfaces:

- Installed `@deepseek-ai/dsh` runs `dsh --version` and `dsh --dump-default-config` successfully under plain Node, covering the static CLI entry and one dynamic mode entry.
- Installed default `dsh` completes one keyless TUI startup in a PTY and exits under test control after reaching a defined ready signal. This path must load the real TUI dynamic chunk, so a missing publication file such as `lib/tui-*.js` fails the gate.
- Every other published `bin` defines a package-owned smoke command that neither reaches a real service nor modifies user state. Different CLIs are not forced to share `--help`; the test runs the actual installed entry and checks its agreed exit or ready signal.
- Node-compatible public runtime entries load from the installation. Browser, worker, or host-protocol-only entries use matching isolated fixtures, but their inputs must still be the current tarballs exclusively.

These tests prove executability; they do not replace unit tests, snapshots, real-API e2e, or publint. Test fixtures should reuse behavior assertions from existing built-bin and PTY scenarios while changing the entry to the tarball installation. A test that runs working-tree `lib/bin.js` directly does not satisfy this gate.

## Publication and recovery

The publish command validates the release manifest, every local checksum, the target registry, `npm ping`, and `npm whoami` before uploading tarballs in a deterministic order. It accepts only a manifest created by the pack phase, never workspace directories. The default registry is `https://registry.npm.harnessment.com/`; every publish passes the registry and derived tag explicitly so a user-level `.npmrc` cannot redirect the operation.

npm provides no multi-package atomic transaction, so uploads still occur package by package. The orchestrator reduces the failure surface through idempotent recovery: upload when remote `<name>@<version>` does not exist; skip when it exists with the release manifest's integrity; fail immediately when it exists with different content. Dist-tag inspection reads tag assignments without resolving a default tag's target, so an unrelated dangling tag cannot block recovery. At completion it must confirm every package version's integrity and every dist-tag against the release version. The workflow reports success only when the complete set passes final verification.

If pack, tarball inspection, or installed-artifact integration fails, the registry must receive zero writes. If publish fails after a partial upload, the operator reruns publish with the same release manifest and must not repack into another timestamped version instead of recovering. Only a code or build-input change that requires different tarballs reruns the complete pack and test flow.

## GitHub Actions integration

GitHub Actions separates a credential-free pack-and-test job from a protected publish job. The first checks out the exact commit, invokes the same pack entry used locally, runs tarball-consumer tests, and uploads the complete release bundle as a workflow artifact. The second depends on the first, downloads that workflow artifact, revalidates the manifest and checksums, and invokes the same publish entry. It cannot rebuild after checkout.

Pull requests and ordinary pushes may run the credential-free pack-and-test signal so payload regressions surface before merge. Actual private-registry publication starts as `workflow_dispatch` with only a target ref as input; the pack job creates the UTC timestamp, while the base version, short SHA, tag, registry, and package inventory derive from repository state or version-controlled configuration. Stable-release triggering is outside this baseline proposal.

The registry token is injected only into the publish job, which uses a protected GitHub Environment to govern human approval, allowed branches or tags, and concurrency. The pack-and-test job cannot read publication credentials. The workflow artifact may have a short retention period, but the publish job must use the bundle produced by the same workflow run instead of locating tarballs from an untrusted source by version.

## Alternatives considered

**Publish recursively from the workspace.** Rejected because it interleaves packing and registry writes, cannot prove the complete set before the first write, and allows workspace resolution and caller working-tree state to influence publication.

**Test only built `lib/` in the working tree.** Rejected because that validates the build tree rather than the tarball selected by `package.json#files`. A dynamic chunk present in the working tree but omitted from the tarball is exactly the failure this proposal must catch.

**Run only `dsh --help`.** Rejected because Commander can print help and exit before loading the TUI, Web, or headless dynamic entry. It does not prove the default production startup path is complete.

**Publish `src` and declaration maps to reduce missing-file risk.** Rejected because the source plane is not a production-runtime fallback. Expanding the payload hides bundle-closure errors and turns local debugging outputs into accidental publication contracts.

**Require truly atomic cross-package publication.** Rejected because the npm registry has no such transaction. An immutable release bundle, complete pre-publication validation, integrity comparison, and idempotent recovery provide an implementable boundary while retaining the explicit limitation that partial uploads can be briefly visible.

**Rebuild in the publish job after approval.** Rejected because the tested and uploaded tarballs would lose content identity. The workflow artifact and checksums must carry the test inputs directly into publication.

## Acceptance criteria

- One pack entry discovers every target under `packages/*/*` and `apps/*` from a fixed commit, derives and displays a version from the UTC second and short commit before waiting for Enter, generates the complete release bundle before any registry write, and prints one copyable publish command; `release` waits again after packing, while `--yes` skips both confirmations.
- Static manifest and tarball-content gates both reject published `src` and `.d.ts.map` while source manifests retain `exports["./src/*"]`.
- The release bundle records the complete package set, commit, derived version, tag, registry, and per-tarball integrity; every internal dependency is pinned exactly to that version, and publish consumes only that bundle without rebuilding.
- An isolated integration test installs from local tarballs and starts the installed default `dsh` TUI under plain Node; deleting any required dynamic chunk makes the test fail deterministically.
- Every published bin and applicable public runtime entry has post-tarball-install execution coverage, with resolution paths proving that no monorepo fallback occurred.
- Publish safely resumes from the same manifest after partial success: matching integrity is skipped, conflicting integrity is rejected, and final verification requires every version and tag to agree.
- A credential-free GitHub Actions job creates and tests the bundle, a protected job uploads the identical bundle, and the publication token exists only in the latter.

## Risks

Full packing, installation, and startup add CI time and workflow-artifact volume. The implementation should cache external dependencies and the pnpm store, but it must not cache or reuse installed workspace output for target packages. Safe consumer probes can run in parallel to reduce latency.

Installing every tarball as a temporary project's top-level dependency can hide an undeclared internal dependency. The test generator should install each tested application's declared recursive closure and retain existing dependency gates. For `@deepseek-ai/dsh`, whose dependency surface approaches the full set, package-manifest and static graph checks remain necessary to detect undeclared edges.

Platform-specific optional dependencies, native addons, PTYs, and browser entries may require platform-owned probes. The first phase must cover primary `dsh` startup on the publication Linux runner and one local macOS path, then expand the matrix with the actual publication platforms. Skipping an unstable probe must not move a production path outside the gate.

Recovery cannot remove npm's partial visibility. During a failed publication, the registry may briefly contain only some package versions from the bundle. Operators and automation must treat the final bundle verification, not one successful `npm publish`, as the baseline-availability signal.
