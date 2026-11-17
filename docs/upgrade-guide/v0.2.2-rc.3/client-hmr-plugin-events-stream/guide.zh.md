---
kind: upgrade-guide
description: "`@deepseek-ai/dsh-client-hmr` 删除 `GET /plugins/events` 和 `EVENTS_ENDPOINT`，改用经过鉴权的 `pluginEvents/follow` Remote 流，浏览器插件在 `apply` 中接收同步配置。"
---

# 插件事件流与浏览器同步配置

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-client-hmr` 不再注册匿名 Server-Sent Events 路由 `GET /plugins/events`，也不再导出 `EVENTS_ENDPOINT`。图帧与重建帧改由经过鉴权的 Typert Remote 流 `pluginEvents/follow` 传递：每一代流先发一个包含完整图的 `baseline` 帧，之后发送 `graph` 与 `rebuilt` 帧。帧类型来自 `@deepseek-ai/dsh-client-hmr/types`。浏览器半侧在 `remoteAccess` 允许 `pluginEvents/follow` 时，经 Connection 与 API Gateway Client 半侧打开这条流；它不再读取 `window.__DSH_TRANSPORT__.fetch`，也不再使用 `EventSource`。Remote access 不允许 `pluginEvents/follow` 的 Peer 不再收到实时的图更新与重建更新。live share 观看者被授予了该动作，可以跟随插件图；与所有非 owner Peer 一样，它收到的是各插件的 schema 默认值，而不是实际配置的值。

图的每一行携带该插件的[同步配置](../../../../packages/client/modules/README.zh.md#synced-plugin-configuration)。Client 半侧未导出 `Config` schema 的浏览器插件在 `apply` 中接收一个 `SyncedConfig` 对象，Host 半侧未声明 volatile 字段时该对象为空，此前接收的是 `undefined`。Client 半侧导出自己 `Config` schema 的插件，若其图行同时携带同步值，则激活失败。

受影响者：读取 `/plugins/events` 或导入 `EVENTS_ENDPOINT` 的自定义 shell、脚本和测试；通过 `__DSH_TRANSPORT__.fetch` 提供插件事件传输的 shell；非 owner Peer 未获 `pluginEvents/follow` 授权却需要跟随插件变更的部署；检查 `apply` 配置是否为 `undefined`，或在 Host volatile 字段之外还导出 Client `Config` 的浏览器插件。

## 迁移

1. 把对 `/plugins/events` 的读取和 `EVENTS_ENDPOINT` 的导入替换为挂载 `@deepseek-ai/dsh-client-hmr/remote` 并跟随 `pluginEvents.follow(signal)` 的 Remote 客户端；与 [`src/client/index.ts`](../../../../packages/client/hmr/src/client/index.ts) 一样，把每个 `baseline` 帧视为对之前全部状态的替换。
2. 在自定义 shell 中，经 Connection 与 API Gateway Client 半侧提供 Remote carrier，而不是为该端点提供 `__DSH_TRANSPORT__.fetch` 处理函数。
3. 在每个需要跟随插件变更的 Peer 的 Remote access 策略中授予 `pluginEvents/follow`；没有该权限的 Peer 需重新加载页面才能看到变更。
4. 在浏览器插件中，不再把 `undefined` 的 `apply` 配置当作“没有配置”；通过 `@deepseek-ai/dsh-client-config/types` 中的 `SyncedConfig` 读取字段。
5. 对带有 Host volatile 字段的插件，删除 Client 半侧的 `Config` schema 导出，只在 Host 半侧保留 schema，共享接口放在 `src/types.ts`。
6. 确认：打开 Web 页面，启用或禁用一个插件，检查页面无需重新加载即更新，且浏览器不再发出 `/plugins/events` 请求。
