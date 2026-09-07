# Agent Note: Provision CI pnpm via pnpm/action-setup

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-26-pnpm-action-setup-for-symmetric-ci-caching.zh.md)

## Problem

Outside `landlock-run.yml`, each workflow that installed pnpm hand-provisioned it with `corepack enable`, and five of them further repeated a hand-rolled cache setup — `pnpm store path --silent >> $GITHUB_OUTPUT`, then `actions/cache@v4` keyed on `pnpm-lock.yaml`: `e2e.yml`, `docs-pages.yml`, `pi-ai-provider-e2e.yml`, `build-exe-for-python-sdk.yml`, and the node-compat, serial-linux, and benchmark jobs of `ci.yml`. The maintained equivalent — `pnpm/action-setup@v4` (reads `packageManager` from package.json) plus `actions/setup-node` with `cache: pnpm` — was already proven in-repo in `landlock-run.yml`, and corepack's removal from newer Node distributions made every `corepack enable` a known future break.

## Decision

`pnpm/action-setup@v4` is the pnpm provisioning mechanism across CI: no workflow runs `corepack enable`. The self-hosted Windows install steps are the deliberate exception — they invoke `corepack pnpm` because clone-mode installs need the `@reflink/reflink` native module that the system corepack pnpm carries but `pnpm/action-setup`'s dest build omits (see [the Windows ReFS store note](2026-08-30-windows-refs-store-block-clone-install.md)). The root dev dependency on `@yarnpkg/cli-dist` separately supplies the modern Yarn CLI exercised by the generated-project e2e; package-manager coverage therefore does not inherit the runner image's Yarn Classic. Caching remains per-job policy on top of pnpm provisioning, in three deliberate shapes:

- **Symmetric cache** (restore and save): `actions/setup-node` with `cache: pnpm` — `e2e.yml`, `docs-pages.yml`, `pi-ai-provider-e2e.yml`, `build-exe-for-python-sdk.yml`, the node-compat job of `ci.yml`, and the two benchmark jobs of `ci-master.yml`. The larger-runner benchmark keeps its store cache Linux-only through a conditional `cache:` input; the consolidated benchmark caches on both platforms.
- **Restore-only caching** (hand-rolled `actions/cache` steps): the three enterprise-runner PR jobs and the Wine-based required Windows job restore without saving, keeping cache compression/upload off their latency-sensitive paths — an asymmetry `setup-node`'s cache cannot express. Each configures a store outside the action's replaceable install directory and resolves that path. No master job produces these hosted caches, so these restores hit matching archived entries until they evict. The enterprise jobs skip restore during self-hosted failover because that VM's persistent store is already warm.
- **Cache-less or persistent** (no store-cache action): the independent native Windows job, native serial-windows and serial-macos, plus `sandbox.yml` install from a cold or runner-local store. Extracting the many-file pnpm store costs more than a clean Windows install; the self-hosted standby and failover jobs instead reuse their VM's persistent pnpm store without transferring a hosted cache archive.

## Alternatives considered

- **Keep the hand-rolled steps.** They worked, but they were drifting copies of setup boilerplate, and the corepack dependency was a known future break.
- **Convert the enterprise jobs' caching to `cache: pnpm`.** Rejected: the restore-only asymmetry is a documented latency decision in `ci.yml`'s comments; erasing it to unify tooling inverts the priority.
- **Convert serial-linux's store cache.** Rejected during implementation: the original proposal counted serial-linux among the symmetric setups, but its cache step is the producer half of the enterprise jobs' restore-only pairing — moving it to `setup-node`'s key format is the enterprise conversion by another route.
- **Stop at the cache-bearing workflows and leave the other `corepack enable` sites.** Rejected: provisioning and caching are separable concerns, and leaving corepack in the cache-less jobs kept the future break and two provisioning idioms for no benefit.
- **Rely on the runner image's Yarn.** Rejected: the hosted image exposes Yarn 1.22 after Corepack is removed, while the generated-project e2e requires Yarn 2 or newer. A locked root dev dependency makes that coverage independent of runner image contents.
- **A composite action wrapping action-setup plus setup-node.** Rejected: the remaining per-job variation (Node-version matrices, per-platform conditional caching, and the restore-only pairing) is deliberate policy, not boilerplate. A wrapper would grow matching inputs or flatten a real asymmetry, while the two-line pair is already near the floor.

## Consequences

- The corepack dependency is gone from CI except the self-hosted Windows install steps, which invoke `corepack pnpm` for the ReFS block-clone native module; pnpm otherwise arrives via the pnpm team's official action, and the version pin stays single-sourced in `package.json`'s `packageManager` field.
- The generated-project e2e runs the root-pinned Yarn 4 CLI instead of inheriting or silently skipping the runner image's Yarn version.
- The cache-key format changed once for converted lanes; one cold run repopulated it, after which hit rates match the old steps. The built-in key spans platform, arch, and the lockfile hash but not the Node version, so the node-compat matrix legs share one store entry — safe, because the pnpm store is Node-version-independent.
- `setup-node`'s built-in pnpm cache restores by exact key only, with no `restore-keys` prefix fallback: a `pnpm-lock.yaml` change starts a converted lane from a cold store instead of seeding from the previous entry.
- `pnpm/action-setup` deletes its install directory on every run and places the default store beneath the resulting `PNPM_HOME`. Linux jobs that need hosted cache restores or self-hosted persistence therefore set `PNPM_CONFIG_STORE_DIR` to `$HOME/.local/share/pnpm/store`, outside the action directory; the restore-only jobs resolve that stable path and exact key.
