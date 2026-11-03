---
kind: upgrade-guide
description: "Agent 创建和恢复选项将表示运行归属的 parentAgent 改名为 ownerAgent。"
---

# Agent 运行归属使用 `ownerAgent`

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-agent` 中的 `CreateAgentOptions` 和 `ResumeAgentOptions` 将 `parentAgent` 替换为 `ownerAgent`。这影响调用 `ctx.agents.create()` 或 `ctx.agents.resume()` 的插件与自定义工厂。该字段指定拥有运行实例的在线 Agent；省略时创建运行时根。

Session 创建来源仍由 `meta.parentSession` 记录。嵌套子代理的运行归属者可以是树根，而直接创建者是另一个后代。持久化 Session 字段和格式保持不变。

## 迁移

1. 将创建和恢复调用中的 `parentAgent` 选项改名为 `ownerAgent`，并更新读取或透传该字段的自定义 `AgentFactory` 实现。继续传入原来的 Agent。
2. 保持 `meta.parentSession` 和存储的 `parentSession` 值不变。不要用运行归属者替换直接创建者。
3. 针对更新后的包对消费者运行类型检查，再验证创建和恢复后的 `ctx.agents.isOwnedBy(id, owner)` 与 `ctx.agents.roots()` 仍报告相同的运行归属关系。
