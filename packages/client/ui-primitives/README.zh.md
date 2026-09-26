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

`Toast` 在浅色和深色模式下均使用主题的系统提示背景与文字颜色。`Menu` 数据条目与 `MenuItemButton` 组件条目接收功能 owner 提供的有效快捷键，并在末端以无背景的浅灰色文字对齐显示，子菜单也采用同一呈现。`ShortcutKeys` 默认以无方块的按键文字显示菜单和行内提示。`tooltip` 变体在深色气泡上使用稍浅的键帽，以加号连接的组合则共用一个填充色块。`Tooltip.shortcutKeys` 将键帽与可选的本地化操作文本垂直居中排列，标签为空时只显示按键。可选的 `className` 供调用方设置交互状态样式。`Modal` 与设置外壳通过 `useModalLayer` 共用顶层 Esc 和 Tab 处理，关闭时恢复先前焦点。`closeTopModal(document)` 请求前台弹窗当前的关闭操作；上层菜单或未注册的对话框会阻止关闭其后方弹窗。组件通过 `isBehindModal` 避免将焦点移到嵌套弹窗后方。菜单先消费自己的 Esc，再由模态层处理关闭。 `observeComposition` 为局部弹层和录键处理提供相同的 composition-end 与旧版 IME 保护；调用方随交互生命周期释放其 document 监听。

弹窗自动进入及弹窗、菜单回焦，包括通过 Esc 和应用关闭快捷键触发的回焦，均使用 `focusWithoutRing(element, options?)`，在 Tab 或方向键导航恢复正常焦点样式前抑制外轮廓线。弹窗容器仍不绘制焦点外框。原有边框、阴影和错误状态保持不变。用 `data-modal-autofocus` 标记弹窗的初始控件，让模态层先保存触发控件，再移动焦点。随弹窗挂载的控件不得使用 React `autoFocus`，因为它会在保存触发控件前执行。弹窗容器获得焦点时，Tab 和 Shift+Tab 分别进入第一个和最后一个可聚焦控件。

