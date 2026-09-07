# Agent Note: Web 搜索卡片 —— grep 与 glob 的 render intent 到达浏览器

Status: implemented
Archived: 2026-09-04

[English](2026-07-30-web-search-card.md) | 中文

## Problem

`grep` 与 `glob` 工具声明了一个仅在结果阶段存在的 `card: 'search'` render intent（[search render card](2026-07-30-search-render-card.zh.md)）：`SearchMatchesResultView`（`shape: 'matches'`）携带 grep 按文件分组的匹配，或 `SearchPathsResultView`（`shape: 'paths'`）携带 glob 的扁平路径列表，两者都带 `truncated`/`total` 截断信号。该视图已经到达浏览器 —— host、connection、runtime 把它作为 `resultView` 投递到 `ConversationSnapshot` 上 —— 但 Web 客户端忽略了它：每个非终端、非 diff 的工具结果都落到 generic 卡片，渲染面向模型的文本。想把搜索结果渲染成可展开的按文件匹配分组、或可扫读的路径列表的 web 前端，只有那段预格式化文本。

这正是 search render card note 指名的后续：后端约定和它的两个生产者归那篇 note 所有，web 消费方归本 note 所有。

## Decision

`SearchBlock` 是一个 `ui-primitives` 组件，把一次已完成的搜索渲染成两种形态之一，`grep`/`glob` 调用的 Web 渲染点都通过它消费搜索 render intent。`ui-tool/src/client/tool/models/search-card-model.ts` 是把 snapshot 的 `resultView` 转成组件 props 的唯一位置，因此没有渲染点重新推导形态。当结果视图不是搜索卡片时它返回 null（走 generic 路径），包括仍在运行的调用（搜索卡片仅在结果阶段存在，`execute` 前无内容）、`grep`/`glob` 失败或嵌套 `run_code` dispatch 产生的 generic 结果、terminal 结果视图、本客户端版本不认识的 `card` 值、`shape` 是本版本无法编译的 `card: 'search'` 视图，以及 —— 因为 `shape` 和分组/扁平内容与 host schema 只做字符串校验的那同一个不可信 wire 帧同行 —— 一个 `shape` 已知但 `files`/`paths` 缺失或格式错误的视图（否则会让 `SearchBlock` 在 `.reduce`/`.map` 处崩溃）。结果视图的判别键是 `shape`（不是 `kind` —— 后端把 `kind` 留给 call view 的选图标签）；`SearchBlock` 自身的 prop 仍是 `kind`，由本推导从 `shape` 映射得到。

与终端卡片的不对称是刻意的，继承自后端约定：`terminalCardModel` 同时读 `callView` 和 `resultView`，因为命令、cwd、description 在调用时就存在；`searchCardModel` 只读 `resultView`，因为搜索的匹配或路径只在执行后存在。因此运行中的搜索行只显示摘要，没有卡片。

一个组件绘制两种形态，用 `kind` 区分，因为 `grep` 和 `glob` 是同一个视觉对象 —— 一个搜索结果。`SearchMatchesBlockProps`（`kind: 'matches'`）和 `SearchPathsBlockProps`（`kind: 'paths'`）让每种形态的字段保持必填，而不是所有字段都可选的单一接口。组件把它持有的形态压平成一个渲染行列表 —— matches 形态是一个文件头行加它的匹配行，paths 形态是每个路径一行 —— 于是高度上限把一个文件头当作一行来计，与一条匹配行或一个路径相同，头/尾切片算术就是 `TerminalBlock` 的（`ceil(max/2)` 头，其余为尾），因此一个长搜索结果和一段长命令输出在两张卡片间在同一处截断。

组件约定：

