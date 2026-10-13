# Agent Note: 必需 runtime context 中的 Team 身份

Status: implemented

[English](2026-10-13-team-identity-runtime-context.md) | 中文

## Problem

嵌入初始任务的 teammate 身份依赖普通历史保留。压缩可能移除它；从 teammate 创建的普通 fork 即使已成为独立 Lead，也可能保留旧角色。身份必须反映当前 membership，同时保持共享系统指令一致。

## Decision

`tool-agent-team` 通过 Agent 作用域的 `systemPrompt.context()` 注册 `team:identity`，并设置 `required: true`。提供方读取现有 Team membership，渲染成员角色、名字与寻址说明。关闭可选 context 不能移除它。固定协作策略保留在 system prompt；roster 和 task 状态仍通过工具查询。初始任务只包含传入的正文。

Loop 负责日志记录、保留快照比较和压缩后的重新接纳。角色变化会在继承历史之后追加当前完整 runtime-context 快照；保留的 context 未变化时不追加消息。不引入 Team 专属的保留状态、事件类型或日志迁移。已有身份提醒仍作为历史消息保留。

本决策仅取代 [Agent Teams](../feature/2026-08-05-agent-teams.zh.md#team-identity) 中的初始任务身份决策；其 roster、mailbox 和 task 决策仍然有效。

## Alternatives considered

**身份留在初始任务中。** 保持 system prompt 一致，但恢复被移除的身份或纠正 fork 继承的角色需要额外机制。

**身份放进 system prompt。** 成员之间的 system 文本会不同；不支持历史内 system 更新的路由可能重写继承的请求前缀。

**添加自定义提醒保留与重新注入。** 重复了 loop 已有的 runtime-context 投影和恢复职责。

## Consequences

成员承担完整 runtime-context 快照中的身份 token 成本。其他 context 变化会重复身份，保留的 context 稳定时则不追加消息。Fork 保留继承历史并追加当前身份；提供方实际缓存命中仍为尽力而为。现有 Team 授权仍在工具执行时落实。

验证覆盖 fresh 和 fork teammate、从 teammate 创建的独立 fork、关闭可选 context、压缩后恢复、冷恢复和注册释放。录制的 `team-targets` 场景固定 Lead context；无密钥 headless Team 工作流通过内置 profile 固定 teammate context。
