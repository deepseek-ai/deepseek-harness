---
description: "为 CLI 应用插件的插件页提供账号区块、标题旁标签、开启引导、确认和提示，内容镜像自插件的 Host 账号 Remote，文案由插件翻译。"
kind: "package-library"
---

# @deepseek-ai/dsh-client-ui-cli-account

[English](README.md) | 中文

## 概述

飞书、企业微信等 CLI 应用插件用这些共用组件搭建自己的插件页。`CliAccountConnection` 跟随插件的账号流，在发起操作的浏览器中把授权链接打开一次，并报告结果。区块、标签、开启引导、确认和提示组件按插件翻译的文案，渲染六种显示阶段之一。Web 外壳静态链接这个库，并通过模块表共享同一份，插件像使用 `ui-primitives` 一样导入它。每个插件保留各自的展示推导和字典。

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

插件页导入这个库，基于自己的 Remote 创建一个连接，把 Host 视图映射为显示阶段，再渲染共用组件。

### 何时选择

用于基于 [`@deepseek-ai/dsh-cli-account`](../../connector/cli-account/README.zh.md) 的插件的页面一半，其 Remote 流式推送 `CliAccountView`。通过 MCP 接入托管服务的插件改用 MCP 账号界面。

### 导入

插件页导入 `@deepseek-ai/dsh-client-ui-cli-account`，并把它列入 `devDependencies`。本包是 Web 外壳的 `PLATFORM_MODULES` 之一，因此插件 bundle 无需 `dsh.client.external` 就会把导入解析到外壳的那一份；如果插件 bundle 把它内联进来，客户端 bundle 纯净性检查会拒绝。本包是 Web 外壳的构建输入：其静态 ESM 为 Vite 保留 CSS module，没有 Loader 行，也没有配置字段。

### 连接镜像

`new CliAccountConnection(ctx, { name, follow, cancel, notices })` 通过 `ctx.remote.$stream` 打开插件的 `follow` 流，并发布快照，包含 Host 视图、流是否在推送或已停止、是否有页面操作未完成，以及最新提示。`start(call)` 一次只运行一个 Remote 启动调用，有调用未完成时忽略点击；启动或取消被拒绝时只报告一次 `action-failed` 提示。本浏览器发起的操作的每个新链接只在新窗口中打开一次，且只打开 HTTPS 链接。本浏览器发起的操作成功时，报告 `notices` 为其类型映射的提示。流永久失败时快照标记为已停止，`retry()` 会重新打开。`actions` 为插件的 face 绑定了 `cancel`、`openAuthorization`、`retry` 和 `dismissNotice`。

### 共用字典键

组件通过插件的翻译函数读取这些键，因此每个插件字典都要定义它们，缺少任何一个都会被 TypeScript 拒绝：`section.title`、`hint`、`close`、`action.cancel`、`action.connect`、`activation.title`、`activation.body`、`activation.later`、`failure.details`（含 `{details}`）、`failure.exitCode`（含 `{code}`）、除 `checking` 外每个阶段的 `badge.<phase>`，以及除 `connecting` 外每个阶段的 `status.<phase>`。提示组件还会读取插件映射的每种提示的 `notice.<kind>`，以及 `action-failed`。

### 组件

| 组件 | 行为 |
|---|---|
| `CliAccountSection` | 标题、状态、按钮、说明、附加行、失败和提示；状态默认取该阶段的 `status.*` 文案。页面操作未完成或 Host 流中断时按钮禁用，但在已停止时保持可用，以便重试重新打开流。失败时先显示插件的恢复建议，再显示分类后的命令、退出码和白名单字段 |
| `CliAccountBadge` | 标题旁的标签，只在已启用插件包的页面或其某一行的页面上、并且阶段确定后显示 |
| `CliAccountActivation` | 开启插件包后的引导，未连接时打开；阶段确定为其他状态后自行关闭 |
| `CliAccountConfirm` | 先关闭再执行确认的确认框 |
| `CliAccountToast` | 最新提示；`action-failed` 带警告图标 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

[`src/index.ts`](src/index.ts) 导出连接镜像和组件，没有插件入口。Web 外壳把本包放进模块表，因此每个插件页共用同一份代码，而不是各自内联一份。组件只接收翻译好的文案和显示阶段；从插件的账号状态推导显示阶段，仍由插件负责。

| 文件 | 职责 |
|---|---|
| [`src/connection.ts`](src/connection.ts) | Host 视图镜像、链接打开、提示与未完成操作保护 |
| [`src/components.tsx`](src/components.tsx) | 共用组件、显示阶段与字典键 |
| [`src/index.ts`](src/index.ts) | 外壳模块表提供的库入口 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [CLI 账号库](../../connector/cli-account/README.zh.md)——推送视图的 Host 一半。
- [Web 外壳](../web/README.zh.md)——`PLATFORM_MODULES`，提供本库的共享模块表。
- [插件管理页面](../ui-plugin-manager/README.zh.md)——插件页及其插件包插槽。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包是浏览器侧 UI 层，不注册任何面向模型的内容。

#### KV 缓存影响

无；本包既不组装也不发送提供方请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 六种显示阶段是固定的；插件要把其他账号状态映射到其中之一。
- 共用字典键对所有插件都相同；插件不能改名。
- 本库不注册插槽；每个插件注册自己的区块、标签、开启引导和提示条目。
- 无论是否安装了 CLI 应用插件，Web 外壳都带着本库。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
