# Agent Note: Source run without a managed installer

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-10-source-run-without-managed-installer.zh.md)

## Problem

A repository-owned source installer can provide a stable launcher, isolated staging worktrees, atomic upgrades, rollback storage, and shared maintenance workflows for personal customizations. It also makes the repository responsible for a second lifecycle beside the package manager: host dependency installation, credential prompting, checkout adoption, symlink ownership, staging branch coordination, upgrade recovery, and continued compatibility between the installer and bundled maintenance skills.

That lifecycle is not required to run or develop DeepSeek Harness from a source checkout. Maintaining it expands the supported filesystem and Git state space without improving the repository-native execution path.

## Decision

The repository supports source execution through its root `pnpm` scripts. The `dsh` entry in `package.json` launches `apps/cli/src/bin.ts` directly through `node --import tsx/esm`; artifact generation is the separate `pnpm run build` operation defined by the [source-launch/build separation decision](2026-08-12-separate-source-launch-from-build.md). The package script forwards arguments and inherits the caller's environment, including `NODE_USE_ENV_PROXY=1` when a supporting Node version must honor `HTTP_PROXY` and `HTTPS_PROXY`. Users select Web with `pnpm dsh web`, headless execution with `pnpm dsh --profile headless "task"`, and ACP automation with `pnpm dsh --profile acp`.

The repository does not distribute a source installer, an installer test suite, or skills that assume a managed `current` symlink and timestamped staging worktrees. Users own source checkout placement, Git updates, and any launcher they create outside the repository.

## Alternatives considered

**Keep the installer but document `pnpm run` as another path.** This retains the managed launcher and rollback capability but keeps both lifecycle contracts active, including the installer tests and staging-aware skills.

**Keep generic customization and upstream-publication skills.** Their safety rules can apply beyond the staging layout, but the shipped workflows form one coupled maintenance system: customization discovers the installed staging checkout, upgrade performs the cutover, and upstream publication is selected from those personal changes. General Git contribution guidance already belongs to repository instructions and does not require product-bundled skills.

**Replace the installer with a smaller launcher-link script.** This reduces setup behavior but still makes the repository responsible for host PATH mutation and launcher ownership. Source scripts provide the entry points without that state.

## Consequences

Source users invoke repository scripts rather than an installed `dsh` command. The repository provides no atomic upgrade cutover or preserved staging rollback checkout, and it does not automate the integration or upstream publication of personal source modifications. A future distribution mechanism must justify its ownership of installation and upgrade state, define recovery behavior, and add tests and user documentation without making the source-run path depend on it. Any future publication workflow must isolate one approved feature and obtain explicit approval before its first push and draft PR.

Verification covers repository-wide references to the removed entry points, documentation links, generated third-party-notice freshness, the direct `package.json` source command, and a source CLI smoke through the exact `node --import tsx/esm` runtime vector.
