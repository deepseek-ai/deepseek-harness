# Agent Note: Web result 卡片前端 —— 在浏览器渲染 web 渲染意图

Status: implemented
Archived: 2026-09-04

[English](2026-07-30-web-result-card-frontend.md) | 中文

## Problem

`web_search` 和 `web_fetch` 工具声明了 `card: 'web'` result view（[web result card](2026-07-30-web-result-card.zh.md)）：一个 `kind` 标签联合,携带结构化的被引用 sources 加可选的 provider answer（`kind: 'search'`),或抓取的 URL 及其 HTTP 状态（`kind: 'fetch'`）。该视图早已抵达浏览器 —— host、connection、runtime 将它作为 `resultView` 投递到 `ConversationSnapshot` —— 但 Web 客户端忽略了它:一次已完成的 web 调用只渲染为摊平的模型可见文本,正是约定笔记所解释的、结构化视图要替代的那种有损渲染。`web_search` 到达读者时是每个 source 一行自由文本 markdown,而非可点击 source 的引用列表;`web_fetch` 是它的 markdown 正文,没有检索摘要。

## Decision

`WebBlock` 是一个 `ui-primitives` 组件,渲染一次已完成的 web 检索,web 调用的每个 Web 渲染点都通过它消费 `web` 渲染意图:键控的 chat 工具行（`web_search`/`web_fetch`）、`GenericToolCard` 渲染点兜底,以及详情面板的 Output 区。`ui-tool/src/client/tool/models/web-card-model.ts` 是唯一把快照的 `resultView` 转成组件 props 的地方,镜像 `terminal-card-model.ts`,因此没有两个渲染点会对一次 web 调用的显示产生分歧。它返回 null —— 走通用路径 —— 对运行中的调用（web 卡片是 result-only 的,因为工具保留 generic pending 视图）、对 result view 不是 web 卡片的已结算调用（包括本客户端版本不认识的 `card` 值,它经 wire 抵达因而不能被信任为已编译的变体）、对 generic result view（web 工具的错误路径返回 generic 卡片,其文本由通用路径保留）、以及对本客户端版本不认识 `kind` 的 web 卡片（更新的 host 经 wire 发来的值,读作 fetch 会画出空 URL 和 `HTTP undefined`）。

一个组件绘制两种 kind,由 `kind` 判别。`search` 把 answer 作为 markdown 显示在引用列表上方;每个 source 是一个安全外链,以其标题为标签,provider 未给标题时以其主机名为标签,下方是 snippet 与发布日期,工具截断列表时显示 `来源列表已截断` 提示。`fetch` 显示一个紧凑摘要:带链接的最终 URL、其 HTTP 状态、以及 `内容已截断` 提示。用一个组件而非两个,因为两者都是渲染为同一卡片族的 web 检索 —— 这正是约定把它们放在一个 `card` 标签下、用 `kind` 判别的原因。

**链接的安全性沿用 MarkdownText 对不受信任的 assistant 链接所用 allowlist 的 http(s) 子集。** MarkdownText 还允许 `mailto:`，此处刻意排除，因为检索 URL 绝不会是邮件地址。一个 source 或 fetch URL 仅当其协议为 `http:` 或 `https:` 时才成为可导航锚点，带 `target="_blank"` 和 `rel="noopener noreferrer"`；`javascript:`/`data:`/`file:`/`mailto:` URL 或无法解析的字符串渲染为纯文本、无 href。web 工具返回的 result content 是模型创作的,未经验证抵达本组件,因此像 assistant markdown 一样被当作不受信任处理。标签从标题回退到主机名再回退到原始 URL,因此即便标题缺失且 URL 无法解析,source 也总能读作某个东西。

**几何镜像 CodeBlock/TerminalBlock**（12px 圆角、code-block 表面、16px 垂直外边距）,使 web 卡片与它们读作一家。整份 source 列表渲染在单个 `<ol>` 里,由 `max-height: 320px` 与 `overflow-y: auto` 约束,因此高于该值的列表在原地纵向滚动,而不是把卡片撑高（[来源滚动](2026-08-03-web-search-source-scroll.zh.md)）。source 列表是散文而非按列对齐的输出,所以它正常换行,而不像终端卡片的输出那样横向滚动 —— 这是与 TerminalBlock 唯一刻意的分歧。

卡片在 chat 行中**常驻**于摘要行之下,与 `BashRow` 所用的同一常驻姿态。两个渲染点展示同一份完整的 source 列表,仅由卡片自身的滚动高度约束,而没有行与面板两级的 source 上限。键控行把一个 `WebRow` 组件注册在 `web_search` 与 `web_fetch` 两个键下;行仅根据工具名判别以选取其图标（search 对 browse）与标题（`Search`/`Fetch`）。没有自己键控行的 web 声明工具落到 `GenericToolCard`,它长出同一张常驻卡片。详情面板渲染该卡片,并在其下方渲染摊平的模型可见结果内容:`web_fetch` 卡片只携带 URL 与状态,因此其抓取正文只在此处可读。

## Consequences

