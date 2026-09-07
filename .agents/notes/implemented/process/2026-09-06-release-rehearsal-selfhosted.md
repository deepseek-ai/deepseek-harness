# Agent Note: trusted release rehearsals on persistent Linux runners

Status: implemented

English | [中文](2026-09-06-release-rehearsal-selfhosted.zh.md)

## Problem

Dependency-layout and release-pack rehearsals consume hosted Linux minutes without requiring npm or API credentials. Moving arbitrary pull-request code or credentialed publication onto a persistent shared host would weaken isolation; reusing a checkout without cleaning would also weaken the packed-payload proof.

## Decision

The two jobs in [release.yml](../../../../.github/workflows/release.yml) and the pack job in [release-vendor.yml](../../../../.github/workflows/release-vendor.yml) select the existing self-hosted Linux pool only with the writer-controlled `DSH_CI_FAILOVER_LINUX` repository variable set to `selfhosted`. The selector requires the canonical repository and a non-Dependabot actor, then admits only master pushes or same-repository, non-fork PRs whose author is not Dependabot. Manual dispatch always selects `ubuntu-24.04`, as do all other rejected contexts. The [failover runbook](2026-07-26-ci-failover-runbook.md) owns the platform switches and standby operation. Release rehearsals intentionally share the Linux switch with main CI: enabling or disabling it routes both workloads, not releases independently. Unset remains the hosted default; hosted-minute savings occur only while an operator selects `selfhosted`, whether for an outage or a longer-running cost choice.

The runner labels are `[self-hosted, linux, x64, vm-backup]`. Runner registrations share one VM, not independent machine capacity. Each job uses its runner-private temporary volume for Node compile cache and node-gyp headers before pnpm setup, and a pnpm setup destination qualified by run, attempt, and job. `TMPDIR` also points to `runner.temp`, so temporary npm consumers stay outside the checkout but inside runner cleanup even when a killed process cannot execute `finally`. The persistent pnpm store stays outside checkout cleanup; only GitHub-hosted runners restore the remote store cache. Neither rehearsal workflow saves remote caches.

Checkout explicitly cleans ignored and untracked output before immutable installation and the existing builds. Full tag history, pack concurrency, dependency checks, tarball verification, and artifact retention remain unchanged. The packed-install verifier creates a fresh consumer outside the checkout, installs tarballs with npm, removes inherited Node resolution hooks, and deletes the consumer in `finally`; a warm pnpm store cannot substitute workspace links or stale build output for a tarball payload. The [npm release decision](2026-08-10-npm-release-sequences.md) still owns release families and publication. Both manual publish workflows remain entirely hosted and gain no credentials or registry changes here.

## Alternatives considered

Always-hosted rehearsals avoid persistent-host risk but retain all hosted minutes. Always-self-hosted rehearsals remove the portable fallback. A scheduling job or reusable workflow adds another logical job and hides the three short setup sequences. Allowing manual dispatch on arbitrary refs gives a maintainer action broader persistent-host access than the explicit event trust rule.

## Consequences

Unsetting the variable or changing it away from `selfhosted` routes subsequent eligible jobs to hosted Ubuntu. This is an operator-selected fallback, not automatic runner-health detection or failover for already queued jobs. The shared VM can still contend with other trusted jobs, and repository writers remain responsible for code admitted to its persistent trust domain. No workflow provisions host packages or changes global host configuration.

[scripts/tests/ci-release-selfhosted.spec.ts](../../../../scripts/tests/ci-release-selfhosted.spec.ts) evaluates the committed selectors with trusted events and negative controls for forks, Dependabot, other repositories, non-master pushes, dispatches, missing PR data, and disabled switches. It pins setup ordering, checkout cleanup, hosted-only remote cache access, publication isolation, and the retained commands. Real release-build and packed-install execution remains the PR CI verification owner; selector tests do not claim to reproduce those builds.
