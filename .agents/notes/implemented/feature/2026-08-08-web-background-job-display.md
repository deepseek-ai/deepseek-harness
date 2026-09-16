# Agent Note: Web background-job display

Status: implemented

English | [中文](2026-08-08-web-background-job-display.zh.md)

## Problem

`ctx.jobs` already runs every long-lived piece of work the harness starts in the background — `bash`, `pwsh`, `pty-send`, and one-shot background subagents — but its only reader was the model. [`dsh-tool-jobs`](../../../../packages/jobs/tool-jobs/README.md) exposes `job_list`, `job_output`, and `job_kill`, and nothing else observed the registry.

A human at the Web client therefore could not see that a build was running, could not distinguish a finished task from a stuck one, and could not stop one. The only trace was the `run_in_background` tool card that printed a job id somewhere earlier in the transcript, and that card never updates again.

The session header was already the place where per-session background activity lives: [`dsh-client-ui-subagent`](../../../../packages/client/ui-subagent/README.md) contributes the subagent catalog to `conversation.session.header.actions`. Placement was settled. What was missing was any channel at all that carried task state to a browser.

## Decision

Task state reaches the browser as **one whole-snapshot control frame per session**, pushed at every registry commit point that changes what that session can see. The client keeps a last-wins mirror; a header action renders it. There is no RPC, no polling, and no client-side staleness bookkeeping.

This ships the list alone. Per-task streamed output and a human-initiated cancellation are separate phases, and the channel is shaped so neither has to undo it.

### Wire shape

One frame in the Session Controller control stream:

```ts ignore-check
| { type: 'jobs'; sessionId: SessionId; jobs: SessionJob[] }
```

`SessionJob` is browser-safe and owned beside the other Session Remote contracts in [`packages/api/session-controller/src/types.ts`](../../../../packages/api/session-controller/src/types.ts):

```ts
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'

export interface SessionJob {
  id: JobId
  kind: string
  label: string
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  detail?: string
  startedAt: number
  finishedAt?: number
}
```

`JobId` comes from the cordis-free [`@deepseek-ai/dsh-jobs/brand`](../../../../packages/jobs/jobs/src/brand.ts) leaf — the same arrangement as the `@deepseek-ai/dsh-llm/brand` import `api/subagents.ts` already uses, because the `dsh-jobs` root reaches `dsh-agent` and is unreachable from a client program even as a type. Like every other non-root subpath in this workspace, it carries an explicit `tsconfig.base.json` `paths` entry; without one the Typert analyzer resolves the specifier to `lib/types/` and rejects the reference as unexported.

`kind` is `string` on the wire rather than `JobKind`. The kind map is merge-extensible by producer plugins, so a client build cannot enumerate the closed set; presentation falls through a documented default for an unrecognized kind.

