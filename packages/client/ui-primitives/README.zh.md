---
description: "dsh Web 客户端共享的 React UI 原子组件：控件、图标、Markdown 与数学公式渲染，以及终端/读取/差异/搜索/网页输出卡片（零 Cordis）。"
kind: "package-library"
---

# @deepseek-ai/dsh-client-ui-primitives

[English](README.md) | 中文

## 概述

使用 `dsh-client-ui-primitives`，通过共享 React UI 构建 Web 客户端控件并渲染 agent 输出。它提供标准控件、图标、锚定浮层，以及用于带 TeX 公式的 Markdown、终端输出、文件读取、差异、搜索、网页检索和 JSON 的渲染器。这些渲染器会丢弃原始 HTML、限制链接并解析 ANSI 转义序列，以处理不受信任的模型输出。组件不 import Cordis 运行时；调用方提供本地化 label，主题相关颜色使用 `--dsw-*` 设计 token。

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

本包是 Web 壳的构建输入。静态 ESM 为 Vite 保留第三方导入和样式；独立消费方自行提供开发依赖（[依赖规则](../AGENTS.md#dependency-declaration)）。

只要 Web 客户端需要标准控件或 agent 输出渲染器，就用这些原子组件拼装功能 UI。它们只经 React 渲染，并从主题取得 `--dsw-*` 设计 token，因此无需导入主题或 slot 系统即可适配任意插件。

<a id="component-catalog"></a>
### 组件目录

在功能包里写控件之前，先查这张表。插件无法导入另一个插件的组件，因此本包是控件唯一可以共享的地方：合适的就复用，有意的视觉差异提升成 prop，而不是另起一份拷贝。

| 导出 | 是什么 |
|---|---|
| `Button` | 可点击操作；`variant` 选择 `primary`、`ghost`、`outline` 或 `toolbar`。 |
| `Switch` | 36×20 的双态开关。`label` 必填，控件不可能在没有名称的情况下发布。 |
| `Input` | 单行文本输入，用于搜索框与行内表单。 |
| `Menu` | 由条目、分隔线与分组标题构成的下拉菜单，支持嵌套子菜单。 |
| `Pill` | 可选中的胶囊按钮，用于视图切换与筛选器；接受 `active` 与 `onClick`。 |
| `Tag` | 只读胶囊徽章；`tone` 选择八种配色之一。 |
| `StateDot` | 状态标记：`done`、`warning`、`ongoing`、`error` 或 `idle`。它是 `aria-hidden` 的，名称由渲染点提供。 |
| `ConnectionIndicator` | 行内连接恢复控件，覆盖断线、重试与已恢复三种状态。 |
| `DisclosureRow` | 24px 紧凑折叠行，标题与内容左右排列。 |
| `Modal` | 页面遮罩之上的居中对话框。 |
| `RiskConfirmation` | 以显式复选框把关的敏感操作确认。 |
| `OnboardingSurface` | 首次运行的引导舞台，期间保持应用根节点 inert。 |
| `Tooltip` | 克隆锚点上的悬停文本，可置于右、下、上三个方向。 |
| `HoverCard` | 指针可停留、可选中的悬停预览；可选带复制按钮。 |
| `Toast` | 顶部居中的瞬时横幅，保持时长由所有者的 `holdMs` 决定。 |
| `JsonTree`、`JsonBlock` | 只读 JSON 查看。 |
| `MarkdownText`、`CodeBlock` | 不可信 GFM 与 TeX 数学，以及高亮代码。`CodeBlock` 可通过 `lineNumbers` 开启行号；复制的源码不含行号栏，`contentRef` 则向需要把稳定源码包装节点用作滚动区的 owner 提供该节点。调用方提供自己的语言与复制工具栏时，设置 `showHeader={false}`。 |
| `TerminalBlock`、`ReadBlock`、`DiffBlock`、`SearchBlock`、`WebBlock` | 与各类工具结果意图对应的 agent 输出卡片。 |
| `icons/*`、`FishLogo`、`BrandWordmark`、`ReferenceIcon`、`LinkIcon` | 字形与品牌标识。`LinkIcon` 用于 14px 的可点击链接分类。 |
| `FileTypeIcon`、`classifyFileType`、`fileExtension` | 按类别着色的 28px 文件或文件夹图形，以及它背后共享的不区分大小写文件名映射。代码与配置文件使用细分的全彩技术图形；链接前置图形使用 `LinkIcon`，图片内容使用图片预览。 |

有三组容易混淆：

- **`Tag` 与 `Pill`。** 11px 胶囊尺寸的只读徽章用 `Tag`；胶囊可选中（`active` 与 `onClick`，视图切换与筛选器就是这样用的），或者必须落在 24px 文本行上时用 `Pill`——`TerminalBlock` 把退出状态渲染成静态 `Pill` 正是后一种情况。这里尺寸和是否可交互同样是判据，两者不可互换。
- **`DisclosureRow` 与卡片。** 该行以固定 24px 把标题与内容左右排列。把名称叠在描述之上的卡片是另一种布局，属于功能包——`ui-settings-plugins` 的 `PluginCard` 是先例，并记录了原因。
- **`FoldToggle` 与对外导出面。** 它是包内组件，未导出；输出卡片用它做头尾折叠。

需求确实特殊时，在自己的包里写自己的组件没有问题。不可以的是复制这里已有的控件——而当第二个包需要同一个控件时，它就该住进本包（[决定](../../../.agents/notes/implemented/architecture/2026-09-05-shared-client-control-primitives.zh.md)）。

### 控件与图标

上面的目录说明每个导出的用途；本节讲 props 本身看不出来的行为。`ic_ds_*` 图标集与 `FishLogo`/`BrandWordmark` 标记填充品牌与行内图标 slot。`FileTypeIcon` 渲染传统的 28px Excel、folder、HTML、image、Markdown、generic、PDF、PPT、video 与 Word 图形，并为现有 48 个代码和配置类别使用导入的方形技术图形。该导入只替换图形：资源包中额外的类别不会扩展 `CodeFileType`。`classifyFileType` 按完整文件名、前缀、后缀、可选项目上下文、扩展名的顺序匹配；React 文件名优先于 TypeScript/JavaScript，Angular 后缀优先于基础扩展名，只有传入的项目文件包含带 `flutter:` 的 `pubspec.yaml` 时 Dart 文件才使用 Flutter。Markdown 与 SVG 仍分别使用传统 Markdown 与图片图形。办公文件映射包含 XLSM/Numbers 的表格图标、KEY 的幻灯片图标，以及 RTF/ODT/Pages 的文档图标。`fileExtension` 为相邻元数据 label 暴露同一套 basename 与最终点号解析。传统图形使用实色分类底板、白色标记和半透明白色折角；通用文件使用灰色底板与较深灰色折角。调用方可通过 `--dsh-file-type-icon-color` 覆盖底板颜色。全彩技术图形是明确例外，会保留其内嵌调色板。所有图形都是装饰性的，不自带 label。`LinkIcon` 仍是可点击产物链接较小的前置分类图形——地球、文件夹、代码、图片、文档或纸张——`classifyLinkPath` 把共享文件类型折叠进原有六类词汇。`ConnectionIndicator` 可渲染警告色的断联操作（常驻重试图形指明重试动作，断联文案由持有方提供）、spinner 加一至三个点以独立于 retry 时序的 500ms 节奏推进的连接中状态，或成功色的恢复状态。点击任一警告状态都会请求立即重连；没有任何悬停交互会改变文案。药丸出现时淡入、卸载前淡出 150ms，宽度随当前 label 自适应。它的持有方提供可见性、恢复驻留时间、本地化 label 与立即重连回调；该原语不使用原生 title tooltip。`useAnchoredPosition` 与 `useAnchoredMaxHeight` 让浮动面板与底部锚定浮层始终钳制在视口内并跟随锚点。`HoverCard` 通过指针离开宽限期让采用 portal 的预览在跨过锚点间隙时仍可触及，并可通过 `copyText` prop 提供复制按钮。`Toast` 的停留时长由使用方通过 `holdMs` 指定，因为横幅该留多久取决于有多少内容要读；同一个值同时驱动它的卸载定时器与样式表的淡出延迟，两者不可能再错位。`rankByName` 是 `/` 菜单命令源与 skill（技能）源共享的候选排序器：查询必须是名字的不区分大小写的有序子序列；前缀命中排最前，其次按对齐分数，再按来源顺序。 `Menu.autoFocus` 聚焦首个启用项，支持上下方向键与 Home/End 导航，并在 Escape 时聚焦 anchor 内的第一个按钮；操作菜单可显式启用。

### 渲染 agent 输出

`MarkdownText` 渲染不可信的 GFM 与 TeX 公式、阻止不安全的链接与图片，并可把已解析的文件提及转换为显式控件。当 owner 传入 `pathImages` 词表时，本地媒体路径的图片目标只在落定渲染阶段重写为可展示 URL（与 file mentions 相同的流式门）；不传词表时本地目标保持惰性 alt 文本。加载或解码失败后，图片替换为作者的 alt 文本；alt 为空时显示原始目标路径。图片源变化后可重新加载。回复流式输出时，它冻结已完成的块、按已完成行推进顶层未闭合 fence，并从保存的 Shiki grammar state 为该 fence 增量高亮。已完成的 token 行进入固定大小的 React 分组，后续分片只 reconcile 正在增长的分组；最终全量解析解决跨文档语法时，未变化的 fence 会保留该 DOM。`TerminalBlock`、`ReadBlock`、`DiffBlock`、`SearchBlock` 与 `WebBlock` 把对应的工具结果意图渲染为带复制控件、溢出处理及适用时 ANSI 处理的卡片。`JsonTree` 与 `JsonBlock` 以只读方式检查 JSON 值；`projectUserText` 把已发送的用户文本投影为行内普通文本段与引用 chip，供消息气泡和排队行使用。 传入 `UserTextReferences` 时，文件和 skill 引用成为支持键盘操作的预览按钮，复用正文文件链接的悬停和聚焦样式；第一次指针点击可以打开预览，后续点击和已有选区保留原生选择行为。键盘激活在存在选区时仍可打开预览。

`DiffBlock` 按行比较新旧内容。它显示实际增删行及两侧最多三行中性上下文，用 `⋯` 分隔远距离改动，摘要和底部统计都不计入共享上下文。若一个片段需要超过 256 次行新增或删除，则停止精确比较；该片段按完整新旧内容显示和统计为粗粒度替换，包含共享行。复制包含完整显示 diff 及其前缀。末尾换行视为行终止符；仅末尾换行不同不会显示为改动。

`JsonTree` 把折叠字符串限制为 `collapsedStringLines` 行（默认三行）。展开后显示原始文本、保留同级逗号，并限制在窗口与外层滚动容器内；尺寸变化和祖先滚动事件会更新此限制。行复制反馈独立于 JSON 值渲染更新；尚未完成的剪贴板写入不会更新另一行或已卸载的树。

### 本地化文案

这些原子组件无法读取应用 locale，因此每段面向用户的文案都必须通过 label prop 提供。`HoverCard`、`TerminalBlock`、`JsonTree`、`CodeBlock`、`MarkdownText`、`JsonBlock`、`ConnectionIndicator`、`Modal`、`DiffBlock`、`ReadBlock`、`SearchBlock` 与 `WebBlock` 接收完整的本地化 label。本包不拥有语言回退；遗漏会导致类型检查失败，各功能会把带类型的 `t` 席位映射到 primitive 的 label 接口。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包只做一件事：提供零 cordis、零 slot 知识、仅经 `--dsw-*` token 设置样式的纯 React 原子组件，而所有功能专属的关注点（locale、会话数据、组合）都留在拼装它们的插件中。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 原子组件公开导出 |
| [`src/markdown/`](src/markdown/) | Markdown 与数学公式流水线：micromark 解析、KaTeX 排版、增量流式渲染器、`CodeBlock`/`JsonBlock` |
| [`src/TerminalBlock.tsx`](src/TerminalBlock.tsx) | ANSI 转义解析（`anser`）与终端卡片渲染 |
| [`src/ReadBlock.tsx`](src/ReadBlock.tsx) / [`src/DiffBlock.tsx`](src/DiffBlock.tsx) | 读取与差异卡片 |
| [`src/SearchBlock.tsx`](src/SearchBlock.tsx) / [`src/WebBlock.tsx`](src/WebBlock.tsx) | 搜索与网页检索卡片 |
| [`src/icons/`](src/icons/) | `ic_ds_*` 字形组件与品牌标记 |
| [`src/useAnchoredPosition.ts`](src/useAnchoredPosition.ts) / [`src/useAnchoredMaxHeight.ts`](src/useAnchoredMaxHeight.ts) | 浮动面板与浮层几何钩子 |

### 流式 Markdown

回复流式输出期间，`MarkdownText` 增量解析：除末尾两个块外全部冻结为缓存的 React 元素，每个分片只重新解析其后的源文本尾部，因此每分片的工作量跟随尾部而非整个回复。末尾的顶层未闭合 fence 会保留已解析的 code node，只把最后一个已完成行与当前未完成行交给同一套 GFM grammar；闭合 fence 或有歧义的解析会回到普通尾部路径。高亮同样从保存的 Shiki grammar state 续接，并只发布新完成行与可变尾部。`CodeBlock` 把已完成行封入固定大小的 React 分组、复用更早的分组，并在代码与语言未变化时跨定稿保留整棵高亮树。定稿时的全量解析仍会解析跨过冻结边界的引用。

### 几何与溢出

输出卡片共享同一套几何模型：`white-space: pre` 并横向滚动，让按列对齐的内容保持对齐；超过 `maxLines`（默认 16）时折叠为头部切片加尾部切片，由展开按钮控制，长正文不会撑高卡片。`TerminalBlock` 把 ANSI 解析为 React span，并带逐行列缓冲处理光标移动，遵循行内擦除、制表位与字符宽度。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面说明这些原子组件在客户端技术栈与设计系统中的位置。

- [ui-renderer](../ui-renderer/README.zh.md)——挂载组装后应用并绑定 slot 数据的 React 渲染器。
- [ui-tool](../ui-tool/README.zh.md)——拼装这些输出卡片的工具调用展示层。
- [ui-conversation](../ui-conversation/README.zh.md)——渲染 Markdown 回复与工具卡片的聊天界面。
- [ui-theme](../ui-theme/README.zh.md)——这些原子组件样式所依赖的 `--dsw-*` token 体系。
- [Web 样式](../../../docs/web-styling.zh.md)——Web 客户端组件的权威样式规则。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端 UI 插件层，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明原子组件在边缘情况下的行为；它们是当前包约束，不是组件路线图。

- **Diff 搜索有上限，输入处理仍为线性**：编辑距离上限使大量改动的片段采用粗粒度替换，不再精确对齐。规范化、回退行及复制内容仍随输入大小增长；高度限制只约束可见行数，不限制这些分配。
- **流式期间跨边界引用解析被推迟**：定义落在增量冻结边界另一侧的引用式链接或脚注，在回复流式输出期间渲染为字面文本；定稿时的全量解析会将其解析。
- **长高亮 fence 会保留完整 token DOM**：流式路径避免重新解析、重新 tokenize 和 reconcile 已完成前缀，但不会丢弃旧颜色或虚拟化 token span。因此最终 DOM 数量仍随 fence 的 token 数增长；嵌套／容器内 fence 与病态的单个超长行仍走通用尾部路径。
- **字形级图标是重新绘制的近似版本**：鱼形标志与闪光标记来自字体字形，而本地设计数据无法导出其矢量几何；在获得精确导出路径前，使用手工重建版本代替。
- **`Pill` 与 `Input` 没有设计来源**：两个原子组件均自行定义；与其相似的侧边栏搜索字段和视图标签条由消费方组合，不是这些原子组件。
- **`StateDot` 没有 `Active` 变体**：支持的状态为 done、warning、ongoing、error 和 idle。
- **面向用户的文案必须由渲染点提供**：这些原子组件是 zero-Cordis 的，拿不到 `ctx.locale`；各功能必须通过原子组件的带类型 prop 提供完整本地化 label（见[决策](../../../.agents/notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.zh.md)）。
- **`TerminalBlock` 不是终端模拟器**：它渲染已结束或仍在运行的命令输出，而不是交互式会话：SGR 颜色、回车、退格、行内擦除、制表位与字符宽度会被遵循；绝对光标定位、清屏与备用屏幕序列会被剥离。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这些是纯 props-in React atom，没有 Cordis API、事件、service 或跨插件可变状态；渲染约定由组件测试覆盖。
