---
description: "通过 `ctx.connectorAccounts` 在 Host 上注册连接器插件的账号，并经由一个 `connectorAccounts` Remote 在插件页显示其区块、标题旁标签、开启引导、确认和提示，文案来自注册方自己的文本和本包的共用文案。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-connector-account

[English](README.md) | 中文

## 概述

连接器插件在 Host 上通过 `ctx.connectorAccounts` 注册账号，在插件页显示账号：CLI 应用插件注册其厂商 CLI 保存的账号，MCP 连接器注册其 OAuth 服务器的账号。页面显示什么、能做什么由 Host 决定：每个注册方把自己的账号映射为展示内容，注册表只启动或取消该账号列出的操作。浏览器一半渲染每个插件包的区块、标题旁标签和开启引导，并且只在发起操作的浏览器中打开授权页、报告提示。Web 与桌面端组合通过 [`dsh-web-app`](../../bundle/web-app/README.zh.md) 加载这两半。

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

注册方的 Host 行注册一次账号；注册方不为账号提供任何浏览器代码。

### 注册账号

注册方的 Host 行在注册表运行时注册其账号来源，因此没有注册表的组合（如 headless profile）会跳过注册：

```ts ignore-check
import type {} from '@deepseek-ai/dsh-client-ui-connector-account'

export function apply(ctx: Context): void {
  const account = new AcmeAccount(options)
  ctx.effect(() => () => account.dispose(), 'acme: account')
  ctx.inject(['connectorAccounts'], (scope) => {
    scope.effect(() => scope.connectorAccounts.register({
      key: '@acme/cli', packageName: '@acme/cli', source: account, copy,
      operations: [{ kind: 'check' }, { kind: 'connect', notice: { en: 'Acme connected', zh: 'Acme 已连接' } }],
      present: presentAccount,
    }), 'acme: Plugins page account')
  })
}
```

- `key` 在 Remote 中标识该账号；页面启动和取消操作时把它传回。用同一个键再次注册会抛出异常。
- `packageName` 是其插件包页面承载区块和标签的 npm 包；一个包最多承载一个账号。没有包名的账号（如 MCP 服务器行的账号）不出现在任何插件包页面上。
- `source` 是账号：其当前视图、变化观察、检查，以及启动和取消操作。
- `operations` 列出页面按钮可以启动的操作类型，每项可带该操作成功时在发起它的浏览器中报告的文本；注册表拒绝其他类型。
- `copy` 包含区块标题、区块下方的提示，以及开启引导的标题、正文和连接按钮文案。

注册方用 `import type` 从包根或 `./types` 导入注册表的类型。返回的销毁函数会把账号从所有页面撤下。

### 展示区块

`present(view)` 把账号视图映射为 `ConnectorAccountDisplay`：阶段、状态行、可选的标题旁标签、按钮、开启引导中“连接”启动的操作、说明、附加行，以及带不翻译诊断项的失败信息。注册表在每次变化时为每条流调用它，因此它只做视图映射。所有文案都是 `LocalizedText`，由各浏览器按当前语言解析。按钮携带一个命令：`start` 启动某个已注册的操作类型，`cancel` 取消进行中的操作（处于不可取消的阶段时来源会忽略），`open` 重新打开其授权页。带 `confirm` 的按钮会先询问，用户确认后才执行。

| 界面 | 行为 |
|---|---|
| 区块 | 标题、状态、按钮、说明、附加行、失败信息和提示。区块发起的调用未返回，或 Host 流中断时，按钮（包括确认框的按钮）不可用。失败时先显示注册方的文案，再显示其诊断项 |
| 标题旁标签 | 显示 display 的 `badge`，只出现在已启用插件包的页面或其某一行的页面上，且只在 display 带有标签时显示 |
| 开启引导 | 插件包开启后，阶段为 `disconnected` 时打开；“连接”会打开插件包页面，并在 display 给出 `connect` 时启动该操作；Host 流中断时它不可用。账号检查中或连接中时继续等待，已连接或不可用时自动关闭 |
| 提示 | 本浏览器的最新结果，不受插件面板生命周期限制：操作成功的文本，或带警告图标的共用失败文案 |

