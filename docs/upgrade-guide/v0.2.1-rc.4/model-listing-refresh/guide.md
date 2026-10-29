---
kind: upgrade-guide
description: "DeepSeek model listings refresh automatically after first use, and custom listing-cache owners must supply live settings and change notifications."
---
# Model listings refresh automatically

English | [中文](guide.zh.md)

## Change

DeepSeek account and API-key routes refresh their model listing automatically after first use, including while idle. `modelsMaxAgeMs` keeps its ten-minute default and now schedules background requests instead of waiting for another access. Failed refreshes retain the last successful listing, including badges. Successful refreshes replace badge metadata, including omission or `null`, and notify open Web selectors.

`ModelListingCache` consumers must supply `settings` and `changed` callbacks. Its `dispose()` now returns a promise that settles after active loads and automatic credential lookups finish. `ListedCatalog` also requires a `badges` map, and `ModelSelectInjected` requires a `resolveText` callback.

## Migration

1. Keep existing `modelsMaxAgeMs` values to use the same interval for automatic refresh. Use `0` only when each access should refresh and no automatic timer should run.
2. Custom `ModelListingCache` owners must provide `settings: () => ListingSettings | undefined` for the latest route configuration and `changed: () => void` to notify catalog consumers. Return `undefined` from `settings` when the route stops following a listing.
3. Return or await `cache.dispose()` from the owning plugin's cleanup.
4. Code that constructs `ListedCatalog` must include `badges: new Map()` when it has no badges, or a map from model id to `LlmModelBadge`. Prefer `resolveListedCatalog` to construct this result from decoded listing entries.
5. Code that constructs `ModelSelectInjected` must provide `resolveText: text => ctx.locale.resolveText(text)` from its owning locale service. Test doubles can use `text => typeof text === 'string' ? text : text.en` when they intentionally render English.
6. After the next refresh, confirm that an already-open model selector displays the current badge without reloading the page. Remove the badge field or set it to `null` to clear it.
