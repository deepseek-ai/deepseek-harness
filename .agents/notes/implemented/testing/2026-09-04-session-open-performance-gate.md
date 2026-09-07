# Agent Note: Required CI performance gate for opening large Sessions

Status: implemented

English | [中文](2026-09-04-session-open-performance-gate.zh.md)

## Problem

The Session format v2 rollout changed two paths whose cost scales with model output: the JSONL backend migrates and publishes a released-v0 log, and the Client folds each settled reply's embedded compact stream. Neither path had an executable performance check, so first open grew from about 35 ms to about 5 s on a 127,400-event synthetic log (and from about 0.3 s to 26 s on a 575,000-chunk real log, with 2.7 GB peak RSS and heap exhaustion under a 512 MB limit), while Client fold grew linearly with streamed deltas instead of compact records; these regressions reached master unnoticed.

Measuring only `SessionPersistence.open()` does not stably describe the result for which a user or Host waits. Work can move among `open()`, `SessionHandle.read()`, Session restoration, and projection, while the first history page and cold Agent resume add separate orchestration above those operations. A single `heapUsed` sample without prior GC also cannot distinguish data still retained by the Session from reclaimable migration temporaries.

## Decision

Linux pull requests run a required `node 24 / benchmarks` job that executes `pnpm run check:ci:bench` → `pnpm run test:bench`. The private `@deepseek-ai/dsh-benchmarks` workspace owns benchmark-only dependencies. The command first builds workspace libraries and dedicated workers under `benchmarks/.dsh-build/`, then invokes `vitest.bench.config.ts`. The [standard hosted runner decision](2026-09-06-standard-hosted-benchmark-runner.md) owns runner selection and the outer job timeout. The job runs the benchmark lane alone; Vitest runs one file at a time and only prepares input, starts measurement children, aggregates results, and enforces budgets. Every timed Node CPU path executes compiled JavaScript under plain Node with `NODE_OPTIONS` removed and no TypeScript loader; bare workspace imports therefore resolve from `benchmarks/node_modules` through package exports to built `lib/` entries.

Required performance gates live under top-level `benchmarks/`, grouped by measured user path rather than package ownership. Host files use `*.bench.ts`, Client-face files use `*.bench.client.ts`, and scenario-specific workers and fixtures stay beside their benchmark without a benchmark suffix. Package-local `.perf.ts` files remain non-gating diagnostics; `scripts/` owns orchestration rather than benchmark cases.

The Session benchmarks synthesize a released-v0 input from fixed parameters: 200 turns with 500 text deltas and 125 reasoning deltas per turn, for 127,400 logical events. The input uses Zstandard with fixed logical-row grouping and frame partitioning, so every run processes the same events, bytes, and frame distribution. The fixture constructs the immutable released-v0 physical rows directly instead of depending on a current-runtime historical encoder; compression and every measured read or migration entry point still use production code. Setup writes the input into a private temporary directory for each sample before timing starts; benchmarks never use recorded Sessions.

Every Session endpoint runs at two user-lifecycle points. `first-open` starts with only the released V0 generation and includes migration; read-only consumers do not publish a successor, while writable Agent resume does. Setup produces `post-upgrade-reopen` once through that same production migration outside measurement, then copies both the unchanged V0 predecessor and published V2 successor into each sample root. Reopen samples use a fresh process, so they measure an upgraded user's later disk open without migration or process-local caches.

Each access-kind and endpoint sample runs in a fresh compiled Node child process. Module imports, Host service initialization, and fixture preparation finish before measurement; the measured process performs no extra parse warm-up. Normal-heap mode runs five independent samples, reports every sample plus minimum, median, and maximum, and enforces access-specific fixed budgets against the median. Another child runs the same path under a fixed 128 MB old-space limit and checks only that it completes; extra GC caused by the constrained heap does not enter the normal timing baseline.

The lane contains three independent Session-opening benchmarks and retains the Client-fold benchmark:

| Benchmark | Measured path | Timing metrics |
|---|---|---|
| Phase profile | Executes the real persistence open, handle read, Session restore, and projection for both first open and post-upgrade reopen | `openMs`, `readMs`, `sessionRestoreMs`, and `projectionMs` each have a fixed budget; read-only migration belongs to first-open `openMs`; successor encoding, verification, and publication belong to writable Agent resume |
| First history | Reads each access kind through the Host Session history controller until it produces the first paginated snapshot | Separate first-open and reopen end-to-end budgets; each includes source stat, reading, restoration, projection, pagination, and snapshot construction, while first open additionally includes migration; both exclude Gateway network transport, Client fold, and browser paint |
| Agent resume | Calls `ctx.agents.resume()` for each access kind until Agent creation, setup, publication, and loop startup finish | Separate first-open and reopen end-to-end budgets; neither path runs after first-history or reuses that benchmark's cache |
| Client fold | Folds small and large v2 history windows through the real `ConversationNodeAssembler` and every Chat Definition | The large window's absolute time and scaling relative to the small window each have a fixed budget |

