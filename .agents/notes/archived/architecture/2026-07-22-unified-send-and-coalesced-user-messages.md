# Agent Note: Unify agent delivery on send(target × wakeup) and coalesce injected context into user/message

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-22-unified-send-and-coalesced-user-messages.zh.md)

## Problem

The agent's public driving surface had grown three near-parallel verbs — `send`, `steer`, `inject` — each with its own options type, its own live event story, and its own durable event. `send` and `steer` both queued a frozen inbox record and emitted `agent/queued`; `inject` bypassed the inbox and wrote a separate `context/message` durable event. The three verbs actually vary along only two independent axes: which queue an item joins (a whole new turn versus the active turn) and whether the item makes the model run. Encoding that 2×2 as three hand-written methods hid the symmetry, made "queue a turn without waking the driver" unreachable, and left `cancel()` with no way to abort a turn while preserving queued work.

Separately, `context/message` and `user/message` had converged: the surface projected both as verbatim user-role content, and the only real difference was that injected context carried a non-user `source` and was "not a prompt." Two event types for one projection meant every consumer branched on event type to answer "is this a human prompt?", and the goal system used the type split as a side channel (round-zero state changes were `context/message`, admitted rounds were `user/message`).

## Decision

**One primitive, three preset aliases.** The `Agent` interface's `send(message, target, wakeup)` covers the (`target` × `wakeup`) matrix. Its complete `UserMessage` owns identity, role, model-facing `content`, and producer `source`; the remaining arguments own only routing policy. `followup` (`next-turn`/wakeup), `steer` (`next-step`/wakeup), and `inject` (`next-step`/no-wakeup) each accept that one message and fix the policy. `wakeup` reserves a driver when the agent is idle; an already active driver receives no second reservation and can claim the input only if it reaches a later pre-step boundary. `next-turn`/no-wakeup (queue without waking) is representable with no alias and no current caller.

**inject is a non-waking next-step delivery.** It always appends the complete message to the next-step inbox and records that insertion in a durable `agent/inbox/spliced` event. The driver claims it at a later pre-step and records it as model-visible `user/message` only when the final decision returns it in the entering batch; idle injection remains pending until another delivery wakes the driver. Its required `UserMessage.source` preserves the source fields supplied by the caller.

**context/message is gone.** Injected context uses one `UserMessage` value in the inbox and becomes a `user/message` event if admitted; context producers supply the appropriate non-user `source` explicitly, and typed source variants carry any durable producer-specific fields. The surface, derivation, and `SurfaceEventType` drop `context/message`; consumers that need "is this a human prompt?" read `source.kind === 'user'` instead of the event type.

**Goal continuation attribution uses positive rounds.** Goal lifecycle state commits through the domain-owned `goal/change` event defined by the later [goal-owned durable event decision](2026-07-31-goal-owned-durable-events.md). A positive round advances only from an admitted continuation `user/message`; goal persistence does not use injection or inbox state.

**`send` does not return identity.** Callers already own the complete message and its opaque `MessageId`; creation and freezing are owned by the [identified immutable message decision](2026-07-28-identified-immutable-message-values.md), not by routing.

**Inbox mutations have one durable projection and three minimal live notifications.** Every append, prepend, edit, remove, cancellation, and claim records normalized `agent/inbox/spliced` coordinates. Insertions emit `agent/inbox/inserted { message }`; ordinary removals carry durable `outcome: 'canceled'` and emit `agent/inbox/discarded { message }`; the loop's atomic `claim()` records pure deletion splices and then emits `agent/inbox/claimed { message, turn }`. `MessageId` is the sole occurrence identity and remains unique across both pending lists. The live payloads deliberately omit placement, outcome, and batch envelopes because the durable splice owns those facts.

**Pre-step claims next-step input without making it a separate turn.** Steering and injection always enter the same next-step inbox; steering wakes the driver, while injection does not. At a turn boundary the driver atomically claims pending next-step input before one queued prompt, and between steps it claims only next-step input. Claiming records pure deletion splices and emits `agent/inbox/claimed { message, turn }` once per message. `agent/pre-step` then rejects the proposed step or returns its complete entering batch. Rejection and listener failure leave the claimed batch removed; input arriving after the claim waits for a later boundary.

