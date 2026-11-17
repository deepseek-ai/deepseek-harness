---
description: "在插件页显示每个 MCP 连接器插件的 OAuth 服务器账号：`ctx.mcpAccounts` 把账号注册到连接器账号注册表，并把 MCP 管理器的状态和授权映射为其区块；授权、退出登录和重启都在 Host 上执行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-account

[English](README.md) | 中文

## 概述

Linear、Notion 等 MCP 连接器插件通过 `ctx.mcpAccounts` 注册其 OAuth 服务器，在插件页显示账号。本服务把账号注册到[连接器账号注册表](../../client/ui-connector-account/README.zh.md)，并把 [MCP 管理器](../mcp-manager/README.zh.md)对该服务器的视图映射为区块：状态、进行中的授权，以及适用的按钮。连接、取消、退出登录和重试都通过 Host 上的管理器执行。每个连接器只提供点出其服务名称的文案。Web 与桌面端组合通过 [`dsh-web-app`](../../bundle/web-app/README.zh.md) 加载本包。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

连接器的 Host 行在 `ctx.inject` 内向 MCP 管理器注册服务器、向本服务注册账号，因此没有本服务的组合（如 headless profile）加载连接器时不带页面：

```ts ignore-check
import type {} from '@deepseek-ai/dsh-mcp-account'

export function apply(ctx: Context): void {
  ctx.inject(['mcpAccounts'], (scope) => {
    scope.effect(() => scope.mcpAccounts.register({ server: 'acme', packageName: '@acme/connector', copy }), 'acme: Plugins page account')
  })
}
```

- `server` 是连接器向管理器注册的名称；账号在注册表中的键为 `mcp:<server>`。同一服务器或同一插件包的第二个账号会抛出异常。
- `packageName` 是其插件包页面承载区块和标签的 npm 包。
- `copy` 是点出服务名称的 `McpAccountCopy`：区块标题、“连接”按钮文案、开启引导、各状态的说明、退出登录确认，以及连接成功和退出登录的提示。

返回的销毁函数会把账号从所有页面撤下。

### 区块显示什么

| 管理器视图 | 阶段 | 按钮 |
|---|---|---|
| 尚未列出 | 检查中 | 无 |
| 授权在等待浏览器 | 连接中 | 打开授权页面、取消 |
| 授权正在开始、交换或保存授权 | 连接中 | 取消 |
| 已连接 | 已连接 | 重新授权，用于更换账号或工作区，新授权保存前保留原授权；退出登录，需先确认 |
| 正在连接或重新连接 | 连接中 | 无 |
| 因没有授权而等待授权 | 未连接 | 连接；开启引导的“连接”也会发起它 |
| 因授权过期、与设置不再匹配、被拒绝或缺少权限而等待授权 | 未连接，原因写在说明里 | 重新连接 |
| 已关闭 | 不可用 | 重试，即重启服务器 |
| 等待凭据、已停用或失败 | 不可用 | 只有重启能恢复失败时才提供“重试” |

授权失败后，未连接或不可用的区块还会显示授权未完成。每个区块下方的一行说明授权需要在运行 DSH 的这台电脑上的浏览器中完成。连接成功和退出登录会在发起它们的浏览器中显示连接器的提示。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`McpAccounts` 为每个服务器向 `ctx.connectorAccounts` 注册一个来源。来源从 `ctx.mcpManager.list()` 读取该服务器的条目，并在该服务器的每个 `mcp-manager/status` 事件上通知观察者。进行中的授权尝试就是来源的操作，其 id 就是操作的 id，因此发起它的浏览器跟随的是管理器自己的尝试，并打开其授权页。结束的尝试就是结果。`start('connect')` 在管理器创建尝试后返回；`sign-out` 和 `retry` 在管理器退出登录或重启服务器后返回，并记录各自的结果，使提示到达发起它们的浏览器。`cancel` 把 id 交给管理器，管理器会忽略其他尝试。`refresh` 什么也不做，因为管理器会发布每次变化。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `ctx.mcpAccounts` 服务及其注册 |
| [`src/account.ts`](src/account.ts) | 服务器账号来源、区块的 display 及其文案 |
| [`src/locales.ts`](src/locales.ts) | 各连接器共用的 8 种语言文案 |
| [`src/types.ts`](src/types.ts) | 注册和连接器文案类型 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [连接器账号界面](../../client/ui-connector-account/README.zh.md)——渲染账号的注册表和插件页。
- [MCP 管理器](../mcp-manager/README.zh.md)——服务器状态、授权和退出登录。
- [MCP 包分组](../README.zh.md)——相邻的 MCP 包。

-----

<a id="model-experience"></a>
## 模型体验

无，账号属于插件页 UI，不增加模型输入。各连接器和 MCP 客户端自行说明授权开放的工具。

#### KV Cache 影响

无；注册或撤下账号不改变任何模型可见文本。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 需要重新连接的账号显示为未连接，只有其状态和说明能把它与从未连接的账号区分开。
- Host 行加载失败的连接器不显示账号区块；插件页仍会列出该插件包及其加载失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

测试用假的管理器驱动来源和 display，并在真实的连接器账号注册表上注册账号，检查键、路由的操作，以及服务卸载时的撤下。

</details>
