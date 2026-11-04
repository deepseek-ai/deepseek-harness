---
kind: upgrade-guide
description: "DeepSeek web search and fetch bill the signed-in DeepSeek account when a conversation on another model provider has no DeepSeek API key; new searchBilling and fetchBilling settings choose the credential."
---

# DeepSeek web search and fetch choose their credential by billing

English | [中文](guide.zh.md)

## Change

Previously, the DeepSeek Search API and Fetch API (`web-deepseek-api`) sent the DeepSeek account token only in conversations on the `deepseek-account` model provider; every other operation sent the DeepSeek API key, and without a key it failed and the model did not see `web_search` or `web_fetch`. Now each capability has a billing setting, `searchBilling` and `fetchBilling`, with the values `auto` (the default), `account`, and `api-key`. With `auto`, conversations on `deepseek-account` and `deepseek-official` behave as before, but a conversation on another model provider, or an operation outside a conversation, that has no DeepSeek API key now bills the signed-in DeepSeek account instead of failing. `account` always sends only the account token, and `api-key` always sends only the API key. Settings with `searchBaseURL`, `searchApiKeyEnv`, `fetchBaseURL`, or `fetchApiKeyEnv` ignore billing and are unchanged. Signed-in users without a DeepSeek API key who chat on other model providers are affected; users with a key, or without a sign-in, see no change.

## Migration

1. To keep the earlier behavior, which never bills the account outside account conversations, set both capabilities to `api-key`: in **Plugins > Built-in plugin settings > Web search and fetch**, choose **DeepSeek API key** in each **Billing** menu, or set the keys on the `web-deepseek-api` row:

   ```yaml
   - name: '@deepseek-ai/dsh-web-deepseek-api'
     config:
       searchBilling: api-key
       fetchBilling: api-key
   ```

   This also stops account billing in conversations on `deepseek-account`.
2. Confirm: in a conversation on another model provider without a DeepSeek API key, the model no longer offers `web_search` or `web_fetch`, and with a key a search succeeds.
