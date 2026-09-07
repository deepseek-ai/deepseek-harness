# Agent Note: Private npm publication as three independent sequences

Status: implemented

English | [中文](2026-08-10-npm-release-sequences.zh.md)

## Problem

This repository held three unrelated groups of publishable packages and no channel that sent any of them to a registry.

`packages/*/*` and `apps/*` form the runtime surface of `@deepseek-ai/dsh`; `vendor/*` holds nine rescoped Cordis framework packages, each carrying its upstream version; `native/landlock-run/packages/*` holds Linux platform packages with their own workflow. The three differ in version baseline, change rate, and build requirements: dsh moves with the product, vendor moves only when upstream is re-synced or a local modification changes, and native needs a musl toolchain and one build per architecture. Forcing them through one pipeline means every product release republishes the framework and the native binaries.

Two hard blockers sat in the way. All 217 workspace manifests set `private: true`, which npm refuses to publish. The subtler one was 933 hand-written `peerDependencies: "^0.0.1"` entries between sibling dsh packages: `pnpm pack` substitutes the `workspace:` protocol but leaves semver ranges alone, and `^0.0.1` means `>=0.0.1 <0.0.2` — it excludes `0.0.2`, and semver excludes prereleases from a range without a prerelease of its own, so it excluded `0.0.1-rc.1` too. Those entries never failed only because the version never left `0.0.1`.

`scripts/publish-npm-baseline.ts` is a local publication script: it packs and publishes in one process, needs a human to authenticate and retry on their own machine, and excludes vendor from its release set. It cannot be the basis for CI publication, though its tarball payload validation and installed-artifact probes are verified parts.

## Decision

### Three independent sequences

`packages/`, `vendor/`, and `native/` each have one bump sequence and one publication, sharing no version, no trigger, and no waiting. Releasing dsh does not republish vendor; releasing vendor does not republish native.

| Sequence | Members | Version baseline | Tag | Workflow |
|---|---|---|---|---|
| dsh | Publish set: non-experimental `packages/*/*` + `apps/*`; private experimental packages join only the shared version bump | one version for the publish set, private dsh packages, and workspace root, `0.0.x` | `dsh-v<version>` | `release.yml` (pack) / `release-publish.yml` (publish) |
| vendored framework | the nine `vendor/*` packages | each package on its own version line | `vendor-<package>-v<version>` (one per package) | `release-vendor.yml` (pack) / `release-vendor-publish.yml` (publish) |
| native | `native/landlock-run/packages/*` | its own `0.0.x` | `landlock-run-v<version>` | `landlock-run-release.yml` |

All three publish to the `@deepseek-ai` scope on npmjs.com, and access is per sequence rather than per scope: the vendored framework and the native packages are `public`, and the dsh family has been `public` since its own sequence went public on 2026-08-13 ([rationale](../../archived/process/2026-08-13-public-vendor-and-native-sequences.md)). No publish path passes `--access`, because one flag cannot serve sequences that disagree and would override the manifest that owns the level.

### Versions land in the repository from a local command; CI only checks and uploads

Each sequence has one bump-and-commit command: it derives the target version, writes it into the relevant manifests, runs `pnpm install --lockfile-only`, and commits the manifests with the lockfile. The published version is therefore readable from the repository. A human creates the tag after the commit merges to master; CI never writes to the repository and needs no write permission.

`release:dsh` accepts `major`, `minor`, `patch`, or an explicit version, and writes one version across the publishable family, every private package under `packages/*/*`, **and the workspace root**. Private packages receive no release tag and remain outside pack and publish; they follow the version because [the static version-coherence gate](../../archived/process/2026-09-03-workspace-version-coherence-gate.md) requires every dsh package's version to equal the root's. The root check accepts a prerelease segment, so explicit versions such as `0.0.1-alpha.1`, `0.0.1-canary.1`, and `0.0.1-rc.1` drive the same pack, installed-artifact probe, and publication path. `dsh` publication maps `alpha` and `canary` to their matching npm dist-tags, maps other prereleases including `rc` to `next`, and leaves stable versions to npm's `latest` default. Other release families retain their own dist-tag policy.

For equal release numbers, SemVer compares alphanumeric prerelease identifiers lexically: `alpha` is lower than `canary`, `canary` is lower than `rc`, and every prerelease is lower than the stable version. npm dist-tags are mutable aliases and do not participate in version precedence.

