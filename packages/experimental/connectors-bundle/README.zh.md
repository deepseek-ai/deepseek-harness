---
description: "启用插件页的“连接器”标签。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-connectors-bundle

[English](README.md) | 中文

## 概述

开启“连接器”后，Web 或 Desktop 插件页的“已安装”旁会多出“连接器”标签。标签列出官方连接器及其品牌图标：未安装的可以按当前 DSH 版本安装，已安装的可以打开它的详情页，在那里连接账号。随附的 profile 默认不启用这个 bundle，插件页在它开启前也不列出它。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在**插件 → 添加插件**中输入 `@deepseek-ai/dsh-experimental-connectors-bundle`，选择**安装**，再选择**立即启用**。DSH 使用随包提供的版本，无需再次下载。也可在目标 [profile](../../boot/app-boot/README.zh.md#profiles) 的 `package.json` 中，将包名加入 `dsh.profile.bundles`。之后“已安装”旁会出现“连接器”标签；关闭这个 bundle 会移除标签，它的卡片也会再次隐藏。profile 未持有的连接器显示**安装**，点击后按当前 DSH 版本打开安装对话框，装好后可选择**立即启用**。已安装的连接器显示**已安装**或**已开启**；点这一行会打开它的详情页，详情页的返回键会回到这个标签。已安装的连接器在“已安装”中保留自己的卡片和开关，无论这个 bundle 是否开启都会运行。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>维护者细节 — 点击展开</summary>

bundle 补丁插入一个浏览器行 [client-ui-connectors](../client-ui-connectors/README.zh.md)，它负责连接器列表、文案和标签。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

[“连接器”标签](../client-ui-connectors/README.zh.md) · [插件页](../../client/ui-plugin-manager/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

间接影响来自标签安装的连接器 bundle：每个已安装的连接器负责自己的工具、技能和运行时上下文，标签本身不添加任何内容。

#### KV Cache 效果

安装或开启连接器后，后续请求按该连接器的说明变化；标签本身不添加模型上下文。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 从标签安装要求连接器包已按当前 DSH 版本发布；开发构建改用 `dsh plugin add` 安装连接器。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
