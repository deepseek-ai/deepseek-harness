---
description: "Delivery of messages from outside an Agent into its inbox, for maintainers of entry points such as the Web Session Remote and authors of admission listeners."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-controller

English | [中文](README.zh.md)

## Summary

Deliver a message that a sender brings on someone's behalf into an Agent's inbox after the `agent-controller/admission` stage decided it. Listeners can hold a message until the Agent is ready or refuse it with a reason the sender reports; messages that the Agent's own machinery produces do not pass the stage.

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

The base bundle mounts the service as `ctx.agentController`; it has no configuration. A sender that delivers work on someone's behalf resolves the receiving Agent itself and calls `deliver(agent, request)` instead of `followup()` or `steer()`.

### Deliver a message

`deliver()` runs `request.prepare(signal)` to turn the sender's content into durable message content, builds the message with `request.source`, asks the admission stage for a decision, calls `request.beforeInsert?.(message)`, and appends the message with `followup()` for `mode: 'followup'` or `steer()` for `mode: 'steer'`. It resolves with the message id once the message is in the inbox.

```text
const messageId = await ctx.agentController.deliver(agent, {
  mode: 'followup',
  source: { kind: 'user', rpcId },
  signal,
  prepare: () => ctx.attachments.admitPromptContent(parts),
  beforeInsert: (message) => { record(message.id) },
})
```

`prepare` runs after the earlier messages to the same Agent settled, so content admission happens in arrival order; its error reaches the sender unchanged. `beforeInsert` runs synchronously after admission, immediately before the message enters the inbox, for bookkeeping the sender needs before the Agent wakes. A throw from it keeps the message out of the inbox, and the sender reverts its own effects when `deliver()` rejects.

`deliver()` rejects with `AgentAdmissionRejected` when a listener refuses the message (with the listener's `reason` and `presented`), when a listener throws (`agent-controller/admission-failed`, with the error as `cause`), or when the Agent left the registry before its message entered the inbox (`agent-controller/agent-gone`). Each of these errors is a `HarnessError` whose `code` is `AGENT_ADMISSION_REJECTED` (`ADMISSION_REJECTED_CODE`); senders recognize a refusal by that code and its `reason`, not by the class, so the check also holds for an error from another copy of this package. A cancelled sender gets its cancellation reason at once, also while its message waits behind a held one, and errors from `prepare`, `beforeInsert`, `followup()`, and `steer()` pass through unchanged. The Web Session Remote maps these failures onto `session/prompt-rejected` and its other Session errors.

### Hold or refuse a message

Listeners of the `agent-controller/admission` waterfall run in registration order and return an `AdmissionDecision`. A listener admits by returning the decision of `next()`, whose last step is `{ kind: 'admit' }`; it holds the message by awaiting before `next()`, and refuses it by returning `{ kind: 'reject', reason, message, presented }` without calling `next()`. `reason` names the refusal, and `presented` says whether the refusing plugin explains it in its own interface. A listener throws only when its check itself fails, and it must not wait for a person when the message source is unattended, such as a schedule or a webhook. The `signal` in its payload aborts when the sender cancels or the controller stops; a holding listener must settle once it aborts.

```text
ctx.on('agent-controller/admission', async ({ agent, message, signal }, next) => {
  if (!ready(agent)) return { kind: 'reject', reason: 'my-plugin/not-ready', message: 'Prepare the workspace first.', presented: false }
  return await next()
})
```

The event is scope-filtered: a listener registered in an Agent's scoped context, such as one a preset mounts, receives only that Agent's messages. Exact signatures live in the generated region of the [core subsystem page](../../../docs/subsystems/core.md#cordis-surface).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the service realizes the behavior above; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The controller chains each Agent's deliveries on one promise, so a held message keeps later messages to the same Agent waiting while other Agents proceed. The chain covers preparation, the decision, and the append, so messages enter the inbox in arrival order. Before preparing, and again after the stage returns, the controller checks cancellation and that the registry still holds the Agent; it then calls `beforeInsert` and `followup()` or `steer()` with no await in between. Listeners therefore never run after the message entered the inbox; a plugin that reacts to admitted messages listens to `agent/inbox/inserted`. A message whose sender cancels while it waits keeps its place in the chain and is dropped when its turn comes, so the order of the others does not change. Disposing the controller aborts the signal that every pending delivery observes, so the messages that have not entered an inbox are rejected; disposal finishes only after every pending delivery, including its preparation and listeners, has settled.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `AgentController`, the refusal code and fixed refusal reasons, and `AgentAdmissionRejected` |
| [`src/types.ts`](src/types.ts) | `DeliveryRequest`, `AdmissionDecision`, and the `agent-controller/admission` event |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The package-level contract is enough for most senders and listeners; read these when you need the surrounding domain.

- [agent package](../agent/README.md) — the `Agent` handle, its inbox methods, and the `agent/*` events.
- [Session Controller](../../api/session-controller/README.md) — the Web `session/prompt` Remote that delivers through this package.
- [Agent Note: delivering outside messages through the Agent controller](../../../.agents/notes/implemented/architecture/2026-10-17-agent-controller-message-delivery.md) — why the admission stage lives here instead of in the Agent core.
- [Core group map](../README.md) — how the core packages compose.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the messages the controller appends to an Agent's inbox; the Agent loop owns how they enter a model request.

#### KV Cache effect

Admission adds no model-visible content and changes no request prefix; a refused message never reaches a request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Only the Web Session Remote delivers through the controller** — the SDK server, ACP, headless runs, schedules, webhooks, and subagent prompts still call `followup()` or `steer()` directly, so their messages pass no admission listener.
- **Request deduplication stays with the sender** — the Web Session Remote acknowledges a retried `requestId` before calling `deliver()` by reading the Session history synchronously. Moving that check into the controller requires a projection of accepted request ids, because new synchronous history reads are prohibited.
- **A refused prompt can leave a stored attachment** — preparation stores attachments before the decision, so a refused or cancelled prompt can leave an unreferenced stored image or file.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
