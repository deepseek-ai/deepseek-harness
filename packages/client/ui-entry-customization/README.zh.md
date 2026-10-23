---
description: "为三个导航区域的更多菜单提供插件浏览与创造模式草稿。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-entry-customization

[English](README.md) | 中文

桌面端产品事件使用可选的[产品埋点服务](../product-analytics/README.zh.md)，不包含普通 Web 交互。

## 概述

为左侧栏、会话 View 标签和右侧栏起始页的“更多”菜单提供插件浏览与可审阅的创造模式草稿。Web 应用默认加载本包。各区域自己画“更多”按钮；本包不保存状态。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

`@deepseek-ai/dsh-web-app` 组合包默认加载本包，无需在插件页开启或由 profile 选择。区域只在其 actions slot 有注册项时显示“更多”按钮，因此卸载本包会移除三个按钮。

打开左侧导航入口下方的**更多**、会话 View 标签之后的**更多会话视图**，或右侧栏起始页卡片之后的**更多工具**。左侧栏和起始页菜单仅提供**浏览更多插件**（可用时）与**创建你的插件**。会话菜单在这些操作之前列出收起的 View，并在当前 View 右侧显示勾选标记。所有菜单都不提供 Pin 或排序操作。

**浏览更多插件**进入插件页主列表，不打开安装弹窗。**创建你的插件**用 Creator 预设打开新 Session 或可复用的空白 Session，并把对应区域的简短本地化插件创建请求加入草稿：空草稿直接以该请求为文字，已有草稿保留其文字、引用和附件，请求另起一段追加在后面。它绝不发送消息。请自行审阅并发送草稿。无论区域是否有入口，创建操作始终可用；分隔线仅显示在收起的 View 与操作之间，浏览可用时位于浏览之前，否则位于创建之前。

在桌面端，**浏览更多插件**与**创建你的插件**在执行前上报 `more_menu_item_click`，`action` 为 `browse_plugins` 或 `create_plugin`，`region` 为菜单所在区域：**更多**为 `sidebar`，**更多会话视图**为 `conversation`，**更多工具**为 `rightbar`。菜单不上报曝光事件。没有埋点服务时，两项操作行为不变且不上报。

「浏览插件」一行只在 `pluginNavigation` 服务存在时出现；没有该服务时插件照常启动。该服务缺失时仅移除浏览操作，不影响“更多”按钮、收起的 View 或创建操作。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[`apply`](src/client/index.ts) 通过 `ctx.slots.inject` 以 id `entry-customization` 把 [`EntryMenuContent`](src/client/EntryMenuContent.tsx) 注册到 `sidebar.panellist.actions`、`conversation.session.header.views.actions` 和 `sidebar.right.tab.guide.actions`，每个注册项跟随所在区域声明的生命周期。各区域在自己的 `Menu` 中渲染这些 slot；菜单行先调用 `onDismiss`，再执行浏览或创建操作。仅会话菜单消费 owner 提供的收起入口列表及导航回调；Pin 回调不被消费。

每个注册项的 `inject` 提供所属区域与两个回调。每个回调先调用 `ctx.get('productAnalytics')?.track('more_menu_item_click', { region, action })`。浏览随后调用 `ctx.get('pluginNavigation')?.openList()`；ui-plugin-manager 只在插件页有权限时提供该服务，因此本包按可选方式读取，不把它写进 `inject`。创建随后按区域取本地化提示语，调用 `uiWorkspace.startSession(undefined, { agentPreset: 'cordis', prompt, whenDraftExists: 'append' })`；该调用不经过 `ui-agent-preset`，预设标签不播放介绍动画。[`dsh-web-app` bundle patch](../../bundle/web-app/cordis.patch.yml) 挂载浏览器插件。

</details>

-----

<a id="model-experience"></a>
## 模型体验

无。本包管理浏览器入口并准备未发送、可审阅的草稿；仅用户提交才会将其文字发送给模型。

#### KV Cache 影响

无；本包既不组装也不发送模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 更多菜单不提供入口显隐管理。其他注册项仍可调用区域 Pin 回调，仅修改内存中的选择；插件重新加载后恢复默认值。
- 不读取或写入 localStorage 中的旧 Pin 值。
- **创建你的插件**不检查 Creator 预设是否存在。预设缺失时 Session 创建失败，Workspace 显示创建失败提示，不准备草稿。草稿准备还要求可确定目标 Workspace；没有目标时，现有流程提示需要 Workspace。
- 会话区域负责按估算值分组；菜单不提供排序。
- 会话控件遵循现有非空 Session 头部与代码工作工具的可用性规则。右侧栏控件要求已选择 Session，并显示在其起始页。
- 菜单不列出插件清单；使用浏览操作进入插件页。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
