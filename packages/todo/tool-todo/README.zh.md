---
description: "面向 DeepSeek Harness 会话日志的模型侧 todo_write 工具：整表替换、单一会话归属、todos 投影以及默认关闭的过时列表更新提醒，供选择、配置或排查该工具的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-todo

[English](README.md) | 中文

## 概述

`dsh-tool-todo` 为 agent（智能体）提供一份可用于规划的结构化任务列表：把多步工作拆成具体任务、标记正在进行的工作、完成后逐项勾掉。列表跨轮次、跨重新打开的会话持续存在，agent 与 UI 始终看到最新计划。一个开关控制是否允许多个任务同时 `in_progress`，可选的 `reminder` 策略（默认关闭）则在列表未更新且经历指定条数 assistant 步骤后，注入围绕第一个未完成条目截取的有界列表片段。每次更新整体替换列表，只有拥有该列表的 agent 会话才能修改。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当你希望 agent 在工作时维护一份可见的任务列表时使用本包：规划多步工作、展示当前进行中的任务、记录完成情况。挂载它并设置并行开关是唯一的必填配置步骤；当长时间运行的 agent 需要周期性校准提示时，可将 `reminder.enabled` 设为 `true`。

### 何时选择

当某个 agent 会话应当拥有任务列表、且整表更新即可满足需求时选择它——这是规划工具的常见形态。当多个 agent 必须共享同一份列表、或需要逐项编辑时，请避开：列表只属于一个 agent，每次更新都会替换整个列表。它要求环境中确实存在 agent 会话；从不运行 agent 的纯自动化入口无法使用它。

### 最小配置

`allowParallelInProgress` 是必填项、没有默认值：省略它的组合会在加载时失败，非布尔值也会被拒绝。可能并发运行工作的 agent（subagent、后台命令、工作流扇出）设为 `true`，需要单活跃项纪律的设为 `false`。

`reminder` 为可选配置且默认关闭（`enabled: false`），因此 `dsh-base` 等组合在未显式启用前均保持关闭。当 `reminder.enabled` 为 `true` 时，`intervalSteps` 表示最新 Todo 写入或已交付提醒之后需要完成多少条 `assistant/message` 记录再注入提示（默认 `64`），`maxReminderChars` 按 JavaScript 字符串长度限制完整模型可见提醒（默认 `16384`）。Loader 会拒绝非整数或小于一的间隔，也会拒绝无法保留固定指引与截断提示的过小字符上限。

