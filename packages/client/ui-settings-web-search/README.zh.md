---
description: "dsh Web 客户端插件页上的 DeepSeek 网页搜索提供方设置页：API Key、接口地址与单次请求的搜索次数上限。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-web-search

[English](README.md) | 中文

## 概述

在侧栏打开**插件**，在官方分组里选择**网页搜索**，即可设置提供方的密钥、接口地址，以及一次请求最多可以搜索几次。页面暂存输入、只在保存时写入；密钥通过凭据域写入而不进设置文件，其明文从不出现在任何响应里。页面只在 Host 服务 `web-search-deepseek` 命名空间期间存在。

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

官方分组里的**网页搜索**卡片打开这一页。**API Key** 每次加载都是空的，只报告是否已配置密钥；留空保存等于保留现有密钥，而当凭据不能从这里写入时（例如由进程环境变量提供的密钥）该控件会被禁用。**接口地址**和**单次请求最多搜索次数**显示生效值，一旦被覆盖就带**已覆盖**标签和**恢复默认**，清空后保存等于重置。点击**保存**之前不会写入任何内容；离开页面即丢弃草稿。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

宿主半侧是一个空的 `apply`，只为让本包占一条 Loader 行，客户端模块系统据此送出浏览器半侧。浏览器半侧通过 `ctx.configForms.get` 绑定 `web-search-deepseek` 命名空间，用 `ui-primitives` 的共享 `SettingsFormModel` 在 `WebSearchCardController` 里维护暂存表单，密钥是表单里唯一的密文控件：写入走 `remote.credentials.set`，引用名取自本节的 `apiKeyEnv`（未指定时为 `DEEPSEEK_API_KEY`），是否成功由 `remote.credentials.describe` 回读判定。scope 变化时、以及 Host 对所监视引用发出 `credentials/reference-updated` 时，控制器都会重读凭据，因为在模型页写入的密钥不会改变任何设置节。页面通过 `ctx.configForms.whileServed` 把 `WebSearchCard` 注册进插件页的 `plugins.item` slot。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-plugin-manager](../ui-plugin-manager/README.zh.md)——插件页以及本页注册进去的 `plugins.item` slot。
- [ui-settings](../ui-settings/README.zh.md)——本页依赖的设置 scope 与"命名空间被服务期间"的监视。
- [ui-primitives](../ui-primitives/README.zh.md)——本页渲染的设置表单模型与字段。
- [credentials](../../credentials/README.zh.md)——密钥写入所经的凭据引用 seam。
- [web-search-deepseek](../../web/web-search-deepseek/README.zh.md)——注册该命名空间的提供方。

-----

<a id="model-experience"></a>
## 模型体验

无，本包是浏览器侧的设置界面，不注册任何模型面。

#### KV 缓存影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只编辑命名空间的三个字段**——提供方的模型、API 版本和 token 预算保持组合值不变；本页只编辑密钥、接口地址和搜索次数。
- **运行时不变量：**不发布伴生。本页没有自己拥有的关系：它显示的内容派生自设置镜像与凭据域，它写入的内容由 Host 校验。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
