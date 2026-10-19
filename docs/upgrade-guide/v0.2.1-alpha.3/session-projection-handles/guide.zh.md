---
kind: upgrade-guide
description: "Session 投影注册改为异步，并返回保留读取能力的句柄而不是释放函数。"
---
# Session 投影注册句柄

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-session-projection` 的 `SessionProjectionRegistry.register(definition)` 从同步释放函数改为返回 `Promise<ProjectionHandle<S>>`。注册表级 `stateOf(session, key)` 与 `SessionProjectionStateMap` 已移除。宿主状态类型保留在各自的 `ProjectionDefinition<K, S>` 中，注册时从 `stateSchema` 推导。注册错误现在使返回的 Promise 拒绝。最后一次注册释放后，该投影单元不再参与快照、检查点和实时通知，但保留的句柄仍可按需折叠 Session 事件。

`@deepseek-ai/dsh-agent` 与 `@deepseek-ai/dsh-subagent` 依赖 `sessionProjections`。AgentRegistry 持有轮次和步骤状态；消费方使用 `ctx.agents.turnBoundaryOf(session)`，不再导入 `turnBoundaryProjectionDefinition`。包括 Claude Code mods 桥接在内的轮次状态消费方依赖 `agents`。预设与上下文压力分别通过 `ctx.agentPresets.presetForSession(session)` 和 `ctx.tokenMeter.contextPressure(session)` 读取。API 控制器与 mods 桥接不再独立注册这些定义；所属服务缺席时采用各自的可选服务行为。`@deepseek-ai/dsh-api-session-controller` 同时移除了 `installModelSelectionProjection`。

## 迁移

1. 在自定义组合中，先挂载 `SessionProjectionRegistry`，再挂载 `AgentRegistry`、`SubagentRuntime` 及其他投影所有者。组合中的插件依赖 `agents` 时，加入 `@deepseek-ai/dsh-agent`。领域数据的消费方注入所属服务。
2. 删除宿主状态映射的声明合并与导入，将局部状态类型作为 `ProjectionDefinition<K, S>` 的第二个类型参数。保留 `SessionProjectionMap` 中的客户端值声明。对插件自己的定义，在异步 `apply()` 或 `[Service.init]()` 中等待 `ctx.sessionProjections.register(definition)`，并在提供依赖操作前于内部保存句柄。保留现有函数插件命名空间导出。
3. 将 `registry.stateOf(session, key)` 替换为其他领域的业务服务方法，或所有者内部的 `handle.stateOf(session)`。将保存的取消注册回调替换为始终返回 `Promise<void>` 的 `handle.dispose`，并等待显式释放完成；fiber 释放仍会自动释放注册。处理初始化失败时须等待注册。
4. 将 `installModelSelectionProjection(ctx)` 替换为 `await ctx.sessionProjections.register(modelSelectionProjection)`，从 `@deepseek-ai/dsh-api-session-controller/src/model-selection-projection.ts` 导入该定义。
5. 对自定义插件执行类型检查，再验证激活、Session 状态读取与 owner 释放。已释放的读取句柄仍可使用，而投影单元在最后一次注册解除后会从新快照中消失。
