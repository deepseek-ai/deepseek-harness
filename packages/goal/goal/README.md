---
description: "The persisted same-session goal service for users and maintainers choosing, configuring, or debugging one durable completion objective per session."
kind: "package-reference"
---

# @deepseek-ai/dsh-goal

English | [中文](README.zh.md)

## Summary

`dsh-goal` lets one long-running completion objective persist across turns, session resume, fork, and process restarts. Users and agents can create, edit, pause, resume, complete, block, or clear it; compare-and-set updates reject stale views. A configurable round cap (256 by default) bounds automatic continuation, and blocked goals retain a stable policy code with a human-readable explanation. The package stores goal state but does not schedule work, and continuation permission remains process-local rather than durable. Choose it for one objective spanning many turns; skip it for routine single-turn work or parallel objectives.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `dsh-goal` whenever a session should remember one long-running completion objective across many turns and restarts. The package is a service: the model tools, the `/goal` command, and the continuation driver are separate packages that consume the same goal state, so mounting only this package stores and serves the goal without starting any work.

### When to use it

A goal suits one long-running completion objective that should continue across autonomous goal rounds — for example shipping a migration or fixing every failing documentation gate. Routine single-turn work should not create a goal. The service keeps at most one current goal per session: an unfinished goal must be edited, paused, resumed, blocked, or cleared before another takes its place, while a completed goal can be replaced directly.

### Set up the service

Load the package with a composition entry; the only deployment choice is the default round cap applied to creates that do not name their own.

```yaml
- name: '@deepseek-ai/dsh-goal'
  config:
    defaultMaxGoalRounds: 256
```

| Field | Default | Meaning |
|---|---|---|
| `defaultMaxGoalRounds` | `256` | Round cap applied when a create request omits its own |

`defaultMaxGoalRounds` must be a positive safe integer; a create request that names its own cap overrides it. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-goal) is the exhaustive source for every accepted field.

### Session projection

`GoalService` requires `ctx.sessionProjections` ([`@deepseek-ai/dsh-session-projection`](../../session/session-projection/README.md)) and registers the `goal` projection unit at startup; a composition that omits the projection registry cannot activate `ctx.goals`. The unit's version 6 host state retains the latest valid current goal, every previously used goal id, and the first strict replay failure. Its client view exposes the current goal or `null` before the first create and after a clear tombstone. The key merges into both `SessionProjectionStateMap` and `SessionProjectionMap`; carriers serve the client value on the history tail page and the `session/projection` push frame.

### Drive the lifecycle

A goal moves through four durable phases — `active`, `paused`, `blocked`, `complete` — plus a process-local flag that says whether automatic continuation is armed. The verbs:

| Operation | What it does |
|---|---|
| `create` | Starts an active goal with an objective and round cap |
| `edit` | Changes the objective and/or round cap without changing the phase |
| `pause` | Stops automatic continuation and keeps the state |
| `resume` | Restarts continuation; also rearms an active goal after session resume or fork |
| `complete` | Marks the goal achieved and stops continuation |
| `block` | Records a stable blocker code and explanation |
| `clear` | Removes the current goal; its history stays in the session log |

Pause, completion, blocking, and clear all disarm continuation. Blocking is the one phase that keeps a policy-owned lower-kebab-case code and a free-form explanation, so provider limits, exhausted budgets, execution errors, and requests for human input share a single durable phase instead of multiplying lifecycle states. Resume accepts a stopped goal, or an active but disarmed one, only while the round cap has remaining capacity, and it clears any former blocker reason.

### What survives and what does not

Every accepted change is recorded durably in the session log — the only store of goal state — so goal state never depends on transient message delivery. After session resume or fork, the goal, its phase, its revisions, and its admitted-round count are all still there. Automatic continuation is the exception: an active goal is disarmed after any session-start edge, so the agent does not continue on its own until someone explicitly resumes it.

### Observing a goal

Consumers read the current goal with `ctx.goals.get(agent)` and receive a detached view: objective, phase, rounds started versus the cap, blocker reason when blocked, and whether continuation is armed. Mutations must carry the exact `{ id, revision }` from that view, so a consumer holding older state receives a clear stale-revision error instead of silently overwriting newer state:

