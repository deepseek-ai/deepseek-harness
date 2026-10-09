---
kind: upgrade-guide
description: "受管理的子 agent activation 替代前台与 Job 后台委派、相关配置键和已发布的进程内驱动包。"
---

# 将委派迁移到受管理的子 agent activation

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-tool-subagent` 移除了 `backgroundMode`、`enableRunInBackground` 和模型参数 `run_in_background`。每次委派现在都会在接纳子 agent（智能体）后返回 `{ kind: 'activation', subagentId }`，运行时通过父级完成通知交付最终答案。前台结果和 `{ kind: 'background', jobId }` 结果已移除；子 agent 不再通过 `job_output` 或 `job_kill` 收集结果或停止。

已发布的 `@deepseek-ai/dsh-subagent-in-process-driver` 包被移除。本地提供方通过 `prepareContinuable()` 提供创建输入，由子 agent 服务拥有执行过程。Spawn 和 Fork 子级可以接收后续消息；组合了持久化和 Session 查询服务时，结算后也能接收。外部提供方只执行一次，不接受后续消息。

## 迁移

1. 从 `cordis.yml`、配置文件补丁和覆盖文件中的 `tool-subagent` 配置项删除 `backgroundMode` 和 `enableRunInBackground`。保留提供方和其余配置。例如：

   ```yaml
   - name: '@deepseek-ai/dsh-tool-subagent'
     config:
       provider: spawn
       toolName: subagent
   ```

   本地工具委派需要 Session 持久化。将其与[子 agent 服务及提供方](../../../../packages/subagent/subagent/README.zh.md#use-this-package)一起组合。

2. 从工具调用中删除 `run_in_background`，并将结果消费方改为读取 `subagentId`。收集完成通知，替代前台输出或 Job 结果。组合了相应控制工具时，使用 `interrupt_agent` 停止当前执行；`send_message` 仅用于本地子级。

3. 对于必须等待结果的宿主代码，将 `ctx.subagents.start()` 或 `startContinuable()` 替换为 `startActivation()`，并选择调用方投递。以下示例假设服务已组合且父 agent 在线：

   ```ts
   import type { Agent } from '@deepseek-ai/dsh-agent'
   import type SubagentRuntime from '@deepseek-ai/dsh-subagent'

   async function collect(subagents: SubagentRuntime, parent: Agent, signal: AbortSignal) {
     const activation = await subagents.startActivation({
       provider: 'spawn',
       label: 'Review changes',
       request: { parent, prompt: [{ type: 'text', text: 'Review these changes.' }] },
       signal,
       delivery: 'caller',
     })
     const result = await activation.result
     await activation.dispose()
     return result
   }
   ```

   调用方投递不会发送父级完成通知。`result` 在清理结束后结算，包含 `output`、`stopReason` 以及可选的 `structured` 和 `diagnostic` 值；将结果视为成功前先检查 `stopReason`。发布后，启动信号不再控制取消：保留回执，通过 `dispose()` 取消该次 activation。`dispose()` 单独报告清理失败，不替换已捕获的执行结果。

4. 删除驱动包依赖及其导入，包括 `startInProcessRun`。挂载现有的 Spawn 或 Fork 提供方，并按上例调用服务。自定义本地提供方按[提供方 API](../../../../docs/subsystems/subagent.zh.md)实现 `prepareContinuable()`；没有替代的独立驱动包。

   外部提供方保留 `start()`，但每次返回的 `SubagentRun.id` 必须在运行时内跨父级、提供方和本地 Session 保持唯一。为每次执行生成新的 id，替代父级独立计数器。

   使用 `dsh-subagent-dsh-sdk` 时，将单独配置的 `dshBin` 运行时更新到支持 `session/wait` 的版本。 目录配置按照[工作目录迁移指南](../working-directory/guide.zh.md)调整。

5. 确认委派返回 activation 结果变体，完成通知包含最终答案，且调用方投递返回结果而不添加该通知。确认本地子级在完成后仍可列出，外部子级不支持继续执行。
