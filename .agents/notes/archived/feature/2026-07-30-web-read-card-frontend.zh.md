# Agent Note: Web 读取卡片前端 —— 读取工具的行窗口以带行号、语法高亮的形式渲染

Status: implemented
Archived: 2026-09-04

[English](2026-07-30-web-read-card-frontend.md) | 中文

## Problem

[读取后端](2026-07-30-web-read-card.zh.md)给 `ToolResultView` 增加了第四种渲染意图卡片 `card: 'read'`：一次已结算的读取现在会把 `{ path, lines: [{ number, text }], totalLines, lang? }` 作为 `resultView` 带到会话快照上。这份数据能到达浏览器，但 Web 客户端没有消费者。每个读取行都仅从参数派生，详情面板把结果的 content block 摊平进一个 `<pre>`，于是读取显示为带 `N: text` 前缀的纯文本，没有行号栏、没有语法高亮，也没有窗口读取的"显示 N / M"提示。[web 终端卡片](2026-07-28-web-terminal-card.zh.md)确立了消费一个结构化卡片的模式；读取卡片沿用它，只在结果侧。

## Decision

`ReadBlock` 是一个 `ui-primitives` 组件，把一次读取结果渲染成带行号、可选语法高亮的文件视图，读取的两个 Web 渲染点都通过它消费读取渲染意图：聊天工具行（常驻在摘要行之下）与详情面板的 Output 区段。`ui-tool/src/client/tool/models/read-card-model.ts` 是把快照的 `resultView` 转成组件 props 的唯一位置，因此两个渲染点不会产生分歧。

**新建一个 `ReadBlock` primitive，而不是扩展 `CodeBlock`。** `CodeBlock` 已经带语言横幅和复制控件做 shiki 高亮，但读取视图需要一个每行带该行自身文件行号的行号栏，而 `CodeBlock` 把内容渲染为单个 `<pre>` 树、没有逐行结构。给 `CodeBlock` 加一个可选行号栏会把读取专属的关切（窗口行号、"显示 N / M"提示、高度上限）强加给共享该组件的每个 markdown 代码围栏和每个 `run_code` 程序体。`ReadBlock` 转而复用真正共享的部分：`markdown/highlight.ts` 里的 shiki 语法单例。那里新增的 `highlightLines(code, lang)` 把代码切成 shiki 自己的逐行 token 数组（`codeToTokens`），而不是 `highlightToHtml` 产出的单 `<pre>` HTML，于是该 block 能每行放一个行号、同时用同一套 `--shiki-*` 自定义属性、同一份语法白名单给内容上色。高度上限及其头/尾展开算法照抄自 `TerminalBlock`（`ceil(max/2)` 行头部加剩余的尾部），因此长读取和长命令输出在同一处折叠。复制控件写入窗口的原始文本（各行以换行拼接），绝不含行号栏或横幅。

`readCardModel` 只在结果侧，与后端对称：一次读取调用在 `execute` 返回前不带任何内容，因此挂起中的调用保持为 `GenericCallView`（`kind: 'read'`），本函数对运行中的读取返回 null —— 该行保持其从参数派生的摘要，直到结果到达。它对结果视图不是读取卡片的已结算调用也返回 null，包括本 UI 版本不认识的 `card` 值（它从线路到来、不能被信任为一个已编译的变体）以及读取工具对错误结果自己的通用回退。卡片横幅标签在工具提供 `title` 时取它（约定的替换标题规则），否则取相对于会话工作区化简后的文件路径，使工作区根下的绝对路径显示为与行摘要相同的短形式。该 model 把冻结的行数组复制进 primitive 自己的行形状，因此卡片绝不持有指向运行时快照缓存的引用。

聊天行把卡片**常驻**渲染在摘要行之下，上限 `CHAT_READ_MAX_LINES`（8，是 primitive 默认值的一半），与 `BashRow` 对终端卡片的姿态相同 —— block 的内部展开器让长读取不会占据整个消息流。两个渲染点承载它：keyed `ReadRow`（经 `ctx.slots.inject` 以 `read` 键注册，与 bash 样例完全一致），其摘要是作为可打开的宿主链接的文件路径；以及 `GenericToolCard` 对没有自己 keyed 行的读取声明工具（例如归到 `read` 变体的 `web_fetch`）的回退。详情面板以 primitive 自己的全高上限（16）渲染同一张卡片，因为面板是单次调用的阅读界面。

