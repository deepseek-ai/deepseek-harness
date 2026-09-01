---
description: "dsh Web 客户端共享的 React UI 原子组件：控件、图标、Markdown 与数学公式渲染，以及终端/读取/差异/搜索/网页输出卡片（零 cordis）。"
kind: "package-library"
---

# @deepseek-ai/dsh-client-ui-primitives

[English](README.md) | 中文

## 概述

`dsh-client-ui-primitives` 是 Web 客户端共享的 React 组件库：每个功能插件都用这些原子组件拼装自己的 UI，而这里没有任何内容依赖 Cordis 或 slot 系统。它提供控件集（按钮、胶囊、输入框、菜单、模态框、Toast 横幅、折叠行、悬浮卡片、连接指示器）、图标字形与品牌标记、锚定浮层用的定位钩子，以及 agent 输出的内容渲染器：带 TeX 公式的 markdown、终端输出、文件读取、差异、搜索结果、网页检索与 JSON 检查。这些渲染器为不受信任的模型输出而设计——原始 HTML 会被丢弃、链接会被失效或安全打开、ANSI 转义序列会被解析而非透传。面向用户的文案通过 label prop 提供；拼装某个原子组件的功能插件负责本地化。

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

只要 Web 客户端需要标准控件或 agent 输出渲染器，就用这些原子组件拼装功能 UI。它们只经 React 渲染，并从主题取得 `--dsw-*` 设计 token，因此无需导入主题或 slot 系统即可适配任意插件。

### 控件与图标

`Button`、`Pill`、`Input`、`Menu`、`Modal`、`Tooltip`、`DisclosureRow`、`StateDot`、`HoverCard`、`Toast`、`ConnectionIndicator`、`RiskConfirmation` 与首次运行接管层 `OnboardingSurface` 覆盖常见的交互形态。`ic_ds_*` 图标集与 `FishLogo`/`BrandWordmark` 标记填充品牌与行内图标 slot。`ConnectionIndicator` 可渲染警告色的断联操作、以独立于 retry 时序的 500ms 节奏推进一至三个点的连接中状态，或成功色的恢复状态。所有状态都为最长的输入 label 预留空间，并使用固定的图标列和文字列，因此文案变化不会移动控件或改变其宽度。它的 owner 提供可见性、恢复驻留时间、本地化 label 与立即重连回调；该原语不使用原生 title tooltip。`useAnchoredPosition` 与 `useAnchoredMaxHeight` 让浮动面板与底部锚定浮层始终钳制在视口内并跟随锚点。`HoverCard` 通过指针离开宽限期让采用 portal 的预览在跨过锚点间隙时仍可触及，并可通过 `copyText` prop 提供复制按钮。 `Toast` 的停留时长由使用方通过 `holdMs` 指定，因为横幅该留多久取决于有多少内容要读；同一个值同时驱动它的卸载定时器与样式表的淡出延迟，两者不可能再错位。

### 渲染 agent 输出

`MarkdownText` 渲染不可信的 GFM 与 TeX 公式、阻止不安全的链接与图片，并可把已解析的文件提及转换为显式控件。回复流式输出时，它冻结已完成的块、按已完成行推进顶层未闭合 fence，并从保存的 Shiki grammar state 为该 fence 增量高亮。已完成的 token 行进入固定大小的 React 分组，后续分片只 reconcile 正在增长的分组；最终全量解析解决跨文档语法时，未变化的 fence 会保留该 DOM（[增量渲染器](../../../.agents/notes/implemented/architecture/2026-08-06-web-markdown-incremental-ast-renderer.zh.md)、[流式 fence 高亮](../../../.agents/notes/implemented/feature/2026-08-20-web-streaming-fence-highlight.zh.md)）。`TerminalBlock`、`ReadBlock`、`DiffBlock`、`SearchBlock` 与 `WebBlock` 把对应的工具结果意图渲染为带复制控件、溢出处理及适用时 ANSI 处理的卡片。`JsonTree` 与 `JsonBlock` 以只读方式检查 JSON 值；`MessageText` 仍是用户创作内容的字面文本原语。

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

### 流式 markdown

回复流式输出期间，`MarkdownText` 增量解析：除末尾两个块外全部冻结为缓存的 React 元素，每个分片只重新解析其后的源文本尾部，因此每分片的工作量跟随尾部而非整个回复。末尾的顶层未闭合 fence 会保留已解析的 code node，只把最后一个已完成行与当前未完成行交给同一套 GFM grammar；闭合 fence 或有歧义的解析会回到普通尾部路径。高亮同样从保存的 Shiki grammar state 续接，并只发布新完成行与可变尾部。`CodeBlock` 把已完成行封入固定大小的 React 分组、复用更早的分组，并在代码与语言未变化时跨定稿保留整棵高亮树。定稿时的全量解析仍会解析跨过冻结边界的引用（[增量渲染器](../../../.agents/notes/implemented/architecture/2026-08-06-web-markdown-incremental-ast-renderer.zh.md)、[流式 fence 高亮](../../../.agents/notes/implemented/feature/2026-08-20-web-streaming-fence-highlight.zh.md)）。

### 几何与溢出

输出卡片共享同一套几何模型：`white-space: pre` 并横向滚动，让按列对齐的内容保持对齐；超过 `maxLines`（默认 16）时折叠为头部切片加尾部切片，由展开按钮控制，长正文不会撑高卡片。`TerminalBlock` 把 ANSI 解析为 React span，并带逐行列缓冲处理光标移动，遵循行内擦除、制表位与字符宽度。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面说明这些原子组件在客户端技术栈与设计系统中的位置。

- [ui-renderer](../ui-renderer/README.zh.md)——挂载组装后应用并绑定 slot 数据的 React 渲染器。
- [ui-tool](../ui-tool/README.zh.md)——拼装这些输出卡片的工具调用展示层。
- [ui-conversation](../ui-conversation/README.zh.md)——渲染 markdown 回复与工具卡片的聊天界面。
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

- **流式期间跨边界引用解析被推迟**：定义落在增量冻结边界另一侧的引用式链接或脚注，在回复流式输出期间渲染为字面文本；定稿时的全量解析会将其解析。
- **长高亮 fence 会保留完整 token DOM**：流式路径避免重新解析、重新 tokenize 和 reconcile 已完成前缀，但不会丢弃旧颜色或虚拟化 token span。因此最终 DOM 数量仍随 fence 的 token 数增长；嵌套／容器内 fence 与病态的单个超长行仍走通用尾部路径。
- **字形级图标是重新绘制的近似版本**：鱼形标志与闪光标记来自字体字形，而本地设计数据无法导出其矢量几何；在获得精确导出路径前，使用手工重建版本代替。
- **`Pill` 与 `Input` 没有设计来源**：两个原子组件均自行定义；与其相似的侧边栏搜索字段和视图标签条由消费方组合，不是这些原子组件。
- **`StateDot` 没有 `Active` 变体**：支持的状态为 done、warning、ongoing 和 error。
- **面向用户的文案必须由渲染点提供**：这些原子组件是 zero-Cordis 的，拿不到 `ctx.locale`；各功能必须通过 primitive 的带类型 prop 提供完整本地化 label（见[决策](../../../.agents/notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.zh.md)）。
- **`TerminalBlock` 不是终端模拟器**：它渲染已结束或仍在运行的命令输出，而不是交互式会话：SGR 颜色、回车、退格、行内擦除、制表位与字符宽度会被遵循；绝对光标定位、清屏与备用屏幕序列会被剥离。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这些是纯 props-in React atom，没有 Cordis API、事件、service 或跨插件可变状态；渲染约定由组件测试覆盖。
