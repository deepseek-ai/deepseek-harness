# Agent Note: 将仅用于追踪的会话事实折叠进承载实际功能的事件

Status: implemented

[English](2026-06-20-collapse-trace-only-session-events.md) | 中文

## 问题

会话事件词汇中包含一些一等事件，它们不属于可回放的对话历史，在生产环境中几乎没有消费方。`usage` 已经作为模型流分片存在，之后循环又追加了一个独立的 `usage` 事件。`error` 与 `turn/end { kind: 'error', message, code }` 中的循环失败原因重复；ACP（Agent Client Protocol）结算读取轮次结束原因，而消息投影和 UI 投影都会跳过独立的 `error` 事件。

这些事件让规范的 transcript（文本记录）看起来比实际更适合作为遥测数据。它们增加了事件变体、不变式、测试、快照和持久化用例，但作为独立记录并不承载实际功能。它们携带的事实仍然有用：token 用量应当保留以供核算，错误的步骤编号也不应悄然消失。简化的方式是将这些事实折叠进消费方本已必须理解的邻近事件，而非减少记录的信息量。

## 决策

仅在信息已被保留、无需并行记录的情况下，移除独立的、仅用于追踪的事件：

- 成功步骤的 usage 折叠进匹配的 `assistant/message`（`assistant/message { turn, step, content, usage? }`），使组装好的模型输出与其核算信息一同传递。
- 失败或中止的步骤如果有 usage 但没有助手内容，则将 usage 放在一个空内容的 `assistant/message { content: [], usage }` 上——不会有已持久化的 usage 分片无处安放。必须确保信息不丢失的典型情形是 max-tokens 路径：一个被截断的步骤有 usage 但内容为空（例如只有一个被丢弃的工具调用），以前会发出独立的 `usage`。为防止空内容事件向提供方 transcript 注入一个多余的无内容的助手轮次，`deriveMessages()` 跳过空内容的 `assistant/message` 事件；回归测试断言 usage 仍有记录，且派生历史未被破坏。
- 独立 `error` 事件中的步骤编号折叠进 `turn/end.reason`（当 `kind: 'error'` 时：`{ kind: 'error', step, message, code? }`）——`turn/end` 是 ACP 和恢复机制已经消费的持久轮次结果。
- `agent/error` 与日志保留用于实时诊断；`turn/end` 之后不再有第二条会话日志错误记录。

用户对话日志包含渲染、恢复、审计和核算所需的全部信息，消费方无需协调重复的追踪行。

## 曾考虑的替代方案

**保留独立行作为遥测**——这些事件让规范 transcript 看起来比实际更适合作为遥测数据，代价是增加了事件变体、不变式、测试、快照和持久化用例，却没有任何消费方使用。如果分析需求真正出现，正确的形态是投影辅助工具或带有独立保留策略的专用遥测存储，而非对话日志中的重复追踪行。

## 验证

`SessionEventMap` 不再包含独立的 `usage` 或 `error`；agent loop（智能体循环）不再追加独立的 usage 事件，并通过 `turn/end { kind: 'error', step, message, code? }` 持久记录失败；ACP 快照和持久化测试断言不存在仅用于追踪的行；冻结的 v0 codec 与恒等迁移会把该已发布表示保留到当前 v1；文档说明了 token 用量和运行错误的观测位置。

## 后果

消费方不能再从规范日志中筛选独立的 `usage` 或步骤级 `error` 行，而必须从承载这些信息的助手消息或失败事件中读取这些事实。由于相同事实仍然存在——「验证」一节给出了证明——这是合理的简化。

## 实现说明

**格式版本。** 该事件简化早于已发布 v0 基线。`dsh-session` 拥有当前写入方常量，静态目录与相邻包则拥有受支持历史版本的解码和迁移。恒等的 v0-to-v1 边在不改变该事件表示的情况下证明整套生命周期。

Usage 现在通过 `assistant/message.usage` 观测；运行错误的步骤编号通过 `turn/end.reason`（当 `kind: 'error'` 时）观测。`agent/error` 与日志用于实时诊断，保持不变。
