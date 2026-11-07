---
kind: upgrade-guide
description: "`ctx.sessionProjections.checkpoint(session)` keeps a released unit's last row instead of omitting it."
---

# Released projection units stay in checkpoints

English | [中文](guide.zh.md)

## Change

Previously, when the last registrant of a projection key released it, through `handle.dispose()` or by unloading the owning fiber, the registry deleted the unit and `ctx.sessionProjections.checkpoint(session)` stopped returning its row.

Now the released unit stays in the registry as a predecessor. It leaves event drives, `snapshot()`, `summaryKeys()`, `restoreFloor()`, `restore()`, `viewCheckpoint()`, and `hydrate()`, and Sessions created afterward get no cell for it. `checkpoint(session)` still returns the last row the unit folded for each existing Session, and the registry no longer advances that row. Registering the same key again replaces the predecessor and refolds the log; see the [registration lifecycle](../../../../packages/session/session-projection/README.md).

This affects plugin code and tests that read `checkpoint()` after a projection's owner unloads, such as HMR tests that assert a released key is absent. `@deepseek-ai/dsh-session-projection-cache` stores these rows, so a graceful shutdown no longer drops the values that Web-layer plugins folded before their Sessions detach.

## Migration

1. Find reads of `sessionProjections.checkpoint(...)` that run after a projection's owner unloads, including calls through an alias of `ctx.sessionProjections`.
2. Replace an assertion that the released key is absent from an existing Session with one that its row keeps the pre-unload value:

   ```ts ignore-check
   const row = ctx.sessionProjections.checkpoint(session).myKey
   await owner.dispose()
   expect(ctx.sessionProjections.checkpoint(session)).toHaveProperty('myKey', row)
   ```

3. To show that the unit left live participation, assert that a Session created after the unload has no row, `expect(ctx.sessionProjections.checkpoint(ctx.sessions.create())).not.toHaveProperty('myKey')`, or that an event appended after the unload leaves the row unchanged. A client-visible key is also absent from `snapshot(session).values`.
4. Run the affected tests; they pass when no assertion expects a released key to disappear from an existing Session's checkpoint.
