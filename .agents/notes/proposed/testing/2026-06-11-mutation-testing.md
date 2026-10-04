# Agent Note: Mutation testing as the coverage counterweight

Status: proposed

English | [中文](2026-06-11-mutation-testing.zh.md)

## Problem

The per-file 100% coverage gate ([the quality-gates reference](../../../../docs/testing.md)) proves every line *executes* under test — not that any assertion would notice if the line were wrong. Under agent-written tests, coverage pressure can produce execution-without-assertion. Mutation testing measures what coverage cannot: whether the suite *kills* deliberately injected bugs.

## Proposal

Stryker (`@stryker-mutator/vitest-runner`) over `packages/*/src`:

- **PR-scoped incremental runs** (changed files only) as a CI job — fast enough to gate merges once tuned.
- **Nightly full runs** with a tracked mutation score; start by recording, then set the threshold at the observed baseline and ratchet upward (same policy as coverage: thresholds only ever tighten).
- Surviving mutants are work items: an agent picks a survivor, writes the killing test, repeats — a well-shaped autonomous loop.
- Equivalent mutants (provably behavior-preserving) get annotated exclusions with reasons, mirroring the `/* v8 ignore */` policy.

## Plan

1. Add Stryker config scoped to one package (llm — smallest, most algorithmic) and measure runtime.
2. Expand to all packages; record baseline scores in the config.
3. Wire the nightly job; add the incremental PR job once runtime is acceptable.

## Acceptance criteria

- A Stryker config runs over `packages/*/src` with the vitest runner; a nightly job records the mutation score, and a ratcheting threshold fails the run when the score drops below the recorded baseline.
- PR-scoped incremental runs gate merges once runtime is acceptable — or are explicitly kept nightly-only, with that outcome recorded here.
- Equivalent mutants carry annotated exclusions with reasons, mirroring the `/* v8 ignore */` policy.

## Risks

Runtime: mutation testing is expensive; per-file 100% coverage helps (every mutant is at least reached). If PR-scoped runs stay too slow, keep them nightly-only and rely on the score ratchet.

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
