---
description: "The same-session continuation driver for users and maintainers choosing, composing, or debugging automatic goal rounds."
kind: "package-reference"
---

# @deepseek-ai/dsh-goal-round-driver

English | [中文](README.zh.md)

## Summary

`dsh-goal-round-driver` automatically continues an active goal in the same session: whenever the agent is idle with an active, armed goal and remaining round capacity, the driver starts the next goal round. Each round is one model turn toward the objective, driven by a retained goal-round prompt; only goal-sourced rounds count against the goal's round cap, and the goal records a blocker when the cap is exhausted. The driver has no configuration of its own — the round cap belongs to the goal definition and the model-facing blocked threshold belongs to `dsh-tool-goal`, so policy stays in one place. Mount it together with `dsh-goal` and `dsh-tool-goal` when a task should work itself toward completion across rounds; leave it out when every step needs human steering.

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

Mount `dsh-goal-round-driver` when an active goal should keep making progress without human intervention. It composes with the goal service and the goal tools: the service owns the state, the tools give the model control over it, and this package schedules the rounds.

### Compose it

Mount the driver beside the goal service and the goal tools; the driver itself takes no configuration.

```yaml
- id: goal
  name: '@deepseek-ai/dsh-goal'

- id: tool-goal
  name: '@deepseek-ai/dsh-tool-goal'

- id: goal-round-driver
  name: '@deepseek-ai/dsh-goal-round-driver'
```

`maxGoalRounds` belongs to the goal definition, while the model-facing blocked threshold belongs to `dsh-tool-goal`; duplicating either value in the driver could produce divergent policy.

### What each round does

With an exact live agent idle, an active armed goal, and remaining capacity, the driver queues one goal-round prompt. It names the JSON-quoted objective, round number, and cap, and tells the model to use current workspace, tool results, and durable state as authority. An accepted round starts a distinct request series, so Chat renders its self-contained request header before the goal message. The round enters history as a goal-sourced user message; only an entered goal message consumes the cap, while human messages and stale reservations do not. Goal lifecycle mutations still require the independent authority checks in `dsh-tool-goal`.

### When continuation stops

A round starts only at whole-agent idle, and completion, pause, and blocking suppress continuation; a host-initiated pause also aborts the turn already running, while a model-initiated pause inside its own turn finishes normally. An edit only invalidates an in-flight round through the revision fence, and the driver continues the new revision. The driver also stops on its own when a turn ends on max tokens, a durability write fails, the agent is cancelled, the plugin unloads, or the round cap is exhausted — at the cap it records a blocker with the stable code `round-limit`. Cancellation never auto-restarts a round: a goal whose round was under way or already queued is paused at the next idle point, and a cancellation unrelated to a goal attempt only disarms continuation.

### After resume, fork, or unload

Mounting the driver over an existing agent never arms a goal, and after session resume or fork an active goal stays disarmed until an explicit human-authorized resume — the driver never revives work on its own. Unloading the plugin cancels any in-flight round and ensures no later round starts.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the driver schedules rounds without races; the observable behavior is covered in [Use this package](#use-this-package).

### Design

- **Reservation, then admission.** At idle the driver reserves `roundsStarted + 1` for the current `{ goalId, revision }`, queues one `<goal_round>` prompt with a goal message source, and only an entered `user/message` increments `roundsStarted`. A reservation rejected as stale does not consume the round number.
- **Race fences.** The `agent/pre-step` listener verifies the complete claimed record against the current goal both before and after downstream listeners, so a stale, cancelled, or competing prompt is rejected before its step enters. Human work that arrives before a reservation makes automatic work yield until the agent is idle again.
- **Durability checkpoint.** `goal/changed` creates a durability obligation: before queuing work the driver awaits `ctx.sessions.flush()` and rechecks the goal revision and competing input after the await. A flush failure arriving through `agent/error` disarms continuation before another round can start.
- **Fail-closed teardown.** Teardown closes admission, disarms every live goal, cancels active work with the `parent` cause, and awaits the driver plus agent quiescence while its event fence remains installed.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: driver state machine, race fences, teardown |
| [`src/prompt.ts`](src/prompt.ts) | The retained `<goal_round>` continuation prompt |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: goal-round messages must match the package-owned prompt |

### The round prompt

The retained prompt is one text block: the JSON-quoted objective and `round/maxGoalRounds` on the first lines, then the working instructions. The invariant companion reconstructs the goal from the durable prefix and rejects any goal-sourced message whose content does not match the prompt exactly.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The driver consumes the goal state and defers policy to the goal tools; read these pages for the surrounding contract and the design rationale.

- [Goal service](../goal/README.md) — the goal state and lifecycle this driver continues.
- [Goal tools](../tool-goal/README.md) — the model-facing tools and their execution-time authority checks.

-----

<a id="model-experience"></a>
## Model Experience

### Goal-round prompt

#### What the model sees

Each admitted round is one retained user-role `<goal_round>` block naming the full objective and positive round number. Earlier human messages, goal-state snapshots, assistant output, and tool records remain in the same session history.

#### Token effect

One fixed instruction block plus the objective is added per admitted round. Later requests resend retained rounds until compaction shadows them; no fresh agent or copied conversation prefix is created.

#### KV Cache effect

Append-only within an epoch: each admitted round extends the existing conversation after its reusable prefix. Compaction may replace the derived-history suffix and move the reusable boundary.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the driver is a poor fit or needs special care. They are current package constraints, not a task backlog.

- **No independent evaluator** — the model-facing goal policy decides when evidence is sufficient for completion and whether a blocker is semantically unchanged; evaluator-backed certification remains deferred.
- **Same-session execution only** — this package deliberately does not spawn a fresh agent, fork a session prefix, or implement Ralph-style independent attempts; that workflow belongs to its own plugin layer.
- **Accepted-queue unload race** — Cordis plugin unload is asynchronous. A goal prompt already accepted by the agent inbox can begin and consume its round before unload starts; teardown then cancels the request, disarms the goal, and awaits quiescence. No later round starts.
- **Round cap, not resource budget** — token, currency, time, and provider quota policies remain independent. Their session events are not attributed to the goal message or mapped into goal blocker codes.
- **No abnormal auto-retry** — transient provider and persistence failures require a later human-authorized resume rather than an implicit retry policy.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Open, undecided directions: an abnormal-failure retry policy and evaluator-backed round certification; both stay outside this package by design.

</details>
