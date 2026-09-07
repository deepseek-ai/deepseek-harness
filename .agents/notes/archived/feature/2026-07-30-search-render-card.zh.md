# Agent Note: 搜索渲染意图——grep 与 glob 产出结构化搜索卡片

Status: implemented
Archived: 2026-09-04

[English](2026-07-30-search-render-card.md) | 中文

## 问题

`grep` 与 `glob` 返回结构化的 canonical 值——`grep` 是扁平的 `{ matches: [{ path, lineNumber, line }] }`，`glob` 是 `{ paths: string[] }`——但每个 UI 只见过它们面向模型的渲染文本：`grep` 把匹配按文件头分组、每行 `Line N:`，`glob` 打印换行连接的路径列表，两者在内联上限（`grepMaxMatches`，默认 250；`globMaxResults`，默认 100）把后续结果落到 spill 文件时都追加一个 spill 脚注。想把搜索结果渲染成可展开的按文件匹配组、或可选择的路径列表的 Web 前端，只能去重新解析那段文本。两个工具都已声明调用时的[渲染意图](../architecture/2026-07-02-tool-render-intent-union.zh.md)（`GenericCallView`，`kind: 'search'`），但没有结果阶段视图，所以已完成的调用回退到渲染原始文本的 generic 卡片。

结构化 canonical 值不通过协议传输：只有面向模型的渲染文本、以及当工具声明了 `output.presentationMeta` 时的一份 JSON 元数据，会经 `tool/result` 事件到达客户端（[canonical-output 约定](../architecture/2026-07-20-canonical-tool-output-contract.zh.md)）。因此携带结构化数据的结果时视图必须把数据投影进 `presentationMeta`，再在 `presentResult` 里读回——与 `write`/`edit` 的 diff 卡片走同一条路。

## 决定

`packages/core/tools/src/presentation.ts` 把 `card: 'search'` 作为 `SearchResultView` 加入 `ToolResultView` 联合，这是一个以 `shape` 判别的视图，表达两个工具的形状：`SearchMatchesResultView`（`shape: 'matches'`）以 `files: { path, matches: { lineNumber, line }[] }[]` 承载 `grep` 按文件分组的匹配，`SearchPathsResultView`（`shape: 'paths'`）承载 `glob` 的扁平 `paths: string[]`。两者都带 `truncated: boolean` 与 `total: number`。

判别子是 `shape` 而非 `kind`，是刻意为之：同一个 presentation 模块已经给 `GenericCallView` 一个 `kind: ToolCallKind` 字段，其取值恰好包含 `'search'`（图标类别）。持有 `ToolCallView | ToolResultView` 的桥接层会看到两个含义不同的 `kind` 字段；结果变体用 `shape` 把两者分开。

用一个带两种形状的视图而非两张卡片，因为两个工具是同一个视觉对象——一个搜索结果——Web 消费方先在一个 `card` 值上分支，再在 `shape` 上分支决定行布局。判别式 `shape` 让每个变体的字段保持非可选（matches 视图总有 `files`，paths 视图总有 `paths`），而不是一个所有形状相关字段都可选的单一接口。

该视图**不**携带结果文本。把面向模型的 `result.content` 附到视图上不会产生效果——消费方的回退路径本就读取原始 `tool/result` 内容——却会把整段搜索文本又序列化进持久化视图一遍。视图只承载结构化形状；无 search 卡片的 UI 回退到原始结果内容。

卡片标签只在结果时存在。搜索调用保持为 `GenericCallView`（`kind: 'search'`）：pending 状态没有匹配或路径可展示，所以 `SearchCallView` 能携带的东西不会比 generic 标题更多。这是与 terminal 卡片的不对称之处——terminal 的调用视图携带执行前就存在的命令、cwd、description；搜索的结构化内容只在 `execute` 之后才存在。

`packages/fs/tool-fs-search/src/presentation.ts` 拥有投影与收窄。`grepSearchMeta`/`globSearchMeta` 把 canonical 值投影为每个工具声明为 `output.presentationMeta` 的 `SearchMeta` 载荷；`presentGrepResult`/`presentGlobResult` 经 `searchViewFromMeta` 把 `result.meta` 读回。它们消费与面向模型渲染相同的已保留结果——`search-core.ts` 里的 `retainGrepMatches`/`retainGlobPaths` 只跑一次内联上限与每行预览预算，渲染与投影都取这份产出——所以文本与卡片对哪些结果幸存永不分歧，也没有第二次保留计算。`total` 是搜索找到的全部结果（截断前）；`truncated` 在上限丢弃了结果时置位。这是截断诚实点：模型看到的是被截断的内联结果加一个 spill 脚注，所以卡片不能把保留页当作完整结果——UI 读 `truncated`/`total` 显示截断指示，而非宣称模型从未有过的完整性。

**meta 有自己的字节预算。** 内联上限约束的是条目数，但一次宽泛搜索保留下来的匹配（数百条长行）仍可序列化到数百 KB，而 `meta` 会随会话日志持久化并在每次请求时重发。部署的最终输出预算（`dsh-spill-policy` 的 `maxInlineBytes`）只缩减结果的 `content`——`PostToolDecision` 没有 `meta` 通道——所以投影自己负责把 `meta` 约束住。`capMetaBytes` 丢弃末尾的文件组／路径，直到序列化 meta 装进 `searchMetaMaxBytes`（配置，默认 64 KiB），并把结果标记 `truncated`。单个大到自身都装不下的条目会被保留：不变量是可丢弃处一律有界，绝不产出隐藏了真实结果的空卡片。

