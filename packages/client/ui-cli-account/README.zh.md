---
description: "通过 `ctx.cliAccounts` 在 Host 上注册 CLI 应用插件的账号，并经由一个 `cliAccounts` Remote 在插件页显示其区块、标题旁标签、开启引导、确认和提示，文案来自插件自己的文本和本包的共用文案。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-cli-account

[English](README.md) | 中文

## 概述

飞书、企业微信等 CLI 应用插件在 Host 上通过 `ctx.cliAccounts` 注册账号，在插件页显示账号。注册表通过一个 `cliAccounts` Remote 提供所有账号，并且只启动或取消各账号列出的操作。浏览器一半渲染每个账号的区块、标题旁标签、开启引导、确认和提示，并在发起操作的浏览器中把授权链接打开一次。插件以 `LocalizedText` 提供自己的文案；共用文案来自本包的字典。Web 与桌面端组合通过 [`dsh-web-app`](../../bundle/web-app/README.zh.md) 加载这两半。

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

插件的 Host 行注册一次账号；插件不为账号提供任何浏览器代码。

### 何时选择

用于基于 [`@deepseek-ai/dsh-cli-account`](../../connector/cli-account/README.zh.md) 的插件，其厂商 CLI 保存账号。通过 MCP 接入托管服务的插件改用 MCP 账号界面。

### 注册账号

插件的 Host 行在注册表运行时注册其 `CliAccountRuntime`，因此没有注册表的组合（如 headless profile）会跳过注册：

```ts ignore-check
import type {} from '@deepseek-ai/dsh-client-ui-cli-account'

export function apply(ctx: Context): void {
  const account = new AcmeAccount(options)
  ctx.effect(() => () => account.dispose(), 'acme: account')
  ctx.inject(['cliAccounts'], (scope) => {
    scope.effect(() => scope.cliAccounts.register({
      packageName: '@acme/cli', source: account, copy,
      operations: [{ kind: 'check' }, { kind: 'connect', notice: { en: 'Acme connected', zh: 'Acme 已连接' } }],
      present: presentAccount,
    }), 'acme: Plugins page account')
  })
}
```

`packageName` 是其插件包页面承载区块和标签的 npm 包；同一个包再次注册会抛出异常。`source` 是账号，由 `CliAccountRuntime` 实现。`operations` 列出页面按钮可以启动的操作类型，每项可带该操作成功时在发起它的浏览器中报告的文本；注册表拒绝其他类型。`copy` 包含区块标题、区块下方的提示，以及开启引导的标题、正文和连接按钮文案。插件用 `import type` 导入注册表的类型。返回的销毁函数会把账号从所有页面撤下。

### 展示区块

`present(view)` 把账号视图映射为 `CliAccountDisplay`：阶段、状态行、可选的标题旁标签、按钮、开启引导中“连接”启动的操作、说明、附加行，以及带不翻译诊断项的失败信息。注册表在每次变化时为每条流调用它，因此它只做视图映射。所有文案都是 `LocalizedText`，由各浏览器按当前语言解析。按钮携带一个命令：`start` 启动某个已注册的操作类型，`cancel` 取消进行中的操作（处于不可取消的阶段时 Host 会忽略），`open` 重新打开其授权链接。带 `confirm` 的按钮会先询问，用户确认后才执行。

| 界面 | 行为 |
|---|---|
| 区块 | 标题、状态、按钮、说明、附加行、失败信息和提示。本浏览器发起的操作未完成，或 Host 流中断时，按钮不可用。失败时先显示插件的文案，再显示其诊断项 |
| 标题旁标签 | 显示 display 的 `badge`，只出现在已启用插件包的页面或其某一行的页面上，且只在 display 带有标签时显示 |
| 开启引导 | 插件包开启后，阶段为 `disconnected` 时打开；“连接”会打开插件包页面，并在 display 给出 `connect` 时启动该操作。阶段确定为其他值后自动关闭 |
| 提示 | 本浏览器的最新结果，不受插件面板生命周期限制：操作成功的文本，或带警告图标的共用失败文案 |

### 跟随操作

