# Agent Note: Todo update reminders from durable session history

Status: implemented

English | [中文](2026-08-27-todo-update-reminder.zh.md)

## Problem

The `todo_write` description tells a model to update task status as work changes, but that instruction is present only as tool guidance. A model can keep using other tools and produce many assistant messages without reconciling an unfinished list. The durable list then diverges from actual progress, reducing both its planning value for the model and its progress value for readers.

A reminder must recognize this drift without making Todo updates mandatory for trivial work, duplicating authoritative task state outside the session log, or changing the generic agent loop. It must also preserve its cadence after resume and compaction, and it must not instruct an agent to call a tool hidden by that agent's scoped tool policy.

## Decision

Stale-list update reminders live inside `@deepseek-ai/dsh-tool-todo` (`packages/todo/tool-todo/src/reminder.ts`) under the optional `reminder` configuration block, disabled by default (`enabled: false`, `intervalSteps: 64`, `maxReminderChars: 16384`) so `dsh-base` and Desktop presets leave reminders off unless an overlay opts in (`reminder.enabled: true`). Deployments and users opt in via configuration overlays before enabling reminders by default.

When enabled, the plugin advises every agent whose current tool view exposes `todo_write`. It does not create a list, mutate Todo state, block a model step, reject a final answer, or infer task completion.

## Scheduling authority

The raw Session event log is the only scheduling authority. When `reminder.enabled` is `true`, `dsh-tool-todo` registers a private host-only `todoReminder` unit on `ctx.sessionProjections` that folds three records: an unfinished `todo/write` stores that event's immutable list and resets the counter; a completed or empty `todo/write` clears it and resets the counter; each later `assistant/message` increments the counter while unfinished work exists. A `todo-reminder` message resets the same counter.

An accepted `agent/pre-step` emits a reminder when the counter reaches `intervalSteps` and `todo_write` remains visible to the calling agent. It delegates first, so a rejected decision or aborted signal emits nothing. A reminder becomes the next cadence anchor only when the loop appends its returned message; an append failure leaves the old durable history authoritative.

The projection unit is a derived index over immutable event data (with checkpoint support for cold restore), not a second authoritative Todo store. A reopened Session or restored checkpoint rebuilds or advances it from raw events. Compaction appends replacement messages while retaining the source events, so both the latest writer-authored list and the assistant-message cadence remain reconstructable. When `reminder.enabled` is `false`, neither the `todoReminder` unit nor the `agent/pre-step` listener is registered.

The client-facing `todos` projection is not suitable scheduling input. Its product lifetime deliberately clears at the next `turn/start` so a previous checklist disappears from the plan strip ([decision](../../archived/feature/2026-07-28-todo-plan-clears-on-next-turn.md)). Reminder policy instead needs the latest writer-authored list until another `todo/write` supersedes it; reading the client projection would silently disarm cross-turn reconciliation.

## Model context

Each reminder enters the accepted current-step message batch as a durable user-role `<system-reminder>`. It names `todo_write`, explains whole-list replacement and the three statuses, permits rebuilding or clearing stale tracking, and asks the model not to mention the maintenance message. The character cap covers the complete model-visible text; when truncation is necessary, the renderer keeps a contiguous excerpt centered on the transition from completed work to the first unfinished item and marks the rest as omitted.

The source is `{ kind: 'todo-reminder', form: 'snapshot', sections: [{ name: 'todo-reminder', text }] }`. Snapshot form is appropriate because the message carries current Todo state and a later reminder supersedes that state.

## Package ownership

`dsh-tool-todo` owns the `todo_write` tool schema, write validation, `todo/write` durable event, current-turn client projection (`todos`), and the opt-in reminder policy (`todoReminder` host-only projection unit and prompt rendering). Keeping the reminder policy co-located inside `dsh-tool-todo` avoids multiplying single-feature packages for one domain while keeping default runtime overhead at zero until `reminder.enabled` is set to `true`.

The plugin uses the existing `agent/pre-step` and `sessionProjections` extension points. No `agent-loop` behavior, new session event type, or Todo service is added.

## Verification

Package tests run the real AgentLoop and Loader `cordis.yml` composition with scripted model responses and pin default-disabled inertness, threshold timing, exact prompt text and source attribution, repeated cadence, Todo-write reset, completed-list suppression, durable-log reconstruction, projection checkpoint restore plus suffix replay, scoped tool restriction, rejected and aborted steps, invalid configuration, and plugin disposal. A keyless headless snapshot pins the opt-in reminder in the assembled base profile and in the subsequent model request.

## Alternatives considered

**Ship a separate `@deepseek-ai/dsh-todo-reminder` plugin package enabled by default.** Putting reminder policy in a separate package adds package, manifest, and bundle wiring overhead for behavior that shares the exact Todo domain, `tools`, and `sessionProjections` injections with `dsh-tool-todo`. Merging it behind an opt-in `reminder.enabled: false` setting keeps one Todo package and lets adopters test reminders before enabling them by default.

**Put the reminder in the global system prompt.** This adds tokens to every request, including sessions with no list, and cannot carry the current list or a state-dependent cadence without changing system-prompt assembly.

**Append guidance only to `todo_write` results.** Immediate feedback can reinforce a write, but it cannot detect that later work continued without another write. The stale condition exists only after subsequent assistant messages.

**Read the `todos` projection or add a Todo service.** The client-facing `todos` projection intentionally clears at a UI turn boundary, while a service or separate durable schedule would duplicate log-owned state. A private host-only projection unit preserves one authority while supporting incremental fold and checkpoint restore without exposing a client view.

**Persist a reminder counter event.** The count is a deterministic fold of existing `assistant/message`, `todo/write`, and reminder messages. Another event would duplicate derivable state and enlarge the durable event set without improving reconstruction.

**Block final answers while a list is unfinished.** Todo status is model-authored planning state, not evidence that the user's task is incomplete. A hard veto would turn a useful heuristic into an unreliable completion authority.

## Consequences

Deployments keep existing behavior unchanged until `reminder.enabled: true` is configured. When enabled, an unfinished list receives bounded, repeated maintenance advice while work continues, and the exact list plus cadence survive restart and compaction without additional session events. Because the mechanism is advisory, correctness still depends on model compliance; because it follows raw writer-authored state across turns, it can surface a list after the current-turn UI projection has cleared.