没有包名的账号，或插件包页面之外的界面，渲染组件工厂 `connector.account` 并传入 `{ account, presentation }`：`section` 显示账号的完整区块，`status` 只显示状态点和状态行，用于列表行。在 Host 列出该账号之前它不渲染任何内容。[“连接器”标签](../../experimental/client-ui-connectors/README.zh.md)用它显示使用 OAuth 的 MCP 服务器行的账号。

### 跟随操作

每个浏览器在 Web 应用加载时打开一条流，Host 为每条新流检查每个没有在运行操作的账号；流打开期间注册的账号会立即检查。浏览器跟随其最近一次启动返回的操作，从返回时起，直到流推送该操作的结果。被跟随的操作提供的每个页面只在新标签页中打开一次，只打开 HTTPS 页面或回环地址上的 HTTP 页面；其他浏览器显示同样的区块，但不打开页面，也不报告提示。第一次调用返回前的第二次点击不会启动任何操作。连接断开后流会自动重连；流永久失败时，区块保留最后的账号，按钮不可用，直到页面重新加载。卸载浏览器一半会关闭流；Host 持有的操作继续运行。

### 共用文案

`connectorAccount` 字典包含所有账号共用的文案：关闭、取消、稍后、排障信息标签和失败提示。其余文案都来自注册方。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Host 一半 `ConnectorAccounts` 是一个 Remote 服务。`register()` 观察账号来源，每条 `watch` 流在每次变化后读取每个账号的条目，并合并在下一次读取前到达的变化：键和包、文案、`present(view)`、进行中的操作，以及带成功文本的最新结果。`start` 和 `cancel` 按键路由到该账号的来源。

[`dsh-api-remotes`](../../api/remotes/README.zh.md) 挂载生成的 `connectorAccounts` Remote。浏览器一半通过 `BrowserAccounts` 打开一条 `watch` 流；它的一个 store 保存按键索引的 Host 账号、流是否在推送，以及最新提示，同时记住本浏览器发起的操作。它为页面注册一个 `plugins.detail.badge` 条目和一个 `shell.overlay` 提示，并为每个带包名的账号注册以包名为键的 `plugins.bundle.config` 和 `plugins.bundle.activation`，全部使用 `connectorAccount` 命名空间；另以同一个 face 注册组件工厂 `connector.account`。各界面收到 `start` 和 `cancel` 两个回调：它们调用 Remote 并返回其结果；按钮把启动成功时返回的操作报告给 `BrowserAccounts`，结果为失败或调用被 reject 时报告失败提示。Host 撤下的账号会失去其插件包条目；卸载时撤下所有条目和流。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `ctx.connectorAccounts` 注册表及其 Remote |
| [`src/types.ts`](src/types.ts) | 注册、来源、视图、display 和条目类型 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器入口：字典和插槽注册 |
| [`src/client/state.ts`](src/client/state.ts) | 流的 store、本浏览器发起的操作，以及它们的页面和提示 |
| [`src/client/components.tsx`](src/client/components.tsx) | 各界面的插槽条目，以及按钮的 Remote 调用 |
| [`src/client/locales.ts`](src/client/locales.ts) | 共用字典 |
| [`src/client/types.ts`](src/client/types.ts) | 浏览器状态、提示和 face 类型 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [插件管理页](../ui-plugin-manager/README.zh.md)——插件页及其插件包插槽。
- [客户端包地图](../README.zh.md)——相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

无，注册表及其界面属于插件页 UI，不增加模型输入。各注册方自行说明其账号启用的工具和技能。

#### KV Cache 影响

无；注册或移除账号不改变任何模型可见文本。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 五个显示阶段固定不变；注册方需把其他账号状态映射到其中之一。
- Host 行加载失败的注册方不显示账号区块；插件页仍会列出该插件包及其加载失败。
- 每个加载 Web 应用的浏览器都会触发一次对所有空闲账号的检查。
- 无论是否安装了连接器插件，Web 与桌面端组合都会加载注册表。
- 调用返回后才打开的授权页可能被浏览器拦截；区块中的打开按钮可以再次打开它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

Host 测试用假的账号来源驱动注册表。客户端测试用假的 Remote 流驱动 `BrowserAccounts`，用中文字典和假的 Remote 渲染各界面，并在真实的插槽注册表和 locale 运行时上挂载浏览器一半。

</details>
