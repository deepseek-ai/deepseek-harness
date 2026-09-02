# Web UI 样式参考

[English](web-styling.md) | 中文

本文规定浏览器客户端包的样式职责归属与组件规则。当前 token 值位于 [`packages/client/ui-theme/src/styles/`](../packages/client/ui-theme/src/styles/)；本文不重复这份由源码生成的清单。

## 职责归属

[`ui-theme`](../packages/client/ui-theme/README.zh.md) 负责 `--dsw-*` 静态色阶、语义别名、排版、动效、渐变、阴影、滚动条样式以及明暗主题偏好。[`ui-layout`](../packages/client/ui-layout/README.zh.md) 将解析后的主题快照应用到文档。功能包使用语义别名，不得另行定义全局主题。

全局样式表归 `ui-theme/src/styles/` 所有。组件样式以 CSS Modules 形式放在组件旁。当某个值属于该组件的布局或呈现约定时，组件可以定义局部自定义属性；共享颜色、排版、层级和动效属于主题包。

## 组件规则

- 使用 CSS Modules 和 `clsx`；不得添加组件库或 Tailwind。
- 功能组件使用 `--dsw-alias-*` 语义 token。不得复制静态色板值或在其中写入颜色字面量。
- 功能组件 CSS 不得包含主题选择器。明暗主题覆盖属于主题所有方。
- 字体大小必须与行高配对；已有角色匹配时使用主题排版变量。
- 当组件约定要求保留列结构时，源码文本、终端输出和 diff 行不得换行；使用共享滚动条样式，不得定义组件专用滚动条选择器。
- 呈现规则写在 CSS 中。React 内联样式可以传递组件局部自定义属性值，但不得编码主题分支。
- 添加过渡动画或仅悬停可见的控件时，保留清晰可见的键盘焦点和减少动态效果行为。
- 支持的引擎上，圆角继承 ui-theme `corner-shape.css` 的全局超级椭圆平滑。每个正圆 `border-radius`（`50%`、`100%` 或胶囊半径）必须配对 `corner-shape: round`，使圆形与胶囊保持圆弧；ui-theme 的 corner-shape spec 强制这一配对。
- 高层级表面（菜单、浮层、对话框、面板、悬浮按钮、输入框）设 `border: 0` 并使用 `box-shadow: var(--dsw-elevation-panel)`、`var(--dsw-elevation-prominent)` 或输入框专用的 `var(--dsw-elevation-soft)`（更大模糊、更低透明度）：0.5px 发丝描边是第一层投影，`--dsw-elevation-stroke-color` 可按表面或状态重绑或抑制描边。不得将 `--dsw-alias-border-*` border 与 lv/elevation 投影配对——ui-theme 的 elevation spec 会拒绝；状态色 border（warn 面板）保持真 border。
- 使用中性 `--dsw-alias-border-*` token 的平面边框与分割线一律 `0.5px`——按钮、输入框、卡片、行分割线，以及以填充盒绘制的分隔线（菜单分隔、对话标题栏接缝、markdown `hr`、竖向轨道线）共用发丝线粗细，Chromium 将其绘制为一个设备像素。dashed 记号与状态色 border 保持 1px；spinner 圆环经 spec 的显式豁免保留原宽度。更宽的中性 solid border 会被 ui-theme elevation spec 拒绝。

## 变更系统

在所属 `ui-theme` 样式表中添加或修改共享 token，然后在功能包中使用其语义别名。公共样式约定发生变化时，更新所属包的参考文档。视觉行为遵循[测试策略](testing.zh.md)；[样式系统 Agent Note](../.agents/notes/implemented/process/2026-07-19-web-styling-system.zh.md) 记录框架依据。
