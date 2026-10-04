# Session corpus benchmarks

English | [中文](README.zh.md)

## Summary

Measure the Web Host's Session list, content search, and fork over synthetic corpora in which every Session is at least as long as the same quantile of a measured local DSH corpus. Search and fork run over separate 1,000-Session corpora; the list runs over 3,000, the largest count that keeps this file within five minutes on standard hosted CI. Content search models a deployment that opts in with `openAt: first-search`; shipped profiles disable it. No case uses network services, recorded Sessions, or a browser.

## Table of Contents

- [Run](#run)
- [Measurements](#measurements)
- [Dev Note](#dev-note)

<a id="run"></a>

## Run

From the repository root, build the libraries and workers with `pnpm run build:bench`, then run `pnpm exec vitest run --config vitest.bench.config.ts benchmarks/session-corpus/session-corpus.bench.ts`. Do not overlap timing runs with builds or other benchmarks. Seeding writes about 1.5 GB of Zstandard logs under a private temporary root, which the test removes after success or failure.

The test reports every fresh-process sample, the CPU model, available parallelism, platform, and Node version, and enforces median budgets. Its last case fails when the file, including seeding, exceeds five minutes. A failed worker reports its exit, signal, timeout, and stderr tail. The required benchmark lane discovers this file automatically.

<a id="measurements"></a>

## Measurements

[corpus-shape.ts](corpus-shape.ts) holds the measured quantile anchors. [synthetic-corpus.ts](synthetic-corpus.ts) authors one event body per anchor and stores each Session as its own header frame followed by that body. [The Agent Note](../../.agents/notes/implemented/testing/2026-09-28-session-corpus-performance.md) owns the workload derivation, timing endpoints, calibration, and exclusions.

| Case | Corpus | Timed endpoints |
|---|---|---|
| List | 3,000 Sessions | Host boot; first and repeated `session.list`, each returning every Session with cached projections |
| Content search | 1,000 Sessions | First `session.search`, which builds the in-memory index; a second query over the built index |
| Fork | 1,000 Sessions | `session.fork` return for ten length strata, the p99 Session, and the longest Session |

<a id="dev-note"></a>

## Dev Note

None.