```yaml
- name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: true
    reminder:
      enabled: false
      intervalSteps: 64
      maxReminderChars: 16384
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `allowParallelInProgress` | 必填 | 是否允许多个 todo 同时处于 `in_progress`；同时选择模型描述中的活跃状态条款 |
| `reminder.enabled` | `false` | 是否在获准模型步骤中注入过时列表更新提醒 |
| `reminder.intervalSteps` | `64` | Todo 写入或已交付提醒与下一次提醒之间的 assistant 消息数 |
| `reminder.maxReminderChars` | `16384` | 一条完整模型可见提醒的字符上限 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-todo)是每个受支持字段的穷尽式真源。

### 每次调用做什么

agent 每次更新都发送完整列表；新列表替换旧列表，因此没有部分更新或逐项编辑。每个条目是一句简短的任务描述，外加 `pending`、`in_progress` 或 `completed` 状态。成功的更新会返回新的计数——`Updated todo list: <pending> pending, <inProgress> in progress, <completed> completed.`——UI 随即展示新计划。任务描述为空或重复、条目带有描述与状态之外的字段、或（禁用并行时）多个任务被标记为进行中，这些情况下更新都会明确失败。

### 单一所有者

任务列表属于创建它的那一个 agent 会话——subagent 与其他 agent 各自维护自己的列表，不存在跨 agent 共享列表的方式。来自 agent 会话之外的调用会被拒绝，因此 agent 会得知更新失败，而不是被静默丢弃。如果你需要多个 agent 共享同一份列表，本包不提供该能力。

### 建议性提醒的触发与重置规则

当 `reminder.enabled` 为 `true` 时，只有在最新 `todo/write` 至少包含一个 `pending` 或 `in_progress` 条目、其后至少存在 `reminder.intervalSteps` 条 `assistant/message` 记录、且当前 agent 的工具视图仍暴露 `todo_write` 时，提醒才会到期。插件会在下游 `agent/pre-step` listener 接受该步骤后评估这些条件；拒绝或取消不会加入任何内容。

每次 `todo/write` 都会重置计数。只包含 `completed` 条目的替换列表或空替换列表也会停用提醒，直到后来写入未完成列表。已交付的提醒会再次重置计数，因此未变化的列表只有经过完整间隔后才能再次产生提醒。

会话日志是调度权威。启用提醒时，插件会在 `ctx.sessionProjections` 上注册一个仅限宿主的 `todoReminder` 单元，用来折叠 `todo/write`、自身 `todo-reminder` 快照消息和 `assistant/message` 记录，而不暴露 wire 视图。因此，重新打开的 Session、经过压缩的对话以及从检查点恢复的 Session 都能保留当前由写入方记录的列表与提醒节奏，不会形成第二份权威 Todo 副本，也不新增会话事件。面向客户端的 `todos` 投影会在下一次 `turn/start` 时清空，提醒刻意不读取该投影，因为写入方记录的未完成列表在后续轮次仍可能需要校准。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本工具建立在四项承诺之上：

- **整表替换、日志承载状态。** 模型重新发送整个列表；`todo/write` 快照存放在事件溯源的会话日志上，持久性、回放与恢复重建都来自日志而非服务。
- **单一所有者。** 列表属于调用 agent 会话；不存在共享或 swarm 作用域，非 agent 调用方会被拒绝。
- **部署策略，而非编码规则。** `allowParallelInProgress` 是必填组合选择，因为工具无法观测运行时并发；`reminder` 是保留在所属包内的可选策略。
- **校验确保日志快照如实反映输入。** schema 层拒绝未知键、`execute` 层拒绝空或重复 content，使持久快照与模型自认为写入的内容一致。

[todo_write 工具 Agent Note](../../../.agents/notes/archived/feature/2026-06-29-todo-write-tool.md) 记录原始设计与备选方案；[并行 in-progress Agent Note](../../../.agents/notes/archived/feature/2026-07-26-todo-parallel-in-progress.md) 记录并行策略决策；[Todo 更新提醒 Agent Note](../../../.agents/notes/implemented/feature/2026-08-27-todo-update-reminder.zh.md) 记录提醒调度与默认关闭依据。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、工具注册、`todos` 投影单元、`MessageSourceMap` 扩充 |
| [`src/reminder.ts`](src/reminder.ts) | 仅限宿主的 `todoReminder` 投影注册、pre-step 提醒触发与有界片段渲染 |
| [`src/types.ts`](src/types.ts) | `todos` 投影键声明及其载荷类型的唯一归属地 |
| [`src/client.ts`](src/client.ts) | 客户端命名空间对类型出口的再导出 |

### 导出形状

本插件是函数／命名空间插件：导出 `name`、`inject`、`Config`、`apply`，没有默认导出。多余的 `export default` 会让 Loader 的 `unwrapExports` 折叠模块并丢弃 `inject`（参见 [postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md)）。

### 会话投影

当组合挂载 `ctx.sessionProjections`（[`@deepseek-ai/dsh-session-projection`](../../session/session-projection/README.zh.md)）时，本包在注入的子插件中注册 `todos` 单元：投影即有效计划——最新的整份 `todo/write` 列表，首次写入前为 `null`，下一轮次开始时清空，而 `turn/end` 保留刚完成的清单。该键在此处合并进 `SessionProjectionMap`；载体通过历史尾页与 `session/projection` 推送帧提供该值。当 `reminder.enabled` 为 `true` 时，[src/reminder.ts](src/reminder.ts) 还会注册仅限宿主的 `todoReminder` 单元（无 wire 视图），用于追踪自上次写入或提醒以来的未完成 Todo 条目与 assistant 消息。

### 调用机制

每次调用都会先校验提交的列表是否符合 schema，拒绝不一致的输入，成功后把完整快照作为 `todo/write` 会话事件追加并返回新的计数；当前列表始终是日志中最近一次 `todo/write`（回放时后写覆盖先写）。启用提醒且需要截断时，`renderReminder` 会保留一个以已完成工作和首个未完成条目交界处为中心的连续片段，依次优先保留首个未完成条目、紧邻其前的已完成条目及后续工作，再用剩余字符容纳更早的已完成条目；提醒来源声明 `kind: 'todo-reminder'` 与 `form: 'snapshot'`，并在一个命名 section 中镜像模型可见文本。确切步骤见 [src/index.ts](src/index.ts) 与 [src/reminder.ts](src/reminder.ts)。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从会话子系统逐步进入生成的目录，以及工具背后的决策记录。

- [Todo 子系统](../../../docs/subsystems/todo.zh.md)——`todo/write` 事件载荷、归属规则与 `TodoItem`。
- [todo 组映射](../README.zh.md)——同级组页面及其包表格。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-todo)——模型接收的 `todo_write` schema。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-todo)——每个受支持配置字段及其源声明。
- [todo_write 工具 Agent Note](../../../.agents/notes/archived/feature/2026-06-29-todo-write-tool.md)——原始设计、备选方案与未采纳的字段。
- [并行 in-progress Agent Note](../../../.agents/notes/archived/feature/2026-07-26-todo-parallel-in-progress.md)——为何活跃计数上限成为部署策略。
- [Todo 更新提醒 Agent Note](../../../.agents/notes/implemented/feature/2026-08-27-todo-update-reminder.zh.md)——提醒调度、默认关闭策略与包所有权依据。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

模型会看到生成的 [`todo_write` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-todo)：一个对象，含一个必填的 `todos` 数组，元素为 `{ content, status }`，其中 `status` 为 `pending`、`in_progress` 或 `completed`。`todos` 描述说明每次调用都会替换整个列表；工具描述中的活跃状态条款跟随 `allowParallelInProgress`。

#### Token 影响

工具可见的每个请求都有固定 schema 开销；在给定配置下描述与 schema 保持稳定。

#### KV Cache 影响

定义与可见性不变时前缀保持稳定。插件生命周期或作用域限制可能使从此 schema 起的复用失效。

### 工具调用历史与结果

#### 模型看到什么

每次 assistant 工具调用都会在参数中保留整个替换列表。成功时原样返回 `Updated todo list: <pending> pending, <inProgress> in progress, <completed> completed.`。稳定失败文本为 `Error: invalid arguments: todos[<i>].content must be a non-empty string`、`Error: invalid arguments: todos[<i>].content duplicates "<content>"`，以及——仅在部署设置 `allowParallelInProgress: false` 时——`Error: invalid arguments: at most one task may be in_progress (got <n>)`，均为 `ToolArgsError` `INVALID_ARGS`；另有 `ToolContextUnavailableError` `TOOL_CONTEXT_UNAVAILABLE` 的 `Error: todo_write requires an owning agent session`。完整的 `todo/write` 会话事件是 UI 与回放状态，而非第二条模型消息。

#### Token 影响

token 用量随模型每次提交的完整列表增长，这些调用参数会保留到压缩（compaction）。结果本身很小且形状固定。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使既有 KV-cache 条目失效。

### 过时列表提醒快照

#### 模型看到什么

仅当 `reminder.enabled` 为 `true` 且间隔到期时，下一个获准请求会收到一条保留的用户角色消息。`<items>` 包含最新 Todo 列表中的完整条目行，每个条目保留原始编号并占一行 `[status]`，内容使用 JSON 引号。如果完整消息超过 `reminder.maxReminderChars`，片段会以最后一个已完成条目和首个未完成条目为中心，并包含精确标记 `[todo items outside this excerpt omitted; rebuild or clear the list instead of guessing their contents]`。

##### 提醒模板

```markdown
<system-reminder>
An open task list has remained unchanged while the work continued. Reconcile it with actual progress before proceeding when the list is still useful. Invoke `todo_write` with `todos` set to the entire replacement array: move finished work to `completed` as soon as it finishes, mark work currently underway `in_progress`, and leave later work `pending`. Rebuild the array when its items no longer match the task. If tracking adds no value, clear the recorded list with `todos: []`. Keep this maintenance note out of the response to the user.