Three `JobSnapshot` fields are deliberately absent: `ownerSession` (the frame's `sessionId` already carries it), `reported` (an internal notice-delivery bit with no user meaning), and `outputLimitBytes` (producer-owned model-presentation policy).

The frame carries a whole snapshot rather than a delta so start, kill, settlement, reconnect, and a second browser tab all converge through one authoritative value. A session's task set is single-digit; the frame is small.

### The task-registry change feed

`JobRegistry` owns one observation method:

```ts ignore-check
abstract onJobsChanged(listener: JobsChangedListener): () => void
```

It fires **after** every commit that changes what `list(owner)` returns: registration at the end of `start()`, the `stopping` transition in `kill()`, settlement, and the removal `disposeOwner()` performs. An `undefined` owner means an unowned task changed, and therefore every caller's view changed.

The listener is owner-granular rather than task-granular. The only consumer pushes whole snapshots, so a per-job record would be discarded on arrival — and a per-task feed cannot express the owner-disposal removal at all without inventing a tombstone status nothing else needs.

`onJobDone` is not a subset of this. It delivers the terminal record with the exact owner `Agent` under first-wins semantics that `dsh-tool-jobs` couples to `reported`; `onJobsChanged` is pure observation with no delivery meaning and marks nothing reported. Listener throws are contained and never awaited, matching `onJobDone`, and each registration is an effect on the calling fiber.

Service disposal deliberately announces nothing. Every `onJobsChanged` registration is an effect on the registry's own fiber, so the listeners are already gone by the time teardown clears the store; an observer learns the registry left through its own disposal, not through a final empty set.

### The Session Controller carrier

[`SessionControlController.control()`](../../../../packages/api/session-controller/src/control.ts) emits one complete Host-wide baseline before later `jobs` replacement frames. Every physical reconnect opens a new generation, so the client replaces its process-local mirror before applying further changes.

Four rules the carrier keeps:

- **Never resume.** A change push reads `jobs.list(owner)` with the exact `Agent` the listener supplied, which stays correct even while that owner's scope is tearing down and a lookup by id would already miss. The baseline instead reads `ctx.jobs.list(ctx.agents.get(session.id))`, where a Session with no live Agent correctly yields only unowned tasks. Neither path calls the [Session Controller Agent resolver](../../../../packages/api/session-controller/src/agent.ts), because listing must never revive a Session the user merely scrolled past.
- **Fan out unowned changes.** An `undefined` owner pushes a fresh snapshot to every attached Session, because unowned tasks are visible to every caller.
- **Stay optional.** The carrier reads `ctx.get('jobs')`. A composition without the registry reports empty job sets, and the client renders no entry point.
- **Represent emptiness explicitly.** The opening baseline contains an entry for every attached Session, including `[]`; a later change that empties one list also pushes `[]`. The client may then normalize an empty set to an absent key without retaining stale rows.

### The client mirror

`SessionListState` carries `jobsBySession: Readonly<Record<SessionId, readonly JobView[]>>`, owned by `SessionManager` and folded from the frame under last-wins, with an emptied set stored as an absent key so absence and `[]` are one representation.

It lives on the list mirror rather than on `Session` for three reasons: the header action already reads list state through `useSessions`, no composer behavior depends on tasks, and a later sidebar indicator gets the data without opening a second channel.

Two replacement points keep it honest. Each control-stream generation clears the complete jobs mirror before installing the new baseline's non-empty sets. An `api-session/removed` event also drops that Session's entry, independently of the job-registry disposal notification's ordering.

### The header action

[`@deepseek-ai/dsh-client-ui-jobs`](../../../../packages/client/ui-jobs/README.md) registers one entry in `conversation.session.header.actions`, ordered after the subagent catalog. Its own README owns the presentation contract; the decisions worth recording here are that the control does not render at all until the session has a task, that the live badge is omitted at zero so a history-only session keeps a quiet entry point, and that settled rows stay visible because a failed task's `detail` is the only place its failure is legible.

A running one-shot background subagent therefore appears both there and in the subagent catalog. The two answer different questions — the catalog navigates into the child's transcript, this list is the only handle a cancellation can ever attach to — and suppressing `kind: 'subagent'` here would leave the cancellation phase with no entry point for exactly those tasks.

### What this deliberately does not do

**No web path calls `ctx.jobs.read()`.** It consumes the single output cursor, so a browser read would silently take bytes the model's `job_output` will never see. This is an invariant worth a test rather than a convention, because the failure is invisible at the call site.

**No cancellation.** That phase owes a decision the seam does not currently answer: `kill()` marks terminal delivery reported, so a human interrupt written against the `kill()` contract would leave the model believing its task is still running.

**No output watermark on the frame.** The output phase's delta channel is where an anchor field earns its place; one added now would have no reader.

## Alternatives considered

**Signal frame plus RPC pull, the subagent-catalog shape.** Push a payload-free `jobs-changed` signal, debounce, then re-read authoritative state over a unary RPC. This is what the subagent catalog does, and the cost is visible in [`SessionManager`](../../../../packages/api/session-controller/src/client/sessions/manager.ts): `catalogInflight` for single-flight, `catalogStale` for a trailing re-pull when a membership frame lands mid-request, `updateCatalogActivity` patching loaded rows in place *and* writing into the in-flight request so a response older than the frame gets overwritten, `parentAvailableOverride` replaying a stale `false`, and a reconnect path re-pulling every open catalog. That apparatus exists because the catalog's authority is split — durable lineage from a projection, liveness sampled at response time — and tasks have no durable half to justify inheriting it. It also fails specifically at the moment the output phase cares about: a task settles, its output stream closes immediately, but status only arrives after debounce plus round-trip, so the UI shows a running task with a dead stream for that window.

**Popover-scoped polling with no seam change.** Cheapest to build and the only option that avoids touching `JobRegistry`. It cannot support a resident count on the trigger without a resident poll, and both later phases need a real change feed anyway, so it buys a week and spends it back.

**A session-projection unit over durable task events.** Projection units fold over committed session events, so this would first require task lifecycle to become durable — `job/started` … `job/settled` as a standalone open/close bracket, with the last [`session/end-seed`](../../../../packages/core/session/src/types.ts) marking any unmatched opener as dead history, exactly as the compaction bracket already does. It is genuinely cheaper on the client: `dsh-tool-todo` shows the whole pattern in a fifteen-line unit, and the existing `session/projection` frames, history-tail block, and persisted checkpoint cache would have carried the data with no new wire surface, no carrier subscription, and no manager state. It was rejected because it buys that with a durable format change in service of a browser list, and because it does not extend to the phase it would most need to: [`spill/`](../../../../packages/spill/README.md) exists precisely so oversized tool output stays out of the log, so streamed job output cannot ride durable events either way. Nothing here forecloses revisiting it if durable task history becomes valuable on its own merits.

**Reusing `PublicJobSnapshot` from `dsh-tool-jobs`.** Nearly the right fields, but it belongs to the model-facing control surface. A wire type a browser program imports from a tool package couples client presentation to prompt-facing decisions and drags a host-only package into a client build.

**Folding tasks into the subagent catalog as one "activity" panel.** One entry point instead of two. Rejected because `SubagentCatalogAction` is already 605 lines whose subject is a durable session-lineage tree including finished children; process-scoped tasks are a second data model with different identity, lifetime, and affordances, and the catalog's lazily-expanded branch, duration, and token contracts would all need rewriting to host them.

**A host-global task list across every session.** The literal reading of "show all running tasks". Rejected because the registry's authorization fence is per-owner-session, so a global read needs a new access rule, and a global list has no business in a session's header — it would need its own home in the sidebar. Nothing in this design blocks adding it later; the per-session frames are the same data.

## Testing

The [web e2e scenario](../../../../apps/web/tests/background-job-list.e2e.ts) is the end-to-end proof and runs keyless: a real `run_in_background` bash call registers with `ctx.jobs`, the header count and row appear with no user interaction, and killing the task through the registry flips the open list to its producer detail. It asserts the whole delivery path rather than any single layer.

Below it, [`jobs-local`](../../../../packages/jobs/jobs-local/tests/jobs.spec.ts) pins the change feed at all four commit points, its containment of a throwing observer, and its removal on both explicit disposal and fiber teardown; [`control-jobs`](../../../../packages/api/session-controller/tests/control-jobs.host.spec.ts) pins the complete baseline, three change pushes, dropped internal fields, unowned fan-out, no-resume guarantee, registry-absent composition, and the prohibition on consuming model output; and the client suites pin baseline replacement, the last-wins fold, the absent-key representation, removal cleanup, and the component's ordering, duration, and dismissal behavior.

## Consequences

**A missed commit point leaks rows.** If `disposeOwner()` removal ever stops firing the feed, the client keeps tasks that no longer exist until the session disappears. The whole-snapshot shape makes this recoverable rather than corrupting — the next legitimate change repairs the list — but the disposal path is the one most easily forgotten, so it carries its own test.

**Unowned-task fan-out is easy to under-implement.** Pushing only to the changed owner's session is correct for owned tasks and silently wrong for unowned ones, which are visible everywhere. The bug would surface only in compositions that create unowned tasks, which is why the carrier suite covers it directly.

**The UI set is not the registry's set.** The header shows what one session can see, so a task owned by another session never appears in it even though the registry holds it — and because the registry is process-local, a restart empties every list while the transcript still shows the `run_in_background` cards that started them. Unowned tasks are the opposite case: they reach every session's list, exactly as `list(caller)` reports them to every caller.

**Settled rows accumulate.** The registry retains settled tasks until owner disposal, so a long session with many background commands grows a long list. Capping the settled tail is a presentation change, not a protocol one, if it becomes a real complaint.

**`stopping` is rarely visible.** Only the model's `job_kill` produces it, so the state is rendered but rarely seen until human cancellation lands. It is in the union now because leaving a status out would have made that phase a wire change.

**Two entry points for one running subagent.** Accepted deliberately, and bounded to one-shot background delegations. If it reads as noise in practice, the fix is presentational — the catalog row can cite the task rather than the task list hiding the kind.

**A new non-root subpath needs its `paths` entry.** `@deepseek-ai/dsh-jobs/brand` had to be registered in `tsconfig.base.json` before the Typert analyzer would accept the reference. The failure mode is a confusing "not exported by" error from a generator far from the edit, so the entry is part of adding a subpath, not an optimization.
