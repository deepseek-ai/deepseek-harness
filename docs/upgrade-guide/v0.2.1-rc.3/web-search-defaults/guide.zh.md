---
kind: upgrade-guide
description: "一次 web_search 调用默认接受 10 个查询并返回 10 个来源，DeepSeek Search API 提供方会为请求限速。"
---

# Web 搜索默认值

[English](guide.md) | 中文

## 变更

在 `dsh-tool-web` 中，`searchMaxQueries` 默认值从 4 提高到 10，`searchMaxResults` 默认值从 8 提高到 10。`web_search` 的 schema 现在公布 `1–10 search queries`，因此含 5–10 个查询的调用会执行，而不是校验失败；每次调用最多返回 10 个来源。因此一次调用可能发起更多提供方搜索，并向上下文加入更多来源文本。使用内置的 Messages 搜索提供方时，每个查询都是一次辅助模型请求。`dsh-web-deepseek-api` 新增 `searchRequestsPerSecond`，默认 5：其 Search 提供方在任意一秒窗口内最多发送这么多请求，因此 10 个查询的调用中后五个查询比前五个晚一秒开始，而不会超过账号的 5 QPS 限制。部署已设置的值保持不变。

## 迁移

1. 如需保留原上限，在 `cordis.patch.yml` 的 `tool-web` 条目 `config` 中设置 `searchMaxQueries: 4` 和 `searchMaxResults: 8`。
2. 如果多个进程通过 Search API 共享同一个 DeepSeek 账号，在 `web-deepseek-api` 条目中调低 `searchRequestsPerSecond`，使它们的合计速率不超过 5。
3. 运行一个在一次 `web_search` 调用中发送 10 个查询的任务来确认：调用返回结果，而不是 `Error: queries must contain at most 4 queries`。参见 [tool-web 配置](../../../../packages/web/tool-web/README.zh.md)。
