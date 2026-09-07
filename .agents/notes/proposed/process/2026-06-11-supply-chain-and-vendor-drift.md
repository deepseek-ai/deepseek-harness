# Agent Note: Supply chain checks and vendor drift verification

Status: proposed

English | [中文](2026-06-11-supply-chain-and-vendor-drift.zh.md)

## Problem

The vendor manifest ([the vendoring decision](../../archived/process/2026-06-11-vendor-cordis-as-source.md)) is enforced at commit time in the *forward* direction (vendored change ⇒ manifest update) but nothing verifies the manifest's *claims*: that vendor/ actually equals upstream-at-SHA plus exactly the logged modifications. And the handful of true npm dependencies have no advisory monitoring or update cadence.

## Proposal

1. **Vendor drift check** (nightly CI): clone the upstream repos at the manifest SHAs (shallow), copy the corresponding package sources, and diff against `vendor/*/src`. The job fails unless the diff matches the logged local modifications (kept as a checked-in patch file per modification — the log entries become verifiable artifacts rather than prose).
2. **Dependency advisories**: osv-scanner (or `pnpm audit`) job on the lockfile, scheduled + on lockfile-touching PRs.
3. **License inventory**: a script asserting every vendored package carries its LICENSE and that package.json `license` fields match the inventory in vendor/README.md (we mix vendored MIT with our BSD-3) — CI step.
4. **Renovate** (or a scheduled agent task) proposing npm dependency updates in small PRs that ride the full gate suite; vendored packages are excluded (their updates follow the manifest sync procedure, ideally as a semi-automated agent workflow: fetch upstream, re-apply patches, run gates, open PR with the manifest table updated).

## Plan

3 is trivial — do first. 1 requires network access from CI to the upstream repos (private — needs a token) and converting the two existing logged modifications into patch files. 2 and 4 are config.

## Alternatives considered

- **`pnpm audit` instead of osv-scanner** — either satisfies the advisory-scanning shape; the choice is deferred to implementation.
- **A scheduled agent task instead of Renovate** — equivalent for proposing small update PRs that ride the full gate suite; vendored packages stay excluded either way (their updates follow the manifest sync procedure).

## Acceptance criteria

- The license inventory script runs in CI and fails on a missing LICENSE or a `license` field that contradicts the inventory in `vendor/README.md`.
- The nightly drift job reconstructs `vendor/` from the manifest SHAs plus checked-in patch files and fails on any unexplained diff.
- Advisory scanning runs on the lockfile on schedule and on lockfile-touching PRs.

## Risks

Upstream repos are private mirrors; CI credentials and availability are the main friction for the drift check. If blocked, run it as a local scheduled agent task instead of CI.
