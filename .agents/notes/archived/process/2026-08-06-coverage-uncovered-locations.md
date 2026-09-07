# Agent Note: Exact uncovered locations on coverage failure

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-06-coverage-uncovered-locations.zh.md)

## Problem

When the per-file 100% coverage gate fails, vitest emits only file-level error lines (`ERROR: Coverage for lines (…) does not meet global threshold (100%) for <file>`) — you learn which file fell short, not which lines. The built-in `text` report does have an Uncovered Line #s column, but it is one giant table over hundreds of files repo-wide: the column truncates at the table width, carries line numbers but no column numbers, does not distinguish statements from branches from functions, and passing files occupy rows all the same. The net effect is that a red coverage run on CI is not directly actionable; the only way to locate the specific gap is to rerun the html report locally.

## Decision

`scripts/coverage-uncovered-locations.cjs` is a custom istanbul reporter (a `ReportBase` subclass): for every file below 100%, it emits one self-contained single-line record per uncovered statement, untaken branch path, and uncalled function — `<path>:<line>:<col> uncovered <kind> …` — directly clickable in terminals and CI logs, and easy to grep. When every file passes, it prints nothing. istanbul report generation runs before threshold validation, so the records land exactly above the existing ERROR lines.

The wiring is a single point: the coverage block in the root `vitest.config.ts` is the repo's only coverage configuration, shared by the CI lane (`run-gates ci-coverage`), local `test:coverage`, and focused runs (`--coverage.include`). The reporter joins both the CI and local reporter arrays by absolute path (`fileURLToPath`) — istanbul-reports' `create()` falls back to a bare `require(name)` for non-built-in names, and a relative path would resolve against istanbul's own package directory.

Output conventions:

- istanbul's 0-based column numbers are converted to 1-based (the convention editors and terminal links expect).
- v8 reports `end.column = Infinity` for whole-line statements: a span crossing lines degrades to a `(to <line>)` suffix carrying only the line number, and a single-line span omits the suffix.
- An implicit branch arm (such as a missing else) may carry no location; the reporter falls back to the branch's own span so the record stays clickable; branch records are annotated with the branch type and `path k/n`.
- Records within a file are sorted by line, then column; there is no cap on the count.

The root `package.json` declares `istanbul-lib-report` as a devDependency because pnpm's strict layout prevents `scripts/` from reaching nested dependencies.

CJS is a forced shape, and a justified exception to the ESM-everywhere discipline: istanbul loads custom reporters via a bare `require()` outside the tsx/Vite pipeline, where TypeScript cannot participate; the namespace object `require(esm)` returns also fails its `new Cons(cfg)` construction — CommonJS is the only reliable shape.

## Alternatives considered

- **Rely on the built-in `text` report's Uncovered Line #s column.** This is precisely the problem as found: one repo-wide table, column-width truncation, line numbers only, no kind distinction, passing files in the same column — not actionable in CI logs.
- **Add a `json` reporter plus a separate wrapper script that reads `coverage-final.json` for post-processing after a failure.** Feasible in pure ESM/TS, but the wrapper would have to wrap both entry points — `package.json`'s `test:coverage` and the run-gates gate — changing their command shapes; the custom-reporter route touches one piece of configuration and takes effect at both entry points automatically.
- **Write the reporter in TypeScript/ESM.** istanbul's loading mechanism (a bare `require` outside the pipeline) rules this out, as above; swapping out the loading mechanism for the sake of one report file is out of proportion.

## Verification

Local matrix: with a deliberately induced failure, all three record kinds appear and their locations match the planted gaps; a mixed run emits records only for the failing files (files at 100% within the same run stay silent); an all-green run produces zero output and exit code 0. CI evidence: after temporarily planting one unreachable statement/branch/function in `clampTimeout`, the coverage lane — under the isolated condition of all tests passing (632 files / 10326 cases) with only the threshold failing — printed the 4 records above the ERROR lines; the planted failure is not in the committed tree.

## Consequences

- A red coverage run is self-sufficient: the log gives exact line and column numbers plus the kind of each gap, and rerunning the html report locally to pinpoint it is no longer needed.
- The cost is one CJS-file discipline exception and one root devDependency; all-green runs produce zero output and add no log noise.
- A file with zero coverage yields output on the order of its statement count (deliberately uncapped): the gate demands zero gaps, so the full listing is the action list, and vitest's own ERROR lines already provide the per-file summary as a backstop.
