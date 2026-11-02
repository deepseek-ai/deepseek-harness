---
description: "启用插件页的“连接器”标签。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-connectors-bundle

[English](README.md) | 中文

## 概述

在 Web 或 Desktop 的插件页开启“连接器”后，“已安装”旁会多出“连接器”标签。标签列出官方连接器：未安装的可以安装，已安装的可以打开它的详情页，在那里连接账号。连接器只在这个 bundle 开启时运行，关闭它会停止所有连接器。随附的 profile 默认不启用这个 bundle。

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

打开插件页，在“实验性插件”组中开启“连接器”，“已安装”旁就会出现“连接器”标签。每一行显示连接器是未安装、已安装还是已开启。“安装”会打开插件页的安装对话框，安装与当前 DSH 版本相同的连接器包。已安装连接器的按钮会打开它的详情页，详情页的返回键会回到这个标签。标签存在期间，已安装的连接器只出现在这里；关闭“连接器”会移除标签，已安装的连接器回到“已安装”。

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
