---
kind: upgrade-guide
description: "移除 ctx.sessionQuery.inspectSession，经预备 Session 对象读取冷会话的插件将无法通过编译。"
---

# 移除 `ctx.sessionQuery.inspectSession`

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-session-query` 的 `SessionQueryEngine.inspectSession(sessionId, read, signal?)` 已移除。它为冷会话准备一个未发布的 `Session`，交给同步读取函数，让投影句柄和属主服务可以读取。这个对象不在 Session 存储中，没有 Agent，也不能追加事件。仓库内唯一的调用方 worktree 归档清理，现在经 `observeSession` 读取投影的对外值。

调用 `ctx.sessionQuery.inspectSession` 的第三方插件会受影响：无法通过编译，未标类型的调用会在运行时被拒绝。

## 迁移

1. 在插件中搜索 `inspectSession(`。
2. 把每处调用改为观察会话，再按 key 读取投影的对外值：`using observation = await ctx.sessionQuery.observeSession(sessionId, { signal })`，然后读 `observation.projections?.values[key]`。活会话与冷会话的值都算到日志末尾，冷会话不会被挂载或恢复运行。
3. 没有对外视图的状态归属方私有；经属主的服务读取，或请属主补上对外视图。
4. 运行类型检查；不再有调用时即可通过。
