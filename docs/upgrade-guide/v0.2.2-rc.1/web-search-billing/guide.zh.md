---
kind: upgrade-guide
description: "在其他模型提供方上的会话没有 DeepSeek API 密钥时，DeepSeek 网页搜索与获取改为由已登录的 DeepSeek 账号计费；新增的 searchBilling 与 fetchBilling 设置选择所用凭据。"
---

# DeepSeek 网页搜索与获取按计费方式选择凭据

[English](guide.md) | 中文

## 变更

过去，DeepSeek Search API 与 Fetch API（`web-deepseek-api`）只在 `deepseek-account` 模型提供方上的会话中发送 DeepSeek 账号令牌；其他所有操作都发送 DeepSeek API 密钥，没有密钥时操作失败，模型也看不到 `web_search` 或 `web_fetch`。现在每个能力都有一个计费方式设置 `searchBilling` 和 `fetchBilling`，取值为 `auto`（默认）、`account` 和 `api-key`。在 `auto` 下，`deepseek-account` 和 `deepseek-official` 上的会话行为不变，但在其他模型提供方上的会话或会话之外的操作没有 DeepSeek API 密钥时，现在改由已登录的 DeepSeek 账号计费，而不再失败。`account` 始终只发送账号令牌，`api-key` 始终只发送 API 密钥。设置了 `searchBaseURL`、`searchApiKeyEnv`、`fetchBaseURL` 或 `fetchApiKeyEnv` 的配置忽略计费方式，行为不变。受影响的是在其他模型提供方上对话、已登录但没有 DeepSeek API 密钥的用户；有密钥或未登录的用户不受影响。

## 迁移

1. 要保持原有行为，即在账号会话之外从不由账号计费，就把两个能力都设为 `api-key`：在**插件 > 内置插件配置 > 网页搜索与获取**中，在每个**计费方式**下拉框选择 **DeepSeek API Key**，或在 `web-deepseek-api` 行设置这两个键：

   ```yaml
   - name: '@deepseek-ai/dsh-web-deepseek-api'
     config:
       searchBilling: api-key
       fetchBilling: api-key
   ```

   这样在 `deepseek-account` 上的会话也不再由账号计费。
2. 确认：在其他模型提供方上、没有 DeepSeek API 密钥的会话中，模型不再提供 `web_search` 或 `web_fetch`；配置密钥后搜索成功。
