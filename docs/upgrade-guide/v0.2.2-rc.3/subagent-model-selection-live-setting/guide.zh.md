---
kind: upgrade-guide
description: "Subagent 模型选择在每次调用时读取当前 Host 设置，不再使用每个 Session 记录的策略。"
---

# 从当前设置读取 subagent 模型选择

[English](guide.md) | 中文

## 变更

Host 的 `@deepseek-ai/dsh-tool-subagent/model-selection-settings` 服务在创建 Agent（智能体）时不再追加 `subagent/model-selection-policy`。允许模型选择的 `subagent` 工具在显式选择路由时读取 `ctx.subagentModelSelection.allowedRoutes()`，`list_subagent_models` 在每次调用时读取它，因此设置编辑会对所有运行中、已恢复和子 Session 的下一次调用生效。设置关闭或服务未挂载时，显式选择只允许当前父级路由。早期版本中记录过策略的 Session 会忽略该策略，改用当前设置。

启用但路由列表为空、格式无效或重复的设置不再使 Agent 创建失败；读取它的显式选择和发现调用会抛出错误码为 `INVALID_MODEL_SELECTION_SETTINGS` 的 `SubagentError`。普通委派和关闭模型选择的工具不读取路由列表。Host 设置关闭时会在读取或校验列表之前返回。该服务不再注入 `sessions` 或 `sessionProjections`，`@deepseek-ai/dsh-tool-subagent` 也不再注入 `sessionProjections`。已移除 `subagentModelSelectionProjectionDefinition`、`subagentModelSelectionPolicy` 和 `SubagentModelSelectionSettings` 导出。

## 迁移

1. 将读取 `subagentModelSelectionPolicy` 投影或 `subagent/model-selection-policy` 事件的代码替换为 `ctx.subagentModelSelection.allowedRoutes()`；它返回已授权路由，选择关闭时返回 `undefined`。
2. 如果已有 Session 需要保留早期的允许列表，在 `subagent-model-selection-settings` 命名空间中设置该列表；已记录的事件不再生效。
3. 确认变更：在已打开的 Session 中启用设置并配置一条路由，然后不带参数调用 `list_subagent_models`，确认它列出该路由的提供方。关闭设置后，确认显式委派到该路由会以 `MODEL_ROUTE_NOT_ALLOWED` 失败。
