# Agent Note: verify-cordis-config gates source-plane resolution of configured plugins

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-30-cordis-config-source-plane-resolution-gate.zh.md)

## Problem

`apps/cli/config/tui.cordis.yml` gained the `@deepseek-ai/dsh-tui/prompt` entry without a matching tsconfig `paths` mapping. The generic `@deepseek-ai/dsh-*` wildcard substitutes `tui/prompt` whole into its `<group>/*/src` candidates, none of which exist, so the [tsx source launch](../architecture/2026-07-29-dsh-source-launch-tsx-esm.md) fell back to package `exports` and resolved `lib/prompt.js` — an artifact-plane file. Every environment with a built `lib/` (developer trees after `pnpm build`) booted fine, and the e2e workflow runs the keyless TUI PTY smoke in `lib` mode (`DSH_EXAMPLE_MODE=lib`, built bin under plain Node) so CI never exercises the source vector at all — while every clean checkout failed `pnpm dsh` at startup with `plugin(s) failed to load: @deepseek-ai/dsh-tui/prompt`. No gate checked the source plane, so the breakage shipped silently and surfaced only in fresh worktrees.

## Decision

`scripts/verify-cordis-config.ts` (`validateSourcePlaneResolution`) requires every configured specifier of a local workspace package — harness packages and vendored Cordis alike — to resolve through the `tsconfig.base.json` `paths` facade to a `.ts`/`.tsx` source file, using `ts.resolveModuleName` from the repository root. A failed resolution or a `.d.ts` hit (the `exports` fallback into built `lib/types`) fails `verify-cordis-config`, naming the config files and the specifier. The missing `@deepseek-ai/dsh-tui/prompt` mapping is added next to the other explicit subpath entries; removing it reproduces the gate failure.

## Alternatives considered

**Rely on the keyless TUI PTY smoke.** In default source mode it boots the real tree through the source vector and does catch the failure — but only on a clean tree. CI's e2e workflow runs it exclusively in `lib` mode (the built bin resolving real package `exports`), so no CI line runs the source vector, and developer trees with a stale `lib/` stay masked locally. Adding a source-mode CI smoke proves one composition per run; the static gate covers every shipped and example config.

**Broaden the `dsh-source-launch-smoke` compat test to full boot.** The node-compat smoke asserts only the TTY refusal, which happens before plugin loading. A full keyless boot per matrix line duplicates the PTY smoke at higher cost and, like it, proves one composition rather than every shipped and example config.

**A `@deepseek-ai/dsh-*/prompt`-style wildcard mapping.** Fixes this one subpath but not the class; the next single-file subpath export (`/surface`, `/message`, …) regresses identically. The static gate covers all current and future configured specifiers.

## Consequences

- A configured workspace specifier that resolves only through built `lib/` is now a red `verify-cordis-config` (in `hygiene` and CI) instead of a clean-tree-only startup crash.
- New single-file subpath exports referenced from a cordis.yml need an explicit `tsconfig.base.json` `paths` entry at introduction time; the gate message says so.
- The gate resolves with `tsconfig.base.json` options only; a specifier needing client-only compiler options to resolve would fail it, which matches the facade's role as the single resolution surface for tsx and vitest.
