---
kind: upgrade-guide
description: "DeepSeek Search and Fetch add per-capability billing and replace provider authentication fields with ordered credential sources."
---

# DeepSeek web search and fetch choose their credential by billing

English | [中文](guide.zh.md)

## Change

The DeepSeek Search and Fetch APIs (`web-deepseek-api`) previously used the signed-in account only in `deepseek-account` conversations; other conversations required an API key. New `searchBilling` and `fetchBilling` settings accept `auto` (default), `account`, or `api-key`. With `auto`, DeepSeek model routes behave as before; other conversations and operations outside a Session now use the signed-in account when no key exists. `account` uses only the account; `api-key` only the key. Non-empty `*BaseURL` or `*ApiKeyEnv` settings still take precedence. Other providers, including local HTTP fetch, are unaffected.

In TypeScript, `DeepSeekSearchApiOptions` and `DeepSeekFetchApiOptions` lose their top-level `baseURL`. Their `auth` becomes `{ sources, missingCredentialMessage? }`. Each account or API-key source carries its own address; list order replaces the implicit account-first order. Direct provider constructors must migrate.

With an `AbortSignal`, credential-read errors now retain the original `Error` as `cause` and its name in the diagnostic without an extra `Error:` wrapper. A resolver throwing a DOMException named `AbortError` now yields `WEB_ABORTED`, not `WEB_PROVIDER_ERROR`, even when that signal is not aborted. The no-signal path already behaves this way.

## Migration

1. To disable the new account fallback, set both capabilities to `api-key` on the `web-deepseek-api` row, or choose **DeepSeek API key** under **Plugins > Built-in plugin settings > Web search and fetch** when each DeepSeek API is selected:

   ```yaml
   - name: '@deepseek-ai/dsh-web-deepseek-api'
     config:
       searchBilling: api-key
       fetchBilling: api-key
   ```

   This also disables account billing in account conversations; it does not fully restore the old route-dependent behavior.
2. Migrate direct `DeepSeekSearchApiProvider` and `DeepSeekFetchApiProvider` constructors. The table describes TypeScript options, not YAML settings:

   | Old option | Replacement |
   |---|---|
   | `baseURL: base`, `auth.apiKey: key` | `auth.sources: [{ kind: 'api-key', baseURL: base, key }]` |
   | `auth.resolveApiKey`, `auth.apiKeyEnv` | An API-key source with `key: { ref, configured, resolve }`. Keep the reference (`DEEPSEEK_API_KEY` when omitted); `configured()` checks presence without reading the value, and `resolve()` reads it. |
   | `auth.account` | `{ kind: 'account', ...account }`; preserve its address and callbacks. Place it before the Key source to retain account-first behavior. |
   | `auth.missingKeyMessage` | `auth.missingCredentialMessage` |
   | `auth.invalidRoute` | `{ kind: 'misconfigured', message }` at the position of the invalid source; it fails only when reached. |

3. Update error handling to recognize resolver `AbortError` as cancellation. Do not depend on the extra error wrapper or its diagnostic prefix.
4. Confirm migrated constructors type-check. With the DeepSeek APIs selected and `api-key` billing, missing keys withhold their tools; configured keys allow requests. Local HTTP fetch remains unaffected.
