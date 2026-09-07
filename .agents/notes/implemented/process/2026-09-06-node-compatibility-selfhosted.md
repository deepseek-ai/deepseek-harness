# Agent Note: Isolated Node compatibility jobs on self-hosted Linux

Status: implemented

English | [中文](2026-09-06-node-compatibility-selfhosted.zh.md)

## Problem

The Node 22.19, 24.9, and 26 compatibility jobs consume hosted Linux minutes even when the repository has selected its existing self-hosted Linux pool. Moving version installers onto a persistent shared machine can create tool-directory collisions and accumulate generated cache files outside runner cleanup.

## Decision

[CI](../../../../.github/workflows/ci.yml) applies the Linux failover variable to these three jobs, requiring a non-Dependabot author and a non-fork head repository matching the current repository. The standard hosted fallback remains available. These predicates constrain this job, not every workflow admitted to the pool. Both repository identity and fork status remain explicit to preserve its trust restriction if repository settings change; existing sibling selectors are outside this migration.

The temporary tool cache trades repeated Node downloads for isolation across concurrent runners and Node versions. A setup-node-only [ESM preload](../../../../scripts/ci-compatible-toolcache.mjs) assigns the cache inside the action process: the Actions runner overwrites reserved environment variables after reading step configuration. An executed path check rejects installations outside runner temp; compatibility processes do not inherit the preload. pnpm keeps its existing private setup destination and persistent content-addressed store. Compile caches and node-gyp headers use runner temp before the first pnpm invocation. No global Node symlink or system package changes are introduced. Hosted jobs retain their tool and package caching; self-hosted jobs do not restore or upload hosted package caches. The runner owns temporary-directory cleanup between jobs, and the shared image supplies native npm packages’ compiler and Python prerequisites.

The [failover runbook](2026-07-26-ci-failover-runbook.md) remains the owner of repository trust and pool switching. The [serial reference decision](2026-07-21-serial-cross-platform-ci-reference.md) remains the owner of master scheduling. Neither decision is superseded beyond the compatibility jobs' runner selection; both remain active.

## Alternatives considered

**Keep all compatibility jobs hosted.** This avoids extra shared-host load but continues paying for Linux runtime checks that do not require a different operating system or architecture.

**Use the shared Node installation or global version-manager links.** The jobs must run different Node releases concurrently. Mutable shared links would make the selected version depend on another job's timing.

**Move the Python SDK job in the same change.** Its setup-python installation and global pip installation of uv need separate isolation evidence. Its short hosted job is not required for the Node optimization.

## Consequences

The pool receives three additional jobs per trusted PR; each retains gate concurrency one, including the build-backed Node 22 leg. The September 6 inventory reports 31 Linux registrations, not 31 independent machines. The shared VM's contention and download latency remain rollout risks; the variable preserves hosted recovery. Test inventory, check names, and master scheduling are unchanged.

## Verification

The focused [workflow regression](../../../../scripts/ci-compatible-selfhosted.spec.ts) executes the actual routing expressions and environment setup. A negative control removing the fork condition fails the hosted-fallback assertion. It checks Dependabot reruns by a maintainer, repository mismatch, fork flags, disabled variables, and runner-scoped cache paths.

[Successful standby run 33984559660](https://github.com/deepseek-harness/deepseek-harness/actions/runs/33984559660) at the implementation base supplies Linux Node 24.19.0 and Windows Node 24.20.0 baseline evidence. Linux job 101359402557 uses runner-specific temporary and tool directories on the data volume. [Read-only capability probe 34012679056](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34012679056/job/101431064925) reports Linux x64, 192 online logical CPUs, GCC/G++ 13.3, Make 4.3, and Python 3.12.3. Python 3.10 is absent, reinforcing the separate SDK provisioning requirement. [PR run 34013779750](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34013779750) at `282519d2` verifies Node 22.19.0, 24.9.0, and 26.8.1 on self-hosted Linux, including setup, executable-path checks, compatibility tests, and post actions. The executables reside under each runner’s `_temp/node-compat-toolcache/node/<version>/x64/bin`; the completed jobs take 228s, 94s, and 101s respectively. These observations establish version and path compatibility, not an exclusive-host capacity guarantee.
