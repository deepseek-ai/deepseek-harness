---
description: "在插件页的标签中列出、安装和打开官方连接器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-connectors

[English](README.md) | 中文

## 概述

插件页的“连接器”标签列出官方连接器，每行带品牌图标。profile 未持有的连接器显示**安装**，点击后通过插件页的安装对话框安装与当前 DSH 版本相同的包；已安装的连接器显示它的状态，并且与“已安装”列表的卡片一样，点这一行会打开它的详情页。

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

启用 [“连接器”bundle](../connectors-bundle/README.zh.md)。本包没有配置项。每一行以界面语言显示连接器的品牌图标、名称和简介。profile 未持有的连接器显示**安装**，点击后插件页的安装对话框直接进入检查步骤，安装目标是该连接器在当前 DSH 版本的包；安装完成后，对话框提供**立即启用**。构建中没有 DSH 版本时，不显示“安装”。已安装的连接器显示**已安装**或**已开启**；点这一行会打开它的详情页，详情页的返回键会回到本标签。已安装的连接器在“已安装”标签中保留自己的卡片和开关，无论 bundle 是否开启都会运行。

-----

<a id="understand-the-implementation"></a>
## 实现原理

<details>
<summary>实现细节 — 点击展开</summary>

Host 入口是一个空插件，浏览器入口把标签注册到 `plugins.tab`。`ConnectorsController` 在标签首次渲染时读取 `pluginManager.listBundles`，收到 `plugin-manager/changed` 和 `connection/reset` 时再次读取，只采用最新一次读取的结果。**安装**以 `<包名>@<DSH_CLIENT_VERSION>` 调用插件页提供的 `install`；已安装连接器的名称按钮覆盖整行，点击会调用 `openPackage`。每个连接器的品牌图标是其 bundle 所声明 `icon.svg` 的副本，放在 `src/client/assets/` 下。连接器名单以及每个连接器的名称、简介和图标都放在本包中，所以标签能显示 profile 尚未持有的连接器。

- [Host 源码](src/index.ts)
- [浏览器源码](src/client/index.ts)
- [测试](tests/)

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [“连接器”bundle](../connectors-bundle/README.zh.md) — 启用本标签的可选 bundle。
- [插件页](../../client/ui-plugin-manager/README.zh.md) — 页面标签和安装对话框。

-----

<a id="model-experience"></a>
## 模型体验

间接影响来自“安装”添加的连接器 bundle：每个已安装的连接器负责自己面向模型的内容，标签本身不增加工具或提示词。

#### KV Cache 效果

标签不增加模型上下文。已安装或已开启的连接器按其说明改变后续请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 名单只包含 DSH 发布的连接器；新增连接器时，要在这里加上它的包名、文案和图标。每一行的名称和简介是本包的文案，须跟随连接器自身的显示名称，没有检查比对两者。
- 每一行不显示账号连接状态，连接状态在连接器的详情页查看。选择**立即启用**后，连接器提供的账号引导显示在“已安装”标签中。
- 安装要求连接器包已按当前 DSH 版本发布。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
