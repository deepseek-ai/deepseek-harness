# Agent Note: 已发送用户文本行内投影，Queue 行折叠 wire 引用

Status: implemented
Archived: 2026-09-04

[English](2026-08-21-inline-user-text-projection.md) | 中文

## 问题

已发送用户文本存在两个显示缺口，都早于 Lexical composer。用户气泡装饰器（`projectUserText`，当时是 `MessageItem` 的私有函数）把一条消息切成普通片段与引用 chip，但每个普通片段都经块级的 `MessageText` div 渲染——被装饰的单行消息因此被拆成每段一行，两个相邻 token 之间的单个空格更是渲染成一整行空白。另一处，queue dock 的只读行原样打印 `row.preview`，携带 chip 的排队消息因此显示 wire 会话形式 `@[查看并分析图片](dsh-session:InNlc3Npb24t…)`——面向模型的文本，作为预览不可读。两处的持久模型文本都是正确的（已对照会话日志字节核实）；两个缺陷都纯属呈现层。

## 决策

由一个共享的行内投影 `reference/user-text.tsx` 负责已发送用户文本的显示，气泡与 queue 行共同消费：

- **一切行内。** 普通片段渲染为 `span`；块级 `MessageText` 彻底退出该路径。换行策略归消费方：气泡声明 `pre-wrap`（真实换行保留），queue 预览保持 `nowrap`/省略号单行——共享 span 两者都不钉死。
- **wire 会话形式折叠。** 新增最高优先级规则把 `@[label](dsh-session:…)` 折叠为显示标签的会话 chip（原文保留在 `title`）。既有规则——recall 关联的精确标签、按形状识别的裸 `/name` / `@name` token——按原优先级跟随，因此折叠同时挡住了裸 token 扫描（否则它会把 URI 误读成文件路径）。
- **Queue 编辑态保持原文。** 行的编辑框展示未经处理的 `row.text`：用户编辑的正是将要发送的内容，折叠一个可编辑表面会让可见文本与持久文本脱钩。

`queue-actions.e2e` 的定位器从 `getByText(…).locator('..')` 改为行容器匹配（带 `hasText` 的 `li`）：投影多了一层 span，从命中文本向上跳一级不再落在行元素上。

## 曾考虑的替代方案

- **在排队模型文本旁另存一份显示文本**：否决——为呈现关切增加 wire/会话字段，违背单一真源；渲染期折叠不需要新状态。
- **编辑框内也折叠**：否决——编辑对象就是字面发送文本，可编辑表面折叠会让用户"编辑"一段并非实际发送的文本。
- **仅用 CSS 修气泡空行**（折叠空片段）：否决——片段的块级性是结构性的，且 queue 缺口本来就需要共享投影。

## 后果

- 被装饰的单行消息渲染为一行；现场报告中的气泡从四视觉行（含一空行）降到自然换行高度。
- Queue 预览按 composer 中的样子呈现：标签 chip 取代 `dsh-session:` URI；wire 形式若进入持久文本，气泡同样折叠。
- `MessageItem` 与 `QueueDock` 共享一套装饰词汇与样式表（`user-text.module.css`）；chip 样式移出 `MessageItem.module.css`。
- 测试：`user-text.client.spec` 钉住行内保证（零 `div`、片段保留空白）与每条折叠规则；chat-view 的字面文本匹配器随元素变化更新。