**One accepted message keeps one representation.** Durable user-role input and additional model-facing context both use the identified, frozen `UserMessage` directly. The loop stores that value beside private routing state rather than copying its identity, content, or source into another public shape. Steering, injection, and tool-produced context each keep their identified messages in the next-step inbox. The [identified immutable message decision](2026-07-28-identified-immutable-message-values.md) supersedes this note's former `UserMessageData`/`AgentMessage` hierarchy and extends the representation to assistant and tool-result messages.

**Idle wakeup follows insertion.** A waking send inserts its input, then enters the running driver before returning. The first pre-step may claim that input immediately; later synchronous sends therefore join the running loop and wait for a later boundary. Cancellation belongs to the running turn signal from wakeup onward; no distinct pre-run phase intervenes.

**cancel gains keepInbox.** `cancel(cause, { keepInbox? })`; callers choose the cause explicitly, and `keepInbox: true` aborts the active turn while preserving queued and steering items (no discard event, and un-started work is not dropped).

## Alternatives considered

- **A dedicated `MessageSource` kind `context`** for injected content. Rejected because `plugin` already means "not a human," so a fourth kind would add a parallel axis the authority checks would have to learn. Plugin-produced injected context supplies its plugin source explicitly.
- **A typed discriminant field on `UserMessage`** (e.g. `origin: 'prompt' | 'context'`) to replace the event-type split. Rejected in favor of `source`, which every consumer already carries and which the goal system already keyed on; a second discriminant would duplicate that fact.
- **Keeping `agent/queued` alongside the inbox events.** Rejected as a mirror: `agent/inbox/inserted` is the live insertion signal, while claimed/discarded notifications describe exits and the durable splice retains placement.
- **Derive inbox placement from agent status.** Rejected because `running` includes pre-step processing and settlement. The producer already supplies the exact target to the durable splice.

## Consequences

The delivery surface is now one primitive plus three self-documenting presets, and the (`target` × `wakeup`) matrix makes previously-unreachable combinations explicit. One identified message value serves prompts, injected context, and goal rounds, so every "human prompt?" check simplifies to a `source` test. The `Agent` contract remains an interface, so alternate implementations and object-literal test fakes implement the same minimal structural surface. Positive goal rounds fold from admitted `user/message` events, while goal lifecycle state remains outside the delivery surface. An idle injection remains pending without opening a turn or running the model, then becomes `user/message` when a later waking delivery's pre-step returns it in the entering batch.

`wakeup` is the "should the model run" signal, so the inbox distinguishes waking queued work from anything available to claim: a lone `next-turn`/no-wakeup item stays parked at idle and rides along the next waking send, and `whenIdle`/`cancel` settle quiescence off the waking signal. Every insertion and exit publishes its matching live notification, while domain-specific durable facts travel in typed message sources rather than a parallel metadata channel. The direct pending-message representation keeps durable splices and live events correlated without maintaining a second steering wrapper or allowing its data to diverge. The later [claimed pre-step inbox lifecycle](2026-07-31-claimed-pre-step-inbox-lifecycle.md) decision keeps live queue mutations addressed by `MessageId` and separates single-message lifecycle notifications from the durable whole-queue splice projection.

## Related

- [one-send-one-turn](../simplification/2026-07-17-one-send-one-turn.md) — the one-claimed-message-per-turn rule this builds on.
- [remove-agent-steering-mirror](../../archived/simplification/2026-07-04-remove-agent-steering-mirror.md) — the precedent for collapsing a mirrored live event.
- [explicit-turn-cancellation](2026-07-16-explicit-turn-cancellation.md) — the cancel-cause signal `keepInbox` extends.
- [identified immutable message values](2026-07-28-identified-immutable-message-values.md) — the message identity and representation contract that now underlies this routing decision.
