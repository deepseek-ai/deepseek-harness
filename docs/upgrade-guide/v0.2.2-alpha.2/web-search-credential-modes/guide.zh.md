---
kind: upgrade-guide
description: "DeepSeek 网页搜索与获取从 DeepSeek 模型路由取得端点；共享的 baseURL、apiKeyEnv 与 apiKey 字段已移除，改用按能力区分的字段。"
---

# DeepSeek 网页搜索与获取跟随 DeepSeek 模型路由

[English](guide.md) | 中文

## 变更

过去，DeepSeek Search API 与 Fetch API（`web-deepseek-api`）把凭据发往同一个共享的 `baseURL`（默认 `https://api.deepseek.com/v1/tools`）：会话最近一次模型请求使用 `deepseek-account` 路由且用户已登录时发送账号令牌，否则发送 `apiKeyEnv`（默认 `DEEPSEEK_API_KEY`）下的密钥或字面 `apiKey`。现在每个能力沿用相同的路由规则，但端点取自路由：在 `deepseek-account` 上把账号令牌发往账号路由的 origin 加 `/v1/tools`；其他情况（包括未登录的账号会话）把 `deepseek-official` 路由 `apiKeyEnv` 下的密钥发往该路由的 origin 加 `/v1/tools`，因此 `DEEPSEEK_BASE_URL` 现在也会改变 Search 与 Fetch 的端点。没有 `deepseek-official` 路由时，把 `DEEPSEEK_API_KEY` 发往 `https://api.deepseek.com/v1/tools`；已挂载的路由设置无法解析时，操作直接失败。`baseURL`、`apiKeyEnv` 与 `apiKey` 字段已移除；已保存的值可以正常加载，但会被忽略。只要设置 `searchBaseURL` 或 `searchApiKeyEnv` 中的任一项（Fetch 为 `fetchBaseURL` 或 `fetchApiKeyEnv`），就会把该能力固定到其自己的端点（默认 `https://api.deepseek.com/v1/tools`）和密钥（默认 `DEEPSEEK_API_KEY`），且从不发送账号令牌。这些字段只能在 YAML 中设置。没有设置这些 YAML 字段、没有设置 `DEEPSEEK_BASE_URL`、也没有自定义模型基础地址的用户不受影响。

## 迁移

1. 在 `web-deepseek-api` 条目上设置过 `baseURL`、`apiKeyEnv` 或字面 `apiKey` 的用户：对 Search 与 Fetch 分别比较原端点和密钥与路由现在发送的值，即 DeepSeek 模型提供方基础地址的 origin 加 `/v1/tools`，以及该提供方的 `apiKeyEnv`。两者都一致时，删除旧字段。否则把成对字段 `searchBaseURL` 与 `searchApiKeyEnv`（Fetch 为 `fetchBaseURL` 与 `fetchApiKeyEnv`）设为原端点和原密钥引用；即使其中一个原值与路由的值相同，也要两个字段都设置：成对字段中未设置的一项回退到 `https://api.deepseek.com/v1/tools` 或 `DEEPSEEK_API_KEY`，不会继承路由的值。设置过字面 `apiKey` 时，把该值以某个引用存入凭据存储或启动环境，并使用该引用。单独配置的能力从不发送账号令牌。确认：`dsh` 正常启动，且搜索和抓取都到达预期端点，没有凭据错误。
2. 设置了 `DEEPSEEK_BASE_URL` 或为 DeepSeek 模型提供方设置了自定义基础地址、且该主机不提供 `/v1/tools` 的用户：把同一对字段设为 `https://api.deepseek.com/v1/tools` 和该端点接受的密钥引用。确认：搜索返回结果。
