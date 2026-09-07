# Agent Note: Redirect the Node compile cache to the data-volume runner temp

Status: implemented

English | [中文](2026-08-28-ci-node-compile-cache-data-disk.zh.md)

## Problem

The self-hosted Linux CI VM (`vm-backup` pool, 32 runner instances on one host) exhausts the root partition's inode capacity. Issue #3134's residue (`/tmp/dsh-*`) is one source; a second, larger source is the Node.js module compile cache. Tools in the CI toolchain call `module.enableCompileCache()` explicitly: pnpm 11.7.0 enables the cache in its entry (`module.enableCompileCache?.()` in `bin/pnpm.mjs`) on every invocation, and TypeScript does so in `tsc`/`tsserver`; vitest forwards the API but does not enable it itself. Every such call writes the serialized V8 bytecode cache under `os.tmpdir()/node-compile-cache`. On the shared VM that is the root partition's `/tmp`: measured 2026-08-28 at **697,389 inodes and 9.2 GB**, with 34,110 files younger than 1 hour — the cache grows on every CI run and is never cleaned, so the root partition's 3,276,800 inodes trend toward exhaustion even after the `dsh-*` residue is controlled.

## Decision

Each Linux lane that can run on the `vm-backup` pool under failover (`ci.yml` static/coverage/snapshots — hosted by default, self-hosted only when `DSH_CI_FAILOVER_LINUX=selfhosted` — and `ci-master.yml` serial standby, always self-hosted) redirects `NODE_COMPILE_CACHE` to the per-runner data-volume temp dir `${{ runner.temp }}/node-compile-cache`. `runner.temp` lives on `/data_local` (1 TB, ~1% inode used) and is per-runner (`_workNN/_temp`), so the cache stops consuming root-partition inodes.

The redirect is a step right after `actions/checkout` that writes `NODE_COMPILE_CACHE=${{ runner.temp }}/node-compile-cache` into `$GITHUB_ENV`, so every later step in the lane — `pnpm/action-setup`, the store-path probe, install, Playwright install, and the test gate — inherits it. Injection is required because the `runner` context is unavailable in job-level `env` (the same constraint as the earlier TMPDIR work), and a step-level env on the gate step alone would leave the earlier pnpm calls writing to the root partition's `/tmp`. A confined child (bwrap/Landlock) whose sandbox does not grant the `runner.temp` path inherits the variable but **silently skips caching** — verified on the VM: with `NODE_COMPILE_CACHE` pointing at an ungranted path inside bwrap, `node` runs normally (exit 0), unlike `mkdtemp` which fails hard with a read-only filesystem error. The compile cache is best-effort by design; a failed write is a cache miss, not a crash.

## Verification

- VM probe: `NODE_COMPILE_CACHE=/data_local/ci/compile-cache-probe node -e 'require("node:fs")'` wrote a `v22.23.2-x64-*` cache subdirectory on the data disk (location switch effective).
- VM probe (bwrap): with `NODE_COMPILE_CACHE` set to a path the bwrap profile does not grant, `node` ran normally (exit 0) — cache write failure is tolerated.
- `scripts/ci-workflow.spec.ts` asserts every Linux lane injects `NODE_COMPILE_CACHE=${{ runner.temp }}/node-compile-cache` (a `$GITHUB_ENV` `KEY=VALUE` line) into `$GITHUB_ENV` before `pnpm/action-setup`; the position assertion fails if the injection moves after the first pnpm call.
- CI lanes: the three required Linux jobs (hosted by default, self-hosted `vm-backup` under `DSH_CI_FAILOVER_LINUX`) run the full suite under the new env; a regression in cache handling would surface as lane failure.

## Alternatives considered

### Why not disable the compile cache entirely?

`NODE_DISABLE_COMPILE_CACHE=1` would stop root-partition growth immediately but forfeit the startup speedup on every run, and the cache is a legitimately useful Node feature (enabled explicitly by pnpm and TypeScript). Redirecting preserves the benefit while moving the cost off the constrained partition.

### Why not add `node-compile-cache` to the `dsh-*` residue sweep?

The CI sweep (added in the residue-cleanup change) targets test residue; the compile cache is a cache, not residue. Deleting it every run would discard the speedup the cache exists to provide. Redirecting is the structural fix: the cache's growth moves to the volume sized for it.

### Why not job-level env or gate-step env only?

The `runner` context is only available in step-level `env`; job-level `env` evaluates it to an empty string (GitHub contexts-availability), which would silently leave the cache on the root partition. A step-level env on the gate step alone would cover only that step: every earlier pnpm invocation in the lane (setup, store-path probe, install) would still write to the root partition's `/tmp`. Injecting into `$GITHUB_ENV` in a step between checkout and `pnpm/action-setup` sets the variable before the lane's first pnpm call, so one step covers the whole lane.

## Consequences

- **Bought**: the Node compile cache stops consuming root-partition inodes; inode pressure from this source is removed without losing the cache's startup benefit. The cache now lives in per-runner `_workNN/_temp` on the data volume.
- **Cost**: the cache accumulates in `runner.temp`, which the runner does not empty between jobs (measured earlier) — but on the data volume (~1% inode used) that is harmless.
- **Cost**: confined children without the `runner.temp` grant skip caching for their own `node` invocations; this is a cache miss, not a failure, and matches Node's best-effort contract.
- **Cost**: the change touches CI configuration only; local development keeps the default `os.tmpdir()` location.
