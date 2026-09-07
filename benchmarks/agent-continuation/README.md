# Backend continuation benchmarks

English | [中文](README.zh.md)

## Summary

Measure long-history request processing, cold tool-heavy continuation, and repeated discovery of inactive fork children without network services or recorded user data. The SDK variant drives 100 turns and 800 real file reads through the shipped sdk-minimal profile; other cases isolate backend service costs. No case renders a browser.

## Table of Contents

- [Run](#run)
- [Measurements](#measurements)
- [Dev Note](#dev-note)

<a id="run"></a>

## Run

From the repository root, build the libraries and workers with `pnpm run build:bench`, then run `pnpm exec vitest run --config vitest.bench.config.ts benchmarks/agent-continuation/agent-continuation.bench.ts`. Do not overlap timing runs with builds or other benchmarks.

The test reports all five fresh-process samples and enforces reviewed median budgets. Catalog and tool continuation each use a 900 ms standard hosted CI expectation with 1.25× headroom (1,125 ms); request history uses a 190 ms hosted expectation with the same headroom (238 ms), and SDK continuation uses reference-machine scaling. A failed worker reports its exit, signal, timeout, and stderr; temporary roots are removed even on failure. The required benchmark lane discovers this file automatically.

<a id="measurements"></a>

## Measurements

[workload.ts](workload.ts) owns synthetic dimensions. [The Agent Note](../../.agents/notes/implemented/testing/2026-09-06-backend-continuation-performance.md) owns timing endpoints, calibration evidence, memory interpretation, and exclusions. The model adapter does not perform provider serialization or network calls; integrated cases run synthetic tool bodies through the real tool-execution pipeline, while the SDK profile variant performs real file reads.

## Dev Note

None.
