# Agent Note: Performance baselines for tool-heavy backend continuation

Status: implemented

English | [中文](2026-09-06-backend-continuation-performance.zh.md)

## Problem

Opening one Session does not measure the repeated cost of preparing model requests after a long tool conversation, executing another tool-heavy turn, or discovering multiple inactive fork children. The [Session-opening gate](2026-09-04-session-open-performance-gate.md) covers first history and activation but deliberately stops before new model work. Its text/reasoning workload also lacks historical tool-call arguments and large tool results.

## Decision

The [agent-continuation benchmark](../../../../benchmarks/agent-continuation/agent-continuation.bench.ts) adds three scenario groups, including a shipped-profile variant, without changing product implementations. They use current-generation Zstandard Sessions authored through production append, stream accumulation, and persistence APIs. A separate seed process creates the deterministic source before measurement; each sample copies that source into its private root and starts a fresh compiled plain-Node worker. No recorded Session, ambient repository, network, private Harness home, or deployed GUI supplies input.

The shared history has 800 completed two-step turns, four tool calls per turn, and 2,048-character tool results: 13,600 events and 5,600 conversation messages. Each assistant reply carries reasoning, text, and compact streamed records; tool replies additionally carry fragmented arguments. Fixed timestamps and ids describe the seed. Live synthetic replies use the real loop's clocks and ids without overriding process globals.

| Case | Timed operation | Endpoint |
|---|---|---|
| Request history | After unmeasured cold resume, deliver 40 sequential text-only turns over the tool-heavy history, then flush | Idle Agent with all 40 model requests completed; reports turn and final-flush time separately |
| Tool continuation | Cold resume, 20 sequential turns with eight parallel-safe synthetic tool calls and a final reply per turn, then flush | Idle Agent with 40 model requests and 160 completed tool executions; reports resume, turns, and final flush separately |
| Shipped SDK workflow | Launch built dsh with the sdk-minimal profile, deliver 100 sequential turns with eight real file-view calls per turn, then close the SDK | SDK receives 200 assistant messages and 800 successful file results; includes Loader boot, stdio JSON-RPC, persistence, and shutdown |
| Child catalog | List 16 inactive seeded fork children twice through the real subagent and Session query services | Two complete healthy catalogs with observations released; each child inherits 80 tool-heavy turns and owns its descriptor after the exact fork cut |

The tool execution pipeline, request preparation, Session projections required by those services, persistence, and catalog observations remain production code. Only the model adapter and bounded tool body are synthetic. The adapter retains a request counter, not request objects, so the fixture cannot manufacture a growing retention cost. Sequential input means each idle interval belongs to the one request delivered by this worker; it does not generalize idle to a per-message completion API under concurrent input.

Five samples report raw wall time, CPU user/system time, peak RSS, endpoint counts, and the minimum, median, and maximum total wall time. Budgets enforce the unrounded median. Continuation additionally measures retained heap against an initialized Host: two explicit GCs separated by an event-loop yield precede and follow the timed operation, while the idle Agent remains reachable. The measured delta therefore includes the resident historical Session and live additions, not just newly appended turns. GC and teardown are outside timing; flush is inside. Request-history retention starts after resume and is diagnostic only. Catalog peak RSS is diagnostic; no retained-heap budget claims to measure already-released child observations.

The parent bounds every child to 60 seconds, checks timeout, signal, exit, and report independently, awaits process close, and removes private roots after failures. Context and Agent teardown run in finally blocks. Seed processes cannot warm the measured process's caches. Filesystem caches are not forcibly evicted: cold means a fresh process, not cold physical storage.

## Calibration evidence

The implementation reference is `925e012340f033f0521e802ba8569ce6dd7ef1ac` on Apple M4 Pro, macOS arm64, Node 24.19.0. Two exclusive five-sample runs use the same seed and no product optimization. Durations below are milliseconds; source expectations round above the observed run medians rather than imposing an unimplemented optimization target.