`WebBlock` 只读 web view 的字段,因此它是渲染意图所携带内容的纯函数 —— 无会话查找,与产出该视图的 presenter 一样回放安全,且不同于终端卡片它不需要 cwd 解析,因为 web view 不携带路径。没有 `web` 能力的 UI（TUI）仍得到约定的回退 `content`;工具的 result 形状没有任何改变。answer 复用 `MarkdownText`,因此 answer 自身的不受信任链接处理与 GFM 渲染免费获得。

每张常驻卡片（terminal、diff、web）共用的整行折叠/展开交互归[统一展开与检视 note](2026-07-30-web-tool-row-unified-expand-and-inspect.zh.md)所有;本卡片遵循常驻约定,而非抢先做那套交互。

## Alternatives considered

**两个组件,每种 kind 一个。** 拒绝:两种形状共享卡片外框、安全链接处理、截断提示,而约定已经把它们的差异表达为一个 `card` 标签下的 `kind` 判别;两个组件会重复共享表面并拆分安全链接逻辑。

**重解析模型可见的渲染文本,而非消费结构化视图。** 因约定笔记给出的同一理由拒绝:`web_search` 的渲染把每个 source 的字段压缩成一行自由文本、以标题或主机名为标签,所以重解析无法恢复 `{url, title?, snippet?, publishedAt?}`。结构化的 `resultView` 是唯一忠实来源,这正是后端约定添加它的原因。

**不加协议 allowlist 直接渲染裸锚点。** 拒绝:URL 在此展示边界处是模型创作、未经验证的,所以未过滤的 href 会让 `javascript:` URL 在点击时执行。该 allowlist 是 MarkdownText allowlist（它还允许 `mailto:`）的 http(s) 子集,因此不受信任的检索链接无论在何处渲染都行为相同。

## Testing

`packages/client/ui-primitives/tests/web-block.client.spec.tsx` 把组件钉到 per-file 100% 门槛:两种 kind;标题-或-主机名-或-原始 URL 的标签回退;两种 kind 上的安全链接属性（http(s) URL 成为带 `target`/`rel` 的外链,`javascript:`/`file:`/无法解析的 URL 渲染为无 href 的纯 span）;snippet 与日期在存在/为空/缺失时的显示或省略;由标志位控制的截断提示;以及完整 source 列表渲染在单个滚动容器内、无展开控件、`<li value>` 从 1 起为每条 source 连续编号。

`packages/client/ui-tool/tests/web-card.client.spec.tsx` 在每个接线边界镜像 `terminal-card.spec.tsx`:`webCardModel` 的派生投影每个 source 字段、其截断与缺失 answer 的支路、fetch 派生、以及每个 null 支路（运行中、null result view、generic result view、未知 card 标签、未知 web `kind`）;键控 `WebRow` 对两种 kind 的常驻卡片、其仅摘要行的运行中与失败支路;`GenericToolCard` 兜底为 web 声明工具长出常驻卡片、并为非 web 调用保持纯行;详情面板 Output 区对两种 kind —— 含 `web_fetch` 正文摊平在其 URL/状态卡片下方 —— 及其对非 web 结果的摊平回退;以及在 `web_search` 与 `web_fetch` 两键下用一个组件的键控注册。该文件位于覆盖率 `exclude` 列表（`ui-tool/src/*`）,因此覆盖率运行不度量它。

fixture（`packages/client/connection/src/client/fixture.ts`）添加 turn 66（`web_search`）与 67（`web_fetch`）,内联撰写,因为客户端 fixture 无法 import web 工具:turn 66 的 result view 携带一个 answer 与三个 source,演练引用列表（一个带 snippet 与日期的有标题 source、一个无标题因而以主机名标注链接的 source、一个有日期无 snippet 的 source）并开启截断提示;turn 67 携带抓取的 URL 与一个 200 状态。两者都保留 generic pending call view,仅在 result 时添加 `web` 卡片,匹配约定的 result-only web 形状,且以真实工具命名,使其命中键控 `WebRow`。它们被排在 todo turn（重编号为 68）之前,理由与终端 turn 相同:待定计划在下一个 `turn/start` 退休,所以排在其后的 turn 会清空 dock 的 plan strip。这驱动 built-boot snapshot 与一个实时 `?fixture` 服务。

## Related

- [Web result card](2026-07-30-web-result-card.zh.md) —— 添加 `card: 'web'` result 支路并让两个工具发出它的后端契约;其前端消费方归本 note 所有。
- [Web search 来源卡片改为滚动而非折叠](2026-08-03-web-search-source-scroll.zh.md) —— 用定高滚动容器替换本笔记的 source 列表头/尾折叠,并移除 `CHAT_WEB_MAX_SOURCES` 与原语自身的 source 上限;本笔记的其余决策依然成立。
- [Web terminal card](2026-07-28-web-terminal-card.zh.md) —— 本条所镜像的先例:一个 `ui-primitives` block、一处 card-model 派生、键控与兜底 chat 行、以及一个详情面板支路,用于 `terminal` 渲染意图。
- [工具调用呈现的标签化 render-intent union](../architecture/2026-07-02-tool-render-intent-union.zh.md) —— `card` 标签词汇;Web 客户端现在是 `web` 支路的完整消费者。
