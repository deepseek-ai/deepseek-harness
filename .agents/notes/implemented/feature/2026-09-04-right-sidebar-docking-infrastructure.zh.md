# Agent Note: 右侧 Sidebar 停靠基础设施

Status: implemented

[English](2026-09-04-right-sidebar-docking-infrastructure.md) | 中文

## Problem

Web 客户端的右列曾是单一用途的 Detail 面板：`ui-chat` 以 `DetailsPanel` 占据 `details` 坑位，通过 `conversation.details.tool` 子坑位展示一个被选中 Tool 调用的原始载荷。其他任何内容都无法住在那里。想要一个常驻侧面的插件——文件预览、任务清单、diff——没有可注册的坑位，没有从会话流打开自己内容的通道，也没有可共享的布局来与他人分享这一列。

Agent 产出的文件是最尖锐的案例。产出文件 chip 或 `read` 行的路径链接会经 `session/openWorkspacePath` 把路径交给操作系统，因此不在 Host 机器上的浏览器完全看不到该文件，即便本机浏览器也要离开产品才能查看。与此同时 Detail 面板以全高重复渲染会话行的卡片，成为每张卡片都必须保持同步的第二个展示面。

## Decision

右列是每会话一份的停靠面（分栏 pane、tab、浮动面板与可撤销的操作序列），由 `ui-sidebar-right` 基于 `ui-dockkit` 引擎持有，取代原来的 Detail 面板。本篇只管这个面：引擎、框架的右列、面板的两种呈现与控件、每会话的状态。面里放什么由别处决定：插件如何声明 tab 类型、打开内容、拿到 props 见[tab 类型与导航](../architecture/2026-09-05-sidebar-tab-types-and-navigation.zh.md)；地址背后的活数据见[客户端资源模型](../architecture/2026-09-05-client-resource-model.zh.md)；读工作区文件见[工作区文件服务](../architecture/2026-09-05-workspace-files-service.zh.md)；引导页、文本预览与文件树见[随包类型](2026-09-05-sidebar-text-preview-and-file-tree.zh.md)。

### 包拓扑

| 包 | 形态 | 所有物 |
|---|---|---|
| `packages/client/ui-dockkit` | 静态链接库，零 DSH 依赖 | 布局引擎与渲染/驱动它的 React 组件；消费方编译其源码，且它只保留一张样式表，因为消费方按文件名去重注入的样式表 |
| `packages/client/ui-sidebar-right` | 动态插件 | 共用一个 store 的 `rightbar` 面板坑位与 `conversation.session.header.corner` 展开按钮、每会话一份 surface、两种呈现模式、浮层宿主、`ctx.sidebarRight`、`ctx.sidebarRightTabs`、tab 域（每条 tab 记录一个 occurrence）、三个扩展坑位、引导 tab 类型与 `sidebarRight` 文案命名空间 |

该库的第一个嵌入方就是本产品，而库对此一无所知：所有字符串经 `DockLabels` 传入，所有 tab 正文经按不透明 `kind` 分派的 `TabRenderer` 传入，所有手势经 `DockIntents` 传出。集成包提供库拒绝知晓的一切。

### 布局引擎

引擎是归一化的递归分裂树：`nodes` 按 id 索引，`rootId` 指向停靠根，`floats` 自底向上排列。id 带 brand（`PaneId`、`SplitId`、`TabId`；`NodeId` 是 pane 与 split 的并集），只由 `Mint` 铸出，任何一种 id 都不能充当另一种或裸字符串。悬浮面板是 `host` 为 `'float'`、容量为一的 pane，不绘制 tab 条。`applyOp(state, op)` 返回下一状态以及撤销它的操作，逆操作在执行时刻捕获，因为到 undo 时操作前状态已不存在。每个操作携带自己创建的 id，所以 `replay(initial, ops)` 从同一初态重现同一棵树；引擎不读时钟也不读随机源。`Sequencer` 维护线性历史，一个意图一条账——一次手势或命令产生的全部操作一起撤销与重做——连续的纯焦点条目合并为一步，后退后的新条目丢弃前向分支。planner 是纯意图层——`(state, mint, args) → LayoutOp[]`——`DockController` 是其上的薄可观察壳。`planSettle` 是可选的收尾 planner：合并掉意图留下的每个空停靠 pane，并经嵌入方的工厂重新种上被清空的根 pane。

