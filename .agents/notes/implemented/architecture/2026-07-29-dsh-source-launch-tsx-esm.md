# Agent Note: dsh source launch through the tsx ESM hook

Status: implemented

English | [中文](2026-07-29-dsh-source-launch-tsx-esm.zh.md)

> Supersedes [native TypeScript source launch](../../archived/architecture/2026-07-28-dsh-native-typescript-source-launch.md): Node removed the capability that decision was built on.

## Problem

The [archived native source-launch decision](../../archived/architecture/2026-07-28-dsh-native-typescript-source-launch.md) ran `apps/cli/src/bin.ts` under `node --experimental-transform-types` with a resolve-only paths loader, so Node owned TypeScript transformation. Node 26.0.0 removed `--experimental-transform-types` (the process rejects the flag with `bad option`), keeping only strip mode, and strip mode rejects syntax this source graph requires: vendored Cordis parameter properties (`constructor(private ctx: Context)`), the `@Inject` decorators in `vendor/hmr`, and runtime enums/namespaces throughout `vendor/` and `packages/workflow`. The repository's engines range (`^22.19.0 || >=24.0.0`) includes Node 26, so the native launch chain could not start at all there — and no CI job executed the real launch vector, so the incompatibility shipped silently.

Startup latency also mattered: the off-thread `module.register()` hooks worker serialized every resolution across threads (~440ms of `makeSyncRequest` wait during TUI boot), and the full tsx default (`--import tsx`) pays ~0.4s in its CJS hook's resolution amplification.

## Decision

The `dsh` TUI, Web, and headless source launches run `node --import tsx/esm`: tsx's ESM-only hook owns both TypeScript transformation and tsconfig `paths` projection. The root `dsh` script uses that vector directly from the repository root; artifact generation is a separate operation under the [source-launch/build separation decision](../../archived/simplification/2026-08-12-separate-source-launch-from-build.md). The CJS hook stays off because the CLI source graph is ESM-only; measured runtime launch to the TUI banner is ~0.7s versus ~1.1s under the full tsx default and ~0.75s under the removed native chain.

`scripts/tspath-loader.ts` and `apps/cli/src/tsconfig-paths-loader.ts` are deleted. With them went the loader's runtime rule of mapping a workspace import only for declared runtime dependencies — tsx applies the `paths` map unconditionally. Declaration completeness now rests on the static gates alone: `verify-cordis-config` for configured bare plugins, and workspace constraints for manifests. (That runtime rule found real bugs: `dsh-plan-mode` and `dsh-tool-jobs` imported `@deepseek-ai/dsh-llm` while declaring it only in devDependencies; since fixed.)

The node-compat CI matrix (Node 22.19 and 26) gains `dsh-source-launch-smoke` (`apps/cli/tests/source-launch.compat.spec.ts`): a keyless piped-stdio launch of the exact production runtime vector asserting the non-zero-exit TTY refusal. Any future Node change to module hooks or TypeScript handling turns this gate red instead of breaking developers' `pnpm dsh`.

## Alternatives considered

**Keep the native chain on Node ≤25 and branch by version.** Rejected: two transformation semantics (amaro versus esbuild) diverge on edge syntax, the launcher grows version probing, and the node-compat matrix must cover both paths — heavy maintenance for an experimental flag that already changed under us. amaro also rejects the `@Inject` decorators `vendor/hmr` uses, so the native path could not boot the shipped default TUI config anyway.

**Make the source graph erasable-only so Node 26 strip mode accepts it.** Rejected: parameter properties and value namespaces pervade vendored Cordis/cosmokit/loader/schemastery; rewriting them is unbounded churn re-applied on every vendor sync.

**A repo-owned in-thread loader (`module.registerHooks()` plus an esbuild or `@swc/core` transform).** Rejected: prototypes measured about 0.45s, while the esbuild path lacked end-to-end validation and SWC failed on `vendor/hmr`'s decorator plus namespace merge in both decorator modes. This option also makes the repository own transform correctness and a resolve hook that tsx already provides. Revisit only if the measured 0.3s gap becomes a material cost.

**Run built `lib/` for Node 26 and keep native for 24.** Rejected: loses the zero-build development loop on the newest Node line and mixes source and artifact planes.

## Consequences

- One launch vector across the whole engines range, including future Node lines that change native TypeScript support; the smoke gate enforces it per matrix line.
- TypeScript transformation is delegated to tsx/esbuild again, reversing the prior note's goal of proving Node-native transformation; that goal is unreachable while vendored sources use non-erasable syntax and Node ships no transform mode.
- The runtime declared-dependency enforcement in source launches is gone; undeclared workspace imports now surface only through static gates or built-mode resolution failures.
- Runtime launch improves ~0.4s over the full tsx default; ACP keeps `--import tsx` because its graph was not audited for CJS-hook dependence and its launch latency is not on the interactive path.
