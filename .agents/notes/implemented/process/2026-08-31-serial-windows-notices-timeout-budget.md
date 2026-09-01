# Agent Note: serial-windows notices timeout budget and generator store-scan cost

Status: implemented

English | [中文](2026-08-31-serial-windows-notices-timeout-budget.zh.md)

## Problem

The `serial / windows (self-hosted standby)` master lane failed its `test:coverage` gate four times in a week (runs 33333033178, 33311481884, 33352293522, 33353113100), always on the same case: `scripts/gen-third-party-notices.spec.ts > THIRD_PARTY_NOTICES.md > matches what the generator produces from the current manifests`, with `Error: Test timed out in 5000ms`. Measured test wall times on the shared Windows host were 4149–8853 ms against Vitest's default 5000 ms per-test budget. All other 26 cases in the file finished in 0–3 ms, and the passing run two hours later (33360033028) had the same code green.

The lane runs the complete unsharded Windows gate inventory serially with `DSH_COVERAGE_MAX_WORKERS=1`, so `render()` regenerates `THIRD_PARTY_NOTICES.md` from the workspace manifests and the installed pnpm store on a host shared by 32 runners. The cold path is dominated by `workspaceLinkedManifest`, which re-ran `loadWorkspaceManifests()` — a glob plus reads and JSON-parses of every workspace `package.json` — once per cache-missing external dependency name: 130 names × 270 manifests ≈ 35k file operations, on top of a `.pnpm` store scan per name. Under v8 coverage instrumentation and shared-host I/O contention that crossed the 5 s default.

The lane also had no `DSH_COVERAGE_TEST_TIMEOUT_MS`, unlike the pull-request `windows-coverage` lane ([ci.yml](../../../../.github/workflows/ci.yml)) which grants 90000 ms, so the serial reference ran the same coverage inventory at the strictest budget of any lane.

## Decision

Two changes:

1. [scripts/gen-third-party-notices.ts](../../../../scripts/gen-third-party-notices.ts) loads the workspace manifests once in `render()` and threads the map through `collectNpmDeps` → `installedMetadata` → `installedManifest` → `workspaceLinkedManifest` instead of reloading it per external dependency name. The cold `render()` wall time on the same checkout fell from ~893 ms to ~86 ms with byte-identical output (verified by diffing the rendered documents before and after the change).

2. [ci-master.yml](../../../../.github/workflows/ci-master.yml) `serial-windows` step "Run complete unsharded Windows gate inventory serially" gains `DSH_COVERAGE_TEST_TIMEOUT_MS: '90000'`, matching the pull-request `windows-coverage` lane budget. This extends the per-test, expect.poll, and hook budget mechanism defined by [the Windows lane hook and Lefthook budget note](../testing/2026-08-29-windows-lane-hook-and-lefthook-budget.md) to a second lane; that note records which lanes set the env. `scripts/ci-workflow.spec.ts` pins this env with a `toMatchObject` assertion; removing the env turns the spec red (negative control exercised).

## Alternatives considered

- **Raise the lane budget only** - rejected as the sole fix: it would mask the O(names × manifests) reload for every lane that runs the generator, including the pre-commit hook and the standalone `--check` path.
- **Module-level cache for `loadWorkspaceManifests()`** - rejected in favor of explicit threading, which keeps the single-load contract visible at the call site and avoids a second hidden cache next to `workspaceLinkedManifestCache`.

## Consequences

The generator resolves installed metadata from one manifest load per `render()` call, and clears the name-keyed linked-manifest cache at the start of each call so the cache cannot outlive the map it was resolved from. The serial-windows lane runs the coverage inventory at the same 90000 ms per-test budget as the pull-request coverage lane. `THIRD_PARTY_NOTICES.md` bytes are unchanged; the freshness spec still compares `render()` against the committed document.
