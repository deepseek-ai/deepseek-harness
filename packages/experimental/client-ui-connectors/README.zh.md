---
description: "在插件页的标签中列出、安装和打开官方连接器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-connectors

[English](README.md) | 中文

## 概述

插件页的“连接器”标签列出官方连接器，每行带品牌图标和“已安装”列表上的开关。打开未安装连接器的开关，会安装与当前 DSH 版本相同的包并开启它；点已安装连接器的名称会打开它的详情页。“已安装”标签的卡片列表把连接器留给本标签，关闭“连接器”bundle 会停止所有连接器。

## 目录

- [使用本包](#use-this-package)
- [实现原理](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

启用 [“连接器”bundle](../connectors-bundle/README.zh.md)。本包没有配置项。每一行以界面语言显示连接器的品牌图标、名称和简介，以及它在“已安装”列表的卡片上会显示的开关。打开 profile 未持有的连接器的开关，会以当前 DSH 版本打开安装对话框，装好后开启该连接器，并在本标签上显示它的账号引导；构建中没有 DSH 版本时，这类连接器不显示开关。连接器只在 bundle 开启时运行：关闭 bundle 会停止所有连接器，但保留每个连接器自己的开关；重新开启后，它们恢复运行。

-----

<a id="understand-the-implementation"></a>
## 实现原理

<details>
<summary>实现细节 — 点击展开</summary>

Host 入口在 bundle 开启期间提供 `connectors` 服务。声明了 `inject: [connectors]` 的连接器条目在没有这个服务时保持等待，所以无论开关在哪里切换，Loader 都会随之停止或恢复连接器。浏览器入口把标签注册到 `plugins.tab`。`ConnectorsController` 在标签首次渲染时读取 `pluginManager.listBundles`，收到 `plugin-manager/changed` 和 `connection/reset` 时再次读取，只采用最新一次读取的结果。每一行渲染插件页的 `renderEnableSwitch`，未安装的连接器附带安装目标 `<包名>@<DSH_CLIENT_VERSION>`；点已安装连接器的名称会调用 `openPackage`。每个连接器的品牌图标是其 bundle 所声明 `icon.svg` 的副本，放在 `src/client/assets/` 下。连接器名单是 [`dsh-official-bundles`](../../util/official-bundles/README.zh.md) 的 `CONNECTOR_BUNDLES`，插件页也据此把它们排除在卡片列表之外；每个连接器的名称、简介和图标放在本包中，所以标签能显示 profile 尚未持有的连接器。

- [Host 源码](src/index.ts)
- [浏览器源码](src/client/index.ts)
- [测试](tests/)

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [“连接器”bundle](../connectors-bundle/README.zh.md) — 启用本标签的可选 bundle。
- [插件页](../../client/ui-plugin-manager/README.zh.md) — 页面标签、安装对话框，以及把连接器留给本标签的卡片列表。

<a id="model-experience"></a>
## 模型体验

间接影响来自“安装”添加的连接器 bundle：每个已安装的连接器负责自己面向模型的内容，标签本身不增加工具或提示词。

#### KV Cache 效果

标签不增加模型上下文。已安装或已开启的连接器按其说明改变后续请求；关闭 bundle 后，所有连接器的内容都从后续请求中移除，直到重新开启。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 名单只包含 DSH 发布的连接器；新增连接器时，要把包名加入 `CONNECTOR_BUNDLES`，在这里加上它的文案和图标，并在它的条目上声明 `inject: [connectors]`。
- 每一行不显示账号连接状态，连接状态在连接器的详情页查看。
- 安装要求连接器包已按当前 DSH 版本发布。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
