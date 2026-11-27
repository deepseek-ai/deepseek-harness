# Agent Note: 基于持久会话历史的 Todo 更新提醒

Status: implemented

[English](2026-08-27-todo-update-reminder.md) | 中文

## 问题

`todo_write` 描述会指示模型在工作变化时更新任务状态，但这条指令只存在于工具指引中。模型可能继续使用其他工具并生成许多 assistant 消息，却不校准未完成列表。这样，持久列表会偏离实际进度，同时降低它对模型的规划价值和对读者的进度价值。

提醒必须识别这种偏离，同时让 agent 在处理琐碎任务时仍能自行决定是否更新 Todo。提醒机制不能在会话日志之外复制权威任务状态，也不能修改通用 agent loop。它还必须在恢复和压缩后保持节奏，并且不能指示 agent 调用被其作用域工具策略隐藏的工具。

## 决策

过时列表更新提醒合入 `@deepseek-ai/dsh-tool-todo`（`packages/todo/tool-todo/src/reminder.ts`）的可选 `reminder` 配置块中，默认关闭（`enabled: false`，`intervalSteps: 64`，`maxReminderChars: 16384`），因此 `dsh-base` 与桌面端 preset 在没有配置覆盖（`reminder.enabled: true`）时均不开启提醒。部署与用户可在默认开启前通过配置覆盖选择启用。

启用后，只要 agent 能在当前工具视图中看到 `todo_write`，插件就会向它提供建议。插件不会创建列表、改变 Todo 状态、阻止模型步骤、拒绝最终回答或推断任务完成情况。

## 调度权威

原始 Session 事件日志是唯一调度权威。当 `reminder.enabled` 为 `true` 时，`dsh-tool-todo` 在 `ctx.sessionProjections` 上注册一个私有的仅限宿主的 `todoReminder` 单元，折叠三类记录：未完成的 `todo/write` 保存该事件的不可变列表并重置计数；已完成或空的 `todo/write` 清除列表并重置计数；只要存在未完成工作，后续每条 `assistant/message` 都会增加计数。`todo-reminder` 消息会重置同一个计数。

当计数达到 `intervalSteps` 且 `todo_write` 对调用 agent 仍可见时，获准的 `agent/pre-step` 会发出提醒。它先委托下游，因此被拒绝的决策或已中止的 signal 不会发出任何内容。只有 loop 追加返回的消息时，提醒才会成为下一个节奏锚点；追加失败会让旧持久历史继续作为权威。

该投影单元是不可变事件数据之上的派生索引（支持用于冷恢复的检查点），不是第二个权威 Todo 存储。重新打开的 Session 或恢复的检查点会从原始事件重建或推进它。压缩会追加替换消息，但会保留源事件，因此最新由写入方记录的列表和 assistant 消息节奏都可以重建。当 `reminder.enabled` 为 `false` 时，既不注册 `todoReminder` 单元，也不注册 `agent/pre-step` 监听。

面向客户端的 `todos` 投影不适合作为调度输入。其产品生命周期会刻意在下一次 `turn/start` 时清空，使上一份清单从计划条消失（见[决策](../../archived/feature/2026-07-28-todo-plan-clears-on-next-turn.md)）。提醒策略则需要保留最新由写入方记录的列表，直到另一个 `todo/write` 取代它；读取客户端投影会悄然停用跨轮次校准。

## 模型上下文

每条提醒都会以持久用户角色 `<system-reminder>` 进入获准的当前步骤消息批次。它会点名 `todo_write`，解释整表替换与三种状态，允许重建或清空过时跟踪，并要求模型不要提及维护消息。字符上限覆盖完整的模型可见文本；需要截断时，渲染器会保留一个以已完成工作和首个未完成条目交界处为中心的连续片段，并标记其余内容已省略。

来源是 `{ kind: 'todo-reminder', form: 'snapshot', sections: [{ name: 'todo-reminder', text }] }`。快照形式是合适的，因为消息携带当前 Todo 状态，后续提醒会取代该状态。

## 包所有权

`dsh-tool-todo` 拥有 `todo_write` 工具 schema、写入校验、`todo/write` 持久事件、当前轮次客户端投影（`todos`）以及可选提醒策略（仅限宿主的 `todoReminder` 投影单元与提示词渲染）。将提醒策略合入 `dsh-tool-todo` 可避免围绕同一领域拆分过多的单功能包，同时在 `reminder.enabled` 设为 `true` 之前保持零运行时开销。

插件使用现有 `agent/pre-step` 与 `sessionProjections` 扩展点。它没有增加 `agent-loop` 行为、新会话事件类型或 Todo 服务。

## 验证

包测试使用带脚本模型响应的真实 AgentLoop 与 Loader `cordis.yml` 组合，固定默认关闭惰性、阈值时序、精确提示文本与来源归属、重复节奏、Todo 写入重置、已完成列表抑制、持久日志重建、投影检查点恢复及后缀回放、作用域工具限制、被拒绝和中止的步骤、无效配置与插件卸载。无密钥 headless snapshot 固定开启提醒后的 base profile 组装及后续模型请求。

## 考虑过的替代方案

**拆分独立的 `@deepseek-ai/dsh-todo-reminder` 插件包并默认启用。** 将提醒策略放到独立包会为同一 Todo 领域及共享 `tools`、`sessionProjections` 注入的逻辑增加包、manifest 与 bundle 组装成本。将其合入并以 `reminder.enabled: false` 作为可选开关，可保持单一 Todo 包，并让用户先通过配置试用再决定是否默认开启。

**把提醒放入全局 system prompt。** 这会向每个请求增加 token，包括没有列表的会话，并且无法在不修改 system-prompt 组装的情况下携带当前列表或实现依赖状态的节奏。

**只在 `todo_write` 结果后追加指引。** 即时反馈可以强化一次写入，但无法发现后续工作继续进行却没有再次写入。过时条件只会在后续 assistant 消息之后出现。

**读取 `todos` 投影或增加 Todo 服务。** 面向客户端的 `todos` 投影会刻意在 UI 轮次边界清空，而服务或独立持久调度会复制日志拥有的状态。私有的仅限宿主投影单元在保留单一权威的同时支持增量折叠和检查点恢复，而不暴露客户端视图。

**持久化提醒计数器事件。** 计数是现有 `assistant/message`、`todo/write` 与提醒消息的确定性折叠结果。另一个事件会复制可推导状态并扩大持久事件集合，却不会改善重建。

**在列表未完成时阻止最终回答。** Todo 状态是模型记录的规划状态，不是用户任务尚未完成的证据。硬性否决会把有用的启发式信号变成不可靠的完成权威。

## 后果

在配置 `reminder.enabled: true` 之前，部署保持原有行为不变。启用后，只要工作继续，未完成列表就会收到有界、重复的维护建议；精确列表和节奏可跨重启与压缩恢复，而无需额外会话事件。由于该机制仅提供建议，正确性仍取决于模型遵从；由于它跨轮次追踪原始写入方状态，因此可能在当前轮次 UI 投影清空后再次呈现列表。
