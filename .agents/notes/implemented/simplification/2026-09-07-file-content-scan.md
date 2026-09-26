# Agent Note: Scan file content without per-array callbacks

Status: implemented

English | [中文](2026-09-07-file-content-scan.zh.md)

## Problem

Every model dispatch checks complete message content for files, including tool-role result content. A request-history CPU profile attributes 23.540 ms of self time to `contentHasFile` and 5.584 ms to its callback. This traversal remains necessary even after [loop-owned freeze evidence](2026-09-06-agent-request-freeze-evidence.md) removes repeated request freezing. The hot LLM source is identical at both sampled master revisions and the measured V3 integration revision; these observations do not establish PR causality.

## Decision

[`contentHasFile`](../../../../packages/llm/llm/src/content.ts) uses direct iteration instead of recursive `Array.some` callbacks. It preserves early exit, tool-role result traversal, and false results for other block kinds. It stores no identities, validation results, or freeze proofs. Image detection, file projection, and request construction keep their existing behavior. The [request-freeze evidence](2026-09-06-agent-request-freeze-evidence.md) owns the request-history budget.

## Measurement evidence

Apple M4 Pro, Node 24.19.0: nine alternating original/candidate pairs run the unchanged [request-history worker](../../../../benchmarks/agent-continuation/agent-continuation.worker.ts) in fresh plain-Node processes. Each process receives a copy of one native-V3 seed. Only the built LLM entry changes; every sample completes 40 requests, zero live tools, and 13,925 events. All totals below are milliseconds, in pair order.

| Variant | Raw totals | Median |
|---|---|---:|
| Original | 61.772167, 66.480917, 63.590042, 62.250333, 63.804875, 62.504208, 61.887958, 61.062959, 67.120125 | 62.504208 |
| Direct iteration | 53.655375, 56.223416, 57.078125, 54.559250, 54.271459, 55.288917, 55.400416, 56.191916, 54.877041 | 55.288917 |

The median improves 11.54%; all nine pairs improve, by 4.871–12.243 ms. User CPU medians are 82.019/76.150 ms. A separate five-pair scan probe uses the same synthetic history: 5,601 frozen messages, 13,600 blocks, and 8,801 content arrays scanned 40 times. Original totals are 17.188584, 17.944000, 16.869458, 17.437750, 17.459708; direct iteration totals are 8.726333, 8.373000, 8.851750, 8.479167, 9.074083. These local measurements establish an implementation gain, not a hosted-CI pass or a new calibration.

## Alternatives considered

A weak negative-result cache needs proof that every relevant descendant is immutable; a shallow-frozen root is insufficient. Direct iteration provides measured savings without introducing that ownership or invalidation problem. Optimizing image traversal or system-prompt projection lacks evidence from this experiment and is outside this change.

## Consequences

The scan remains linear in visited blocks and rereads mutable nested content on each call. [Content tests](../../../../packages/llm/llm/tests/content.spec.ts) cover empty, frozen, nested, and subsequently mutated arrays; service tests preserve file-handle projection, and request-freeze, reconstruction, and resume tests preserve native-history semantics. No model-visible text or Session format changes. The freeze-evidence and [backend-baseline](../testing/2026-09-06-backend-continuation-performance.md) notes retain independent ownership; neither is superseded.
