# Agent Note: 流式围栏代码增量高亮

Status: implemented
Archived: 2026-09-04

[English](2026-08-20-web-streaming-fence-highlight.md) | 中文

## Problem

回复流式输出期间，`MarkdownText` 在 `CodeBlock` 看到围栏语言之前就把它剥掉，代码因此以无高亮的等宽纯文本呈现、语言横幅为空，直到定稿切换一次性重新着色整个回复（[#1499](https://github.com/deepseek-harness/deepseek-harness/issues/1499)）。纯文本臂是一道刻意的成本防线，记录于 [assistant-markdown 笔记](2026-07-23-web-assistant-markdown.zh.md)：shiki 从文档顶部开始 tokenize，朴素地高亮一个增长中的围栏意味着每个分片都重新 tokenize 整个围栏——随流式过程对围栏长度呈平方级，与[增量 markdown 解析器](../architecture/2026-08-06-web-markdown-incremental-ast-renderer.zh.md)为块解析消除的是同一类成本。修复必须在流式期间给出高亮，同时不重新引入该成本、不在 info string 尚在分片中途时以错误语法短暂着色、也不改变定稿渲染。

## Decision

流式围栏从保留的解析、tokenize 与 reconcile 前沿继续推进；定稿输出保持不变。

- **`IncrementalMarkdownParser`**（`packages/client/ui-primitives/src/markdown/incremental.ts`）会在普通尾部解析后识别经 parser 确认、位于末尾且未闭合的顶层 fence。已完成内容保留在既有 `code` node 中；只有最后一个已完成行与当前未完成行再次进入调用方的 GFM grammar，因此无需重新解析 fence 前缀，也能保留其换行、缩进、CRLF 与 value 语义。出现闭合分隔符、非追加输入、嵌套／容器内 fence 或无法明确重建时，会回到普通尾部解析。
- **`StreamingHighlightSession`**（`packages/client/ui-primitives/src/markdown/highlight.ts`）利用 TextMate tokenize 按行、且只向前推进的性质：一行的 token 只取决于该行文本与进入该行时的 grammar state，因此追加的文本永远不会改变已完成行的 token。会话缓存已完成行的 span 以及其后的 shiki `GrammarState`（`getLastGrammarState`）；`updateFrame` 只发布新完成行与仍在增长的最后一行，兼容方法 `update` 则物化完整结果。每分片 tokenize 成本不包含已完成的前缀；结果与从头 tokenize 逐 token 一致。非追加输入与解析后语法变化会重置缓存并完整重新 tokenize。每个 run 携带 shiki HTML 臂会赋予它的样式——css-variables 颜色加上主题放行的 markup 字体位（bold/italic/underline；markdown 围栏会携带它们）；纯空白 run 并入其后的 token，与 shiki 默认的 `mergeWhitespaces` 一致（其对带下划线/删除线空白的豁免在该主题下不可能出现：主题唯一的 underline 规则作用于 inline-link scope，其含空格文本整体成一个 run）；CRLF 切割点的 `\r` 绝不进入最后一个已完成行，与 shiki 自身的行切分一致。
- **`CodeBlock`** 把增量 frame 渲染为带有 shiki HTML 同款属性与 token span 的 `pre.shiki.css-variables` React 树。已完成行会封入固定大小的 React fragment；后续更新复用这些 fragment element，只 reconcile 一个有界的待完成分组与可变尾部。未知或缺失语言保持几何一致的纯文本臂；懒加载语法在注册前渲染纯文本，注册后由既有的 `useSyncExternalStore` 加载信号触发重渲染进入高亮——只有一次纯文本→高亮的转换，不会闪回。分组大小只是内部 reconcile 单元，不是部署策略或内容上限。
- **`render.tsx` 与 `MarkdownText`** 向围栏传递 `lang` 与 `context.streaming`，并让流式和定稿的顶层 block 都按源偏移设置 key。错误语法的瞬时着色在结构上不可能出现：info string 尚在分片中途的围栏（`` ```py `` 补全为 `` ```python ``）还没有内容——内容只在 info 行的换行之后才存在，而该换行恰恰定格了语言——空值围栏保持原生 `<pre>`。`` ```math `` 围栏与 TeX 在定稿前保持字面量；语言横幅在流式期间显示围栏语言。

最终的全量文档解析仍会解决跨文档引用与数学语法。当该解析产生相同的 fence 代码与语言时，源偏移 key 会保留其 `CodeBlock` 实例，组件则复用完整的流式 React 树；冷启动的定稿 fence 继续使用 `highlightToHtml`。

## Testing

包测试会约束 800 行未闭合 fence 的累计 grammar 输入量、逐次比较增量结果与全量解析，并覆盖缩进分隔符、跨分片 CRLF、闭合回退与非追加重置。高亮测试覆盖跨多行 grammar state、空行、CRLF 与 markup 样式的增量／从头等价性，delta 标识与重置／懒加载路径，固定分组的 DOM 保留，从流式到定稿的 DOM 标识，以及纯文本和 math 回退。组装后的 Web 浏览器快照会启动真实 Web 组合，让 TypeScript 围栏经过 Host 与 SSE 路径流式传输，在回复仍活跃时暂停确定性 LLM 适配器并对 Chromium 中的 Shiki token 树做快照，然后验证定稿保留该 token 树。`tests/fixtures/markdown-dom/*.streaming.txt` fixture 锁定相对 react-markdown 来源的一项有意分叉：Shiki span 树与可见语言横幅取代纯文本臂。

## Alternatives considered

**直接透传 `lang`，每个分片重新 tokenize 整个围栏。** 一行改动，但在不回应的情况下推翻了已记录的纯文本臂理由：长流式围栏在整个流式过程付出平方级 tokenize 成本，恰恰在高亮最有价值的长代码回复上产生卡顿。

**流式期间只高亮已冻结（闭合且位置定格）的围栏。** 成本有界，但未闭合围栏会钉住增量解析器的尾部，于是正在增长的围栏——屏幕上的那个——要等回复结束才高亮，不满足 issue 的"识别语言后即可增量高亮"。

**只保留固定窗口内的高亮行，并把更早的前缀转成纯文本。** 这能限制流式 token DOM 并进一步降低布局成本，但会改变已经渲染的内容、让跨窗口边界的选择更复杂，还会把可调的展示策略塞进 `CodeBlock`。保留解析、tokenize 与 React 前沿可以在不丢颜色的情况下消除可避免的重复工作；完整 token DOM 被明确记录为限制，而不是隐藏的语义变化。

**把高亮移到 worker 或异步流程。** 采纳 shiki 时已否决（[同步高亮笔记](../process/2026-07-26-web-syntax-highlighting-shiki.zh.md)）；异步换入还会重新引入本变更必须避免的纯文本→彩色→纯文本闪烁类问题。

**增量拼接定稿 HTML 字符串并继续使用 `dangerouslySetInnerHTML`。** 白得定稿一致性，但 React 每个分片都会整体替换 `innerHTML`，浏览器每次重新解析并重建所有行的 DOM——O(围栏) 的 DOM 翻搅，抵消了会话在 token 层的收益。

## Consequences

流式代码随到达即可读：语言一经识别 token 即着色；顶层 fence 的已完成内容不再重新解析或 tokenize；封存的 React 分组保留其 element 与 DOM；定稿也会保留高亮树。该包持有一小份 shiki HTML 臂约定的镜像——`pre` 属性与空白折叠——由双臂一致性测试锁定，shiki 升级若改变任一处会在该测试处响亮失败，而不是让两臂悄然漂移。流式 DOM 一致性 fixture 锁定 Shiki span 树，这是相对其 react-markdown 来源的一项有意分叉。保留的 DOM 仍随最终 token 数增长，因此浏览器 style 与 layout 工作量并非与长度无关。嵌套／容器内 fence 使用普通尾部解析器，仍在增长的最后一行则会每分片重新 tokenize；病态的单行超长 fence 因而仍是最坏情况。
