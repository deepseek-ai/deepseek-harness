---
description: "The model-facing todo_write tool over the DeepSeek Harness session log: whole-list replacement, per-session ownership, the todos projection, and opt-in stale-list update reminders, for users and maintainers choosing, configuring, or debugging the tool."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-todo

English | [中文](README.zh.md)

## Summary

`dsh-tool-todo` gives the agent a structured task list to plan with: break multi-step work into concrete tasks, mark active work, and check items off as they finish. The list survives across turns and reopened sessions, so the agent and UI always see the latest plan. One flag controls parallel `in_progress` items, and an opt-in `reminder` policy (disabled by default) injects a bounded excerpt of the current list centered on the first unfinished item after unchanged assistant steps. Each update replaces the whole list, and only the owning agent session can change it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use this package when you want the agent to maintain a visible task list while it works: plan multi-step work, show what is active, and record completion. Mounting it with the parallelism flag is the only required setup; opt into `reminder.enabled: true` when long-running agents should receive periodic reconciliation nudges.

### When to choose it

Choose it when one agent session should own the task list and whole-list updates are fine — the common shape for planning tools. Avoid it when several agents must share one list or when you need per-item edits: the list belongs to one agent and every update replaces the whole list. It needs an agent session to exist at all; automation-only surfaces that never run an agent cannot use it.

### Minimal configuration

`allowParallelInProgress` is required with no default: a composition that omits it fails at load, and a non-boolean value is rejected. Set `true` for agents that may run work concurrently (subagents, background commands, workflow fan-out) and `false` for the single-active discipline.

`reminder` is optional and defaults to disabled (`enabled: false`), so compositions such as `dsh-base` keep reminders off until opted in. When `reminder.enabled` is `true`, `intervalSteps` sets how many completed `assistant/message` records must follow the latest Todo write or delivered reminder before injecting a nudge (default `64`), and `maxReminderChars` caps the complete model-visible reminder by JavaScript string length (default `16384`). The Loader rejects non-integer intervals, intervals below one, and character caps too small to preserve the fixed guidance and truncation notice.

```yaml
- name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: true
    reminder:
      enabled: false
      intervalSteps: 64
      maxReminderChars: 16384
```

| Field | Default | Meaning |
|---|---|---|
| `allowParallelInProgress` | required | Whether several todos may be `in_progress` at once; also selects the active-status clause of the model description |
| `reminder.enabled` | `false` | Whether to inject stale-list update reminders on accepted model steps |
| `reminder.intervalSteps` | `64` | Assistant messages between a Todo write or delivered reminder and the next reminder |
| `reminder.maxReminderChars` | `16384` | Character cap for one complete model-visible reminder |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-todo) is the exhaustive source for the accepted field.

### What each call does

The agent sends the ENTIRE list on every update; the new list replaces the previous one, so there are no partial updates or per-item edits. Each item is a short task description plus a status of `pending`, `in_progress`, or `completed`. A successful update returns the new counts — `Updated todo list: <pending> pending, <inProgress> in progress, <completed> completed.` — and the UI shows the new plan. Updates fail visibly when a task description is empty or duplicated, when an item carries fields beyond the description and status, or — when parallel work is disabled — when more than one task is marked in progress.

### Single owner

The task list belongs to the one agent session that created it — subagents and other agents each keep their own list, and there is no way to share a list between agents. A call from outside an agent session is rejected, so the agent learns the update failed instead of silently writing nowhere. If you need a list shared across agents, this package does not provide it.

### Advisory reminder trigger and reset rules

When `reminder.enabled` is `true`, a reminder becomes due only when the latest `todo/write` contains at least one `pending` or `in_progress` item, at least `reminder.intervalSteps` later `assistant/message` records exist, and the current agent's tool view still exposes `todo_write`. The plugin evaluates those conditions after downstream `agent/pre-step` listeners accept the step; rejection or cancellation adds nothing.

Every `todo/write` resets the count. A replacement containing only `completed` items, or an empty replacement, also disarms reminders until a later unfinished list is written. A delivered reminder resets the count again, so an unchanged list can produce another reminder only after a full interval.

