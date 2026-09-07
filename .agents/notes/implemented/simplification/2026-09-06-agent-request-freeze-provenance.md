# Agent Note: Reuse only loop-proven message freezes

Status: implemented

English | [中文](2026-09-06-agent-request-freeze-provenance.zh.md)

## Problem

Long tool conversations repeatedly traverse immutable history while constructing requests. The [backend continuation baseline](../testing/2026-09-06-backend-continuation-performance.md) attributes 132.876 ms of sampled CPU self time to `buildRequest`'s `deepFreeze` during a 211.300 ms request-history operation. Skipping all frozen roots is unsafe: restore adopts independently owned graphs without freezing them, and a shallow-frozen message can still contain mutable content.

## Decision

Each `ReactLoopAgent` owns a private WeakSet<Message> containing only identities whose complete `deepFreeze` call succeeded in that instance. Every unseen message is deep-frozen in place, then added. Later requests reuse that proof. A fresh loop proves each identity again; equal message ids do not establish object identity. Weak references add no ownership of compacted history.

The loop deep-freezes the small local canonical header on every request. `canonicalHeader` shares nested values, and `Session.append` freezes a separate snapshot: neither operation proves the local tools or a `NO_ADAPTER` fallback's stop array immutable. The loop separately freezes its fresh messages array and request envelope, retains `markAgentLoopRequest`, and leaves the live `AbortSignal` mutable. Restored message identity and containing event-wrapper mutability remain unchanged.

This specializes request construction, not Session ownership or general `deepFreeze` behavior. `Session.deriveMessages` and `fromRestore` remain unchanged. LLM file, image, and replay projections retain their own freezes because their newly produced values have no loop-local proof. The [reconstructable-request decision](../architecture/2026-07-05-reconstructable-requests.md) continues to own observable immutability and logged request reconstruction.

## Measurement evidence

Apple M4 Pro, macOS arm64, Node 24.19.0; independent worktree dependencies and built artifacts. The exact parent Agent source at 1dc3296eba is rebuilt for the negative control, then the optimized source is restored and rebuilt. Each row retains all five fresh-process totals in sampling order; all timings are milliseconds. Exclusive slots do not overlap repository builds or sibling benchmarks.

| Implementation and UTC interval (2026-09-06) | Request-history raw totals | Median | 175 ms verdict |
|---|---|---:|---|
| Optimized, 07:15:40–07:15:51 | 65.737375, 67.292833, 68.035208, 65.380417, 67.919167 | 67.292833 | Pass |
| Original, 07:17:06–07:17:10 | 249.050708, 238.275291, 242.172084, 250.093166, 246.130875 | 246.130875 | Fail |
| Optimized repeat, 07:18:17–07:18:20 | 66.693500, 67.402083, 68.665000, 66.642083, 66.609125 | 66.693500 | Pass |

The same 800-turn, four-tools-per-historical-turn history and 40 live requests complete in every sample: 13,923 events, no live tool calls. The repeat median is 72.9% below the isolated original. The historical 70 ms M4 expectation rounds above both optimized medians; applying the shared 2× CI scale and 1.25× headroom produced the 175 ms budget used in the table. These remain local reference measurements, not hosted-runner expectations. The explicit hosted calibration below owns the enforced request-history budget; no other case or memory budget changes here.

The first optimized slot also measures cold tool continuation: totals 185.839958, 185.235583, 185.865917, 189.213459, 185.279417; median 185.839958 ms. Every sample completes 40 requests and 160 tool calls with 14,143 events. Retained heap samples are 22.591591, 22.590355, 22.594795, 22.591743, 22.594681 MiB, below the unchanged 28.75 MiB budget. The earlier baseline's approximately 22.295 MiB highlights the small provenance-table cost; weak keys prevent the table itself retaining replaced messages.

The same slot's shipped SDK profile completes 100 turns, 200 requests, and 800 real reads per sample. Totals are 1428.555292, 1160.396333, 1139.843500, 1135.834750, 1155.890334 ms; median 1155.890334 ms. The first sample includes 461.829250 ms boot time versus 164–169 ms for the others and is retained, not discarded. Provider serialization, network time, and browser rendering remain excluded as specified by the baseline owner.

An earlier original-code run at 06:58:28 UTC overlaps a sibling build because of scheduling-message latency: totals 264.269792, 282.442000, 365.836334, 293.172791, 288.719500 ms; median 288.719500 ms. It also fails 175 ms but is not calibration evidence. The isolated original row replaces that comparison, without removing or averaging away the contaminated samples.

