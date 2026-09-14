# Agent Note: Canonicalize partition coverage locations before the blob merge

Status: implemented

English | [中文](2026-09-13-partitioned-coverage-location-canonicalization.zh.md)

## Problem

The coverage gate reported [packages/util/home-paths/src/index.ts](../../../../packages/util/home-paths/src/index.ts) at 96.96% statements with one uncovered statement at `48:22`, while branches, functions, and lines stayed at 100% and the same tests reported the file at 100% in an unpartitioned run. Line 48 holds one statement, so the merged report counted a second, unhit statement the source does not contain. The branch that exposed the failure only added a jsdom suite that loads a node-tested module; it did not touch that module or its package.

A source file reaches the merged report through one statement map per Vite environment, and the serialized partition blob strips the location data istanbul-lib-coverage reconciles those maps with. A file executed under two environments can therefore fail the per-file 100% gate although every statement ran, and the failure follows the test environments and the partition count rather than the file.

## Decision

[scripts/coverage-partitions.ts](../../../../scripts/coverage-partitions.ts) passes every partition `--reporter=./scripts/coverage-canonical-locations.ts`, whose `onCoverage` hook rewrites each non-finite end column of the finished run's coverage map to `Number.MAX_SAFE_INTEGER`. That column keeps the meaning of a location that ends at its line's end, serializes as a number, and keys identically in every blob, so the merge command reconciles environment-specific spellings exactly as an in-process merge does. The per-file 100% gate keeps its full strength for every file `coverage.include` matches: the canonicalization adds hits through istanbul's containment rule and never removes a statement from the report. A payload that carries no istanbul `data` record fails the partition instead of leaving every location uncanonicalized.

[scripts/coverage-uncovered-locations.cjs](../../../../scripts/coverage-uncovered-locations.cjs) reads the same column as a line end, so an uncovered record prints the same `path:line:col` with or without the canonicalization. The [in-job partitioned coverage](../process/2026-08-18-in-job-partitioned-coverage.md) coordinator owns the partition and merge commands this reporter joins, and it keeps its single merged threshold check.

## Divergent statement maps across Vite environments

A node suite maps a source file through the `ssr` environment and a `@vitest-environment jsdom` suite maps it through the `client` environment. The AST-based V8 remapper positions a statement at the node it finds in the transformed code, so one declaration enters the merged map twice: at its declared identifier from the ssr transform, at the nested call expression of the client transform. istanbul-lib-coverage attributes the hits of the narrowest containing range to an entry no other record names, which covers whichever spelling the client record introduces.

That reconciliation runs on locations `getLoc()` accepts, which requires numeric line and column values. ast-v8-to-istanbul ends a whole-line statement at column `Infinity`; a partition blob serializes `Infinity` as `null`, so the merge command holds a location it cannot compare and keeps the client-only spelling as an extra, unhit statement. The same records merged inside one process, where `Infinity` survives, report no such statement.

## Testing

`scripts/coverage-partitions.spec.ts` merges two records that spell one statement both ways through the JSON hop a blob performs, and asserts that the canonicalized merge reports no uncovered statement where the raw merge reports the phantom. A second case pins the canonicalization across statement, function, and branch locations, a third pins the canonicalizing reporter on every partition command, and a fourth pins the loud rejection of a payload that carries no coverage data.

## Alternatives considered

**Drop the untested-file maps from partitions.** Rejected because those maps are what fails a file no test runs; removing them silences a real coverage gap in exchange for the phantom.

**Reconcile statements by line in the merge command.** Rejected because several statements can share a line, so line-level merging hides genuinely uncovered code.

**Keep jsdom suites from loading node-only modules.** Rejected because attribution must not depend on which environment a suite happens to load a module in, and any later cross-environment load would return the defect.

**Repair the merged map in the report phase.** Rejected because the records are already fused by then, so re-adding hits cannot separate a phantom spelling from a genuinely unhit nested statement.

**Exempt the file or relax the per-file gate.** Rejected because the file is covered and the gate is correct; the attribution was not.

## Consequences

Partitioned runs attribute for a cross-environment file what one process attributes, so the gate holds 100% per file without exempting anything. Canonicalization runs inside partitions only, which leaves unpartitioned runs and their reports as they are. Blobs carry a finite sentinel column for a line-end position, and both the partition reporter and the uncovered-locations reporter name that sentinel as the line-end convention. The canonicalization also depends on Vitest's reporter ordering: the blob reporter stores the map in its own `onCoverage` and serializes it in `onTestRunEnd`, so a Vitest upgrade that reordered those hooks would first show up as the phantom statement returning.
