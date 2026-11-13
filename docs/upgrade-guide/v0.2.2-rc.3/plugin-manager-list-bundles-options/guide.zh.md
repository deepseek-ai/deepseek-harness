---
kind: upgrade-guide
description: "Client 对 pluginManager.listBundles 的 Remote 调用必须传入新增的可选参数 options。"
---

# `pluginManager.listBundles` 新增可选参数 `options`

[English](guide.md) | 中文

## 变更

[`listBundles`](../../../../packages/boot/plugin-manager/src/index.ts) 现在声明 `options?: ListBundlesOptions`。其中的 `names` 字段只读取指定的组合包；不提供 `names` 时与之前一样读取全部组合包。Remote gateway 要求传入每个声明的参数，因此不带参数的 Client 调用会失败，报错为 `client api: pluginManager/listBundles expected 1 argument(s), got 0`。受影响的是调用 `ctx.remote.pluginManager.listBundles()` 的 Client 插件；直接调用 `ctx.pluginManager.listBundles()` 的 Host 代码不受影响。

## 迁移

1. 在 Client 代码中把 `ctx.remote.pluginManager.listBundles()` 改为 `ctx.remote.pluginManager.listBundles({})`，以继续读取全部组合包。
2. 只读取指定组合包时改为传入包名，例如 `listBundles({ names: ['@acme/plugin'] })`。列表本身不会包含的名称不出现在结果中。
3. 确认调用以 `ok: true` 返回，且结果包含预期的组合包。
