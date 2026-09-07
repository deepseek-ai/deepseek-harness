# Agent Note: Steer a queued Web message into the active turn

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-30-web-queue-steer-action.zh.md)

## Problem

The Web composer originally queued every Enter submission while an agent ran. QueueDock already gives each pending message an addressable row, and the durable transcript already renders consumed steer events as user-style bubbles, but Web had neither an action connecting those two surfaces nor a direct composer gesture for choosing current-turn steering.

Implementing the row action as a client-side delete followed by `session.prompt(mode: 'steer')` would split one user intent across two RPCs. Driver claim could win between them, the steer could fail after deletion, or the existing best-effort `agent.steer()` fallback could silently append a new Queue item after the original occurrence was removed. A send-now action must therefore distinguish current-turn steering from Queue promotion and preserve the original row when steering is no longer possible.

## Decision

### Product contract

Each non-editing ordinary-session QueueDock row exposes the upward-arrow action as “插话发送”. The action is enabled only while the session reports a running agent; mixed-content messages remain eligible because steering forwards the complete immutable `UserMessage` rather than the row's text projection. An addressed subagent keeps its Queue projection read-only because its continuation transport does not expose queue mutation.

Activating the action requests strict current-turn steering for that exact `InboxItemId`. Success removes the Queue row through the authoritative Host snapshot and immediately projects the same pending steering after the `Deep diving...` running-status row; that bubble offers Copy but no Fork because the message has no durable event sequence yet. Once AgentLoop drains it, the existing durable `user/message` event takes over the same user-style bubble and restores its clock, Copy, and Fork without a separate durable presentation path.

The running bit is only an interaction hint. AgentLoop's `acceptsNextStep` value is authoritative at the synchronous mutation boundary. If that window has closed, the operation leaves the Queue occurrence unchanged and returns a typed `steer-unavailable` error, after which the original waking occurrence proceeds through Queue. If the driver already claimed the occurrence, it returns the existing `queue-item-not-found` error and independent-turn delivery is already underway. The UI treats both races as converged Queue delivery without a failure notice; transport and unknown errors still surface.

The composer uses a separate best-effort contract for newly typed input. While the addressed session is idle, Enter and Cmd/Ctrl+Enter both perform an ordinary Queue send. While a primary session is running, a General Settings preference assigns plain Enter to Queue (the default) or Steer, and Cmd/Ctrl+Enter performs the other behavior; Shift+Enter inserts a newline. An addressed subagent keeps both gestures on its Queue-only continuation transport. The Host settings document persists the preference across Web origins sharing one DSH home, and it affects only the steer-capable busy-state gesture pair. If a direct composer Steer misses the current next-step window, AgentLoop automatically admits it as the next waking Queue turn and the Web does not report a failure.

### Agent and lifecycle boundary

`InboxAction` gains a consumer-backed `{ kind: 'steer' }` operation alongside edit and remove. `Agent.updateInbox()` handles it only after locating the queued occurrence and proving `acceptsNextStep`; it never delegates to the best-effort `agent.steer()` alias.

An applied action ends the queued occurrence and accepts the same immutable `UserMessage` as a new steering occurrence. The steering occurrence receives a new `InboxItemId` and truthful `placement: 'steering'`, while the message retains its `MessageId`, content, source, and any pending `SteeringReceipt` delivery controller. AgentLoop installs the new outbox entry before publishing lifecycle events, then emits its enqueue before the old occurrence's discard so re-entrant cancellation cannot observe or retire an unannounced item. The existing inbox conservation invariant therefore continues to require one enqueue and one terminal dequeue or discard for each occurrence.

The action does not run `agent/prompt-submit`: choosing steering intentionally changes delivery from an independently admitted turn to current-turn next-step input. It neither cancels current work nor reorders the remaining Queue.

### Host and client boundary

`session.updateQueue` carries the `steer` action and maps the two negative outcomes to typed RPC errors. The conversion is one synchronous Agent operation; the Host never reconstructs it by combining remove and prompt calls.

The Host's existing `queuedMirror` remains the sole transient inbox authority. Its `session/queue` snapshot carries every live occurrence with `placement: 'queued' | 'steering'`: QueueDock renders only queued rows, while ChatView renders pending steering at the conversation tail after the `Deep diving...` running-status row, with Copy but without Fork, edit, or delete actions. Reconnect replays the same snapshot, so this visibility does not require client optimism or a second registry.

