---
kind: upgrade-guide
description: Agent 工厂归属参数和注册表树查询已删除，改为查询托管 subagent 谱系。
---

# Subagent 运行时归属

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-agent` 删除 create/resume 的运行时归属参数（`parentAgent` 或 `ownerAgent`）、`AgentRegistry.isOwnedBy()`、`AgentRegistry.roots()` 以及 `enter()` 的 owner 参数。直接通过工厂创建 Agent 不再将其加入托管 subagent 树。自定义工厂不再实现运行时树归属。

subagent 服务在 setup 期间、`agent/created` 之前绑定本地实例。`lineageOf(agent)` 为托管本地实例返回确切的存活根实例和已验证的创建祖先 id；对普通、非托管或失效实例返回 `undefined`。Session 格式和 Cordis 上下文对句柄的所有权不变。

## 迁移

1. 通过 `ctx.subagents.startActivation()` 和已注册提供方创建委派工作。删除直接调用 `ctx.agents.create()` 与 `resume()` 时的归属参数；这些操作创建独立的运行时实例。
2. 通过 `ctx.agents.get(id)` 与 `list()` 查询存活实例。筛选普通存活 Agent 时，用 `agent.session.header.origin !== 'subagent'` 过滤 `list()`；历史普通 fork 仍可能包含 `parentSession`。
3. 通过 `ctx.subagents.lineageOf(agent)?.root` 查询托管归属，并比较 Agent 对象，而非仅比较 id。调用方或所有者不可用时需要拒绝的操作使用 `rootOf(agent)`。中间创建者读取 `lineageOf(agent)?.ancestors`；运行时树根不一定是直接创建者。
4. 更新自定义工厂，在 setup 后调用 `ctx.agents.enter(agent)`。保留调用方上下文释放、初始化回滚和确切实例注册检查。验证委派回调在 `agent/created` 期间可读取谱系，且不能复用已释放实例的归属。
