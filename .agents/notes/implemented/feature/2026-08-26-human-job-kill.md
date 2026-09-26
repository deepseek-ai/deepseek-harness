# Agent Note: Human job kill — an unclaimed terminal report instead of a second cancellation path

Status: implemented

Update: the `reported` option this note introduced is gone with the [jobs seam consolidation](../architecture/2026-09-03-jobs-seam-consolidation.md). The registry keeps no report bit; `dsh-tool-jobs` claims only its own `job_kill` and waits in a ledger, so a human `job.kill` leaves the notice due by construction. The reason merge, the `job.kill` Remote, and the two-press control are unchanged.

English | [中文](2026-08-26-human-job-kill.zh.md)

## Problem

The [web job display note](2026-08-08-web-background-job-display.md) shipped the task list read-only and recorded why: `JobRegistry.kill()` marks the job `reported`, and the [`dsh-tool-jobs`](../../../../packages/jobs/tool-jobs/README.md) completion reporter suppresses the settlement notice for a reported job. That coupling is correct for the one caller that existed — the model's `job_kill`, whose own tool result already tells the model what it did — but a human pressing a stop button has no model-visible channel at all. A kill written against that contract would leave the model believing its task is still running, exactly the stale-world-model failure Claude Code ships today (its `/tasks` kill sets `notified: true` and the model learns nothing) and Kimi avoids (a model `TaskStop` suppresses its own notification; a human stop delivers one).

## Decision

A delivery claim means "the terminal state has a committed delivery path to the model", so the fix is to stop conflating cancellation with claiming that delivery.

- **A human kill claims no delivery.** `JobRegistry.kill(id, { reason? })` records the reason only; the delivery ledger lives in `dsh-tool-jobs`, which claims a job for the model's own `job_kill` and for its waits, so a `job.kill` from the task list leaves the settlement to the existing completion reporter (wakeup/inject, wake budget, truncation all unchanged). It never clears a claim the model already holds, and a terminal record stays exactly as settlement left it.
- **A recorded kill reason merges into a `killed` settlement's detail** — producer facts first (`signal: SIGTERM; cancelled by the user`) — so the completion notice and the web row both say who stopped the work without a new snapshot field or notice template. A job that outruns its kill (settles `completed`/`failed`) keeps the producer detail alone. This is the reconciliation Codex spells out in its `<turn_aborted>` guidance: when the user stops something, the model is told rather than left to infer.
- **`job.kill` is a Job Controller Remote** (`@deepseek-ai/dsh-api-job-controller`, beside `job.follow`; it began life as `session.killJob` on the Session Controller and moved with the observation stream when that package split out) with the same live-only Agent lookup (`ctx.agents.get`) as `session.cancel`: a running job's owner is alive by the registry's ownership contract, and killing from a list must not revive a Session any more than listing does. Unknown and foreign jobs collapse to one `job/not-found` rejection scoped to the lookup — a producer-cancel throw propagates per the registry contract instead of masquerading as a lookup failure; the controller requires `ctx.jobs` to load, so a composition without a registry has no kill Remote at all. The registry's owner fence is the only access rule: the Session Controller's subagent ownership fence is not applied, so a child session's own jobs are killable from its list (review rejected exporting that fence's helpers from the Session Controller package, and the rule adds nothing for a job the child owns), and the controller depends on neither the agent registry nor the Session Controller. No approval interaction: this single-user local BFF treats it as the same class of action as the turn-cancel button.
- **The task list's stop control is two-press** (arm, then confirm within 3s, matching the Kimi `s`+`y` and OpenCode double-Esc shape), rendered only on running job rows — rows with a `jobId`. Standalone activity rows (workflow runs) have no kill handle and no button. The pending press disables the control and stays pending on an admitted kill — the unary response and the jobs frames have no cross-carrier ordering, so only the authoritative frame (the row leaving the killable set) releases it; a rejected kill shows a brief hint. Because the kill addresses `ctx.jobs` by id, every job kind gains the control at once — bash, pwsh, pty, and one-shot background subagents.

## Alternatives considered

- **A `notify: boolean` option** — rejected because the registry cannot promise a notice (quiet delivery, unowned jobs, owner teardown all legitimately drop one); the ledger's claim names the fact the tool actually controls: whether one of its own tool results already delivered the terminal state.
- **A separate `interrupt()`/`stopByUser()` method** — one cancellation path with an explicit claim beats two methods whose only difference is a boolean, and Kimi's split (`stop` vs `stopByUser`) shipped with its TUI calling the wrong one.
- **Saying nothing to the model (Claude Code's shape)** — rejected; their own source comments question it, and the DSH blocker note recorded the stale-belief failure as the reason the control did not ship earlier.

## Testing

`tool-jobs` pins the ledger (a kill the model did not request leaves the notice due; its own `job_kill` and waits claim it) and the delivered notice text verbatim, reason included; `jobs-local` pins the detail merge on `killed` and the outran-kill case. `kill.host.spec.ts` pins the Remote command: admission, unowned-job kill from an agentless session, `job/not-found` for unknown/foreign. The client suites pin the RPC passthrough and the two-press control (arm, confirm, disarm timer, failure hint, single armed row, stale-phase cleanup); the keyless web e2e drives the button end to end.

## Consequences

- The completion notice for a human kill wakes an idle owner (default `wakeup` delivery) — a deliberate cost: an unclaimed completion the model never learns about is the failure this note exists to fix.
- `kill`'s positional `reason` parameter is gone (pre-release, no shim); the options object is the only form.
- A killed job's `detail` may now carry two clauses joined by `; `. Anything parsing `detail` as a single producer fact must treat it as opaque text, which `JobView.detail` always declared it to be.