`searchViewFromMeta` 防御性地收窄不透明的 `meta`，对任何畸形或缺失载荷返回 `undefined`，使在较旧或手工编辑的回放日志上运行的 presenter 回退到 generic 卡片而非抛错。它确实接受零结果载荷（`files: []` / `paths: []`）为合法的空卡片——这是对作为参照的 `diffsFromMeta` 的刻意偏离（后者拒绝空 `diffs`），因为零匹配的 grep 是 UI 展示为「no matches」的合法结果，而非缺失的投影。`presentResult` 对失败结果、对缺失 meta（嵌套 `run_code` 分发不计算 `presentationMeta`）、以及对另一工具的 meta 形状（每个 presenter 收窄到自己的 `shape`）返回 `undefined`。

`SearchMeta` 的成员形状是对象字面量 `type` 别名，而非视图暴露的 `SearchFileMatches`/`SearchLineMatch` 接口，因为只有 type 别名可赋给 `presentationMeta` 返回的 `JsonValue` 索引签名；两者结构等价，所以投影值仍读回为 `SearchResultView`。

没有专用 `search` 分支的消费方会回退到同一个 generic body，并从原始结果中读取面向模型的文本。因为搜索视图不带自己的 `content`，而 grep/glob 此前返回的是 generic 卡片，所以该回退与引入 search 卡片之前的路径逐字节一致。渲染结构化 `files`/`paths` 形状的前端独立于这个后端约定及其两个生产者。

## 考虑过的备选

**一个扁平的 `SearchResultView` 接口，带可选 `files?` 与 `paths?`。** 否决：它让两个形状相关字段在每个值上都可选，并允许畸形视图同时带两者或都不带。`shape` 判别式让每个变体的字段保持必需，并让消费方穷尽分支。

**复用 `kind` 作形状判别子。** 否决：同一模块里调用视图上的 `kind` 已经表示 `ToolCallKind`（图标类别，取值含 `'search'`）。结果视图上再有一个含义不同的 `kind`，对任何同时持有两者的桥接层都会冲突。

**把面向模型的文本作为视图的 `content` 附上。** 否决：对每个当前消费方是 no-op，且把整段搜索文本第二次序列化进持久化视图。视图是结构化形状；文本回退读原始结果内容。

**在 `PostToolDecision` 上加 meta 通道，让 `dsh-spill-policy` 像约束 `content` 那样约束 `meta`。** 此处否决：它为一个工具的载荷改动核心工具决策约定与 spill-policy 插件。投影按配置的字节上限约束自己的 `meta` 是自包含的，且保持 seam 不变。

**镜像 terminal 卡片双侧对称的调用时 `SearchCallView`。** 否决：搜索调用在 `execute` 前没有匹配或路径，视图只会携带 `GenericCallView` 已有的标题。

## 后果

`grep` 与 `glob` 现在在每次非嵌套的成功调用上计算 `presentationMeta`，这是对已保留匹配或路径的一次有界投影——与 render 消费的是同一份保留产出，所以没有第二次保留计算，传输中也没有双份搜索文本。序列化 meta 受 `searchMetaMaxBytes` 约束，所以宽泛搜索不再把无界的结构化副本持久化进会话日志。

无 search 卡片的 UI 渲染原始 `tool/result` 内容，所以不会导致任何消费方出现回归。渲染结构化形状的消费方读 `truncated`/`total` 与按文件分组；因为视图只携带保留的、字节有界的页，想要完整结果的 UI 跟随面向模型文本里的 spill 定位符，与模型的做法完全一致。

## 测试

`packages/fs/tool-fs-search/tests/presentation.spec.ts` 钉住纯层：`groupMatchesByFile` 的首见文件顺序；`grepSearchMeta`/`globSearchMeta` 在共享保留产出上的投影，`total` 报告截断前计数、`truncated` 被带过；保留过程施加的每行预览预算；序列化 meta 字节上限丢弃末尾组／路径同时保留单个超大条目；以及 `searchViewFromMeta` 对两种良好形状、零结果空卡片、以及每种畸形情形（非对象／数组 meta、缺失或误型的 `truncated`/`total`、未知 `shape`、畸形 `files` 条目、非字符串 `paths`）的收窄。`packages/fs/tool-fs-search/tests/tools.spec.ts` 钉住经真实工具注册表的接线：被截断的 `grep`/`glob` execute 在 `result.meta` 上产出 `SearchMeta`，`presentResult` 构建搜索视图（无 `content`），嵌套 `run_code` 分发不计算 meta 故 `presentResult` 回退，失败或跨形状或畸形结果回退到 generic 卡片。搜索包 `src` 上保持 per-file 100% 覆盖。

## 相关

- [工具调用呈现的带标签渲染意图联合](../architecture/2026-07-02-tool-render-intent-union.zh.md)——本变更用 `search` 结果标签扩展的 `card` 标签词汇。
- [Canonical 工具输出约定](../architecture/2026-07-20-canonical-tool-output-contract.zh.md)——本投影所依托的 value/render/`presentationMeta` 划分；结构化值留在执行本地，卡片通过 `meta` 传递。
- [Web terminal 卡片](2026-07-28-web-terminal-card.zh.md)——本变更在后端所仿照的先例：工具把结果投影进 `presentationMeta` 与一个 `presentResult` 视图；搜索卡片的 Web 消费方是与之类比的后续。
