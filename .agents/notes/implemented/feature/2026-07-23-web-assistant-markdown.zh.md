# Agent Note: Web 对话中安全的 assistant Markdown

Status: implemented

[English](2026-07-23-web-assistant-markdown.md) | 中文

## 问题

Web 对话通过会话事件、历史回放与流式累积保留 assistant Markdown 源文本，但其最末端的文本原语会按字面渲染源文本。若修改共享原语，用户消息与 steering（中途引导）消息也会被格式化；若在运行时中解析，则会把呈现状态混入不依赖 React 的会话投影。

## 决策

`@deepseek-ai/dsh-client-ui-primitives` 导出 `MarkdownText`，用作不受信任的 assistant 文本渲染器；`ui-conversation` 仅为 assistant `text` 块选择该渲染器。已完成的历史消息、流式输出尾部与被中断的部分输出已经共用 `AssistantMarkdown`，因此无需更改事件或快照，它们便会采用同一渲染器。用户消息与 steering 消息经 `projectUserText` 渲染（行内普通片段加引用 chip），并保持按字面渲染。

`MarkdownText` 以 `mdast-util-from-markdown` 加 GFM micromark 扩展解析，并经包内自有渲染器渲染 mdast 树，轮次流式输出期间增量解析（[增量 AST 渲染器 Note](../architecture/2026-08-06-web-markdown-incremental-ast-renderer.zh.md) 拥有该机制及其 DOM 一致性约定）。它覆盖 CommonMark 块，以及 GFM 表格、任务列表、删除线与自动链接，且不解析原始 HTML。一个 micromark attention 扩展复用 CommonMark resolver，同时允许至少两个星号组成的连续序列在 Unicode 标点后闭合，前提是其后紧邻 CJK 文本。这一例外涵盖流式输出期间与完成后无空格 CJK 文本中以标点结尾的粗体；单星号强调、紧邻非 CJK 文本的情况、已转义源文本、代码与数学公式仍沿用上游解析行为。围栏代码经共享的 `CodeBlock` 路由；该组件用客户端的 shiki 单例（`--shiki-*` token）高亮已注册语法，否则回退为纯等宽文本。轮次流式输出期间，围栏增量高亮：每个分片从保存的 grammar state 出发 tokenize 新完成的文本以及仍在增长的最后一行，不重复处理已完成的前缀（[流式围栏高亮 Note](2026-08-20-web-streaming-fence-highlight.zh.md) 拥有该机制）。

视觉间距、表格、链接、引用块、行内代码与代码块外框遵循 deepsuite `@deepseek/md`（`markdown.css` / `code-block.css`），并使用同一套 `--dsw-alias-markdown-*`、`--dsw-font-markdown-*`、`--dsw-alias-border-l*` 与 `--dsw-alias-label-*` token。链接使用 `--dsw-alias-state-business-primary`（deepsuite 的样式表使用 `--dsw-alias-brand-text`，仅在 newDesign 下为蓝色；design-platform 将 brand-text 保持为近黑色，此处不做重新调色）。当单个行内代码 token 完全由绝对 HTTP(S) URL 构成时，其代码外框会包含一个与普通链接相同、可通过键盘聚焦的安全外链锚点；端口、路径与查询文本保持不变，而命令、非完整 URL、其他 scheme 与围栏代码仍不会成为链接。`CodeBlock` 提供语言横幅与复制控件（`复制` / `复制成功`）。已完成的文本通过定稿语法的数学扩展渲染 KaTeX；`mathCompatibility` 将 `\(...\)`、`\[...\]` 和块级同一行 `$$...$$` 映射为同一套标准数学 AST 节点。这是一层小范围的解析器兼容层，不是正则重写，也不修复格式错误的模型输出。流式输出在完成前保持按字面渲染，避免不完整公式闪现错误。引用胶囊、标题锚点、thinking-small markdown 变体，以及自定义 □/☑ 任务标记仍不在范围内；GFM 任务列表继续使用原生复选框。