```text
const view = ctx.goals.get(agent)      // undefined when no goal is current
view.phase                             // 'active' | 'paused' | 'blocked' | 'complete'
view.roundsStarted, view.maxGoalRounds // continuation progress
view.activation                        // 'armed' | 'disarmed' — not persisted
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the service realizes the behavior above; the observable contract is covered in [Use this package](#use-this-package).

### Design

- **Event-sourced state.** Every mutation appends a durable `goal/change` event (version 1) carrying the complete post-mutation snapshot; `clear` writes a revisioned tombstone. The session log is the only durable authority.
- **Compare-and-set mutations.** `ctx.goals` accepts only the exact live `Agent` registered under its id. `get()` returns a detached `GoalView`; mutations take a `GoalRef { id, revision }` and reject stale refs. Creation resolves the deployment default internally before committing.
- **Activation is process-local.** `armed` and `disarmed` live in a per-session cache and are never persisted. A fresh cache and every `agent/created` edge disarm continuation even when replay finds an active durable phase; `disarm()` removes authority without writing a revision or emitting a mutation.
- **Strict replay.** The fold derives lifecycle mutations only from `goal/change` and rejects malformed shapes, discontinuous revisions, illegal phase transitions, non-monotonic per-goal timestamps, and non-sequential admitted rounds. Positive rounds advance only on admitted goal-sourced `user/message` events, and mutation timestamps clamp against the preceding update when wall time moves backward.
- **Projection unit.** The package requires the projection registry and registers a strict `goal` unit. Its host state retains replay validation data and the first failure, while its client view exposes the latest valid whole goal or `null`; `GoalService` rejects access after a retained replay failure.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `GoalService`, config schema, mutations, activation cache, projection unit |
| [`src/domain.ts`](src/domain.ts) | Durable change payloads, `goal/changed` event, goal message-source attribution |
| [`src/types.ts`](src/types.ts) | Pure client-safe types: `GoalView`, `GoalSnapshot`, `GoalActivationChanged`, projection-key declaration |
| [`src/fold.ts`](src/fold.ts) | Strict replay fold and decoder for durable goal changes |
| [`src/runtime.ts`](src/runtime.ts) | `GoalId` brand, `GoalError` codes, change-version constant |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: independent incremental fold over every attached session |

### Events and attribution

`goal/changed` fires after the durable event commits, with listener failures contained; the payload carries the operation, the exact ref, and the fresh view (absent for a clear tombstone). `goal/activation-changed` forwards a process-local `armed`/`disarmed` edge with the exact current ref, or no goal after a clear, without changing durable state. Admitted continuation rounds are attributed through `GoalMessageSource { goalId, revision, round }` on the `user/message` event, which the strict fold validates as the next admitted round of the current goal.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The package-level contract is enough for most consumers; read these when you need the surrounding domain and the design rationale.

- [Goal subsystem](../../../docs/subsystems/goal.md) — the goal types, durable change payloads, and generated service API.
- [Goal group map](../README.md) — the goal packages and how they compose.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-goal) — every accepted config field and its source declaration.
- [Goal domain Agent Note](../../../.agents/notes/implemented/feature/2026-07-19-persisted-same-session-goal-domain.md) — the domain design, alternatives, and decisions.

-----

<a id="model-experience"></a>
## Model Experience

### Goal-state mutations

#### What the model sees

Goal mutations do not inject model context. Tools such as `get_goal` return the current state, and a continuation consumer may render the objective and round state when it schedules model work.

#### Token effect

Goal mutation events add no model tokens by themselves. Tool results and scheduled continuation prompts account for their own visible state.

#### KV Cache effect

There is no KV-cache effect until another component exposes goal state in model-visible input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the goal service is a poor fit or needs special care. They are current package constraints, not a task backlog.

- **State, not scheduling** — this package does not decide when an armed goal continues, retry abnormal failures, or cancel an active turn; those policies belong to consumer packages such as `dsh-goal-round-driver`.
- **Round-count budget only** — `maxGoalRounds` does not meter tokens, currency, wall time, or provider quotas.
- **No independent evaluator** — the caller that records completion or blocking is authoritative; evaluator-backed certification is deferred to a separate policy layer.
- **One current goal** — parallel objectives and a separate goal database are intentionally absent; history remains available in the session log after replacement or clear.
- **Trusted in-process producers** — a plugin with direct `Session` access can append counterfeit `goal/change` data. Strict replay detects malformed or inconsistent records and leaves goal access failed at that record until the log is repaired; this is integrity detection, not plugin isolation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Open, undecided directions: an always-visible goal context plugin for deployments that want the objective in every model request, and evaluator-backed certification of completion and blocking claims.

</details>
