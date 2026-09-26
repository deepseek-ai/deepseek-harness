# Agent Note: The activity observation seam (`ctx.activities`) and live output streaming to the Web client

Status: implemented

Superseded: the standalone seam described here was folded into `ctx.jobs` as the per-job observation record — see [jobs absorb the record](../architecture/2026-09-01-jobs-absorb-activity-record.md); the durable-vs-live analysis below still holds.

English | [中文](2026-08-24-activity-observation-seam.zh.md)

## Problem

Every incremental reader in the shell, terminal, and jobs layers is single-consumer and consuming: `ShellProcess.readOutput()`, `TerminalSendOperation.readOutput()`, and `JobRegistry.read()` all destroy the delta they return, because the owning model is the intended reader. The [web background-job display](2026-08-08-web-background-job-display.md) shipped the roster on those terms — its carrier is test-pinned to never call `ctx.jobs.read()`, since a browser read would silently steal bytes the model's `job_output` would never see — and explicitly deferred the output phase to "a separate non-consuming observation API". So a human watching the Web client saw that a background build was running but never a line of its output, and the `workflow/log` / `workflow/phase` events scripts are told to narrate with had no consumer at all.

The substrate below bash already had the right shape: `SubprocessOutputReader.readFrom(fromByte)` is offset-based and explicitly non-consuming, and `bash-local` narrows it to a single cursor pair at the shell seam.

## Decision

A new capability seam, `packages/activity/`, is the non-consuming observation plane. An **activity** is one observable unit of long-running work: an append-only bounded output stream plus live status. The seam is pure observation — it starts nothing, cancels nothing, and is invisible to the model. Model-visible facts stay exactly where they were (tool results, `ctx.jobs` cursors), so the "model-visible ⟺ logged" invariant is untouched and a composition without the seam loses only live observation.

- **`@deepseek-ai/dsh-activity` (Service Definition)** — abstract `ActivityRegistry` on `ctx.activities`: `open(spec) → ActivityHandle { append, updateDetail, end }`, fenced `get`/`list`, non-consuming `read(id, from)` over absolute UTF-8 byte offsets, owner-relative `onActivitiesChanged` (roster) and `onOutput` (advancement signal, id only). `ActivityCorrelation { callId?, jobId? }` links a row to its tool call and job. `pumpActivityOutput` is the shared pull-substrate pump.
- **`@deepseek-ai/dsh-activity-local` (Service Provider)** — in-memory chunk ring per activity. Offsets stay absolute across eviction (`outputEarliest` marks the oldest retained byte; a read below it is `lossy`, never an error); a single over-cap chunk keeps its UTF-8-safe tail with `gapBefore`. Config `retainBytes` (256 KiB) live, trimmed to `settledRetainBytes` (16 KiB) at settlement. Records outlive producer fibers; owner disposal force-ends and removes; `end` is first-wins and post-end writes log-and-drop so a producer's trailing flush cannot break its own teardown.
- **`@deepseek-ai/dsh-api-activity-controller`** — the wire, in the workspace-controller shape: `activity.control` streams one roster baseline then whole-bucket replacement frames per owner session (the jobs-frame self-healing semantics), and `activity.observe({ activityId, from? })` streams one `opened` anchor, coalesced `output` frames (`flushMs` window, `maxFrameBytes` soft budget), then the terminal `status` on the same stream before closing — so settlement can never race a still-open output channel. Reconnects resume from the last frame's `next`. The client half installs `ctx.activityFeed` (roster mirror plus reference-counted observation streams with a bounded render tail).
- **`@deepseek-ai/dsh-client-ui-activity`** — the session-header task list ([unified with the job rows](../../archived/feature/2026-08-25-unified-task-list.md)); expanding a row opens its observation stream into a `TerminalBlock` panel, collapsing closes it, so output only flows while someone is watching. `TerminalBlock` itself gained live rendering: a running block with supplied `output` shows the text under the running state instead of the historical prompt-only frame.

Producers mirror best-effort behind `ctx.get('activities')`, never a declared inject, and every observation failure is logged and swallowed — the seam is strictly optional and can never break the work it observes:

