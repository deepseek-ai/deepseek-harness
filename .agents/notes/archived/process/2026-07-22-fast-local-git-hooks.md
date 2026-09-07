# Agent Note: Fast local Git hooks

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-22-fast-local-git-hooks.zh.md)

## Problem

An agent already runs the tests and checks that exercise its change, while commit, push, and CI can each repeat increasingly broad subsets of the same work. A full pre-push suite therefore delays every publication, amplifies unrelated local flakes, and gives no new signal when CI immediately runs the exhaustive matrix again.

Fast hooks still need to reject cheap, high-confidence defects before work leaves the machine. Staged formatting, whitespace errors, missing vendored-source metadata, and repository type errors fit that boundary; unit suites, snapshots, documentation checks, builds, and package hygiene vary with the changed surface and do not.

## Decision

[lefthook.yml](../../../../lefthook.yml) keeps both hooks as bounded local checkpoints. Pre-commit runs sequentially: a project-free [Oxlint](2026-07-29-oxlint-linter.md) profile validates changed JavaScript and TypeScript, applies safe fixes with a [bounded retry](2026-08-09-oxlint-only-fix-workflow.md), and re-stages them; `git diff --cached --check` rejects staged whitespace errors, and the vendor manifest guard checks vendored-source metadata. Pre-push runs `pnpm run typecheck`, which prepares the generated Host Typert contracts before the Client incremental typecheck.

Pre-commit does not run type analysis, tests, snapshots, documentation checks, builds, hygiene, or the gate scheduler. Pre-push adds only the Host contract build required by repository typecheck. The opt-in `check:all` package script selects the `check-all` scheduler inventory in [scripts/run-gates.ts](../../../../scripts/run-gates.ts) independently of the hooks; it is a contributor command, not an agent instruction.

Agents inspect the outgoing diff and run the narrowest tests and checks that cover its behavior once. CI owns exhaustive coverage, built-artifact checks, and the platform matrix. A complete local rehearsal is reserved for an explicit request, CI diagnosis, or a repository-wide change that cannot be validated credibly by narrower evidence.

## Supersedes

This decision supersedes the local-hook portion of [Parallel pre-push gates](2026-07-06-parallel-pre-push-gates.md) and the hook/CI symmetry in [Mechanical quality gates over prose guidelines](2026-06-11-quality-gates.md). Their CI scheduler, package-gate, and mechanical-enforcement decisions remain in force.

## Alternatives considered

- **Keep the full pre-push suite and optimize its scheduler** — preserves the earliest exhaustive signal but still repeats agent-selected evidence and CI, while unrelated failures continue blocking publication.
- **Remove pre-push entirely** — makes pushes cheapest but loses the fast cross-file guarantee that TypeScript provides after several commits.
- **Keep typecheck in pre-commit** — catches type errors earlier but charges every intermediate commit instead of one push; staged lint already covers the commit-local syntax and style boundary.
- **Make staged lint check-only** — avoids hook-side mutation, but contributors intentionally retain the auto-fix workflow; Oxlint's bounded retry and Lefthook's `stage_fixed` preserve it without a separate formatter or duplicate `git add`.

## Consequences

Normal commits take the project-free staged Oxlint fix-and-validate critical path, and warm pushes take the prepared incremental typecheck critical path. Contributors retain a one-command opt-in rehearsal without widening the hook critical paths or the agent-required validation set. Hook latency is observed in development and PR evidence rather than enforced by a timing test whose result would depend on host load and cache state.

Local publication no longer proves the exhaustive repository matrix. Agents must select relevant behavioral evidence, reviewers must evaluate whether that selection matches the diff, and CI supplies the comprehensive signal once per pushed revision.
