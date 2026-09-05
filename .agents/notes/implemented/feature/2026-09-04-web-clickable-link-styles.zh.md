# Agent Note: Web 可点击链接语言——链接别名、hover 点状下划线、分类图标

Status: implemented

[English](2026-09-04-web-clickable-link-styles.md) | 中文

## 问题

会话记录里的可点击产物链接有四套互不一致的样式：Markdown 锚点和正文文件引用是 business-primary 蓝加 hover 实线下划线，网页搜索/抓取链接与之相同，产物 chips 是灰色药丸（interactive-bg-hover 底上的 label-secondary 文字，96px 最大宽度），workflow 成员链接则带常驻实线下划线。没有任何标记说明链接点开后去哪儿（浏览器、宿主应用、Finder、应用内视图），而且链接颜色耦合在 `--dsw-alias-state-business-primary` 上——它同时驱动焦点环和状态点，调链接色会波及无关表面。

## 决策

会话记录的可点击链接表面——Markdown 锚点（含引用式链接、mailto、被提升为链接的 inline code）、正文文件引用、网页搜索来源链接与抓取 URL、产物 chips、workflow 成员链接——统一为一套链接语言：

- 颜色经由 `design-platform.css` 中专用的 `--dsw-alias-link` 别名（亮色 `deepseek-500`，暗色 `deepseek-400`），与 `state-business-primary` 解耦；链接以 `font-weight: 500` 呈现，默认无下划线，hover/focus 时为 3px offset 的 `underline dotted`。
- 前置分类图标——ui-primitives 新增的 `LinkIcon`，kind 为 `url`（地球）、`folder`、`code`、`image`、`document`、`other`（纸张）——只渲染 `currentColor`；`classifyLinkPath` 按扩展名推导文件类别，代码、网页、数据扩展名按设计共用 code 图形。两类锚点不带图标：workflow 成员链接（应用内成员视图不属于任何文件或 URL 类别）和只包图片的锚点（徽章或缩略图——图片旁悬着的地球没有可引导的文字）。行内图标为 1.1em、基线偏移 −0.25em；flex 居中的产物图标则下移 1.2px，因为 22px 文字盒的字形低于盒中心。
- 产物 chips 去掉灰色药丸和 96px 上限：纯链接蓝文字按自然宽度展示，仅当整行溢出时才收缩出省略号；容器查询档位在决定展示几个 chip 时仍按每个 96px 预算。
- 刻意不动：ToolRow 的灰色点线文件链接，以及灰色的「在文件夹中显示」操作（它获得文件夹图标但保持灰色样式）。
- 同一批次中，inline code 底色从 `neutral-bluish-100` 换到 `neutral-50`（暗色：`neutral-800`），并新增 0.5px l1 描边。

覆盖：LinkIcon 单测（每个 kind 一个独立图形、分类表）、刷新后的 markdown-dom 夹具，以及 `clickable-links-gallery` web e2e——一个 settled 的 keyless 回合渲染全部可点击链接形态——像其他引 scaffold 的同类一样注册进 host 编译面（`tsconfig.host.json`）。

## 备选方案

- **彩色 Word/Excel/PPT/PDF 品牌图形。** 实现后又移除：固定品牌填充违反图标集 currentColor-only 规则，这些扩展名并入单一的 outline `document` 图形。
- **每个扩展名一个图标。** 收敛为六个类别：14px 下超出肉眼可分辨数量的图形只会增加噪音，按站点的 favicon 以后仍可在同一 `url` 类别之下引入。
- **链接继续用 `state-business-primary`。** 更深的链接蓝（试过 blue-600/650/700 又回退）会连带焦点环和状态点；专用别名把未来的调色收敛到一行。
- **给 ToolRow 路径链接加图形。** 否决：工具行保持更安静的灰色点线示能，在已经很密的行里加前置图形会造成图标堆叠。

## 后果

- 新的可点击产物表面应消费 `--dsw-alias-link` 和 LinkIcon 词汇，而不是引入另一种颜色或下划线形态；规则记录在 [docs/web-styling.md](../../../../docs/web-styling.zh.md)。
- 长产物文件名按自然宽度展示；整行溢出时 flex 按比例收缩所有 chip，几个长名字一起收缩，而不是最后一个先让位。
- mailto 链接目前共用 `url` 地球图形；若将来需要独立的邮件类别，一行即可加上。
