# Agent Note: 主动后台 Shell 的命令展示与任务状态分离

Status: implemented

[English](2026-10-10-background-shell-command-display.md) | 中文

## Problem

主动后台 Shell 在 Start 时已经具有完整 command 和工作目录，但 Tool 卡片使用通用参数 JSON，而不是普通 Shell 的命令区域。原调用返回的是启动回执，后台最终结果通过另一条完成通知或 `job_output` 调用出现；这些消息没有直接携带原 Bash callId，不能把启动回执当成执行完成，也不能用原调用状态代表任务实时状态。

## Decision

合法的主动后台 `bash`／`pwsh` 复用现有终端命令展示。Start 尚未返回时只表达启动调用正在进行；正常启动回执到达后，同一 Tool 卡片保留 command、工作目录、软换行及展开状态，切换为静态的仅命令展示，不显示执行状态点、退出码、空输出提示或持续运行动画。启动错误继续使用现有原始参数和错误结果展示；完整参数与启动回执仍可通过 Inspect 查看。

终端组件从 Start 起接收原调用的 `background` 标志，并结合调用的 `running` 决定展示：`background=true`、`running=true` 表示启动调用尚在进行；回执到达后 `background` 不变、`running=false`，只保留静态命令，不代表后台任务的运行状态。不新增派生展示参数或任务状态，也不以永久 `running=true` 伪造命令仍在执行。普通前台、持久 Shell 和 `terminal_send` 的默认行为不变；不改变原有 Copy 按钮的输出复制语义。

本次只处理主动后台启动，不修改超时转后台。没有 job 订阅、轮询、结果拼接或 callId/jobId 索引；后续完成通知和 `job_output` 保持原来的独立展示，标题栏任务面板继续拥有实时任务信息。Tool 卡片不回填最终输出，不修改 Host 接口、执行器或 Session 日志。

[Client 工具展示决策](../architecture/2026-08-23-client-derived-tool-presentation.zh.md#terminal-card)的原始事件派生与业务归属保持有效；本文仅替代其主动后台 Shell 使用通用正文的条目，不改变后台 `terminal_send`。

## Alternatives considered

**直接按普通已结束命令解析启动回执。** 回执没有命令退出结果，容易显示虚假的成功状态。

**永久保留 Start 的 running 状态。** 原 Tool 调用已返回，且不订阅任务状态，无法保证后台任务仍在运行。

**将后续 job 输出匹配回原 Tool。** 需要可靠的 jobId 与原 callId 关联，还要定义分次读取、缺失历史和重复展示的处理；这些不是展示已有 command 的前提，本次不做。

**继续只展示通用参数 JSON。** 数据虽然存在，但没有复用用户熟悉的 Shell 命令展示，保留了后台与前台的不必要差异。

## Consequences

用户能在原 Tool 卡片查看启动命令，但不能据此判断后台任务当前成功、失败或运行中。最终状态和输出仍在任务面板、完成通知及独立读取调用中查看。组件与装配回归覆盖 Start→回执的展开保持、无虚假状态与空输出、启动失败、root/child、普通前台及 `terminal_send` 不变；装配回归的事件用例使用明确标识的构造数据。