组件渲染快照并上报已落定的意图，每个手势一条：拖拽过程只在本地 state 预览、手势的事实住在它的闭包里，松手把净结果折成一条操作。手势基于 pointer 事件与 pointer capture，而非 HTML5 拖放。chip 是胶囊形，只带一个控件——关闭；右键打开上下文菜单（关闭加嵌入方的 `renderTabMenuItems`）。chip 之后是添加控件，经 `DockIntents.addTab` 请嵌入方种入它的种子 tab（`planAddTab`）。悬浮是把拖拽松手在面之外，复制则完全没有库控件——`DockIntents.duplicateTab` 留给嵌入方 API。分栏控件的图标是被竖线一分为二的方框，与分栏本身一致。四条交互规则修复了真实浏览器中发现的缺陷并被有意保留：手势开始即捕获指针；tab 条绝不做滚动容器；焦点落在 click 而非 press；可拖 chip 内嵌的控件自行拦截按下。tab 的操作菜单以 portal 渲染并对着它的按钮定位，因为 tab 条刻意裁切溢出，画在条内的菜单会被一起切掉。库不自带 undo/redo 控件，也不自带头部：嵌入方的面级控件经 `DockSurface` 的 `chrome` prop 传入，库把它们放在右上 pane 的 tab 条末端（`topRightPaneId`：每个行分裂取最后一个子节点、每个列分裂取第一个）。通用工具包默认允许四个窗格；Sidebar 传入产品的两格上限。

### 框架的右列

[响应式 Sidebar 与标签信息](../architecture/2026-09-07-sidebar-responsive-tab-info.zh.md)取代本记录中的无让步布局、覆盖模式与产品窗格上限。`ui-layout` 仍拥有三列几何与像素宽度偏好，Sidebar 占位项通过 `ctx.layout.openRightbar(track, fullscreen)` 和 `closeRightbar()` 报告呈现方式，框架不注入 Sidebar 包。具体宽度规则见 [ui-layout](../../../../packages/client/ui-layout/README.zh.md)。

右栏在普通与全屏模式下使用同一棵已挂载内容树；隐藏保留标签状态，全屏覆盖视口并保留底层列占位。浮窗仍经 portal 使用视口坐标，不随右栏关闭。产品限制为两个水平窗格与 20–80% 分割比例，通用引擎保留自己的默认值。

### 状态

[默认页](2026-09-08-sidebar-default-pages.zh.md)取代此处的默认补入引导页；[最后一个 tab 的关闭规则](2026-09-08-sidebar-last-tab-close-rules.zh.md)负责显式关闭，移动 tab 仍会处理被清空的格。

`ui-sidebar-right` 为每个会话 id 保存一份 `SurfaceState`——布局、历史与铸造计数——住在坑位注册时声明的 store 里。每个 action 先铸造意图所需的 id，向库的 planner 索取操作，对结果跑一遍 settle planner，把整个意图记为一条历史账，再把该会话的 surface 整体赋回；没有 action 就地改布局。settle 是产品规则：最后一个 tab 被关闭、拖走或悬浮出去的停靠 pane 会被合并掉；展开且为空的根 pane 会填入当前默认页。折叠的布局可以保持为空，直到下次展开；没有单独的关闭 pane 手势。状态仅在内存：刷新使所有会话回到折叠默认态，切换会话时各 surface 保持原样。布局是呈现状态，永不进入会话日志。

### 面之外

这个面渲染的 tab 正文它自己并不认识：每个 tab 带一个 `kind`，面板向类型注册表询问该 kind 生效的实现，再派发到其 keyed 正文坑位。正文能依赖的一切——它的记录、所在格、是否可见、如何被导航到、中止信号、可做的动作——均通过框架注入的 `useTabInfo()` 从标签域读取。注册表、导航面 `ctx.sidebarRight`、坑位与 标签信息 在[tab 类型与导航](../architecture/2026-09-05-sidebar-tab-types-and-navigation.zh.md)里定；展示数据的正文经[客户端资源模型](../architecture/2026-09-05-client-resource-model.zh.md)读取。

