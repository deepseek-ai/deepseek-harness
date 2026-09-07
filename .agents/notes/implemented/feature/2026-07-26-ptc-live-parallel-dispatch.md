# Agent Note: PTC mode live dispatch lifecycle and native-contract parallelism

Status: implemented

English | [中文](2026-07-26-ptc-live-parallel-dispatch.zh.md)

> Scope: the `tool/code-dispatch-start` event, per-sub-call running state in the web chat, and the bridge's scheduler reusing the native concurrency contract. Builds on the [host foundation](../../archived/feature/2026-07-26-ptc-dispatch-ui-foundation.md) and [chat sub-call rows](../../archived/feature/2026-07-26-ptc-chat-subcall-rows.md); the native contract itself is owned by the [parallel tool-call note](2026-07-10-parallel-tool-call-execution.md).

## Problem

Two gaps remained after the host foundation and chat sub-call rows shipped. Sub-call rows appeared only when each dispatch *settled* — while one ran, the UI showed nothing for it, so a slow sub-call read as a stalled parent. And the bridge serialized every binding call ("even `Promise.all` executes one at a time"), a placeholder from before tools carried concurrency metadata: `isConcurrencySafe` now exists, the loop scheduler already runs native siblings in bounded pools, and a PTC mode program awaiting three independent reads paid 3× the latency the native path would.

## Decision

**One lifecycle pair, one scheduling contract, shared with native.**

- **Event pair**: `tool/code-dispatch-start` (parent/sub ids, name, normalized args) is appended when the scheduler actually starts a call — not at submission, so a queued call abandoned by run settlement logs nothing. The existing `tool/code-dispatch` settles the pair (same `subCallId`); every started call settles exactly once (aborts settle as `isError` outcomes through the pipeline). Timing = the two events' `time` fields. Both stay log-only; model context is untouched; format stays v0.
- **Bridge scheduler**: submitted calls are classified at start time via `registry.executionMode` (the SAME fail-closed `isConcurrencySafe` contract the loop uses) and start strictly in submission order. One single-lane driver owns every ORDERED stage — the start append, `prepare` (pre-execute/guards), the head-of-line `finalize`/`finish` commit (post-execute + context deferral + settle append) — so ordered policy stages never overlap each other and only the around-dispatch/body stage runs concurrently, exactly the native loop's sequencing (`fillPool` awaits `startCall` then `commitReady`). Consecutive parallel-classified calls overlap up to `maxParallelSubCalls` (a `Config` field validated by the Loader schema AND re-validated at direct construction, default 10 — the loop scheduler's own default; `1` restores serial dispatch); an exclusive call drains the pool, runs alone, and holds its barrier until its COMMIT completes (post-execute included), like a native exclusive group. Run settlement aborts in-flight dispatches and abandons queued-unstarted ones (binding rejection, no events), then drains to quiescence — including a commit already mid-flight when the program returned — before the outer result closes the turn.
- **Client**: Runtime's `ToolCallTree` stores a start event as a `RunningToolCall` child and projects it through the parent's recursive `subCalls` (rows derive the running ring from that shape, exactly as for native in-flight calls). Its settle replaces the private-index entry in place, preserving start order under parallel completion and carrying the start's `time` as `callTime` (duration source). A settle with no observed start (window cut mid-pair, or a pre-start-event log) appends directly, so old logs keep rendering.
- **SDK prompt**: the model-facing "calls execute sequentially" sentence is replaced with the true contract (independent safe calls may overlap under `Promise.all`; dependent work sequences with `await`) — a model-visible change, re-recorded across every ptc snapshot.

## Alternatives considered

**Unrestricted parallelism (let `Promise.all` overlap everything).** Rejected: writes could race; the native scheduler exists precisely because the tool, not the caller, owns the safety claim. One concurrency vocabulary across native and PTC mode was the settled requirement.

**Emit the start event at submission instead of pool entry.** Rejected: a submission-time start would show queued-but-never-run calls as "running" and would force a third "abandoned" terminal event to reconcile the log. Start-at-entry keeps the invariant *started ⇔ settles exactly once* and needs no third event.

**Reuse the loop scheduler's implementation directly.** Rejected: the loop schedules a fully-parsed batch with model-order result commitment; the bridge schedules an open-ended stream of submissions whose results return to the program (not the transcript), so only the *contract* (classification, pool, barriers) is shared, not the machinery.

## Consequences

Programs get native-grade latency for independent reads with no new model-side API — `Promise.all` simply works better, and prompt guidance changed accordingly. The web UI shows per-sub-call running rings live (fixture emits start/settle pairs; jsdom pins the running shape; the runtime spec pins in-place settlement, out-of-order completion, and callTime pairing). Trajectory/waterfall sub-call spans draw truthful timing from the pair. Spill bounding ([ptc-dispatch log spill](../../archived/feature/2026-07-26-ptc-dispatch-log-spill.md)) inherits the settle event as its single bounding point.