- `ShellProcess` gained optional `observed` — the substrate's non-consuming offset readers re-exposed (bash-local and pwsh-local return `handle.collected`; the e2b subprocess provider satisfies the same contract). `dsh-tool-bash` / `dsh-tool-pwsh` open a correlated activity after `jobs.start()` commits and pump `observed` at `activityPollMs` (default 150 ms).
- `dsh-tool-workflow` mirrors each recorded top-level run as a push-mode `workflow` activity, giving the previously unconsumed `workflow/phase` / `workflow/log` events their consumer.

### Why not durable session events, the control stream, or the jobs seam

Peer products converge on the same split (Codex marks every exec-output delta "Transient, non-durable" in its rollout policy; Claude Code persists a file path, never deltas; Kimi's envelope has a first-class `volatile: true`; OpenCode's V2 corrected V1's per-chunk durable part updates to "stream fragments are live-only"). In this repository the durable route is also concretely bad: chunk-run packing is hardcoded to the three `assistant/chunk` shapes so a new output event gets zero compression, each event is one uncoalesced WebSocket frame, and reconnect gap-repair re-reads the window — and the job-display note already rejected it ("spill exists precisely so oversized tool output stays out of the log"). The session control stream's whole-snapshot frames are self-healing for rosters but quadratic for streams. Extending the jobs seam would cover only jobs — not workflow narration, not a future foreground stream — and would re-litigate the settled "producers own their buffers" decision; the activity plane instead recovers the substrate's existing offsets.

### Two cursor regimes, kept separate

The model keeps its consuming cursors (`job_output` semantics unchanged, zero prompt or tool changes anywhere in this work); observers get absolute offsets any number of readers can hold. This mirrors the strongest peer pattern (Codex: destructive drain for the model, seq-cursor reads for infrastructure) and is what makes the wire path provably non-stealing.

## Alternatives considered

**Durable `activity/output` session events with a conversation node.** Replay for free, but the log-growth math above, plus retention pressure on every follower, killed it; the transcript's durable story remains the producers' tool results.

**Extending `SessionControlFrame` with output.** One fewer stream, but whole-snapshot semantics resend the accumulated buffer per chunk — O(n²) on exactly the data that grows.

**A signal frame plus RPC pull.** The subagent-catalog shape; rejected for the split-authority apparatus the job-display note documents, and it fails worst at settlement (running row, dead stream).

**Observation inside the jobs seam.** One integration point, but only for jobs; foreground runs, terminals, and workflow narration would each need another mechanism, and the registry would grow a second buffer beside the producers' own.

## Testing

Unit suites pin the registry (offsets, eviction, UTF-8-safe tail trims, lossy reads, first-wins settlement, owner cleanup, scoped delivery, listener containment, HMR disposal, Loader composition with row config), the pump (cadence, per-source cursors, lossy `gapBefore`, settlement drain, timer hygiene), the controller (baseline/bucket frames, anchor/output/status ordering, resume, frame splitting, fenced owned reads, abort), the client model and reference-counted streams, and both producer taps (real subprocess output for bash including the never-steals-the-model's-cursor assertion; scripted readers for pwsh; event-driven mirror for workflow, including the throwing-registry containment the optionality promise requires). The keyless web e2e drives a real `run_in_background` bash through the full composition and pins ARIA goldens for the streaming panel while the command still runs and for the settled panel after a registry kill.

## Consequences

The Web client now shows live output for background bash/pwsh and workflow narration with zero model-facing change, and any plugin can join with three calls (`open`/`append`/`end`) against an optional service. Bought at the cost of one more seam family and a per-producer tap; the initial two-header-list duplication was folded into [one task list](../../archived/feature/2026-08-25-unified-task-list.md). Deferred, recorded on the package READMEs: foreground streaming (needs a shell-seam run/observe variant), terminal `pty-send` observation (needs a non-consuming face on terminal buffers), a human kill control (blocked on the jobs `reported` contract), SDK/ACP consumers, and durable replay after restart.
