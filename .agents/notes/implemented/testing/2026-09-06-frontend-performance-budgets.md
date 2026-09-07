# Agent Note: Frontend large-session performance budgets

Status: implemented

English | [中文](2026-09-06-frontend-performance-budgets.zh.md)

## Problem

A fast Node conversation fold does not prove that a browser paints a long conversation or remains responsive while a response streams. Active reconnect also reconstructs a different representation from settled history: a compact prefix becomes public per-chunk Client entries. The [Session performance policy](2026-09-04-session-open-performance-gate.md) supplies an isolated CI job but does not measure these user paths.

## Decision

The existing serial benchmark inventory includes two frontend owners: [active reconnect](../../../../benchmarks/active-stream-reconnect/README.md) and a [browser workflow](../../../../benchmarks/long-session-browser/README.md). The browser workflow combines cold open, older-page navigation, first Trajectory activation, return to Chat, and a paced response with trusted keyboard input into one sequential scenario. These are endpoints of one workflow, not independent cold scenarios. The settled conversation-fold benchmark remains unchanged.

`build:bench` keeps the Node-only library and worker build. `test:bench` additionally builds the Web shell before running all cases; the required benchmark CI job follows the [standard hosted runner decision](2026-09-06-standard-hosted-benchmark-runner.md), unconditionally provisions Chromium and its Linux dependencies on that hosted runner, and enables the existing verbose gate output so successful raw samples remain available for calibration. Browser cases reuse the shipped-composition Web scaffold with private temporary roots and an atomically assigned loopback port. Only the nondeterministic model is replaced by synthetic replay. The scaffold Host runs under the existing Vitest source resolver; measured Client rendering runs built bundles in fresh Chromium processes. Browser wall times therefore include this test Host, transport, Playwright actionability, and rendering, and are not claims about a published Host process.

The browser input contains 240 closed turns, 40 tool results, and 20 code fences, plus mixed-language prose and reasoning. Historical Assistant records carry matching compact streams built through the production accumulator with 12-character reasoning/text deltas and 8-character tool-argument deltas; empty streams would omit stored and transferred payload costs. Nine older-page actions exhaust this input from its observed 25-turn initial window; the readiness probe follows mounted turn growth rather than duplicating the pagination algorithm. Each sample uses a fresh scaffold and browser. Setup, seeding, browser launch, initial shell load, and sidebar expansion are excluded from open timing. Open ends at transcript availability and an editable composer; page and navigation timings end at their target DOM state. Two animation frames include a rendering opportunity, not hardware presentation or a guarantee that every offscreen node painted.

The continuation sends 120 text deltas at 16 ms replay pacing. The input witness is installed before Send; typing starts immediately after the first visible marker, without a separate pre-input animation-frame wait. Send lookup stays inside the composer seat; first/final marker lookups stay inside the latest Assistant step and retain visible-state waits. The synchronous input witness reads that same bounded reply. Whole-history text and accessibility queries add observer CPU and garbage collection to the measured interval, so reducing that observer work is benchmark repair, not product optimization. It records click-to-first-visible-reply, trusted draft typing whose first actual input event observes the first reply but no completion marker, complete reply wall time through settled persistence and the new rendered turn-tail, and Chromium main-thread task duration. The complete wall budget adds the fixed 1984 ms scripted pacing to a scaled overhead allowance; input and completion have their own enforced budgets. Post-GC browser heap and DOM counts remain diagnostics because one endpoint does not prove a leak.

Reconnect uses three fresh compiled plain-Node children. Each creates a 100,000-delta reasoning prefix with distinct timestamps and two compact records before timing `ClientAssistantStream.replace()`. GC precedes the baseline and follows replacement while the result remains reachable; replacement time excludes both collections. The report consumes the result after collection and checks that the next dense live frame remains accepted. This measures reconstruction, not transport, rendering, or an entire reconnect workflow.

## Calibration

Three-sample medians on the arm64 reference machine, Node 24.19 and Chromium 149.0.7827.55, at product revision `925e012340`, establish the baseline below. An isolated repeat follows a complete workflow smoke. Each browser sample reports raw endpoint values and every page; the paging verdict uses the median of the sample maxima. Reconnect reports all child measurements. The following historical reference table uses 8 ms replay pacing and includes a two-frame wait in first-reply timing. Standard-hosted open, paging, Trajectory, and reconnect expectations are recorded separately below; other source reference constants retain these allowances. The bounded-observer 261.60 ms paging median exceeds its 260 ms reference allowance but remains below its 650 ms CI limit; the shared 2× time scale and 1.25× variance allowance produce CI limits. Memory uses only variance allowance. The shared scale originates in Node CI calibration. Both actual x64 browser runs below pass the fixed budgets on unchanged benchmark code; this supplies repeated-run evidence for these runners, not a universal browser speed ratio.