When AgentLoop claims pending steering, it emits `agent/inbox/dequeue` immediately before synchronously appending the durable `user/message`. The Host retires that steering row on the following microtask, allowing the durable session event to enter the linear mux stream first. On the accepted live event, the client Session retires the first matching current steering occurrence before publishing its snapshot; history replay does not consume a later occurrence that reused the same `MessageId`. ChatView therefore renders one authority at a time without scanning durable history, and the durable projection restores the clock, Copy, and Fork against its logged event time and sequence. An append failure still retires the claimed row.

The existing `session.prompt(mode: 'steer')` contract remains best-effort for new primary-session input: outside the next-step window it becomes a waking follow-up. The composer carries an explicit `queue | steer` mode through slash adjudication and reference serialization before calling that contract. A browser submission policy owns the live busy-Enter preference while the Host settings service owns durability; the policy resolves plain versus accelerated Enter as complementary gestures only for steer-capable sessions, and the Settings row and InputBar share it without duplicating storage or delivery-window authority. Only the Queue row action is strict, because either negative result converges through the original Queue occurrence.

### Verification

AgentLoop contract coverage holds prompt admission open, converts one exact queued occurrence, and proves the replacement steering occurrence keeps the message value and delivery receipt, drains as a `user/message`, and never starts its former independent turn. It also pins unavailable-window retention, claimed-address rejection, and re-entrant cancellation lifecycle conservation.

Host schema and proxy tests cover the new action, both typed errors, placement-aware snapshots and reconnect replay, plus durable-before-retirement ordering. Client tests cover silent convergence of both semantic races, genuine error reporting, read-only subagent rows and Queue-only subagent gestures. Runtime and ChatView tests cover occurrence-aware pending-to-durable handoff, including repeated `MessageId` values, while Web ARIA snapshots cover pending steering after the running-status row with Copy alone and the durable node with clock, Copy, and Fork.

The keyless Web steering scenario queues a message through the real composer while the first response streams, activates the row arrow, then uses `ask_user_question` as a stable pending-steering barrier. It proves the Host-backed pending bubble appears before admission, hands off to one durable interjection after the answer, and affects the next model request. Assembled composer scenarios prove default-mode Cmd+Enter reaches the same pending and durable path without creating a Queue row, while Steer-mode Cmd+Enter creates a Queue row instead. Settings and submission-policy coverage pin the default, persistence, busy-only scope, and complementary gesture mapping; Queue edit/delete scenarios continue to prove those actions are unchanged.

## Alternatives considered

**Delete the row, then call `session.prompt(mode: 'steer')` from Web.** Rejected because two RPCs cannot make deletion and steering atomic; failure and driver-claim races can lose or duplicate the user's message.

**Restore Queue promotion under the upward arrow.** Rejected because moving an item to the front still creates an independent admitted turn. The control promises current-turn steering, not priority within Queue.

**Use the existing best-effort `agent.steer()` behavior for the Queue row.** Rejected for that action because a closed next-step window would create a new queued occurrence, possibly at a different position and identity. Strict refusal preserves the original occurrence so the UI can treat it as the same accepted Queue delivery. Newly typed composer input has no existing Queue occurrence to preserve, so it intentionally uses the best-effort behavior.

**Change `agent.steer()` to be strict for every caller.** Rejected because TUI and plugin callers use its safe follow-up fallback for newly submitted input. A queued row has recoverable state that those callers do not.

**Preserve the same `InboxItemId` while changing placement.** Rejected because `InboxItemId` identifies one FIFO acceptance and `placement` records that acceptance's resolved delivery. Ending one queued occurrence and accepting one steering occurrence keeps lifecycle facts truthful and leaves the conservation invariant unchanged.

**Add a dedicated pending-steering projection and client store.** Rejected because queued and steering occurrences already share one Agent inbox lifecycle and one Host mirror. A second projection would duplicate reconnect state and ordering authority; a placement tag lets each client surface select its rows without widening Queue mutation semantics.

**Cancel the active turn and run the selected Queue item.** Rejected because it destroys unrelated in-flight work and starts a new turn rather than steering the current one.

## Consequences

`session/queue` describes a placement-aware transient inbox snapshot rather than a Queue-only list, so every consumer must filter by placement. Pending steering survives reconnect and appears immediately, but remains non-durable until the durable `user/message` commits. The running bit can also remain true briefly after the strict next-step window closes, so an enabled action may internally return `steer-unavailable` while the product continues through Queue without reporting failure.

The explicit action changes delivery from an independently admitted turn to current-turn steering, so prompt-admission plugins do not process the converted message. Enqueue-before-discard lifecycle publication remains required for re-entrant cancellation safety; focused regression coverage protects that ordering.