本包是 Web 壳的构建输入。静态 ESM 为 Vite 保留第三方导入和样式；独立消费方自行提供开发依赖（[依赖规则](../AGENTS.md#dependency-declaration)）。

只要 Web 客户端需要标准控件或 agent 输出渲染器，就用这些原子组件拼装功能 UI。它们只经 React 渲染，并从主题取得 `--dsw-*` 设计 token，因此无需导入主题或 slot 系统即可适配任意插件。

<a id="component-catalog"></a>
### 组件目录

在功能包里写控件之前，先查这张表。插件无法导入另一个插件的组件，因此本包是控件唯一可以共享的地方：合适的就复用，有意的视觉差异提升成 prop，而不是另起一份拷贝。

| 导出 | 是什么 |
|---|---|
| `Button` | 可点击操作；`variant` 选择 `primary`、`ghost`、`outline` 或 `toolbar`。ref 指向原生按钮，供焦点控制与浮层锚定使用。 |
| `Switch` | 36×20 的双态开关。`label` 必填，控件不可能在没有名称的情况下发布。 |
| `SegmentedControl` | 两段或更多等宽分段加一个滑动指示块的 tablist，用于在几种模式间切换一张卡片或面板；选中项由调用方持有，`label` 为列表命名。`id` 派生每个 tab 的 id（`<id>-<value>`）及其控制的面板 id（`<id>-<value>-panel`），面板由调用方渲染并用 `aria-labelledby` 指回 tab；分段可 `disabled` 并带 `title`，控件级 `disabled` 在当前面板有进行中的操作时锁住全部分段。 |
| `Checkbox` | 带标签的原生复选框，支持受控状态、键盘交互和禁用样式；调用方提供本地化的 `label` 文本。 |
| `Input` | 单行文本输入，用于搜索框与行内表单。 |
| `Menu`, `MenuItemButton` | 由 `items` 数据行、分隔线与分组标题构成的下拉菜单，支持嵌套子菜单；`children` 在同一列表中加入组件行，每行一个 `MenuItemButton`（`separatorBefore` 开启新分组）。所有行共享样式、键盘走位与焦点归还；两类行的关闭都是 owner 状态的改变。打开期间 `↑`／`↓`（以及 Home、End）在列表中走位，Tab 选定聚焦行，Escape 或 Shift+Tab 关闭并把焦点还给锚点；选定一行同样把键盘还给锚点——除非拥有者自己移动了焦点。只拦截位于锚点或列表内的键盘，`autoFocus` 仅决定打开时是否聚焦首行。 |
| `Pill` | 可选中的胶囊按钮，用于视图切换与筛选器；接受 `active` 与 `onClick`。 |
| `SegmentedTabs` | 受控的等宽分段标签，支持滑动指示条及左／右方向键、Home、End 导航。调用方提供文案、标签与面板 id，以及面板内容。 |
| `Tag` | 只读胶囊徽章；`tone` 选择八种配色之一。 |
| `PathLabel` | 单行文件路径：目录使用弱化颜色，文件名使用主色，悬停可查看完整路径。空间足够时靠左显示；溢出时保留尾部并在左侧渐隐，路径或尺寸变化时更新。 |
| `StateDot` | 10px 槽内的绿色 `done`、琥珀色 `warning`、红色 `error`、中性灰色 `idle` 圆点，以及 tertiary 灰色 14px 旋转 `ongoing` loading，其动画固定到文档时间零点，所以所有可见 loading 同相旋转。它是 `aria-hidden` 的，名称由渲染点提供。 `appearance="step"` 以实心勾表示完成、空心圆表示等待。 |
| `ConnectionIndicator` | 行内连接恢复控件，覆盖断线、重试与已恢复三种状态。 |
| `DisclosureRow` | 24px 紧凑折叠行，标题与内容左右排列。使用浅层 prop 比较进行 memo；内容未变时，保持回调与 React 节点 prop 的引用稳定。 |
| `Modal` | 页面遮罩之上的居中对话框。嵌套对话框可通过 `onKeyDownCapture` 在文档级 Escape 处理器之前拦截按键。 色层与弹窗淡入，背景模糊始终完整生效，并遵循减少动态效果偏好。调用方已模糊源页面时设置 `backdropBlur={false}`。 |
| `RiskConfirmation` | 以显式复选框把关的敏感操作确认。 |
| `Tooltip` | 锚定在克隆子元素上的悬停文本；可通过 `portal` 渲染到外层，避免被容器裁剪，或受祖先层叠上下文限制其 z-index。 |
| `HoverCard` | 指针可停留、可选中的悬停预览；可选带复制按钮。 |
| `ImageLightbox` | 共享图片浮层，支持焦点恢复与 Esc 关闭。 |
| `Toast` | 顶部居中的瞬时横幅，保持时长由所有者的 `holdMs` 决定。 |
| `SettingsForm`、`SettingsValueField`、`SettingsSecretField` | 插件设置页的框架与控件：框架以 `labels` 接收文案，只在按钮点击时保存，卸载即丢弃；值字段显示暂存文本以及已覆盖标签和重置；密文字段每次为空，请求浏览器不要自动填入已保存的密码，只报告是否已配置。 |
| `SettingsFormModel`、`settingsNumberField`、`settingsTextField` | 这类页面背后基于设置 scope 的暂存编辑模型：草稿先暂存、保存时写入，字段是否被覆盖看用户层是否含有它，未落地的保存保留草稿。 |
| `JsonTree`、`JsonBlock` | 只读 JSON 查看。 |
| `MarkdownText`、`MarkdownDelegateProvider`、`CodeBlock` | 不可信 GFM 与 TeX 数学、owner 委托的 HTTP(S) 导航，以及高亮代码。`CodeBlock` 可通过 `lineNumbers` 开启行号；复制的源码不含行号栏，`contentRef` 则向需要把稳定源码包装节点用作滚动区的 owner 提供该节点。调用方提供自己的语言与复制工具栏时，设置 `showHeader={false}`。 |
| `TerminalBlock`、`ReadBlock`、`DiffBlock`、`SearchBlock`、`WebBlock` | 与各类工具结果意图对应的 agent 输出卡片。 |
| `icons/*`、`FishLogo`、`BrandWordmark`、`ReferenceIconRegular`/`ReferenceIconMedium`、`LinkIconRegular`/`LinkIconMedium` | 字形与品牌标识。`LinkIconMedium` 用于 14px 的可点击链接分类及已知站点标记。 |
| `PermissionIconReadOnlyRegular`/`Medium`、`PermissionIconWorkspaceWriteRegular`/`Medium`、`PermissionIconFullAccessRegular`/`Medium` | 只读、工作区写入与完全访问选项使用的权限模式图形。 |
| `PluginArtworkTerminal`/`Loop`/`Subagent`/`Search`/`Default` | 固定配色的 36×36 插件插画；`Terminal` 为插件卡片和侧边栏开始页入口提供浅蓝色提示符。`Default` 用于没有自有插画的插件。def id 按实例生成，同一插画可在一页中安全重复。 |
| `GuideArtworkBrowser`/`Files` | 固定配色的 36×36 浏览器与文件夹插画，用于侧栏引导入口。 |
| `FileTypeIcon`、`classifyFileType`、`fileExtension` | 按类别着色的 28px 文件或文件夹图形，以及它背后共享的不区分大小写文件名映射。代码与配置文件使用细分的全彩技术图形；链接前置图形使用 `LinkIconMedium`，图片内容使用图片预览。 |
| `languageForPath`、`CODE_HIGHLIGHT_EXTENSIONS`、`useCodeHighlighter` | 代码预览与 diff review 共用的惰性逐行 token 高亮。文件名 grammar 选择再导出自 `@deepseek-ai/dsh-util-code-language`，即 read 卡片持久化短 id `lang` 提示背后的同一张扩展名表。 |

有四组容易混淆：

- **`Tag` 与 `Pill`。** 11px 胶囊尺寸的只读徽章用 `Tag`；胶囊可选中（`active` 与 `onClick`，视图切换与筛选器就是这样用的），或者必须落在 24px 文本行上时用 `Pill`——`TerminalBlock` 把退出状态渲染成静态 `Pill` 正是后一种情况。这里尺寸和是否可交互同样是判据，两者不可互换。
- **`Pill` 与 `SegmentedControl`。** 一排 `Pill` 是一组彼此独立的 chip——每个各自开关，可以同时激活多个。`SegmentedControl` 是在几种互斥模式中选一，画成带一个指示块的 tablist，并自带 tab 键盘模式（方向键在分段间移动，只有选中项在 Tab 序列里）；模型设置页的新增卡片就用它切换两张表单。
- **`DisclosureRow` 与卡片。** 该行以固定 24px 把标题与内容左右排列。把名称叠在描述之上的卡片是另一种布局，属于功能包——`ui-settings-plugins` 的 `PluginCard` 是先例，并记录了原因。
- **`FoldToggle` 与对外导出面。** 它是包内组件，未导出；输出卡片用它做头尾折叠。

需求确实特殊时，在自己的包里写自己的组件没有问题。不可以的是复制这里已有的控件——而当第二个包需要同一个控件时，它就该住进本包（[决定](../../../.agents/notes/implemented/architecture/2026-09-05-shared-client-control-primitives.zh.md)）。

### 控件与图标

上面的目录说明每个导出的用途；本节讲 props 本身看不出来的行为。产品图标名称不含画板尺寸，以 `Regular` 表示原始 1px 图形，以 `Medium` 表示同一几何的 1.3px 描边；`size` prop 控制渲染尺寸（[决定](../../../.agents/notes/implemented/architecture/2026-09-16-size-neutral-product-icon-weights.zh.md)）。每个产品、引用、链接与权限图形都会有意保留两种线重导出，即使当前产品只使用其中一种，也让调用方无需再次扩展 API 就能选择强调程度；仅填充的成对图形外观相同。`IconWarningOutlineRegular`/`Medium` 使用圆形；`IconWarningTriangleOutlineRegular`/`Medium` 使用圆角三角形。`FishLogo` 与 `BrandWordmark` 填充品牌 slot。`FileTypeIcon` 渲染传统的 28px spreadsheet、folder、HTML、image、Markdown、generic、PDF、PPT、video 与 Word 图形，并为现有 48 个代码和配置类别使用导入的方形技术图形。该导入只替换图形：资源包中额外的类别不会扩展 `CodeFileType`。`classifyFileType` 按完整文件名、前缀、后缀、可选项目上下文、扩展名的顺序匹配；React 文件名优先于 TypeScript/JavaScript，Angular 后缀优先于基础扩展名，只有传入的项目文件包含带 `flutter:` 的 `pubspec.yaml` 时 Dart 文件才使用 Flutter。Markdown 与 SVG 仍分别使用传统 Markdown 与图片图形。表格映射包括 CSV、TSV、Excel 工作簿与模板、OpenDocument 表格和 Numbers；KEY 映射为幻灯片，RTF/ODT/Pages 映射为文档。`fileExtension` 为相邻元数据 label 暴露同一套 basename 与最终点号解析。传统图形使用实色分类底板、白色标记和半透明白色折角；通用代码图形使用尖括号与斜线，保留原图 1.35px 描边；通用文件使用灰色底板与较深灰色折角。调用方可通过 `--dsh-file-type-icon-color` 覆盖底板颜色。全彩技术图形是明确例外，会保留其内嵌调色板。所有图形都是装饰性的，不自带 label。`LinkIconMedium` 是可点击产物链接的前置图形——地球、文件夹、代码、图片、文档或纸张，`url` 链接的 `href` 指向已知站点时则改用该站点自己的标记——转写内容常引用的开发者站点（GitHub、GitLab、npm、PyPI、Stack Overflow、MDN、Wikipedia、Hacker News、YouTube、X、Bilibili、知乎、掘金、CSDN），以及主流搜索、视频、社交、购物与参考资料站点（Google、百度、DuckDuckGo、TikTok、Netflix、Spotify、Facebook、Instagram、Reddit、Telegram、WhatsApp、微信、QQ、微博、淘宝、速卖通、eBay、Quora、V2EX、Apple）——`classifyLinkPath` 把共享文件类型折叠进原有六类词汇。`ConnectionIndicator` 可渲染警告色的断联操作（常驻重试图形指明重试动作，断联文案由持有方提供）、与文案使用相同警告色的共享 ongoing loading 加一至三个点以独立于 retry 时序的 500ms 节奏推进的连接中状态，或成功色的恢复状态。点击任一警告状态都会请求立即重连；没有任何悬停交互会改变文案。药丸出现时淡入、卸载前淡出 150ms，宽度随当前 label 自适应。它的持有方提供可见性、恢复驻留时间、本地化 label 与立即重连回调；该原语不使用原生 title tooltip。`useAnchoredPosition` 与 `useAnchoredMaxHeight` 让浮动面板与底部锚定浮层始终钳制在视口内并跟随锚点；`useAnchoredMaxHeight` 与 portal 模式的 `Menu` 会把 12px 的视口顶部边距加宽到框架发布的 `--dsh-frame-top-clearance`。`HoverCard` 通过指针离开宽限期让采用 portal 的预览在跨过锚点间隙时仍可触及，并可通过 `copyText` prop 提供复制按钮。其 `preview` 变体使用 anchor 或 `widthAnchorRef` 元素的宽度减去 48px，左右各内缩 24px，并在视口内放置于行的上方或下方。浮层避开框架顶部保留区，高度最多 420px，会跟随内容及 anchor 尺寸变化；Escape 或通过鼠标和键盘激活锚点可将其关闭。整个浮层的淡入和淡出各持续 100ms；关闭中的浮层停止接收指针输入，淡出后卸载。在淡出期间移回锚点可恢复显示。减少动态效果偏好会禁用过渡动画。只有启用复制时才必须提供复制标签。锚点中嵌套的 `Tooltip` 在显示悬停或焦点标签时隐藏该预览；嵌套提示释放、禁用或卸载后，仍处于打开状态的预览会恢复。`Toast` 使用调用方的 `holdMs` 同时控制淡出延迟与停留加淡出的总时长。`holdMs` 未变时，父组件重渲染不会重启该生命周期；完成时调用最新回调，完全淡出的操作不能接收输入。新的组件 key 会重新开始横幅周期。`rankByName` 是 `/` 菜单命令源与 skill（技能）源共享的候选排序器：查询必须是名字的不区分大小写的有序子序列；前缀命中排最前，其次按对齐分数，再按来源顺序。 portal 模式的 `Menu` 列表会在拖动和 CSS 变换期间跟随锚点，并在关闭时停止跟踪。`Menu.autoFocus` 聚焦首个启用项，支持上下方向键与 Home/End 导航，并在 Escape 时聚焦 anchor 内的第一个按钮；操作菜单可显式启用。

`Tooltip` 在悬停或键盘聚焦时读取锚点位置，再根据 `ResizeObserver` 提供的边框盒尺寸调整气泡。首次定位前气泡保持隐藏；横向移入视口留白，仅在另一侧容得下时上下翻转。标签尺寸与视口变化复用锚点坐标；定位不会同步测量气泡，也不会触发 React 渲染。

### 渲染 agent 输出

最近的 `MarkdownDelegateProvider` 提供可选的 `openExternalLink` 和 `openFile` 导航回调。嵌套 Provider 替换外层能力，回调变化无需重新构建 Markdown 即可到达已渲染链接。其 `openFile` 使本地 Markdown 链接在落定后可点击。绝对路径和工作区相对路径支持百分号转义以及 `#L24` / `#L24-L30` 片段；范围定位到起始行。文件名中的字面 `?` 和 `#` 必须百分号编码。悬停提示使用解码后的路径，并在标签为空时提供可访问名称。回调接收解码后的路径和可选行号，渲染器保留标签并显示文件图标。不传回调时，本地链接仍为文本。URL 协议、查询串、不支持的片段及格式错误的目标不会传给文件打开器。

`MarkdownText` 渲染不可信的 GFM 与 TeX 公式、阻止不安全的链接与图片，并可把已解析的文件提及转换为显式控件。外层 `MarkdownDelegateProvider` 会接收普通点击产生的已净化 HTTP(S) URL；带修饰键的点击和 Provider 外的链接保留原生外部 anchor 行为。当 owner 传入 `pathImages` 词表时，本地媒体路径的图片目标只在落定渲染阶段重写为可展示 URL（与 file mentions 相同的流式门）；不传词表时本地目标保持惰性 alt 文本。重写后的图片支持 HTTP(S)、data、blob 及桌面端 `dsh-app://app/api/file` 路由；正文直接书写的桌面端 URL 仍保持惰性。加载或解码失败后，图片替换为作者的 alt 文本；alt 为空时显示原始目标路径；`fileImages` 还提供本地化的失败提示前缀。图片源变化后可重新加载。回复流式输出时，它冻结已完成的块、按已完成行推进顶层未闭合 fence，并从保存的 Shiki grammar state 为该 fence 增量高亮。已完成的 token 行进入固定大小的 React 分组，后续分片只 reconcile 正在增长的分组；最终全量解析解决跨文档语法时，未变化的 fence 会保留该 DOM。`TerminalBlock`、`ReadBlock`、`DiffBlock`、`SearchBlock` 与 `WebBlock` 把对应的工具结果意图渲染为带复制控件、溢出处理及适用时 ANSI 处理的卡片。`JsonTree` 与 `JsonBlock` 以只读方式检查 JSON 值；`projectUserText` 把已发送的用户文本投影为行内普通文本段与引用 chip，供消息气泡和排队行使用。引用名称继承调用方的换行规则：长名称在气泡内换行，排队预览保持单行布局。传入 `UserTextReferences` 时，文件和 skill 引用成为支持键盘操作的预览按钮，复用正文文件链接的悬停和聚焦样式；第一次指针点击可以打开预览，后续点击和已有选区保留原生选择行为。键盘激活在存在选区时仍可打开预览。

`MarkdownText` 默认为 `variant="body"`。次级内容使用 `variant="compact"`：其 13px 字号与 20px 行高跟随内容字号设置，各级标题保持同一字号并使用 600 字重，段落与列表采用更紧凑的间距。正文、链接和代码均保持 tertiary 颜色，以点状下划线区分链接。代码标题栏随代码块滚动。表格和公式仍然启用，使用周围文字的字号，并在可用宽度内横向滚动。两个变体共享解析器与流式缓存。

`CodeBlock.toolbarLabels` 启用共享代码卡片的标题栏和间距。`ReadBlock` 与 `DiffBlock` 使用相同的标题栏：tertiary 色的语言名称与文件名、secondary 色的复制与换行图标，以及悬停或键盘聚焦时的提示。语言缺失或不受支持时显示调用方提供的本地化代码块标题；混合语言的 Diff 也使用该标题。代码卡片共用字体和内容内边距；在两种主题下，标题栏和正文都使用相同背景。读取卡片的行号栏容纳返回窗口中的最大行号，Diff 底色覆盖完整可滚动行。换行按钮保留固定的无障碍名称，以 `aria-pressed` 表达状态；提示文本说明下一步操作。换行设置仅属于当前挂载的卡片，不改变复制的文本；代码围栏默认换行，读取和差异卡片则在启用换行前保留源码列位置。紧凑 Markdown 共用此工具栏、间距和代码字体排版，同时保留单色文本。源码预览传入 `toolbarLabels` 后，可用 `wrap` 跟随所属视图的换行设置，仅显示语言和复制图标；所属视图的 CSS 保留源码布局。

`DiffBlock` 按行比较新旧内容。它显示实际增删行及两侧最多三行中性上下文，用 `⋯` 分隔远距离改动，工具摘要的统计不计入共享上下文。卡片在差异正文后结束。若一个片段需要超过 256 次行新增或删除，则停止精确比较；该片段按完整新旧内容显示和统计为粗粒度替换，包含共享行。复制包含完整显示 diff 及其前缀。末尾换行视为行终止符；仅末尾换行不同不会显示为改动。

`JsonTree` 把折叠字符串限制为 `collapsedStringLines` 行（默认三行）。展开后显示原始文本、保留同级逗号，并限制在窗口与外层滚动容器内；尺寸变化和祖先滚动事件会更新此限制。行复制反馈独立于 JSON 值渲染更新；尚未完成的剪贴板写入不会更新另一行或已卸载的树。

`ImageLightbox` 是共享原图浮层，支持焦点恢复与 Esc 关闭。包内缩略图渲染器由调用方提供加载及失败文案。`HoverCard.inline` 使文件链接保持在文本流内，并使用共享菜单材质、键盘可见焦点，并在锚点上方或下方定位而不遮挡锚点。即使焦点位于其他位置，Esc 也会关闭已打开的缩略图；后续 Esc 按键继续传给 owner。`MarkdownDelegateProvider.fileImages` 提供已解码路径解析器与完整图片文案：消息落定后的图片链接支持悬停预览，独立图片支持点击放大。仅包含图片的链接保留单一导航目标。解析器仅恢复完整、未转义、独立成段且带明确图片扩展名的含裸空格本地图片引用；代码与有歧义的目标保持原文。

### 本地化文案

这些原子组件无法读取应用 locale，因此每段面向用户的文案都必须通过 label prop 提供。`HoverCard`、`TerminalBlock`、`JsonTree`、`CodeBlock`、`MarkdownText`、`JsonBlock`、`ConnectionIndicator`、`Modal`、`DiffBlock`、`ReadBlock`、`SearchBlock` 与 `WebBlock` 接收完整的本地化 label。本包不拥有语言回退；遗漏会导致类型检查失败，各功能会把带类型的 `t` 席位映射到 primitive 的 label 接口。

-----

<a id="understand-the-implementation"></a>
## 理解实现

`Button` 的 `md` 使用 H36/R12，`sm` 使用 H28/R8，包含描边控件。菜单与卡片遵循[共享圆角规则](../../../docs/web-styling.zh.md#corner-radii-and-settings-cards)；功能样式保留控件几何。

`Menu.listClassName` 独立控制菜单卡片样式，不影响入口容器，也适用于 portal 模式。前置图标使用 `--dsw-alias-menu-icon` 文本色；破坏性操作图标保留错误色。

`Menu` 将卡片材质交给 `MenuSurface`，自定义菜单也使用该组件。`MenuSurface` 转发 div 属性和 ref，采用透明填充及模糊，`compact` 使用较小圆角。默认相对定位使材质层限制在容器内；调用方的类可以设置 fixed 或 absolute 定位。macOS 上，不接收交互的底层通过 CSS 锚点跟随卡片，并随卡片卸载；该底层要求 Web 外壳隔离 body 的层叠上下文。功能类控制布局和层级，组件负责材质和外圆角（[菜单规则](../../../docs/web-styling.zh.md#component-rules)）。 模态遮罩保留黑色半透明填充，不模糊背景。

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
| [`src/icons/`](src/icons/) | 与尺寸无关的 `Regular` 和 `Medium` 产品图标组件 |
| [`src/code-highlighting.ts`](src/code-highlighting.ts) | 共享的文件名 grammar 选择与惰性逐行高亮 |
| [`src/input-modality.ts`](src/input-modality.ts) | 全文档输入模态，发布到 `<html>` |
| [`src/plugin-artwork.tsx`](src/plugin-artwork.tsx) | 固定配色插件插画，SVG def id 按实例生成 |
| [`src/useAnchoredPosition.ts`](src/useAnchoredPosition.ts) / [`src/useAnchoredMaxHeight.ts`](src/useAnchoredMaxHeight.ts) | 浮动面板与浮层几何钩子 |
| [`src/settings-form/`](src/settings-form/) | 设置页套件：基于设置 scope 的暂存表单模型、值字段与密文字段、表单框架 |

<a id="input-modality"></a>
### 输入模态

[`input-modality.ts`](src/input-modality.ts) 为 tooltip 跟踪输入，并在 `<html>` 上发布 `data-input-modality`，供[主题焦点样式](../ui-theme/README.zh.md#understand-the-implementation)使用。`pointerModality()` 在指针输入后为 true，在任意按键后为 false，包括 IME（输入法）组合输入按键；`Tooltip` 据此决定聚焦时是否可以显示气泡。发布的属性保持 `pointer`，直到非组合输入的导航键（Tab、方向键、Home/End、PageUp/PageDown）到达，或非组合输入按键之后焦点移到不同控件。重新聚焦同一控件不会恢复键盘模态。指针输入、IME 组合输入按键和 window blur 都会清除待处理按键；没有待处理按键的焦点变化不改变模态。监听器与文档同寿命；从 Node 导入时不安装监听器。 焦点变化规则只观察传到 window 的事件；shadow root 内部不向外暴露这些事件的额外导航由组件负责。

### 流式 Markdown

回复流式输出期间，`MarkdownText` 增量解析：除末尾两个块外全部冻结为缓存的 React 元素，每个分片只重新解析其后的源文本尾部，因此每分片的工作量跟随尾部而非整个回复。末尾的顶层未闭合 fence 会保留已解析的 code node，只把最后一个已完成行与当前未完成行交给同一套 GFM grammar；闭合 fence 或有歧义的解析会回到普通尾部路径。高亮同样从保存的 Shiki grammar state 续接，并只发布新完成行与可变尾部。`CodeBlock` 把已完成行封入固定大小的 React 分组、复用更早的分组，并在代码与语言未变化时跨定稿保留整棵高亮树。定稿时的全量解析仍会解析跨过冻结边界的引用。

### 几何与溢出

输出卡片共享同一套几何模型：`white-space: pre` 并横向滚动，让按列对齐的内容保持对齐；超过 `maxLines`（默认 16）时折叠为头部切片加尾部切片，由展开按钮控制，长正文不会撑高卡片。`TerminalBlock` 把 ANSI 解析为 React span，并带逐行列缓冲处理光标移动，遵循行内擦除、制表位与字符宽度。宿主可按表层选择退出共享几何：把 `--dsl-terminal-command-whitespace` / `--dsl-terminal-line-whitespace` 重绑为 `pre-wrap` 让命令与输出完整换行且不横向滚动；`maxLines: Infinity` 为改用 `--dsl-terminal-output-max-height` 限高滚动的宿主禁用折叠；`copyText` 覆盖复制载荷（并让控件在任何输出出现之前就保持渲染）；`runStateDot: false` 在外围行已携带同一状态时省去状态点，并经 `--dsl-terminal-gutter` 收回其落区。横幅分割线跟随渲染出的正文：正在流式输出的 running 卡片像已结束卡片一样把命令与文本分隔开。

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
- **已知站点标记是固定列表**：只有列名的主机解析为自己的标记，其余外部主机仍使用地球；要识别任意站点需要通过网络抓取它的图标。
- **流式期间跨边界引用解析被推迟**：定义落在增量冻结边界另一侧的引用式链接或脚注，在回复流式输出期间渲染为字面文本；定稿时的全量解析会将其解析。
- **长高亮 fence 会保留完整 token DOM**：流式路径避免重新解析、重新 tokenize 和 reconcile 已完成前缀，但不会丢弃旧颜色或虚拟化 token span。因此最终 DOM 数量仍随 fence 的 token 数增长；嵌套／容器内 fence 与病态的单个超长行仍走通用尾部路径。
- **鱼形标志是重新绘制的近似版本**：它来自字体字形，而本地设计数据无法导出其矢量几何；在获得精确导出路径前，使用手工重建版本代替。
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