每个浏览器在 Web 应用加载时打开一条流，Host 为每条新流检查每个没有在运行操作的账号；流打开期间注册的账号会立即检查。浏览器跟随其最近一次启动返回的操作，从返回时起，直到流推送该操作的结果；每次尝试启动都会先放弃之前跟随的操作，因此被拒绝的启动不会留下被跟随的操作，并只报告一次失败提示。操作未完成时的点击会被忽略。被跟随的操作提供的每个链接只在新窗口中打开一次，且只打开 HTTPS 链接。其他浏览器显示同样的区块，但不打开链接，也不报告提示。流永久失败时，区块显示账号服务未运行，并提供“重试”；无论按多少次，都只重新打开流一次。卸载浏览器一半会关闭流；Host 持有的操作继续运行。

### 共用文案

`cliAccount` 字典包含所有账号共用的文案：关闭、取消、重试、稍后、排障信息标签、失败提示，以及未运行时的状态、标签和说明。其余文案都来自插件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Host 一半 `CliAccounts` 是一个 Remote 服务。`register()` 观察账号来源，每条 `watch` 流在每次变化后读取每个账号的条目，并合并在下一次读取前到达的变化：文案、`present(view)`、进行中的操作，以及带成功文本的最新结果。`start` 和 `cancel` 按包路由到该账号的来源。

浏览器一半挂载 `cliAccounts` Remote，并通过 `CliAccountsConnection` 打开一条 `watch` 流，为每个账号保存一个快照 store：Host 条目、流是否在推送或已停止、本浏览器发起的操作是否未完成，以及最新提示。对 Host 报告的每个账号，它注册以包名为键的 `plugins.bundle.config` 和 `plugins.bundle.activation`、id 为 `<package>.account` 的 `plugins.detail.badge` 条目，以及 id 为 `<package>.account-toast` 的 `shell.overlay` 提示，全部使用 `cliAccount` 命名空间并注入同一个 face。Host 撤下的账号会失去这四个条目；卸载时先撤下条目和流，再撤下 Remote。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `ctx.cliAccounts` 注册表及其 Remote |
| [`src/client/index.ts`](src/client/index.ts) | 绑定生成的 Remote 的浏览器入口 |
| [`src/client/mount.ts`](src/client/mount.ts) | Remote 挂载、字典，以及每个账号的插槽注册 |
| [`src/client/connection.ts`](src/client/connection.ts) | 流的镜像、链接打开、提示和未完成操作保护 |
| [`src/client/components.tsx`](src/client/components.tsx) | 各界面，以及读取 face 的插槽条目 |
| [`src/client/locales.ts`](src/client/locales.ts) | 共用字典 |
| [`src/client/types.ts`](src/client/types.ts) | 快照、提示和 face 类型 |

注册、display 和条目类型位于 [`@deepseek-ai/dsh-cli-account/types`](../../connector/cli-account/src/types.ts)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [CLI 账号库](../../connector/cli-account/README.zh.md)——账号运行时和页面类型。
- [插件管理页](../ui-plugin-manager/README.zh.md)——插件页及其插件包插槽。
- [客户端包地图](../README.zh.md)——相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

无，注册表及其界面属于插件页 UI，不增加模型输入。各插件自行说明其账号启用的 CLI 和技能。

#### KV Cache 影响

无；注册或移除账号不改变任何模型可见文本。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 五个显示阶段固定不变；插件需把其他账号状态映射到其中之一。
- Host 行加载失败的插件不显示账号区块；插件页仍会列出该插件包及其加载失败。
- 每个加载 Web 应用的浏览器都会触发一次对所有空闲账号的检查。
- 无论是否安装了 CLI 应用插件，Web 与桌面端组合都会加载注册表。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

Host 测试用假的账号来源驱动注册表。客户端测试用假的 Remote 流驱动 `CliAccountsConnection`，用中文字典渲染各界面，并在真实的插槽注册表和 locale 运行时上挂载浏览器一半。源码覆盖率排除 `src/client/index.ts`，因为它导入只存在于 `lib/` 中的生成 Remote。

</details>
