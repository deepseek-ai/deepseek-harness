# Agent Note: 通过 sessionStats 投影提供全会话统计条数字

Status: implemented
Archived: 2026-09-04

[English](2026-08-12-full-session-turn-step-counts.md) | 中文

## 问题

Web 聊天统计条的每个非 token 数字都折算自 `StatsLine` 已加载的会话窗口（`deriveStats` 遍历 `chat.legacy.nodes`）：「N 轮 · M 步」计数、LLM 与工具墙钟时间、TTFT／吞吐平均值。历史按每页 50 条消息分页，因此每点一次「加载更早」窗口变大、所有数字随之增长——7 轮 · 44 步在翻一页后变成 10 轮 · 89 步，LLM 时长同样攀升。产品预期是与客户端加载了多少历史无关的全会话数字。同一统计条里的 token 账目早已采用正确架构：持久的 `tokenUsage` 投影。

## 决定

新的函数插件 `@deepseek-ai/dsh-session-stats` 在 `ctx.sessionProjections` 上注册 `sessionStats` 投影单元，作为 web-app bundle 行挂载。值携带统计条完整的非 token 数字集——`{ turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }`，字段名与窗口折叠一一对应以便整体互换。`steps` 统计 `step/end` 事件，`turns` 统计含至少一条该事件的不同 turn（turn 号单调递增，一个 `lastTurn` 槽即可）；`llmMs` 累加 `step/start` → `assistant/message`；TTFT 记录每步首个非空 delta chunk（在步内 `llm/retry` 后保留，与窗口 `resetForRetry` 对齐）；解码时长覆盖首 token → 已组装消息、仅统计上报 usage 的步；`toolMs` 按 callId 配对 `tool/call` → `tool/result`，未解决的调用在 `turn/end` 时丢弃。首 token 谓词 `isTokenDelta` 移入 `@deepseek-ai/dsh-llm/message`（与其判别的 `StreamChunk` 类型同处），Host 折叠与客户端计时索引共用同一实现；client-runtime 转发导出。投递完全复用现有投影缝——history 尾页块、`session/projection` 推送帧、列表行——apiproxy、wire schema 与客户端运行时零改动。`StatsLine` 读取 `useProjection('sessionStats')`，键为 undefined（未组合该单元的装配）时整体回退到窗口折叠。客户端 connection fixture 按其「镜像每个已组合键」的既有纪律以 `sessionStatsOf` 平行实现该折叠。

计数事件选 `step/end` 而非 `assistant/message`，源于评审直觉方案（按消息计数）时发现的两个正确性问题：

1. max-tokens 步会追加一条仅为承载 usage 而存在的空内容 `assistant/message`，它从不进入 surface；按消息计数会把 transcript 上看不到的步计进去。
2. 被取消的步在消息组装前就中止（完全没有 `assistant/message`），但客户端会合成可见的 interrupted assistant 节点；按消息计数会悄悄丢掉常见的取消步。

`step/end` 对每个进入的步在循环的 `finally` 中恰好追加一次，因此完成、失败、取消、max-tokens 的步都恰好落一条——且计数在步结算时推进，与窗口折算推进的时机相同，直播期行为不发生变化。

## 备选方案

**统计 `assistant/message` 事件。** 因上述两个正确性缺陷否决（多计 usage 宿主消息、少计被取消的步）。

**统计 `step/start` 事件。** 覆盖等价（它先于每条 `step/end`），但计数会在步开始而非结算时推进——一个没有收益的可见直播期行为变化；`step/end` 的 `finally` 位置给出同等完整性。

**把单元注册进 `core/agent-loop`（事件生产方）。** 循环是产品主干；把 UI 读模型放进去会给每个装配加上 session-projection 依赖，违反「用插件而非改循环」与「默认组合不带可选项」。

**把单元注册进 `token-meter`（折叠同批事件的现有单元）。** 轮/步计数不是 token 度量；每个投影键都住在拥有其领域的包里。

**在客户端折叠全量日志。** 客户端按设计只持有分页窗口；投影 RFC 的「不在客户端折叠」规则正是为了让数字在分页、压缩与冷读之间存活。

**墙钟时间、TTFT 与吞吐保持窗口口径，解读为「屏幕上有什么」。** 否决：同样的分页问题一样落在 LLM 时长上，且全量计数与窗口时间混在一条统计条里读起来是一套自相矛盾的数字。投影携带完整集合，窗口折叠降级为无单元时的回退。

## 后果

统计条从第一个尾页起就显示全日志数字；翻页不再改变任何分组。与旧窗口语义的已定义边缘差异记录在包 README 中：未产生可见输出的步（在内容之前失败）仍计入；被崩溃打断的步在重新加载、恢复为其补写合成 `step/end` 后计入（`interruptedTurnClosers`）；被取消的步计数但不计时（没有组装出消息）；max-tokens 的 usage 宿主消息贡献 surface 上看不到的模型时间。每个 web 尾页与列表行多携带一个小键，且单元内部状态在步边界与首 token chunk 处变化，变更流每步会多发几帧值相同的推送；TUI 与 headless 装配不提供 `sessionStats` 键，其消费者回退窗口折叠。两个曾把统计条当作已加载窗口探针解析的 e2e（`chat-scroll-contract`、`complex-history.perf`）改为统计已挂载的消息流行／turn-tail 页脚。`stats-paged-history` web 场景冷种一份 28 轮日志，钉住整条统计条在不完整尾页上即读出全量数字、且「加载更早」前后不变。
