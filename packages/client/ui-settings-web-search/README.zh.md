---
description: "dsh Web 客户端插件页上的 DeepSeek 网页搜索设置页：Search 与 Fetch API 开关、API Key、接口地址与每次搜索的上限。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-web-search

[English](README.md) | 中文

## 概述

在侧栏打开**插件**，在官方分组里选择**网页搜索**，即可在 DeepSeek Messages 搜索与 DeepSeek Search 与 Fetch API 之间切换，并设置所选 API 的密钥、接口地址和每次搜索的上限。页面暂存输入、只在保存时写入；密钥通过凭据域写入而不进设置文件，其明文从不出现在任何响应里。页面只在 Host 服务 `web-search-deepseek` 命名空间期间存在。

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

官方分组里的**网页搜索**卡片打开这一页。**API Key** 每次加载都是空的，只报告是否已配置密钥；未配置时提示仅使用 DeepSeek 账号模型的对话可以通过默认接口地址搜索，因为这类搜索使用账号登录鉴权；留空保存等于保留现有密钥，而当凭据不能从这里写入时（例如由进程环境变量提供的密钥）该控件会被禁用。API 基础地址和当前模式的上限（Messages 的**单次请求最多搜索次数**或 Search API 的**每次搜索结果数**）显示生效值，一旦被覆盖就带**已覆盖**标签和**恢复默认**，清空后保存等于重置。点击**保存**之前不会写入任何内容；离开页面即丢弃草稿。

**启用新版 Web 搜索 API** 默认关闭，搜索继续使用 Messages，抓取继续使用本地 HTTP。提示中链接到 DeepSeek 网页搜索与抓取指南，说明新版 API 的功能与计费。开启并保存后同时选择 DeepSeek Search 与 Fetch API；关闭并保存后两项选择都恢复为部署默认值，部署默认已组合这两个 API 时则写入 Messages 搜索和本地 HTTP 抓取。只有 Host 同时提供 `web` 和 `web-deepseek-api` 命名空间时才显示该开关。开关开启时以**每次搜索结果数**（1–50 的整数，默认 10）代替仅适用于 Messages 的**单次请求最多搜索次数**，无效的结果条数会阻止保存。暂存了无效编辑或保存失败时开关不可用，以免它隐藏的字段不再可见。切换时分别保留两种模式的 API 基础地址。**Messages API 基础地址**与 **Search / Fetch API 基础地址**标签标明当前协议，提示说明应包含的前缀和程序追加的操作路径。一次保存先写入提供方设置再写入选择，因此某一节被拒绝时开关不会保存。API 行为见 [web-search-deepseek](../../web/web-search-deepseek/README.zh.md#use-this-package) 和 [web-deepseek-api](../../web/web-deepseek-api/README.zh.md#use-this-package)。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

宿主半侧是一个空的 `apply`，只为让本包占一条 Loader 行，客户端模块系统据此送出浏览器半侧。浏览器半侧通过 `ctx.configForms.get` 绑定 `web`、`web-search-deepseek` 和 `web-deepseek-api` 命名空间，在 `WebSearchCardController` 里为每个命名空间维护一个 `ui-primitives` 共享的 `SettingsFormModel`。开关在 `web` 中暂存 `searchProvider` 和 `fetchProvider`；目标值等于组合值时改为暂存重置。密钥是选择表单里唯一的密文控件：写入走 `remote.credentials.set`，引用名取自当前所选 API 设置节的 `apiKeyEnv`（未指定时为 `DEEPSEEK_API_KEY`），是否成功由 `remote.credentials.describe` 回读判定。控制器把同步发布的 scope 更新和引用切换合并成下一个微任务中的一次凭据读取；连接重置后的 scope 刷新也会重新同步凭据。引用变化会立即清除旧凭据状态。Host 对所监视引用发出 `credentials/reference-updated` 事件以及写入时，都会独立触发读取，即使此前的读取仍未完成。只有所选引用的最新读取会更新卡片；保存使用自身的回读结果。释放控制器后不再执行排队的读取，也不再发布迟到的响应。页面通过 `ctx.configForms.whileServed` 把 `WebSearchCard` 注册进插件页的 `plugins.item` slot。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-plugin-manager](../ui-plugin-manager/README.zh.md)——插件页以及本页注册进去的 `plugins.item` slot。
- [ui-settings](../ui-settings/README.zh.md)——本页依赖的设置 scope 与"命名空间被服务期间"的监视。
- [ui-primitives](../ui-primitives/README.zh.md)——本页渲染的设置表单模型与字段。
- [credentials](../../credentials/README.zh.md)——密钥写入所经的凭据引用 seam。
- [web-search-deepseek](../../web/web-search-deepseek/README.zh.md)——其命名空间决定页面是否出现的 Messages 搜索提供方。
- [web-deepseek-api](../../web/web-deepseek-api/README.zh.md)——开关选择的 Search 与 Fetch API 提供方。
- [web](../../web/web/README.zh.md)——开关写入的提供方选择。

-----

<a id="model-experience"></a>
## 模型体验

无，本包是浏览器侧的设置界面，不注册任何模型面。

#### KV 缓存影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只编辑命名空间的三个字段**——提供方的模型、API 版本和 token 预算保持组合值不变；本页只编辑密钥、接口地址和搜索次数。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
