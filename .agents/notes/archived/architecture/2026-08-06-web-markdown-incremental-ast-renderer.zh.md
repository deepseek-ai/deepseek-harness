# Agent Note: 经由直接 mdast 渲染器的增量流式 Markdown

Status: implemented
Archived: 2026-09-04

[English](2026-08-06-web-markdown-incremental-ast-renderer.md) | 中文

## Problem

`MarkdownText` 在每次流式发布时都重新解析整个已累积的回复:react-markdown 的纯字符串 API 每次渲染都新建 unified processor,并对全文跑完 micromark → mdast → hast → React,因此每个 chunk 的主线程工作量随回复长度线性增长,整个流的累计成本随之二次增长。既有缓解手段(帧级合并、隔离的流式尾部、围栏 plain 臂)约束的是这份工作跑多频繁、波及多广,从未约束每次重新解析多少文本。修复它需要 AST 级输入——冻结已定型的块、只重新解析源文本尾部——这是纯字符串封装在结构上无法表达的。

## Decision

`MarkdownText` 直接渲染 mdast,并在流式期间增量解析:

- **语法**([parse.ts](../../../../packages/client/ui-primitives/src/markdown/parse.ts)):`parseGfm`(流式臂与 `extractMarkdownPlainText`)和 `parseGfmWithMath`(定稿臂)以被替换的 remark 插件所包装的同一组 micromark 扩展调用 `mdast-util-from-markdown`,因此各处块边界完全一致。`mathCompatibility`(原 `remarkMathCompatibility`)现在直接导出其 micromark 扩展。
- **增量解析**([incremental.ts](../../../../packages/client/ui-primitives/src/markdown/incremental.ts)):CommonMark 块解析按行推进,追加文本只会重塑解析前沿。`IncrementalMarkdownParser` 保留末尾两个块不稳定(最后一块是前沿;倒数第二块是安全裕量),冻结其前的所有块,只从最后一个冻结块的 `position.end.offset` 起重新解析源尾部——用的是解析器自己的偏移量,没有任何自制源扫描。每个源区间在整个流中解析 O(1) 次而非每 chunk 一次;单个巨型块(未闭合围栏)退化为旧的全量重解析成本,不会更差。非追加输入在递增的 generation 下重置状态。
- **渲染**([render.tsx](../../../../packages/client/ui-primitives/src/markdown/render.tsx)、[katex.tsx](../../../../packages/client/ui-primitives/src/markdown/katex.tsx)):一个对 mdast 节点类型的 switch 取代 remark-rehype + react-markdown,逐字节复刻被替换管线的 DOM——表格对齐渲染为 `text-align` 样式、紧凑列表段落解包、任务列表类名与复选框空格、脚注区(其页内锚点本就被协议白名单降为纯文本)、字面 raw HTML、会与字面 HTML 文本相邻显形的分隔换行,以及 rehype-katex 的三臂容错链,KaTeX HTML 经浏览器自带的 `DOMParser` 映射为 React(无包裹元素,首/末子元素的 margin 规则仍能作用于 `.katex-display`;React 18 会把 `.katex-mathml` 子树放进 HTML 命名空间,与被替换管线完全一致——既有限制,不在本对等性约定范围内,对承担视觉渲染的 `.katex-html` 臂不可见)。冻结块缓存其 React 元素并保持源偏移 key,跨过冻结边界时走 reconcile 而非重挂载;`MarkdownText` 已 memo 化。

DOM 由 `tests/fixtures/markdown-dom` 钉死:fixture 录制自替换前的 react-markdown 实现,新渲染器必须在空白规整序列化器下复现。fixture 差异即用户可见的 markdown 样式变更,必须按此评审,绝不能为重构而重录。`tests/markdown-incremental.spec.tsx` 承载等价性性质——以 1/3/7/16 字节分块,在每个追加前缀处,常驻组件的 DOM 都等于全新挂载——外加冻结边界的 DOM 节点同一性与重置行为。

这推翻了[助手 Markdown Note](../feature/2026-07-23-web-assistant-markdown.zh.md) 中被否决的备选("维护一个自定义 React walker"):增量需求是当时不存在的新证据,walker 的安全敏感分支(URL 白名单、图片策略、惰性 HTML)本就是产品自有函数,而该依赖不再删减自有代码——它阻塞了架构。该 Note 的不可信输出策略与渲染器选型不变。

## Alternatives considered

**保留 react-markdown,把源文本切成逐段 `<ReactMarkdown>` 实例。** 渲染器零自有成本,但每帧对尾部解析两次(边界检测 + 渲染),定稿数学仍要全量重解析,hast 构建与逐渲染 processor 依旧存在,且块跨过冻结边界时会重挂载——元素树无法跨实例缓存。

**用 `mdast-util-to-hast` + `hast-util-to-jsx-runtime` 渲染缓存的 mdast。** 白拿上游节点映射,但每帧保留 hast 中间层,并为一个映射面小、封闭、且已被 fixture 钉死的管线引入两个新直接依赖。

**用 `hast-util-from-html-isomorphic` 解析 KaTeX 输出(rehype-katex 的做法)。** 为解析可信、词汇受限的 KaTeX 输出把基于 parse5 的 HTML 解析器拉进 bundle,而浏览器自带的 `DOMParser`(带规范的 SVG/MathML 属性调整)解析结果完全相同。

## Consequences

流式的每 chunk 工作量现在跟随不稳定尾部而非整个回复,react-markdown、remark-gfm、remark-math、rehype-katex、unified 及 hast 链退出浏览器 bundle(`mdast-util-math` 与 `micromark-util-sanitize-uri` 成为直接依赖;两者原本就是传递依赖)。包自有约 25 个节点映射、其测试以及 KaTeX DOM 转换——代价由冻结其输出的 fixture 约定对冲。两个行为偏差,均在定稿的全量解析处自愈:定义落在冻结边界另一侧的引用式链接或脚注在流式期间渲染为字面文本;当脚注定义先冻结而引用块仍不稳定时,脚注引用可能闪回字面文本。本模块与 KaTeX 转换假定浏览器 DOM(`DOMParser`),这个 client-only 包本就如此。
