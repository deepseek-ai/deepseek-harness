# Agent Note: Oxlint-only fix workflow

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-09-oxlint-only-fix-workflow.zh.md)

## Problem

The [repository linter migration](2026-07-29-oxlint-linter.md) retained a formatting-only ESLint invocation because Oxlint's JavaScript-plugin bridge was treated as validation-only. The pinned Oxlint toolchain executes the safe fixers supplied by `@stylistic/eslint-plugin`, so the separate formatter duplicates a configuration boundary, command startup, and direct `eslint` plus `@typescript-eslint/parser` dependencies.

A single Oxlint invocation is not an equivalent replacement. Overlapping plugin fixes can apply one change while leaving a newly exposed diagnostic; the repository's `semi` and `object-curly-spacing` fixture requires a second pass before it is clean. The workflow must retry that case without printing obsolete first-pass diagnostics.

## Decision

All repository lint and fix workflows invoke Oxlint through [`scripts/run-oxlint.ts`](../../../../scripts/run-oxlint.ts). Normal validation remains one process with inherited output. An invocation containing `--fix`, `--fix-suggestions`, or `--fix-dangerously` captures the first Oxlint result; success emits its stdout and stderr on their original channels, while a completed non-zero run discards its potentially obsolete diagnostics and runs the same command once more with inherited output. The runner re-raises a child signal instead of retrying or converting it to an exit code, and the second process completion is final.

The `lint:fix` package script and staged lefthook job use that runner directly. The type-aware root profile still ignores preserved TypeGraph fixture shapes that `oxlint-tsgolint` cannot analyze; the project-free staged profile re-includes that directory, carries its intentional `any` and quote exceptions, and applies its style fixes before the full type-aware fix pass. The formatting-only ESLint configuration and the direct `eslint` and `@typescript-eslint/parser` development dependencies are absent. `@stylistic/eslint-plugin` and `eslint-plugin-sonarjs` remain Oxlint JavaScript plugins because they preserve enforced rules; pnpm still installs ESLint as their declared peer, but no repository configuration or workflow invokes it.

## Verification

The executable lint contract drives a deliberately overlapping style violation through the repository runner and requires a successful exit plus exact final bytes. The same contract pins the complete Stylistic rule set, project-free TypeGraph fixture coverage, the package scripts, the staged hook command, the deleted formatter configuration, and the absence of direct ESLint parser and runner dependencies. Existing executable probes continue to cover the Stylistic and SonarJS compatibility plugins, project-free staged validation, and type-aware project discovery.

## Alternatives considered

**Keep the formatting-only ESLint pass.** This preserves ESLint's built-in multipass behavior but retains a second runner, a duplicated formatting config, and direct dependencies after Oxlint can execute the same plugin fixes.

**Run Oxlint once with `--fix`.** This is simpler, but overlapping safe fixes can leave the command partially formatted and non-zero even though another identical pass completes it.

**Adopt Oxfmt.** A formatter migration changes the repository's output contract and would create an unrelated formatting diff. It remains a separate decision from removing the redundant ESLint execution path.

**Remove the JavaScript compatibility plugins.** This would eliminate their ESLint peer graph but would also drop the enforced Stylistic and SonarJS rules. Dependency-tree purity does not justify weakening the quality contract.

## Consequences

Contributors, package scripts, hooks, and CI have one lint runner and one rule configuration. The staged profile repeats the root ignore list so it can re-include formatter-only fixtures without exposing vendor or generated files. A completed non-zero fix invocation always pays for one retry, including a stable unfixable error. The first pass buffers each output stream up to 64 MiB so obsolete diagnostics are not printed when the retry succeeds; process creation and capture failures, including that limit being exceeded, surface immediately without a retry.

The dependency lock can still contain ESLint through plugin peer resolution. Removing that transitive package requires native replacements or a formatter decision that also replaces the compatibility plugins; it is not part of the workflow simplification.