- **按文件分组的匹配，逐文件可折叠。** 每个文件是一个头行（加粗路径加它的匹配计数，整行即折叠控件），后面跟它的 `lineNumber: line` 行。折叠一个组会把它的匹配行从压平列表和高度上限的算术里去掉，但绝不从复制文本里去掉。
- **扁平路径列表。** paths 形态每行一个路径，无头行。
- **截断指示。** `truncated` 时，横幅摘要把截断前总数折入 —— grep 为 `显示 X / 共 N 处匹配 · K 个文件`，glob 为 `显示 X / 共 N 个路径` —— 因此卡片绝不把一个被截断的页面呈现为完整结果。未 `truncated` 时摘要是一个朴素的结构计数（`{n} 处匹配 · {m} 个文件`，或 `{n} 个路径`）。
- **被截断结果的恢复脚注。** 卡片只持有保留的那一页，但通往其余部分的定位符 —— grep/glob 的 `Full … stored at: <locator>` 脚注 —— 只存在于原始 `tool/result` 内容里（搜索视图不携带结果文本；没有卡片的 UI 回退到那段原始内容），而非结构化的 matches/paths 中。由于每个渲染点都用卡片替换了原始结果，`searchCardModel` 在（且仅在）结果被截断时把 block 自身压平后的结果文本作为 `SearchCardModel.recovery` 暴露出来，每个渲染点把它画在卡片下方。没有它，通往被丢弃行的唯一路径就会从 UI 里消失；未截断的结果携带了每一行，其原始文本不增加任何信息，因此被丢弃。
- **不软换行。** 结果行在一个横向滚动的盒子里 `white-space: pre`，因此一条长匹配行或一个深路径横向滚动而不折叠。
- **带展开控件的高度上限。** 超过 `DEFAULT_SEARCH_MAX_LINES`（16）行时显示一个头/尾切片，中间一个按钮报告被隐藏的行数，形状和算术与 `TerminalBlock` 相同。
- **复制。** 复制控件写入整个结构化结果 —— 每个文件与匹配，或每个路径 —— 无关高度上限或哪些组被折叠，因此剪贴板携带的是结果本身，而不是卡片此刻恰好显示的内容。

几何、圆角、字体镜像 `CodeBlock` 与 `TerminalBlock`，因此搜索卡片与它们读作同一族；`white-space: pre` 加横向滚动是它们共享的刻意分歧。

### 渲染点

三个渲染点消费该推导，与终端卡片的落位完全一致：

- **keyed `SearchRow`**（`toolviews/search-row.tsx`）把一个组件同时注册到 `tool.call.toolview` keyed hole 的 `grep` 与 `glob` 键下，并把卡片作为常驻（resident）渲染在摘要行下方，上限为 `CHAT_SEARCH_MAX_LINES`（8）—— 与 `BashRow` 对其终端卡片采取的姿态相同。两个工具名共用同一行，因为推导出的 `kind` 决定形态，第二个组件只会重复它。被截断结果的恢复脚注画在卡片下方。因为 keyed 行占据了这个渲染槽，一个没有搜索卡片的已结算调用 —— 出错的搜索（grep/glob 出错时不产出结果视图）、成功的嵌套 `run_code` 子派发（后端不为其计算 `presentationMeta`，故 `resultView` 为 null）、或旧日志的 generic 结果 —— 否则只会显示摘要而丢失内容；该行把这段面向模型的文本作为 fallback body 暴露出来，判据是 `search === null && 已结算`，而非仅凭错误状态。（该常驻姿态与 terminal/diff 卡片一致；一次性翻转了所有常驻卡片的整行折叠/展开交互归[统一展开与检视 note](2026-07-30-web-tool-row-unified-expand-and-inspect.zh.md)所有。）
- **generic fallback**（`chat/GenericToolCard` → `chat/ToolRow`）把推导出的 model 作为展开门控的 body 传入，与 `terminal` 用的是同一分支：没有 keyed 行的 `grep`/`glob` 结果（发布应用里没有，因为两者都注册了）仍在行的展开开关后渲染其卡片，并带恢复脚注。
- **details panel**（`skeleton/DetailsPanel`）在 Output 段以 primitive 自身的完整高度渲染卡片，恢复脚注画在其下方，保留 JSON Input 段。

`CHAT_SEARCH_MAX_LINES`（8）是行内上限，为 primitive 默认值的一半（panel 保留默认值），理由与 `CHAT_TERMINAL_MAX_LINES` 相同：chat 流是跨多次调用扫读的摘要表面，panel 是单次调用的阅读表面。

## Alternatives considered

**两个卡片组件，每个工具一个。** 否决：`grep` 与 `glob` 是仅由 `kind` 区分的同一视觉对象，两个组件会重复横幅、高度上限、复制控件与不换行几何。一个按 `kind` 分支的组件正是后端那个单一 `card: 'search'` 视图的用途。