该依赖在 `ui-primitives` 中显式声明；由于这一纯库由 Web shell 预置，解析器与高亮器会成为初始浏览器 bundle 的一部分。

## 不受信任输出策略

assistant 生成的链接目标地址仅限绝对 HTTP、HTTPS 与 mailto URL。HTTP(S) 链接会在新标签页中打开，并带有 `rel="noopener noreferrer"`；相对目标地址与其他协议会渲染为不可导航的文本。Markdown 图片遵循独立的[远程图片策略](2026-07-30-web-remote-markdown-images.zh.md)。由于流水线中未引入 HTML 解析器，原始 HTML 仍是不会生效的源文本。Shiki 输出是由围栏文本生成的静态 span 树（不含脚本或用户 HTML）。

围栏代码与 GFM 表格各自处理横向溢出，因此较长内容无法撑宽对话栏。

## 考虑过的替代方案

**将现有的 mdast 与 micromark 开发依赖提升为正式依赖，并维护自定义 React walker。**此方案避免引入新的解析器体系，但产品需要自行负责每种节点映射、GFM 扩展和安全敏感的渲染分支。专用 React 渲染器将这套遍历交由上游维护，同时保留 AST 到 React 的处理路径。*后因新证据被推翻——增量流式解析需要纯字符串封装无法提供的 AST 级输入；该决策由[增量 AST 渲染器 Note](../architecture/2026-08-06-web-markdown-incremental-ast-renderer.zh.md) 拥有。*

**把用户提示词与 steering 也按 Markdown 渲染。**这会产生格式化用户输入的副作用。在产品明确选择此行为之前，这些输入仍按字面渲染。

**将 Markdown 解析为会话快照。**这会让 React 节点或呈现层 AST 成为持久的运行时状态，并重新引入最终输出与流式输出之间的模式边界。解析仍留在呈现层的叶节点中。

**通过净化启用原始 HTML。** 原始 HTML 当前没有产品需求，并且会扩大可执行内容边界，因此保持禁用，无需增加净化器依赖。远程图片由后续的[图片策略](2026-07-30-web-remote-markdown-images.zh.md)约束。

**移植 deepsuite 的 Prism `highlight.css` 与 mdast 管线。**外观一致性由 CSS Modules 与共享的 `--dsw-*` token 负责；高亮仍走现有的 shiki 允许列表，使客户端不必引入第二套高亮器或 Prism class 约定。

**为处理 CJK 标点边界而预处理 Markdown 源文本，或在解析后修复文本节点。**源文本重写必须在解析器掌握这些区别之前复现转义、代码、数学公式与定界符规则；文本节点修复则已经丢失部分源文本意图，也无法与已解析的行内节点组合。在分词器边界扩展 attention 可保留上游 resolver，并将差异限制在定界符的适用条件上。

**要求模型输出标准链接，并让 URL 形态的行内代码保持不可交互。**输出指引无法统一已持久化回复与第三方模型回复，而行内代码是将端点标记为字面值的常见方式。仅在行内代码的渲染边界识别完整的绝对 HTTP(S) 值，可在应用现有不受信任链接策略的同时保留代码语义。

## 后果

assistant 回复在流式输出与回放期间都会一致地渲染为语义化 Markdown，而工具卡片、推理行、交互、用户气泡和宿主协议保持不变。每次累积更新后，流式输出只重新解析不稳定的尾部；未完成的 Markdown 可能暂时改变尾部结构，但独立的尾部会限定 React 失效范围，最终事件也不会切换渲染器。URL 形态的行内代码会在不改变其可见字面文本的情况下变得可导航，而采用不安全 scheme 或混有其他内容的代码仍不可交互。代码围栏与工具及详情表层共用同一外框与复制路径。初始 Web shell 包含 Markdown 解析器、GFM 运行时、KaTeX 与 shiki 允许列表；citation、anchor 和 thinking-small 表层仍暂缓。
