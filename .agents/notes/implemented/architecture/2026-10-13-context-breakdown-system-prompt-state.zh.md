# Agent Note: 上下文构成只保留系统提示词

Status: implemented

[English](2026-10-13-context-breakdown-system-prompt-state.md) | 中文

## Problem

`contextBreakdown` 曾为每个保留的 surface 节点存一条 `{ seq, heuristicTokens, system }`，以便任意替换都能减去其范围的精确价格，并重新选出最后一个非空系统提示词。因此它的检查点随模型上下文中的消息数增长。在一个包含 836 个 Session 的本地语料中，151,122 条条目让该单元的行占用 projection cache 的 7.13 MB，单个 Session 最多 103 KB，而每次缓存会话列表都要校验全部条目。低于压缩阈值、工具调用密集的长时间运行各自保留约 2,000 条条目。

## Decision

[`breakdown-projection.ts`](../../../../packages/llm/token-meter/src/breakdown-projection.ts) 按 surface 顺序保留存活的 `system/message` 节点及其启发式价格、一个 surface 运行总量，以及至多一个已武装的影子价 claim。状态版本 6 丢弃版本 5 的行；其他 projection key 保留各自的行。

- 追加加上其价格；`system/message` 追加还会加入系统列表末尾。
- `compaction/summary` 和 `compaction/prune` 依据 `shadowedRange`、`shadowedTokenCount` 以及 `shadowedSeqs` 中列出的已保留系统提示词武装 claim。下一个事件消费或使其失效。覆盖所 claim 范围的替换减去 claim 价格并移除这些提示词；指向其他范围的替换，或以 `system/message` 取代已计量范围的替换，会抛出错误。
- 对单个已保留系统提示词的未计量替换减去该提示词自身的价格。`system/message` 替换保持其位置；其他替换将其移除。
- 其他未计量替换以零增量折叠，这与 `contextPressure` 已采用的规则相同。

`systemTokens` 是最后一个价格为正的保留提示词，`messageTokens` 是 surface 总量减去它；两者都不低于零。`shadowedSeqs` 是被遮蔽节点的权威集合，因此由成员关系决定哪些提示词离开，无需在 surface 顺序中定位非系统端点。

## Verification

用版本 5 和版本 6 的定义折叠全部 836 份已存日志，每个事件之后的构成数字都完全相同。这些日志包含 2,206 次已计量替换、106 次系统提示词改写，没有其他替换。保留状态从 7.13 MB 降到 110 KB，单个 Session 最多有五个存活的系统提示词。

## Alternatives considered

**保留逐节点条目，换用更快的校验器。** 手写节点检查把列表校验从 75 ms 降到 4.5 ms，但仍保留 7.13 MB 的行、每个 surface 事件一次 O(surface) 数组复制，以及与消息数成正比的检查点写入。

**列式逐节点条目。** 并行数组让行缩小约 5.7 倍，但仍为影子价事件已经携带的信息保留 O(surface) 状态。

**精确定价未计量的非系统替换。** 这需要逐节点价格。当前生产方会计量每一次非系统替换，自 v0 起的已发布格式都携带影子价字段，因此剩余情况只是破坏生产方相邻性的日志；它像 `contextPressure` 一样产生偏差。

## Consequences

检查点大小和每个事件的成本取决于存活系统提示词的数量而不是消息数，缓存列表也不再校验逐消息条目。对已计量替换和系统提示词改写，数字保持精确，其和在这些生产方下等于 `measure()` 的启发式总量。未计量的非系统替换会让数字偏离该替换的价格差。未来插入系统提示词的范围替换会被拒绝，直到折叠能确定它在已保留提示词中的顺序。这取代了 [历史内系统提示词替换](../feature/2026-09-02-in-history-system-prompt-replacement.zh.md) 说明中针对该单元的位置条目选择；`measure()` 仍为路由定价保留位置节点。
