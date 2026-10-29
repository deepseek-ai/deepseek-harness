---
kind: upgrade-guide
description: "Session follow callers must explicitly request background Agent activation."
---
# Request activation when following a Session

English | [中文](guide.zh.md)

## Change

`session.follow` no longer automatically resumes a cold ordinary Agent when `activate` is omitted. It reads the opening snapshot and follows subsequent events without activation. This affects integrations that used opening a history stream to make an Agent available. The shipped Web Client sends `activate: true` explicitly and retains its opening behavior.

With `activate: true`, activation starts once the opening snapshot is computed, before it is delivered; that snapshot does not acknowledge Agent readiness. Subagent Sessions still do not use ordinary Agent activation.

## Migration

1. Add `activate: true` to `session.follow` requests that must resume a cold ordinary Agent. Keep the existing `address` and history-window fields.
2. For passive viewers, omit `activate` or set it to `false`.
3. Verify that an activation-enabled stream still returns its opening snapshot, then check Agent availability separately. Do not treat receipt of the snapshot as completion of activation.

See the [Session Controller reference](../../../../packages/api/session-controller/README.md) for history and state observation behavior.
