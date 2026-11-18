---
kind: upgrade-guide
description: 自定义 subagent 组合必须更新模型选择配置，并通过主入口注册发现工具。
---

# 更新 subagent 模型选择与控制工具

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-tool-subagent` 将 `modelSelectionSettings` 替换为 `modelSelection`，用于控制可选子级路由字段。发现功能要求每个工具作用域的一个实例设置 `modelDiscovery: true`。两个选项均默认 false。该包不导出 `/list-models` 插件。随附 Web 与 Desktop preset 为 spawn 启用两个选项，并为 fork 保持路由字段关闭；自定义 fork 工具可以启用选择。headless、SDK 和 ACP 的默认工具集保持不变。

Host 的 `/model-selection-settings` 服务在 Agent（智能体）创建时记录授权，包括在委派工具挂载前创建的 Session。子 Session 继承策略，恢复的 Session 保留策略，之后安装工具或编辑设置均不会重新采样已有 Session。没有已记录策略时，发现和显式选择只允许当前父级路由。Host 设置启用但允许模型列表为空时，会拒绝创建所有新的顶层 Session，即使未挂载委派工具；设置界面不允许保存这种组合。

`@deepseek-ai/dsh-tool-subagent-control` 一起注册 `send_message`、`interrupt_agent` 和 `list_agents`，要求 `tools`、`subagents` 和 `agents`。独立的 `/list-agents` 导出已移除。模型发现随配置该选项的委派工具实例存续，与委派提供方无关；卸载该实例会移除发现，即使其他实例仍然存在。`llm` 不可用时，发现调用会失败。

## 迁移

1. 在自定义 `cordis.yml`、patch 或直接插件配置中，将 `modelSelectionSettings: true` 改为 `modelSelection: true`。在每个需要 `list_subagent_models` 的工具作用域中，为一个委派实例设置 `modelDiscovery: true`；同一作用域的多个发现工具所有者会注册失败。
2. 自定义组合需要用户授权其他路由时，在创建 Agent 前将 `@deepseek-ai/dsh-tool-subagent/model-selection-settings` 挂载到 Host，并提供必需的 `sessions` 和 `sessionProjections` 服务。设置启用时，须提供非空的允许模型列表。直接调用 `apply(ctx, config)` 时不再传入 Session 参数。
3. 将 `/list-agents` 配置行替换为每个工具作用域一条 `@deepseek-ai/dsh-tool-subagent-control`，已有该行时则删除它们。移除针对已停用的 `tool-subagent-list-agents` 行的 patch。禁用共享控制行现在会禁用全部三个工具；使用工具限制隐藏单个工具。
4. 创建新 Session，确认所需工具各有一份定义。用户偏好启用时，发现必须返回授权路由，否则仅返回父级路由；显式选择未授权路由的委派必须失败。卸载负责发现的实例，确认其发现工具消失。