### Standard hosted CI calibration

The standard two-CPU `ubuntu-24.04` lane runs Node 24.20.0. [Run 34033336380, job 101487280801](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34033336380/job/101487280801) measures the optimized request path at merge commit `8fba64d9ae06d1a9a778a95487bb915d24cb0644` in Azure eastus: 183.355397, 184.468253, 185.042397, 182.160790, 182.924728 ms; median 183.355397 ms. Every sample completes the same 40 requests and 13,923 events. All five exceed the historical 175 ms budget without changing the WeakSet implementation or workload.

A second hosted run of the same request implementation, [run 34033336246, job 101487216170](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34033336246/job/101487216170), records 145.644577, 144.204300, 143.072572, 145.985903, 146.834474 ms; median 145.644577 ms. It uses the same Ubuntu image and Node version but a different worker in Azure westus3 at merge commit `c366e49`. This faster run does not replace the eastus evidence or establish why the workers differ. The older self-hosted `VM-7-113-ubuntu-ci-9` run with Node 24.18.1 ([run 34021903421, job 101456015028](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34021903421/job/101456015028)) records 110.025154, 119.958978, 108.266860, 107.557950, 108.538902 ms; median 108.538902 ms. Its runner and Node version do not calibrate the standard hosted lane.

The request-history CI expectation is 190 ms, rounded above this observed range. The enforced median budget is `ceil(190 × 1.25) = 238 ms`; the shared 2× reference-machine scale does not apply again to a CI measurement. This matches the direct-CI calibration method of the [63 ms Session-reopen budget](../../../../benchmarks/session-open/session-open.bench.ts), rather than relabeling the M4 reference as hosted evidence. The 238 ms budget remains below the isolated original implementation’s 246.130875 ms M4 median.

Deterministic controls call the same `assertRequestHistoryBudget` assertion as the timed case. They accept the recorded hosted median and maximum (185.042397 ms), reject the recorded original M4 median, and reject a synthetic 250 ms median from 248, 250, 252, 251, 249 ms inputs. The synthetic inputs model a material regression; they are not runtime measurements. Replaying recorded values verifies the assertion, not a new hosted run. The acceptance control fails at 175 ms before calibration; all three controls and the five request-freeze behavior tests pass at 238 ms.

## Alternatives considered

**Return immediately for `Object.isFrozen`.** A frozen root does not prove its descendants frozen. Applying this shortcut to the shared helper would weaken every caller, including restore and projection paths.

**Trust every Session message or cache message ids.** Restore explicitly permits owned unfrozen data; replacements can preserve an id while changing identity and content. Only completed traversal of that exact object proves the request's requirement.

**Retain a strong Set or share a global proof cache.** Strong references extend old history lifetime. Global caching expands ownership beyond the Agent and is unnecessary for repeated requests from one loop.

**Remove downstream projection freezes.** Projected file/image/replay messages are distinct values with separate ownership. Optimizing them requires their own evidence and is not implied by freezing canonical history.

## Consequences

Request construction still scans message identities and allocates a fresh array; it avoids recursively traversing already-proven history. Each loop pays one complete traversal for restored history. Local headers remain a per-request cost. Message values, request markers, previous request snapshots, cancellation, and serialized SDK outputs keep their existing behavior.

The [focused tests](../../../../packages/core/agent-loop/tests/request-freeze.spec.ts) exercise shallow-frozen restored roots with mutable descendants, wrapper identity and mutability, successful-only provenance, repeated requests, same-id compaction replacements, a fresh loop, nested tool schemas, adapter and `NO_ADAPTER` stop arrays, held requests, and live cancellation. Reconstruction and cancellation suites cover adjacent loop semantics. Performance measurements use the unchanged [continuation workload](../../../../benchmarks/agent-continuation/workload.ts), not a smaller synthetic microbenchmark.

Validation runs 646 Agent-loop and LLM tests with 100% statement, branch, function, and line coverage of agent.ts. Keyless TypeScript SDK bash-tool and multi-turn snapshots pass against rebuilt libraries. Python sdk-minimal and sdk-snapshot checks pass against an independently packaged node24-macos-arm64 executable. Neither SDK requires an expected-output change. The packaging deploy temporarily removes workspace dependency links; a frozen-lockfile install restores them before source checks, without a tracked dependency change.

The active immutability, message-identity, observable-state-machine, and backend-baseline notes remain independently useful; none is fully superseded or archived. This note specializes the request-freezing mechanism and cross-links its reconstructability owner.
