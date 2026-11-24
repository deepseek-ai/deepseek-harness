---
description: "启用插件页的“连接器”标签，用来列出、安装和打开官方连接器。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-client-ui-connectors

[English](README.md) | 中文

## 概述

开启“连接器”后，Web 或 Desktop 插件页的“已安装”旁会多出“连接器”标签。标签列出官方连接器及其品牌图标：未安装的可以按当前 DSH 版本安装，已安装的可以开启或关闭，也可以打开它的详情页，在那里连接账号。随附的 profile 默认不启用这个 bundle，插件页在“实验性插件”下列出它。

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

打开**插件**，在**实验性插件**下启用**连接器**。也可在目标 [profile](../../boot/app-boot/README.zh.md#profiles) 的 `package.json` 中，将 `@deepseek-ai/dsh-client-ui-connectors` 加入 `dsh.profile.bundles`。之后“已安装”旁会出现“连接器”标签；关闭这个 bundle 会移除标签。本包没有配置项。

每一行以界面语言显示连接器的品牌图标、名称和简介。profile 未持有的连接器显示**安装**，点击后插件页的安装对话框直接进入检查步骤，安装目标是该连接器在当前 DSH 版本的包；安装完成后，对话框提供**立即启用**。构建中没有 DSH 版本时，不显示“安装”。已安装的连接器显示一个开关，连接器已启用时开关为开；这个开关启用或停用该连接器，和它在“已安装”标签中卡片上的开关一样。点这一行的其余位置会打开连接器的详情页，详情页的返回键会回到本标签。Host 未能应用更改时，标题下方会有一行文字指出是哪个连接器，开关显示 Host 报告的状态。已安装的连接器在“已安装”标签中保留自己的卡片和开关，无论这个 bundle 是否开启都会运行。

-----

<a id="understand-the-implementation"></a>
## 实现原理

<details>
<summary>实现细节 — 点击展开</summary>

bundle 补丁插入本包自己的一行。Host 入口是一个空插件，浏览器入口把标签注册到 `plugins.tab`。`ConnectorsController` 在标签首次渲染时读取 `pluginManager.listBundles`，收到 `plugin-manager/changed` 和 `connection/reset` 时再次读取，只采用最新一次读取的结果。已安装连接器的开关调用 `pluginManager.setBundleEnabled`，在写入之后的那次读取结束前保持禁用；调用被拒绝或应用结果为 `failed` 时，失败提示会指出该连接器，直到下一次切换开始。**安装**以 `<包名>@<DSH_CLIENT_VERSION>` 调用插件页提供的 `install`；已安装连接器的名称按钮覆盖整行，点击会调用 `openPackage`。每个连接器的品牌图标是其 bundle 所声明 `icon.svg` 的副本，放在 `src/client/assets/` 下。连接器名单以及每个连接器的名称、简介和图标都放在本包中，所以标签能显示 profile 尚未持有的连接器。

- [bundle 补丁](cordis.patch.yml)
- [Host 源码](src/index.ts)
- [浏览器源码](src/client/index.ts)
- [测试](tests/)

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [插件页](../../client/ui-plugin-manager/README.zh.md) — 页面标签和安装对话框。

-----

<a id="model-experience"></a>
## 模型体验

间接影响来自“安装”添加的连接器 bundle，以及开关启用或停用的连接器 bundle：每个连接器负责自己面向模型的内容，标签本身不增加工具或提示词。

#### KV Cache 效果

标签不增加模型上下文。安装连接器，或者开启、关闭连接器，会按该连接器的说明改变后续请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 名单只包含 DSH 发布的连接器；新增连接器时，要在这里加上它的包名、文案和图标。每一行的名称和简介是本包的文案，须跟随连接器自身的显示名称，没有检查比对两者。
- 每一行不显示账号连接状态，连接状态在连接器的详情页查看。选择**立即启用**后，连接器提供的账号引导显示在“已安装”标签中。
- 在本标签中开启连接器时不显示账号引导；更改需要重启才生效时，也不显示重启提示。连接器在“已安装”标签中卡片上的开关会显示这两项。本标签的开关不发送 `plugin_toggle` 分析事件。
- 安装要求连接器包已按当前 DSH 版本发布；开发构建改用 `dsh plugin add` 安装连接器。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
