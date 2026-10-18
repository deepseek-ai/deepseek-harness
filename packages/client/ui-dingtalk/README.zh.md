---
description: "钉钉插件在插件页上的页面：不必开始对话即可登录、检查和退出钉钉。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-dingtalk

[English](README.md) | 中文

## 概述

本包是[钉钉插件](../../connector/dingtalk/README.zh.md)的浏览器行。插件开启期间，它在**插件**页面的插件详情中显示**钉钉账号**区块，用户不必开始对话就能在这里登录和退出。每个操作都通过 [`dingtalk` Remote](../../connector/dingtalk-cli/README.zh.md#account-operations) 在 Host 上执行；页面显示其进度和结果。

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

安装[钉钉插件 bundle](../../connector/dingtalk/README.zh.md)，它会把本包作为 `ui-dingtalk` 行插入。打开插件详情会检查账号，标题旁的标签显示未连接、连接中、已连接、待确认或未运行。账号未连接时，从列表开启插件会提供**连接钉钉**，它会打开插件详情并开始登录。

| 区块状态 | 操作 |
|---|---|
| 正在检查连接 | 无；Host 下载 dws 或其技能期间，状态显示正在下载 dws 及其技能 |
| 未连接 | **连接钉钉**打开钉钉授权页面；区块说明需要组织管理员先开启 CLI 访问 |
| 等待在钉钉页面授权 | 点击的浏览器会打开一次授权页面；**打开授权页面**再次打开它，**取消**结束登录 |
| 正在连接 | 无；Host 检查 dws 是否报告该账号已登录 |
| 已连接 | 显示已登录的用户和组织；**退出登录**先请求确认，再退出当前账号 |
| 正在退出登录 | 无 |
| 暂时无法确认登录状态 | **重试**重新检查账号；dws 或其技能没有下载完成时，区块会说明，**重试**会重新下载 |
| 钉钉组件未运行 | Host 的 `dingtalk` 行没有加载；区块引导用户到组件列表查看原因，**重试**会重新订阅 Host |

离开页面不会取消登录，登录归 Host 所有。授权页面由用户自己的点击打开，因为浏览器会拦截很久之后才打开的窗口。登录、退出登录或检查失败时显示失败提示，附带命令和退出码；登录失败时还会提示检查 CLI 访问是否已开启。页面操作失败时显示提示条，登录或退出登录完成时也会显示。区块说明账号与这台电脑终端里的 `dws` 共用，关闭插件不会退出登录；退出确认说明终端也会退出这个账号，其他组织的账号保持登录。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

Host 部分 [`src/index.ts`](src/index.ts) 是一个空的 `apply`，它的存在只是为了让本包持有一个 Loader 行，客户端模块系统据此提供浏览器部分。浏览器部分 [`src/client/index.ts`](src/client/index.ts) 用 `ctx.remote.$mount` 自行挂载 `dingtalk` Remote，因为随产品发布的 Remote 集合不包含按需安装的包；卸载前它会先撤下自己的注册。

[`src/client/connection.ts`](src/client/connection.ts) 为每个浏览器插件在 `dingtalk` Remote 上创建一个来自 [CLI 插件页零件](../ui-cli-account/README.zh.md)的 `CliAccountConnection`，并只根据 Host 的视图推导页面状态。该连接只为本浏览器发起的操作打开链接，只打开一次，并且只用 HTTPS。[`src/client/DingtalkConnection.tsx`](src/client/DingtalkConnection.tsx) 用钉钉的操作渲染共享的区块、退出确认、标签、激活提示和提示条；Web shell 以平台模块提供该共享库，因此本包的 bundle 不包含它。它注册以 `@deepseek-ai/dsh-dingtalk` 为 key 的 `plugins.bundle.config` 作为区块，`plugins.bundle.activation` 作为引导，`plugins.detail.badge` 作为标签，以及一个 `shell.overlay` 提示条。页面文案，包括共享零件读取的键，都在本包的 `dingtalk` 字典中。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [钉钉插件](../../connector/dingtalk/README.zh.md) — 插入本行和 Host 行的 bundle。
- [钉钉 CLI 与技能](../../connector/dingtalk-cli/README.zh.md) — Host 行，以及本页面发起的账号操作。
- [CLI 插件页零件](../ui-cli-account/README.zh.md) — 本页面渲染的共享连接镜像和组件。
- [ui-plugin-manager](../ui-plugin-manager/README.zh.md) — 插件页，以及本页面注册进去的 bundle 插槽。

-----

<a id="model-experience"></a>
## 模型体验

无，本包是浏览器端页面，不注册任何面向模型的内容。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 页面每次订阅时检查账号，没有定期检查，因此在用户终端里的登录或退出会在页面重新打开后显示。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
