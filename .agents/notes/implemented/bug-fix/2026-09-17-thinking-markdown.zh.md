# Agent Note: Thinking 的紧凑 Markdown

Status: implemented

[English](2026-09-17-thinking-markdown.md) | 中文

## 问题

Chat Thinking 包含模型编写的 Markdown，但纯文本渲染直接显示标题、强调标记和代码围栏。共享回答排版会让标题比次级推理文本更大、更醒目。Trajectory 对同一推理内容使用了回答排版。

## 决策

[MarkdownText](../../../../packages/client/ui-primitives/src/markdown/MarkdownText.tsx) 拥有紧凑展示变体，供 Chat Thinking 和 Trajectory 思考详情使用。内容沿用次级字号、行高和 tertiary 颜色。各级标题保留语义元素，但统一使用 600 字重和相同字号；段落、列表、引用和代码采用紧凑间距。链接保留默认点状下划线与 tertiary 颜色，作为[共享链接样式](../../../../docs/web-styling.zh.md)的次级内容例外；代码保留等宽字体和底色。

表格和公式继续通过既有解析器启用。其容器限制横向溢出，公式文本继承次级字号。行内公式保留 KaTeX 原生基线，由外层文本块承担溢出处理，短公式不会产生滚动条。紧凑代码栏保持正常文档流，让 [Thinking 折叠标题](../../../../packages/client/ui-chat/src/client/chat/ReasoningRow.module.css) 位于滚动内容上方，无需第二条 sticky 栏。

Chat 将运行状态传给既有增量 Markdown 渲染器。折叠摘要仍是独立的单行文本投影。解析器、冻结块缓存、存储的推理内容和 Session 格式均保持不变。Trajectory 将 Thinking 固定在检查器的 13px/20px 层级，与 Chat 的内容字号设置无关。其回答输出保留既有排版及其 [Thinking 折叠行为](../feature/2026-09-09-ptc-trajectory-code-inspection.zh.md)。

## 曾考虑的替代方案

**直接使用回答排版。** 大标题和宽松块间距让推理比回答更醒目。

**由每个使用方单独设置 Markdown 样式。** Chat 和 Trajectory 将需要分别跟踪相同的渲染元素；基元拥有这些元素及其紧凑展示。

**禁用表格和公式。** 既有渲染器已支持二者。限制溢出和继承字号可以保留有用内容，无需增加另一种解析模式。

## 后果

Thinking 支持结构化阅读，同时保持次级强调。虽然视觉层级被统一，辅助技术仍可使用语义标题。共享变体同时用于两个视图；后续 Markdown 元素变更必须同时保留紧凑排版与默认回答排版。

Markdown 软换行与回答正文一样折叠；硬换行和独立段落需要相应 Markdown 语法。流式冻结以完整块为单位，因此尚未结束的长段落仍处于可变尾部，并随增长重新解析。
