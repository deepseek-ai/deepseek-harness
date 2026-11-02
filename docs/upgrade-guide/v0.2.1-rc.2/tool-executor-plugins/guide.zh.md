---
kind: upgrade-guide
description: "工具执行模式从 dsh-tools 配置移至显式执行器插件。"
---

# 挂载工具执行器

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-tools` 保留工具注册和执行器选择，但加载时会拒绝已移除的 `mode` 和 `maxParallelSubCalls` 配置字段。原生和 PTC 执行分别要求 `@deepseek-ai/dsh-tool-executor-native` 或 `@deepseek-ai/dsh-tool-executor-ptc`。内置 profile 已挂载执行器，自定义组合必须添加一个。现有 `dsh-agent-tool-presentation` 选择器仍受支持，但已弃用。启用的 `tool-executor-native` 和 `tool-executor-ptc` 条目属于启动必需项；无效的执行器配置会终止启动。Web、headless 与 SDK 不再读取 `DSH_TOOLS_MODE`，均继承 base 的原生执行。

## 迁移

1. 保留 `dsh-tools` 条目并移除其执行配置。在目标部署或预设作用域挂载一个原生或 PTC 执行器。内置 profile 的补丁应修改执行器条目，而非 `tools` 条目。
2. 把 `maxParallelSubCalls` 移到 PTC 执行器配置，并挂载兼容的 `ctx.ptcRuntime` 提供方。执行器将该服务声明为必需注入；缺少运行时会阻止启动，卸载运行时会撤回执行器。`agent-loop.maxParallelToolCalls` 和已保存的覆盖值保留原位，默认值为 `10`。循环向每个批次传入当前上限；实时修改从下一个批次生效，不再从下一个工具组生效。
3. 自定义执行器实现 `describe` 和 `execute`。程序调用方传入原始 `calls` 和 `signal`，以及可选的 `agent` 和 `log: { turn, step }`；从 `results` 读取单次结果。不属于已提交模型步骤的调用应省略 `log`。
4. 从 `@deepseek-ai/dsh-tool-executor-ptc` 导入 PTC SDK 渲染器和 `CodeRunFailedError`。用所选交互模式运行任务，确认工具结果出现在 Session 中。
5. 从 `@deepseek-ai/dsh-tools/pipeline` 导入 `ToolExecutionPipeline` 和 `executeToolBatch`。完整执行（包括单次调用）使用批次；自定义调度器直接调用 `prepare`、`dispatch` 和 `complete`。把 `@deepseek-ai/dsh-tool-testkit` 添加为开发依赖，并从该包导入工具 fixture。工具注册表主入口不再导出这些成员。
6. 从 `@deepseek-ai/dsh-tool-executor-ptc/types` 导入共享分派事件与 `ptc-mode` 消息来源声明；Client 代码使用其 `/client` 重导出。Host 策略扩展通过 `@deepseek-ai/dsh-tool-executor-ptc` 的 `import type` 获取 `PtcDispatchLog` 与 `tools/ptc-dispatch-log`。

7. 从启动环境中移除 `DSH_TOOLS_MODE`。需要 PTC 时，将以下内容保存为 `ptc.yml` 并通过 `--patch` 加载；原生执行无需 overlay。同一补丁也适用于 `--profile web` 和 `--profile sdk`；TypeScript 和 Python SDK 客户端通过 `patches` 传入其路径。确认 PTC 模式下模型只收到 `run_code`。

```yaml
- id: tool-executor-native
  disabled: true

- id: tool-executor-ptc
  disabled: false
```

```bash
dsh --profile headless --patch ./ptc.yml "task"
```
