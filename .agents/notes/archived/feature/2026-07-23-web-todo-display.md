# Agent Note: Web todo display — snapshot side-effect channel + two render surfaces

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-23-web-todo-display.zh.md)

## Problem

`todo_write` appends `todo/write` whole-list snapshots to the session log; the TUI renders a persistent plan panel (the automation-only ACP bridge deliberately omits todo presentation). The web client dropped the event entirely: the host mux stream already forwards every session event, but `todo/write` is not a surface type (it never folds into `ConversationSnapshot.nodes`), and no side-effect branch accumulated it — the browser had no consumption point and no display surface.

## Decision

Consume `todo/write` as a Session side effect, not a surface node, and render it on two surfaces matching the split the TUI already draws.

### Side-effect channel, converging with window replay

`applyEventSideEffects` gains a `todo/write` case (whole list, last write wins) and clears on `turn/start` ([turn-scoped plan lifetime](2026-07-28-todo-plan-clears-on-next-turn.md)). `rebuildDerivedFromWindow` sweeps the window from an empty plan and restores the tail-page seed only when the window never determined the plan (no `todo/write` and no `turn/start`); otherwise the in-window write/`turn/start` fold wins. Every `installWindow` caller is a tail request (`doOpen`, its gap re-pull, `repairGap`; `loadOlder` prepends without reseeding), which the host answers with the projection or omits it when no plan stands — so an absent field is the authoritative empty list and is assigned as such. That distinction matters on rollback: a live write whose host crashed before persisting leaves the log empty, and preserving the prior value instead would strand the rolled-back plan on screen indefinitely. `ConversationSnapshot.todos` is the read surface. This follows the event's own contract ("log-only UI state; never derived history"): surfacing each write as a conversation node would render superseded lists as if they were still standing.

### TodoPanel: the durable list as a persistent strip

The panel mounts through the `conversation.input.dock` slot (a plain registrant plugin, `todoDockEntry`, using `ctx.slots.inject` with no `ConversationController` edge, `order: 0` above the queue rows), hidden while empty, collapsible to a header of title + `·`-joined per-status counts (localized, `1 completed · 2 in progress · 1 pending`, zero-count segments omitted; no in-progress content hint when collapsed). Status glyphs are the figma todo set (green check ring / blue fading ring / dashed pending ring) on a tip-surface card (`--dsw-specific-tip`, 14px radius, `width: calc(100% - 88px)` / `max-width: 776px` centered; InputBar top pad 6px is the gap to the composer card). It reads the host-computed `todos` projection via the standard-kit `useProjection` hook the dock entry receives — no store, no service, no ctx. The inner component stays props-complete and framework-free; the dock adapter is a one-line wrapper.

### TodoRow: the per-call row through the keyed toolview slot

The dedicated `todo_write` chat row is a plain registrant plugin (`todoToolview`, mounted from `apply`) that registers into the keyed `tool.call.toolview` slot through `ctx.slots.inject`, the same declaration-lifetime posture as the bash sample but a product registration. The summary derives from call args (`N/M done · first active item`, with a `+<n>` count of the other active ones in `ToolRow`'s non-shrinking `summarySuffix` slot); unparseable args fall back to the generic row summary; clicking opens the details column with the raw args. No `ToolEventView` is added for todo — presentation is client-owned, and the durable list renders from the session event, not the tool card.

## Alternatives considered

- **Fold todo writes into `nodes` as surface entries** — replayed windows would render every superseded list; the event is deliberately not a surface type.
- **Hardcoding the panel inside `ConversationRoot`** — the original landing spot before the input-dock slot existed; the dock is the architecture's home for always-on strips above the composer, and a hardcode bypasses the slot registry's disposal and ordering.
- **Details column for the panel** — the details slot is single-occupant and selection-driven, a different lifetime than an always-on strip.
- **Host-computed view (a todo `ToolEventView`)** — presentation belongs to the client; the wire already carries the whole snapshot in the event payload.

## Consequences

Replay correctness is owned by one code path: any future change to window rebuild keeps todos consistent for free, and the fixture (fx-alpha turn 71) plus `packages/client/ui-conversation/tests/todo-panel.client.spec.tsx` pin the full chain (row summary and state, dock panel content, collapse round-trip). `todos` is a required `ConversationSnapshot` field, so scripted fakes in specs must carry it. The automation-only ACP bridge deliberately omits todo presentation; the web surfaces render the same event, adding one wire field and no new event type. That field is how cold-load reconstruction stays host-backed: the tail history page carries `todos` — the full-log standing plan (latest `todo/write` with no later `turn/start`), computed independently of the page window (the same backscan posture the view pairing uses) — so a reopened session restores the plan when it still stands and the last write precedes the window; that value survives an older-page prepend, is overwritten by any later write, clears on a later `turn/start`, and resets to empty when a tail response carries no projection.
