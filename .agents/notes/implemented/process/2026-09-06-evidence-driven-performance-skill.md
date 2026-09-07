# Agent Note: Evidence-driven performance optimization workflow

Status: implemented

English | [中文](2026-09-06-evidence-driven-performance-skill.zh.md)

## Problem

Performance work can improve an isolated phase while moving cost into another phase, retaining more data, or skipping required behavior. Historical PR descriptions also retain abandoned implementations and estimates, so copying their apparent solution can restore a rejected design instead of addressing a current bottleneck.

## Decision

The [dsh-speed-up-perf skill](../../../skills/dsh-speed-up-perf/SKILL.md) guides broad surveys toward bounded, measured user paths. It combines focused attribution with independently timed backend and browser endpoints, synthetic workload distributions, comparable cold/warm and retained-memory conditions, and negative controls for tightened budgets. The historical evidence below distinguishes merged implementations, superseded proposals, author-reported measurements, and estimates.

The workflow requires behavior evidence independently of timing: model-visible logs, durable generation and publication rules, stream ordering, cancellation, and disposal remain obligations. Authorized private corpus inspection yields only aggregate workload inspiration; committed inputs and published artifacts contain synthetic material. Optimization PRs carry their tighter budgets, while a preceding benchmark layer can protect the measured baseline and remain independently mergeable.

The [Session-opening performance-gate decision](../testing/2026-09-04-session-open-performance-gate.md) retains ownership of lane mechanics and calibration. The [simplification skill](../../../skills/dsh-find-simplifications/SKILL.md) retains ownership of deletion-oriented surveys. Neither is superseded: this workflow adds performance-specific candidate selection, measurement comparability, and stopping criteria rather than replacing their decisions.

## Historical evidence

These are author-reported historical measurements, not benchmarks rerun for this workflow. Final merged diffs and owning source take precedence over original PR descriptions. The rejected intermediate proposal is retained only to explain why identity registries are not a general prescription.

| Evidence | Measured path and result | Reusable lesson |
|---|---|---|
| [#3535](https://github.com/deepseek-harness/deepseek-harness/pull/3535), merged | The [final benchmark design](https://github.com/deepseek-harness/deepseek-harness/pull/3535#issuecomment-5552779119) reports a 4,394 ms first-open negative control against 550 ms, first-history 4,452 against 550, resume 4,333 against 450, and 128 MB heap failures. Client fold: 123.9 ms / 10.84× against 40 ms / 3.125×. | Built-JS user-path gates and positive/negative controls matter more than an earlier PR-body design. |
| [#3536](https://github.com/deepseek-harness/deepseek-harness/pull/3536), closed unmerged | Repeated snapshot/freeze work occupied about 70% of profiled CPU; synthetic open improved from 4,734–4,921 to 707–823 ms. | Streaming migration superseded this identity-registry proposal. Do not revive it without current ownership evidence. |
| [#3585](https://github.com/deepseek-harness/deepseek-harness/pull/3585), merged | Historical physical decode: 7.527 s / 7,219 MB peak RSS to 1.467 s / 908 MB; streaming migration with serial publication: 6.241 s, 2.107 GB peak, 477 MB retained. Settled 500,000-delta Client fold: 3.2 ms. | Keep representations compact across consumers; bound intermediate state. Attribution estimates overlap and cannot be added. |
| [#3586](https://github.com/deepseek-harness/deepseek-harness/pull/3586), merged | Current-v2 opening snapshot: 2,011.4→1,027.9 ms; restore: 598.5→16 ms; retained heap: 1,025.3→478.7 MB. | Separate read-only preparation from awaited write publication; share immutable ownership with revision-keyed preparation and caller-local cancellation. |
| [#3537](https://github.com/deepseek-harness/deepseek-harness/pull/3537), merged | Synthetic 200-turn projection: 28→5.4 ms; total: 76.9→50 ms; peak RSS: 137.2→94.9 MB. | Read stats, usage, text and image references per compact record. Expanded-stream caching retains unnecessary representation cost. Chat/Trajectory belong to the preceding migration change. |
| [#2587](https://github.com/deepseek-harness/deepseek-harness/pull/2587), merged | Historical 416,756 events represented by 696 records: client history 4,682→276 ms; sampled additional V8 peak 612.5→199.4 MB. | Preserve compactness through validation and folding; [baseline review](https://github.com/deepseek-harness/deepseek-harness/pull/2587#discussion_r3803082730) requires equal validation and retained output, not parse-and-discard. |
| [#3331](https://github.com/deepseek-harness/deepseek-harness/pull/3331), merged | 10,000 collapsed tool rows: 22.5→7.5 ms, retained 12.2→1.6 MiB; inactive Trajectory flushes: 4,082→15.5 ms. | Defer unused parsing and materialization; first activation and retained Context still cost work. |
| [#3391](https://github.com/deepseek-harness/deepseek-harness/pull/3391) and [#3383](https://github.com/deepseek-harness/deepseek-harness/pull/3383), merged | Narrow subscriptions, stable identities, batched publication, and viewport-triggered highlighting. The 10,000-node timing table is estimated, not browser measurement. | Deferral is not virtualization: visited token DOM remains retained. |
| [#3292](https://github.com/deepseek-harness/deepseek-harness/pull/3292), merged | Two-million-item FIFO drain: 9.656 ms median, excluding enqueue. | A deque removes shift copying, not queue admission or backpressure obligations. |
| [#1161](https://github.com/deepseek-harness/deepseek-harness/pull/1161), merged | Keyless 100,000-chunk browser stress at 128 chunks per 16 ms. | [Producer catch-up](https://github.com/deepseek-harness/deepseek-harness/pull/1161#discussion_r3699970161) and [final heartbeat stalls](https://github.com/deepseek-harness/deepseek-harness/pull/1161#discussion_r3699970162) can distort measurements; scheduled events are not trusted keyboard/pointer input. |

The [cancellation review](https://github.com/deepseek-harness/deepseek-harness/pull/3586#discussion_r3940578092), [source-revision review](https://github.com/deepseek-harness/deepseek-harness/pull/3586#discussion_r3940569241), and [typed-reader review](https://github.com/deepseek-harness/deepseek-harness/pull/3537#discussion_r3942974015) illustrate why removing repeated work does not authorize deleting validation or publication obligations. A [standby-runner review](https://github.com/deepseek-harness/deepseek-harness/pull/3535#discussion_r3927945561) distinguishes a dedicated job from an isolated physical host.

## Alternatives considered

**Optimize suspicious code before measuring.** Rejected because local complexity does not identify dominant user cost and cannot establish improvement or regression protection.

**Treat historical speedups as reusable prescriptions.** Rejected because representation, ownership, and lifecycle requirements change. Historical evidence generates hypotheses; current production paths and fresh measurements decide whether a change applies.

**Use only microbenchmarks or only end-to-end timing.** Rejected because isolated phases can omit moved work, while aggregate timing alone cannot locate its cause. Both are required at the scope appropriate to the selected problem.

## Consequences

The skill adds no runtime behavior, benchmark implementation, or new CI policy. Its validation is document/link consistency and skill metadata; each future optimization supplies executable measurements and functional evidence at its owner. The finite scenario/fix scope prevents a broad performance request from becoming an unrelated architectural rewrite.
