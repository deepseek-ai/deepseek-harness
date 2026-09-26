# Agent Note: Input echoes retain display ownership through admission

Status: implemented

English | [中文](2026-09-22-input-echo-admission-ownership.zh.md)

## Problem

An idle submission can appear first as a local Chat echo, then as an Inbox row in QueueDock, and finally as a durable user message. Inbox projection and conversation history arrive independently: retiring the echo on acceptance leaves a gap before admission, while a delayed Inbox projection can duplicate an already-admitted message. Separately, turn/start precedes user/message, so an empty progress title can appear before the echo and exchange positions with it when the real input arrives.

These transitions concern display ownership, not scrolling or composer geometry. A delay cannot identify which representation is authoritative, and moving every echo before the progress title would move running steering ahead of existing work.

## Decision

- A submission keeps its locally selected placement: idle input stays in Chat, running steering stays at the process tail, and explicitly queued input stays in QueueDock. Inbox acceptance does not change that placement.
- Chat hides an echo by matching the durable input's rpcId in the same render, and excludes stale next-step Inbox rows matched by admitted local Chat submissions. QueueDock excludes only Inbox rows matched by local transcript echoes; unrelated queued messages remain visible and actionable.
- Session retains an admitted transcript or steering submission's local suppression identity until the Inbox projection watermark reaches its claim sequence. Higher-sequence projection retention then prevents an older accepted row from reappearing after that identity retires. Claim tracking and cancellation use the existing per-submission receipt for both Inbox targets; no new SessionSnapshot field, Host event, or persisted format is needed.
- At an open, input-free progress control at the end of Chat, the first transcript echo precedes the control. Other echoes remain at the tail. Last-input Turn tracking shares the existing rpcId scan; it does not add a history traversal or predict a sequence of future Turns.
- Pending bubbles and durable seats share one keyed React list. Inserting a progress title preserves the pending bubble's mounted identity. Once admitted, the durable node owns ordering and ordinary Group segmentation.

The [durable Inbox recovery decision](2026-08-17-durable-web-queue-recovery.md) still owns cold reads, reconstruction and projection transport. The [generic file upload decision](../feature/2026-08-26-generic-file-upload.md) still owns attachment preparation and draft recovery; retirement returns each submission's durable references once, in attachment order.

## Alternatives considered

**Delay QueueDock or echo removal by a fixed interval.** CPU throttling, transport batching and projection ordering can exceed any such interval. Time does not establish admission or confirm that stale queue state is gone.

**Retain the echo without changing the other readers.** Chat-side Inbox deduplication can still remove the echo, and QueueDock can still display it. The Session lifetime, Chat handoff and Dock exclusion must agree.

**Delete the suppression identity as soon as user/message arrives.** A later Inbox acceptance projection can resurrect a Dock or pending-steering row. The claim watermark supplies the required ordering evidence without assuming the streams publish together.

**Move all pending inputs before the newest Turn control.** Running steering belongs after existing process content, and several ordinary submissions can target different Turns. Only the first local transcript echo receives the empty-control placement adjustment.

**Add a Host correlation event or a client-side Turn scheduler.** Exact prediction across competing clients and reordered requests would widen the change beyond local optimistic presentation. Durable admission remains authoritative; optimistic ordering is deliberately approximate in those races.

## Verification

| Evidence | Covered behavior |
|---|---|
| [Session submissions](../../../../packages/api/session-controller/tests/session-pending-submissions.client.spec.ts) | Projection-first and history-first handoff, claim watermark, overlapping opening/queue/steering identities, attachment callbacks, cancellation, unadmitted endings, reconnect baselines and disposal. |
| [Projection store](../../../../packages/api/session-controller/tests/projection-store.client.spec.ts) | Missing/cached watermarks, monotonic sequence retention and clearing. |
| [Chat rendering](../../../../packages/client/ui-chat/tests/chat-view.client.spec.tsx) | Same-render rpcId replacement, stable echo mounting, title-before-input delivery in all three modes, steering remaining behind the title, historical empty Turns, and six local-versus-Host orderings. |
| [QueueDock](../../../../packages/client/ui-conversation/tests/queue-dock.client.spec.tsx) | Local transcript exclusion, unrelated rows/actions, and all six three-message acceptance orders followed by FIFO claims. |
| [Recorded Web replay](../../../../apps/web/tests/idle-submission-handoff.e2e.ts) | Real Web composition with FIFO-preserving delivery barriers: both Inbox/history arrival orders at 6× CPU throttling, an explicit turn/start-to-user/message gap, and complete three-Turn handoff for all six request orders. |
| [Steering Web replay](../../../../apps/web/tests/steering.e2e.ts) | Local shortcut steering remains unique when durable admission precedes its Inbox claim projection. |

The single-input regression fails before the fix: Inbox acceptance moves the bubble into Dock, and a separately delivered Turn title precedes the echo. The corrected path retains one Chat representation at a stable vertical position. Multi-input replay verifies durable order and absence of duplicate or residual echoes; it does not assert that optimistic ordering predicts Host order.

## Consequences

- Steering without a locally tracked submission still follows the Inbox projection; a delayed projection can briefly duplicate its durable row. Local deduplication adds no history scan for other clients' submissions.
- Reconnect may discard receipt-confirmed optimistic echoes and display the new authoritative baseline. A claimed input outside that baseline can briefly have no bubble; reconnect does not promise DOM continuity.
- Submissions made before the local running update can all remain transcript echoes. If A, B and C are submitted locally in that order but B or C enters first, durable admission changes their visible order. Even when A enters first, remaining local echoes can differ from the Host queue order.
- Cross-client competition and request-preparation races can change the actual opening input. The client does not migrate an idle-classified echo into Dock merely because the Host queued it behind another Turn.
- The changes prevent representation handoff flicker on the ordinary online path without changing model input, Inbox scheduling, scroll-follow policy, or released Session data. The browser barriers establish behavior, not a general latency or throughput improvement.
