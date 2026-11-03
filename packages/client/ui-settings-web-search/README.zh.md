---
description: "dsh Web 客户端插件页上的网页搜索与获取设置页：Search 与 Fetch 提供方下拉框、DeepSeek Search API 的结果数，以及旧版 Messages 搜索的设置。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-web-search

[English](README.md) | 中文

## 概述

在侧栏打开**插件**，在官方分组里选择**网页搜索与获取**，即可选择网页搜索和网页获取使用的提供方、设置 Search API 的结果数，或配置旧版 Messages 搜索。DeepSeek Search 与 Fetch API 在这里没有凭据设置：它们使用会话的 DeepSeek 账号或 DeepSeek API Key。页面只在保存时写入；旧版搜索的密钥经凭据域写入。页面在 Host 服务 `web` 命名空间期间存在；各官方提供方的控件只在 Host 服务该提供方命名空间时显示。

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

官方分组里的**网页搜索与获取**卡片打开这一页。页面分为**网页搜索提供方**与**网页获取提供方**两节，每节标题下方紧接一个提供方下拉框。下拉框列出 Host 注册的全部提供方，包括插件注册的提供方，因此新安装的提供方无需修改本页；在 profile 中挂载提供方的方法见[添加其他提供方](../../web/web/README.zh.md#adding-a-provider)。已注册的官方提供方排在最前：搜索下拉框依次为 **DeepSeek Search API**（`deepseek-search-api`）与 **DeepSeek（旧版）**（`deepseek-official`），获取下拉框依次为**本机直接获取**（`http`）和 **DeepSeek Fetch API**（`deepseek-fetch-api`）；其他提供方按注册顺序排在其后，显示其注册的标题或 id。随附组合默认搜索选择 DeepSeek Search API、获取选择本机直接获取，设置中已存的选择或部署组合的选择仍然生效；打开页面不会写入任何内容。下拉框没有单独的标签，其无障碍名称由所在节的标题和当前选中的提供方组成，例如**网页搜索提供方 DeepSeek Search API**。Host 未注册的已选 id 额外显示为一项**（未加载）**，并保持选中。部署没有为某项能力组合提供方时，其下拉框首项为**自动选择**，选中它会清除已存的选择，由 Host 重新选择。选择部署组合的提供方时清除已存的选择，而不写入一份副本。提供方列表读取失败时，每节提示其下拉框可能不完整并提供**重试**；下拉框保留上一次读到的列表，尚未读到任何列表时只包含已选 id。每节在下拉框下方以纯文本显示所选提供方注册的 `description`（按当前语言）；未注册说明的提供方或 Host 未注册的已选 id 不显示说明。官方提供方的说明写明各自的凭据、计费、模型调用、可访问的地址和内容限制，本机直接获取的说明末尾以纯文本建议改用 DeepSeek Fetch API。插件提供方所在的节在其说明之后提示到该插件自己的设置中配置。

**网页搜索提供方**一节中，DeepSeek Search API 在说明之后显示 DeepSeek 网页搜索与获取指南链接，下拉框下方的灰色面板中是**每次搜索结果数**（1–50 的整数，默认 10；无效值阻止保存）。DeepSeek Fetch API 所在节显示提供方下拉框及说明。两个 API 都跟随会话的 DeepSeek 凭据，单独配置的端点字段只能在 YAML 中设置（[web-deepseek-api 鉴权](../../web/web-deepseek-api/README.zh.md#authentication)）。在本页没有设置项的提供方（例如 DeepSeek Fetch API、本机直接获取或插件提供方）不显示面板。所有控件直接位于所在节中，没有折叠区。

**DeepSeek（旧版）**在同样的面板布局中显示 API Key、独立的 Messages Base URL 与**单次请求最多搜索次数**（`maxUses`，正整数，默认 5）。密钥写入 `web-search-deepseek.apiKeyEnv` 指向的引用（默认 `DEEPSEEK_API_KEY`）；端点和次数上限写入 `web-search-deepseek`，与 API 设置分开。切换其他提供方会丢弃未保存的密钥，但保留端点和次数设置。

数值字段显示生效值，一旦被覆盖就带**已覆盖**标签和**恢复默认**，清空后保存等于重置；填写部署默认值则作为覆盖值保存。暂存了无效编辑或保存失败时提供方下拉框不可用，以免切换后隐藏的字段不再可见。

对已隐藏提供方字段的暂存编辑会被保留并保存。一次保存先写入提供方设置再写入选择，因此某一节被拒绝时选择不会保存。点击**保存**之前不会写入任何内容；离开页面即丢弃草稿。API 行为见 [web-deepseek-api](../../web/web-deepseek-api/README.zh.md#use-this-package)。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

宿主半侧是一个空的 `apply`，只为让本包占一条 Loader 行，客户端模块系统据此送出浏览器半侧。浏览器半侧通过 `ctx.configForms.get` 绑定 `web`、`web-search-deepseek` 和 `web-deepseek-api` 命名空间，在 `WebSearchCardController` 里为每个命名空间维护一个 `ui-primitives` 共享的 `SettingsFormModel`。下拉框在 `web` 中暂存 `searchProvider` 和 `fetchProvider`；目标值等于组合值时改为暂存重置；组合的 `base` 对该字段没有值时，下拉框提供**自动选择**项，选中它同样暂存重置。提供方列表来自 `remote.web.listProviders`，该列表保持注册顺序；控制器把已注册的官方提供方按固定顺序移到最前，其余保持 Host 顺序。列表在构造时、每次 `web/providers-changed` 事件、`connection/reset` 以及 `web` 命名空间开始被服务时读取；只有最新一次读取会发布，读取失败时保留上一份列表，并在快照中设置 `providersFailed`，直到之后某次读取成功；首次成功应答前下拉框只包含已选 id。面上的 `retryProviders` 沿用同一套序号与释放检查重新读取。`web-deepseek-api` 表单只暂存 `count`。选择表单的密文控件为 `legacyApiKey`，使用 `web-search-deepseek.apiKeyEnv` 引用。草稿记录输入时控件所使用的引用；每次重新发布时，页面不再显示该控件或引用已变化时丢弃草稿。保存在选择表单规划写入时固定草稿的引用，因此在提供方消失前已规划的密钥写入仍写到该引用。写入走 `remote.credentials.set`，是否成功由 `remote.credentials.describe` 回读判定，一次读取同时询问当前引用和刚写入的引用。控制器把同步发布的 scope 更新和引用切换合并成下一个微任务中的一次凭据读取；连接重置后的 scope 刷新也会重新同步凭据。引用变化会立即清除旧凭据状态。Host 对所监视引用发出 `credentials/reference-updated` 事件以及写入时，都会独立触发读取，即使此前的读取仍未完成。只有最新一次读取会更新卡片，且只在其引用未变时更新；保存使用自身的回读结果。释放控制器后不再执行排队的读取，也不再发布迟到的响应。`WebSearchCard` 用基于 `Menu` 基础组件的同一个本地下拉按钮渲染提供方下拉框，用 `SettingsSecretField` 和 `SettingsValueField` 渲染旧版搜索的字段。页面通过 `ctx.configForms.whileServed([web])` 把 `WebSearchCard` 注册进插件页的 `plugins.item` slot。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-plugin-manager](../ui-plugin-manager/README.zh.md)——插件页以及本页注册进去的 `plugins.item` slot。
- [ui-settings](../ui-settings/README.zh.md)——本页依赖的设置 scope 与"命名空间被服务期间"的监视。
- [ui-primitives](../ui-primitives/README.zh.md)——本页渲染的设置表单模型与字段。
- [credentials](../../credentials/README.zh.md)——旧版搜索密钥写入所经的凭据引用 seam。
- [web-deepseek-api](../../web/web-deepseek-api/README.zh.md)——Search 一节编辑其结果数的 Search 与 Fetch API 提供方。
- [web](../../web/web/README.zh.md)——下拉框使用的提供方选择与提供方列表。

-----

<a id="model-experience"></a>
## 模型体验

无，本包是浏览器侧的设置界面，不注册任何模型面。

#### KV 缓存影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **自动选择只看部署组合层**——组合层没有为该能力设置提供方时，下拉框才提供自动选择。自动选择生效时，Host 的 `DSH_WEB_SEARCH_PROVIDER` 或 `DSH_WEB_FETCH_PROVIDER` 环境变量会改为由它指定提供方，而页面不会显示这一选择。两者都没有时，如果注册了多个可用提供方，自动选择会让每次操作以 `WEB_PROVIDER_AMBIGUOUS` 失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
