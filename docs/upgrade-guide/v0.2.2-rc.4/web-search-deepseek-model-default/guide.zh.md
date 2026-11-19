---
kind: upgrade-guide
description: "交付的组合不再固定搜索提供方，因此使用 DeepSeek 模型的会话中，网页搜索改用旧版 Messages 搜索而不是 DeepSeek Search API。"
---

# DeepSeek 模型上的搜索默认使用旧版 Messages 搜索

[English](guide.md) | 中文

## 变更

过去，共享的基础组合把 `web.searchProvider` 设为 `deepseek-search-api`，因此每次搜索都是一次 DeepSeek Search API 请求。现在基础组合不设置 `searchProvider`，由 `dsh-web` 按模型提供方路由选择。为 `deepseek-official` 或 `deepseek-account` 路由上的模型请求发起的搜索使用 `deepseek-official` 搜索提供方：它向 `web-search-deepseek` 的端点发送一次辅助 Messages 请求，不按次收费，按模型 token 计费，并向会话日志追加一个 `web/deepseek-search-llm-request` 事件。其他路由上的搜索，以及不服务于模型请求的搜索，仍使用 `deepseek-search-api`。

Messages 搜索的端点不跟随模型提供方的基础地址：它是 `web-search-deepseek.baseURL`，其次是 `$DEEPSEEK_SEARCH_BASE_URL`，再次是 `https://api.deepseek.com/anthropic/v1`；在账号会话之外，它收到的是 `web-search-deepseek.apiKeyEnv`（默认 `DEEPSEEK_API_KEY`）下的密钥。因此，DeepSeek 模型提供方指向网关的部署会把该密钥发往官方端点，搜索会失败，直到执行第 2 步或第 3 步。

「网页搜索与获取」设置页的「网页搜索提供方」菜单新增**自动选择**，没有已存选择时即选中它。自行设置了 `web.searchProvider` 的组合或 profile，以及 `DSH_WEB_SEARCH_PROVIDER`，不受影响。Fetch 仍默认为 `http`。

## 迁移

1. 接受新的默认值时无需修改。确认：「网页搜索提供方」菜单显示「自动选择」，且使用 DeepSeek 模型的会话中的搜索会追加一个 `web/deepseek-search-llm-request` 事件。
2. 要让所有模型继续使用 DeepSeek Search API，在该菜单中选择 DeepSeek Search API 并保存，或在 `@deepseek-ai/dsh-web` 条目的 `config` 中把 `searchProvider: deepseek-search-api` 与 `fetchProvider: http` 一起设置。确认：菜单显示 DeepSeek Search API，且搜索不再追加 `web/deepseek-search-llm-request` 事件。
3. 要通过网关使用 Messages 搜索，在该菜单中选择 DeepSeek 服务端搜索，把网关的 Anthropic 兼容基础地址（到 `/messages` 之前为止）作为其 Base URL 保存，或设置 `web-search-deepseek.baseURL`；如果其他模型应继续使用 Search API，再重新选择「自动选择」。确认：DeepSeek 模型上的搜索返回结果，且其 `web/deepseek-search-llm-request` 事件指向网关端点。