The session log is the scheduling authority. When reminders are enabled, the plugin registers a host-only `todoReminder` unit on `ctx.sessionProjections` that folds `todo/write`, its own `todo-reminder` snapshot messages, and `assistant/message` records without adding a wire view. A reopened Session, a compacted conversation, and a checkpoint-restored Session therefore preserve both the current writer-authored list and reminder cadence without a second authoritative Todo copy or a new session event. The client-facing `todos` projection clears at the next `turn/start`, and reminders deliberately do not read it because an unfinished writer-authored list can still need reconciliation in a later turn.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the tool and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The tool is built on four commitments:

- **Whole-list replace, log-backed state.** The model resends the entire list; the `todo/write` snapshot lives on the event-sourced session log, so durability, replay, and resume reconstruction come from the log rather than a service.
- **Single owner.** The list belongs to the calling agent session; there is no shared or swarm scope, and non-agent callers are rejected.
- **Deployment policy, not a coded rule.** `allowParallelInProgress` is a required composition choice because the tool cannot observe runtime concurrency; `reminder` is opt-in policy kept inside the owning package.
- **Validation keeps the logged snapshot honest.** Schema-level rejection of unknown keys and `execute`-level rejection of empty or duplicate content keep the durable snapshot equal to what the model believes it wrote.

The [todo_write tool Agent Note](../../../.agents/notes/archived/feature/2026-06-29-todo-write-tool.md) records the original design and alternatives; the [parallel in-progress Agent Note](../../../.agents/notes/archived/feature/2026-07-26-todo-parallel-in-progress.md) records the parallelism policy decision; the [Todo update reminder Agent Note](../../../.agents/notes/implemented/feature/2026-08-27-todo-update-reminder.md) records the reminder scheduling and opt-in default rationale.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, tool registration, `todos` projection unit, `MessageSourceMap` augmentation |
| [`src/reminder.ts`](src/reminder.ts) | Host-only `todoReminder` projection registration, pre-step reminder trigger, and bounded excerpt rendering |
| [`src/types.ts`](src/types.ts) | The one home of the `todos` projection-key declaration and its payload types |
| [`src/client.ts`](src/client.ts) | Client-namespace re-export of the types outlet |

### Export shape

The plugin is a function/namespace plugin: it exports `name` / `inject` / `Config` / `apply` and no default export. A stray `export default` would make the Loader's `unwrapExports` collapse the module and drop `inject` (see [postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

### Session projection

When the composition mounts `ctx.sessionProjections` ([`@deepseek-ai/dsh-session-projection`](../../session/session-projection/README.md)), this package registers the `todos` unit on an injected child: the projection is the standing plan — the latest whole `todo/write` list, `null` before the first write, cleared when the next turn starts while `turn/end` keeps the finished checklist visible. The key merges into `SessionProjectionMap` here; carriers serve the value on the history tail page and the `session/projection` push frame. When `reminder.enabled` is `true`, [src/reminder.ts](src/reminder.ts) additionally registers the host-only `todoReminder` unit (without a wire view) to track unfinished Todo items and assistant messages since the last write or reminder.

### Call mechanics

Each call validates the submitted list against the schema, rejects incoherent input, and on success appends the full snapshot as a `todo/write` session event and returns the new counts; the current list is always the most recent `todo/write` in the log (last-write-wins on replay). When reminders are enabled and truncation is necessary, `renderReminder` keeps a contiguous excerpt centered on the transition from completed work to the first unfinished item, prioritizing that first unfinished item, its immediately preceding completed item, and subsequent work before using spare characters for older completed items; the reminder source declares `kind: 'todo-reminder'` and `form: 'snapshot'`, mirroring the model-visible text in one named section. See [src/index.ts](src/index.ts) and [src/reminder.ts](src/reminder.ts) for the exact steps.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the session subsystem to the generated catalogs and the decision records behind the tool.

