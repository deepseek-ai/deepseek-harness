---
description: "企业微信插件在插件页上的页面：无需开始对话即可授权和检查企业微信。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-wecom

[English](README.md) | 中文

## 概述

本包是[企业微信插件](../../connector/wecom/README.zh.md)的浏览器行。插件开启时，它在**插件**页上的页面显示**企业微信授权**区块，用户无需开始对话即可在这里扫码绑定机器人。所有操作都通过 [`wecom` Remote](../../connector/wecom-cli/README.zh.md#account-operations) 在 Host 上运行；页面显示其进度和结果。

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

安装[企业微信插件 bundle](../../connector/wecom/README.zh.md)，它会把本包作为 `ui-wecom` 行插入。打开插件页面会检查授权，标题旁的标签显示未授权、授权中、已授权、待确认或未运行。在列表中开启插件且尚未授权时，会提示**连接企业微信**，点击后打开插件页面并开始连接。

| 区块状态 | 操作 |
|---|---|
| 正在检查授权 | 无 |
| 未授权 | **连接企业微信**打开企业微信扫码页面 |
| 等待扫码授权 | 点击的浏览器会把扫码页面打开一次；**打开扫码页面**再次打开，**取消**结束连接 |
| 正在确认授权 | 无；Host 检查扫码结果 |
| 已授权 | 无；可以在对话中使用企业微信 |
| 暂时无法读取授权状态 | **重试**重新检查授权 |
| 企业微信组件未运行 | Host 的 `wecom` 行没有加载；区块提示到组件列表查看原因，**重试**重新订阅 Host |

离开页面不会取消连接，连接由 Host 持有。扫码页面由用户自己的点击打开，因为浏览器会拦截点击很久之后才打开的窗口。连接或检查失败时显示通用失败提示，并附上命令和退出码；页面操作失败时显示提示，连接完成时也会显示提示。区块会说明该授权与这台电脑终端里的 `wecom-cli` 共用，关闭插件不会解除授权。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

Host 半部 [`src/index.ts`](src/index.ts) 是空的 `apply`，只为让本包持有一行 Loader 条目，客户端模块系统据此提供浏览器半部。浏览器半部 [`src/client/index.ts`](src/client/index.ts) 用 `ctx.remote.$mount` 自行挂载 `wecom` Remote，因为随产品发布的 Remote 集合不包含按需安装的包；卸载 Remote 之前会先撤下自己的注册。

[`src/client/connection.ts`](src/client/connection.ts) 为每个浏览器插件基于 `wecom` Remote 创建一个来自 [CLI 插件页组件](../ui-cli-account/README.zh.md)的 `CliAccountConnection`，只根据 Host 的视图推导页面状态。该连接只为本浏览器发起的操作打开链接，每个链接只打开一次，且只打开 HTTPS 链接。[`src/client/WecomConnection.tsx`](src/client/WecomConnection.tsx) 用企业微信的操作渲染共用的区块、标签、开启引导和提示；本包通过 `dsh.client.external` 请求共用模块，而不是把它打包进来。它以 `@deepseek-ai/dsh-wecom` 为 key 注册 `plugins.bundle.config` 作为区块，注册 `plugins.bundle.activation` 作为引导、`plugins.detail.badge` 作为标签，以及一个 `shell.overlay` 提示。页面文案，包括共用组件读取的键，位于本包的 `wecom` 词典。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [企业微信插件](../../connector/wecom/README.zh.md)——插入本行与 Host 行的 bundle。
- [企业微信 CLI 与技能](../../connector/wecom-cli/README.zh.md)——Host 行，以及本页面发起的授权操作。
- [CLI 插件页组件](../ui-cli-account/README.zh.md)——本页面渲染的共用连接镜像与组件。
- [ui-plugin-manager](../ui-plugin-manager/README.zh.md)——插件页，以及本页面注册进的 bundle slot。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包是浏览器侧页面，不注册任何模型可见内容。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 页面每次订阅时检查授权，没有定期检查，因此在用户终端里完成的授权要在重新打开页面后才显示。
- 页面不提供断开连接，因为 `wecom-cli` 无法撤销授权。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
