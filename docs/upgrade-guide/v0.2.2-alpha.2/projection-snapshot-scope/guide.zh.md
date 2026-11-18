---
kind: upgrade-guide
description: "投影 snapshot 读取只计算返回的单元，注册表的 cached snapshot 读取已废弃，Session 列表摘要不再包含 context pressure 和 breakdown。"
---

# 投影 snapshot 的计算范围

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-session-projection` 的 `ctx.sessionProjections.snapshot(session, keys)` 只计算它返回的单元：传 `keys` 时只计算选中的单元，不传时计算每个定义了 `wire` 的单元、不计算 Host 专用单元。插件不能再依赖调用 `snapshot` 之后其他单元已经算好。注册表的 `cachedSnapshot(session, keys)` 已废弃，它只返回其他读取已经算好的值，可能缺少 key。持久化缓存的读取 `ctx.sessionProjectionCache.cachedSnapshot(header, keys)` 不变。`session.list` 摘要的 `projections` 不再携带 `contextBreakdown` 和 `contextPressure`，`@deepseek-ai/dsh-token-meter` 的这两项改为 `SessionProjectionSummaryExcluded`。读取这些值的插件以及 SDK 或 wire 客户端受影响。

## 迁移

1. 通过 `await ctx.sessionProjections.register(definition)` 返回的句柄，用 `handle.stateOf(session)` 读取自己单元的 Host 状态，不要先调用 `snapshot` 再读取 cell。
2. 把对注册表 `cachedSnapshot(session, keys)` 的调用替换为 `snapshot(session, keys)`。
3. 从打开的 Session 读取 `contextBreakdown` 和 `contextPressure`，例如 Session 投影 snapshot 或 follow 基线，不要从 `session.list` 行读取。
4. 重新构建插件和客户端，确认类型检查通过、`cachedSnapshot` 没有 `no-deprecated` 告警，并确认打开的 Session 仍显示上下文用量。
