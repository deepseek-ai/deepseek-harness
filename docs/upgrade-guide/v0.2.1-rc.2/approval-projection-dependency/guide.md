---
kind: upgrade-guide
description: "Custom ApprovalService compositions must provide sessionProjections and await service activation."
---

# Approval requires the Projection registry

English | [中文](guide.zh.md)

## Change

`ApprovalService` requires `sessionProjections`. It waits for projection registration during activation instead of reading the event log when the registry is absent or pending. Custom compositions that mounted approval alone must add the registry. Shipped profiles already provide it.

Approval outcomes, audit events, policy defaults, and synchronous business methods keep their existing behavior. Session logs and checkpoint formats do not change. The private registration handle is process-local; checkpoints contain only the policy override and turn state.

## Migration

1. In custom `cordis.yml` files, mount `@deepseek-ai/dsh-session-projection` before `@deepseek-ai/dsh-user-approval`. Avoid adding a duplicate registry to a shipped profile.
2. In direct host compositions, use `ctx.plugin(ApprovalService)` and await activation before using `ctx.approval`. Do not construct the service with `new ApprovalService(...)`: that does not run `Service.init`.

   ```ts
   import { Context } from '@deepseek-ai/cordis'
   import SessionStore from '@deepseek-ai/dsh-session'
   import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
   import ApprovalService from '@deepseek-ai/dsh-user-approval'

   const ctx = new Context()
   await ctx.plugin(SessionStore)
   await ctx.plugin(SessionProjectionRegistry)
   await ctx.plugin(ApprovalService)
   ```

3. Let the host and registry complete Session recovery before exposing historical state to synchronous readers. Follow the [registry lifecycle](../../../../packages/session/session-projection/README.md); do not add history loading to approval getters or replay runtime hooks.
4. Confirm activation completes and the existing approval tests still produce the same outcomes and audit records. Registration errors must fail activation instead of selecting a full-log fallback.