- [Todo subsystem](../../../docs/subsystems/todo.md) — the `todo/write` event payload, ownership rules, and `TodoItem`.
- [todo group map](../README.md) — the sibling group page and its package table.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-todo) — the `todo_write` schema the model receives.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-todo) — every accepted config field and its source declaration.
- [todo_write tool Agent Note](../../../.agents/notes/archived/feature/2026-06-29-todo-write-tool.md) — the original design, alternatives, and dropped fields.
- [parallel in-progress Agent Note](../../../.agents/notes/archived/feature/2026-07-26-todo-parallel-in-progress.md) — why the active-count cap is a deployment policy.
- [Todo update reminder Agent Note](../../../.agents/notes/implemented/feature/2026-08-27-todo-update-reminder.md) — reminder scheduling, opt-in default, and package ownership rationale.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`todo_write` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-todo): an object with one required `todos` array of `{ content, status }` items, where `status` is `pending`, `in_progress`, or `completed`. The `todos` description states that each call replaces the whole list; the tool description's active-status clause follows `allowParallelInProgress`.

#### Token effect

Fixed schema cost on every request where the tool is visible; the description and schema are stable for a given configuration.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

Each assistant tool call retains the entire replacement list in its arguments. Success returns exactly `Updated todo list: <pending> pending, <inProgress> in progress, <completed> completed.` Stable failures are `Error: invalid arguments: todos[<i>].content must be a non-empty string`, `Error: invalid arguments: todos[<i>].content duplicates "<content>"`, and — only where the deployment set `allowParallelInProgress: false` — `Error: invalid arguments: at most one task may be in_progress (got <n>)`, all `ToolArgsError` `INVALID_ARGS`, plus `Error: todo_write requires an owning agent session` as `ToolContextUnavailableError` `TOOL_CONTEXT_UNAVAILABLE`. The full `todo/write` session event is UI and replay state, not a second model message.

#### Token effect

Token growth scales with every full list the model submits, and those call arguments remain until compaction. The result itself is small and fixed-shape.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Stale-list reminder snapshot

#### What the model sees

Only when `reminder.enabled` is `true` and the interval expires, the next accepted request receives one retained user-role message. `<items>` contains complete lines from the latest Todo list, one originally numbered `[status]` line per item with JSON-quoted content. If the full message exceeds `reminder.maxReminderChars`, the excerpt centers on the last completed and first unfinished items and includes the exact marker `[todo items outside this excerpt omitted; rebuild or clear the list instead of guessing their contents]`.

##### Reminder template

```markdown
<system-reminder>
An open task list has remained unchanged while the work continued. Reconcile it with actual progress before proceeding when the list is still useful. Invoke `todo_write` with `todos` set to the entire replacement array: move finished work to `completed` as soon as it finishes, mark work currently underway `in_progress`, and leave later work `pending`. Rebuild the array when its items no longer match the task. If tracking adds no value, clear the recorded list with `todos: []`. Keep this maintenance note out of the response to the user.

Current todo list:
<items>
</system-reminder>
```

#### Token effect

Zero tokens while `reminder.enabled` is `false` (default) or before a reminder is due. When enabled and due, each delivered reminder adds the fixed guidance plus a bounded excerpt of the current list centered on the first unfinished item to retained history until compaction shadows it; `reminder.intervalSteps` bounds frequency and `reminder.maxReminderChars` bounds each model-visible reminder.

#### KV Cache effect

Append-only; the reminder follows the reusable request prefix. A later reminder adds another suffix, while compaction may replace an older visible span.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the tool or its optional reminder is a poor fit. They are current package constraints, not a task backlog.

- **Single-owner scope only** — the list belongs to the one calling agent session; subagent, shared, and swarm scopes are a deliberate cut, and a non-agent caller is rejected.
- **The item shape is deliberately minimal** — `content` plus three-state `status`; whole-list replacement needs no stable id, priority, or active-form fields.
- **Whole-list replacement is the only operation** — no partial updates, no read-back tool, and no per-item edits; the model must resend the entire list each call.
- **Reminders are advisory and opt-in** — disabled by default (`reminder.enabled: false`); when enabled, reminders only suggest updates after an unfinished `todo/write` and `intervalSteps` assistant messages, never force first-list creation, block final answers, or certify completion, and may omit items outside the active excerpt boundary.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: cross-agent and shared lists

The single-owner scope is a deliberate cut, and cross-agent or shared lists remain a separate future design: they would need per-item log deltas and explicit scope selection, and would change the model-visible contract. No design exists yet.

</details>
