---
description: "飞书插件在插件页上的页面：无需开始对话即可连接、检查和退出飞书账号。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-feishu

[English](README.md) | 中文

## 概述

本包是[飞书插件](../../connector/feishu/README.zh.md)的浏览器行。插件开启时，它在**插件**页上的页面显示**飞书账号**区块，用户无需开始对话即可在这里关联飞书应用、登录和退出登录。所有账号操作都通过 [`feishu` Remote](../../connector/feishu-cli/README.zh.md#account-operations) 在 Host 上运行；页面显示其进度和结果。

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

安装[飞书插件 bundle](../../connector/feishu/README.zh.md)，它会把本包作为 `ui-feishu` 行插入。打开插件页面会检查账号，标题旁的标签显示未连接、连接中、已连接、待确认或未运行。在列表中开启插件且账号未连接时，会提示**连接飞书**，点击后打开插件页面并开始下一步。

| 区块状态 | 操作 |
|---|---|
| 正在检查连接 | 无 |
| 未连接，没有应用 | **关联飞书应用**打开飞书页面，用户在其中新建或选择应用，完成后停下 |
| 未连接，已关联应用 | **登录飞书账号**打开飞书授权页面 |
| 任何已关联应用的状态 | 区块显示应用 id；**更换应用**确认后重新关联应用，这会一并替换终端使用的 CLI 配置，之后需要重新登录 |
| 第 1 步：关联飞书应用，或第 2 步：登录飞书账号 | 点击的浏览器会把这一步的飞书页面打开一次；**打开飞书页面**再次打开，**取消**结束这一步 |
| 已连接 | **退出登录**确认后退出 CLI 的默认账号 |
| 暂时无法确认登录状态 | **重试**重新运行连接，保留现有配置和登录 |
| 飞书组件未运行 | Host 的 `feishu` 行没有加载；区块提示到组件列表查看原因，**重试**重新订阅 Host |

离开页面不会取消连接，连接由 Host 持有。每一步都由用户自己的点击打开页面，因为浏览器会拦截点击很久之后才打开的窗口。关联应用失败时，区块提示查看服务日志；若飞书页面已显示成功，还会建议检查本地配置和凭据的访问权限，并在再次关联时选择已有应用。其他步骤或退出登录失败时保留通用失败提示。区块会显示可用的安全 CLI 诊断代码；页面操作失败时显示提示，关联应用、登录或退出登录完成时也会显示提示。区块会说明该账号与这台电脑终端里的飞书 CLI 共用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

Host 半部 [`src/index.ts`](src/index.ts) 是空的 `apply`，只为让本包持有一行 Loader 条目，客户端模块系统据此提供浏览器半部。浏览器半部 [`src/client/index.ts`](src/client/index.ts) 用 `ctx.remote.$mount` 自行挂载 `feishu` Remote，因为随产品发布的 Remote 集合不包含按需安装的包；卸载 Remote 之前会先撤下自己的注册。

[`src/client/connection.ts`](src/client/connection.ts) 中每个浏览器插件一个 `FeishuConnection`，它镜像 Remote 的 `follow` 流，只根据 Host 的视图推导页面状态；它自己只保存流是否在送达、页面操作是否未完成、本浏览器发起的操作和最近一条提示。它以 `@deepseek-ai/dsh-feishu` 为 key 注册 `plugins.bundle.config` 作为区块，注册 `plugins.bundle.activation` 作为引导、`plugins.detail.badge` 作为标签，以及一个 `shell.overlay` 提示。它只为本浏览器发起的操作打开链接，每个链接只打开一次，且只打开 HTTPS 链接。页面文案位于本包的 `feishu` 词典。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [飞书插件](../../connector/feishu/README.zh.md)——插入本行与 Host 行的 bundle。
- [飞书 CLI 与技能](../../connector/feishu-cli/README.zh.md)——Host 行，以及本页面发起的账号操作。
- [ui-plugin-manager](../ui-plugin-manager/README.zh.md)——插件页，以及本页面注册进的 bundle slot。

-----

<a id="model-experience"></a>
## 模型体验

无，本包是浏览器端页面，不注册任何模型可见内容。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 页面每次订阅时检查账号，没有定期检查，因此在用户终端里登录或退出后，需要重新打开页面才能看到。
- 每种失败的操作都显示同一条重试提示；诊断信息保留在 Host 上。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