整行折叠/展开（把每个工具调用默认折叠）归[统一展开与检视 note](2026-07-30-web-tool-row-unified-expand-and-inspect.zh.md)所有，它已一次性翻转每张常驻卡片；本 note 的卡片是常驻的，与它旁边的终端卡片一致。

**读取卡片的语法按需 lazy 加载，只有 boot 三种保持 eager。** `highlight.ts` 是 `ui-primitives` 在每次 Web 启动都加载的平台 seed，其预热会无条件构建 shiki 单例。读取卡片的 `langFromPath` 提示覆盖完整的源码/配置/标记扩展集（python、rust、yaml、html……）；把它们全部 eager 注册会给启动 chunk 增加约 1.6 MB 的语法模块、并把它们的同步初始化摊给每个会话，包括从不打开读取卡片的会话。因此只有每个会话本就渲染的三种语法 —— TypeScript、shell、JSON（markdown 围栏与 `run_code` 语言）—— 在 boot 时加载。每种读取卡片扩展语法置于 `LAZY_GRAMMARS` 中一个动态 `import()` 之后，以其别名解析到的语法 id 为键。对某个 lazy 语言首次调用 `highlightLines`/`highlightToHtml` 时，`ensureGrammar` 启动 import（仅一次）并返回未就绪，于是卡片该帧渲染纯文本；import 解析后用 `loadLanguageSync` 注册该语法、递增一个加载计数、并通知订阅者。`ReadBlock` 与 `CodeBlock` 通过 `useSyncExternalStore(subscribeGrammarLoaded, grammarLoadCount)` 订阅，因此语法就绪的那一刻卡片就重渲染带上高亮。未知/缺省语言仍同步返回 undefined（纯文本，绝不报错）。

**空窗口的复制控件被隐藏，与 `TerminalBlock` 对齐。** 成功读取一个空文件会返回 `lines: []`、`totalLines: 0`，且 `presentResult` 仍投出 `card: 'read'`，因此空窗口分支是可达的。故 `ReadBlock` 在 `lines` 为空时隐藏复制控件，正如 `TerminalBlock` 对空输出隐藏复制，使按钮绝不会用空字符串清空剪贴板。

## Alternatives considered

**给 `CodeBlock` 加一个可选行号栏和 `startLine`。** 拒绝：这会把读取专属的行号栏、窗口计数提示和高度上限强加给共享 `CodeBlock` 的每个 markdown 围栏和 `run_code` 程序体，对那些调用者毫无好处。真正共享的界面是 shiki 语法单例，两个 block 都通过 `highlight.ts` 复用它；围绕它的外壳各不相同（读取有行号栏和窗口提示，围栏两者都没有），因此第二个小 primitive 是正确的切分 —— 正如 `TerminalBlock` 是基于同一套 token 的第二个 primitive，而不是 `CodeBlock` 的一种模式。

**复用 `highlightToHtml`，用 CSS counter 注入行号。** 拒绝：shiki 产出的单 `<pre>` HTML 没有可供行号栏挂上文件行号的逐行边界（窗口读取的行号从大于 1 处开始，不是简单的 CSS counter 自增），而从 HTML 里把行号解析回来又很脆弱。`codeToTokens` 直接给出逐行 token 结构。

**在 boot 预热里 eager 注册所有读取卡片语法。** 拒绝：这会给每次 Web 启动摊上约 1.6 MB 语法模块及其同步初始化，只为一张多数会话从不打开的卡片。lazy 路径的代价是某个语言首次被读取时的一帧纯文本，随后在语法加载的重渲染里高亮；boot 代价只为每个会话本就渲染的三种语法付出。

## Consequences

`ui-primitives` 增加 `ReadBlock` 和 `highlightLines`；没有新的运行时依赖（shiki 已因 `CodeBlock` 存在）。`ReadBlock` 只读取读取视图的字段，因此保持为渲染意图所承载内容的纯函数 —— 无会话查询，与产出该视图的 presenter 一样可安全回放。没有读取能力的 UI 仍通过通用卡片拿到后端的 `content` 回退（剥掉外壳的文本），保持不变。

