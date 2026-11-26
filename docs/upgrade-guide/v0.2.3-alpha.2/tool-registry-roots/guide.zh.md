---
kind: upgrade-guide
description: "工具执行器包改为根注册表，ctx.tools 以其为送达目标；步骤时的工具条件改由提供方为每个 Agent 添加的工具取代。"
---

# 工具执行器改为根注册表

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-tool-executor-native` 与 `-ptc` 改为 `@deepseek-ai/dsh-tool-registry-native` 与 `-ptc`，插件名为 `native-tool-registry` 与 `ptc-tool-registry`，Loader 行名为 `tool-registry-native` 与 `tool-registry-ptc`。配置字段不变。

`setExecutor()` 与 `ToolExecutor { sections?, describe(), execute() }` 改为 `setRoot(registry)` 与 `ToolRegistry`（`register()`、`include()`、`get()`、`getAll()`），其中 `ToolRegistry` 没有 `execute()`。`setRoot()` 把每个作用域的注册项交给根注册表，并发出 `tools/change`；引入或读取 `ctx.tools` 的根注册表会以 `INVALID_TOOL_COMPOSITION` 失败。`ctx.tools.get()` 与 `getAll()` 返回选中的根注册表的条目，在 PTC 根注册表下只有 `run_code`，没有可用的根注册表时则抛出 `TOOL_REGISTRY_UNAVAILABLE`（原为 `TOOL_EXECUTOR_UNAVAILABLE`）；`ctx.tools` 上没有任何 API 能列出 PTC 根注册表的绑定。所有模型直接调用的批次都由 `ctx.tools.execute()` 运行，每个 `ToolExecution` 都携带该调用所运行的 `definition`。

`register(tool, { when })`、`resolve()`、`executable()`、`definitions()`、`schemas()`、`ResolvedToolSet`、`ToolActivationContext`、`ToolActivationError`、PTC 的 `/run-code` 入口、`createRunCodeTool()` 与 `RunCodeConfig` 均已移除；也不再产生 `TOOL_ACTIVATION_FAILED`。`ToolDefinition.guidance` 持有工具的提示词段，在该工具可调用时显示；`restrict({ deny })` 接受尚无任何来源提供的名称。模型直接调用程序绑定时，该调用会在 `tools/pre-execute`、审批、守卫和包装层之前以 `unknown tool "<name>"; tools you can call directly: run_code` 失败。

在 `@deepseek-ai/dsh-tools/pipeline` 中，`executeToolBatch(input, pipeline)` 去掉了 `maxParallel` 参数，改用 `DEFAULT_MAX_PARALLEL_TOOL_CALLS`；`ToolExecutionSource.get()` 改为必需；`reject(name, nested)` 改为对每个调用都执行的 `reject(exec)`。`ToolNotFoundError(toolName, callable?)` 接收可直接调用的条目名称，取代 `reachableFrom`。

受影响的是点名旧行或旧包的 `cordis.yml` 文件与 overlay、自定义根注册表，以及使用已移除 API 或通过 `ctx.tools.get()` 读取已注册工具的插件。已录制的会话仍可读取。

## 迁移

1. 在 Cordis 配置与 `package.json` 中，将 `tool-executor-native` / `'@deepseek-ai/dsh-tool-executor-native'` 重命名为 `tool-registry-native` / `'@deepseek-ai/dsh-tool-registry-native'`，PTC 的行照此处理。
2. 将 `setExecutor(executor)` 替换为 `ctx.tools.setRoot(new NativeToolRegistry())` 或 `new PtcToolRegistry(ctx, { name: 'run_code' }).mountRoot()`。自定义执行器改为 [`ToolRegistry`](../../../subsystems/tools.zh.md#tool-registries-roots-and-model-steps) 根注册表：`describe()` 改为基于其 `include()` 所接收注册项的 `get()` 与 `getAll()`，并用 `get()` 解析名称，因为来源的 `getAll()` 可能重复列出同一名称；`sections` 改为在选择该根注册表的 effect 中调用 `ctx.systemPrompt.section()`；`execute()` 直接删除，因为调度与日志记录由 `ctx.tools.execute()` 负责。
3. 将 `register(tool, { when })` 替换为引入到 `ctx.tools` 中的 `AgentToolRegistry`，并在以下时机调用 `set(agent, names)`：收到 `agent/created` 时、收到条件输入的事件时、位于预设内且收到 `agent-preset/selected` 时，以及加载时（针对 `ctx.agents.list()` 中的 Agent）。
4. 把以 `ctx.tools.get(name, scope)` 控制显示的段移入该工具的 `guidance`；新增的工具在其 schema 中描述自己（[理由](../../../../.agents/notes/implemented/architecture/2026-11-19-composable-tool-registries.zh.md)）。按 Agent 提供工具的提供方读取自己的注册表。
5. 将策略中的 `ctx.tools.get(exec.name, exec.agent)` 替换为 `exec.definition`，将 `resolve()` 替换为 `ToolStep.capture(ctx.tools, agent)`。`schemas()` 与 `definitions()` 没有替代方法：`ctx.tools.getAll()` 列出的是根注册表的条目，因此请保留你自己注册的定义。
6. 将 `createRunCodeTool(ctx, { name, description, runtime, tools, limits })` 替换为持有这些工具、并引入到 `ctx.tools` 中的 `new PtcToolRegistry(ctx, { name, description, runtime, config: limits })`；`RunCodeConfig` 改为 `PtcToolRegistry.Config`。
7. 按上述签名更新 `ToolExecutionPipeline` 的来源、`executeToolBatch()` 调用与 `ToolNotFoundError` 的构造。
8. 确认 `dsh` 能够启动，并且 `ctx.tools.getAll(agent)` 列出预期的条目。
