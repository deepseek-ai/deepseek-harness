---
kind: upgrade-guide
description: "Live Session projection frames list every key one committed event changed instead of carrying one key each."
---

# Projection frames list every key one event changed

English | [中文](guide.zh.md)

## Change

Live `projection` frames on the `session/control` stream and change frames on the `session/observeProjections` stream carried one projection key each: `{ type: 'projection', sessionId, key, value, seq }`. An event that changed several keys produced several frames with the same `seq`. Each frame now carries every key one committed event changed: `{ type: 'projection', sessionId, seq, changes }` on `session/control`, and the same fields without `sessionId` on `session/observeProjections`. `changes` holds one `{ key, val }` entry per changed key, without duplicate keys, where `val` is the key's new value. A key absent from `changes` is unchanged. The exported types `SessionProjectionUpdate`, `SessionProjectionChange`, `SessionControlFrame`, and `SessionProjectionFrame` of `@deepseek-ai/dsh-api-session-controller` follow the new fields.

Baseline frames, `session/projections` reads, and the Host listener `ctx.sessionProjections.onChanged` keep their behavior. The Host adds `ctx.sessionProjections.onEventChanged` for one call per committed event.

This affects Remote clients that read either stream directly, such as test harnesses, proxies, and external dashboards. The bundled Web client and `@deepseek-ai/dsh-api-session-controller/client` read the new frames.

## Migration

1. Replace a call such as `apply(frame.key, frame.value, frame.seq)` with a loop over `frame.changes`:

   ```ts
   import type { SessionControlFrame } from '@deepseek-ai/dsh-api-session-controller'

   declare const frame: Extract<SessionControlFrame, { type: 'projection' }>
   declare function apply(key: string, value: unknown, seq: number): void

   for (const change of frame.changes) apply(change.key, change.val, frame.seq)
   ```

2. Replace key tests such as `frame.key === 'inbox'` with `frame.changes.find(change => change.key === 'inbox')`, and read the value from that entry's `val`.
3. Confirm that one committed event yields at most one `projection` frame per Session, and that the values your client holds match a fresh `session/projections` read.
