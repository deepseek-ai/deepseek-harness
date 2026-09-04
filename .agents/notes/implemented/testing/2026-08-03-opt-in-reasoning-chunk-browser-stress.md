# Agent Note: Frame-coalesced reasoning-chunk publication and browser stress validation

Status: implemented

English | [中文](2026-08-03-opt-in-reasoning-chunk-browser-stress.zh.md)

## Problem

Long reasoning streams continuously produce large numbers of process-local `assistant/live-chunk` updates before one durable settlement. Each update must remain ordered and be folded into the Assistant Definition to preserve live completeness, while the settlement embeds the exact stream for replay; React, however, needs only the current accumulated result, not every intermediate state within one browser frame.

Each `yield` in an async stream can create a new microtask boundary, so `Notifier.markDirty()` backed only by microtask batching degrades into rebuilding a `ConversationSnapshot`, notifying `useSyncExternalStore`, and running a React render for every chunk. Even with the live Think row collapsed, 100,000 reasoning chunks can overwhelm the main thread with reconciliation, commit, and layout work. The performance boundary must sit between session ingestion and React publication; it cannot hide the problem by slowing the producer or discarding raw events.

## Decision

The Session Controller appends every Client-only live chunk to its event source, and Conversation immediately folds it into each matching Definition State. Chat and Trajectory Definitions request `animation-frame` publication for visible `block-start`, `text-delta`, `reasoning-delta`, `tool-call-delta`, and `block-end` chunks; the first change schedules one `requestAnimationFrame`, later chunks continue updating State, and the frame callback materializes one accumulated snapshot from the latest State. `usage` and `finish` request no publication. The durable `assistant/message` or `assistant/attempt` settlement publishes immediately and reproduces the same final stream during history replay.

`BoundConversation` owns one pending frame per Session. Ordinary structural events and durable settlements request immediate publication, flush the latest assembled State, and make a later frame callback harmless because no dirty Context remains. Environments without `requestAnimationFrame` publish immediately. A settlement may skip one intermediate partial that has not yet appeared, while the published final content and durable embedded stream remain complete.

Keeping the live Think row horizontally pinned to the end of the accumulated text is purely visual alignment and does not require synchronous layout reads on every React commit. An in-component scheduler coalesces consecutive requests into one update every three frames, reads `scrollWidth` and `clientWidth` from the latest DOM, and updates `scrollLeft` directly to the latest position; the fixed visual cadence keeps summary changes readable without allowing browser smooth-scroll animations to accumulate. This throttling applies only to Think's horizontal summary and does not delay Chat body scrolling, history-prepend anchoring, or user-triggered `scrollIntoView`.

`pnpm run test:web:stress` remains keyless, opt-in browser performance evidence. The deterministic `?fixture` session emits 100,000 `reasoning-delta` events at a cadence independent of painting, and a terminal marker proves that the events cross production session reduction and reach the live Think row; a 50-millisecond heartbeat and a pre-scheduled DOM event measure main-thread stalls and interaction latency, respectively, with a 250-millisecond budget for identifying clear regressions. `DSH_WEB_STRESS_HEADFUL=1` lets developers profile the same scenario in a visible browser with the Performance panel. The stress lane is evidence for manual performance diagnosis and fix acceptance, not a default CI gate or a substitute for deterministic scheduling unit tests.

Focused tests pin `Notifier`'s per-frame coalescing, structural-event preemption, invalidated callbacks, and no-rAF fallback, and prove at the `Session` layer that a frame publishes the latest accumulated text only once and that finalization is not followed by a duplicate notification from a stale frame callback. Small fixture unit tests continue to pin input validation, external arrival pacing, concurrency rejection, exact event count, and terminal-marker delivery without bringing the 100,000-chunk workload into the default test suites.

## Alternatives considered

**React transitions, deferred values, or component throttling applied to snapshots.** Rejected: the session source would still notify `useSyncExternalStore` for every chunk, the React render has already occurred before a component decides to defer display, and multiple components consuming the same snapshot would each need to implement the strategy. Visual tail-following throttling for the Think summary occurs after snapshot publication and only reduces the frequency of synchronous layout; it does not implement the data-publication policy.

**Dropping or sampling live chunks before Definition folding.** Rejected: the live accumulated state would diverge from the durable embedded stream and could omit visible intermediate content. Compact durable storage and frame-coalesced React publication solve different costs.

**Microtask batching alone.** Rejected: consecutive asynchronous `yield` operations can drain the microtask queue between adjacent chunks, making microtask batching approximate one notification per chunk.

**Pacing the test producer by animation frames.** Rejected: the producer would slow whenever rendering slowed, giving the page implicit backpressure absent from a real network stream and masking main-thread starvation.

**A live model or recorded HTTP byte stream.** Rejected: live models are nondeterministic, and an HTTP/SSE recording would not improve the target assertion. The in-memory fixture preserves individual asynchronous session events, production client reduction, and the React rendering path while controlling the workload and arrival cadence.

## Consequences

The publication rate of streaming `ConversationSnapshot` objects is bounded by the browser's paint rate, so React handles at most one accumulated partial containing all received text per frame; structural events can still publish sooner. Ingestion, ordering, logging, string concatenation, and accumulator updates still run for every raw chunk, so this decision reduces snapshot rebuilding and React work without pretending to solve raw-stream parsing cost.

Horizontal layout reads and writes for the collapsed Think summary run at most once every three frames, and each update moves the summary directly to the latest position; React still commits accumulated snapshots normally, and the summary returns to the first line at finalization. This local visual policy does not change the immediacy of body scrolling or user interactions.

The browser stress lane continues to provide a responsiveness signal from the real assembled application and an entry point for visible profiling, but hardware and scheduling differences make it suitable only as explicit performance evidence. Deterministic focused tests guard publication counts, accumulated content, and preemption order, while the default test lanes remain fast.
