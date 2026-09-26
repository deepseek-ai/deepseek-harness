# Web UI 样式参考

[English](web-styling.md) | 中文

本文规定浏览器客户端包的样式职责归属与组件规则。当前 token 值位于 [`packages/client/ui-theme/src/styles/`](../packages/client/ui-theme/src/styles/)；本文不重复这份由源码生成的清单。

## 职责归属

[`ui-theme`](../packages/client/ui-theme/README.zh.md) 负责 `--dsw-*` 静态色阶、语义别名、排版、动效、渐变、阴影、滚动条样式以及明暗主题偏好。[`ui-layout`](../packages/client/ui-layout/README.zh.md) 将解析后的主题快照应用到文档。功能包使用语义别名，不得另行定义全局主题。

全局样式表归 `ui-theme/src/styles/` 所有。组件样式以 CSS Modules 形式放在组件旁。当某个值属于该组件的布局或呈现约定时，组件可以定义局部自定义属性；共享颜色、排版、层级和动效属于主题包。

<a id="component-rules"></a>
## 组件规则

- 重新设计控件样式之前先复用控件：[ui-primitives 组件目录](../packages/client/ui-primitives/README.zh.md#component-catalog)是唯一跨功能包的通道，有意的视觉差异应作为那里的一个 prop，而不是另起一份拷贝（[决定](../.agents/notes/implemented/architecture/2026-09-05-shared-client-control-primitives.zh.md)）。
- 使用 CSS Modules 和 `clsx`；不得添加组件库或 Tailwind。
- 功能组件使用 `--dsw-alias-*` 语义 token。不得复制静态色板值或在其中写入颜色字面量。
- 功能组件 CSS 不得包含主题选择器。明暗主题覆盖属于主题所有方。
- 字体大小必须与行高配对；已有角色匹配时使用主题排版变量。
- 当组件约定要求保留列结构时，源码文本、终端输出和 diff 行不得换行；使用共享滚动条样式，不得定义组件专用滚动条选择器。
- 呈现规则写在 CSS 中。React 内联样式可以传递组件局部自定义属性值，但不得编码主题分支。
- 添加过渡动画或仅悬停可见的控件时，保留清晰可见的键盘焦点和减少动态效果行为。
- 支持的引擎上，圆角继承 ui-theme `corner-shape.css` 的全局超级椭圆平滑。每个正圆 `border-radius`（`50%`、`100%` 或胶囊半径）必须配对 `corner-shape: round`，使圆形与胶囊保持圆弧；ui-theme 的 corner-shape spec 强制这一配对。
- 高层级表面（菜单、浮层、对话框、面板、悬浮按钮、输入框）设 `border: 0` 并使用 `box-shadow: var(--dsw-elevation-panel)`、`var(--dsw-elevation-prominent)` 或输入框专用的 `var(--dsw-elevation-soft)`（更大模糊、更低透明度）：0.5px 发丝描边是第一层投影，`--dsw-elevation-stroke-color` 可按表面或状态重绑或抑制描边。不得将 `--dsw-alias-border-*` border 与 lv/elevation 投影配对——ui-theme 的 elevation spec 会拒绝；状态色 border（warn 面板）保持真 border。
- 存量和新增的下拉菜单、上下文菜单、子菜单及选择菜单使用 `Menu`，自定义内容用 `MenuSurface` 包裹。材质由主题的 `--dsw-menu-surface-fill` 和 `--dsw-menu-backdrop-filter` 组成；功能及平台 CSS 不得覆盖两者。ui-theme 菜单检查拒绝未使用共享容器的 menu/listbox 渲染、材质覆盖和 token 重定义。计划任务自有的 `TaskMenu` 与 `ClockPicker` 是明确例外，保留现有容器和材质（[所属包](../packages/client/ui-schedule/README.zh.md)）。
- 设置、确认框等模态弹窗保留黑色半透明遮罩，不模糊背景。主题将 `--dsw-mask-blur` 设为 `none`；Desktop 自有模态浮层也不对父页面施加模糊。
- 菜单背景模糊绘制在独立图层上，保证嵌套菜单和 fixed 浮层的定位及背景采样。macOS 上，`MenuSurface` 仅在各菜单范围内、页面内容后方添加实色底层，使 Chromium 能在原生透明材质上模糊页面内容；CSS 锚点跟随位置及尺寸，卸载时移除底层。没有该底层的浮层使用 `--dsw-specific-menu`，主题在 macOS 上将其设为 94% 不透明度，防止下方文字透出。其他使用该填充的浮起表面也须配套同一模糊；包含 fixed 浮层时，将两者绘制在独立背景层上（[决策](../.agents/notes/implemented/feature/2026-09-17-compact-translucent-menu-surfaces.zh.md)）。
- 使用中性 `--dsw-alias-border-*` token 的平面边框与分割线一律 `0.5px`——按钮、输入框、卡片、行分割线，以及以填充盒绘制的分隔线（菜单分隔、对话标题栏接缝、markdown `hr`、竖向轨道线）共用发丝线粗细，Chromium 将其绘制为一个设备像素。dashed 记号与状态色 border 保持 1px；spinner 圆环经 spec 的显式豁免保留原宽度。更宽的中性 solid border 会被 ui-theme elevation spec 拒绝。
- 可点击产物链接（Markdown 锚点、正文文件引用、网页来源与抓取链接、产物 chips、workflow 成员链接）经 `--dsw-alias-link` 着色、`font-weight: 500`，默认无下划线，hover/focus 时为 3px offset 的点状下划线。紧凑 Thinking Markdown 保持 tertiary 文字色和默认点状下划线（[紧凑展示](../.agents/notes/implemented/bug-fix/2026-09-17-thinking-markdown.zh.md)）。带文字的锚点另以 ui-primitives 的 `LinkIconMedium` 分类图形（随 `currentColor`）作前置；目的地是已知外部站点时改用该站点自己的标记而非地球；workflow 成员链接与只包图片的锚点不带图形，工具行文件链接保持其灰色点线示能。

<a id="corner-radii-and-settings-cards"></a>
## 圆角与设置卡片

圆角尺度、组件尺寸映射、正圆与胶囊例外、嵌套 hover，以及设置卡片的底色与描边统一由 [DSH 统一圆角规范](ui-radius.zh.md)定义。

## 变更系统

在所属 `ui-theme` 样式表中添加或修改共享 token，然后在功能包中使用其语义别名。公共样式约定发生变化时，更新所属包的参考文档。视觉行为遵循[测试策略](testing.zh.md)；[样式系统 Agent Note](../.agents/notes/implemented/process/2026-07-19-web-styling-system.zh.md) 记录框架依据。
