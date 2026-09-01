---
description: "Semantic session durability checkpoints for users and maintainers deploying persisted agents that must not lose a model request or tool side effect on crash."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-checkpoint-policy

English | [中文](README.zh.md)

## Summary

`dsh-session-checkpoint-policy` is a zero-config plugin that makes a persisted session durable at the moments that matter: before a model request reaches the adapter, before a top-level tool body can produce an external side effect, and at each step boundary so the preceding response and tool results are stored before the next request. Load it beside one persistence backend, and a crash after any checkpoint resumes with the recorded work — a request, a tool call, or a completed step — instead of losing it. The policy adds no prompt, tool schema, or configuration; checkpoint failures are fail-closed, so neither the adapter nor a top-level tool body runs when the durable write cannot be confirmed. Streaming `assistant/chunk` events get no per-chunk checkpoint, and a persisted call without a result records an unknown outcome rather than retrying automatically.

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

Mount this plugin in any composition that persists sessions and must survive a crash without redoing or losing work. Persistence and checkpoint scheduling are separate plugins: a backend stores the event log, and this policy decides when the store must be flushed.

### When to choose it

Choose it for every persisted agent that can be interrupted — a crash between a recorded tool call and its result, or between a model request and its response, is exactly the failure this policy contains. Loading a backend without it is valid but weaker: events still inside the backend's batching window or an outstanding write can be lost. Skip the policy when nothing persists sessions, or when a specialized deployment deliberately replaces the checkpoint schedule.

### Minimal configuration

No configuration fields exist; the plugin is a single load beside one persistence backend:

```yaml
- id: session-persistence
  name: '@deepseek-ai/dsh-session-persistence-jsonl'

- id: session-checkpoints
  name: '@deepseek-ai/dsh-session-checkpoint-policy'
```

### What becomes durable

Three barriers are checkpointed. The model request is flushed before the adapter stream is constructed, so a crash before a response cannot replay an unpersisted request. A top-level tool call is flushed before the tool body runs, so a recorded call is durable before any external side effect; nested tool dispatches reuse the outer call's checkpoint. At each `agent/pre-step` boundary, everything the preceding step committed — its response and ordered tool results — is flushed before the next request is derived.

### Observable behavior and failures

After a checkpoint, the checkpointed work is durable: resume restores it from the store like any persisted session. If cancellation lands while a tool checkpoint flush is pending, the wrapper returns the canonical `ABORTED_BEFORE_DISPATCH` result and never enters the tool body. A checkpoint rejection is fail-closed at both boundaries — the adapter or top-level tool body does not run — and a step-boundary rejection fails the turn before another request starts.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the policy joins the loop and the persistence seam; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The plugin is a listener-only composition over three seams, with no state of its own: it wraps `llm/stream` so the downstream stream is not constructed until the live session's buffered request events are durable, wraps `tools/execute` after pre-execute policy and guards so a top-level tool body runs only after its recorded call is durable, and listens to `agent/pre-step` to persist the preceding response/result batch before request derivation. The session store's flush is the shared durability barrier; concurrent tool checkpoints serialize through it and cannot duplicate sequence numbers.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `apply` installs the three checkpoint listeners |
| — | No runtime invariant companion is published; checkpoint ordering is enforced at the intercepted waterfall and persistence seams; this stateless policy owns no independent mutable relation. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the durability model to the seam it joins and the shipped backends.

- [Session persistence subsystem](../../../docs/subsystems/persistence.md) — the flush checkpoint, batching window, and crash recovery every backend shares.
- [Session package map](../README.md) — adjacent persistence, projection, title, and telemetry packages.
- [Session persistence seam](../session-persistence/README.md) — the `ctx.sessionPersistence` service this policy flushes through.
- [JSONL persistence backend](../session-persistence-jsonl/README.md) — the shipped backend this policy is usually loaded beside.

-----

<a id="model-experience"></a>
## Model Experience

### Interrupted calls

#### What the model sees

The plugin adds no prompt or tool schema. A hard crash after a tool checkpoint but before its result leaves a durable unmatched call; session recovery supplies the model-visible `TOOL_OUTCOME_UNKNOWN` result owned by `dsh-session`. The message permits retry for read-only or idempotent work and requires state verification or user confirmation for calls that may have side effects.

#### Token effect

Successful checkpoints add no tokens and do not change the request. Recovery adds one short tool-result message to balance the interrupted transcript.

#### KV Cache effect

The repair result is appended after the reusable prefix, so it does not invalidate earlier cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the policy's durability guarantee stops. They are current package constraints, not a task backlog.

- **Durable execution intent, not exactly-once effects** — the policy records that a call was dispatched, not that its external effect completed. Side-effecting tools should forward `exec.callId` as an idempotency key when their provider supports one.
- **No per-chunk checkpoint for streaming** — `assistant/chunk` events rely on bounded background batches; a hard crash may lose the current in-memory batch or outstanding write.
- **Unknown outcome, not automatic retry** — a persisted call without a result cannot prove whether its external effect completed, so recovery records an unknown outcome instead of retrying.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
