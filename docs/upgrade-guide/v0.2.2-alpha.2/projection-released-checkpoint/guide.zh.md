---
kind: upgrade-guide
description: "`ctx.sessionProjections.checkpoint(session)` 保留已释放单元的最后一行，而不再省略它。"
---

# 已释放的投影单元保留在检查点中

[English](guide.md) | 中文

## 变更

此前，投影 key 的最后一个注册方通过 `handle.dispose()` 或卸载所属 fiber 释放它时，注册表会删除该单元，`ctx.sessionProjections.checkpoint(session)` 也不再返回它的行。

现在，已释放的单元作为前任留在注册表中。它退出事件推进、`snapshot()`、`summaryKeys()`、`restoreFloor()`、`restore()`、`viewCheckpoint()` 和 `hydrate()`，此后新建的 Session 也不会为它建立 cell。`checkpoint(session)` 仍为每个已有 Session 返回该单元最后折叠出的行，注册表不再推进这一行。同一 key 再次注册时会替换前任并重新折叠日志；参见[注册生命周期](../../../../packages/session/session-projection/README.zh.md)。

这会影响在投影所属方卸载后读取 `checkpoint()` 的插件代码和测试，例如断言已释放 key 不存在的 HMR 测试。`@deepseek-ai/dsh-session-projection-cache` 会存储这些行，因此正常关停不再丢掉 Web 层插件在其 Session detach 之前已折叠出的值。

## 迁移

1. 找出在投影所属方卸载后执行的 `sessionProjections.checkpoint(...)` 读取，包括通过 `ctx.sessionProjections` 别名的调用。
2. 把「已有 Session 中不存在已释放 key」的断言，改为断言它的行保持卸载前的值：

   ```ts ignore-check
   const row = ctx.sessionProjections.checkpoint(session).myKey
   await owner.dispose()
   expect(ctx.sessionProjections.checkpoint(session)).toHaveProperty('myKey', row)
   ```

3. 如需证明该单元已退出实时参与，可断言卸载后新建的 Session 没有这一行，即 `expect(ctx.sessionProjections.checkpoint(ctx.sessions.create())).not.toHaveProperty('myKey')`，或断言卸载后追加的事件不会改变这一行。客户端可见的 key 也不会出现在 `snapshot(session).values` 中。
4. 运行受影响的测试；当没有断言要求已释放 key 从已有 Session 的检查点中消失时，测试即通过。