| Endpoint | Measured median | Reference allowance | Historical CI limit |
|---|---:|---:|---:|
| Browser open | 184.62 ms | 200 ms | 500 ms |
| Slowest older page | 261.60 ms | 260 ms | 650 ms |
| First Trajectory | 136.46 ms | 160 ms | 400 ms |
| First reply | 373.72 ms | 1100 ms | 2750 ms |
| Stream main-thread task | 1053.87 ms | 1800 ms | 4500 ms |
| Draft typing | 487.35 ms | 500 ms | 1250 ms |
| Complete response | 1366.36 ms | 1000 ms overhead + 992 ms pacing | 3492 ms |
| Reconnect replacement | 13.83 ms | 16 ms | 40 ms |
| Reconnect retained heap | 23.03 MiB | 24 MiB | 30 MiB |

Draft typing spans 124.97–504.96 ms across the three isolated samples; the reference remains 500 ms and the scaled CI limit covers that observed spread; the median is not a per-keystroke bound. No budget is an environment override. Temporary zero allowances exercise every rejection path; these negative controls prove enforcement, not an optimization or a historical regression. A separate control waits for the final reply marker before typing and fails the actual-input overlap assertion. The compact synthetic JSONL is 3,262,577 bytes; all three corrected samples report an overlapping trusted input event and end after the 241st rendered turn-tail.

### Actual CI runs

[Run 34020120425, benchmark job 101451135853](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34020120425/job/101451135853) passes the complete benchmark inventory at `6d1ba089e5052680961825c08aa4de19b4fe137a`. The runner is `VM-7-113-ubuntu-ci-19` in `dsh-selfhosted-ci`, using x64 Node 24.19.0 and Chromium 149.0.7827.55. [Attempt 2, benchmark job 101453296071](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34020120425/job/101453296071) also passes the complete inventory at the same commit, on `VM-7-113-ubuntu-ci-25` with the same Node and Chromium versions. The following medians use three fresh samples per scenario in each run and leave the local reference table and source budgets unchanged.

| Endpoint | First CI median | Second CI median |
|---|---:|---:|
| Browser open | 303.066 ms | 284.726 ms |
| Slowest older page | 432.979 ms | 413.798 ms |
| First Trajectory | 298.608 ms | 267.372 ms |
| First reply | 740.265 ms | 658.906 ms |
| Stream main-thread task | 1614.594 ms | 1035.385 ms |
| Draft typing | 932.746 ms | 142.148 ms |
| Complete response | 1677.882 ms | 1641.702 ms |
| Reconnect replacement | 29.232 ms | 31.674 ms |
| Reconnect retained heap | 23.028 MiB | 23.028 MiB |

All six browser samples report `inputOverlapped: true` and finish after the 241st rendered turn-tail. Post-GC browser heap is approximately 52.94 MiB in the first run and 53.00 MiB in the second, with 17,064 DOM elements in both; these remain diagnostic endpoints. Both runs support the existing budgets on these runners, not a universal 2× browser speed ratio. Draft-typing medians vary from 932.746 ms to 142.148 ms because the endpoint measures the entire typed draft, including scheduling and Playwright actionability, rather than a per-key latency guarantee. These are self-hosted measurements, not standard-hosted calibration; no product optimization is claimed.

### Standard hosted expectations and input scheduling

[Run 34033336246, job 101487216170](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34033336246/job/101487216170) on standard hosted Ubuntu with two CPUs records reconnect replacements of 46.574411, 46.067910, and 44.193704 ms, with 23.028 MiB retained heap. The endpoint-specific expectation is 50 ms; the existing 1.25× headroom gives a 63 ms integer ceiling. The 30 MiB memory budget and shared machine factor remain unchanged. Browser open records 681.276514 and 541.051233 ms before the third sample fails input overlap; both exceed the historical 500 ms limit. Repeated hosted open measurements below set its expectation and ceiling. Deterministic controls pass these recorded values and reject values above the new ceilings through the same assertions as the measured verdicts. Complete repeated hosted verdicts remain required; the two open values are not a three-sample median.