Web 聊天里的读取行现在常驻承载文件内容，是相对纯摘要行的一次刻意的密度增加，受聊天上限约束。按已发布的协议格式，`run_code` 子派发不会到达读取卡片，与嵌套 bash 调用到不了终端卡片同因：`session.ts` 把 `tool/code-dispatch(-start)` 折叠为 `resultView: null`，因此嵌套读取保持通用的摊平形式。

## Testing

`packages/client/ui-primitives/tests/read-block.client.spec.tsx` 固定 primitive 与 token 路径：`highlightLines` 的逐行 css-variables 片段、它对尾部终止行的丢弃与真正空白末行的情形、它对未知/缺省语言返回 `undefined`、以及它的 lazy 路径（lazy 语法首次触碰返回纯文本，import 注册且订阅者触发后再高亮）；还有 `ReadBlock` 的带行号行保留文件自身编号、高亮与纯文本两条内容分支、横幅（标签、语言、仅当读取是窗口时的计数提示）、头/尾高度上限及其 `aria-expanded` 切换、复制控件在接受与拒绝两条剪贴板路径上写入窗口原始文本、以及空窗口分支隐藏复制控件。`code-block.spec.tsx` 覆盖 `highlightToHtml`，含它对每种读取卡片语法的 lazy 路径（每个动态 import thunk 各触碰一次）。`ReadBlock.tsx`、`highlight.ts`（及 `CodeBlock.tsx`）在这两个 spec 上均保持每文件 100% 覆盖。

`packages/client/ui-tool/tests/read-card.client.spec.tsx` 固定每个渲染点的接线：`readCardModel` 的派生与每条 null 分支（运行中读取、无视图、通用视图、未知卡片）、结果标题替换化简后的路径、路径相对工作区的化简、冻结行数组的复制而非别名；`GenericToolCard` 回退中与 keyed `ReadRow` 中的常驻卡片（外加其路径链接打开宿主、其 running/error/stopped 状态、以及其 `read` 键注册）；还有面板 Output 区段以全高渲染读取卡片同时保留 JSON Input 区段，含运行中读取占位与非读取摊平 pre 两条分支。该文件位于覆盖 `exclude` 列表（`ui-tool/src/*`），因此不承受门槛压力。

`packages/client/connection/src/client/fixture.ts` 中的 fixture（测试前置数据）增加轮次 66，一次 `read` 调用，其结果视图是窗口读取（行号从文件行 41 起、`totalLines` 180、`ts` 提示），使 built-boot 快照和实时 `?fixture` 服务器展示带行号、高亮和计数提示的读取卡片。它命名为 `read` 以驱动 keyed `ReadRow`。轮次 64 的 `run_code` 样例中的嵌套读取子派发并不驱动渲染点回退读取卡片：`session.ts` 把它们折叠为 `resultView: null`，因此它们只覆盖回退行的通用行形状，而非回退行内的读取卡片；回退行读取卡片由 `read-card.spec.tsx` 的 `web_fetch` 用例钉住。轮次 66 排在 todo 轮次（现为 67）之前，与终端样例同因：常驻计划在下一次 `turn/start` 退场。

## Related

- [读取卡片后端](2026-07-30-web-read-card.zh.md) —— 增加本文消费的 `card: 'read'` 结果视图；产出本文渲染的 `lines`/`totalLines`/`lang`。
- [Web 终端卡片](2026-07-28-web-terminal-card.zh.md) —— 本文遵循的先例：一个 `ui-primitives` block、一个 `contract/*-card-model.ts` 派生、一个 keyed 行，以及让 `GenericToolCard`/`DetailsPanel` 感知卡片。
- [Web 客户端语法高亮](../process/2026-07-26-web-syntax-highlighting-shiki.zh.md) —— 拥有 `CodeBlock` 与 shiki `highlight.ts` 单例，本文以逐行 token 路径扩展它。
- [工具调用呈现的标签式渲染意图联合](../architecture/2026-07-02-tool-render-intent-union.zh.md) —— `card` 标签词汇表；Web 客户端现在是 `read` 分支的完整消费者。
