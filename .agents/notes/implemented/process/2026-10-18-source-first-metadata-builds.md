# Agent Note: Generate metadata before package compilation

Status: implemented

English | [中文](2026-10-18-source-first-metadata-builds.zh.md)

## Problem

A Host package can consume generated Remote declarations without becoming a Client package. Generating metadata during Host bundling forces the build to identify those consumers, delay their compilation, and propagate that delay to their callers. TypeScript project references already describe the package dependencies; maintaining another source-import graph duplicates ordering work.

## Decision

Artifact and declaration-only builds run source-only Typert generation before package compilation. The existing generator rejects workspace build outputs and unresolved workspace imports, so a metadata producer cannot depend on its own generated declarations through another source package. TypeScript retains compiler-face ownership and rejects project-reference cycles. Generation failure stops dependent compilation and bundling.

The root bundler uses `decoratorPlugin()` to lower standard TypeScript decorators without generating metadata again. The public `typertPlugin()` retains package/workspace generation and its Worker Thread behavior. [Development](../../../../docs/development.md#typescript-project-layout) owns the current command order.

This ordering replaces only the generation placement in [local gate speed-ups](2026-10-12-local-gate-speedups.md), [lossless build speed-ups](2026-10-11-lossless-build-speedups.md), [the build/check split](2026-10-11-build-artifacts-check-split.md), and [Remote method generation](../architecture/2026-08-02-typert-remote-method-calls.md). Their other optimizations, failure guarantees, public plugin behavior, and historical measurements remain useful and stay active.

## Measurements

The local experiment uses macOS ARM64, Node 24.19.0 and TypeScript 6.0.3. `DSH_GATE_CONCURRENCY=1 pnpm run build:artifacts --profile official` runs baseline/candidate/candidate/baseline. Each run starts after `pnpm run clean`, then repeats without source changes. Installation and cleanup are excluded; native preparation, package compilation, bundles, Desktop, Web and build-record publication are included. Other owned heavy jobs pause; unrelated host load remains possible. Filesystem caches are not flushed.

| Inputs | Clean baseline / candidate (s) | No-change baseline / candidate (s) | Clean peak RSS baseline / candidate (MiB) |
|---|---|---|---|
| Without Node Session consumers | 56.67, 53.55 / 56.29, 56.37 | 13.64, 13.74 / 15.32, 15.26 | 3855, 3858 / 3255, 3268 |
| Separate prototype: Node Session consumers and delayed-stage removal | 61.18, 61.41 / 56.27, 56.44 | 20.08, 20.09 / 15.98, 16.09 | 4013, 4012 / 3278, 3291 |

RSS is summed over descendant processes approximately every 100ms; shared pages count more than once, so this is not unique physical memory. Two samples per case are local evidence, not a CI budget. All 150 generated Typert/Remote files are byte-identical in both comparisons. Complete inventories contain 12,246 and 12,352 files respectively; only the changed decorator-plugin module's four compiler outputs differ.

## Alternatives considered

**Keep generation inside Host bundling.** It preserves overlap and the faster standalone no-change build, but consumers of generated declarations require a separate delayed compilation schedule.

**Hand-maintain delayed packages or change their compiler faces.** Both make package ownership depend on build placement and add an inventory beside project references.

**Use source-first generation only for type checks.** Artifact builds would still need the consumer scanner, leaving two schedules to maintain.

**Remove the public generation plugin.** Its package/workspace API and Worker Thread failure ownership remain supported; repository scheduling does not justify deleting that API.

## Consequences

The consumer row is evidence from a separate integration prototype. It does not describe the packages or validation delivered by this prerequisite.

The standalone prerequisite costs 1.60s (+11.7%) in median no-change artifact time because generation no longer overlaps bundling. Its clean difference is +1.22s, smaller than the baseline spread. This is ordering support, not an independent speedup. With delayed stages removed, the measured consumer build improves by 4.94s clean and 4.05s without changes. Peak summed RSS decreases in both cases.

Source-generation tests reject metadata dependency cycles with absent and preexisting outputs. A fresh Host-consumer fixture compiles against metadata generated in the same build. Decorator tests exercise both plugin entry points, and complete builds verify application artifacts. Wine's separate command sequence prepares metadata explicitly; its source guard rejects missing preparation, while native Windows execution remains CI-owned.
