# Agent Note: Interactive side sessions and merge-back

Status: proposed

English | [中文](2026-07-08-interactive-side-sessions.zh.md)

## Problem

A user may want to explore a question from a live session without changing its main context. Existing primitives do not expose that product shape: [session-store fork](../../implemented/feature/2026-06-30-session-store-fork-api.md) creates an unattached session, while [fork subagents](../../implemented/feature/2026-06-21-subagent-capability-seam.md) are model-driven tasks whose transcript collapses into one tool result. Neither gives the user a separate conversation, and neither records a conclusion in the parent together with the side session that produced it.

## Proposal

A **side session** is an ordinary live session forked at the source's last completed turn, attached to its own agent, framed as a read-only advisor, and able to **merge back** one condensed note.

- **Fork and attach:** create the child with the parent's balanced completed-turn prefix, `parentSession`, `meta.isSeeded: true`, and the exact sibling `inheritedEventCount`. This composes `ctx.agents.create({ seed, inheritedEventCount, meta })`; it adds no core service or session-store method.
- **Advisor framing:** inject one plugin-sourced `context/message` after creation that tells the child to explain without mutating or continuing the task. Keeping the system prompt byte-identical preserves the provider prefix cache over inherited history.
- **Merge-back:** ask the child for a length-capped handback, then inject one plugin-sourced `context/message` into the parent. The next parent request sees it at its logged position, preserving replay and [request reconstructability](../../implemented/architecture/2026-07-05-reconstructable-requests.md) without a new session event.
- **Presentation:** invocation, session switching, and handback rendering belong to the first client UI. This Agent Note specifies only the client-independent mechanics.

Rewind productization, session-tree views, a model-facing side-session tool, and `forkName`/`mergedInto` metadata are out of scope. A live-adapter spike validated source-log isolation, inherited context, a multi-turn child exchange, and merge-back visibility in the parent's next turn.

## Alternatives considered

- **Use the subagent seam:** rejected because side sessions are user-driven, client-visible, and may outlive a parent turn; subagents are model-driven runs returning one tool result.
- **Change the child system prompt:** rejected by default because any byte change invalidates the prefix cache from token zero. Deployments may still prefer that stronger separation.
- **Add `sidechat/*` events:** deferred because a sourced `context/message` already records the content, producer, and replay input durably. A dedicated event is justified only by a client that needs distinct rendering.
- **Bind a protocol API now:** rejected because current UIs are client-owned. Live presentation must eventually derive from the durable message so replay renders the same record.

## Acceptance criteria

- Forking leaves the source untouched and creates a child with the balanced completed-turn prefix, `parentSession`, `isSeeded: true`, the exact `inheritedEventCount`, and a byte-identical system prompt.
- Advisor framing adds exactly one plugin-sourced `context/message` at the head of the child's appended history, rather than changing its system prompt.
- Merge-back adds exactly one length-capped `context/message` with source `plugin: sidechat`; the next parent request and replay see it at the same position.
- Parent and child run concurrently without log or stream cross-talk.
- Unit tests cover fork/attach and merge-back; snapshot coverage lands with the first bound UI.

## Risks

- Read-only behavior is advisory until a `tools/pre-execute` deny gate enforces it; [the interception point](../../implemented/feature/2026-06-30-interception-extension-points.md) can add that gate without changing these mechanics.
- A compacted source forks its compacted view, so a bound UI should disclose that the child inherits summaries rather than replaced turns.
- Repeated handbacks consume parent context. The per-merge length cap bounds each note; later consolidation belongs to compaction.
