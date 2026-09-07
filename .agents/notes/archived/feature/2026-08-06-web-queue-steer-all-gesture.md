# Agent Note: Steer the whole Web queue with an empty-draft Cmd/Ctrl+Enter

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-06-web-queue-steer-all-gesture.zh.md)

## Problem

While a primary session runs, the Web queue accumulates messages the user typed with plain Enter (or queued while the busy-Enter preference was Queue). Flushing them into the current turn required clicking the per-row 插话发送 button once per message; an empty composer draft had no keyboard gesture at all — the input machine rejects empty drafts, so Enter and Cmd/Ctrl+Enter were both no-ops. With several queued messages, steering them one by one is the obvious multi-click friction, and the empty-draft accelerated chord is the natural slot for "steer everything".

## Decision

Empty-draft Cmd/Ctrl+Enter now steers every still-pending `queued`-placement inbox row into the running turn, in FIFO order, on a primary session that reports running. The gesture decodes in `InputBar.onKeyDown`: accelerated Enter with a trimmed-empty draft, `running`, no subagent address, and at least one `queued` row calls the new `ComposerKeyboard.steerQueue()` verb instead of `submit()`. `SessionInputShell.steerQueue()` delegates to a hub-wired choreography that re-reads the authoritative `session/queue` snapshot, filters `placement: 'queued'` (pending steering rows are already in the turn), and applies the queue dock's exact strict-steer operation — `session.updateQueue(itemId, { kind: 'steer' })` — sequentially, so FIFO ordering is guaranteed at the host. A `steer-unavailable` (turn closed mid-flush) or `queue-item-not-found` (row claimed meanwhile) converges silently; any other failure surfaces one composer notice (`插话发送失败，请重试。`). No wire, on-disk, or agent-loop change: the host already owns the strict-steer boundary.

The gesture is strictly the accelerated chord. Plain Enter with an empty draft stays a no-op even under the busy-Enter Steer preference, draft content outranks the queue (accelerated Enter steers only the draft), and idle or subagent sessions keep the existing empty-draft no-op because steering has no live turn to enter.

The same computed availability gate drives discovery: while the draft is empty, the input is unlocked and not in a transient machine lock, the command menu is closed, an ordinary primary session is running, and at least one row remains `queued`, the textarea placeholder advertises that Cmd/Ctrl+Enter steers all queued messages. An owner-supplied placeholder still takes precedence, and the steer hint deliberately outranks the plan-mode placeholder while available (the gesture genuinely works in that window).

## Consequences

One keyboard gesture now replaces N clicks while keeping a single strict-steer path and a single authority for convergence. The per-row button and the gesture are the same host operation, so races and failure semantics stay identical. The gesture and its placeholder share one presentation-layer gate, while the hub re-checks the snapshot at execution time, so the client gate remains advisory and the host remains authoritative.

## Related

The per-row 插话发送 action and its strict-steer boundary are owned by [Steer a queued Web message into the active turn](../feature/2026-07-30-web-queue-steer-action.md); this note only adds the whole-queue keyboard gesture on top of that decision.

## Alternatives considered

- **Intercepting inside the input machine.** Rejected: the machine is queue-agnostic by design (the wiring layer overlays the queue projection) and cannot distinguish the accelerated chord from plain Enter, which must stay a no-op.
- **Steering via `session.prompt(mode: 'steer')` per row.** Rejected: that mints new messages instead of transferring the pending occurrences and would split the dock's immutable-message contract; `updateQueue({ kind: 'steer' })` already atomically transfers the exact occurrence.
- **Firing all row steers concurrently.** Rejected: arrival order at the host is not guaranteed, and steering order is model-visible; sequential awaits preserve FIFO.
- **A new host RPC for steer-all.** Rejected: the existing per-item operation is idempotent enough — each row is one strict steer, and mid-flush closure converges silently — so a protocol change buys nothing.
- **A send-button tooltip.** Rejected: the primary button is Stop in the empty-draft running window, which is also the only window where the whole-queue gesture is available. The placeholder occupies that exact window and can describe the keyboard action directly.
