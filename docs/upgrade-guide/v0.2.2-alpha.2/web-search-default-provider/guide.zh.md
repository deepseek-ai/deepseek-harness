---
kind: upgrade-guide
description: "交付的 Search 默认值从旧版 Messages 搜索改为 DeepSeek Search API，可选的 Exa 与 Perplexity 搜索包已移除。"
---

# Search 默认使用 DeepSeek Search API；Exa 与 Perplexity 已移除

[English](guide.md) | 中文

## 变更

过去，共享的基础组合把 `web.searchProvider` 设为 `deepseek-official`：每次搜索都是发往 `web-search-deepseek` 端点的一次辅助 Messages 请求，以 `Perform a web search for the query: <query>` 调用带服务端 `web_search` 工具的 `deepseek-v4-flash`，按模型 token 计费。现在它设为 `deepseek-search-api`：每次搜索是一次直接发往 DeepSeek Search API 的请求，不调用模型，可能产生 Search API 费用而非模型 token 费用。该请求发送 `query`、`count`、`need_content: false`，并且除非 `web-deepseek-api.sendOriginalQuestion` 为 `false`，还会把用户最近一条提示截取前 128 个字符作为 `ori_question` 发送。其凭据和端点跟随 [DeepSeek 模型路由](../web-search-credential-modes/guide.zh.md)。自行设置了 `web.searchProvider` 的组合不受影响，Fetch 仍默认为 `http`。

可选包 `@deepseek-ai/dsh-web-search-exa`（提供方 `exa`）与 `@deepseek-ai/dsh-web-search-perplexity`（提供方 `perplexity`）已移除。指名任一包的条目不再能加载，`searchProvider: exa` 或 `searchProvider: perplexity` 也不再对应任何提供方。

## 迁移

1. 要继续使用旧版 Messages 搜索，在 `@deepseek-ai/dsh-web` 条目的 `config` 中设置 `searchProvider: deepseek-official`，或在「网页搜索与获取」设置页的「网页搜索提供方」菜单中选择 DeepSeek（旧版）。确认：该菜单显示 DeepSeek（旧版），且每次搜索都会向会话日志追加一个 `web/deepseek-search-llm-request` 事件。
2. 挂载过 Exa 或 Perplexity 的部署：从 `cordis.yml` 或 profile 补丁中删除 `@deepseek-ai/dsh-web-search-exa` 或 `@deepseek-ai/dsh-web-search-perplexity` 条目；若 `EXA_API_KEY` 或 `PERPLEXITY_API_KEY` 不再被其他地方使用，一并移除；再把 `searchProvider` 设为 `deepseek-search-api` 或 `deepseek-official`，或删除该字段以采用默认值。确认：`dsh` 启动时没有这两个包的加载错误，「网页搜索提供方」菜单显示所选提供方，且搜索返回结果。
