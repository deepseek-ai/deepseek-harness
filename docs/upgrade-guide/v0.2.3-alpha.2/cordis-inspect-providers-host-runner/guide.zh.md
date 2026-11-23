---
kind: upgrade-guide
description: "@deepseek-ai/dsh-tool-cordis/host 插件入口被移除，改由 cordis-host-runner 注册 Host 检查提供方。"
---

# Host 检查提供方移入 `cordis-host-runner`

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-tool-cordis/host` 已不存在。`@deepseek-ai/dsh-cordis-host-runner` 挂载时直接注册 Host 检查提供方（`Service`、`Event`、`Config`、`Runtime` 和 `Tool`），组合中不再需要单独的提供方行。每个 agent preset 中的 `@deepseek-ai/dsh-tool-cordis` 行仍负责注册 `cordis_inspect`。随附的 profile 已经更新。升级后，自定义 `cordis.yml`、patch 或 overlay 中名为 `@deepseek-ai/dsh-tool-cordis/host` 的行无法加载，导入该子路径的代码也无法解析。

## 迁移

1. 删除所有 `name` 为 `@deepseek-ai/dsh-tool-cordis/host` 的 Loader 行，通常带有 `id: cordis-inspect-providers`。保留宿主组合中的 `@deepseek-ai/dsh-cordis-host-runner` 行。
2. 删除对 `@deepseek-ai/dsh-tool-cordis/host` 的导入；挂载 `@deepseek-ai/dsh-cordis-host-runner` 即可注册相同的提供方。
3. 不带 `query` 调用 `cordis_inspect`，确认列出的 Host 提供方为 `Service`、`Event`、`Config`、`Runtime` 和 `Tool`。
