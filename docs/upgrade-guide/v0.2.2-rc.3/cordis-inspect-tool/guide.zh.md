---
kind: upgrade-guide
description: "cordis_inspect 工具替代 cordis_inspect_list 和 cordis_inspect_query。"
---

# 使用单个 Cordis 检查工具

[English](guide.md) | 中文

## 变更

`cordis_inspect` 替代 `cordis_inspect_list` 和 `cordis_inspect_query`。引用任一旧工具名称的自定义提示词、skill（技能）和工具调用方必须使用新名称及参数。省略 `query` 时返回 provider 目录；提供 `query` 时选择 provider 方法。

## 迁移

1. 将 `cordis_inspect_list({})` 调用替换为 `cordis_inspect({})`。
2. 将 `cordis_inspect_query({ platform, provider, method, input })` 调用替换为 `cordis_inspect({ query: { platform, provider, method, input } })`。将 `platform`、`provider` 和 `method` 放在 `query` 内；`input` 仍为可选参数。
3. 确认 `cordis_inspect({})` 返回 provider 目录。从该目录中选择 provider 和方法，在 `query.input` 下提供符合其输入 schema 的参数，并确认查询返回所请求的数据。Client 查询需要已连接的页面。