### 入口与删除

`ui-chat` 的 `openFile(path, { line? })`——工具行路径链接、产出文件 chip 与收尾消息提及都经由它——现在经导航面把文件开进 Sidebar（见[tab 类型与导航](../architecture/2026-09-05-sidebar-tab-types-and-navigation.zh.md)）。`Show in folder` 动作及其 `canOpenWorkspacePath` 探针从 `ui-deliverables` 移除：Sidebar 没有目录形态，产品也不保留次级入口。`DetailsPanel`、`ToolDetails`、tool-node reader、chat store 的 selection、`ToolDetailsProps` 与 `CENTER_MIN` 一并删除。`session/openWorkspacePath` 留在 Host 上，已无 web 调用方。

## Alternatives considered

**采用停靠库。** 六个引擎按产品的状态所有权要求（布局是产品拥有的、可记录可回放的序列）评估。dockview 非受控，唯一外部入口是破坏性的 `fromJSON`，undo 划入付费层；react-mosaic 没有浮层，拖拽底座多年未维护；rc-dock、golden-layout、Lumino 在状态所有权上不可用。FlexLayout 0.10.x 是唯一可行候选——外置 Model、可否决的 `onAction`、保内容的 `fromJson`——被保留为已验证的降级预案，切换判定点是原型的五区 dock 与多浮层测试。两项自研均通过、无切换信号，且其 0.x minor 携带 breaking change，故未采用。

**分层复用：`react-resizable-panels` 管尺寸、Pragmatic drag-and-drop 管手势。** 原型之前的规划主线。原型自己的尺寸层与手势层在真实浏览器中通过后即否决：计划要省下的两层已经写完并验证，剩余价值只在长尾边界处理。若将来需要 snap 或 priority 尺寸语义，它仍是可替换的一层。

**挂在 `shell.overlay` 上的抽屉，或双层外壳（root rail、session 内容）。** 原型以抽屉形态交付以避免触碰框架。产品层面否决：抽屉不是一列，永不挤压会话区；双层外壳撞上 slot core 的 one-handle-one-scope 规则，会让折叠不可撤销。框架拥有一条真实的列；内容与状态仍绑定会话。

**框架自有的 32px rail 作为折叠态、面板住在带动画的 grid 轨道里、覆盖态另走 portal。** 第一版交付形态。评审后否决：实体 rail 轨道为一条只在折叠态存在的条带把会话区滚动条向内挤；住在动画轨道里的面板被每次轨道过渡拉伸重排，Sidebar 自己在动而它本不该动；一个面板两条代码路径意味着切换呈现模式要重挂载它。现在面板是一个锚在边缘的盒子做平移，轨道只负责占位。

**会话列内一条 40px 的 rail，带自己的 `sidebar.right.rail.item` 坑位。** 随后一试，好让 rail 能随面板离场。评审否决：为一个按钮加一个占位画一整条竖带，视觉太重。展开入口现在是头部的单个按钮，折叠态坑位推迟到有真实需求时再声明。

**面板自带头部行。** 第一版在 tab 条上方有一条 40px 的标题加控件行。删除：tab 条本来就是面板的顶边，控件经库的 chrome 坑位坐到右上 pane 的条末端，标题说的也不比 tab 多。

**展开按钮作为 `conversation.session.header.utilities` 的一个 list 条目。** rail 之后的一试。评审否决：作为 list 条目它坐在工具区行内，不在头部真正的角落，而且它的出现与消失会挪动旁边的 Session log 控件。专设一个保留占位宽度的角落坑位同时解决两点。

**每个 chip 一个带复制与悬浮项的"更多"控件。** 第一版给每个 chip 一个 `⋯` 菜单，装关闭、复制、悬浮。评审否决：chip 现在只带关闭，菜单挪到右键且只剩关闭（加嵌入方条目），复制与悬浮整体离开面板——复制仍是 API（`open` 带 `duplicate: true`），悬浮仍是拖拽。库的 `duplicateTab` / `floatTab` 意图与 planner 不变。

**面板头部的 undo 与 redo 按钮。** 先上后撤：序列是架构事实，步进它现在还不是产品动作。API 以 `@internal` 方法保留给测试与将来的导航控制器。

