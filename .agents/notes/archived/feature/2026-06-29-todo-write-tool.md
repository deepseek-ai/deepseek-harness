# Agent Note: The `todo_write` tool — model task list as event-sourced session state

Status: implemented
Archived: 2026-09-04

English | [中文](2026-06-29-todo-write-tool.zh.md)

## Problem

The harness gives the model bash and subagent tools but no way to record a structured task list. A todo list serves two co-equal purposes: it steers the model to plan multi-step work and keep the active work unambiguous, and it gives an interactive host a live progress checklist. Every reference coding agent surveyed (claude-code, opencode, codex, oh-my-pi, pi) ships some form of this; the harness had nothing.

## Decision

Add a model-facing `todo_write(todos: [{ content, status }])` tool whose whole-list state lives on the event-sourced session log as a `todo/write` `SessionEventMap` variant owned by the todo package ([event ownership](../architecture/2026-07-20-todo-event-ownership.md)). Interactive hosts render from the durable event: the TUI folds it directly, the web client projects it into `ConversationSnapshot.todos` ([web todo display](2026-07-23-web-todo-display.md)), while the [automation-only ACP bridge](../simplification/2026-07-23-acp-automation-only-protocol.md) deliberately omits todo presentation.

### Whole-list replace, three-state status

The model sends the entire list every call; the new list replaces the old (last-write-wins on replay). This is the shape claude-code V1, opencode, and codex `update_plan` all use, and the shape the model is most trained on — no per-item ids, no delta protocol. `status` is exactly `pending | in_progress | completed`, the same triple as codex `update_plan`; it also matched the ACP `PlanEntryStatus` 1:1 while the bridge projected todo lists as `plan` updates, a mapping retired with the [automation-only ACP contract](../simplification/2026-07-23-acp-automation-only-protocol.md).

### State on the session log, not a service

The list is appended as a `todo/write` event carrying the full `{ todos }` snapshot. The harness is event-sourced — the LLM history, tool calls, and turn structure all live on the log — so the todo list lives there too. This buys durability, replay, and resume reconstruction for free: a reopened session re-derives the standing plan from the latest `todo/write` that is not followed by a later `turn/start` ([plan strip lifetime](2026-07-28-todo-plan-clears-on-next-turn.md)), with no separate persistence backend, in-memory service to rehydrate, or extra wiring. An in-memory `ctx.todos` service would have to reinvent all of that. (Full-log consumers get this reconstruction outright; the web client's paged window gets it from the tail history page's host-computed projection — see the [web todo display note](2026-07-23-web-todo-display.md).)

### NOT a surface event

`todo/write` is deliberately excluded from `SurfaceEventType`. The surface is the projection that produces the LLM message history (`deriveMessages()`); a todo write produces no conversation message. So it carries no `surfaceOp`, never joins the ordered surface, and never reaches `deriveMessages()` — it is durable, replayable *UI* state that travels alongside the conversation without being part of it. (The dev-mode invariants still require it to sit inside an open turn, which it always does: it is appended mid-step during a tool call.)

### Dropped vs claude-code V1: `activeForm`, id, priority

claude-code V1's item is `{ content, status, activeForm }`; later (V2) it grew ids, dependencies, and ownership — but only to support agent *swarms* (disk-backed, lock-guarded, per-item mutation). This tool keeps the item at the minimum: `{ content, status }`. No `activeForm` (the present-continuous label) — the UI shows `content`; no id — whole-list replace needs no stable identity; no priority — that was only ever an ACP `PlanEntry` wire requirement, synthesized as a constant at the bridge boundary rather than modeled, and it left with that projection. Each dropped field is one less thing the model must produce on every call.

### Single owner — no swarm machinery (YAGNI)

Each list belongs to the calling agent session, and non-agent calls are rejected. There is no shared scope, resolver, or delta protocol. Cross-agent lists would require per-item log deltas and explicit scope selection, so they remain a separate future design.

### Validation: the cheap middle

The schema enforces type/required/enum. Beyond that, `execute` rejects empty or duplicate `content` and, when `allowParallelInProgress` is `false`, more than one active task. Ordering and keeping the list current remain model disciplines expressed in the tool description. A rejected write returns an `isError` result so the model self-corrects. The required deployment policy and the durable invariant's independence from it are owned by the [parallel in-progress Agent Note](2026-07-26-todo-parallel-in-progress.md).

## Why no cordis-catalog entry / no `@mode`

`todo/write` is a member of `SessionEventMap`, not a first-class cordis `interface Events` event. The catalog generator (`scripts/gen-cordis-catalog.ts`) scans `interface Events` declarations; a `SessionEventMap` variant rides the existing `session/event` emit and produces no new catalog row. So it carries no `@mode` tag (which the generator requires only on `interface Events` members) — adding one would be meaningless.

## Testing

Four tiers:
- **Unit** — the session event (append/snapshot-clone/last-write-wins/not-on-surface); the tool (schema shape, arg validation via the real `ctx.tools.execute`, value validation, the event append + replacement, no-agent rejection, `presentCall`, HMR-safety); and TUI folding.
- **Real-Loader path** — the plugin run through `Loader.unwrapExports`, asserting the namespace export shape survives (it HAS `inject`, so a stray default would crash at load — postmortem/0001).
- **Full-loop integration** — a scripted mock model calls `todo_write` through the real agent loop; the `todo/write` event lands and a second call replaces it.
- **Resume/replay** — a persisted `todo/write` folds back into the current task list.
- **With-key e2e + snapshots** — a real prompt induces `todo_write`; assembled snapshots pin the log event and interactive rendering.

## Alternatives considered

- **In-memory `ctx.todos` service** — would reinvent durability, replay, and resume reconstruction the log gives for free.
- **Per-item delta protocol** — only needed for a shared multi-owner list, which is out of scope; whole-list replace is simpler and matches the references.
- **Tool in `core/`** — `todo_write` is an extension tool registering on `ctx.tools`, not part of the spine; it lives in its own `packages/todo/` group like other tool families.

## Consequences

The todo list is durable, replayable session state: an interactive host re-derives it from the latest persisted `todo/write`, and the log — not plugin memory — is the single source of truth. Whole-list replace means one tool call per update with last-write-wins; there is no delta protocol to reconcile. The event stays off the model surface, so a todo update never perturbs derived model history — the model sees only its own tool call and result.
