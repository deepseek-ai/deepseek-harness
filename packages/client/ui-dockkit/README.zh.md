---
description: "dsh Web 客户端的停靠布局套件：带可逆操作的标签格分裂树、planner、线性历史，以及渲染并驱动它的组件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-dockkit

[English](README.md) | 中文

## 概述

一套停靠布局套件：由带可逆操作的标签格组成的分裂树，以及渲染并驱动它的组件。Harness Web 客户端是它的第一个嵌入方；这里的代码对此一无所知。

> **内部引擎。** 本包之所以发布，是因为 Sidebar 以静态链接方式使用它，而非作为稳定 API：它的导出——`LayoutState`、`LayoutOp`、各 planner、`DockIntents`、`DockLabels`、`DockMode`——在任何版本都可能变化，并且没有任何一个出现在服务接口里（`ctx.sidebarRight` 只暴露操作，从不暴露布局快照或操作日志）。

## 目录

- [两层结构](#the-two-layers)
- [如何嵌入](#embedding-it)
- [值得保留的交互规则](#interaction-rules-worth-keeping)
- [构建形态](#build-shape)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="the-two-layers"></a>
## 两层结构

**引擎**是纯逻辑——没有 UI 框架、没有 DOM、没有宿主概念。

- 一棵归一化的递归分裂树：按 id 索引的 `nodes`、指向停靠根的 `rootId`、自底向上排列的 `floats`。`PaneId`、`SplitId`、`TabId` 是带 brand 的字符串：只有 `Mint`（或库自己的 DOM 往返）能产出，因此 pane、split、tab 三种 id 彼此不可互换，也不能拿裸字符串充数。浮窗不是第二个概念——它就是 `host` 为 `'float'` 的格，容量一个 tab，绘制时不带 tab 条。
- `applyOp(state, op)` 返回下一状态**以及撤销它的操作**。逆操作在操作执行时捕获，因为到撤销时操作前的状态已经不存在了。
- 每个操作都携带它创建的 id，因此 `replay(initial, ops)` 能复现同一棵树。引擎不读时钟，也不读随机源。
- `Sequencer` 维护一条线性历史，每个意图一条记录：一次手势或命令产生的操作一起后退、一起前进，连续的纯焦点记录作为一步，后退后的新记录会丢弃前进分支。
- `planSettle` 是可选加入的规则，保证意图之后每个停靠格都有内容：被意图清空的格会被并掉，被清空的根格通过嵌入方的工厂重新播种——不传工厂则只并格、让根格保持为空。想要空格的嵌入方只需不调用它，或不带工厂调用。`planDropTab` 接受同一工厂：带工厂时，唯一 tab 放到本格边缘会分栏，工厂的 tab 回填它腾出的格（被拖的 tab 保持聚焦）；不带工厂时这种释放不改变任何东西。
- `DockController` 是意图层，也是一个可观察源（`subscribe` + `getSnapshot`，其引用只在布局变化时才变）。

**组件**渲染布局快照并上报已落定的意图——每次手势一条，绝不上报拖动帧。拖动过程中在本地状态里预览，手势自身的事实留在它的闭包里；松手时净结果通过一次 `DockIntents` 调用离开——在标签条上松手上报的是按绘制顺序数出的插入槽位（被拖的 chip 也计入），由 `planPlaceTab` 换算成重排或移动。正是这一点让嵌入方能为每次手势记录恰好一条历史。标签条遵循 WAI-ARIA tabs 模式的手动激活：选中的 chip 在 Tab 键序里；左右方向键（循环）、Home、End 只在 chip 之间移动焦点而不选中；Enter 或空格选中当前聚焦的 chip，走与点击相同的意图。chip 是一个胶囊，携带唯一的控件——它的关闭按钮；上下文菜单（在 chip 上的次键按下）携带同样的关闭项加上嵌入方的条目——一个连一项都没有的菜单绝不展示——并渲染在按 chip 定位的 portal 里，因为 chip 盒会故意裁掉溢出（见下文）。chip 之后是添加控件，它请嵌入方（`DockIntents.addTab`）安放其种子 tab；嵌入方的 `canAddTab(paneId)` 按格决定是否绘制该控件。复制 tab 没有套件控件——那是嵌入方的 API——而浮出就是把拖动松手在停靠区之外。

<a id="embedding-it"></a>
## 如何嵌入

一切宿主相关的东西都通过 props 进入：

| 约定 | 承载内容 |
|---|---|
| `DockLabels` | 每一个渲染出来的字符串，已本地化，含无障碍名称 |
| `TabRenderer` | 一个 tab 的正文（`renderTab`），贴着格的边缘和（不带边线的）tab 条底边绘制、自己决定留白，以及可选的 chip 或浮窗头部显示的标题（`renderTabTitle`，回退到记录的 `title`）；嵌入方按 `tab.kind` 分发 |
| `DockIntents` | 每次手势落定的结果 |

`DockController` 原样满足 `DockIntents`，所以最简单的嵌入就是把 controller 直接交给 `DockSurface`。经由自己 store 路由的嵌入方则实现同名方法。有三个 props 承载的是控制策略而非手势：`canSplit`（整面有效，即格预算；用 `splitPaneDisabled` 禁用分栏控件）、`canAddTab(paneId)`（按格，省略添加控件；不传则每格都画）与 `canCloseTab(tabId)`（按 tab，把 chip 的关闭控件和菜单的关闭项一并收起；不传则每个 tab 都可关闭）。隐藏添加控件不会移动 tab 条里的其它任何东西，收起关闭也不会移动 chip 里的任何东西——关闭控件压在标题末端之上而非并排。某格仅剩的一个 chip 在关闭被收起时画成安静样式——没有胶囊底色，没有悬停填充——因为既没有别的 tab 可供选择，也没有任何可对它做的事。套件自己再加一条策略，即下文的空间规则，它用 `splitPaneNarrow` 禁用某格的分栏控件；`onRoom(fits)` 上报其读数，让以编程方式分栏的嵌入方能遵守同一规则。

`dropZones="horizontal"` 提供左右两个半区提示；预算或宽度不允许再拆时，正文整格接收移动。提示是一张内缩 8px 的虚线卡片，显示该落区的图形和 `labels.dropZone[zone]`；预览层覆盖全部 tab 正文，指针所在的卡片取强调色，另一张保持安静的轮廓。`minPaneFraction` 控制预览的最小比例，`planResizeSplit` 接受相同最小值以约束提交；Sidebar使用0.2并在自己的store限制两格。通用引擎仍保留原有树与其它分割方向。 `hideSplitWhenBlocked` 在分栏被阻止时（窗格预算已满或格太窄）直接隐藏分栏控件而不是渲染禁用态，默认值为 false。

tab 的 `kind` 是不透明字符串。种子 tab 是工厂（`DockControllerOptions`），因此新格里放什么由嵌入方决定，与本包无关。内容身份是二元组（`kind`、`contentId`）：`findContentTab(state, contentId, kind?)` 在任意位置找到展示它的 tab，`findPaneContentTab(state, paneId, contentId, kind?)` 在一个格内找；`planOpenContent` 会聚焦该 tab 而非再开一个，除非被告知 `revealIfOpened: false`；显式的 `index` 把新 tab 放到 tab 条的某个位置而非末尾。

`DockSurface` 是停靠区。它周围的 chrome——轨道、折叠形态、任何历史控件——属于嵌入方，由嵌入方读取 `state.expanded` 后自行决定；套件不自带撤销/重做控件。嵌入方确实想放到面上的整面控件通过 `chrome` prop 传入，套件把它放在右上格 tab 条的最末端（每个横向分裂的最后一个子节点、每个纵向分裂的第一个子节点），因此停靠面不需要自己的标题行。`FloatLayer` 拥有自己的手势并以视口坐标定位浮窗，因此可以挂在任何位置，包括 portal 里。

<a id="interaction-rules-worth-keeping"></a>
## 值得保留的交互规则

这些不是风格偏好；每一条都修复了在真实浏览器里发现的缺陷。

- **手势开始时捕获指针。** 不捕获的话，指针经过的任何滚动容器都可能接管手势，浏览器会将其报告为指针取消和拖动中止。捕获是加固——无论如何都由 window 监听器承载手势，所以没有该 API 的环境照样可用。
- **chip 让位；tab 条末端的控件永不让位。** chip 盒是 tab 条里唯一会收缩的部分（`flex: 0 1 auto; min-width: 0; overflow-x: auto`）：chip 先缩到 80px 下限，再在盒内随滚轮横向滚动、不画滚动条，且盒在每个藏有 chip 的一侧把 chip 在 24px 内渐隐（`data-dockkit-strip-scroll`，在每次提交、滚动与尺寸变化后由盒的滚动读数写入）。每当活动 tab 或 chip 的排列变化，盒会滚动到让活动 chip 避开渐隐带；已在视野内的 chip 不动。chip 的标题从不加省略号：`TabTitle` 拿文字宽度对照它的盒子，文字更宽时置 `data-dockkit-tab-clipped`，让文字在末端 16px 内渐隐。chip 的关闭控件在 chip 活动、悬停或持有焦点时显示，压在标题末端 14px 之上、标题在其下渐隐，因此 chip 宽度两种情况下都一样。活动 chip 两侧的槽不画细线，让填色胶囊立在裸 chip 之间。添加、分栏与 chrome 控件都是 `flex: none`，因此在任何不窄于它们自身的格里（带 chrome 约 130px，不带约 72px）都保持宽度与位置。停靠面的 `min-width: 0` 与格的 `overflow: hidden` 阻止正文里最长的不换行行把格撑出自己的盒子——正是那种情况把控件和正文滚动条推到了屏幕外。
- **chip 盒会滚动，但绝不认领手势。** 横向滚动容器会把按下并移动的手势据为己有并取消指针；盒、chip 与 tab 条都设 `touch-action: none`，手势又捕获了指针，所以在 chip 上按下并移动是拖动，只有滚轮滚动盒子。
- **分栏需要给两个可用的半格留出空间。** 格被等分成两半，因此每一半都必须容得下不可收缩的部分：tab 条的固定部分——按 tab 条宽减去 chip 盒与填充条测得，即内边距、间隙以及该格绘制的每个控件（含它自己的 chrome，所以右上格要求更多）——加上一枚最小尺寸的 chip——`.tab` 在 content-box 上声明 `min-width: 80px`，所以它的足印是 80px 加 10px + 10px 内边距，即 100px，从已渲染 chip 的计算样式读取（读不到时用样式表数值）；两半之间的分隔条取其渲染厚度（0——它的细线画在接缝上、不占布局空间，因此正文自己画的分隔线能不断线地穿过接缝）。纵向分栏只由边缘落下产生，它要求每一半容得下 tab 条（34px）加 48px 正文：正文自留的 12px 内边距内一行 13px、行高 1.6 的次级文字——格的正文容器本身没有内边距，tab 的正文直接贴到 tab 条底边和格的边缘，由自己留白。`geometry.ts` 里的 `halvesFit` 是算术；`measure.ts` 在每次提交后与停靠面尺寸变化时读取矩形，因为布局状态只携带比例、从不携带像素，引擎的 planner 也保持如此。没有空间的格保留分栏控件，以 `splitPaneNarrow` 禁用（开启 `hideSplitWhenBlocked` 时改为隐藏），并且在该轴上不提供边缘落区（松手就不是移动）。开启 `hideSplitWhenBlocked` 时，分栏控件自己的占位——它的盒子加 tab 条的间隙——不计入固定部分：隐藏控件让 tab 条卸下的恰是这份占位，把它算进去的读数会随控件的可见性来回翻转、无限重渲染；不计入也正是被询问的那一半会承载的量，因为窄到无法分栏的一半会隐藏自己的控件。用户随后拖窄的格——通过拖动分隔条或嵌入方的列——会保持原尺寸：规则只决定它的下一次分栏。
- **焦点落在 click 而不是按下。** 在 `pointerdown` 与第一次 `pointermove` 之间的状态变化会重建被按下的子树，而被替换的元素会取消指针。这也避免拖动先记录一条多余的焦点操作。chip、标签条各控件以及嵌入方 chrome 上的 click 都止于标签条：它们各自上报的意图已决定了活动格，或本就是嵌入方自己的事，所以格自身的点击聚焦不再多记一条。浮动面板的抓手与角柄同样通过手势上报——原地松开的按下是一次 click，抬起面板；真正的拖动只记录移动或缩放，由该操作自己抬起面板——而按在面板主体上则直接抬起它。点击本已活动的格、点击或按键选中该格本已选中的 chip，或按下本已活动且在最上层的面板，什么都不改变，也什么都不记录。
- **嵌套在可拖动 chip 里的控件要拦住自己的按下。** 否则按下会开始拖动、捕获指针，嵌套控件的 click 就永远落不下。
- **强调色用平台的强调 token，绝不用 `--dsw-alias-brand-primary`。** 本平台把 `brand-primary` 绑定到近黑（浅色）或近白（深色）的前景色，因此落点光标与落区提示都用 `--dsw-alias-brand-primary-new-colorprimary-new-color`，与轨迹视图一致；悬停的分隔条改用 caption 文字色，读起来是把手而不是高亮。浮窗不画边框——菜单同款阴影（`--dsw-elevation-prominent`）已勾出它的轮廓——活动浮窗也不加重边框：它本就在最上层、投同样的阴影；围它一圈更深的边框读起来像缺陷。

<a id="build-shape"></a>
## 构建形态

本包静态链接：tsdown 的 `staticLinked` 预设在 `lib/index.js` 产出一个浏览器 ESM bundle（所有裸说明符保持为 import，sourcemap 链回源码），并把样式表按其相对 `src` 的路径放到 `lib/` 下；Web 外壳按包名解析并自行打包该产物，因此 vite 仍是 class 哈希的唯一拥有者。有一个后果至关重要——套件只保留**一张**样式表 `dockkit.module.css`，因为消费方按文件名去重注入的样式表，撞名会静默丢掉一张。

<a id="model-experience"></a>
## 模型体验

无，因为本包是浏览器侧停靠布局引擎与组件集，不注册任何面向模型的内容。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **尺寸语义刻意保持精简**：比例权重加一处最小尺寸夹取。没有吸附、优先级或首选尺寸，因此完整 splitview 的级联挤压行为不存在。
- **触控未调优。** 手势基于 pointer 事件，并在滚动容器可能干扰处设置了 `touch-action`，但没有做过触控专项调优。
- **无障碍不完整**：分隔条没有 `separator` 角色，也没有键盘路径去分栏、移动或浮出。
- **没有发布样式表约定。** 消费方拿到的是哈希化的模块类名；套件除读取的 `--dsw-*` 自定义属性外不暴露任何主题 API。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。引擎是作用于纯数据的纯函数，组件只上报意图；操作序列的可逆性与 settle 规则由本包的引擎 spec 直接断言，不提供也不观察任何 Cordis 服务。