**空 pane 作为一种持久状态。** 第一版允许 pane 在最后一个 tab 离开后带占位留下。否决，因为没有任何方式关掉这样的 pane；每个意图都会整理 surface，被清空的侧 pane 合并掉。空根 pane 只在该列展开时填入当前默认页。

**经 `packages/util` 与 `INLINE_SAFE` 清单内联库。** 构建探针证明可行，但 util 构建链没有 CSS 管线而库带样式表；在知晓改库须重建壳并刷新页面的前提下，选择静态链接的 client 包（`ui-primitives` 先例）。

## Consequences

- 停靠面自身不再溢出面板：`.surface` 与 `.pane` 收在列内（`min-width: 0`、`overflow: hidden`），长的不换行行在正文内滚动，tab 条控件在任何分栏下都可见。
- 布局可撤销且按会话隔离，同时仅在内存；刷新使所有会话回到折叠态。undo 只能经 `@internal` 服务方法触达；产品不显示历史控件。
- 展开的布局不保留空 pane。空侧 pane 被合并，空根 pane 只在展开时填入当前默认页。新会话以及关闭最后一个 tab 后收起的布局保持为空，直到下次展开。
- 一个 pane 最多持有一个引导 tab：第二个不能被添加、打开、复制或搬入；唯一性按 pane 算，所以分栏仍给新 pane 种引导。
- pane 只有在等分后的两半都仍能容下不可收缩部分时才可分栏：tab 条的固定控件（条宽减去 chip 盒与填充，因此右上 pane 的面板控件只计在承载它的那一半）加一个最小宽度的 chip，由组件层在每次提交与尺寸变化后测量。否则分栏控件保留但禁用并带自己的文案，对应的边缘落区不再提供，用户拖窄的 pane 保持原尺寸；产品最多两个水平窗格，不因拉宽或拖分隔条而提高上限。
- 切换呈现模式时 Sidebar 面板一动不动，两种模式的平移一模一样；切换时只有会话区在动。隐藏的面板保持 tab 挂载，预览在折叠后仍在。
- 折叠时 Sidebar 只是头部角落的一个按钮：会话区保持全宽、滚动条停在自己的边缘，面板展开时按钮离场但占位保留，头部其余内容不动。
- tab 从 chip 上关闭；复制与悬浮在面板上没有控件（复制仅 API、悬浮靠拖拽）。上下文菜单经右键打开，含关闭与嵌入方条目。
- Detail 面板及其重复的卡片展示消失（净删约 1,400 行）；卡片就地阅读，`inspect` 打开 trajectory 视图。
- 框架没有中列下限：视口窄于两侧列之和时会话区被挤向零，而不是关掉某一列。
- 库由消费方编译，改库须重建壳并刷新页面；它没有 HMR。
- 面板、浮层宿主与 portal 出去的 tab 菜单使用硬编码 z-index；客户端仍没有 z-index token 层。

## Testing

`ui-dockkit` 的规格钉住引擎不变量——每个操作的逆操作往返恒等、历史任意前缀的 `replay` 等于记录状态、一个复合意图作为一条账步进、焦点段对称合并、格数上限与宽度规则拒绝且零记账——并仅以 props 驱动组件，不用 scaffold。`ui-sidebar-right` 的规格覆盖 per-session store、座位的两种呈现与控件、按格唯一的引导、宽度感知分栏。Web e2e 套件在 Chromium 里经真实插件图驱动随包交付的 Sidebar：展开与收起、分到上限与置灰控件、浮窗、回坞、引导页。两套均无需密钥。

## Deferred

- z-index token 层，随后替换面板、浮层宿主与菜单的硬编码值。
- 组合层的切换会话用例，受阻于 fixture 组合默认打开设置面。
- 新包 README 与本次改动的英文文档的中文对。
- snap 或 priority 面板尺寸语义、触屏调优，以及分栏/移动/悬浮的键盘路径。
- 布局持久化、popout 窗口，以及内容导航栈（条目以 pane 与内容为键、相邻重复替换、`navigating` 守卫、已关 tab 留在栈中）。
- 不可关闭的 tab（`TabRecord` 上的 `closable` 标志，画成固定的前置标记而非胶囊），等到有 tab 类型需要时再做。
