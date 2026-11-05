---
kind: upgrade-guide
description: "实时 Session projection 帧改为列出一个已提交事件改变的全部 key，不再每帧只带一个 key。"
---

# Projection 帧列出一个事件改变的全部 key

[English](guide.md) | 中文

## 变更

`session/control` 流上的实时 `projection` 帧与 `session/observeProjections` 流上的变更帧，原先每帧只带一个 projection key：`{ type: 'projection', sessionId, key, value, seq }`。一个事件改变多个 key 时，会产生多帧 `seq` 相同的帧。现在每帧携带一个已提交事件改变的全部 key：`session/control` 上是 `{ type: 'projection', sessionId, seq, changes }`，`session/observeProjections` 上是去掉 `sessionId` 的同样字段。`changes` 中每个变化的 key 一项 `{ key, val }`，key 不重复，`val` 是该 key 的新值。未出现在 `changes` 中的 key 没有变化。`@deepseek-ai/dsh-api-session-controller` 导出的 `SessionProjectionUpdate`、`SessionProjectionChange`、`SessionControlFrame` 与 `SessionProjectionFrame` 类型随新字段更新。

baseline 帧、`session/projections` 读取以及 Host 监听器 `ctx.sessionProjections.onChanged` 的行为不变。Host 新增 `ctx.sessionProjections.onEventChanged`，按每个已提交事件调用一次。

受影响的是直接读取这两条流的 Remote 客户端，例如测试 harness、代理和外部看板。内置 Web 客户端与 `@deepseek-ai/dsh-api-session-controller/client` 已读取新帧。

## 迁移

1. 把 `apply(frame.key, frame.value, frame.seq)` 这类调用改为遍历 `frame.changes`：

   ```ts
   import type { SessionControlFrame } from '@deepseek-ai/dsh-api-session-controller'

   declare const frame: Extract<SessionControlFrame, { type: 'projection' }>
   declare function apply(key: string, value: unknown, seq: number): void

   for (const change of frame.changes) apply(change.key, change.val, frame.seq)
   ```

2. 把 `frame.key === 'inbox'` 这类 key 判断改为 `frame.changes.find(change => change.key === 'inbox')`，并从该项的 `val` 读取值。
3. 确认一个已提交事件对每个 Session 至多产生一个 `projection` 帧，且客户端持有的值与重新调用 `session/projections` 读到的一致。
