# Agent Note: Settings 支撑的会话正文字号

Status: implemented
Archived: 2026-09-04

[English](2026-08-18-settings-font-size-control.md) | 中文

## 问题

会话正文字号是固定的（markdown 阶梯按 0.875 重缩放后为 14px）。用户需要一个设置项：在 General → Appearance 下加一行「字号大小」，用步进器交互，范围 12–17，默认 14，同时调整转录正文与 composer 输入框的文字大小。

## 决策

**主题插件拥有该设置。**`ThemeSettingsSchema` 在既有 `ui-theme` namespace 的 `preference` 旁新增 `fontSize`（`z.number().step(1).min(12).max(17).default(14)`）——一个持久化 section、一个 settings scope、一条采纳路径。`ThemeRuntime` 在 `ThemeSnapshot` 中携带 `fontSize`，暴露 `setFontSize(px)`（校验整数与范围，越界抛教学式错误），并通过 `theme/change` 重新发布。同一插件把 FontSizeRow 注册进 `settings.general.item`，order 11，紧挨外观方块（order 10）之下。

**呈现走既有快照管线。**服务绝不接触 DOM：ui-layout 的 `ThemePresenter` 依据每份快照在 `body` 上写 `--dsh-content-font-size`（dispose 时收回），Host 引导脚本把持久化值嵌入 index 响应，让首帧就使用所选字号——与暗色属性同一条插件前路径，避免字号闪变。

**一个 CSS 增量变量平移阶梯，另派生一个低一档层级。**`gradient-shadow-text.css` 派生 `--dsh-content-font-delta: calc(var(--dsh-content-font-size, 14px) - 14px)`，把 markdown h1–h4 与 base 各变体（字号与行高）按同一像素增量平移，保持标题层级与各变体的行距。低一档文本——比正文低一档——读 `--dsh-content-font-size-secondary: min(设置值 − 1px, max(13px, 设置值 − 2px))`：设置 ≤14 时为设置值 −1，>14 时为设置值 −2（12→11、13→12、14→13、15→13、16→14、17→15），其行高经 `--dsh-content-font-delta-secondary`（低一档值 − 13px）随动。低一档覆盖：markdown 表格变体、共享 DisclosureRow 标题（工具调用、think、命令）、ToolRow/bash 行的 summary 与文件链接、think 正文、compaction/context/retry/错误行、StatsLine、chat 提示与打开失败条、workflow-run 面板的头部/计数/状态、回合状态时钟、引用摘要与笔记触发标签。small 与 code 变体保持固定——中断回合的 `.stopped` 标签（11px）同样固定：它们是密集次级文本，其默认值在字号下调时会低于可读下限。token 阶梯之外按正文档读取的消费方直接使用 `var(--dsh-content-font-size, 14px)` 与 `calc(<默认行高> + var(--dsh-content-font-delta, 0px))`：助手正文根节点、用户气泡（含行内引用字形）、composer 卡片（其 textarea/mirror/backdrop 三层按设计从卡片继承字体度量）、compaction/DisclosureRow 的行几何（行高、leading 盒、展开内容的 `22px + delta` 缩进）、消息时钟与图标操作（slot 注入的消息反馈操作经同一对变量同步缩放），以及回合状态行。流内图标经由各 leading 盒的 CSS 边长缩放（`svg` width/height 覆盖字形自身属性）；StateDot 通过其 `data-state` 属性豁免——它是状态标记，不是文字组件。回退值（正文 14px、低一档 13px）让变量缺席时（测试、独立挂载、采纳前的远程组合）所有表面逐像素不变。

**步进器是药丸控件，不是菜单。**该行复用选择器药丸几何（h36 r18 模块填充），数值在药丸内居中，上下箭头列在 hover/focus-within 时显示并绝对定位在药丸右缘（显示时数值不移动），药丸后带 `px` 单位标签。标题下方的三级说明行标明作用范围——字号仅影响会话内容，不影响应用外框。到达边界时对应箭头禁用；显示跟随 store 镜像，绝不跟随点击回声——与外观行相同的 store/face 模式。

## 已考虑的替代方案

**独立 settings namespace 或独立插件。**否决：字号与主题偏好具有相同的持久化、采纳与远程浏览器语义，属外观偏好；为一个整数复制一套 scope 机制不值得。

**用倍率（`em`／百分比）而非像素增量缩放。**否决：乘法会让 12–17px 的范围在阶梯上不成比例地放大（21px 的 h1 会摆动到约 18–25.5px），并产生小数行高；固定像素平移让每一档都是整数，层级间的像素差保持不变。

**缩放全部字体 token（code、small）。**否决：这些变体按设计就是密集文本；−2 档时 small 阶梯会降到 10px、code 降到 9px，低于可读下限。表格变体改为并入低一档层级，在 12px 设置下触底 11px——与 think 文本在该设置下相同。

## 后果

0.875 的 markdown 阶梯重缩放（正文 16 → 14）作为新的默认渲染随本变更一同交付；默认设置下正文档消费方与该重缩放基线一致，低一档渲染为 13px（低一步——这是对此前按正文档渲染的流内行标题与摘要的有意降档）。无变量的表面回退到同样的默认值。修改后的字号持久化在 `$DSH_HOME/settings.yaml`，重载不闪变（引导脚本在 hydration 前写入持久化值，`ThemeRuntime` 以它为初始快照种子），在转录与 composer 上实时生效；远程浏览器沿用主题偏好既有的进程内选择规则。`setFontSize` 与 `setTheme` 一同进入模型可见的 cordis 客户端 API 目录。