| Case | Run 1 raw totals | Run 2 raw totals | Medians | Historical M4 expectation | Historical scaled budget |
|---|---|---|---|---:|---:|
| Request history | 209.134, 210.333, 208.959, 236.355, 238.685 | 222.833, 213.911, 208.089, 211.494, 209.137 | 210.333 / 211.494 | 220 | 550 |
| Tool continuation | 358.953, 324.790, 318.861, 320.119, 322.896 | 324.280, 321.952, 340.409, 325.470, 324.312 | 322.896 / 324.312 | 340 | 850 |
| Child catalog | 318.730, 309.006, 311.404, 308.565, 310.105 | 308.670, 310.030, 280.086, 303.084, 284.829 | 310.105 / 303.084 | 320 | 800 |

Continuation retains approximately 22.295 MiB; its source expectation is 23 MiB and its budget is 28.75 MiB. SDK time expectations use the existing [calibration helper](../../../../benchmarks/support/calibration.ts): 2× shared CI time scale and 1.25× variance headroom. Request history uses the direct hosted expectation in the [request-freeze calibration](../simplification/2026-09-06-agent-request-freeze-provenance.md), without the 2× scale. Memory uses only 1.25× headroom. The scale is inherited from the existing lane's calibration, not a new Linux measurement of these cases; CI evidence remains necessary when runner characteristics change. Baseline budgets protect the measured implementation; tighter budgets belong with a measured behavior-preserving fix.

A separate plain-Node request-history CPU profile attributes 132.876 ms of sampled self time to deepFreeze called by buildRequest during a 211.300 ms operation. This identifies repeated traversal of already-frozen history as a focused investigation target, not a proven optimization result. Catalog first/repeat timings remain separate because a second listing still reads body-bearing seeded children after observations are released.

The shipped SDK variant completes 100 turns, 200 requests, and 800 real file reads. Its five-sample smoke totals are 1,521.773, 1,463.465, 1,689.701, 1,365.485, and 1,417.106 ms (median 1,463.465 ms); a full-suite repeat reports 1,596.183, 1,784.536, 2,120.082, 1,405.365, and 1,355.894 ms (median 1,596.183 ms). Its 1,700 ms reference expectation yields a 4,250 ms CI budget. The repeat also slows the unchanged service cases, so it is validation under variable host load rather than evidence to relax their exclusive calibration. The SDK process receives an allowlisted environment and private home/workspace. A 40-second deadline starts SDK shutdown; every path awaits the same memoized close promise before the outer worker’s 60-second deadline. Profile timing includes boot, all turns, and shutdown, reported separately; no parent-process CPU or heap metric is presented as server memory. The adapter does not serialize requests for an external model provider.

The first Linux x64 CI measurement at commit `1dc3296eba631d51fbb3bb50e249bf3cc0fce9f6` ran on `VM-7-113-ubuntu-ci-10` with Node 24.18.1 ([run 34017868081, attempt 1, job 101444810498](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34017868081/job/101444810498)). The SDK median was 2,753.441 ms against its 4,250 ms budget, and tool-continuation retained-heap median was 22.274 MiB against 28.75 MiB. Request-history and tool-continuation time budgets failed: 785.498 ms against 550 ms and 1,077.285 ms against 850 ms, respectively. The unchanged Session-reopen open phase also failed at 31.6 ms against 30 ms. [Attempt 2, job 101447076381](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34017868081/job/101447076381) passed every benchmark on the same commit and unchanged budgets, but used `VM-7-113-ubuntu-ci-29` with Node 24.19.0. The gate runner suppressed successful child output, so that attempt supplies a passing verdict rather than raw medians. The changed runner and Node version prevent attributing the difference solely to contention or claiming stable repeated CI calibration; neither the budgets nor the shared scale are changed on this evidence.

