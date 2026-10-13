---
kind: upgrade-guide
description: "Subagent 的 persona 与 toolFilter 配置由 Agent Preset 组装替代。"
---

# 通过 preset 配置子 Agent 组装

[English](guide.md) | 中文

## 变更

`dsh-tool-subagent` 拒绝 `persona` 与 `toolFilter` 配置。新的 `SubagentStartRequest` 和提供方能力声明也不再暴露这两个字段。进程内 spawn 通过 `agentPreset` 选择 preset，其 persona 与工具来自该 preset 的插件。fork 继承父方 preset，不能独立改变 persona 或限制工具。模型与推理强度选项保持不变。

出货的 `standard`、`ptc` 和 `cordis` 委派工具不再隐藏 `schedule_*` 工具。委派调用方仍会收到已有的执行拒绝。历史子 Session 的 descriptor 在恢复时仍应用其 persona 与工具限制。

## 迁移

1. 从 profile patch 和自定义 preset 的 `dsh-tool-subagent` 行中移除 `persona` 与 `toolFilter`。同步从程序化调用方和提供方能力声明中移除这两个字段。
2. 对于 spawn，定义包含 `dsh-persona` 和所需工具插件的 Agent Preset，再将委派工具的 `agentPreset` 设为其 id。使用 `allowedAgentPresets` 向父模型开放多个已声明 preset。preset 选择插件组合，不提供替代的逐子级工具名过滤器。
3. 对于 fork，移除覆盖并接受继承的组合。如果任务需要不同组合，使用带 preset 的 spawn；它不继承父方对话。
4. 启动新 Session 并委派任务，确认子级使用所选 preset 的 persona 与工具。已有持久化子 Session 无须手动修改。