### vendor: publish what changed, and let tags be the ledger

The vendored packages are decoupled from upstream by their scope but keep their own version lines. The published version is the higher of the manifest version and the last published version, with the patch incremented — which also drops an upstream prerelease segment. The first published versions:

| Package | Upstream version | First published version |
|---|---|---|
| `@deepseek-ai/cordis` | 4.0.0-rc.7 | 4.0.1 |
| `@deepseek-ai/cordis-plugin-loader` | 1.0.0-rc.5 | 1.0.1 |
| `@deepseek-ai/cosmokit` | 1.8.1 | 1.8.2 |
| `@deepseek-ai/schemastery` | 3.18.0 | 3.18.1 |
| `@deepseek-ai/cordis-plugin-hmr` | 1.0.15 | 1.0.16 |
| `@deepseek-ai/cordis-plugin-include` | 1.0.4 | 1.0.5 |
| `@deepseek-ai/cordis-plugin-timer` | 1.1.2 | 1.1.3 |
| `@deepseek-ai/cordis-plugin-group` | 1.0.0 | 1.0.1 |
| `@deepseek-ai/cordis-plugin-logger-console` | 1.0.0 | 1.0.1 |

Taking the last published version as the baseline is what survives a re-sync: upstream restoring `4.0.0-rc.8` after this repository published `4.0.1` would otherwise compute `4.0.1` again and collide. `--prerelease rc.1` publishes a rehearsal instead, which takes `--tag next` and leaves the release numbers free: a prerelease has lower precedence than the release it precedes, so `4.0.1` still follows `4.0.1-rc.1`. That ordering is computed here rather than read from `git tag --sort=v:refname`, which places a prerelease above its release.

Only changed packages publish, and the change judgement adds no state file: **each package has its own tag, and that tag records the commit it last published from**. For each package, bump reads the newest `vendor-<package>-v*` tag and diffs the package directory against it. A path counts when the manifest's `files` selects it, when npm publishes it regardless (`package.json`, `README*`, `LICENSE*`), or — for a package whose `files` selects `lib/` — when it is a build input (`src/**`, `tsconfig*.json`, a build config). That last rule exists because a built payload is not tracked by git: without it, a real source change reads as "nothing changed" and the next publication fails on a version whose bytes moved.

A tag is a commit pointer, not proof of publication. Bump asks the registry whether the version its newest tag names exists and fails for a human to resolve when it does not, because a tag pushed for a publication that then failed would otherwise read as "already published" and skip the package indefinitely. Querying a private package needs credentials, so an unauthenticated machine reports the gap instead of failing.

`vendor/cordis` publishes `src` as well. Its export map declares `"./src/*"`, so a tarball without those files points consumers at absent paths, and `files` selecting only build output left the change judgement with no tracked path to match.

### Publication runs only on GitHub, and the registry decides what goes out

Publication runs only from GitHub Actions; there is no local publication path. Publish reads no tag and no manifest of "what this release includes". For each packed tarball it compares the version against the registry, in three states:

| State | Action |
|---|---|
| the registry does not have that version | publish |
| the registry has it, and the tarball's sha512 equals the recorded `dist.integrity` | skip: this is a re-run over one artifact |
| the registry has it, and the integrity differs | fail, reporting content changed without a version bump |

The third state catches code that changed without a version bump. The first two provide idempotence — re-running publish over one artifact republishes nothing and needs no manual selection of packages. The same rule resolves the tension between one vendor release carrying several tags and a workflow that can only run from one ref: the workflow never infers which packages to publish from the tag it ran from.

All three sequences decide this way, including the native one: it publishes through its own script rather than a shell loop, because a loop of bare `npm publish` calls cannot be retried — the registry answers a repeat of an existing version permanently, so one failure partway through left no way forward.

Two registry behaviours shape how a publish is attempted. Writes are spaced by at least two seconds and retried with a backoff, because publishing several packages back to back outruns the registry's own processing and earns `E409 Failed to save packument`. And every retry re-reads the registry first: a reported failure can answer a write that landed anyway, so a version that now exists with this tarball's integrity counts as published rather than as a version to place again.

### Workspace-internal references use the `workspace:` protocol

