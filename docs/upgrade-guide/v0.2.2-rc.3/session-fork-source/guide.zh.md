---
kind: upgrade-guide
description: "Agent 工厂调用方在 seed 之外指定共享的父前缀来创建 fork。"
---

# fork 创建接收父来源

[English](guide.md) | 中文

## 变更

fork 在 `seed` 之外传入 `CreateAgentOptions.parentSource: { sessionId, endSeq }`：父会话和子会话共享的父前缀长度（不包含末端位置）。前 `endSeq` 条 seed 事件必须是持久化读取或观察返回的父会话已存储事件。工厂把构造完成的 log 连同该父来源作为 `SessionPersistenceCreateOptions.parentSource` 传给后端，后端在 `create()` 返回前存储：SQLite 排空实时父写者、引用已持久化前缀并只写入 `endSeq` 之后的事件；JSONL 复制整个 log。父会话已存储历史短于 `endSeq` 时，SQLite 以 `SESSION_FORK_PREFIX_NOT_PERSISTED` 拒绝创建。

`session/fork` Remote 请求及其包含截点的 `atSeq` 保持不变。父会话后续事件不会扩展子会话历史。Agent（智能体）工厂调用方仍可通过完整 `seed` 事件直接回放或恢复历史，`ContinuableCreateSpec.seed` 仍提供子代理前缀。

## 迁移

1. 当历史来自父 Session 时，在 `seed` 之外加上 `parentSource: { sessionId, endSeq }`；保留 `inheritedEventCount` 和 `meta.isSeeded`。
2. 按持久化返回的原样提供父前缀。冷观察的 `persistedEventCount` 限定 `endSeq`；其后的事件（例如中断轮次修复）属于子会话。
3. 从已完成轮次 fork，重新打开子会话并确认其包含所选历史。再向父会话追加一个轮次，确认子会话历史保持不变。来源字段见 [Agent 创建参考](../../../../packages/core/agent/README.zh.md#use-this-package)，后端存储见[持久化服务](../../../../packages/session/session-persistence/README.zh.md)。
