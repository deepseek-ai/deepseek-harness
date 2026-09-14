# Agent Note: 输入框下的会话统计 —— 双图标 pill 与点击展开的统计弹层

Status: implemented

[English](2026-09-07-composer-session-stats-pills.md) | 中文

## 问题

输入框下方的会话统计条（`StatsLine`，ui-chat，挂载于 `conversation.composer.dock`）把所有数字渲染成一整行常驻文本：轮/步计数、模型与工具用时、TTFT/TPS 均值、紧凑 token 总量与缓存命中率。数字越多行越拥挤，精确 token 计数无处可看（带 `ResizeObserver` 溢出测量的悬停提示只在截断时复述同一行紧凑文本），纯文本也没有分组——时间类数字和计费类数字读起来混作一行。一次页面内 A/B 对比双 pill 变体后方向定案：pill 方案在可扫读性和"每类数字有归属"上胜出。

## 决定

`StatsPills`（packages/client/ui-chat/src/client/chat/StatsPills.tsx）在同一 `conversation.composer.dock` 插槽上取代 `StatsLine`；落选变体已删除，其共享工具函数（`deriveStats`、`formatDuration`、`cacheHitPercent`、`billedInputTokens`）并入新模块，废弃的 `stats.llm`、`stats.toolCall`、`stats.ttftAverage`、`stats.tokensPerSecond`、`stats.tokens` 文案键一并移除。

- **两个图标 pill、两个弹层。** 仪表盘 pill（新增 `IconGaugeOutline16`，因下开口圆弧视觉偏高而把表盘中心光学下移到 y=8.75）展示 `{turns} 轮 {steps} 步` 加输出 TPS，点击打开「会话统计」弹层（模型用时、工具调用用时、首 token 平均、输出速度）；日志里没有任何计时数字时弹层会是空的，此时该 pill 渲染为静态读数而非按钮。数据库 pill（`IconDatabaseOutline16`）展示紧凑计费总量加缓存命中率，点击打开「Token 用量」弹层（缓存命中、未缓存输入、缓存读取、输出，以及非零时的缓存写入——精确计数）。两个弹层共用为这两处消费者抽出的 `stat-dialog` 模块（portal 面板、锚定定位、点击外部关闭、可选的外部持有开合状态）；pill 行持有唯一的互斥开合槽位，打开任一弹层即关闭另一个，且每个按钮携带显式 `aria-label`，用 ` · ` 分隔 aria-hidden 分隔符在视觉上连接的两段文本。[引导起始页与统计 pill 的细化](2026-09-10-guide-start-page-and-stat-pill-refinements.zh.md)负责缓存写入为零时省略该行的规则。
- **数据来源架构不变。** 计数与用时优先读取持久的 `sessionStats` 投影，窗口折叠仅作无该单元装配时的回退（[全会话计数](../../archived/bug-fix/2026-08-12-full-session-turn-step-counts.md)）；token 数字只走 `tokenUsage`，投影缺席时直接不渲染用量 pill，而非展示窗口推算的计费。缓存写入仍计入计费总量与缓存命中分母（[投影决定](../architecture/2026-07-29-projected-token-usage-and-request-context.zh.md)）。上下文占用仍在输入框旁的 ContextMeter 圆环上，`StatsLine` 时代它就在那里——统计条从未承载过它。
- **渲染纪律。** 该行只折叠已定稿节点（`chat.legacy.nodes` 身份），流式 chunk 帧零重渲染——由渲染计数单测钉住。无已完成步且无计费 token 的会话什么都不渲染。
- **`data-composer-stats` 是跨包属性契约。** pill 行根元素携带它；ui-conversation 的 `InputBar.module.css` 用 `:has([data-composer-stats])` 在该行挂载时把输入框底部留白收紧到 4px。生产方在单测里钉住该属性，沿用 `data-trigger-menu` 先例。

## 备选方案

- **单行变体（StatsLine，A/B 落选方）。** 全部数字常驻一行文本，悬停提示只在截断时复述整行。败在拥挤与可达性：精确 token 计数无处可看（行内和提示里都只有紧凑总量），单行也无法给时间与计费数字分组。
- **三个常驻分组共享一个弹层。** 中间迭代曾把计数、时间、token 保持为三个内联分组。双 pill 胜出是因为时间/用量的切分与两个底层投影一一对应，且每个 pill 的图标直接预告其弹层内容。
- **抽出与 `TurnUsagePanel` 共享的 dl 分桶行。** 会话总量弹层与逐轮面板皮肤相同但约定不同（会话输入、缓存读取与输出行始终存在，缓存写入行仅在非零时出现；逐轮字段可选且含模型路由）；共享组件只是给九行代码包一层条件。该镜像以 `jscpd:ignore` 标注并内联说明理由。

## 后果

- `ChatSnapshotBuilder` 的 legacy 切片现在服务于 StatsPills；[节点装配 note](../architecture/2026-08-09-client-conversation-node-assembly.zh.md) 已跟进该消费者更名。
- 精确 token 计数第一次变得可达——一次点击即可；`StatsLine` 只展示过紧凑总量。统计条本身只承载两个头条读数。
- Web e2e 对统计条的断言匹配时间 pill 内的子串文本；fresh-round-trip 的 aria golden 钉住双 pill 结构，stats-paged-history 则在无计费 token 的日志上钉住单独的计数读数。
- 生成的插槽目录中 `conversation.composer.dock` 占用者为 `client-ui-chat StatsPills id 'stats'`。
