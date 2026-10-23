---
kind: upgrade-guide
description: Agent 工厂归属参数和注册表树查询已删除；subagent Activation 拥有运行时树成员关系。
---

# Subagent 运行时归属

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-agent` 删除 create/resume 的运行时归属参数（`parentAgent` 或 `ownerAgent`）、`AgentRegistry.isOwnedBy()`、`AgentRegistry.roots()` 以及 `enter()` 的 owner 参数。直接通过工厂创建 Agent 不再将其加入托管 subagent 树。自定义工厂不再实现运行时树归属。

subagent 服务通过 `rootOf(agent)` 从已有 Activation 解析运行时成员关系。Session 格式和 Cordis 上下文对句柄的所有权不变。

## 迁移

1. 通过 `ctx.subagents.startActivation()` 和已注册提供方创建委派工作。删除直接调用 `ctx.agents.create()` 与 `resume()` 时的归属参数；这些操作创建独立的运行时实例。
2. 通过 `ctx.agents.get(id)` 与 `list()` 查询存活实例。筛选普通存活 Agent 时，用 `agent.session.header.origin !== 'subagent'` 过滤 `list()`；历史普通 fork 仍可能包含 `parentSession`。
3. 通过 `ctx.subagents.rootOf(agent)` 查询存活树根，并比较 Agent 对象，而非仅比较 id。普通存活 Agent 返回自身；非托管的委派实例或失效实例抛出代码为 `UNAUTHORIZED` 的 `SubagentError`。直接创建者读取 `session.header.parentSession`；遍历离线创建祖先时使用持久化 subagent 目录。
4. 更新自定义工厂，在 setup 后调用 `ctx.agents.enter(agent)`。保留调用方上下文释放、初始化回滚和确切实例注册检查。运行时树成员关系在托管 activation 发布后可用；`agent/created` 早于该时点。验证失效实例不能复用已释放实例的归属。
