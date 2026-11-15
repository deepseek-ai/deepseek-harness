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

`@deepseek-ai/dsh-web-app` 套件默认加载本包。开关是会话标题栏的第一个工具按钮，位于共享和计划任务目录之前。它是图标按钮：无障碍名称由面板名称和其角标组成，提示文字说明按下后是显示还是隐藏面板（悬停 500ms 后显示，键盘聚焦时立即显示），`aria-expanded` /var/folders/_g/59jgff8x2gqd39f5vy1wnbfc0000gn/T/tmpkeajpmxo/theirs 表示面板当前是否显示。

### 停靠与浮层

正文列到 Chat 外框末端边缘的留白不少于 348px 时，面板停靠：与正文列及其宽度手柄保持 40px 间距，面板最小宽度 300px，外加 8px 边距。停靠时面板宽 300–360px，距末端边缘 8px，位于标题栏下方 12px，止于输入框区域上方，内容在面板内滚动，并为滚动条在距面板末端边缘 2px 处预留一列，因此无论是否滚动，内容宽度都不变。此时按开关会切换所有会话共用的停靠偏好，偏好存放在 `localStorage` 的 `dsh.sessionPanel.pinned` 中；默认停靠。

留白更窄时隐藏停靠面板，保证不遮挡正文。窗口变窄、展开右侧栏、把正文列拖宽都会如此。此时按开关，面板以更强的阴影浮在正文上方，宽 280px，比停靠时窄，以少遮挡正文，距末端边缘 8px，位于输入框区域之上，且不遮挡输入框。浮层可以用开关关闭，也会在按 Esc 时，或在面板、开关和任何已打开的菜单（例如行的上下文菜单）之外按下指针时关闭；焦点原本在面板内时，按 Esc 后焦点回到开关。页面上方有模态框、输入法正在组字，或已有处理程序（例如打开的菜单）接手了这次按键时，Esc 不归浮层；其余情况由浮层先处理，因此浮层打开时，在输入框按下的第一次 Esc 只关闭浮层，不计入停止当前轮次的连按。关闭浮层不改变停靠偏好。同一时间最多一个会话的浮层处于打开状态；留白变宽到可以停靠时，以及没有 Chat 视图再显示该会话时（例如切到其他会话或其他视图），浮层都会关闭，切回来也不会重新打开。面板隐藏时如果焦点在面板内，焦点移到开关。

轨迹等其他视图不显示面板。没有 Chat 视图显示该会话时，开关不可用：它连同角标留在标题栏中并变淡，悬停提示请用户切换到「对话」视图。

<a id="contribute-a-section"></a>
### 贡献分栏

一个分栏是 `conversation.session.panel.section` 列表里的一次注册：`id` 用于寻址，`order` 升序排列，必填的 `label` 是标题，面板按当前语言绘制。分栏组件通过 owner props 收到 `presentation`（`docked` 或 `overlay`）和 `dismissOverlay()`；它负责渲染正文，没有内容时什么都不渲染，标题随之隐藏。标题尾部的控件（例如计数或刷新按钮）注册到以分栏 `id` 为键的 keyed slot `conversation.session.panel.section.actions`。缺少 label 的分栏会报告到控制台，并且不显示。内置的分栏依次是「环境」（`order: 0`）、[forge 套件](../../experimental/client-ui-forge/README.zh.md)的「变更请求」（`100`）、[「子智能体」](../ui-subagent/README.zh.md)（`200`）、[「共享任务」](../ui-agent-team/README.zh.md)（`250`）和[「后台任务」](../ui-jobs/README.zh.md)（`300`）。

多个插件共用一个标题时，把行注册到分栏拥有者的行 slot 中。内置「环境」分栏（`id: 'environment'`，`order: 0`）声明 `conversation.session.panel.environment.row`，其中的行与分栏收到相同的 owner props；其 `project` 行（`order: 0`）显示会话的工作目录：`workingDirectory` 投影记录的当前目录；投影尚未送达或没有记录时，依次取会话创建时所在的目录、列出本会话的工作区目录。该行先显示目录名，再以三级文字色显示父目录，放不下时以省略号截断；悬停 500ms 后出现的提示写明工作目录并给出完整路径。两处都把宿主家目录缩写为 `~`。右键该行或点其「更多」按钮会打开共享的 `directory` 上下文菜单。forge 套件在 order 20 与 30 处添加检出行与本地变更行。拥有共享分栏的插件用同样方式声明自己的行 slot。

