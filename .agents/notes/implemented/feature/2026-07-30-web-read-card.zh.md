# Agent Note: Read card — the read tool's structured line window reaches the client

Status: implemented

[English](2026-07-30-web-read-card.md) | 中文

## 问题

`read` 工具返回规范化输出对象 `{ path, offset, lines: [{ number, text }], totalLines }`，但它的展示层把这个结构压平了。`presentCall` 声明为 `GenericCallView`（`kind: 'read'`，一个跟随定位），`presentResult` 返回 `GenericResultView`，其唯一内容是剥掉 `<path>…</path><type>file</type><content>…</content>` 信封后的面向模型文本。收到该视图的 UI 只看到一个压平的文本块：行号以 `N: ` 前缀烘焙进文本、文件语言未知、`totalLines` 丢失。有相应能力的客户端无法像渲染 diff 那样渲染一次 read——即带行号、语法高亮、行号栏与内容分离的代码视图。

结构化数据在下游无法恢复。线上（wire）的工具结果只携带面向模型的 `ContentBlock[]`（已渲染文本）加上一个不透明的 `meta`；规范化输出对象留在工具内，从不到达客户端或会话日志。因此想要行数组、总数和语言提示的客户端无法从 `N: text` 文本里解析回它们——工具必须把它们投影到一个会持久化的通道上。

## 决策

给[渲染意图 union](../architecture/2026-07-02-tool-render-intent-union.zh.md) 新增第四个 `card` 标签 `read`——仅在结果侧。`ToolResultView` 增加 `ReadResultView { card: 'read'; title?; path; lines: ReadFileLine[]; totalLines; lang?; content? }`；`ReadFileLine { number; text }` 是共享的行单元。`ToolCallView` 不动：待定状态仍是 `GenericCallView`（`kind: 'read'`），因为一次调用在 `execute` 返回前不携带文件内容，调用时没有可展示的结构。这与 bash 终端 card 不同——终端 card 两侧都打标签，因为终端调用在调用时已携带命令和 cwd，而 read 调用既无内容也无总数，给调用侧打标签只会新增一个空变体。

read 工具通过 `output.presentationMeta` 投影结构化窗口，这与 write/edit 用来投影其应用 diff hunk 的持久化通道相同（[规范化工具输出约定](../architecture/2026-07-20-canonical-tool-output-contract.zh.md)）。`presentationMeta` 对一次顶层 surface 调用运行一次，返回 `{ path, offset, lines, totalLines, lang? }` 作为会话校验并存储在结果 `meta` 上的 JSON，`presentResult` 在实时和回放路径上都把该 meta 收窄回 `ReadResultView`。`offset`（窗口请求的 1-based 起始行）一并携带，是因为当字节上限低于首个选中行时，窗口会返回空的 `lines` 数组而 `totalLines` 为正；没有持久化的 `offset`，这类窗口的回放 card 就无法报告它从哪行开始、或续读应从哪行继续，而末行推断与文本重解析两种兜底都有损。没有这个通道，行数组和总数就无法触及：原始输出对象不在线上，而重新解析 `N: text` 文本既有损又对截断尾注脆弱。

`presentResult` 在以下情况返回 `undefined`——即 generic 回退：meta 缺失或畸形（`readMetaFromMeta` 防御性收窄它，因此回放旧的已记录结果永不抛错）、结果是错误、以及单个文本块不是 read 信封。本 card 出现之前记录的结果——信封合法但无持久化 `meta`——有意走同一条 `undefined` 路径：客户端回退到原始 `result.content`，因此显示带 `<path>/<type>/<content>` 信封的原文，而非旧展示器返回的剥信封 generic card。这仍是已接受的降级：展示器保留 generic 回退，而不添加剥信封兼容分支。已发布 Session 边会保留旧日志字节，本变更也重录了全部已发布 fixture（测试前置数据）。在成功路径上，`presentResult` 在结构化字段之外携带 `content`（剥信封后的文本），因此不具备 read 能力的 UI 会通过自己的 generic/default card 分支渲染文件文本。原 TUI 证明了这条回退的必要性：它的非穷尽结果 switch 读取 `view.content`，而另一道 dim-Markdown 门控也必须接纳 `card: 'read'`。该前端随后被移除，但对任何没有结构化 read 卡片的消费方而言，content 回退仍是视图约定的一部分。

### 语言提示推导

`langFromPath`（在 `read-render.ts` 中）通过一张固定小表（`LANG_BY_EXTENSION`，覆盖常见源码、配置、标记扩展名）把文件扩展名映射到语法高亮语言 id。它读取最后一个路径段与最后一个点之后的扩展名，大小写不敏感，并对以下情况返回 `undefined`：dotfile（`.gitignore`）、无扩展名（`/etc/hosts`）、结尾的点、以及任何未知扩展名——此时 card 省略 `lang`，UI 渲染纯文本。该表不是可调项（tunable）：它是 UI 可忽略的展示提示，而非随部署变化的选择，未知扩展名降级为纯文本而非失败。它有意保持小规模而非穷尽的语言注册表；扩展它只需新增一行表项。

