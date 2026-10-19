---
description: "腾讯会议插件在插件页上的页面：无需发起对话即可登录、检查和退出腾讯会议。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-tencent-meeting

[English](README.md) | 中文

## 概述

本包是[腾讯会议插件](../../connector/tencent-meeting/README.zh.md)的浏览器行。插件开启时，它在 **插件** 页上的页面会显示 **腾讯会议账号** 区块，用户无需发起对话即可在那里登录和退出登录。每个操作都通过 [`tencentMeeting` Remote](../../connector/tencent-meeting-cli/README.zh.md#account-operations) 在 Host 上运行；页面显示其进度和结果。

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

安装[腾讯会议插件 bundle](../../connector/tencent-meeting/README.zh.md)，它会把本包作为 `ui-tencent-meeting` 行插入。打开插件页面会检查账号，标题旁的标签显示未连接、连接中、已连接、待确认或未运行。在列表中开启插件且账号未连接时，会提示 **连接腾讯会议**，点击后打开插件页面并开始登录。

| 区块状态 | 操作 |
|---|---|
| 正在检查连接 | 无 |
| 未连接 | **连接腾讯会议** 打开腾讯会议授权页面 |
| 等待在腾讯会议页面授权 | 发起点击的浏览器会打开一次授权页面；**打开腾讯会议页面** 再次打开它，**取消** 结束登录 |
| 正在连接 | 无；Host 检查服务端是否接受新的登录 |
| 已连接 | 显示已登录的用户；**退出登录** 先请用户确认，再退出登录 |
| 正在退出登录 | 无 |
| 暂时无法确认登录状态 | **重试** 重新检查账号 |
| 腾讯会议组件未运行 | Host 的 `tencent-meeting` 行没有加载；区块提示到组件列表查看原因，**重试** 会重新订阅 Host |

离开页面不会取消登录，登录由 Host 持有。授权页面由用户自己的点击打开，因为浏览器会拦截点击很久之后才打开的窗口。登录、退出登录或检查失败时，显示通用失败提示及命令和退出码；页面操作失败时显示 toast，登录或退出登录完成时也会显示。区块会说明账号与这台电脑终端里的 `tmeet` 共用，关闭插件不会退出登录；退出登录的确认框会说明终端也会一起退出。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

Host 部分 [`src/index.ts`](src/index.ts) 是一个空的 `apply`，存在的目的只是让本包占有一个 Loader 行，客户端模块系统据此提供浏览器部分。浏览器部分 [`src/client/index.ts`](src/client/index.ts) 用 `ctx.remote.$mount` 自行挂载 `tencentMeeting` Remote，因为随产品交付的 Remote 组装不包含按需安装的包；它在卸载该 Remote 之前先撤回自己的注册。

[`src/client/connection.ts`](src/client/connection.ts) 为每个浏览器插件在 `tencentMeeting` Remote 上创建一个来自 [CLI 插件页组件](../ui-cli-account/README.zh.md)的 `CliAccountConnection`，并只根据 Host 的视图推导页面状态。该连接只为本浏览器发起的操作打开链接，每个链接只打开一次，并且只打开 HTTPS 链接。[`src/client/TencentMeetingConnection.tsx`](src/client/TencentMeetingConnection.tsx) 用腾讯会议的操作渲染共用的区块、退出登录确认、标签、开启引导和 toast；Web shell 以平台模块提供这个共用库，因此本包的 bundle 不包含它。它注册以 `@deepseek-ai/dsh-tencent-meeting` 为键的 `plugins.bundle.config` 区块、`plugins.bundle.activation` 引导、`plugins.detail.badge` 标签，以及一个 `shell.overlay` toast。页面文案，包括共用组件读取的键，都在本包的 `tencent-meeting` 字典中。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [腾讯会议插件](../../connector/tencent-meeting/README.zh.md) — 插入本行和 Host 行的 bundle。
- [腾讯会议 CLI 与技能](../../connector/tencent-meeting-cli/README.zh.md) — Host 行以及本页面发起的账号操作。
- [CLI 插件页组件](../ui-cli-account/README.zh.md) — 本页面渲染的共用连接镜像和组件。
- [ui-plugin-manager](../ui-plugin-manager/README.zh.md) — 插件页以及本页面注册进去的 bundle 插槽。

-----

<a id="model-experience"></a>
## 模型体验

无；本包是浏览器侧页面，不注册任何面向模型的内容。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 页面每次订阅时检查一次账号，没有定期检查，因此用户在终端里登录或退出登录后，要重新打开页面才能看到。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
