---
description: "会话面板：会话标题栏开关与 Chat 视图侧边层中的悬浮面板，分栏由其他插件注册，并内置「环境」分栏。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-panel

[English](README.md) | 中文

## 概述

`dsh-client-ui-session-panel` 在会话标题栏加一个开关，用来显示或隐藏一块汇总当前会话信息的悬浮面板。面板只出现在 Chat 视图中：Chat 视图末端留白放得下面板时，面板停靠在留白里；放不下时，按需浮在对话正文上方。面板只绘制分栏标题，分栏内容交给注册分栏的插件；本包内置「环境」分栏及其工作目录行。

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

`@deepseek-ai/dsh-web-app` 套件默认加载本包。开关是会话标题栏的第一个工具按钮，位于变更请求、共享和计划任务目录之前。它是图标按钮：无障碍名称由面板名称和其角标组成，提示文字说明按下后是显示还是隐藏面板（悬停 500ms 后显示，键盘聚焦时立即显示），`aria-expanded` 表示面板当前是否显示。

### 停靠与浮层

正文列到 Chat 外框末端边缘的留白不少于 348px 时，面板停靠：与正文列及其宽度手柄保持 40px 间距，面板最小宽度 300px，外加 8px 边距。停靠时面板宽 300–360px，距末端边缘 8px，位于标题栏下方 12px，止于输入框区域上方，内容在面板内滚动，并为滚动条在距面板末端边缘 2px 处预留一列，因此无论是否滚动，内容宽度都不变。此时按开关会切换所有会话共用的停靠偏好，偏好存放在 `localStorage` 的 `dsh.sessionPanel.pinned` 中；默认停靠。

留白更窄时隐藏停靠面板，保证不遮挡正文。窗口变窄、展开右侧栏、把正文列拖宽都会如此。此时按开关，面板以更强的阴影浮在正文上方，宽 280px，比停靠时窄，以少遮挡正文，距末端边缘 8px，位于输入框区域之上，且不遮挡输入框。浮层可以用开关关闭，也会在按 Esc 时，或在面板、开关和任何已打开的菜单（例如行的上下文菜单）之外按下指针时关闭；焦点原本在面板内时，按 Esc 后焦点回到开关。页面上方有模态框、输入法正在组字，或已有处理程序（例如打开的菜单）接手了这次按键时，Esc 不归浮层；其余情况由浮层先处理，因此浮层打开时，在输入框按下的第一次 Esc 只关闭浮层，不计入停止当前轮次的连按。关闭浮层不改变停靠偏好。同一时间最多一个会话的浮层处于打开状态；留白变宽到可以停靠时，以及没有 Chat 视图再显示该会话时（例如切到其他会话或其他视图），浮层都会关闭，切回来也不会重新打开。面板隐藏时如果焦点在面板内，焦点移到开关。

轨迹等其他视图不显示面板。没有 Chat 视图显示该会话时，开关不可用：它连同角标留在标题栏中并变淡，悬停提示请用户切换到「对话」视图。

<a id="contribute-a-section"></a>
### 贡献分栏

一个分栏是 `conversation.session.panel.section` 列表里的一次注册：`id` 用于寻址，`order` 升序排列，必填的 `label` 是标题，面板按当前语言绘制。分栏组件通过 owner props 收到 `presentation`（`docked` 或 `overlay`）和 `dismissOverlay()`；它负责渲染正文，没有内容时什么都不渲染，标题随之隐藏。标题尾部的控件（例如计数或刷新按钮）注册到以分栏 `id` 为键的 keyed slot `conversation.session.panel.section.actions`。缺少 label 的分栏会报告到控制台，并且不显示。

多个插件共用一个标题时，把行注册到分栏拥有者的行 slot 中。内置「环境」分栏（`id: 'environment'`，`order: 0`）声明 `conversation.session.panel.environment.row`；其 `project` 行（`order: 0`）显示会话的工作目录：`workingDirectory` 投影记录的当前目录；投影尚未送达或没有记录时，依次取会话创建时所在的目录、列出本会话的工作区目录。该行先显示目录名，再以三级文字色显示父目录，放不下时以省略号截断；悬停 500ms 后出现的提示写明工作目录并给出完整路径。两处都把宿主家目录缩写为 `~`。右键该行或点其「更多」按钮会打开共享的 `directory` 上下文菜单。拥有共享分栏的插件用同样方式声明自己的行 slot。

面板隐藏时也要可见的标记（例如需要处理的红点）放进 `conversation.session.panel.indicator` 列表。每个占位是一个元素：开关把它定为图标角上的 6px 圆点，占位负责设置 `background`，并带有说明自身的文字，这些文字会成为开关无障碍名称的一部分。占位会重叠，`order` 高的画在低的上方。owner 属性 `panelShown` 让只是重复面板内容的标记在面板显示时不渲染。

