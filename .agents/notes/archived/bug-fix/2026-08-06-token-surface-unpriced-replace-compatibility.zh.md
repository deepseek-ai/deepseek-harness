# Agent Note: 未计价的表层替换以中性方式折叠

Status: implemented
Archived: 2026-09-04

[English](2026-08-06-token-surface-unpriced-replace-compatibility.md) | 中文

## 问题

`contextPressure` 与 `contextBreakdown` 两个投影只维护一份滚动累计的表层 token 总量，外加至多一条待结算的影子价格（shadow price）声明，因此其持久化检查点在会话整个生命周期内保持 O(1)。当前的替换生产方会紧贴在替换之前追加一条 `compaction/summary` 或 `compaction/prune` 计量事件；其 `shadowedTokenCount` 对被替换区间精确计价，`foldSurfaceProjection` 再把它换算成有符号增量。

影子价格协议引入之前录制的会话，其日志中的替换没有相邻的计量事件。O(1) 状态无法重建被替换区间的价格，而折叠此前把每一次未计价替换都当作约定违规并抛出异常，于是回放这类会话会在第一处替换就中断（`token surface: replace at seq … has no adjacent shadow price`），会话从此永远无法打开。

## 决策

到达时没有已就位声明的替换以价格中性的方式折叠：`foldSurfaceProjection` 返回 `deltaTokens: 0`，相当于把被替换区间计价为恰好等于其替换内容的成本，回放随即继续。因中间插入的事件而过期的声明也走同一条中性路径，因为折叠无法把它与从未计量过的日志区分开。

已就位但指向**另一个**区间的声明仍会抛出异常。此时计量事件确实相邻，说明生产方写入了互相矛盾的相邻事件：这是现行影子价格约定的违规，不是历史数据，必须响亮失败，而不能任由总量悄然漂移。

两个投影共用同一个折叠，因此二者都不新增状态字段，也不提升 `stateVersion`。`surface-fold.ts` 与 `ctx.tokenMeter.measure()` 不受影响：它们持有逐节点的已计价表层，本来就不需要声明协议。

## 备选方案

**维持抛出异常。**保住了严格的生产方约定，但协议之前的每个会话都将永远无法回放，而投影本就是为服务回放而存在的。

**在投影状态中持久化完整的已计价表层。**可以对任意被替换区间精确计价，但检查点会随每条模型可见消息各增加一个节点、无上限地增长，恰恰破坏了影子价格协议所要守住的 O(1) 约束（见[上下文仪表的 Agent Note](2026-08-05-context-meter-blind-to-compaction.zh.md)）。

## 影响

未计价的替换让总量保持不动而不是缩小，因此被压缩（compaction）掉的区段仍被计入：`contextBreakdown.messageTokens` 保留这部分多计的量；`contextPressure.projectedTokens` 会高估占用率，但只持续到下一个用量样本重新锚定为止，因为该数字追踪的是自样本以来的增减，而非绝对水平。高估占用率只可能触发更早的压缩。

响亮失败保留在它仍有意义的地方：区间不匹配的相邻声明是现行生产方的缺陷，仍会抛出异常。

## 测试

`packages/llm/token-meter/tests/context-breakdown-projection.spec.ts` 钉住了无声明与声明过期两种替换的中性折叠、声明区间不匹配时的抛出异常，以及声明匹配时的精确计价。`packages/llm/token-meter/tests/token-usage-projection.spec.ts` 钉住了 `contextPressure` 在一次未计价替换前后保持不动。