The phase profile invokes each layer's production entry point explicitly and does not copy any decode, migration, restore, or projection algorithm. First-history and Agent-resume each run their real higher-level entry point against fresh first-open and reopen roots, so component measurements do not stand in for end-to-end results and one scenario cannot warm another's process or Session cache. The sum of the four phases is diagnostic only; an outer clock independently measures each end-to-end result.

Normal-heap mode performs a fixed pair of explicit garbage collections after Host initialization and before the cold Session is touched, then records starting memory. It stops operation timing before performing the same garbage-collection sequence while the scenario's intended long-lived objects remain explicitly reachable, then records ending memory. The Agent-resume endpoint retains the Agent, Session, complete events, and normal service caches; its `heapUsed` delta is the primary resident-Session memory budget. Every scenario also reports `external`, `arrayBuffers`, post-GC RSS, and `process.resourceUsage().maxRSS`; the 128 MB mode prevents transient allocation peaks from being hidden by endpoint collection. Explicit garbage-collection time is excluded from operation timing.

The performance gate does not duplicate semantic assertions owned by functional tests; it requires only that the target call completes and reaches its measured endpoint. The Client-fold benchmark continues to use the real `ConversationNodeAssembler` and every Chat Definition, and requires both the large window's absolute time and its scaling relative to the small window to remain below fixed budgets.

Budgets are calibrated per measured endpoint. Two repeated Node 24.19 x64 CI runs differ by at most 5.2% in their medians; their CPU-heavy wall times are 1.95–2.06× the Node 24.18 arm64 reference run. Except for current-generation `open`, source constants record expected reference-machine durations; `ciTimeBudget()` multiplies them by the measured 2× CI time scale and 1.25× variance headroom. Current-generation `open` uses a directly measured standard-runner expectation of 50 ms with only the 1.25× headroom, rounded up to a 63 ms budget. The retained-heap and Client-fold scaling budgets use only the 1.25× headroom because neither is a wall-clock duration. The 128 MB completion check remains an independent transient-allocation limit. The resulting first-open time limits, constrained-heap checks, and Client-fold limits all reject the known regressions. Pre-stack commit `0d7ea53743e273930a31e9e2b6ca682f21dd4ca5` is the fixed calibration and review reference; CI does not check out or execute the historical repository. Budgets are reviewed source constants and have no environment-variable override.

## Calibration evidence

The comparison is orthogonal by user lifecycle, not by artifact representation. Both implementations receive the same fixed V0 bytes for first open. For reopen, each implementation reads the format it considers current in a fresh process: the pre-stack reference remains on V0, while the V2 implementation reads its published V2 successor. This intentionally compares the same user's later-open experience rather than two codecs over one data structure.

Five-sample medians on the same Node 24 reference machine establish the positive and negative controls:

| Access kind | Implementation | Four-phase total | First history | Agent resume | Agent retained heap | 128 MB old space |
|---|---|---:|---:|---:|---:|---|
| First open | Pre-stack reference | 249.0 ms | 253.8 ms | 100.7 ms | 26.1 MB | Completes |
| First open | Repeated-snapshot regression | 4,197.5 ms | 4,284.8 ms | 4,197.9 ms | 4.4 MB | Exhausts heap |
| Post-upgrade reopen | Pre-stack reference | 251.1 ms | 253.8 ms | 100.7 ms | 26.1 MB | Completes |
| Post-upgrade reopen | Repeated-snapshot regression | 49.2 ms | 50.4 ms | 43.8 ms | 4.5 MB | Completes |

The pre-stack implementation keeps V0 as its current format, so first open does not change its on-disk representation; its native V0 first-history and Agent-resume measurements therefore apply to both lifecycle rows.

The [standard two-CPU run](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34023970384/job/101461539961) at `ca3ffe95dac2c55eefeb16ed9b61067bbd19ee90` uses Node 24.20.0 x64 and Ubuntu image `20260831.293.1`. Its five current-generation `open` samples are 49.2, 47.4, 49.1, 48.6, and 48.1 ms: median 48.6 ms, maximum 49.2 ms. The rounded 50 ms CI expectation gives a 63 ms limit without reapplying the 2× machine scale. The log identifies two available CPUs but not their model; it does not isolate hardware from the Node-version change. This is endpoint-specific runner calibration, not evidence of an application optimization or a new reference-machine measurement. Every other benchmark passes its existing budget. Deterministic controls reject the observed median at the historical 30 ms limit, accept it at 63 ms, reject a synthetic 75 ms reopen median, and reject a synthetic 4,000 ms first-open duration at its unchanged 550 ms limit. These controls verify budget enforcement, not a measured new regression.