## 考虑过的替代方案

**在 `presentResult` 中重新解析 `N: text` 面向模型文本。** 已否决：结构化行数组将不得不通过按第一个 `: ` 切分每行来重建，这既有歧义（某行文本自身含 `: `），又丢失精确的 `totalLines`（脚注只在部分分支中陈述它），并在渲染格式变化时立即失效。`presentationMeta` 携带已经结构化的数据，无需重新解析。

**调用侧也打标签（`ReadCallView`），镜像终端 card 的两侧对称。** 已否决：read 调用在执行前没有内容、没有行数组、没有总数——调用侧 read card 会是一个空变体，重复 `GenericCallView`（`kind: 'read'`，跟随定位）已经表达的东西。终端 card 两侧都打标签是因为终端调用确实携带调用时数据（命令、cwd）；read 调用没有。

**把结构化窗口放进新服务或旁路通道而非 `meta`。** 已否决：`meta` 是既有的持久化展示通道（write/edit 的应用 diff 也经由该通道传递），它随会话日志免费回放，无需新接线。服务会重新发明事件日志已提供的持久化与回放。

**用 merge-extensible union 而非封闭标签。** 出于[渲染意图 union](../architecture/2026-07-02-tool-render-intent-union.zh.md) 封闭的相同理由否决：新 card 需要消费代码来渲染它，因此被消费方静默丢弃的变体比编译错误更糟。把 `read` 加入封闭 union 是扩展它的许可方式——每个在 `card` 上 switch 的消费方都继续编译，因为新成员落入其 generic default，而想要富视图的消费方新增自己的分支。

## 影响

`ToolResultView` 多了第四个成员。消费方可以渲染结构化的 `lines`/`lang`/`totalLines` 形状，也可以将不支持的 card 路由到 generic 路径；read card 携带 `content`，所以后者仍会显示文件文本。本次生产者变更是让结构化数据可触及的后端，无需每个消费方同时实现更丰富的视图。

read 工具现在为每次顶层 read 计算 `presentationMeta`，这是对已有数据的一次小投影（一次 `lines.map` 和一次 `langFromPath` 调用）。meta 随会话日志持久化，因此 read 结果在磁盘上略大——它已渲染为文本的行数组，现在也以结构化形式存在。

## 测试

`packages/fs/tool-fs/tests/read-render.spec.ts` 单测 `langFromPath`（已知扩展名的大小写不敏感、扩展名在最后一段与最后一个点之后读取、以及 `undefined` 各情况：dotfile、无扩展名、结尾的点、未知）与 `readMetaFromMeta`（含与不含 `lang` 的良构收窄，以及每种拒绝：非对象、数组、缺失或类型错误的 `path`/`totalLines`/`lines`、畸形行项、非字符串 `lang`，以及——因为该函数收窄不透明的持久化 `meta` 边界——类型正确的回放 JSON 仍可能携带的语义无效路径：不是 1-based 整数的 `offset`、小于 `offset` 的首行 `number`、不是 1-based 整数的行 `number`（`0`、`1.5`、`NaN`、`Infinity`）、不是非负整数的 `totalLines`（`-1`、`1.5`、`NaN`）、以及行号重复、递减或超过 `totalLines` 的情况；并且收窄正 `offset` 处的空窗口（字节上限低于首个选中行））。`packages/fs/tool-fs/tests/tools.spec.ts` 固定工具接线：`execute` 把结构化窗口（含与不含 `lang` 提示）作为 `meta` 附上、`presentResult` 把它收窄为携带剥信封 `content` 的 `card: 'read'` 视图、以及各拒绝路径（错误结果、非单文本内容、meta 有效但信封畸形、信封有效但 meta 缺失或畸形）都回退到 `undefined`。两个改动的源文件保持逐文件 100% 覆盖率。本变更携带的是持久化 meta 与扩展后联合类型的快照证据，而非新渲染视图的证据：重录的 ACP（Agent Client Protocol）会话 fixture（`fs-read`、`fs-read-window`、`fs-edit`、`fs-policy-reject`、`fs-write-overwrite`、`parallel-tool-calls`、`agent-instructions`、`workspace-edit`）钉住持久化的读取 `meta`（含 `{{cwd}}` 令牌化路径），`cordis-inspect-jsdoc` 钉住四成员的 `ToolResultView` 联合类型。当时的终端快照还钉住了消费方的 generic dim-Markdown 回退保持逐字节一致；结构化卡片自身的组装应用 transcript（文本记录）则属于消费它的前端变更。

## 相关文档

- [工具调用展示的带标签渲染意图 union](../architecture/2026-07-02-tool-render-intent-union.zh.md) —— 本 Note 以 `read` 结果分支扩展的 `card` 标签词汇。
- [规范化工具输出约定](../architecture/2026-07-20-canonical-tool-output-contract.zh.md) —— 拥有本 Note 用来投影 read 窗口的 `presentationMeta` 持久化通道。
- [Web 终端 card](2026-07-28-web-terminal-card.zh.md) —— 客户端消费结构化 card 的先例；read card 遵循相同的生产者模式，仅结果侧。
