# Todo

English | [中文](todo.zh.md)

The Todo subsystem is owned by [`@deepseek-ai/dsh-tool-todo`](../../packages/todo/tool-todo/README.md). The model-facing tool replaces one agent session's whole list; the package also owns the event declaration, replay projection, and optional stale-list update reminders. Tool and reminder behavior, configuration, and model-visible text are on the [package README](../../packages/todo/tool-todo/README.md).

Source: [`packages/todo/tool-todo/src/types.ts`](../../packages/todo/tool-todo/src/types.ts)

## `TodoItem` — one list entry

```ts type-equiv
/**
 * One entry in an agent's todo list — the unit of the `todo/write`
 * whole-list snapshot declared by this package.
 *
 * Deliberately minimal: a human-readable `content` line and a three-state
 * `status`. No id, priority, or `activeForm` — the list is replaced wholesale
 * on every write (last-write-wins), so entries need no stable identity. The
 * three statuses describe the complete portable lifecycle needed by model and
 * UI consumers.
 */
interface TodoItem {
  /** What this task is — a short imperative line shown in the UI. */
  content: string
  /** Lifecycle state. `in_progress` marks a task being worked now; parallel work may mark several. */
  status: 'pending' | 'in_progress' | 'completed'
}
```

## Durable event

The package declaration-merges `todo/write: { todos: TodoItem[] }` into `SessionEventMap`. The event is log-only and carries the complete replacement list; the generated [persistence catalog](../persistence-catalog.md#todowrite--log-only) records its declaration site.

## Advisory update reminders

When `reminder.enabled` is set to `true` on `@deepseek-ai/dsh-tool-todo` (disabled by default, including in `dsh-base`), the package registers a host-only `todoReminder` Session projection rather than reading the client-facing `todos` projection. When the latest list is unfinished and remains unchanged for `reminder.intervalSteps` later assistant messages, the next accepted model step receives a sourced snapshot containing maintenance guidance and a bounded excerpt of the current list centered on the first unfinished item. A later Todo write or delivered reminder restarts the interval; completed or empty lists disarm it. Agent-scoped `todo_write` visibility is required. See the [package reference](../../packages/todo/tool-todo/README.md) for the exact trigger, prompt, resume behavior, and limitations.
