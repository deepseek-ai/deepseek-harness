---
description: "为三个导航区域的“更多”菜单提供 Pin 控件、插件浏览与创造模式草稿。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-entry-customization

[English](README.md) | 中文

桌面端产品事件使用可选的[产品埋点服务](../product-analytics/README.zh.md)，不包含普通 Web 交互。

## 概述

为左侧栏、会话 View 标签和右侧栏起始页的“更多”菜单提供内容：各区域可自定义的入口、Pin 按钮、插件浏览与可审阅的创造模式草稿。Web 应用默认加载本包。各区域自己画“更多”按钮并保存自己的 Pin 状态；本包不保存状态。

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

打开左侧导航入口下方的**更多**、会话 View 标签之后的**更多会话视图**，或右侧栏起始页卡片之后的**更多工具**。每个菜单按注册顺序列出该区域可自定义的入口；插件管理、Chat 和工作区文件始终显示，不列入菜单。点击入口名称会关闭菜单并打开该入口，不改变 Pin 状态。独立的 Pin 按钮在区域中固定或收起该入口，并保持菜单打开；实心 Pin 表示已固定。已收起的入口仍可从菜单打开，Pin 状态在刷新后保留。过长的入口名称会换行，更多工具菜单中则截断为单行。

**浏览更多插件**进入插件页主列表，不打开安装弹窗。**创建你的插件**用 Creator 预设打开新 Session 或可复用的空白 Session，并把对应区域的简短本地化插件创建请求加入草稿：空草稿直接以该请求为文字，已有草稿保留其文字、引用和附件，请求另起一段追加在后面。它绝不发送消息。请自行审阅并发送草稿。当前区域没有可自定义入口时，两项操作仍然可用；空列表不添加分隔线。

在桌面端，**浏览更多插件**与**创建你的插件**在执行前上报 `more_menu_item_click`，`action` 为 `browse_plugins` 或 `create_plugin`，`region` 为菜单所在区域：**更多**为 `sidebar`，**更多会话视图**为 `conversation`，**更多工具**为 `rightbar`。打开入口和更改 Pin 状态不上报，菜单也不上报曝光事件。没有埋点服务时，两项操作行为不变且不上报。

「浏览插件」一行只在 `pluginNavigation` 服务存在时出现；没有该服务时插件照常启动。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[`apply`](src/client/index.ts) 通过 `ctx.slots.inject` 以 id `entry-customization` 把 [`EntryMenuContent`](src/client/EntryMenuContent.tsx) 注册到 `sidebar.panellist.actions`、`conversation.session.header.views.actions` 和 `sidebar.right.tab.guide.actions`，每个注册项跟随所在区域声明的生命周期。各区域在自己的 `Menu` 中渲染这些 slot，并以 owner props 提供入口、Pin 状态、`onOpen`、`onPinnedChange` 与 `onDismiss`。菜单行先调用 `onDismiss`，再打开入口或执行底部操作；Pin 变化不关闭菜单。

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

- 用户收起入口后，若本包被停用或加载失败，被收起的入口保持隐藏，且没有“更多”菜单可以恢复。重新启用本包或清除对应区域的 `dsh.slot.manual-order.*.v1` localStorage 键即可恢复。
- Pin 状态保存在浏览器 localStorage，按协议、主机和端口隔离：更换 Web 端口或在 Web 与 Desktop 之间切换时不共享，也不跨设备同步。
- **创建你的插件**不检查 Creator 预设是否存在。预设缺失时 Session 创建失败，Workspace 显示创建失败提示，不准备草稿。草稿准备还要求可确定目标 Workspace；没有目标时，现有流程提示需要 Workspace。
- 入口保持注册顺序；菜单不提供排序，入口也不能跨区域移动。
- 会话控件遵循现有非空 Session 头部与代码工作工具的可用性规则。右侧栏控件要求已选择 Session，并显示在其起始页。
- 仅显示已激活、已注册的入口；菜单不是已停用或未安装插件的清单。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
