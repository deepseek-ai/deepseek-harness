# Agent Note: Team 消息使用目标 inbox

Status: implemented

[English](2026-09-26-team-direct-inbox.md) | 中文

## 问题

第二套 Team outbox 通过独立身份、确认、持久化检查点和重试排序重复了 Agent inbox 的职责。调用方需要明确的准入结果，而 continuation owner 已提供目标锁、生命周期授权和冷恢复。

## 决策

新的 Team 发送返回获准 inbox 的 `MessageId` 或抛出错误。它们使用 live Lead Steer 或 host-only subagent Steer adapter，通过现有 `agent-message` source 保留真实发送者，并在正文中保留成员名称。接收遵循普通 Agent 的持久化策略，既不确认模型已处理，也不增加同步 flush 保证。Team 不保留尚未接收的发送意图，不在重启后重试，也不对显式重发去重。

历史 mailbox 记录继续可解码并参与投影，使现有 Lead 日志能够回放，但 Team 不再投递或确认它们。该包是实验性的，没有稳定性承诺；另设一条带回执检查、同目标排序和独立 dispose 等待的投递路径，其代价高于它能补回的未投递旧消息。这部分取代了 [Agent Teams](../feature/2026-08-05-agent-teams.zh.md) 的 mailbox 决策；roster 和任务决策仍由原记录负责。[包参考](../../../../packages/experimental/agent-team/README.zh.md#understand-the-implementation)定义由此产生的限制。

## 考虑过的替代方案

**为所有发送保留 Team outbox。** 这保留了更强的重试承诺，但重复协调职责，并要求维护两个接收状态。只有具体的持久发送意图需求无法由 Agent inbox 满足时，才重新引入它。

**扩大公开的 sibling 消息权限。** Team 成员关系与 subagent parent 权限不同。host adapter 授权确切的 Lead，不会错误归属发送者，也不会扩大公开 child control 权限。

**重启后补送历史 pending 项。** 这能兑现已接收的旧意图，但会在 Agent inbox 之外保留第二个投递 owner，而这些数据只由实验性的可选组合写入。同时删除 decoder 的方案也被否决，因为包含 mailbox 记录的 Lead 日志将无法回放。

## 后果

新尝试只有一个身份和一个 inbox owner。失败尝试会向调用方报告，且没有 Team 重试承诺。历史日志仍需要 decoder 与投影代码。升级前目标尚未记录的历史消息永远不会被投递。测试覆盖直接 Lead／peer 接收、冷恢复、发送者归属、失败、取消、dispose（资源释放），以及重启后历史排队消息仍可读取且不被投递。
