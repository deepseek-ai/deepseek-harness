---
kind: upgrade-guide
description: "工具声明只来自步骤准入的注册：`system-prompt/assemble` 不再携带工具，条件工具需要已解析的步骤集合，`exit_plan_mode` 只在会话首次进入计划模式后声明。"
---

# 通过步骤准入声明条件工具

[English](guide.md) | 中文

## 变更

`ctx.tools.register(definition, { when })` 可以附加同步或异步条件。AgentLoop 在提示词组装与 `agent/pre-step` 之前，以 `{ agent, modelSelection, signal }` 为每个拟议步骤计算一次条件，并在该步骤及其重试中用得到的 `ResolvedToolSet` 决定工具声明、原生分发、PTC 绑定和嵌套调用。条件返回 false 时，工具从以上所有位置移除；条件抛错时，轮次以 `TOOL_ACTIVATION_FAILED` 结束。

`system-prompt/assemble` waterfall 现在接收不含工具数组的段落、上下文与变量（`PromptPresentation`），返回的 `tools` 字段会被忽略。在这个 waterfall 中删除或添加工具声明的插件会受到影响：它们做的删除不再进入请求；读取 `assembly.tools` 的监听器会拿到 `undefined`，并在运行时出错。

模型的工具调用只通过所属步骤的准入集合执行。没有已解析集合的条件工具调用、集合释放之后的调用，以及注册在步骤内被替换或移除时尚未开始的调用，都会返回 `UNKNOWN_TOOL`，不会执行。替换规则适用于所有工具，因此在步骤中途重新注册工具的热重载、MCP 重连或 skill 重载会让该步骤里这个工具尚未开始的调用失败。不传集合的调用方（例如实验性 `claude-code-mods` 的 `$.tool.call`）无法调用条件工具。

`exit_plan_mode` 从已选计划状态首次为激活的步骤起声明，并在会话剩余部分保持声明，因此从未进入计划模式的会话，其请求不再列出它。现有 Session 无需格式迁移。

## 迁移

1. 把 `system-prompt/assemble` 监听器中的工具过滤和对 `assembly.tools` 的读取改为注册时的 `when` 条件；从条件的 `modelSelection` 读取该步骤的提供方、模型与推理强度。waterfall 中只保留段落、上下文与变量的修改。
2. 让工具指引跟随同一准入：段落回调把 `context.toolSet` 传给 `ctx.tools.get()` 或 `ctx.tools.schemas()`。
3. 程序化调用条件工具时，调用 `ctx.tools.resolve({ agent, modelSelection, signal })`，把返回的 `toolSet` 传给 `assemble()` 与 `ctx.tools.execute()` 批次，并在批次结束后释放。不使用共享 pipeline 的自定义执行器用 `ctx.tools.executable(name, agent, toolSet)` 查找每次调用。
4. 更新在会话进入计划模式之前仍列出 `exit_plan_mode` 的期望。验证被禁用的工具不出现在请求中，用其名称调用会返回 `UNKNOWN_TOOL` 且不进入实现，条件失败时轮次以 `TOOL_ACTIVATION_FAILED` 结束。