Every reference to a workspace member uses `workspace:^`, so `pnpm pack` substitutes a range matching the target version: sibling `peerDependencies` follow the family version, and a reference to a vendored package follows that package's own line. The Landlock platform packages keep `workspace:*`, which publishes the exact version, because a platform package and its entry must agree exactly.

`scripts/check-workspace-constraints.ts` requires the protocol, so a new package cannot reintroduce a hand-written range; the invariant-companion rule requires `workspace:^` for `@deepseek-ai/dsh-invariants` for the same reason.

### Published dependency faces use an explicit policy

[`verify-package-dependencies`](../../../../scripts/verify-package-dependencies.ts) classifies workspace relationships by their published Client and Host use, keeps only Cordis as a peer in covered packages, and applies a small explicit Host roster. [Published dependency faces and bounded peer relays](2026-08-26-published-dependency-faces.md) owns the selection rules and rationale.

`pnpm run benchmark:npm-resolution` measures this graph manually with the installed npm executable. `pnpm run benchmark:npm-resolution:next` additionally tries each reachable unconfigured Host package and serially remeasures the leading candidates. Both commands use a loopback metadata registry and reject archive requests, so their duration excludes package downloads. Neither command is an aggregate gate because scheduler load and metadata completion order make wall-clock thresholds nondeterministic.

### An optional dependency is never loaded at module scope

A dependency in `optionalDependencies`, or a peer carrying `peerDependenciesMeta.<name>.optional`, may be absent from an installed tree — that absence is the whole promise of "optional". A static import is evaluated when the importing module loads, so one absent package stops being "this capability is unavailable" and becomes a load failure for everything that reaches the importing module. The failure appears only in an installed tree missing that package, and no test here constructs one: a workspace install always has every package, so the unit tests, the snapshots, and the packed-install probe all pass while the published package is broken for the consumer who declined the optional peer.

[`verify-optional-dependency-imports`](../../../../scripts/verify-optional-dependency-imports.ts) closes that hole. It reads each package's own manifest for what that package allows to be absent, then scans the files that ship — `packages/*/*/src/` and `apps/*/src/` — across both compiler faces. `vendor/` is out of scope, as pinned upstream source under the [vendoring policy](../../../../vendor/README.md). Value-versus-type is decided against a bound Program rather than the import syntax, because `verbatimModuleSyntax` is off: the compiler already erases an import whose bindings resolve to types, so `import type {}`, `import {}`, an inline `type` specifier, and a named binding that resolves to a type all emit nothing and are allowed, while a bare import, a value binding, and a star re-export are kept and rejected. Only the type phase erases an import: `import defer` still resolves and links its module, deferring evaluation alone, so the gate counts it as a load.

A violation names the package, the declaration that made it optional, and the way out in order — import it as a type, which is all that declaration merging needs, or restructure so module scope does not need the package. A dynamic `import()` only moves the failure to first use, so it belongs to a caller that genuinely requires the package and handles its absence; reaching for it is a sign the dependency is not optional, and the gate does not offer it as the remedy.

### Release family objects

The entity in this domain is a **release family**: a set of packages sharing one version baseline and tag naming that publishes as a unit. Adding a family means adding a subclass and a workflow lane, not changing the core.

| Object | Responsibility |
|---|---|
| `ReleaseFamily` | a family's identity: member discovery, version baseline, tag prefix, packed-payload rule, installed entry |
| `ReleaseMember` | one publishable package: directory, name, version, manifest |
| `publishOrder` | topological order over the sections npm installs plus peer declarations, ties broken by package name; a cycle among installed dependencies is reported rather than resolved arbitrarily, and a peer edge no order can honour is dropped and named |
| `pack` | packs a whole family into one directory and records the upload order |
| `verify` | the family's version baseline, the publish order it prints in full, and — when publishing — that the run comes from that family's tag and its members are publishable |
| `verify-packed-install` | installs the tarballs of one or more pack directories into a throwaway consumer and drives the installed executable |
| `publish` | the three registry states above |
| `process` / `tarball` | the one home for spawning commands and for reading a packed tarball, including the entry guard that keeps every script importable |

The dsh family applies the repository's publication payload policy, which rejects sources and declaration maps. The vendored family keeps upstream's payload, because those manifests export `./src/*` and dropping `src` would publish an export map pointing at absent files.

