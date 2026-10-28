---
kind: upgrade-guide
description: "DeepSeek 模型列表首次使用后自动刷新，自定义列表缓存的持有者必须提供实时配置与变化通知。"
---
# 模型列表自动刷新

[English](guide.md) | 中文

## 变更

DeepSeek 账号与 API key 路由首次使用模型列表后会自动刷新，空闲时也会刷新。`modelsMaxAgeMs` 保留十分钟默认值，现在会安排后台请求，无需等待下一次访问。刷新失败时保留上次成功加载的列表及其角标。刷新成功时替换角标元数据，省略或 `null` 也会生效，并通知已打开的 Web 选择器。

`ModelListingCache` 的消费方必须提供 `settings` 与 `changed` 回调。其 `dispose()` 现在返回一个 promise，等待进行中的加载与自动凭据查询结束后才完成。`ListedCatalog` 还要求提供 `badges` 映射，`ModelSelectInjected` 要求提供 `resolveText` 回调。

## 迁移

1. 保留现有 `modelsMaxAgeMs` 值即可按相同间隔自动刷新。只有需要每次访问都刷新、且不运行自动定时器时，才使用 `0`。
2. 自定义 `ModelListingCache` 持有者必须提供 `settings: () => ListingSettings | undefined` 以读取最新路由配置，并通过 `changed: () => void` 通知目录消费方。路由停止跟随列表时，`settings` 返回 `undefined`。
3. 在持有该缓存的插件清理函数中返回或等待 `cache.dispose()`。
4. 构造 `ListedCatalog` 的代码在没有角标时必须提供 `badges: new Map()`，否则提供模型 id 到 `LlmModelBadge` 的映射。优先使用 `resolveListedCatalog` 从已解码的列表条目构造该结果。
5. 构造 `ModelSelectInjected` 的代码必须通过所属的 locale 服务提供 `resolveText: text => ctx.locale.resolveText(text)`。明确使用英语渲染的测试替身可以使用 `text => typeof text === 'string' ? text : text.en`。
6. 下一次刷新后，确认已打开的模型选择器无需重新加载页面就显示当前角标。移除角标字段或将其设为 `null` 即可清除角标。