面板隐藏时也要可见的标记（例如提示需要处理的圆点）放进 `conversation.session.panel.indicator` 列表。每个占位是一个元素：开关把它定为图标角上的 6px 圆点，占位负责设置 `background`，并带有说明自身的文字，这些文字会成为开关无障碍名称的一部分。占位会重叠，`order` 高的画在低的上方。owner 属性 `panelShown` 让只是重复面板内容的标记在面板显示时不渲染。「子智能体」与「后台任务」在任务运行且面板未显示时显示蓝点（order 10 和 20）；forge 套件的红色提醒点（order 100）画在它们上方，面板显示时也保留。

各行共享同一外观，但不共享组件。分栏的组件或「环境」分栏的行条目自己写行的标记并标出各个部分，由面板的样式表统一排版，因此不同包的图标、文字与尾部区域对齐，而行里放什么由各包自己决定。

| 标记 | 部分 |
|---|---|
| `data-session-panel-row` | 行：占 28px 一行。带操作或菜单的行在悬停时以及其菜单打开期间整行高亮。 |
| `data-row-part="body"` | 图标与文字。用 `<button>` 作为 body 时，它就是这一行的操作，点击区域覆盖整行；尾部区域与菜单仍是位于其上的独立控件。可见文字不足以说明操作时，给按钮一个以可见文字开头的 `aria-label`。 |
| `data-row-part="icon"` | body 内的 16px 装饰图标，沿用行文字颜色；需标记 `aria-hidden`。 |
| `data-row-part="content"` | body 内的单行文字，溢出时以省略号截断。 |
| `data-row-part="lines"` | 两行的行里，body 内包住 content 与 detail 的容器。 |
| `data-row-part="detail"` | content 下方的第二行，使用较小的三级文字并以省略号截断，例如某个状态的后果或要运行的命令。行变为两行：图标留在第一行旁，尾部区域与菜单在整行上居中。 |
| `data-row-part="trailing"` | body 之后的数值或控件。 |
| `data-row-part="menu"` | 行操作（例如「更多」按钮），位于 16px 宽的一列，中心距行末端 14px。其中的普通 `button` 有 24px 点击区和三级文字色图标，悬停时图标变深、没有底色，因此不需要自己的 tooltip。鼠标悬停在行上、焦点在行内或其菜单打开时显示，没有悬停能力的设备上始终显示。 |

行没有的部分就不要写：有 `<button>` body 或菜单部分的行才会高亮。没有渲染任何内容的菜单部分（例如目标没有菜单项时的共享菜单按钮）视同不存在：不占位置，行也不会因它高亮。每条针对某个部分的规则只有一个类的优先级，因此行自己的类可以调整它。

列表可能很长的分栏会把它收起：只显示列表（或列表里每个分组）的前五行，然后以收起控件作为最后一行，用来显示其余的行或再次收起。只有这样做能收起两行及以上时才收起，因为控件自己也占一行；列表按顺序排列，使被收起的是最不需要看的行。插件把这个控件作为 Component Factory `conversation.session.panel.fold` 提供：`renderFactorySlot('conversation.session.panel.fold', { expanded, label, name, onToggle })` 渲染一个标记为 `data-session-panel-row="fold"` 的行，body 就是按钮，使用分栏计数的 12px 三级文字，图标列里是 14px 的箭头，还有行被收起时朝下，全部显示后朝上。`label` 是当前状态的可见文字，例如「显示其余 14 个」或「收起」；`name` 是无障碍名称，以 `label` 开头并说明列表里是什么。收起状态由分栏保存，显示哪些行也由分栏决定；在注册上声明 store 可以让这个选择在面板隐藏期间保留。