### Workflow shape: pack on PR/push, publish from a manual dispatch workflow

The `pack` job walks the whole release set once, packing each member into one directory, writes the upload order, and uploads that directory as one artifact; it lives in `release.yml` / `release-vendor.yml`. The release set is one unit — half the packages can never reach the registry while the other half is still building.

`pack` carries no credentials and runs on every pull request and master push, so a pull request proves the release set still packs. Publication lives in a separate `release-publish.yml` / `release-vendor-publish.yml` workflow that is `workflow_dispatch`-only (so it never appears as a PR check): it repacks the current tree and then publishes each entry in order, behind the `npm-publish` environment for human approval. Pack runs are grouped per ref so concurrent pull requests do not displace each other; the `publish` job carries the global `Release-publish` group, because dist-tags are shared registry state.

A dsh verification installs the vendored family's pack output too. The harness packages declare the vendored framework as a peer, those packages live in another sequence, and the credential-free job cannot fetch them from a private registry — so the dsh `pack` job packs the vendored family for verification while publishing only the dsh set. The publish workflow (`release-publish.yml`) repacks the current tree and publishes only the dsh set.

The verification also packs the Landlock entry, which `dsh-sandbox-local` declares as a plain dependency, and omits optional dependencies. The platform packages behind those optional entries need a musl toolchain and one build per architecture, so a job on one runner cannot produce them; a consumer that cannot install them must still start, which is what optional means here. The verification therefore reads a directory by its contents rather than a pack order, because a directory can hold tarballs packed only to satisfy a cross-sequence dependency.

### Repository changes this carried

| Item | Content |
|---|---|
| release-set manifests | `private: true` removed; `publishConfig.access` per sequence and `repository` with each package's `directory` added |
| release-set boundary | every member of `packages/*/*`, `apps/*`, and `vendor/*` |
| dependency protocol | workspace-internal references are `workspace:^`, with `check-workspace-constraints.ts` and the invariant-companion rule requiring it |
| root `AGENTS.md` | the convention that vendored packages are `private: true` no longer holds |
| `vendor/README.md` | records `src` joining `cordis`'s `files` as a local modification |
| the three native packages | `publishConfig.access: public`, and their workflow passes no `--access` |

### Relationship to the earlier proposal

This Agent Note replaces the version scheme and the release-set boundary in [artifact-first npm baseline publication](../../rejected/process/2026-08-04-artifact-first-npm-baseline-publication.md): its `<base>-<timestamp>-<short SHA>` prerelease versions and `dev-<base>` dist-tag are not adopted, and vendor is not excluded from the release set. What both agree on stands: pack and publish are separate, publish consumes only verified tarballs, and the payload and installed-artifact probes are release gates.

## Alternatives considered

**A `<base>-<timestamp>-<short SHA>` version.** Planned for continuous dev publication. It conflicts with keeping the published version in the repository: the version embeds a commit SHA, and writing the version back produces a new commit, so the SHA can only name the parent commit that was published and the link needs a convention to explain it. With numbered versions, a prerelease such as `0.0.1-rc.1` already covers "verify first, then release".

**A `vendor/published.json` ledger recording each package's published version and commit.** This preceded the tag design. It adds a state file that must not drift from the registry. A per-package tag gives the same commit pointer, and the tag has to exist anyway, so it introduces no second copy of the state.

**Event-level tags (`vendor-r1`, `vendor-r2`).** Prepared for one release event carrying several package versions. Once the registry decides what publishes, the workflow no longer infers the set from the tag, so per-package tags suffice — and each one names its own package's real version.

**Putting the nine vendored packages on one `4.0.x` line.** It removes change detection, but cosmokit would jump from `1.8.1` to `4.0.1` and lose its upstream lineage; the upstream ranges inside the nine (`^1.8.1` and friends) would stop matching immediately, forcing a rewrite of the vendored manifests.

**Incrementing every vendored package on every vendor release, with no change detection.** The least machinery, at the cost of new version numbers for packages whose content is byte-identical to the previous release. Tags reduce change detection to reading one tag and running one diff, which is not worth trading for inflated version numbers.