Catalog uses an explicit 900 ms expected CI duration and only the existing 1.25× headroom, yielding 1,125 ms without applying the reference-machine scale again. The standard two-CPU hosted `ubuntu-24.04` [run 34033336380, job 101487280801](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34033336380/job/101487280801) reports five unchanged-catalog totals of 797.374, 883.157, 858.364, 790.569, and 904.579 ms: median 858.364 ms exceeds the historical 800 ms budget. The 320 ms M4 expectation above remains historical evidence, not a CI measurement. This follows the explicit-CI calibration used by Session reopening (50 ms expected CI); shared factors, workloads, timing endpoints, and product implementations remain unchanged. Deterministic controls use the same assertion as the measured verdict: the unrounded recorded median passes 1,125 ms and fails 800 ms, while a synthetic 1,400 ms median fails 1,125 ms. A passing run on a faster host does not calibrate the standard hosted runner.

Tool continuation also uses a 900 ms expected CI duration with 1.25× headroom (1,125 ms). At unchanged implementation `79c052ab29`, standard two-CPU hosted [run 34034524265, job 101490056074](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34034524265/job/101490056074) reports totals of 917.007, 892.091, 887.839, 905.659, and 898.252 ms: median 898.252 ms exceeds the historical 850 ms budget. The 340 ms M4 expectation remains historical evidence. The same measured-verdict assertion accepts the recorded unrounded median under 1,125 ms, rejects it under 850 ms, and rejects a synthetic 1,400 ms regression. Workload, timing, product code, and the 28.75 MiB retained-heap budget remain unchanged.

Baseline request history uses a 600 ms expected CI duration with 1.25× headroom (750 ms). At unchanged implementation `54d1190a75`, standard two-CPU hosted [run 34035306987, job 101492163630](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34035306987/job/101492163630) reports totals of 618.598, 618.606, 582.035, 582.304, and 581.832 ms: median 582.304 ms exceeds the historical 550 ms budget. The 220 ms M4 expectation remains historical evidence. The same measured-verdict assertion accepts the recorded unrounded median under 750 ms, rejects it under 550 ms, and rejects a synthetic 900 ms regression. This calibrates the unoptimized baseline only; workload, timing, product code, and memory budgets remain unchanged.

## Alternatives considered

**Repeat existing migration and first-open variants.** Rejected: those twelve cases already distinguish read-only preparation from writable publication. These cases use the current generation and begin or continue actual model work, or enumerate a corpus rather than open one Session.

**Measure only deriveMessages.** Rejected: its incremental cache does not include complete request freezing, adapter dispatch, live append, or persistence. Actual sequential requests protect the cost the Agent pays per step.

**Use only unseeded children with warm projection-cache rows.** Rejected: that path bypasses body observations and misses the exact inherited-cut requirement of fork children. The catalog intentionally omits the optional projection cache and reports the seeded fallback path; it does not characterize cache-hit discovery.

**Apply an optimization and its desired budget together with the first measurements.** Rejected: a baseline-only layer remains independently mergeable and records the current workload before attribution or implementation changes. Source constants cannot be overridden by environment variables.

## Consequences

The lane adds four cases in three scenario groups and twenty measured workers, plus two seed processes. The integrated continuation case spans resume through completed model/tool work and durable flush. The shipped SDK workflow additionally includes profile boot, SDK transport, real file tools, and shutdown; only its model adapter is synthetic. It starts a fresh Session because the public SDK prompt API creates rather than resumes stored identities. Neither path includes network model latency, provider-specific request serialization, optional user plugins, compaction, failed tool results, images, cancellation, or browser rendering. Functional tests retain responsibility for event contents, immutable messages, tool semantics, fork lineage, and read-only versus writable side effects; endpoint counts prevent timing a skipped workload without duplicating those assertions.

This note supplements, rather than supersedes, the Session-opening gate's isolation and calibration rationale. No existing active decision is retired.
