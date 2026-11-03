---
kind: upgrade-guide
description: "DeepSeek web search and fetch take their endpoint from the DeepSeek model route; the shared baseURL, apiKeyEnv, and apiKey fields are removed in favor of per-capability fields."
---

# DeepSeek web search and fetch follow the DeepSeek model route

English | [中文](guide.zh.md)

## Change

Previously, the DeepSeek Search API and Fetch API (`web-deepseek-api`) sent their credential to one shared `baseURL` (default `https://api.deepseek.com/v1/tools`): the account token when the Session's latest model request used the `deepseek-account` route and the user was signed in, otherwise the key under `apiKeyEnv` (default `DEEPSEEK_API_KEY`) or a literal `apiKey`. Now each capability follows the same route rule but takes the endpoint from the route: on `deepseek-account` the account token goes to the account route's origin with `/v1/tools`; otherwise, including a signed-out account conversation, the key under the `apiKeyEnv` of the `deepseek-official` route goes to that route's origin with `/v1/tools`, so `DEEPSEEK_BASE_URL` now moves Search and Fetch too. Without a `deepseek-official` route, `DEEPSEEK_API_KEY` goes to `https://api.deepseek.com/v1/tools`; a mounted route whose settings do not resolve fails the operation instead. The `baseURL`, `apiKeyEnv`, and `apiKey` fields are removed; stored values load without error and are ignored. Setting either `searchBaseURL` or `searchApiKeyEnv` (`fetchBaseURL` or `fetchApiKeyEnv` for Fetch) pins that capability to its own endpoint (default `https://api.deepseek.com/v1/tools`) and key (default `DEEPSEEK_API_KEY`) and never sends the account token. These fields are YAML-only. Users without those YAML fields, without `DEEPSEEK_BASE_URL`, and without a custom model base URL see no change.

## Migration

1. Users who set `baseURL`, `apiKeyEnv`, or a literal `apiKey` on the `web-deepseek-api` row: for each of Search and Fetch, compare the old endpoint and key with what the route now sends, the origin of the DeepSeek model provider's base URL with `/v1/tools` and that provider's `apiKeyEnv`. When both match, remove the old fields. Otherwise set the pair, `searchBaseURL` with `searchApiKeyEnv` (`fetchBaseURL` with `fetchApiKeyEnv`), to the old endpoint and key reference, setting both fields even when one old value equals the route's: an unset field of the pair falls back to `https://api.deepseek.com/v1/tools` or `DEEPSEEK_API_KEY`, never to the route's value. For a literal `apiKey`, store it in the credential store or the launching environment under a reference and use that reference. A pinned capability never sends the account token. Confirm: `dsh` starts, and a search and a fetch reach the intended endpoint without a credential error.
2. Users with `DEEPSEEK_BASE_URL` or a custom base URL on the DeepSeek model provider whose host does not serve `/v1/tools`: set the same pair to `https://api.deepseek.com/v1/tools` and the reference of a key that endpoint accepts. Confirm: a search returns results.