A local diagnostic with temporary 3× Chromium CPU throttling reproduces the overlap failure: the first marker becomes visible at 1321 ms, two animation frames finish at 1370 ms, and the composer click finishes at 1660 ms; the actual input is trusted but already sees DONE. Removing the frame wait and installing the witness before Send still leaves a run with first visibility at 1415 ms and click completion at 1726 ms, after the original 992 ms scripted stream. The fixed 16 ms cadence keeps the same 120 deltas and payload, providing 1984 ms of scripted pacing for this workload. Only that pacing term changes in the complete-wall allowance (4484 ms); input, first-reply, and main-thread overhead allowances remain unchanged. With the same diagnostic slowdown, three 16 ms samples reach first visibility at 1307/1479/1599 ms and accept trusted input before DONE; their post-DONE controls reject it. The diagnostic is not a CPU-ratio calibration. Each measured sample still requires trusted input while FIRST is present and DONE absent; a post-measurement trusted key after DONE must fail that same assertion. Host settlement and the 241st rendered turn-tail remain completion witnesses.

[Run 34034524861, job 101490135303](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34034524861/job/101490135303) records three complete browser samples with trusted input overlap and passing post-DONE rejection controls. Slowest-page samples are 843.941625/672.834329/684.461818 ms (median 684.461818); first-Trajectory samples are 605.788061/367.754027/485.931656 ms (median 485.931656). Their endpoint-specific hosted expectations are 700 and 500 ms, with the same 1.25× headroom producing 875 and 625 ms limits. Recorded-median controls reject the historical 650/400 ms limits, accept these hosted limits, and reject one millisecond above each limit through the measured verdict's assertion. Open, first reply, main-thread task, input, and complete-wall medians are 713.910/1486.206/2806.415/947.398/2986.983 ms; only the open limit is recalibrated by the repeated measurements below. This run supplies calibration data, not a passing benchmark verdict; a complete hosted repeat remains required.

[Run 34036109842, job 101494445658](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34036109842/job/101494445658) records open samples of 875.306861/1083.683529/814.700998 ms, with a median of 875.306861 ms versus 713.909727 ms in the preceding hosted run. The endpoint-specific expectation is 900 ms, rounding up the larger repeated median rather than adding an epsilon to the 875 ms limit; unchanged 1.25× headroom gives 1125 ms. The same enforced assertion accepts the recorded median, rejects it at both historical 500 and 875 ms limits, and rejects a synthetic 1126 ms value at the current limit. All three samples retain trusted input overlap and post-DONE rejection; every other frontend median remains within its unchanged limit. This calibration does not claim a green CI run.

## Alternatives considered

**Use the Node fold as paint evidence.** Rejected because it never performs DOM mutation, layout, or browser scheduling. The focused reconnect case likewise makes no GUI speed claim.

**Promote the entire manual browser diagnostic into CI.** Rejected because its 1,000-session sidebar and 100-turn soak cover a much broader workload. The bounded required case reuses its shipped scaffold and measurement approach without importing a test module or changing the manual inventory.

**Coalesce active reconnect chunks.** Rejected as a benchmark shortcut: Client entries expose per-member ordering and timestamps to conversation definitions. The benchmark retains that production behavior; reducing retained entries requires a separate semantic design, not copied product algorithms or a synthetic approximation.

**Search the entire loaded history for every stream marker.** Rejected because Playwright injects text and accessibility scans into the same renderer whose CPU the benchmark measures. Scoping queries to the composer and latest Assistant preserves visible completion checks without making observer cost proportional to loaded history.

**Measure stream CPU alone.** Rejected because transport stalls and final-settlement delays can leave main-thread CPU low. The independent input, first-reply, and complete-wall budgets cover those waits.

## Consequences

The benchmark layer changes no product implementation or user-visible behavior. It adds approximately fifteen seconds of local browser/reconnect execution plus Web build and browser provisioning to the existing isolated CI lane. A fresh browser discards previous caches, but each workflow deliberately retains its own loaded history and previously activated Trajectory during continuation.

The baseline is independently mergeable and protects current performance; optimization layers tighten budgets only with repeated measurements and focused semantic tests. It does not cover sidebar cardinality, an hours-long soak, GPU presentation, real model latency, a published Host launch, or reconnect rendering. The [Web browser lane](2026-07-24-web-gui-browser-e2e-lane.md) retains its separate threshold-free manual diagnostics and functional browser tests; calibrated required measurements belong to this benchmark lane. The existing Session performance note remains active because it owns Node calibration and persistence rationale; this note extends rather than supersedes it.