插件把面板的行作为 Component Factory `conversation.session.panel.row` 提供。各包的分栏与环境行都用 `renderFactorySlot('conversation.session.panel.row', props)` 渲染自己的行，使不同分栏的图标、文字与尾部区域对齐。每行有一个沿用行文字颜色的 16px 装饰图标、单行内容（溢出时以省略号截断），以及可选的尾部数值或控件。`menu` 放在尾部区域之后的行操作（例如「更多」按钮），位于 16px 宽的一列，中心距行末端 14px；其中的普通 `button` 有 24px 点击区和三级文字色图标，悬停时图标变深、没有底色，因此不需要自己的 tooltip。鼠标悬停在行上、焦点在行内或其菜单打开时显示，没有悬停能力的设备上始终显示。传入 `onActivate` 时整行成为一个按钮，尾部区域与 `menu` 仍是各自独立的控件；带操作或行操作的行在悬停时以及菜单打开期间整行填充。`className` 追加到行的类名上，`attributes`（例如 `role`、`data-*` 标记与右键菜单触发属性）落在行元素上，其余属性被忽略。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

面板是 [`dsh-client-ui-chat`](../ui-chat/README.zh.md#scroll-ownership) 中 `conversation.chat.aside` 的占位组件，因此只渲染在 Chat 视图中。开关与面板是两个独立的 Slot 条目，共享一份插件持有的状态：持久化的停靠偏好、打开了浮层的会话，以及每个会话是否有停靠空间。每个已挂载的面板把所在 Chat 视图的 `endGutter` 数据源登记到这份状态里，面板卸载或其 Chat 视图换到另一个会话时取消登记；会话的任一数据源能容纳停靠面板时，该会话就有停靠空间，没有数据源的会话表示没有 Chat 视图在显示它。面板根据自己的数据源决定呈现方式，两者用同一个纯函数决定，因此开关状态始终与面板一致。面板与开关只订阅留白能否容纳停靠面板，因此尺寸变化只在跨过 348px 阈值时才让它们重新渲染；打开、关闭或停靠面板也不会让 Chat 视图重新渲染。侧边层从滚动容器继承输入框区域与视口高度，以及正文宽度 `--dsh-chat-content-width`，停靠宽度由 CSS 据此算出。

面板把分栏列表的实时注册（`entriesOfSlot`，因此同 `id` 且优先级更高的注册会替换已发布的分栏）投影为 `{ id, label }` 行，只在台账版本或语言版本变化时重新计算。它在各分栏自己的标题和正文容器里用 `renderSlot(..., { only: id })` 渲染内容；CSS `:has()` 规则隐藏正文出口为空的分栏，也包括行出口为空的共享分栏。

| 文件 | 作用 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | 字典、行 Factory、开关、面板、「环境」分栏与项目行 |
| [`src/client/slots.ts`](src/client/slots.ts) | Slot 声明与组件 props |
| [`src/client/visibility.ts`](src/client/visibility.ts) | 停靠阈值、呈现方式、共享可见性状态与每个会话的停靠空间 |
| [`src/client/sections.ts`](src/client/sections.ts) | 分栏名单投影 |
| [`src/client/SessionPanel.tsx`](src/client/SessionPanel.tsx) | 面板、分栏标题与 Esc 处理 |
| [`src/client/SessionPanelToggle.tsx`](src/client/SessionPanelToggle.tsx) | 标题栏开关及其角标 |
| [`src/client/PanelRow.tsx`](src/client/PanelRow.tsx) | `conversation.session.panel.row` Factory 渲染的面板行 |
| [`src/client/ProjectRow.tsx`](src/client/ProjectRow.tsx) | 工作目录行 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Web Client Slots](../../../docs/subsystems/slots.zh.md)——分栏依赖的 list、keyed 与 owner props 语义。
- [`dsh-client-ui-chat`](../ui-chat/README.zh.md#scroll-ownership)——`conversation.chat.aside` 图层及其末端留白数据源。
- [`dsh-client-ui-conversation`](../ui-conversation/README.zh.md)——会话标题栏工具区。
- [`dsh-client-ui-primitives`](../ui-primitives/README.zh.md#component-catalog)——`Button`、`Tooltip`、图标，以及模态层与输入法组合的判断。

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
- **没有运行环境行**——客户端没有区分本机、SSH 主机或沙箱模式的会话级信息，因此「环境」分栏只显示工作目录。
- **不能自定义分栏**——所有有内容的分栏都会显示；面板不提供隐藏或重新排序分栏的功能。
- **不能从其他视图切回 Chat**——`dsh-client-ui-conversation` 没有向插件开放视图选择，因此轨迹视图中的开关无法替用户切换到 Chat 视图。
- **浮层会出现在其会话的每个 Chat 视图中**——每个 Chat 视图实例（主正文区或嵌入的）都会渲染侧边层，因此同一会话同时显示在主正文区和嵌入的对话中时，两处都会显示浮层。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作语境——点击展开</summary>

无。

</details>
