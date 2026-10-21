---
description: "从插件管理页启用实验性的自定义插件市场。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-plugin-market-bundle

[English](README.md) | 中文

## 概述

此可选组合包（bundle）挂载自定义插件市场：Host 的 [`pluginMarket`](../../boot/plugin-market/README.zh.md) 服务读取用户添加的插件市场索引，Web 端提供插件页的[发现标签页](../../client/ui-plugin-market/README.zh.md)。随包配置默认禁用。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

打开 Web 侧栏中的**插件**，点击**实验性插件**旁的**更多**，启用**自定义插件市场**；启用后它也会出现在主列表中。页面随后显示**已安装**和**发现**两个标签页；**发现**用于添加索引源并安装其中的组合包。禁用此组合包会移除发现标签页和 `plugin_market` 工具；已保存的索引源保留在 profile 中。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

静态 `cordis.patch.yml` 插入 `plugin-market` 服务行和 `ui-plugin-market` 浏览器行；与 `plugin-manager` 一样，服务行在没有 profile 时被禁用。Creator 预设保留其 `tool-plugin-market` 行；该插件只在 `pluginMarket` 已挂载时注册 `plugin_market`，因此没有此组合包时，该行既不等待，也不显示该工具。插件页只在存在 `plugins.tab` 条目时显示标签页，因此无需了解此组合包。

</details>

-----

<a id="model-experience"></a>
## 模型体验

该包通过 `pluginMarket` 服务间接影响模型：启用此组合包后，Creator 预设获得只读的 `plugin_market` 工具，其说明见 [`dsh-plugin-market`](../../boot/plugin-market/README.zh.md#model-experience)。

#### KV Cache 影响

启用或禁用此组合包会在 Creator 会话中增加或移除一个工具 schema，从而改变后续请求的缓存请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 目前没有官方插件市场；发现标签页只列出用户添加的索引源。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

无。

</details>
