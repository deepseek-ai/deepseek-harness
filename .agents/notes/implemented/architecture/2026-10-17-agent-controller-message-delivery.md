# Agent Note: Delivering messages from outside an Agent through the Agent controller

Status: implemented

English | [中文](2026-10-17-agent-controller-message-delivery.zh.md)

## Problem

Plugins need to decide, with Host context, whether a message someone sends may enter a Session now. The experimental forge panel must create a requested worktree before the first message reaches the Agent, and must stop a message after the Session's worktree was removed. The Host had no point for that decision. `session/prompt` appended a prompt to the Agent inbox synchronously, and the only seam every sender passes, `agent/pre-step`, runs after the inbox accepted the message and the client already showed it as sent. A pre-step rejection ends the turn without returning the message to its sender, and a queued message reaches pre-step only when its turn starts. A gate in the Web composer, tried first, had no Host context and was bypassed by every other client.

## Decision

The core package `dsh-agent-controller` owns how a message from outside an Agent enters its inbox. The base bundle mounts it as `ctx.agentController`, so every base-backed profile can deliver through it; `dsh-agent` and `agent-loop` keep their inbox methods unchanged.

| Part | Contract |
|---|---|
| Entry | `ctx.agentController.deliver(agent, { mode, source, signal, prepare, beforeInsert })` prepares the content, builds the message, asks the `agent-controller/admission` waterfall for an `AdmissionDecision`, checks the sender's cancellation and that the Agent is still registered, calls `beforeInsert`, then `followup()` or `steer()`, and resolves with the message id once the message is in the inbox |
| Sender work | `prepare` turns the sender's content into durable message content inside the Agent's delivery order; the optional `beforeInsert` runs synchronously immediately before the append, for bookkeeping that must precede the Agent's wake |
| Listeners | Run in registration order with Agent scope filtering and receive the Agent, the message, and a signal that aborts when the sender cancels or the controller stops; return the decision of `next()` to admit, await before `next()` to hold, and return `{ kind: 'reject', reason, message, presented }` to refuse without asking later listeners; throw only when the check itself fails |
| Delivery mode | Stays with the sender; listeners do not see it, because no admission policy depends on it |
| Order | Messages to one Agent are prepared, decided, and appended one at a time in arrival order; a sender that cancels before the append is not admitted and stops waiting at once, even behind a held message; disposing the controller stops every message that has not entered an inbox and finishes once those deliveries settled |
| Failures | A rejection raises `AgentAdmissionRejected`, a `HarnessError` with code `AGENT_ADMISSION_REJECTED`, with its reason and `presented`; senders recognize it by that code rather than its class and import only types from this package; a thrown listener error raises it with `agent-controller/admission-failed`, and an Agent that left the registry with `agent-controller/agent-gone`; errors from `prepare`, `beforeInsert`, `followup()`, and `steer()` pass through; no listener runs after the message entered the inbox |

Only senders that deliver work on someone's behalf call `deliver()`. Messages the Agent's own machinery produces, such as job results, goal rounds, plan transitions, and question answers, keep `followup()`, `steer()`, and `inject()`: they belong to work that was already admitted. A listener must not wait for a person when the message source is unattended, such as a schedule or a webhook; it passes or refuses such a message.

`presented` tells an interactive client that the refusing plugin explains the refusal in its own interface, so the client adds no generic notice.

The Web Session Remote adopts the controller first. `session/prompt` resolves or resumes the Agent, acknowledges a repeated `requestId` itself, and delivers with a `prepare` that checks image input against the Session model, resolves upload receipts, and stores attachments, and a `beforeInsert` that binds the receipts to the request. It maps a refusal to `session/prompt-rejected` with `reason` and `presented`. The call stays open while a listener holds the message, and the client's cancellation stops it. The SDK server, ACP, headless runs, schedules, webhooks, and subagent prompts move to `deliver()` in later changes, each mapping a refusal to its own protocol. Until they do, a plugin that must cover them keeps an `agent/pre-step` check.

Request deduplication stays in the Session Remote. It reads the Session history synchronously, and the [synchronous-read decision](2026-09-09-deprecate-synchronous-session-event-reads.md) prohibits copying such a read into new production code; the controller can take over deduplication once a projection records accepted request ids.

The Web client keeps its existing echo: Enter clears the composer and shows the message at once, and a refusal reaches the client as an ordinary prompt failure, which retires the echo and restores the draft unless new text was typed meanwhile.

## Alternatives considered

- **An admission stage in `dsh-agent`.** `ctx.agents.admit()` with an `agent/admission` event reaches every sender as well, but it adds a delivery concern and a new extension point to the Agent core, whose contract the loop implements. A package composed in the base bundle reaches the same senders without changing that contract.
- **A Session Remote event, or a layer inside the Session Controller.** It fits the Web path, but the Session Controller is composed only in the Web profile, so ACP, SDK, and headless senders could never reach it.
- **`agent/pre-step`.** It covers every sender, but it runs after the inbox accepted the message and the client showed it as sent, a refusal drops the message instead of returning it, and a queued message is checked only when its turn starts.
- **Gated, asynchronous `followup()` and `steer()`.** Every internal sender would pass listeners meant for outside input, and their callers rely on synchronous enqueueing.
- **A composer gate in the Web client.** It has no Host context, and other clients and `ctx.conversation.send` bypass it.
- **Appending in the innermost step, with refusals thrown.** Listeners could act once `next()` returned with the message already in the inbox, but that capability, which no listener uses, cost three special cases: a listener failure after the append could only be logged, the inbox's own refusal had to be told apart from a listener failure, and a refusal thrown from another module copy of the error class needed a structural check. A returned decision keeps the stage a pure decision, as `agent/pre-step` is; a plugin that reacts to admitted messages listens to `agent/inbox/inserted`.

The liveshare proposal in PR #3854 also introduced an admission hook, for caller identity. [Peer principals](2026-10-12-peer-principal-and-remote-access.md) replaced it; this stage decides whether the Agent can take a message now, independent of who sent it.

## Consequences

- A listener that holds one message keeps later messages to the same Agent waiting; other Agents proceed.
- While a listener holds a Web prompt, the client already shows its echo; a refusal then retires the echo and returns the draft.
- `prepare` stores attachments before the decision, so a refused prompt can leave a stored attachment unreferenced.
- Image prompts deliver inside the Session Remote's image admission chain, so a model switch waits while a listener holds an image prompt.
- Until every outside sender adopts `deliver()`, the stage is not a complete enforcement point.
