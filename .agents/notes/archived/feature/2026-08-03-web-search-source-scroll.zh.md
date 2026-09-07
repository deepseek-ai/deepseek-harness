# Agent Note: Web search 来源卡片改为滚动而非折叠

Status: implemented
Archived: 2026-09-04

[English](2026-08-03-web-search-source-scroll.md) | 中文

## 问题

`web_search` 结果卡片（`WebBlock`，`packages/client/ui-primitives/src/WebBlock.tsx`）此前用首尾折叠渲染它的来源列表：超过 `maxSources` 数量（详情面板为 16，聊天行经由 `CHAT_WEB_MAX_SOURCES` 为 8）时，它画出前 `ceil(max/2)` 条来源、一个 `… 其余 N 条来源` 展开按钮，再画出末尾 `max - ceil(max/2)` 条，仿照 `TerminalBlock` 的输出上限机制。用户阅读该卡片时看到 `来源列表已截断`，会以为前端丢弃了它正持有的来源。

其实并没有。seam（`capSources`，`packages/web/web/src/index.ts`）把每个提供方结果裁剪到工具的 `searchMaxResults` 上限（默认 8）；多查询调用随后对组合来源去重、交错并限制在同一个上限内。最终的有界列表同时喂给面向模型的 render 文本与卡片的 `presentationMeta`，因此卡片持有的来源绝不会多于工具返回的来源。这个折叠隐藏的正是用户本有权完整查看的来源——并且在默认上限为 8、面板上限为 16 时，它几乎从不触发，只留下 `truncated` 提示，却无从展开任何内容。

## 决策

`WebBlock` 的 search 分支把它收到的每一条来源都渲染进单个 `<ol className={css.sources}>`，不做首尾切片、不设展开按钮、也不带 `maxSources` prop。`.sources`（`WebBlock.module.css`）获得一个固定的 `max-height` 与 `overflow-y: auto`，因此长于卡片高度的列表在原地滚动，而非撑大卡片或隐藏行。该高度是卡片几何形状的一个设计常量，因此放在 CSS 里，而非插件配置字段。

模型侧仍受 `searchMaxResults` 限制：seam 限制每个提供方结果，多查询消费方限制组合列表，`truncated` 标志及其 `来源列表已截断` 指示保留。卡片完整且可滚动地画出最终工具来源列表，而非折叠其中段。

只要工具下游没有单独改写结果 content，这份列表就是模型读到的那份。挂载了 `dsh-spill-policy` 的部署会对超限结果打破这一对应：`tools/post-execute` 把面向模型的 `content` 替换为预览加 spill 定位符，而 `presentationMeta` 原样保留，因此卡片仍画出全部来源，模型读到的却是一段有界摘录。所以卡片的约定是它收到的 view，不是模型的上下文。

`CHAT_WEB_MAX_SOURCES` 与该 primitive 的 `DEFAULT_WEB_MAX_SOURCES` 被移除：有了滚动，聊天行与详情面板展示同一份完整列表，仅以各自的容器高度区分。`<li value={ordinal}>` 仍钉住每条来源从 1 起算的引用序号；没有了折叠造成的间断，这些序号如今就是连续的。

把列表变成滚动容器，也把它的 `padding-left` 从间距变成了正确性约束。滚动容器裁掉 inline-start 方向的溢出且无从滚回，而 `::marker` 右对齐到内容边缘，因此宽于 padding 的序号会静默丢掉前导数字——在列表原本的 20px 下，两位数序号被画成 `0.` 与 `1.`，而本该是 `10.` 与 `11.`。`searchMaxResults` 是无上界的正整数，因此该 padding 以 `em` 计量——相对列表自身的字体，也就是序号所继承的那个——装得下三位数序号（`999. ` 在应用字体栈下量得 2.35em），并保留一位数情形原有的间隙。

## 考虑过的替代方案

**提高 `searchMaxResults`（或让它无上限），使更多来源同时抵达模型与卡片。** 被用户否决：它改变了模型侧行为（每个请求的上下文纳入更多来源、更多 token），并拉大模型读到的内容与卡片画出的内容之间的差距。

