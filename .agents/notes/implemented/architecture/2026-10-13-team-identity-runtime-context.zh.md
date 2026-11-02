# Agent Note: 必需 runtime context 中的 subagent 身份

Status: implemented

[English](2026-10-13-team-identity-runtime-context.md) | 中文

## Problem

嵌入初始任务的 teammate 身份依赖普通历史保留。压缩可能移除它；从 teammate 创建的普通 fork 即使已成为独立 Lead，也可能保留旧角色。身份必须反映当前 subagent 树，同时保持共享系统指令一致。

## Decision

`tool-subagent-control` 在普通 subagent 和 Team 组合中通过 `systemPrompt.context()` 提供必需的 `subagent:identity`。它从 `ctx.subagents.rootOf(agent)` 派生身份：根看到自身 Session id，后代看到自身、直接父级和根 id。根不可用时会明确报告。可选上下文抑制和 Team 模式都不会移除身份。只有根可用时，agent 才会分别根据对应标准工具的获准情况收到通信与发现指导。Team 任务策略保留在共享系统提示中；任务状态仍通过工具查询。

Loop 负责日志记录、保留快照比较和压缩后的重新接纳。角色变化会在继承历史之后追加当前完整 runtime-context 快照；保留的 context 未变化时不追加消息。不引入 Team 专属的保留状态、事件类型或日志迁移。已有身份提醒仍作为历史消息保留。

这仅取代 [Agent Teams](../feature/2026-08-05-agent-teams.zh.md#team-identity) 中将身份放入初始任务的决策。[任务板等待协调](2026-10-19-team-task-board-inbox.zh.md)使普通收件箱等待独立于 Team 专用模型指导。

## Alternatives considered

**身份留在初始任务中。** 保持 system prompt 一致，但恢复被移除的身份或纠正 fork 继承的角色需要额外机制。

**身份放进 system prompt。** 成员之间的 system 文本会不同；不支持历史内 system 更新的路由可能重写继承的请求前缀。

**添加自定义提醒保留与重新注入。** 重复了 loop 已有的 runtime-context 投影和恢复职责。

## Consequences

成员承担完整 runtime-context 快照中的身份 token 成本。其他 context 变化会重复身份，保留的 context 稳定时则不追加消息。Fork 保留继承历史并追加当前身份；提供方实际缓存命中仍为尽力而为。现有 Team 授权仍在工具执行时落实。

验证覆盖新建和 fork 子级、独立 Session fork、可选上下文抑制、压缩恢复、不可用根、冷恢复和注册释放。录制的普通 subagent 和 Team 工作流通过各自的分发组合固定身份行为；委派任务保留最终结果返回指导。
