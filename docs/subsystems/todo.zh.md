# Todo

[English](todo.md) | 中文

Todo 子系统由 [`@deepseek-ai/dsh-tool-todo`](../../packages/todo/tool-todo/README.zh.md) 拥有。面向模型的工具会整体替换一个 agent（智能体）会话的列表；该包还拥有事件声明、回放投影与可选的过时列表更新提醒。工具与提醒的行为、配置及模型可见文本见[包 README](../../packages/todo/tool-todo/README.zh.md)。

源码：[`packages/todo/tool-todo/src/types.ts`](../../packages/todo/tool-todo/src/types.ts)

## `TodoItem`：一条列表项

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

## 持久事件

该包通过声明合并把 `todo/write: { todos: TodoItem[] }` 加入 `SessionEventMap`。此事件仅写入日志，并携带完整替换列表；生成的[持久化目录](../persistence-catalog.zh.md#todowrite--log-only)会记录其声明位置。

## 建议性更新提醒

当在 `@deepseek-ai/dsh-tool-todo` 上将 `reminder.enabled` 设为 `true` 时（默认关闭，包括在 `dsh-base` 中），包会注册一个仅限宿主的 `todoReminder` 会话投影，而不是读取面向客户端的 `todos` 投影。当最新列表尚未完成且在之后经过 `reminder.intervalSteps` 条 assistant 消息后仍未更新时，下一个获准的模型步骤会收到一条带来源的快照，其中包含维护指引与围绕第一个未完成条目截取的有界列表片段。之后的 Todo 写入或已交付提醒会重新开始计数；只包含已完成项或空列表会停用提醒，并要求 agent 作用域下 `todo_write` 可见。精确触发条件、提示词、恢复行为与限制见[包参考](../../packages/todo/tool-todo/README.zh.md)。
