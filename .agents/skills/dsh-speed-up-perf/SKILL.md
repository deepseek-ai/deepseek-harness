---
name: dsh-speed-up-perf
description: 'Use when investigating or optimizing DeepSeek Harness performance, designing realistic synthetic benchmarks or CI performance gates, profiling long Sessions or Web responsiveness, or turning performance PR evidence into measured behavior-preserving fixes.'
---

# Speed Up DeepSeek Harness

Turn a broad “make it faster” request into reproducible user-path measurements and small, evidence-backed fixes. This is guidance, not a quota or a script: survey broadly, follow measured cost, and reject attractive changes that do not improve the workload users actually run.

## Establish scope and current authority

Read [AGENTS.md](../../../AGENTS.md), [architecture](../../../docs/architecture.md), [testing policy](../../../docs/testing.md), [defensive patterns](../../../docs/defensive-patterns.md), and the affected packages’ instructions and Agent Notes. Use [CI test reliability](../dsh-ci-test-reliability/SKILL.md) for processes, clocks, browser tests, and asynchronous cleanup.

Agree on the user-visible endpoint, workload range, resource constraints, acceptable minor behavior differences, and stopping rule. Keep backend and browser end-to-end measurements separate: a fast history iterator or Client fold does not prove fast transport, paint, scrolling, or input response. Exclude model/network latency when measuring local overhead, and state that exclusion rather than calling the result complete product latency.

Inspect the exact current base, not just the running checkout. Study final merged diffs, owning source, tests, and resolved review threads; a PR body can describe an abandoned implementation. Separate merged, closed-unmerged, superseded, estimated, and newly measured evidence. The [performance workflow decision and evidence](../../notes/implemented/process/2026-09-06-evidence-driven-performance-skill.md) supply historical leads, not authority to reintroduce their implementations.

## Survey user paths, then rank candidates

Delegate independent domains when breadth helps; require measurements and production call sites, not guesses. Useful domains include:

- Cold profile startup, first historical read, current-generation reopen, and writable resume.
- Many-turn and tool-heavy history, large individual messages/results, child Session listing, and repeated navigation among Sessions.
- Initial history transport and fold, first usable browser paint, older-page loading, scrolling, tool expansion, and inactive-view activation.
- Live streaming and reconnect, including a long active attempt, interleaved tool work, settlement, cancellation, and teardown.

Vary independent cost drivers: bytes, durable events, compact records, raw deltas, turns, tools, children, and visible DOM nodes are different quantities. Do not call a large count of tiny identical messages “realistic” without checking which user operation it stresses. Include typical and tail workloads, but avoid a combinatorial matrix with no decision value.

Rank candidates by observed user latency, CPU/allocations, retained memory, occurrence, and confidence. For each, name the production consumer, the repeated work, the expected complexity, the smallest falsifiable intervention, and the behavior that must remain stable. A suspicious loop, unused cache, or large file alone is not evidence of a bottleneck.

## Build realistic synthetic benchmarks first

Follow [benchmarks/AGENTS.md](../../../benchmarks/AGENTS.md) and the [performance-gate decision](../../notes/implemented/testing/2026-09-04-session-open-performance-gate.md). Extend the existing required lane rather than creating competing calibration or reporting infrastructure. Package-local diagnostics remain beside their owner; cross-package required cases live under the measured user path in `benchmarks/`.

If the user authorizes local corpus inspection, extract only aggregate workload characteristics. Never copy prompts, outputs, paths, identities, IDs, credentials, recordings, or recognizable snippets into fixtures, logs, screenshots, PRs, or artifacts. Generate fixed inputs from reviewed constants; no benchmark depends on the user’s home, ambient repository, network service, or private data.

Before implementation, record a measurement card:

| Field | Required decision |
|---|---|
| User operation | Exact action and externally observable completion condition |
| Workload | Fixed dimensions, distributions, construction seed/constants, and why they exercise ordinary and tail use |
| Entry path | Production calls/composition and built artifacts; mocked external boundaries |
| Clock | Included setup, cold/warm state, timing start/end, and excluded costs |
| Memory | Reachable endpoint objects, baseline, GC policy, retained versus transient limits |
| Verdict | Raw samples, chosen aggregate, calibrated absolute/ratio/memory limits, and negative control |
| Behavior | Owning functional tests/snapshots and permitted minor differences |

Measure built JavaScript under plain Node for CPU workers; source-loader overhead and module resolution are not the shipped path. Browser cases use built product assets and the supported `dsh` profile through the existing test harness. Do not add a production export solely for measurement or copy the algorithm into a “benchmark implementation.”

Use fresh children and private temporary roots for cold/process-memory samples. Warm samples explicitly retain the intended cache; never let fixture setup secretly warm a cold scenario. Keep the same input, validations, completion condition, and reachable output on both sides. A parse-and-discard baseline is not comparable with validated retained history.