The calibrated source budgets are:

| Measurement | Reference expectation | CI budget |
|---|---:|---:|
| First-open `open` | 220 ms | 550 ms |
| Current-generation `open` | 12 ms (historical reference; CI expectation: 50 ms) | 63 ms |
| Complete read | 8 ms | 20 ms |
| Session restore | 24 ms | 60 ms |
| Projection | 14 ms | 35 ms |
| First-open first history | 220 ms | 550 ms |
| Current-generation first history | 48 ms | 120 ms |
| First-open Agent resume | 180 ms | 450 ms |
| Current-generation Agent resume | 40 ms | 100 ms |
| Agent retained heap | 26.1 MB | 33 MB |
| Client-fold absolute time | 16 ms | 40 ms |
| Client-fold delta scaling | 2.5× | 3.125× |
| Constrained old space | — | 128 MB |

## Alternatives considered

**Check out the historical commit and compare it on every CI run.** Rejected because a historical checkout requires a separate install, and old and current revisions can assign work to different API phases, adding runtime, dependency, and interface drift. A fixed workload with static budgets calibrated against positive and negative controls is easier to reproduce and review.

**Measure only first open from V0.** Rejected because migration is a one-time upgrade cost and cannot protect later opens of the settled current generation from regressions. The two access kinds need separate measurements and budgets.

**Measure only the four component phases.** Rejected because component measurements locate cost but omit source stat, orchestration, pagination, and snapshot construction, and cannot prove that the complete first-history path remains usable and fast enough.

**Measure only first-history or Agent-resume total time.** Rejected because an end-to-end number protects the result but cannot identify whether storage, reading, Session restoration, or projection regressed; four phase budgets retain actionable attribution.

**Add fine-grained timing instrumentation inside production implementations.** Rejected because those probes would expand production APIs and couple the benchmark to implementation details. Tests use existing service and object boundaries; costs that those boundaries cannot attribute remain part of the end-to-end result.

**Run measured workers from TypeScript source.** Rejected because a source loader changes module resolution and startup behavior, and causes nested workers to select source-only bootstrap paths. Vitest remains an unmeasured orchestrator; every timed worker executes the build output exactly as plain Node consumers do.

**Use only time budgets or only post-GC memory.** Rejected because time does not reveal memory regressions, while endpoint live memory cannot expose transient migration spikes. Normal-heap post-GC deltas and constrained-heap completion cover the two risks separately.

**Benchmark the real recorded corpus.** Rejected because corpus fixtures stay small by policy, recorded material must not become benchmark input, and re-recording would silently move the workload.

**Run benchmarks inside an existing gate aggregate.** Rejected because aggregate gates run concurrently on one runner, so wall-clock measurements inherit neighbouring CPU load.

**Keep each cross-package gate under one participating product package.** Rejected because Session opening spans persistence, migration, projection, Host history, and Agent resume; choosing one participant creates misleading ownership and benchmark-only package dependencies. The repository-level tree owns the integrated user path, while package-local diagnostics remain with their implementation.

**Put benchmark cases under `scripts/`.** Rejected because scripts own commands, generators, and orchestration, while a benchmark case owns typed test files, workers, fixtures, budgets, and lifecycle cleanup. A future reporting or calibration command may consume `benchmarks/` without moving the cases there.

## Consequences

Every pull request pays for one required Linux job; its Session portion runs several short-lived child processes in exchange for cold caches, isolated V8 heaps, explicit GC state, and attributable failures. The repository-level benchmark tree accepts deliberate cross-package test dependencies without changing product package manifests. The fixed Zstandard workload covers both event volume and frame topology; first-open measurements protect the one-time upgrade experience, reopen measurements prevent regressions in later opens, phase budgets locate cost, first-history budgets protect user-visible waiting, Agent-resume budgets and post-GC deltas protect complete cold activation and resident memory, and the 128 MB mode protects the transient allocation ceiling.

The Session and Node-fold scenarios do not measure network transfer, browser rendering, or recorded Sessions, and they are not a continuous performance-trend system. [Frontend performance budgets](2026-09-06-frontend-performance-budgets.md) own browser workflow measurements. A Node or runner change requires resampling the same workload and reviewing the budgets; a business-implementation change must not relax a budget without new positive and negative control data.
