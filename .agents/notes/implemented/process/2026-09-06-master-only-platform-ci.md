# Agent Note: Master-only platform CI

Status: implemented

English | [中文](2026-09-06-master-only-platform-ci.zh.md)

## Problem

Python runtime builds on macOS Intel and ARM and Linux ARM64, plus Windows build/site checks through Wine, consume paid hosted capacity on each pull-request revision. Native Linux and Windows x64 already provide required executable and installed-wheel evidence, and native Windows checks cover the build and process behavior before merge.

## Decision

[CI](../../../../.github/workflows/ci.yml) requires Python runtime validation on Linux x64 and Windows x64. [CI master](../../../../.github/workflows/ci-master.yml) selects Linux ARM64, macOS ARM64, and macOS x64 through the same reusable builder on master pushes only. Both callers pass `ci: true` and the explicit external API secret, preserving complete keyless installed-wheel scenarios and fail-loud trusted live tests. Fork and Dependabot pull requests remain keyless; runner trust and fallback selectors are unchanged. Python releases retain all five targets.

Wine runs once as an independent hosted Ubuntu master job. Its existing image-keyed apt cache restore/save also supplies default-branch cache production, so it needs no separate cache-seeding job. The native Linux and Windows serial aggregates do not invoke Wine. Keeping Wine hosted avoids shared-host apt transactions and shared Wine-prefix cleanup on the persistent Linux VM. The script owns a scratch snapshot, a checkout-local Wine prefix, and a checksum-verified Windows Node cache; provisioning, failure propagation, and always-run cleanup remain intact.

The parent and reusable runtime workflows preserve running master-push checks against subsequent master pushes. GitHub concurrency still permits replacement of pending runs; manual benchmarks can cancel the parent run. A master push schedules all three selected carriers but does not guarantee every intermediate commit reaches a result. PR, manual, and release cancellation retain their existing behavior.

This decision partially supersedes scheduling in the [installed-wheel validation](../testing/2026-08-23-installed-python-wheel-black-box-ci.md), [native Windows CI](2026-08-08-native-windows-pull-request-ci.md), [serial references](2026-07-21-serial-cross-platform-ci-reference.md), and [failover runbook](2026-07-26-ci-failover-runbook.md). Those notes remain active for artifact provenance, platform fidelity, serial completeness, and trust rules.

## Alternatives considered

**Keep every target and Wine required on pull requests.** This detects platform-specific defects before merge but repeats paid native builds for every revision. The chosen policy explicitly accepts post-merge discovery for these four checks.

**Wait until release or require manual dispatch.** This loses the automatic default-branch signal. Master pushes retain scheduled checks without shrinking the release matrix.

**Fold Wine into a self-hosted serial aggregate.** The aggregate does not already cover Wine. Adding it would change persistent-host dependencies, shared cache ownership, and cleanup isolation; the scheduling optimization does not need that migration.

## Consequences

A macOS, Linux ARM64, or Wine-specific regression can merge while required PR checks are green. Master failures remain ordinary failing jobs, not `continue-on-error` observations. Linux/Windows x64 installed-wheel checks and native Windows build/process checks continue to block the PR aggregate; its dependencies never name the removed Wine PR job.

The [routing regression](../../../../scripts/tests/ci-master-platforms.spec.ts) runs through the existing script-spec coverage inventory and checks target partitioning, master-only conditions, credential forwarding, cancellation, Wine uniqueness, valid aggregate dependencies, and the full release matrix. Executed negative controls remove the Intel target, misroute Wine, and restore the stale aggregate dependency; each produces its intended failure. Real platform execution remains CI-owned; local scheduling tests do not claim native runtime or Wine execution.
