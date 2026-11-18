---
kind: upgrade-guide
description: "Session 投影注册异步解析为保留读取能力的句柄；可调用的注册结果与注册表级状态读取已弃用。"
---
# Session 投影注册句柄

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-session-projection` 的 `SessionProjectionRegistry.register(definition)` 从同步释放函数改为 `Promise<ProjectionHandle<S>>`。定义同步安装；等待结果得到带 `stateOf(session)` 与 `dispose()` 的句柄，注册错误使结果拒绝。运行时返回值是可调用的 thenable，而非原生 Promise：调用它仍会释放注册，但该调用已弃用。`typeof registration` 为 `"function"`，`registration instanceof Promise` 为 false，因此按这些检查分支或把函数视为回调的代码会受影响；Vitest 的 `.rejects` 会调用它，而不是观察拒绝。

注册表级 `stateOf(session, key): unknown` 已弃用。当前没有任何插件注册该 key 时它返回 `undefined`：所属插件未组合、尚未执行到注册，或已释放最后一次注册。`SessionProjectionStateMap` 已移除；宿主状态类型保留在各自的 `ProjectionDefinition<K, S>` 中，并从 `stateSchema` 推导。最后一次注册释放后，该投影单元不再参与快照、检查点和实时通知，但保留的句柄仍可按需折叠 Session 事件。[运行时兼容说明](../../../../packages/session/session-projection/README.zh.md#deprecated-plugin-compatibility)详述这些已弃用调用。

`@deepseek-ai/dsh-agent` 与 `@deepseek-ai/dsh-subagent` 依赖 `sessionProjections`。AgentRegistry 持有轮次和步骤状态，并提供 `ctx.agents.turnBoundaryOf(session)`；`@deepseek-ai/dsh-agent-loop` 不再导出 `turnBoundaryProjectionDefinition`。包括 Claude Code mods 桥接在内的轮次状态消费方依赖 `agents`。预设与上下文压力分别通过 `ctx.agentPresets.presetForSession(session)` 和 `ctx.tokenMeter.contextPressure(session)` 读取。API 控制器与 mods 桥接不再独立注册这些定义；所属服务缺席时采用各自的可选服务行为。`@deepseek-ai/dsh-api-session-controller` 移除了 `installModelSelectionProjection`。

## 迁移

1. 在自定义组合中，先挂载 `SessionProjectionRegistry`，再挂载 `AgentRegistry`、`SubagentRuntime` 及其他投影所有者。组合中的插件依赖 `agents` 时，加入 `@deepseek-ai/dsh-agent`。
2. 对插件自己的定义，在异步 `apply()` 或 `[Service.init]()` 中等待 `ctx.sessionProjections.register(definition)`，并在提供依赖操作前保存句柄。删除 `SessionProjectionStateMap` 的声明合并，将状态类型作为 `ProjectionDefinition<K, S>` 的第二个类型参数。保留 `SessionProjectionMap` 中的客户端值声明。
3. 将 `registry.stateOf(session, key)` 替换为所属服务的方法（例如 `ctx.agents.turnBoundaryOf(session)`），或所有者内部的 `handle.stateOf(session)`；替换之前须处理其 `undefined` 结果。将对注册结果的调用替换为等待 `handle.dispose()`；fiber 释放仍会自动释放注册。
4. 需要原生 Promise 时传入 `Promise.resolve(registration)`，包括在 Vitest 中写 `await expect(Promise.resolve(registration)).rejects.toThrow(...)`。将对结果的 `typeof` 或 `instanceof Promise` 检查改为直接等待。
5. 将 `installModelSelectionProjection(ctx)` 替换为 `await ctx.sessionProjections.register(modelSelectionProjection)`，从 `@deepseek-ai/dsh-api-session-controller/src/model-selection-projection.ts` 导入该定义。
6. 对自定义插件执行类型检查，再验证激活、Session 状态读取、注册被拒绝以及 owner 释放。
