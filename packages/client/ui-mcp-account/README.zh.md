---
description: "为注册 OAuth MCP 服务器的连接器插件提供插件页面上的账号界面：账号区块、标题标签、开启后的引导与提示；面向连接器作者和维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-mcp-account

[English](README.md) | 中文

## 概述

本包为连接器插件提供 Web 侧栏**插件**页面上的账号界面。连接器的 Host 一侧向 [MCP 管理器](../../mcp/mcp-manager/README.zh.md)注册 OAuth MCP 服务器后，在浏览器一侧调用 `ctx.mcpAccounts.register()`，传入服务器名、自身的 bundle 包名和文案命名空间。本包随后在该 bundle 的详情页显示账号区块，在标题旁显示连接标签，在开启 bundle 后显示引导，并显示连接提示。授权、状态和退出登录都通过管理器的 Remote 完成；页面不另存连接状态。Web 与 Desktop 组合通过 [`dsh-web-app`](../../bundle/web-app/README.zh.md) 挂载本包。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 注册账号

连接器的浏览器一侧注入 `locale` 与 `mcpAccounts`，注册自己的文案，并在自身生命周期内注册账号：

```ts ignore-check
export const inject = ['locale', 'mcpAccounts']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'docs: dictionaries')
  ctx.effect(() => ctx.mcpAccounts.register({ server: 'docs', packageName: '@acme/docs', locale: NS }), 'docs: account')
}
```

`server` 是连接器 Host 一侧向 MCP 管理器注册的名称，`packageName` 是承载区块和标签的 bundle 所属 npm 包。`locale` 指定连接器的文案命名空间；它在 `LocaleNamespaceMap` 中的条目必须恰好是 `McpAccountKey`，所有产品文案都由该文案提供，包括服务名称以及退出登录会删除什么。连接器在 `dsh.client.inject` 中列出 `@deepseek-ai/dsh-client-ui-mcp-account`。返回的释放函数移除这些界面，并关闭该账号的管理器流。包名或服务器名已注册时，注册会抛出错误，且不留下这次注册的任何界面。

### 页面显示什么

| 区块状态 | 操作 |
|---|---|
| 未连接，或授权已过期、与服务器地址或 OAuth 选项不再匹配、被拒绝、缺少权限 | 连接操作发起一次授权尝试 |
| 等待你在浏览器中确认 | 发起尝试的浏览器打开一次授权页面；**打开授权页面**再次打开，**取消**结束这次尝试 |
| 已连接 | **退出登录**确认后删除本地 grant |
| 暂时无法连接 | **重试**重启服务器并保留现有授权；清理未完成时只有重启宿主才能恢复，因此不提供**重试** |

bundle 开启期间，标题旁的标签报告同样的状态。在尚未连接账号时开启 bundle，页面提示连接，点击后打开 bundle 详情页并发起授权。离开页面不会取消授权尝试，尝试由 Host 持有。

### 失败

授权尝试失败时，状态行下方显示提示；页面操作失败时显示 toast，诊断信息留在 Host。管理器流未在传送时，所有操作保持禁用。页面只为本浏览器发起的尝试打开授权 URL，且该 URL 必须使用 HTTPS 或回环地址上的 HTTP。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

`register()` 为每个账号创建一个 `McpAccountConnection`。它镜像管理器的 `watch` 流，只依据该服务器的条目推导显示状态，并只保存流是否在传送、页面操作是否进行中以及最新提示。注册向 `plugins.bundle.config` 与 `plugins.bundle.activation` 贡献以包名为 key 的条目，向 `plugins.detail.badge` 贡献 id 为 `<server>.connection` 的条目，并贡献 id 为 `<server>.connection-toast` 的 `shell.overlay` toast。每个条目都声明连接器的命名空间，由渲染器提供对应的 `t`；四个条目注入同一个 face，共享同一份快照。注册是本插件 fiber 上的一个 effect：初始化失败时释放已添加的部分；释放时先移除插槽条目，再关闭流，无论先执行的是连接器的释放函数还是本插件的卸载。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [MCP 管理器](../../mcp/mcp-manager/README.zh.md#oauth-authorization) — 页面背后的 `watch`、`startAuthorization`、`cancelAuthorization`、`signOut` 与 `restart` 操作。
- [插件页面](../ui-plugin-manager/README.zh.md#use-this-package) — 本包注册所用的 bundle 详情页插槽。
- [MCP 子系统](../../../docs/subsystems/mcp.zh.md) — MCP 各包如何协作。
- [Client 包地图](../README.zh.md) — 相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

无。账号界面是浏览器 UI，不增加任何模型输入。连接器的命名引导与服务器工具由连接器和 [MCP 客户端](../../mcp/mcp-client/README.zh.md#model-experience)说明。

#### KV Cache 影响

无；注册或移除账号不改变任何模型可见文本。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 区块只在连接器插件开启期间存在。关闭插件后要退出登录，需要重新开启插件，或删除 grant 记录。
- 授权回调地址是 Host 上的 `http://127.0.0.1:<port>`，因此完成授权的浏览器必须运行在 Host 所在机器上。
- 每个账号各自打开一条管理器流。
- Host 上每个服务器只使用一份 grant；没有账号选择器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

客户端测试用模拟的管理器流驱动 `McpAccountConnection`，用回显 key 的翻译函数渲染四个组件，并在真实的插槽注册表上注册账号。

</details>
