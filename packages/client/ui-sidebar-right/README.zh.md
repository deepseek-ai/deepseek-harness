---
description: "dsh Web 客户端的右侧 Sidebar：每会话一个停靠面、两种呈现形态、导航控制器 ctx.sidebarRight、tab 类型注册表 ctx.sidebarRightTabs 与 Tab 域。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-right

[English](README.md) | 中文

## 概述

右侧 Sidebar：停靠套件与本产品相遇的地方。它为每个会话持有一个停靠面，以两种呈现形态之一把它画成贴靠框架右列边缘的一块面板，把展开按钮放进会话 header，并拥有导航控制器（`ctx.sidebarRight`）、tab 类型注册表（`ctx.sidebarRightTabs`），以及告诉每个已开 tab 它是如何被导航到、能活多久的 Tab 域。

## 目录

- [什么住在这里，什么不住](#what-lives-here-and-what-does-not)
- [呈现形态](#presentations)
- [展开按钮](#the-expand-button)
- [状态](#state)
- [扩展席位](#extension-seats)
- [`ctx.sidebarRight`](#ctxsidebarright)
- [Tab 域](#the-tab-domain)
- [引导页](#the-guide)
- [文案](#copy)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="what-lives-here-and-what-does-not"></a>
## 什么住在这里，什么不住

布局本身——分裂树、它的操作、拖拽手势、浮窗——属于 `@deepseek-ai/dsh-client-ui-dockkit`，并保持与宿主无关。本包提供套件拒绝知道的一切：产品文案、tab 的 `kind` 是什么意思、新格用哪个 tab 播种、停靠面挂在哪里、其它插件如何触达它。

<a id="presentations"></a>
## 呈现形态

普通与全屏共用同一棵面板内容树，切换不会重挂载Tab。普通面板贴靠右栏；全屏面板覆盖窗口并保留宽屏底层列宽。窗口低于768px时打开右栏自动全屏；窄屏退出全屏会收起右栏，变宽不重新打开已关闭的右栏。 全屏打开时，底层列宽保持不变，直到滑入结束后才无过渡地准备普通轨道。 全屏面板退场前，关闭先准备全宽会话区，恢复先准备普通右轨道；退场期间底层不播放宽度动画。

| 形态 | 轨道 | 面板 |
|---|---|---|
| `push`（默认） | 面板宽度：会话区让出空间 | 在轨道内；它的左缘与会话区的右缘沿框架自己的曲线一起移动 |
| `fullscreen` | 保留宽屏普通轨道；窄屏自动全屏不占轨道 | 覆盖整个窗口 |

在 Windows Electron 中，`html[data-windows-titlebar]` 让全屏面板保持在顶栏下方及展开侧栏的右侧。框架的 `--dsh-windows-sidebar-width` 提供该缩进及最大宽度；`--dsh-windows-content-radius` 提供左上圆角。仅全屏面板为该圆角裁剪溢出内容。

席位通过 `ctx.layout.openRightbar(track, fullscreen)` / `closeRightbar()` 报告呈现，框架不注入本包。宽屏切换全屏不改变中栏宽度；宽度拖拽区只在普通展开态显示。独立浮窗及 `float`/`dock` 操作保持可用。

面板没有标题行。它的两个控件——形态切换与折叠按钮——搭在套件 chrome 席位上，位于右上格 tab 条的最末端，因此 tab 条就是面板的整条上边。每条 tab 条从左到右读作：在允许时带关闭按钮的 tab 胶囊，添加控件（只在该格没有引导 tab 时绘制；它通过 `ctx.sidebarRight.openTab` 在该格打开引导页），该格的分栏控件，以及右上格里的两个面板控件。窄格里只有 chip 让位；其后的控件从不收缩或被裁切。

<a id="the-expand-button"></a>
## 展开按钮

快捷键速查包含右侧栏切换、分栏和面板全屏命令，对应控件显示同一份有效键位。分栏与全屏要求焦点位于可见的停靠分栏内；焦点在聊天区时不可用。不可分栏时控件仍可见，可聚焦的提示显示当前键位，并说明分栏数量上限或宽度要求。文件、浏览器和终端提供者分别注册自己的命令。开始页按钮内以无背景文字显示有效快捷键，不额外弹出重复提示。

面板隐藏时，会话 header 角落席位里的一个按钮（`conversation.session.header.corner`，在工具组右缘之外，与 Session 日志控件齐平）是回去的路。它的图形是左侧 sidebar 折叠图标的镜像。它使用公共紧凑 Button，与相邻更多操作按钮共用圆角和 hover 底色。它与面板共用一个存储（slot 运行时允许两个同作用域席位共用一个 handle）；面板显示时它什么也不渲染，角落席位随之收起。于是折叠的 Sidebar 不花会话区任何代价：没有轨条、没有宽度，转录的滚动条留在列的边缘。没有会话就没有按钮也没有面板。

面板取会话区的底色与正文字号，而不是自成一层浮起的表面：它是页面的一列，不是压在页面上的卡片。

root 作用域的 `rightbar` 入口通过独立的 `rightbar.session` 子树渲染选中的 Session，以及拥有已初始化 `keepMounted` 正文的后台 Session。每个 View 拥有自身的 Session reference。只有前台 Conversation 上报框架列宽并绑定公共导航；其他子树保持隐藏，不删除 tab 状态。

<a id="state"></a>
## 状态

每个会话 id 一个 `SurfaceState`——布局、它记录的序列、以及它已铸造的 id 数——保存在注册时声明的存储里。每个动作都遵循同一形态：铸造意图需要的 id，向套件 planner 询问由哪些操作承载，记录它们，然后把该会话的整个停靠面赋回去。没有任何动作就地编辑布局，这正是让套件的纯函数成为唯一计算布局之处的原因。

把铸造计数器带在停靠面里，是记录的序列可回放的原因：操作内嵌它们创建的 id，因此从同一初始状态回放能复现同一棵树。每个动作记录一条历史，无论它需要多少操作。展开、折叠与切换形态也都被记录。

每个动作之后，套件的 settle planner 保证展开的停靠面有内容：最后一个 tab 被搬走或浮出的停靠格会被并掉；根格被清空时填入默认页。折叠的停靠面没有这种回填——会话以折叠且为空的停靠面开始，收起整列的关闭也让它保持为空——首次会展示空布局的那次展开才播种默认页。显式关闭遵循[默认页与关闭规则](#the-guide)。展开期间永远至少有一个 tab，永远没有空格——因此没有单独的「关闭格」手势。

停靠面的最后一个 tab 还多带一条规则，由 store 的 `closeTab` 决定并经 `canCloseTab` 镜像给套件：作为唯一停靠 tab 的引导页不画关闭控件也不画菜单里的关闭项——它的 chip 呈安静样式，在没有扩展条目时次键按下也不弹出菜单——对它的编程式关闭什么都不记录；任何其它 tab 独自留下时，点击关闭会连同整列一起收起，记为一条历史，布局保持为空，直到下次展开时创建当时的默认页。浮动面板不参与这条规则：前台 Session 的浮窗无论列是否展开都会渲染，其 tab 照常关闭。

store 将每个 Session 的布局、标签身份、选中项、分栏比例、浮窗矩形、呈现方式和身份计数以 JSON 保存到 localStorage 的 `dsh.sidebar-right.v1.<sessionId>`。刷新时在渲染标签正文前恢复布局；不同 Session 的布局独立。provider 根据保留的标签身份和资源地址恢复自身内容，包括[终端重连](../ui-sidebar-terminal/README.zh.md#use-this-package)。导航参数、资源内容和活动连接不属于布局状态。撤销历史只保留在内存中，刷新后清空。采用布局或启动探测前会校验保存字段类型、节点成员关系、选中项、身份计数，以及单格或左右两格的停靠布局；无效数据只清除对应 Session 的 key。存储失败时，当前布局仍可在内存中使用。同源窗口共享每个 Session 最后保存的布局；活动窗口在刷新前保留各自的当前布局。

`sidebarRight.openTabs` 发布所有已保存和已采用 Session 的打开标签元数据，并保持快照引用稳定。启动时读取布局 key，不挂载非当前内容、pin 文件或激活 Agent。已采用的 store 在标签成员变化时更新自己的元数据，永久清除的 scope 删除对应记录。其他窗口写入 storage 不会覆盖当前窗口的活动成员关系。provider 使用该清单恢复自己的资源生命周期。

<a id="extension-seats"></a>
## 扩展席位

tab 类型分两阶段注册，随包发布的引导类型走的正是别的包的类型走的同一条公开路径（`ui-sidebar-documentpreview` 是活的证明）。两个阶段都在类型自己的 `ctx.effect` 里，因此注册与创建它的插件同生共死。

1. **类型**——`ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide?, keepMounted? })`，一份没有运行时钩子的静态声明，返回 disposer。`id` 是这个实现在 tab 系统里的身份，在全部注册中唯一（包名是天然取值；随包引导页是 `@deepseek-ai/dsh-client-ui-sidebar-right/guide`）：一旦 extension 可以接管 builtin 的 kind，kind 就不再唯一，所以实现要自己命名，同一 `id` 的第二次注册会 throw。资源类型给出 `patterns`，即作用于 `dsh-resource://` 地址的 glob：含 `:` 的匹配整个地址（`dsh-resource://file/**`）；不含的匹配 URI 路径的任意深度且忽略大小写（`*.md`），不是 URI 的地址不匹配任何这类模式。页类型——引导页、文件树——不给出模式，按 kind 打开。`canOpen(address)` 否决一次命中。`title(address)` 是 tab chip 的文字，在 tab 打开时捕获。`guide` 列出引导页的入口框；选中一个即把贡献它的类型作为页打开。一个 `kind` 最多承载一份 `builtin` 与一份 `extension` 注册（extension 生效；它离开后 builtin 恢复）；kind 上的其它任何撞名都 throw。`id` 同时也是该类型正文与标题注册时用的 key，因此 extension 与它接管的 builtin 各占一个格位，席位渲染生效的那个。
2. **正文**——`ctx.slots.register({ name: 'sidebar.right.pane.tab', key: definition.id }, Body)` 通过框架注入的 `useTabInfo()` 读取 `{ sidebar, panel, tab }`。`sidebar` 提供开合与全屏信息，`panel.id` 命名所在格，`tab` 包含原记录字段、`visible`、`navigation`、`signal` 和 `actions`。这些字段不再作为平铺owner props传入；类型自己的store仍使用 `useStore`/`actions`。可选标题注册及引导替换共享该hook；未注册标题时使用打开时保存的文本。标题包装保留 tab 与 occurrence 的 DOM 标记，但不引入布局盒，因此停靠 tab 和浮窗标题中的图标间距与垂直对齐由 dockkit 控制。

由哪个类型打开资源遵循编辑器解析器的惯例：`patterns` 命中的类型先按 `priority` 档排序——`extension`（产品外的类型，最高档，也是未命名时的默认）、`builtin`、`fallback`（任何更具体的类型都应胜过的通用查看器）——再按命中模式的长度，再按注册顺序；`canOpen` 会剔除候选。各档是字符串字面量，因此别的包里的类型不需要从这里做运行时导入。`candidates(address)` 返回排序，`claim(address, kind?)` 返回决定；指定 `kind` 时跳过它的 glob 但保留它的 `canOpen`。

另有两个席位扩展已有之物：`sidebar.right.tab.guide`（chain）替换引导 tab 的正文而不替换 tab，`sidebar.right.tab.menu.item`（list）在套件自己的布局动作之后向 tab 菜单追加内容级动作。目前没有面向格级动作或折叠态控件的席位，因为还没有东西需要它。

<a id="ctxsidebarright"></a>
## `ctx.sidebarRight`

`openResource(address, options?)` 与 `openTab(kind, options?)` 是导航控制器，进入该列的每条路都调用其中之一：会话区的文件链接与工具行的行号引用（`openResource(fileAddress, { params: { line } })`），tab 条的添加控件与引导入口框（`openTab`），文件树的行（`tab.actions.openResource`）。资源地址是 `dsh-resource://<type>/…` URI；不带 `options.kind` 时由注册表认领（glob 与 `canOpen`，最高档胜出），带它时由该 kind 生效的类型打开。页按 kind 命名；tab 记录在本包拼出、别处无人书写的地址下（`contract/seed.ts`）。两者以同一组步骤作为一条历史运行：已展示同一 (kind, contentId) 的资源 tab 被聚焦，不限所在分栏，除非 `revealIfOpened: false`；页 tab 始终只在目标分栏内去重，不受该选项影响；否则新 tab 落到 `options.replaceTab` 所在的格与位置（并关掉那个 tab），再退而落到 `options.paneId`，再退而落到活跃停靠格；面板展开，因为用户看不到的内容不算打开。随后 Tab 域记录这次导航——`params` 以 `navigation.params` 抵达正文，`revision` 递增——不进布局历史。`params` 按所开之物定型：某资源类型的查看器把自己那项并入 `SidebarRightResourceParamsMap`（文本预览声明 `{ line?: number }`）；接受参数的页类型按其 kind 并入 `SidebarRightTabParamsMap`；值约定为 JSON 形状，运行时不校验。`dsh-resource://` 之外的地址、无人认领的地址、或未注册的 kind 都会 throw：那是接线错误，不是用户错误。

`preferNewPane: true` 会先按普通的两格上限与空间规则尝试分割目标停靠格，无法分栏时回退到该格。`replaceTab` 优先并会禁用这项偏好。

`close(tabId)` 关闭一个 tab；`active()` 读取活动 tab。`isExpanded()` 与 `toggleExpanded()` 读取并驱动该列的展开；`toggleFullscreen(target)` 对捕获的停靠分栏执行面板控件的显示模式操作。布局操作供以编程方式安排该列的调用方使用，每个都像它替代的手势一样被记录：`focus(tabId)` 聚焦一个 tab 及其格；`split(paneId?)` 在与 tab 条控件相同的格预算与空间规则下分栏一个停靠格（默认活跃格），返回新格的 id，做不到时返回 `undefined`——且不记录任何东西；`float(tabId, rect?)` 把停靠 tab 浮出为浮窗；`dock(paneId)` 把浮窗放回活跃停靠格。不存在的 tab 或格、或已处于调用目标状态的，都原样不动。该接口只暴露操作：没有布局快照、没有操作日志、没有按地址查找。`_undo()` / `_redo()` 步进已挂载停靠面的历史；它们是 `@internal`——序列没有面向用户的控件，这两个只为测试存在。命令需要一个已挂载的会话停靠面；没有时它们 throw，而不是写进一个没人绘制的面里。`mounted` 是「席位正在屏幕上的那个会话」的可观察值，全局面板替代 Conversation 或没有选中会话时为 `undefined`。要在自己的挂载 effect 里打开内容的组件通过绑定的 hook 读取它，并在它有值后再行动：框架把 Conversation 列挂载在这个席位之前，而席位在同一次提交的 passive effect 里才发布绑定，一个假定席位已绑定的 effect 会先运行并 throw。计划审阅的自动打开就是这样读取它的。

`focusedTarget(element?)` 解析当前 DOM 分栏和标签页，也接受嵌入 iframe；焦点位于外部时不返回页面。`commandTarget(element?)` 另外允许外部打开动作使用已挂载会话的活动停靠分栏。捕获值包含 occurrence 和导航版本；`isTargetCurrent(target)` 拒绝会话变更、已移动或重新打开的标签页，以及期间发生的导航。焦点和指针激活独立于持久化的布局选择。

<a id="the-tab-domain"></a>
## Tab 域

Tab 域按（Session，Tab id）保留品牌化 occurrence id、导航、中止信号与绑定动作。私有装配回调采用各 Session 的 store，立即对齐恢复的记录，再跟随其提交。同一 Session 的 store 重建会替换其 `adopt` 注册，同时释放旧订阅与清理引用。记录消失或插件卸载才中止 signal，收起和切会话不销毁记录；undo 恢复的是新 occurrence。`useTabInfo()` 组合框架绑定的 store 与导航 hook，不在组件中手写订阅或在渲染时创建记录。`tab.actions` 始终作用于自己的会话；`tab.visible` 区分正文与标题，并排除后台 Session；前台浮窗不受整栏收起影响。`adopt` 不在公开控制器上。

类型声明 `keepMounted: true` 后，已访问正文会在切 tab、切 Session、收起和停靠切换期间保留。每个 View 通过 owner props 提供自身稳定的持有回调，因此 Session injection binding 重建不会释放正文。未访问的正文不会提前挂载。

标签页所有者通过 effect 注册 `registerCloseHandler(kind, handler)`。handler 在允许显式关闭或替换前同步保存后台清理任务。资源所有者跟踪完成和重试，侧栏不等待清理。handler 抛错时保留标签页。折叠、展示方式改变和插件卸载不调用关闭 handler；tab abort signal 标识 occurrence 卸载，不代表显式关闭。

关闭与刷新命令解析聚焦 pane 和 tab occurrence。页面通过 `tab.actions.bindCommands()` 绑定刷新操作，并在卸载时释放；已结束的 occurrence 不能重新获得能力。刷新不会重载应用。通过快捷键打开页面、展开侧栏或执行分栏操作后，焦点在 DOM 提交后移至选中的停靠或浮动分栏，包括显示已有单例页面和替换引导页。展开侧栏时聚焦活动停靠分栏；收起时保留浮动分栏内的焦点。分栏获得焦点时保留现有文本选区。聚焦的页面输入框或 iframe 被替换时，仅在没有其他元素持有焦点的情况下将焦点交还其可见分栏；外部指针操作或显式失焦会取消此次恢复。关闭会再次检查捕获的身份并执行资源清理。通过快捷键或原生菜单关闭后，焦点移至同一 Session 中仍可见的分栏，让连续关闭继续作用于右栏。过期目标和清理失败均不会回退为关窗。模态限制遵循[快捷键服务](../shortcuts/README.zh.md)。关闭命令优先请求前台弹窗的关闭操作；弹窗拒绝关闭、菜单或未注册的对话框都会阻止关闭后方侧栏或窗口。通过快捷键或原生菜单关闭唯一的停靠引导页时，收起右栏并保留引导页。Desktop 仅在没有弹窗且焦点没有所属的右栏页面时通过快捷键服务请求关闭窗口；Web 保留浏览器窗口。

<a id="the-guide"></a>
## 引导页

每个 `guide` 入口具有 provider 内唯一的 `id`。开始页按当前生效的定义 id 渲染 `sidebar.right.tab.guide.entry`，传入入口 id、解析后的标题、可选描述，以及框架提供的 `useTabInfo` hook。provider 可按自己的定义 id 注册自定义卡片；未注册时使用默认图标与标题按钮。侧栏负责宽度和排列，自定义组件负责内部结构和交互。引导卡片统一使用 R20，包含悬停底色与提供方自有的分体按钮。排序或其他注册变化不会改变入口身份。无背景的快捷键文字右对齐。终端 Shell 菜单位于入口标题旁。

终端等需要独立实例的 tab 类型可声明 `multiple: true`。每次打开都会获得独立内容地址，因此移动和停靠会保留这些实例；普通页面仍在每个格内去重。

默认页取决于已注册的引导入口数，不取决于 tab 类型数或已打开的 tab 数。恰好一个入口时直接打开对应页面；没有入口或有多个入口时打开引导页。即使只有一个入口，显式添加引导页仍会打开引导页。只有作为唯一停靠 tab 的引导页不可关闭；关闭其它任何唯一 tab 时会同时收起整列。chip、上下文菜单与 `close` API 使用同一规则。

引导 tab 是一枚弱化的罗盘，下方是各已注册类型贡献的每个 `guide` 条目一个入口胶囊，按 `order` 排列并在正文中居中；引导页自己没有文字。胶囊显示条目的图标——条目没注册图标时用引导页自己更浅的立方体占位符——和标题；列出的条目不超过四个时，注册了 `description` 的条目在标题下显示它，更长的列表则去掉所有描述。点击默认胶囊会调用 `tab.actions.openTab(entry.kind, { replaceTab: true })`，于是引导页让位给它打开的页。一个格最多持有一个引导 tab。tab 条的添加控件只在该格没有引导 tab 时绘制，并以 `openTab('guide', { paneId, revealIfOpened: false })` 在该格打开一个，这样别的格里的引导页不会截走这次点击；把引导页开进已有引导页的格则改为聚焦它；把引导页拖入、放入或收回到这样的格会合并进去——来者关闭，该格自己的被聚焦；对引导页 `duplicateTab` 不记录任何东西。分栏、展开且为空的根格、以及唯一 tab 拖到本格边缘分屏后腾出的格使用相同的默认页规则，每个新格一个 tab；这种本格边缘拖放让被拖的 tab 保持聚焦。普通的 `openTab('guide')` 只在活跃或指定分栏内打开或聚焦引导页。对空分栏执行 split 不产生变化，也不返回新分栏。产品最多保留左右两格，默认均分，分隔条限定在 20%～80%。宽度不足以容纳两格时不允许新分栏；已有两格时，正文拖放用于跨格移动，不再创建第三格。达到两格上限时禁用分栏控件并提供可聚焦的原因提示；关闭回单格后重新启用。

<a id="copy"></a>
## 文案

该列里的每个字符串都来自 `sidebarRight` 语言命名空间，包括套件的无障碍名称。tab 的标题在 tab 铸造时固定；类型的显示名跟随当前语言。

<a id="model-experience"></a>
## 模型体验

无，因为本包是浏览器侧 UI 插件层，不注册任何面向模型的内容。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **布局保存在当前浏览器。** 布局不跨设备同步；provider 专属状态需要由该 provider 支持恢复。
- **没有会话就没有停靠面。** 状态按会话 id 键控，因此 hero 画面右侧什么都不显示。
- **硬编码的层叠。** 内容树使用固定层叠层；浮窗在该层内重排，不会把整层抬到菜单之上。
- **保活 Session 的删除。** 仅从目录消失不会使已初始化的保活 View 退休；释放由 tab 生命周期和插件卸载负责。
- **未暴露撤销。** 记录的序列只能通过 `@internal` 服务方法步进；产品控件是有意缺席的。
- **标题在打开时固定。** 类型的 `title(address)` 被捕获进记录；会变的标题只来自可选的标题席位。
- **没有内容导航栈。** 后退回放的是布局操作；编辑器式的「已访问内容」前进/后退尚未构建。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。两个服务（`sidebarRight`、`sidebarRightTabs`）在同一个 effect 内经 `ctx.reflect.provide` 提供并随之拆除；席位绑定与 Tab 域 occurrence 的生命周期由本包的 spec 直接断言，不存在会与之分歧的独立观察。