**加一个 `SearchCallView`，让行在搜索运行时就渲染卡片。** 否决：后端约定刻意没有调用阶段的搜索视图 —— 搜索在 `execute` 前没有匹配或路径。运行中的行只显示摘要，`searchCardModel` 对运行块返回 null，忠实于实际存在的东西。

**复用 `TerminalBlock` 或 `CodeBlock`。** 否决：两者都不建模逐文件可折叠的组或折叠式截断摘要，都需要把按文件分组的形态硬塞进去。三个块转而共享几何与字体 token，那是唯一一处一个实现对三者都正确的部分。

## Consequences

`SearchBlock` 只读搜索视图的字段，因此保持为 render intent 所携内容的纯函数 —— 无会话查询，与产生该视图的 presenter 一样可重放。没有搜索能力的 UI 仍得到 bridge 的围栏回退；工具的结果形态没有任何改变。给 `ToolRow` 扩一个 `search` body prop 只在 `terminal` 旁加一个分支；一次调用至多携带一种卡片，因此两者绝不同时出现在一行。

## Testing

`packages/client/ui-primitives/tests/search-block.client.spec.tsx` 以 per-file 100% 覆盖固定组件：两种 kind、折入摘要的截断前总数、空结果分支、逐文件折叠/再展开且不影响邻居、一个文件头与匹配行一样，在高度上限中单独计为一行、切口落在文件中间时尾部切片恢复其所属文件头、跨两种形态的头/尾上限及其展开控件（含无尾与默认上限的边界），以及复制控件在接受与拒绝的剪贴板路径上写入整个结构化结果。

`packages/client/ui-tool/tests/search-card.client.spec.tsx` 固定每个渲染点的接线：`searchCardModel` 对两种 kind 的推导、截断信号、替换标题、仅在截断时暴露的恢复文本，以及每个 null 分支（运行中、无视图、generic、terminal、未知卡片、本版本无法编译的 `kind`、以及一个形态缺失/错误的已知 kind）；通过 `GenericToolCard` 的展开门控 matches 与 paths body（含恢复脚注），对照非搜索的 args-JSON body；`SearchRow` 对两种 kind 的常驻卡片、它的恢复脚注、它对出错搜索与已结算无卡片结果两者的 fallback body、它与摘要行运行状态的一致、替换标题优先级，以及一个组件在 `grep` 与 `glob` 两个键下的 keyed 注册；以及 details panel 的 Output 段对两种 kind（含恢复脚注），对照非搜索的压平形态。`packages/client/ui-tool/src/*` 在覆盖排除清单上，因此该文件不受 gate 压力。`packages/client/connection/src/client/fixture.ts` 新增一个发出 `kind: 'matches'` 的 `grep` turn（三个文件、十二行超过行内上限、`truncated` 且带溢出恢复脚注，因此在组装快照里同时演练头/尾上限与恢复脚注）与一个发出 `kind: 'paths'` 的 `glob` turn，两者都驱动 built-boot snapshot 与实时 `?fixture` 服务。`apps/web/tests/search-card.expected.e2e.ts` 是仓库约定要求的组装输出检查：它通过 keyless fixture 传输启动真实构建的 `client.js` bundle，打开 fixture 会话，并把 grep 卡片的组装形态——kind、截断摘要、头/尾切片及其展开控件——固定在 `apps/web/tests/expected/search-card/` 下，因此一个损坏的 SearchRow 注册或被丢弃的卡片会让一个 golden 失败，而 built-boot smoke（按约定只测启动）无法捕获它。

## Related

- [Search render intent —— grep 与 glob 发出结构化搜索卡片](2026-07-30-search-render-card.zh.md) —— 后端约定与它的两个生产者；本 note 是它指名的 web 消费者后续。
- [Web 终端卡片](2026-07-28-web-terminal-card.zh.md) —— 本 note 镜像的先例：工具的 render intent 通过一个 `ui-primitives` 块、一个 `contract/*-card-model.ts` 推导、以及同样的三个渲染点到达浏览器。
- [工具调用呈现的标签化 render-intent 联合](../architecture/2026-07-02-tool-render-intent-union.zh.md) —— 两张卡片都消费的 `card` 标签词汇。
