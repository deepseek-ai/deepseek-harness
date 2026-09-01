# Agent Note: 上下文仪表看不见压缩

Status: implemented

[English](2026-08-05-context-meter-blind-to-compaction.md) | 中文

## 问题

composer 的[上下文仪表](../feature/2026-08-05-composer-context-meter-breakdown.zh.md)的圆环、百分比与 `~已用 / 容量` 标题都取自 `contextPressure.pressureTokens`，即提供方报告的最新提示词规模。这个数字只在某个请求报告用量时才会移动，而压缩（compaction）不报告用量：`compaction-basic` 通过直连的 `ctx.llm.stream()` 调用生成摘要，只追加 `compaction/start`、`compaction/summary`、用作替换的 `user/message` 和 `compaction/end`——没有 `assistant/message`，也没有用量分片。

于是在唯一一个专门用来改变它的操作面前，这块仪表纹丝不动。通过真实的 agent loop（智能体循环）驱动一次 `compactNow`：

```
BEFORE compact:  ring=4%  header=~4227/100000   rows=[system 18, tools 0, messages 4365]
AFTER  compact:  ring=4%  header=~4227/100000   rows=[system 18, tools 0, messages  286]
```

折叠表层得出的组成明细行下降了 93%。而圆环——那个主要的可操作元素，也正是用户压缩完立刻会去点开面板的理由——完全没动，而且要等到又跑完一整个轮次才会动。此时面板上的标题与明细行相差一个数量级以上，恰恰发生在读者最可能去把明细行加总的时刻。

## 决策

`contextPressure` 发布第二个分子 `projectedTokens`：在提供方样本之上，加上自取样以来表层增减部分的启发式重新计价，下界钳制为零。该折叠通过共享的 `surface-fold.ts` 携带已计价的表层，并在用量样本落地时记下 `sampledSurfaceTokens`——记录时机在同一条事件加入表层**之前**，因此 `assistant/message` 锚定的正是它自己那次请求实际携带的表层。`stateVersion` 提升到 3。

只有增量部分是估算的。锚点保持提供方精确值，从而把估算器对 CJK 文本与 JSON Schema 的系统性低估挡在占用率数字之外，同时又让这个数字能在内容落地或某段区间被遮蔽的瞬间做出反应。`contextOccupancy` 读取 `projectedTokens`，并回退到裸样本，因此从不含该字段的检查点恢复出来的投影会退化为旧行为，而不是直接消失。

这推翻了[上下文仪表决策](../feature/2026-08-05-composer-context-meter-breakdown.zh.md)中「圆环、标题与进度条总长保持提供方精确值」的那一半。那条决策真正想守住的东西——不要把启发式明细行按比例缩放到提供方总量、从而伪造精度——依然守住了：明细行仍未被缩放，标题仍不等于它们之和。改变的是这样一个认识：「提供方精确、但描述的是两次压缩之前那个请求」并不是更真实的数字。

## 备选方案

**改为投影 `measure().totalTokens`。** 测量服务本来就合成了正是这个量（`baseline` 锚点加有符号的 `surfaceDeltaTokens`），而且反应正确——同一次压缩前后实测为 4383 → 304。但它是一个建立在私有重放状态上的服务，不是纯折叠，投影无法调用它。要在 `ProjectionDefinition` 内部复现它的锚点，需要 `_estimateProviderAssistant` 对按 seq 引用的分片事件进行随机访问（`session.eventAt(seq)`），而 `apply(state, event)` 拿不到。以取样时的表层总量作为锚点，是同一个思路在纯逐事件折叠中可达的版本。

**在压缩结束时补写一条合成的用量记录。** 这确实能推动 `pressureTokens` 本身，但压缩手上唯一的用量是摘要请求自己的用量——那是完全另一个提示词。把它记成本对话的提示词规模，等于把谎言写进持久日志，而不只是写进某一处展示。

**让 UI 自己做减法：暴露 `sampledSurfaceTokens`，再读 `contextBreakdown.messageTokens`。** 这会把一个数字的算术拆散到两个投影和客户端三处。词汇的所有者是宿主，就应当由它发布完整值。

## 影响

占用率现在随每个表层事件推进，而不再是每个轮次跳一次，因此一个轮次中产生工具结果时圆环会持续爬升，而不是等到轮次结束才跳变——压缩落地的瞬间它也会掉下来。代价是线路上多了投影帧：`contextPressure` 每个表层事件推一帧，也就是 `contextBreakdown` 本来就在跑的频率。

面板的组成明细行仍然加不出标题数字，但现在只剩一个能讲清楚的原因，而不是两个：明细行带着估算器的误差，标题的锚点不带。剩下的抓手是估算精度（在 `estimate.ts` 里做 CJK 感知加权），它不改动任何 seam。

`sampledSurfaceTokens` 依赖一个前提：在某个步骤的请求与它的用量报告之间，不会有新内容加入表层。agent loop 在 `buildRequest` 之前接纳 steering（中途引导）与上下文，在 `assistant/message` 之后才排空工具结果，因此该前提成立；即便将来不再成立，误差也被限制在一条消息以内，并在下一个样本处自行纠正。

## 测试

`packages/llm/token-meter/tests/token-usage-projection.spec.ts` 覆盖了投影值在表层增长与一次压缩期间的延续更新（样本保持不动而投影值缩小），以及启发式误差会把数字压到负数时的零钳制。`packages/client/ui-conversation/tests/context-meter.client.spec.tsx` 钉住圆环读取投影值这一点，`chat-stats.spec.tsx` 钉住 `contextOccupancy` 的优先级与回退。上面那组端到端数字来自在挂载了投影注册表的真实 `AgentLoop` 上驱动 `BasicCompactionEngine.compactNow`。
