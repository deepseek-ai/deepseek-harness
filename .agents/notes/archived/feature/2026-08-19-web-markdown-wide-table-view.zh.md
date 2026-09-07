# Agent Note: Web markdown 表格按列数填充消息列，宽表突破列宽

Status: implemented
Archived: 2026-09-04

[English](2026-08-19-web-markdown-wide-table-view.md) | 中文

## 问题

`MarkdownText` 把每个 GFM 表格都按自然宽度渲染（`.tableScroll table { width: max-content; max-width: max-content }`，`packages/client/ui-primitives/src/markdown/MarkdownText.module.css`），于是任何比 748px 消息列更宽的表格都只能靠横向滚动阅读。单元格本可以舒适换行的三列表格也被迫滚动；而真正宽的表格即便转录区周围有几百像素的空余，也永远只能用消息列那么宽。Issue #1761（含外部反馈 dsh-external/issues#520）要求先换行适应，并为需要的表格提供更宽的视图。deepsuite chat 产品已用 CSS 优先的方式解决了同一问题；按评审方向，本变更对齐该方案，替换此前起草的交互式展开对话框方案。

## 决定

**列数在渲染器里静态决定尺寸分支。**`renderTable` 读取解析出的列数（`align` 数组，缺省回退表头行）：不足四列的表格——以及 blockquote 内的任何表格（渲染上下文的 `inBlockquote` 标志）——获得模块的 `tableFill` 类，`table { width: 100%; max-width: none }`，填满消息列，单元格按既有 `min-width: 100px` 下限换行。四列及以上的表格保持自然宽度规则，改挂稳定的全局钩子类 `md-table-wide`（沿用 `md-code-block` 先例），供宿主布局加宽。这正是 deepsuite chat 的判别式（`.wrapper:not(:has(th:nth-child(4), td:nth-child(4)))` 及其 blockquote 豁免），只是移到已经掌握列数的渲染器里计算。全程没有测量、observer 或交互状态。

**聊天转录区用容器查询 CSS 加宽挂钩表格。**ChatView 的 `.scroll` 声明 `container-type: inline-size`，`AssistantMarkdown.module.css` 给 `.body :global(.md-table-wide)` 定义突破：`--dsh-table-spare` 是单侧空余宽度 `max(0px, (100cqw - --dsh-chat-content-width) / 2)`，`--dsh-table-lead` 再加上包裹层自身的缩进（`min(--dsh-chat-content-width, 100cqw) - 100%`），宽度/负 margin/前导 padding 组合起来，让包裹层的滚动区横跨整个转录区，而表格内容仍从消息列左缘起排。`100cqw` 是 deepsuite chat 用 JS 测量的 `--dsl-virtual-list-width` 的 CSS 等价物；`max(0px, …)` 钳制取代其 below-SM 的 JS 开关，转录区窄于消息列时连续退化为普通列内滚动。规则限定在 `AssistantMarkdown .body` 之下，工具卡片、压缩行等其他 `MarkdownText` 表面保持普通列内行为。

**一致性 fixture 的变化是有意的。**含表格的 markdown-dom fixture pin 住判别结果：窄表与 blockquote 表为 `tableScroll tableFill`，宽表为 `tableScroll md-table-wide`；新增的 `table-wide-and-blockquote` 语料文档同时 pin 住 blockquote 豁免的两个分支。

## 曾考虑的替代方案

**实测溢出的交互件：ResizeObserver 门控的展开入口，用 `Modal` 打开宽视图。**先行实现，后按评审方向否决、改为对齐 deepsuite chat：CSS 方案不需要逐表 observer，没有会被流式定稿替换丢弃的对话框状态，不用穿过 cordis-free 包的文案管道，且宽视图是常驻的而非藏在交互后面。

**像 deepsuite chat 那样用 `:has()` 在 CSS 里数列。**否决：它们的包裹层是通用组件，而本渲染器本来就在遍历表格节点，列数是静态可得的；类名比随 DOM 变化反复求值的 `:has()` 选择器更便宜，还把决定固化进 DOM 供 fixture pin 住。

**突破到视口宽而不是转录区宽。**否决：会话列 pin 死了 `overflow-x: hidden`（`apps/web/tests/conversation-column-overflow.e2e.ts` 的单轴契约），超出转录区盒子的部分会被裁剪；转录区宽度正是布局实际拥有的空间。

## 后果

普通宽表原地换行阅读；多列表格保持可读的自然宽度，在布局有空余处横跨整个转录区，剩余部分滚动——无需任何交互，也没有状态要恢复。宽表的横向滚动条悬停才出现、不再常驻：Chromium 从不重绘状态条件化的滚动条样式（悬停条件化的 `::-webkit-scrollbar*` 规则和 `:hover` 下的 `scrollbar-color` 变化都到不了已绘制的滚动条——有头与无头模式均已实测），因此显隐切换的是 `overflow-x` 本身（静止 `hidden`，悬停或聚焦 `auto`），静止时的 `padding-bottom` 与主题滚动条高度一致，出现的滚动条恰好顶替它、下方内容不动。静止的 `overflow-x: hidden` 会失去 Chromium 对滚动容器的隐式可聚焦性，因此宽表包裹层带显式 `tabindex="0"`（`:focus-visible` 有焦点圈，聚焦后方向键可滚）。两个需要知道的点：ChatView `.scroll` 上的 `container-type: inline-size` 使它成为转录区内后续使用容器单位的最近查询容器；不足四列的表格现在总是拉伸到整列宽（deepsuite chat 行为），而不是按内容收缩。

## 测试

markdown-dom 一致性 fixture 按分支 pin 住包裹层类名，含新增的 `table-wide-and-blockquote` 文档；`markdown-render-units.client.spec.tsx` 覆盖手工树的无行无 align 兜底。`apps/web/tests/markdown-wide-table.e2e.ts` seed 一个含三个表格的已关闭轮次（三列填充表、十二列宽表、长 token/中文长单元格表），在真实 Chromium 中跨视口档 pin 关系 golden——填充表与长单元格表在每一档都填满消息列、无残余滚动、随列变窄而变高；宽表始终滚动、恰好在转录区宽于消息列的档位突破列宽、突破时内容与填充表左对齐、窄档钳制为中性——外加聚焦包裹层的方向键滚动、缩放分支、以及必须报告相同关系的 deviceScaleFactor-2 分支。

## 相关

- [Web markdown 增量 AST 渲染器](../architecture/2026-08-06-web-markdown-incremental-ast-renderer.zh.md) —— 本变更所扩展的渲染器与 DOM 一致性契约。
