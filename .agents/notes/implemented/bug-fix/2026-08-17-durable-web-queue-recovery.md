# Agent Note: Recover the Web queue from durable Inbox state

Status: implemented

English | [中文](2026-08-17-durable-web-queue-recovery.zh.md)

## Problem

Inbox acceptance records normalized `agent/inbox/spliced` events, but the Web queue used a separate mux baseline built by enumerating live Agents. After a Host process restart, a persisted ordinary Session remained cold until an operation needed its Agent, so the live-only baseline omitted accepted pending messages that were still present in the durable log.

A reconnect-only repair would retain two recovery implementations: one for a live Inbox and one for cold Web reads. The correct owner is the Inbox domain, and the session-projection framework already provides live drive, cold folding, reconnect baselines, and cache restoration.

## Decision

When composed with the Session projection registry, `AgentLoop` registers the standard `inbox` projection at service activation so cold Sessions can be read without a live Agent. The [claimed Inbox lifecycle](../architecture/2026-07-31-claimed-pre-step-inbox-lifecycle.md) owns splice normalization, message uniqueness, live notifications, and durable reconstruction. The projection shares one schema and `InboxState` definition; message values rely on the existing typed `UserMessage` contract rather than a second runtime message validator.

The registry folds committed splices before `Session.append()` returns; each Agent's `ReactLoopInbox` command facade reads that same live state rather than keeping another fold.

The generic session-projection carrier is the only Web transport. It sends higher-seq `session/projection` values, includes the complete values block in each `session.follow` opening snapshot, folds detached cold logs, and uses the projection cache when valid. There is no Host-owned `queue` projection, placement vocabulary, handoff list, dedicated queue frame, or live-Agent reconnect enumeration.

A synchronous subscription to ready Host generations discards every retained projection value and watermark before refreshing queries and restarting the control stream, including cold Sessions absent from the process-local control baseline. The first control stream waits for generation readiness; a baseline cannot arrive before invalidation and then be erased by a later Cordis `connection/reset` notification. Observable faces retain their identities and subscriptions. A list request from an earlier generation cannot publish values or settle the current request; history and list values from the new generation may therefore establish a lower durable seq without losing to unpersisted state. Within a generation, all incoming baselines obey higher-seq-wins, so a delayed control baseline cannot remove or overwrite newer list or history values.

The client Session binding retains `inbox` in its generic per-session projection store and does not copy it into `SessionSnapshot`. QueueDock reads `next-turn` directly. ChatView reads user-origin `next-step` messages directly and ignores injected context. Claiming removes a pending value through the durable splice; a later `user/message` is rendered through the ordinary conversation projection.

`session.updateQueue` resolves an ordinary cold Session through the shared Agent resolver before mutating its Inbox. A restored pending row therefore remains editable, removable, or steerable after restart, while subagent ownership keeps the same fence as other Agent operations.

No new session event or on-disk format is introduced. The existing splice stream remains the durable source of truth.

## Verification

Host projection coverage reads a detached persisted Session with pending input, returns `values.inbox` in the opening `session.follow` snapshot, and proves that no live Agent is required. Cold-operation coverage proves `session.updateQueue` resumes the Session and appends the durable removal splice.

Client coverage pins generic Inbox projection delivery, reconnect invalidation for omitted cold Sessions, both baseline arrival orders, obsolete list request outcomes, higher-seq retention before Session materialization, and the absence of queue state from `SessionSnapshot`. UI coverage pins direct `next-turn` QueueDock rendering and user-origin `next-step` ChatView rendering. The keyless Web fixture opens a cold persisted Session and observes its pending row after restart.

## Alternatives considered

**Add cold Sessions to the old queue reconnect loop.** Rejected because it would duplicate the projection registry's cold fold and preserve separate implementations for live pushes, history, cache, and reconnect.

**Register a Web-specific `queue` projection in Session Controller.** Rejected because pending input belongs to Inbox. Placement rows and a handoff list would introduce a second domain model solely for one client.

**Store a complete Inbox snapshot on every splice event.** Rejected because the durable event is a normalized mutation, not a repeated aggregate. The projection framework owns aggregate reconstruction and checkpointing.

**Reconstruct Inbox in the client from raw session events.** Rejected because pagination may omit the insertion that established current state and every client would duplicate splice semantics.

**Resume every cold Agent while opening the mux stream.** Rejected because displaying durable state must not publish runtime resources, mount presets, or start lifecycle work.

## Consequences

Pending Queue and steering input recover after Host process restart without resuming an Agent. Live Inbox reads, cold history, reconnect, and projection caching use the same domain-owned fold and registry state. Operations on a restored row do resume its ordinary Agent, preserving preset composition and ownership checks.

Clients receive the raw two-list Inbox value and decide which messages their surface presents. The projection state version invalidates cached rows whenever its serialized state or fold semantics change.
