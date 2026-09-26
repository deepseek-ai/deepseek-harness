# Agent Note: The job registry absorbs the observation record; the standalone activity seam is removed

Status: implemented

Superseded: the record declaration (`JobStart.record`, `RecordingJob`, `readRecord`, `pumpJobOutput`) and the split wire (`SessionJob.record` on the session control stream, `ctx.jobOutput`) described below were consolidated into one output ring and direct operations on `ctx.jobs` — see [the jobs seam consolidation](2026-09-03-jobs-seam-consolidation.md). The argument for absorbing the standalone activity seam into `ctx.jobs` still holds.

English | [中文](2026-09-01-jobs-absorb-activity-record.zh.md)

## Problem

The [activity observation seam](../feature/2026-08-24-activity-observation-seam.md) shipped live output streaming as a second registry beside `ctx.jobs`: producers registered the same work twice (a job for lifecycle, an activity for observation), kept the two terminal states consistent by hand (`observeBackgroundActivity` waited for `proc.done` before mapping the outcome so a pump failure could not freeze a wrong terminal state), correlated the rows through `ActivityCorrelation.jobId`, and wrapped every observation call in registry-absent degradation branches. The Web client maintained two rosters (session-control `jobs` frames and the activity control stream) and joined them per row. Measured before the merge: eight pairing call sites, and one producer population — background bash/pwsh (both registries), PTY sends and subagent delegations (jobs only), foreground workflow (activity only).

The one activity without a job was the foreground workflow mirror. Everything else the split enabled — independent observers, absolute-offset reads, bounded retention — is a property of the record, not of the registry split.

## Decision

`ctx.jobs` owns the observation record; `packages/activity/`, `packages/api/activity-controller`, and the correlation vocabulary are removed.

- **`JobStart.record?: true`** declares an observable output record. `run(job)` now receives the job's producer face — `RecordingJob { id, append(text, {channel?, gapBefore?}), updateDetail(detail) }` for a `record: true` start, the plain `RunningJob { id, updateDetail(detail) }` otherwise — so the id is issued before the starter runs (a throwing starter still registers nothing; its ordinal is skipped). Writes staged inside the starter surface at the registration commit. `updateDetail` works for every job and gives `job_list` a live progress line; `append` without a record declaration logs and drops.
- **There is no `end`.** Job settlement — the producer outcome, a kill, or teardown — is the record's only close: it trims retention to the settled cap and fires the final `onOutput` signal. The dual-settlement pairing (`ActivityHandle.end` first-wins against teardown force-ends) is deleted, not reimplemented.
- **`readRecord(id, from, caller)`** is the non-consuming multi-reader view (absolute UTF-8 offsets, `lossy` below the retained window), fenced like every other job read; it never marks the job `reported`. The model-facing `readOutput` cursor is untouched — the two projections serve different readers and stay separate by design.
- **`jobs-local`** absorbs the chunk ring (`retainBytes` 256 KiB live, `settledRetainBytes` 16 KiB settled), and `pumpJobOutput` replaces `pumpActivityOutput` beside the seam. Producers fold the pump's final drain into `hooks.done` so the record holds its last bytes before settlement closes it.
- **The wire splits by role.** `SessionJob.record` (present exactly for record jobs) marks a row observable on the session control stream; `job.follow({sessionId?, jobId, from?})` on the `job` namespace of `api-job-controller` streams anchor/output/status frames with the fenced read resolved from the request's session. `api-activity-controller` is deleted; its roster stream is redundant (the jobs frames are the roster) and its observe machinery lives in `api-job-controller` (`observe.ts`, client `ctx.jobOutput`), which resolves its Remote faces in its own apply.
- **`ui-activity` returns to its upstream name `ui-jobs`** and renders one roster: `jobsBySession` rows, expandable exactly when `record` is present. The two-roster join is deleted.
- **Foreground workflow loses its live panel deliberately.** `tool-workflow`'s activity mirror is removed; a foreground run surfaces through its recorded run/member lifecycle events only, and the per-line `workflow/phase` / `workflow/log` narration has no observer until workflow gains `run_in_background` and registers a record job. Jobs stay a pure background registry — no `foreground` mode bit, no model-invisible rows, no run-less rows.

## Alternatives considered

- **A `foreground: true` job mode** to keep the foreground workflow panel: it needs two coupled enforcement points (reported-at-birth and a `job_list` filter) whose divergence double-delivers or leaks rows to the model, for one edge feature replaceable by `run_in_background`.
- **Serving model reads from the record** (deleting `readOutput`): model reads are producer-formatted (truncation and spill notices, sandbox markers) and consuming; the record is raw, channel-labeled, and non-consuming. Unifying them moves producer-specific formatting into the registry or noise into the observer stream.
- **Keeping the split with shared implementation** (a common registry library): it removes the duplicated skeleton but keeps the real costs — double registration, terminal-state pairing, correlation, a second wire roster, and a second package family.

The [prior seam note](../feature/2026-08-24-activity-observation-seam.md)'s argument against durable session events and control-stream framing for live output still holds and carries over unchanged: the record is process-local observation state, never a session event, so "model-visible ⟺ logged" is untouched.

## Review corrections

Review of the merged design settled five points that the sections above leave implicit:

- **The pump's wait holds constant resources.** `pumpJobOutput` subscribes to the producer's `done` once and keeps one pending timer; settlement clears the timer and wakes the current wait. Racing the same pending promise every poll round retained a reaction per round until the job ended — a day-long job at the default cadence accumulated over a million closures.
- **Client disposal waits for carrier quiescence.** The `ctx.jobOutput` effect disposer is async and awaits every open `RemoteStream.dispose()`, because Cordis awaits async disposers and a fiber that reported unloaded while an old iterator was still closing could overlap the next plugin instance under HMR.
- **The roster flags a record, it does not count bytes.** `SessionJob.record: true` replaced `outputTotal`: `append` commits no roster change (only lifecycle commits fire `onJobsChanged`), so a mirrored count went stale the moment output arrived, and broadcasting the roster per append was rejected as traffic for a number no row needed. The live offsets ride the observation stream's `opened` anchor.
- **The record is a best-effort live preview.** Producers copy stdout and stderr per poll round, so writes inside one window land stdout first; pipe capture cannot recover the true interleaving (only a PTY or `2>&1` can), and the client concatenates chunks regardless of `channel`. `channel` stays on the wire because it is what makes that limit visible and what a distinct stderr rendering would need.
- **The declaration types the face.** `JobStart` is a union discriminated by `record`: `RecordingJobStart.run` receives `RecordingJob`, `PlainJobStart.run` receives `RunningJob` without `append`, and the registry builds the plain face without the method — output the registry has nowhere to keep is unrepresentable instead of warned about and dropped.
- **Web e2e keep-alive is a barrier, not a clock.** The background command holds on a file the test owns in the job's cwd and the scenario kills it explicitly, so no CI stall can settle the job first; each scenario is one test, never a chain of tests sharing a job id.

## Consequences

Every observable row is a killable job; a pure-observation surface with no lifecycle would need a new home (harness diagnostics belong to the inspector plane, not here). A future remote job provider must implement lifecycle and record together. The record's retention config lives on `jobs-local`; the observation wire's cadence config (`observeFlushMs`, `observeMaxFrameBytes`) lives on `api-job-controller`.