单行显示会截断名称，或放不下负责人、状态、度量的行，把这些内容放进悬停卡片。插件把卡片内容作为 Component Factory `conversation.session.panel.details` 提供：用 `HoverCard` 包住行，并把 `renderFactorySlot('conversation.session.panel.details', { title, lines, status, facts })` 作为它的 `content`。所有属性都是可选的数据。`title` 是行的完整名称，可以换行；名称可能很长（例如命令）而行自己的视图会完整显示它时，不要传。`lines` 是负责人等次要文字行，每行最多显示六行。`status` 是 `StateDot` 的状态及其文字。`facts` 是排在一行里的度量，每种 `kind` 最多一个：`tokens` 前面是数据库图标，`duration` 前面是时钟图标，各带自己的 `label`。卡片内容在两种主题下都使用卡片的深色底面。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

面板是 [`dsh-client-ui-chat`](../ui-chat/README.zh.md#scroll-ownership) 中 `conversation.chat.aside` 的占位组件，因此只渲染在 Chat 视图中。开关与面板是两个独立的 Slot 条目，共享一份插件持有的状态：持久化的停靠偏好、打开了浮层的会话，以及每个已挂载的面板和每个会话是否有停靠空间。停靠空间由样式表决定。侧边层把末端留白发布为 `--dsh-chat-aside-gutter`；停靠宽度和一个零高度的停靠探针都由它和同一组尺寸（间距 40px、边距 8px、最小宽度 300px）推出，因此探针恰好从留白 348px（放得下最小宽度的面板）起宽 1px，更窄时宽度为 0。面板始终渲染探针，并通过注入的 `createProbeRef` 挂接它；插件只用 `ResizeObserver` 观察这一个元素，所以只在停靠判断翻转时收到通知，窗口在阈值同一侧缩放、拖动正文宽度或正文增长时都不会。探针宽度达到 1px 即有停靠空间；会话的任一探针有空间时该会话就有停靠空间，没有探针的会话表示没有 Chat 视图在显示它。面板读取自己的探针，开关读取所在会话，两者用同一个纯函数决定呈现方式，因此开关状态始终与面板一致；打开、关闭或停靠面板也不会让 Chat 视图重新渲染。没有 `ResizeObserver` 时任何探针都不会获得空间，面板只以浮层显示。侧边层还从滚动容器继承输入框区域与视口高度。

面板把分栏列表的实时注册（`entriesOfSlot`，因此同 `id` 且优先级更高的注册会替换已发布的分栏）投影为 `{ id, label }` 行，只在台账版本或语言版本变化时重新计算。它在各分栏自己的标题和正文容器里用 `renderSlot(..., { only: id })` 渲染内容；CSS `:has()` 规则隐藏正文出口为空的分栏，也包括行出口为空的共享分栏。

| 文件 | 作用 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | 字典、开关、面板、「环境」分栏与项目行 |
| [`src/client/slots.ts`](src/client/slots.ts) | Slot 声明与组件 props |
| [`src/client/visibility.ts`](src/client/visibility.ts) | 呈现方式、共享可见性状态、停靠探针与每个会话的停靠空间 |
| [`src/client/sections.ts`](src/client/sections.ts) | 分栏名单投影 |
| [`src/client/SessionPanel.tsx`](src/client/SessionPanel.tsx) | 面板、停靠探针、分栏标题与 Esc 处理 |
| [`src/client/SessionPanelToggle.tsx`](src/client/SessionPanelToggle.tsx) | 标题栏开关及其角标 |
| [`src/client/SessionPanel.module.css`](src/client/SessionPanel.module.css) | 面板的几何、停靠探针，以及带标记的行的样式规则 |
| [`src/client/ProjectRow.tsx`](src/client/ProjectRow.tsx) | 工作目录行 |
| [`src/client/PanelFold.tsx`](src/client/PanelFold.tsx) | 被收起列表的收起控件，以 Component Factory 提供 |
| [`src/client/PanelDetails.tsx`](src/client/PanelDetails.tsx) | 行的悬停卡片里的详情，以 Component Factory 提供 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Web Client Slots](../../../docs/subsystems/slots.zh.md)——分栏依赖的 list、keyed 与 owner props 语义。
- [`dsh-client-ui-chat`](../ui-chat/README.zh.md#scroll-ownership)——`conversation.chat.aside` 图层及其 `--dsh-chat-aside-gutter` 属性。
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
