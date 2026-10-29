---
description: "通过 `ctx.cliAccounts` 在插件页显示 CLI 应用插件的账号区块、标题旁标签、开启引导、确认和提示，内容跟随插件的 Host 账号 Remote，文案由插件翻译。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-cli-account

[English](README.md) | 中文

## 概述

飞书、企业微信等 CLI 应用插件通过 `ctx.cliAccounts` 注册账号，在插件页显示账号。注册表跟随插件的账号流，在发起操作的浏览器中把授权链接打开一次，并渲染区块、标题旁标签、开启引导、确认和提示。每个插件保留各自的 Remote 操作、展示推导和字典。Web 与桌面端组合通过 [`dsh-web-app`](../../bundle/web-app/README.zh.md) 挂载注册表。

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

插件的浏览器一半注册一次账号，提供自己的 Remote 操作、字典，以及把页面快照映射为区块内容的展示函数。

### 何时选择

用于基于 [`@deepseek-ai/dsh-cli-account`](../../connector/cli-account/README.zh.md) 的插件的页面一半，其 Remote 流式推送 `CliAccountView`。通过 MCP 接入托管服务的插件改用 MCP 账号界面。

### 注册账号

插件的浏览器一半注入 `locale` 和 `cliAccounts`，注册字典，并在自身生命周期内注册账号：

```ts ignore-check
export const inject = ['remote', 'locale', 'cliAccounts']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'acme: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.cliAccounts.register({
    packageName: '@acme/cli', locale: NS,
    follow: signal => ctx.remote.acme.follow(signal),
    cancel: id => ctx.remote.acme.cancel(id),
    notices: { connect: () => t('notice.connected') },
    present: (snapshot, page) => presentAccount(snapshot, page, t),
  }), 'acme: account')
}
```

`packageName` 是其插件包页面承载区块和标签的 npm 包。`locale` 指定插件的字典命名空间，它必须翻译每个[共用键](#shared-dictionary-keys)；缺少任何一个，TypeScript 都会拒绝该命名空间。`follow` 和 `cancel` 调用插件的 Remote。`notices` 把操作类型映射为该操作成功时、在发起它的浏览器中报告的已翻译提示；未列出的类型不报告提示。插件把 `@deepseek-ai/dsh-client-ui-cli-account` 列入 `dsh.client.inject`，并用 `import type` 导入其类型。返回的销毁函数会移除这些界面并关闭该账号的 Host 流。如果注册的包已被注册，调用会抛出异常，且不留下任何界面。

### 展示区块

`present(snapshot, page)` 在界面渲染时运行，返回 `CliAccountDisplay`：阶段、可选的状态文案、按钮、说明、附加行和失败信息，其中所有文案都已翻译。它只读取快照，因此通过 `ctx.locale.bind` 翻译时会跟随语言切换。按钮回调使用 `page`：`start(call)` 一次只运行一个 Remote 启动调用，`cancel`、`openAuthorization` 和 `retry` 作用于被跟随的操作和 Host 流。快照包含 Host 视图、流是否在推送或已停止、是否有页面操作未完成，以及最新提示。

| 界面 | 行为 |
|---|---|
| 区块 | 标题、状态、按钮、说明、附加行、失败和提示；状态默认取该阶段的 `status.*` 文案，`connecting` 显示为检查中。页面操作未完成或 Host 流中断时按钮禁用，但在已停止时保持可用，以便重试重新打开流。带 `confirm` 的按钮会先询问，用户确认后才执行。失败时先显示插件的恢复建议，再显示分类后的命令、退出码和白名单字段 |
| 标题旁标签 | 只在已启用插件包的页面或其某一行的页面上、并且阶段确定后显示 |
| 开启引导 | 开启插件包后，阶段为 `disconnected` 时打开；“连接”会打开插件包页面，并执行区块中第一个不需要确认的主要按钮。阶段确定为其他状态后自行关闭 |
| 提示 | 在插件面板生命周期之外报告最新结果：插件的成功文案，或带警告图标的共用失败文案 |

### 跟随操作

页面跟随其最近一次启动调用返回的操作，从调用返回起，直到流送达该操作的结果；每次发起启动都会先放下之前跟随的操作，因此启动被拒绝时不跟随任何操作，并只报告一次 `action-failed` 提示。有页面操作未完成时，点击会被忽略。被跟随的操作提供的每个链接只在新窗口中打开一次，且只打开 HTTPS 链接；后续操作提供同一链接时会再次打开。如果某个结果在流送达之前就被后续操作取代，则不报告任何提示。流永久失败时快照标记为已停止，`retry` 会重新打开一次，无论调用多少次。移除注册会关闭流；此后页面不再打开链接、不再报告提示，而 Host 持有的操作继续运行。

<a id="shared-dictionary-keys"></a>
### 共用字典键

这些界面从插件的命名空间读取以下键：`section.title`、`hint`、`close`、`action.cancel`、`action.connect`、`activation.title`、`activation.body`、`activation.later`、`failure.details`（含 `{details}`）、`failure.exitCode`（含 `{code}`）、`notice.action-failed`、除 `checking` 外每个阶段的 `badge.<phase>`，以及除 `connecting` 外每个阶段的 `status.<phase>`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

`register()` 为每个账号创建一个 `CliAccountConnection`。它镜像插件的 `follow` 流，保存 Host 视图、流是否在推送、是否有页面操作未完成，以及最新提示。一次注册会贡献以包名为键的 `plugins.bundle.config` 和 `plugins.bundle.activation`、id 为 `<package>.account` 的 `plugins.detail.badge` 条目，以及 id 为 `<package>.account-toast` 的 `shell.overlay` 提示。每个条目都声明插件的命名空间，因此渲染器会提供它的 `t`；四个条目注入同一个 face，共享同一份快照，并调用插件的展示函数。注册是本插件 fiber 上的一个 effect：初始化失败时会销毁已经添加的部分；无论插件的销毁函数和本插件的卸载哪个先发生，拆除时都会先移除插槽条目，再关闭流。

| 文件 | 职责 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | `ctx.cliAccounts` 注册表与四个插槽注册 |
| [`src/client/types.ts`](src/client/types.ts) | 注册、展示、快照与字典类型 |
| [`src/client/connection.ts`](src/client/connection.ts) | Host 视图镜像、链接打开、提示与未完成操作保护 |
| [`src/client/components.tsx`](src/client/components.tsx) | 各个界面，以及从 face 读取数据的插槽条目 |
| [`src/index.ts`](src/index.ts) | 空的 Node 一半 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [CLI 账号库](../../connector/cli-account/README.zh.md)——推送视图的 Host 一半。
- [插件管理页面](../ui-plugin-manager/README.zh.md)——插件页及其插件包插槽。
- [客户端包索引](../README.zh.md)——相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

无，因为账号界面是浏览器 UI，不增加任何模型输入。每个插件各自说明其账号启用的 CLI 和技能。

#### KV 缓存影响

无；注册或移除账号不会改变任何模型可见文本。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 六种显示阶段是固定的；插件要把其他账号状态映射到其中之一。
- 共用字典键对所有插件都相同；插件不能改名。
- 每个账号各自打开一条 Host 流。
- 无论是否安装了 CLI 应用插件，Web 与桌面端组合都会加载注册表。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

客户端测试用模拟的 Remote 流驱动 `CliAccountConnection`，用回显键名的翻译函数渲染各个界面，并在真实的插槽注册表上注册账号。

</details>
