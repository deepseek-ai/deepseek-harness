# Agent Note: SessionStore fork API

Status: implemented

English | [中文](2026-06-30-session-store-fork-api.zh.md)

## Problem

The event-sourced session log already has the primitive a fork needs: create a new session with a seed event prefix, then derive model history from that seeded log exactly as replay does. That primitive is intentionally low-level: `ctx.sessions.create(id, { seed, meta })` accepts any valid seed, but ordinary live-session branching needs policy around which prefix can be copied, which metadata is stamped on the child, and how errors are classified.

The semantic hazard is the fork boundary. A valid user-visible fork seed must be contiguous and end outside an active turn. Forking inside execution would copy an open `turn/start`, possibly an open `step/start`, and possibly dangling tool calls. That violates execution and provider-transcript invariants, and it creates a misleading child history that appears to have participated in an unfinished parent turn. Standalone context and plugin-owned log-only events are stable forkable history after a closed turn. The existing [subagent seam](2026-06-21-subagent-capability-seam.md) deliberately solves a different problem: tool-triggered subagent forks usually happen while the parent turn is open, so `dsh-subagent-fork-in-process` clips the seed to the parent's last completed-turn prefix. A general session fork should not silently clip; it should either fork the requested boundary or reject it.

## Decision

`dsh-session` owns ordinary live-session forking directly on `ctx.sessions`. There is no separate `dsh-session-fork` package or `ctx.sessionFork` service: the API has no independent backend, event vocabulary, lifecycle, or persistence behavior, and all durable work delegates to the existing session store and persistence backends.

The store exposes one operation:

```ts ignore-check
type SessionForkSource = Session | SessionId

class SessionStore extends Service {
  fork(source: SessionForkSource, boundary?: SessionSeq, childSessionId?: SessionId): Session
}
```

`boundary` is the branded inclusive source event `seq` to copy through. When omitted, it defaults to the source session's current last event; on an empty source, omitted `boundary` creates an empty child. Fork-specific validation checks that the requested boundary exists and that the selected prefix's latest turn boundary is not an unmatched `turn/start`. The selected prefix may therefore end at `turn/end` or at a later standalone event, then is deep-cloned into the child seed. The child inherits the source session's `cwd`, stamps `parentSession` to the source id, sets logical `isSeeded: true`, and supplies the copied prefix length separately as `inheritedEventCount`. When `childSessionId` is omitted, `SessionStore` generates one using its existing id policy.

An empty prefix is forkable; any non-empty boundary must be a safe existing sequence outside an open turn. Typed errors distinguish missing sources, stale objects, duplicate child ids, invalid boundaries, and prefixes ending during execution. Broader log validation and crash repair remain with their existing owners.

### Host and browser adaptation

The Host `session.fork` RPC accepts `atSeq` as an anchor within the desired turn rather than as the store's inclusive safe boundary. It selects the first `turn/end` at or after that anchor; an omitted or past-end anchor selects the last completed turn. An anchor already in the log but not followed by a matching `turn/end` returns `fork-unavailable` and never falls back to an earlier turn, so a message action cannot silently omit the clicked message.

The Host creates the child through the agent registry with the selected seed and lineage, and pre-publication setup installs the latest logged provider, model, and reasoning target before the child can run. It then attaches the child to the source Workspace. An attachment failure returns `workspace-attach-failed` with the already-published child id; the client reconciles that child into its summary list before surfacing the error. The Session-row action uses the last completed turn, while a message action supplies its event seq; both open the child after success, and lineage expansion makes it visible beneath the source.

## Alternatives considered

**Separate `ctx.sessionFork` service.** An earlier iteration shipped this as a separate service; it overfit the capability-seam pattern. The code had no swappable backend, no extra event surface, no independent ownership lifecycle, and no durable behavior beyond `ctx.sessions.create({ seed, meta })`. Keeping a separate package would make callers discover and install a second service just to perform policy around a session-store primitive.

**Two functions: `snapshot()` plus `fork()`.** This preserved a reusable seed/metadata computation, but the only supported consumer created a session immediately. It also made the API feel more abstract than the concrete operation users need. A single `fork()` with an explicit `boundary` keeps the API direct while still supporting previous-point forks.

**Silently clip open turns to the last completed boundary.** That is correct for `dsh-subagent-fork-in-process`, where delegation often starts while the parent turn is open and the child should inherit only the completed prefix. It is wrong for ordinary user/session branching because it hides that the requested fork point was not actually a valid boundary and silently drops the parent turn tail.

## Consequences

The public API stays small and discoverable: live session branching is part of `ctx.sessions`, next to `create({ seed })`, rather than a standalone service or a two-step helper pair. Persistence continues to work through existing `session/created` and `session/flush` behavior: a forked child starts life with seeded events, so the JSONL backend persists that seed once and preserves logical `parentSession` / `isSeeded` plus the separate exact cut (encoded as v0 physical `seedLength`).

This decision excludes ACP `session/fork`, unloaded persisted-session forking, model-facing tools, and subagent refactors. If a future ACP method is added, it should advertise the capability only after it has protocol and snapshot coverage; this Agent Note adds no ACP wire behavior, so no ACP snapshot is required. Fork-child replay remains covered by the existing [seed-boundary testing Agent Note](../testing/2026-06-22-fork-child-replay-seed-boundary.md); focused store, Host, carrier, and client tests pin the boundary and reconciliation contracts, while the real Chromium scenario pins the assembled message action and lineage tree.
