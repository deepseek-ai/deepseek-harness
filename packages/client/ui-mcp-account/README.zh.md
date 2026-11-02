---
description: "通过 `ctx.mcpAccounts` 在 Host 上注册 MCP 连接器的 OAuth 账号，并经由一个 `mcpAccounts` Remote 在插件页面显示其账号区块、标题标签、开启后的引导、退出登录确认与提示，文案来自连接器自己的文本和本包的共用文案。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-mcp-account

[English](README.md) | 中文

## 概述

向 [MCP 管理器](../../mcp/mcp-manager/README.zh.md)注册 OAuth MCP 服务器的连接器插件，在 Host 上通过 `ctx.mcpAccounts` 注册账号，使其显示在 Web 侧栏的**插件**页面上。注册表通过一个 `mcpAccounts` Remote 提供所有账号，并附上管理器对各自服务器的视图。浏览器一侧渲染每个账号的区块、标题标签、开启后的引导和提示，并通过管理器的 Remote 完成授权、取消、退出登录和重试。连接器以 `LocalizedText` 提供指明其服务的文案；共用文案来自本包的字典。Web 与 Desktop 组合通过 [`dsh-web-app`](../../bundle/web-app/README.zh.md) 加载这两侧。

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

连接器的 Host 行注册一次账号；连接器不为账号提供任何浏览器代码。

### 注册账号

连接器的 Host 行在注册表运行时注册账号，因此没有注册表的组合（如 headless profile）会跳过注册：

```ts ignore-check
import type {} from '@deepseek-ai/dsh-client-ui-mcp-account'

export function apply(ctx: Context): void {
  ctx.inject(['mcpAccounts'], (scope) => {
    scope.effect(() => scope.mcpAccounts.register({ server: 'docs', packageName: '@acme/docs', copy }), 'docs: Plugins page account')
  })
}
```

`server` 是连接器向 MCP 管理器注册的名称，`packageName` 是承载区块和标签的 bundle 所属 npm 包；同一个包或服务器的第二次注册会抛出错误。`copy` 包含所有指明该服务的文案：区块标题、连接按钮文字、开启后的引导、各状态的说明行、包含退出登录会删除什么的退出确认，以及连接成功与退出登录的提示。每条文案都是 `LocalizedText`，由各浏览器按当前语言解析。连接器用 `import type` 引入注册表的类型。返回的释放函数从所有页面撤下该账号。

### 页面显示什么

| 区块状态 | 操作 |
|---|---|
| 未连接，或授权已过期、与服务器地址或 OAuth 选项不再匹配、被拒绝、缺少权限 | 连接操作发起一次授权尝试 |
| 等待你在浏览器中确认 | 发起尝试的浏览器打开一次授权页面；**打开授权页面**再次打开，**取消**结束这次尝试 |
| 已连接 | **退出登录**确认后删除本地 grant |
| 暂时无法连接 | **重试**重启服务器并保留现有授权；清理未完成时只有重启宿主才能恢复，因此不提供**重试** |

bundle 开启期间，标题旁的标签报告同样的状态。在尚未连接账号时开启 bundle，页面提示连接，点击后打开 bundle 详情页并发起授权。离开页面不会取消授权尝试，尝试由 Host 持有。

### 跟随授权尝试

每个浏览器在 Web 应用加载时打开一条流。发起尝试的浏览器把授权页面打开一次，且只在 URL 使用 HTTPS 或回环地址上的 HTTP 时打开，并报告连接结果；其他浏览器显示同样的区块，但不打开页面，也不报告提示。Host 撤下账号时，本浏览器放弃所跟随的尝试。操作未完成时的点击会被忽略。

### 失败

授权尝试失败时，状态行下方显示提示；页面操作失败时显示 toast，诊断信息留在 Host。流未在传送时，所有操作保持禁用。

### 共用文案

`mcpAccount` 字典包含所有账号共用的文案：状态行和标签、授权过期、不再匹配与暂时无法连接的说明、授权需在 Host 所在电脑上完成的提示、失败提示与失败 toast，以及各操作的文字。其余文案都来自连接器。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

Host 一侧的 `McpAccounts` 是注入 MCP 管理器的 Remote 服务。`register()` 保存账号，每条 `watch` 流跟随管理器自己的 `watch` 流：管理器列出服务器后，在任一方每次变化后产出所有账号及其服务器的视图，并合并在下一次读取前到达的变化。管理器的流失败时它重新抛出该错误，管理器的流结束时它随之结束。

浏览器一侧挂载 `mcpAccounts` Remote，并通过 `McpAccountsConnection` 打开一条 `watch` 流，为每个账号保存一个快照 store：Host 条目、流是否在传送、本浏览器发起的操作是否未完成，以及最新提示。它的操作以账号的服务器调用管理器的 `startAuthorization`、`cancelAuthorization`、`signOut` 与 `restart`。对 Host 报告的每个账号，它注册以包名为 key 的 `plugins.bundle.config` 与 `plugins.bundle.activation`、id 为 `<server>.connection` 的 `plugins.detail.badge` 条目，以及 id 为 `<server>.connection-toast` 的 `shell.overlay` toast，全部使用 `mcpAccount` 命名空间并注入同一个 face。Host 撤下的账号会失去这四个条目；卸载时先撤下条目和流，再撤下 Remote。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `ctx.mcpAccounts` 注册表及其 Remote |
| [`src/types.ts`](src/types.ts) | 注册、文案和流条目类型 |
| [`src/client/index.ts`](src/client/index.ts) | 绑定生成的 Remote 的浏览器入口 |
| [`src/client/mount.ts`](src/client/mount.ts) | Remote 挂载、字典，以及每个账号的插槽注册 |
| [`src/client/connection.ts`](src/client/connection.ts) | 显示状态推导、流的镜像、授权页面打开、提示和未完成操作保护 |
| [`src/client/McpAccount.tsx`](src/client/McpAccount.tsx) | 四个界面 |
| [`src/client/locales.ts`](src/client/locales.ts) | 共用字典 |
| [`src/client/types.ts`](src/client/types.ts) | 快照、提示和 face 类型 |

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

无。注册表及其界面属于插件页面 UI，不增加任何模型输入。连接器的命名引导与服务器工具由连接器和 [MCP 客户端](../../mcp/mcp-client/README.zh.md#model-experience)说明。

#### KV Cache 影响

无；注册或移除账号不改变任何模型可见文本。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 区块只在连接器插件开启期间存在。关闭插件后要退出登录，需要重新开启插件，或删除 grant 记录。
- Host 行加载失败的连接器不显示账号区块；插件页面仍列出该 bundle 及其加载失败。
- 授权回调地址是 Host Web 服务器自身的源地址，因此完成授权的浏览器必须直接访问该服务器，不能经过代理或 Web 应用的 `publicUrl`。
- Host 上每个服务器只使用一份 grant；没有账号选择器。
- 无论是否安装了连接器，Web 与 Desktop 组合都会加载注册表。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

Host 测试用模拟的管理器流驱动注册表。客户端测试用模拟的 Remote 流驱动 `McpAccountsConnection`，用回显 key 的翻译函数和中文的连接器文案渲染各界面，并在真实的插槽注册表和 locale 运行时上挂载浏览器一侧。源码覆盖率排除 `src/client/index.ts`，因为它引入只存在于 `lib/` 中的生成 Remote。

</details>
