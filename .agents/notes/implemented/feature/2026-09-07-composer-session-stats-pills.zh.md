# Agent Note: 输入框下的会话统计 —— 双图标 pill 与点击展开的统计弹层

Status: implemented

[English](2026-09-07-composer-session-stats-pills.md) | 中文

## 问题

输入框下方的会话统计条（`StatsLine`，ui-chat，挂载于 `conversation.composer.dock`）把所有数字渲染成一整行常驻文本：轮/步计数、模型与工具用时、TTFT/TPS 均值、紧凑 token 总量与缓存命中率。数字越多行越拥挤，精确 token 计数无处可看（带 `ResizeObserver` 溢出测量的悬停提示只在截断时复述同一行紧凑文本），纯文本也没有分组——时间类数字和计费类数字读起来混作一行。一次页面内 A/B 对比双 pill 变体后方向定案：pill 方案在可扫读性和"每类数字有归属"上胜出。

## 决定

[性能与用量偏好](2026-09-16-performance-usage-preference.zh.md)管理统计可见性，并移除已完成轮次的耗时操作。

`StatsPills`（packages/client/ui-chat/src/client/chat/StatsPills.tsx）在同一 `conversation.composer.dock` 插槽上取代 `StatsLine`；落选变体已删除，其共享工具函数（`deriveStats`、`formatDuration`、`cacheHitPercent`、`billedInputTokens`）并入新模块，废弃的 `stats.llm`、`stats.toolCall`、`stats.ttftAverage`、`stats.tokensPerSecond`、`stats.tokens` 文案键一并移除。

- **两个图标 pill、两个弹层。** 仪表盘 pill（新增 `IconGaugeOutlineRegular`，因下开口圆弧视觉偏高而把表盘中心光学下移到 y=8.75）展示 `{turns} 轮 {steps} 步` 加输出 TPS，点击打开「会话统计」弹层（模型用时、工具调用用时、首 token 平均、输出速度）；日志里没有任何计时数字时弹层会是空的，此时该 pill 渲染为静态读数而非按钮。数据库 pill（`IconDatabaseOutlineRegular`）展示紧凑计费总量加缓存命中率，点击打开「Token 用量」弹层（缓存命中、未缓存输入、缓存读取、输出，以及非零时的缓存写入——精确计数）。两个弹层共用为这两处消费者抽出的 `stat-dialog` 模块（portal 面板、锚定定位、点击外部关闭、可选的外部持有开合状态）；pill 行持有唯一的互斥开合槽位，打开任一弹层即关闭另一个，且每个按钮携带显式 `aria-label`，用 ` · ` 分隔 aria-hidden 分隔符在视觉上连接的两段文本。[StatsPills](../../../../packages/client/ui-chat/src/client/chat/StatsPills.tsx)负责缓存写入为零时省略该行的规则。
- **统一信息层级。** 输入框底部统计与单轮回答末尾信息都使用次级字号减 1px。回答末尾信息使用与操作图标一致的 tertiary 文字颜色，并与操作图标组额外拉开 8px。
- **数据来源架构不变。** 计数与用时优先读取持久的 `sessionStats` 投影，窗口折叠仅作无该单元装配时的回退（[全会话计数](../../archived/bug-fix/2026-08-12-full-session-turn-step-counts.md)）；token 数字只走 `tokenUsage`，投影缺席时直接不渲染用量 pill，而非展示窗口推算的计费。缓存写入仍计入计费总量与缓存命中分母（[投影决定](../architecture/2026-07-29-projected-token-usage-and-request-context.zh.md)）。上下文占用仍归 ui-conversation 的 `ContextMeter` 所有，在输入卡片下方、两个统计 pill 之后显示圆环和百分比。共用 dock 将统计信息放在一起，工具栏保留给输入操作；ui-chat 不导入上下文组件。上下文面板通过 portal 渲染，复用 ui-primitives 的视口内定位与外部指针关闭工具，统计贡献项缺席时也不会越界。
- **渲染纪律。** 该行只折叠已定稿节点（`chat.legacy.nodes` 身份），流式 chunk 帧零重渲染——由渲染计数单测钉住。无已完成步且无计费 token 的会话什么都不渲染。
- **输入框负责 dock 间距。** `InputBar` 将 slot 贡献项和 `ContextMeter` 放在同一个居中的 flex 行中，在 dock 上下各提供 4px 留白，即使 slot 没有可见贡献项也保持该间距。hero 保持无底部留白，并隐藏空 dock。`StatsPills` 提供可收缩的时间与计费内容，不占满整行宽度，也不添加外部 padding。

## 备选方案

- **单行变体（StatsLine，A/B 落选方）。** 全部数字常驻一行文本，悬停提示只在截断时复述整行。败在拥挤与可达性：精确 token 计数无处可看（行内和提示里都只有紧凑总量），单行也无法给时间与计费数字分组。
- **三个常驻分组共享一个弹层。** 中间迭代曾把计数、时间、token 保持为三个内联分组。双 pill 胜出是因为时间/用量的切分与两个底层投影一一对应，且每个 pill 的图标直接预告其弹层内容。
- **抽出与 `TurnUsagePanel` 共享的 dl 分桶行。** 会话总量弹层与逐轮面板皮肤相同但约定不同（会话输入、缓存读取与输出行始终存在，缓存写入行仅在非零时出现；逐轮字段可选且含模型路由）；共享组件只是给九行代码包一层条件。该镜像以 `jscpd:ignore` 标注并内联说明理由。

## 后果

- `ChatSnapshotBuilder` 的 legacy 切片现在服务于 StatsPills；[节点装配 note](../architecture/2026-08-09-client-conversation-node-assembly.zh.md) 已跟进该消费者更名。
- 精确 token 计数第一次变得可达——一次点击即可；`StatsLine` 只展示过紧凑总量。统计条本身只承载两个头条读数。
- Web e2e 对统计条的断言匹配时间 pill 内的子串文本；fresh-round-trip 的 aria golden 钉住提交操作下方的时间、计费、上下文顺序，stats-paged-history 则在无计费 token 的日志上钉住单独的计数读数。
- 生成的插槽目录中 `conversation.composer.dock` 占用者为 `client-ui-chat StatsPills id 'stats'`。
