# Agent Note: Web stop preserves pending Queue

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-31-web-stop-preserves-queue.zh.md)

## Problem

The Web stop button reached `session.cancel`, which mapped to broad `agent.cancel({ kind: 'user' })`. During an active turn, ordinary composer submissions are already accepted as independently addressable Queue occurrences. Broad cancellation discarded every occurrence when the user intended to stop only the current generation, conflating turn interruption with the Queue's explicit delete operation.

The browser cannot repair that loss by resending visible rows. It does not own their live `InboxItemId`, wake policy, or claim race, and a resend can duplicate work that the Host has already claimed.

## Decision

`session.cancel` is the Web Host API's active-turn stop for ordinary sessions. It rejects session-backed subagents with `agent-busy`; otherwise it calls `agent.cancel({ kind: 'user' }, { keepInbox: true })`, preserving pending inbox work while cooperatively aborting the current turn. The underlying option preserves queued and steering entries; the Web Queue projection continues to expose only queued entries.

The AgentLoop starts no concurrent replacement turn. It closes and flushes the interrupted turn, reaches cancellation quiescence, and then claims the next waking queued occurrence through its existing FIFO driver. That claim emits `agent/inbox/dequeue`, so the Host's authoritative `session/queue` snapshot retires the claimed row and leaves the remaining tail visible. The browser neither resends nor promotes any row. Work that ignores cancellation delays this handoff until it settles.

This mapping changes only the Host `session.cancel` endpoint used by Web clients. The default `Agent.cancel()` contract remains broad, ACP and TUI retain their existing cancellation policies, and `AgentHandle.dispose()` still clears pending work during teardown. Queue row removal remains the explicit Web action for discarding one pending occurrence.

## Alternatives considered

**Keep broad cancellation for the stop button.** Rejected because stopping one generation should not destroy independently queued user intent; the Queue already owns explicit deletion.

**Resend the next row from the browser after cancellation.** Rejected because the Host owns occurrence identity and claim order. Client resubmission can duplicate work, reorder the FIFO, or race an authoritative dequeue.

**Start the next turn before cancelled work reaches quiescence.** Rejected because two turns would concurrently mutate one session log and share Agent-owned resources. Cooperative cancellation waits truthfully for the active work to settle.

**Add a wire option for broad versus preserving cancellation.** Rejected until the Web product has a separate “stop and clear Queue” interaction. The existing stop button has one policy, while per-row delete already supplies the current discard control.

## Verification

AgentLoop coverage holds an active model stream, queues two waking turns, cancels with `keepInbox`, and pins the aborted-then-completed turn reasons, FIFO user-message order, absence of discard events, and eventual idle state. The keyless Web scenario drives the built composition over HTTP/SSE: it stops one hung turn, observes the next queued occurrence start while the tail remains visible, stops that turn, and observes the final queued occurrence complete. Its accessibility snapshot pins the intermediate preserved-Queue state.

## Consequences

Web stop preserves accepted queued intent and advances it automatically after truthful cancellation settlement. Queue rows may remain visible while uncooperative active work winds down, and external steering preserved by the same inbox option can enter the next admitted turn even though Web does not render steering in QueueDock. A future bulk-clear interaction requires an explicit product action rather than overloading stop.