Report all samples and the aggregate that decides the result. For the Node lane, use the existing shared time calibration and reviewed variance headroom; do not scale bytes, counts, or dimensionless ratios by CPU speed. Keep manual browser diagnostics threshold-free. A required browser performance case needs an explicit lane decision and repeated measurements on its actual CI browser/runner before adopting timing budgets; the Node machine multiplier alone is not browser calibration. Budgets are source constants, not environment overrides. Serialize measured work against other owned CPU-heavy jobs; measure reference and candidate under comparable conditions. Do not widen a budget or select a lucky run to hide a regression.

Measure end-to-end latency independently from component phases. Track retained memory with intended objects still reachable, and transient pressure separately through constrained-heap completion or an appropriate peak measurement. Faster execution with unbounded retention is not an automatic win.

For browser responsiveness, use real browser input and observe the resulting UI update. Include the final stall in frame/input measurements, distinguish scheduled timers from actual input, and bound synthetic producers so catch-up bursts do not invent a different workload. State whether first paint, scrolling, paging, live updates, and activated-but-hidden views are covered. Node folds, fake DOMs, and custom heartbeat events alone cannot establish browser responsiveness.

## Prove the regression, then remove work

Run the unoptimized workload before changing production code. Save the command, revision, runtime/platform, fixture dimensions, raw measurements, and verdict. Reduce a failing scenario until it still exercises the real bottleneck, then rank falsifiable hypotheses before patching. Use profiles, allocation samples, work counts, or phase timings to distinguish them.

Common patterns worth testing, not automatic prescriptions:

- Keep compact representations compact through downstream readers; avoid per-delta objects when the consumer needs settled content or one aggregate.
- Remove duplicate parsing, copying, freezing, and validation only after identifying the actual ownership and trust transition. Typed same-process borrowing is not permission to weaken durable or wire parsing.
- Stream artifact transformations and bound intermediate state rather than retaining every generation. Include publication, verification, and writable-readiness obligations where the user operation requires them.
- Separate read-only preparation from write/publication work without moving awaited work past a correctness-required endpoint.
- Defer inactive-view and collapsed-detail work; measure first activation and retained state too. Deferral is not deletion, and viewport highlighting is not full virtualization.
- Stabilize identities and narrow subscriptions so one changed node does not invalidate an entire history; preserve update ordering and immediate-event behavior.
- Prefer a suitable data structure to repeated shifting, scanning, or rebuilding. Measure the whole consumer path, not just the isolated container operation.
- Use revision-keyed reuse or singleflight only with explicit invalidation, bounded retention, independent waiter cancellation, and disposal ownership. Avoid caching expanded representations merely to make repeated benchmarks look fast.

Change one causal factor at a time. Re-run both the focused scenario and its end-to-end parent. Require a negative control: the tightened assertion fails on the original implementation or a controlled reintroduction of the targeted cost. A threshold so generous that the regression passes is not protection; a budget below a verified noise floor is not reliable either.

## Preserve behavior and resource ownership

Performance measurements complement functional evidence; they do not replace it. Run or add the narrow owning tests for output, ordering, paging, stream indexes, errors, cancellation, concurrency, and disposal as applicable. Preserve model-visible/logged equivalence, released-generation immutability, atomic publication, required validation, and writable readiness. Do not silently truncate history, skip tool results, disable invariants, or change lifecycle semantics to reach a number.

State any deliberate minor visible difference and verify it through the owning keyless snapshot. For a product-visible GUI change, include the required browser evidence/GIF. Keep functional expectations independent of benchmark internals; benchmark assertions need enough evidence to reach the real endpoint, not a second semantic test suite.

Reject an optimization when gains disappear end-to-end, a typical workload regresses materially, complexity outweighs a small gain, or cancellation/retention/durability cannot be explained and tested. Record the rejected hypothesis briefly instead of expanding scope to justify it.

## Deliver a bounded, reviewable result

Use [Agent Note rules](../../notes/README.md) for durable rationale, alternatives, calibration, exclusions, and remaining risks. Check relevant notes for supersession without turning performance work into a corpus-wide prose cleanup. Keep the reusable procedure here and scenario-specific truth with its benchmark or package owner.

When the task requests stacked PRs, choose layers before editing and use official GitHub stacks and separate worktrees. Keep each layer mergeable: benchmark infrastructure can protect the measured baseline; the optimization layer carries its fix, functional coverage, and tighter budget. Independent bottlenecks may use separate stacks. Fix a finding in its owning layer before propagating upward.

Apply [pre-push checks](../dsh-pre-push-checks/SKILL.md), report only executed evidence, and inspect CI rather than assuming local timing proves runner stability. After marking ready, evaluate review findings against code and executable evidence; reply with the reason or fix and resolve addressed threads. Do not dismiss a report merely because it came from a bot.

Summarize each result as: workload → before/after absolute values and ratio → endpoint and memory semantics → behavior evidence → negative control → exact checks → exclusions. Separate author-reported historical numbers, fresh local measurements, and CI evidence. Stop at the agreed scenario/fix scope; retain a short ranked follow-up list instead of chasing unrelated opportunities.