**Deciding "already published" from the version alone, without comparing content.** The reference flow queries no registry: publish uploads each tarball and npm rejects a duplicate version. Skipping on the version alone misses code that changed without a bump, which is the only failure that quietly leaves stale bytes on the registry. The cost is a registry query and a dependency on reproducible builds.

**Verifying only the packed install, with no local registry.** The reference flow unpacks tarballs into a tree and drives it with plain Node, which bypasses version-range resolution. Running a local registry in CI to cover that layer was rejected: artifact correctness is covered by existing tests, the publication path is exercised by the master rehearsal, and a pull request only needs to prove the release set packs. Installing from `file:` specifiers still exercises range resolution for every internal dependency.

**Selecting a subset by entry closure.** Crawling `dependencies` from `@deepseek-ai/dsh` and `@deepseek-ai/dsh-web-frontend` yields 156 packages, 61 fewer than the whole set. But this repository's plugins are mounted by name from `cordis.yml` rather than imported: `vendor/cordis-plugin-group` and `vendor/cordis-plugin-logger-console` fall outside the dependency closure while being required at runtime. Selecting by code dependency fails as "the consumer installs it and it will not start", and it would need a standing proof that no mounted package was missed. Under a private scope the extra packages are invisible outside the organization. `python/`, `docs/`, and `website/` are not release-family members.

**Extending `scripts/publish-npm-baseline.ts`.** It is a local publication script that packs and publishes in one process, the opposite of separating credential-free packing from protected publication. Its verified parts — payload validation and installed-artifact probes — are reused so `pnpm run duplication` does not report clones.

**One workflow with a `family` input.** Two version models in one file forks the concurrency group, the tag prefix, and the rehearsal triggers into conditional expressions. One file per family is both shorter and easier to read.

**Rewriting dependency ranges at publication time.** Compared with the protocol, the rewrite runs only in CI, a local `pnpm install` cannot show whether it is correct, and it repeats on every release.

**Running bump in CI and pushing the version back.** It needs repository write permission for the workflow, and a version commit on the release branch races human commits. Bump and commit stay local; CI checks and uploads.

## Consequences

The release scripts are importable modules behind a guarded entry point, and their judgements carry unit tests: tag naming, publish order and cycle reporting, version-baseline arithmetic, the payload change judgement, and each family's payload policy. Two defects the first draft carried — a publish command that ran the pack command on import, and a change judgement blind to `vendor/cordis` source edits — are exactly what a test at that seam catches.

A pull request runs the full pack for both sequences without credentials and installs the packed dsh tarballs into a throwaway consumer, where plain Node drives `dsh --version`. That probe is deliberately one command: it proves `files` selected a complete payload and that the published ranges resolve, and says nothing about interactive behavior.

What this costs:

- **Tags can drift from the registry.** A tag pushed for a publication that then failed is caught by bump's registry check, but only where credentials exist; an unauthenticated machine reports the gap and continues.
- **The change judgement depends on visible tags.** A shallow clone, or a checkout without tags, degrades the vendored judgement to "publish everything for the first time". `fetch-depth: 0` is a precondition, not an optimization.
- **The protocol rewrite touched 1504 dependency declarations.** It does not change local resolution — pnpm already resolves from the workspace — but it changes the ranges that go out.
- **Private packages need credentials to install.** Every consumer — CI, sandbox e2e, outside users — needs scope credentials, including for the Landlock packages, which have never been published and so cut off no existing anonymous path.
- **`repository` names a different organization than the one running the workflows.** Token-based publication is unaffected; npm provenance (OIDC) requires the two to agree, so adopting it means either repointing `repository` or publishing from the organization it names.
- **Byte reproducibility is assumed, not measured.** The skip-on-identical-integrity state rests on packing the same commit twice producing the same bytes. Nothing measures that yet: if the build embeds absolute paths or timestamps, a re-run reports a false failure. Measure it before the first publication a re-run might follow, and fall back to comparing per-file content hashes if it does not hold.
- **Re-running publish over an older artifact can move `latest` backwards.** Publication is decided per version, so an older set republished after a newer one takes the stable dist-tag again. The rehearsals run from a prerelease version, which never takes `latest`.
- **The first publication is one large step.** Nine vendored packages and the whole dsh set publish at once, so any payload defect surfaces in a single release, which is why a prerelease version drives the complete path first.