Current todo list:
<items>
</system-reminder>
```

#### Token 影响

当 `reminder.enabled` 为 `false`（默认）或提醒未到期时为零 token。启用并到期时，每次已交付提醒都会把固定指引和围绕第一个未完成条目截取的有界列表片段加入保留历史，直到压缩遮蔽它；`reminder.intervalSteps` 限制频率，`reminder.maxReminderChars` 限制每条模型可见提醒。

#### KV Cache 影响

仅追加；提醒位于可复用请求前缀之后。后续提醒会再增加后缀，而压缩可能替换较早的可见区间。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明工具或可选提醒何时不合适。它们是当前包约束，不是任务积压。

- **仅单一所有者作用域**——列表属于唯一调用 agent 会话；subagent、共享与 swarm 作用域是有意设置的限制，非 agent 调用方会被拒绝。
- **条目形状刻意保持最小**——`content` 加三态 `status`；整表替换不需要稳定 id、优先级或 active-form 字段。
- **整表替换是唯一操作**——没有部分更新、没有回读工具、没有逐项编辑；模型每次调用都必须重新发送完整列表。
- **提醒仅提供建议且默认关闭**——默认 `reminder.enabled: false`；启用后，仅在写入未完成 `todo/write` 并经过 `intervalSteps` 条 assistant 消息后给出建议，不会主动触发首次建表、阻止最终回答，也不会据此判定任务已完成，并且可能省略活跃交界以外的条目。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：未决问题与尚未决定的方向。它明确不具权威性——已交付行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

#### 未来：跨 agent 与共享列表

单一所有者作用域是有意设置的限制，跨 agent 或共享列表仍是独立的未来设计：它们需要逐项日志增量与显式作用域选择，并会改变模型可见约定。目前尚不存在设计。

</details>
