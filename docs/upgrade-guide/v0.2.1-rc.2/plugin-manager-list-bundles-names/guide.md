---
kind: upgrade-guide
description: "Client Remote calls to pluginManager.listBundles must pass the new optional names argument."
---

# `pluginManager.listBundles` takes an optional `names` argument

English | [中文](guide.zh.md)

## Change

[`listBundles`](../../../../packages/boot/plugin-manager/src/index.ts) now declares `names?: readonly string[]`. Passing package names reads only those bundles; passing `undefined` reads every bundle, as before. The Remote gateway requires every declared argument, so a Client call without arguments now fails with `client api: pluginManager/listBundles expected 1 argument(s), got 0`. This affects Client plugins that call `ctx.remote.pluginManager.listBundles()`. Host code calling `ctx.pluginManager.listBundles()` directly is unaffected.

## Migration

1. In Client code, replace `ctx.remote.pluginManager.listBundles()` with `ctx.remote.pluginManager.listBundles(undefined)` to keep reading every bundle.
2. To read specific bundles, pass their package names instead, for example `listBundles(['@acme/plugin'])`. A name the listing would not include is omitted from the result.
3. Confirm the call resolves with `ok: true` and returns the expected bundles.