**保留首尾折叠，仅对展开区域加滚动。** 否决：一个关注点上两套重叠机制。一旦整份列表始终渲染，折叠的算术、展开/折叠状态与那个按钮都是累赘；仅靠滚动即可约束高度。

**把滚动高度做成插件配置字段。** 否决：该高度约束的是卡片在屏幕上的几何形状，而非部署策略，因此它属于 `WebBlock.module.css`，与 [Web result 卡片前端笔记](2026-07-30-web-result-card-frontend.zh.md) 已作为本卡片几何固定在那里的圆角、表面与外边距并列。

## 后果

工具返回的每一条来源始终存在于 DOM 中，因此 view 携带的来源没有一条被藏在交互之后。无论来源数量多少，卡片高度都受限；高于容器的列表在原地滚动。代价是滚动提示依赖平台的滚动条渲染：overlay 滚动条系统（macOS 默认）在指针离开时不显示常驻滚动条，因此受高度限制的列表依靠 `来源列表已截断` 提示加上被裁切的最后一行来表明还有更多内容。`WebSearchBlockProps`/`WebFetchBlockProps` 失去 `maxSources` prop，primitive 失去 `DEFAULT_WEB_MAX_SOURCES`，因此未来任何调用方都从构造上渲染完整列表，而不是靠传入一个很大的上限值。

## 测试

`packages/client/ui-primitives/tests/web-block.client.spec.tsx` 删去折叠相关用例（首尾切片、点击展开、折叠尾部编号、展开器不计入编号、仅首部、默认上限），并新增：一张含 30 条来源的卡片渲染出全部 30 个 `<li>`，无 `[aria-expanded]`、无 `<button>`，每个 `<ol>` 子元素都是一条来源 `<li>`，且 `<li value>` 从 1 到 N 连续编号。`packages/client/ui-tool/tests/web-card.client.spec.tsx` 删去 `CHAT_WEB_MAX_SOURCES` 上限断言；WebRow 展开测试仍断言卡片展示每一个来源字段。`packages/web/tool-web` 独立固定单查询与多查询的模型侧上限。

jsdom 不解析 CSS Modules layout，对任何 element 都报告 `scrollHeight === clientHeight`，因此无法见证滚动。几何由 assembled browser 的 `apps/web/tests/web-search-round.e2e.ts` 固定：确定性 search double 为两个 query 分别返回 6 条 result，每条带 title、citation snippet 与 date。真实 composition 观察两次 provider request，并固定 tool 的 round-robin combined cap——出厂 `searchMaxResults` 保留代表两个 query 的 8 条 source，model-visible render text 不含被丢弃的 4 条 URL，并含 `(Showing the first 8 sources. Refine the query for more.)`，`meta.truncated` 为 true。aria golden 后的 case 展开 `web_search` row，对 card 的 `<ol>` 断言：8 个 `<li>`、card 内没有 `<button>`、`来源列表已截断` indicator 可见，以及 computed style `max-height: 320px` 与 `overflow-y: auto`，scroll body 高于 container。后续 case 在 list 自身继承 font 下测量 `999. ` marker 宽度，要求 computed `padding-left` 不小于该宽度，从而把 scroll container 无法滚回的 marker space 固定在最宽 marker，而不是某个 fixture 的 source count。Replay 是对 fixture 嵌入式 Assistant settlement 的位置 cursor，search double 是 provider 通过 `fetch` 抵达的另一个 local endpoint。

## 相关文档

- [Web result card](2026-07-30-web-result-card.zh.md) —— 本卡片消费的 `card: 'web'` 渲染意图分支与 `presentationMeta` 路由；最终有界列表的来源。
- [Web result 卡片前端](2026-07-30-web-result-card-frontend.zh.md) —— `WebBlock`、唯一的 `web-card-model` 派生，以及绘制该卡片的各渲染点由它拥有；本笔记替换掉它所规定的来源列表折叠，它的其余决策（一个组件绘制两种 kind、http(s) 链接 allowlist、单一派生、常驻姿态）依然成立。
