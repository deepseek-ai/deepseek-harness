---
description: "会话面板：会话标题栏开关与主对话区上方的悬浮面板，分栏由其他插件注册，并内置「环境」分栏。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-panel

[English](README.md) | 中文

## 概述

`dsh-client-ui-session-panel` 在会话标题栏加一个开关，用来显示或隐藏一块汇总当前会话信息的悬浮面板。主对话区末端留白放得下面板时，面板停靠在留白里；放不下时，按需浮在对话正文上方。面板只绘制分栏标题，分栏内容交给注册分栏的插件；本包内置「环境」分栏及其项目目录行。

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

`@deepseek-ai/dsh-web-app` 套件默认加载本包。开关是会话标题栏的第一个工具按钮，位于共享和计划任务目录之前。它是图标按钮：无障碍名称由面板名称和其角标组成，提示文字说明按下后是显示还是隐藏面板，`aria-expanded` 表示面板当前是否显示。

### 停靠与浮层

正文列到对话区末端边缘的留白不少于 344px 时，面板停靠：与正文列及其宽度手柄保持 48px 间距，面板最小宽度 280px，外加 16px 边距。停靠时面板宽 280–340px，位于标题栏下方 12px，内容在面板内滚动。此时按开关会切换所有会话共用的停靠偏好，偏好存放在 `localStorage` 的 `dsh.sessionPanel.pinned` 中；默认停靠。

留白更窄时隐藏停靠面板，保证不遮挡正文。窗口变窄、展开右侧栏、把正文列拖宽，以及切换到 Chat 以外的视图（这些视图占满对话区）都会如此。此时按开关，面板以更强的阴影浮在正文上方，位于输入框区域之上，且不遮挡输入框。浮层可以用开关关闭，也会在按 Esc 时，或在面板、开关和任何已打开的菜单（例如行的上下文菜单）之外按下指针时关闭；焦点原本在面板内时，按 Esc 后焦点回到开关，页面上方有模态框时 Esc 归模态框处理。关闭浮层不改变停靠偏好。同一时间最多一个会话的浮层处于打开状态，在宽留白下切换停靠也会关闭它。

<a id="contribute-a-section"></a>
### 贡献分栏

一个分栏是 `conversation.session.panel.section` 列表里的一次注册：`id` 用于寻址，`order` 升序排列，必填的 `label` 是标题，面板按当前语言绘制。分栏组件通过 owner props 收到 `presentation`（`docked` 或 `overlay`）和 `dismissOverlay()`；它负责渲染正文，没有内容时什么都不渲染，标题随之隐藏。标题尾部的控件（例如计数或刷新按钮）注册到以分栏 `id` 为键的 keyed slot `conversation.session.panel.section.actions`。缺少 label 的分栏会报告到控制台，并且不显示。内置的分栏依次是「环境」（`order: 0`）、[forge 套件](../../experimental/client-ui-forge/README.zh.md)的「变更请求」（`100`）、[「子智能体」](../ui-subagent/README.zh.md)（`200`）和[「后台任务」](../ui-jobs/README.zh.md)（`300`）。

多个插件共用一个标题时，把行注册到分栏拥有者的行 slot 中。内置「环境」分栏（`id: 'environment'`，`order: 0`）声明 `conversation.session.panel.environment.row`，其中的行与分栏收到相同的 owner props；其 `project` 行（`order: 0`）显示列出本会话的工作区目录，或会话创建时所在的目录，宿主家目录缩写为 `~`。右键该行或点其「更多」按钮会打开共享的 `directory` 上下文菜单。forge 套件在 order 20 与 30 处添加检出行与本地变更行。拥有共享分栏的插件用同样方式声明自己的行 slot。

面板隐藏时也要可见的标记（例如需要处理的红点）放进 `conversation.session.panel.indicator` 列表。每个占位都带有说明自身的文字，这些文字会成为开关无障碍名称的一部分。

各包的摘要行都使用 `PanelRow` 原语，使不同分栏的图标、文字与尾部区域对齐。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

开关与面板是两个独立的 Slot 条目，共享一个插件持有的可见性 source：持久化的停靠偏好，以及打开了浮层的会话。两者都从 `ctx.uiConversation.layouts` 读取该会话的主对话区几何信息（由 Conversation 宽度控件在已有的测量中写入），并用同一个纯函数决定呈现方式，因此开关状态始终与面板一致。面板渲染在主对话区内部，对话区持有其定位上下文、正文轴线和输入框区域高度。

面板把分栏列表的实时注册（`entriesOfSlot`，因此同 `id` 且优先级更高的注册会替换已发布的分栏）投影为 `{ id, label }` 行，只在台账版本或语言版本变化时重新计算。它在各分栏自己的标题和正文容器里用 `renderSlot(..., { only: id })` 渲染内容；CSS `:has()` 规则隐藏正文出口为空的分栏，也包括行出口为空的共享分栏。

| 文件 | 作用 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | 字典、开关、面板、「环境」分栏与项目行 |
| [`src/client/slots.ts`](src/client/slots.ts) | Slot 声明与组件 props |
| [`src/client/visibility.ts`](src/client/visibility.ts) | 停靠阈值、呈现方式与共享可见性状态 |
| [`src/client/sections.ts`](src/client/sections.ts) | 分栏名单投影 |
| [`src/client/SessionPanel.tsx`](src/client/SessionPanel.tsx) | 面板、分栏标题与 Esc 处理 |
| [`src/client/SessionPanelToggle.tsx`](src/client/SessionPanelToggle.tsx) | 标题栏开关及其角标 |
| [`src/client/ProjectRow.tsx`](src/client/ProjectRow.tsx) | 项目目录行 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Web Client Slots](../../../docs/subsystems/slots.zh.md)——分栏依赖的 list、keyed 与 owner props 语义。
- [`dsh-client-ui-conversation`](../ui-conversation/README.zh.md)——会话标题栏工具区、面板落位与主对话区几何信息。
- [`dsh-client-ui-primitives`](../ui-primitives/README.zh.md#component-catalog)——`PanelRow` 与 `PathLabel`。

-----

<a id="model-experience"></a>
## 模型体验

无。本包为用户展示客户端已有的信息，不涉及任何 prompt、消息、schema、流或工具结果。

#### KV 缓存影响

无；本包从不组装或发送模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制定义的是当前包的约束，而非任务待办清单。

- **笔记本宽度下使用浮层而非停靠**——在默认正文宽度下，对话区宽度需约 1608px 以上才能停靠；更窄时使用浮层。通过把正文列移开来停靠属于另一项布局决策。
- **没有运行环境行**——客户端没有区分本机、SSH 主机或沙箱模式的会话级信息，因此「环境」分栏只显示项目目录。
- **不能自定义分栏**——所有有内容的分栏都会显示；面板不提供隐藏或重新排序分栏的功能。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作语境——点击展开</summary>

无。

</details>
