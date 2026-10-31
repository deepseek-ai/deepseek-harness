---
kind: upgrade-guide
description: "Subagent user controls address only the target Session, rename the interrupt endpoint, and require target Session permissions instead of global permissions."
---

# Subagent user controls address the target Session

English | [中文](guide.zh.md)

## Change

Browser and custom Remote callers send subagent prompts without `parentSessionId` or `mode`. `subagents/interruptByParent(childSessionId, parentSessionId, mode)` is replaced by `subagents/interruptByUser(childSessionId)`. Creation ancestry, history addresses, completion recipients, and persisted Session data are unchanged.

Both operations name the child as a `session` access resource. Non-owner policies must grant the corresponding action on that Session; a `global` binding or a binding on its parent does not grant access. Owner behavior is unchanged. Model messages remain limited to one subagent tree, and model interruption remains ancestor-only.

The same-process `SubagentInterruptAuthority` user variant is `{ kind: 'user' }`. The published `@deepseek-ai/dsh-subagent/internal` entry point is removed, including its host prompt adapters and tool identity markers. Remote authorization is performed by the Gateway.

Old prompt payloads with extra fields inside `request` can decode on the new Host, subject to its new access rules. Old interrupt calls fail because the endpoint is removed. New callers require the new Host. Upgrade custom clients and hosts together; the bundled Web client is delivered with its Host.

## Migration

1. Remove `parentSessionId` and `mode` from subagent prompt requests. Keep `childSessionId`, `requestId`, `delivery`, `content`, and optional `clientTimeZone`.
2. Replace calls to `interruptByParent(childId, parentId, 'continuable')` with `interruptByUser(childId)`.
3. Update non-owner policies to grant `subagents/prompt` and/or `subagents/interruptByUser` on `{ kind: 'session', id: childId }`. Parent-to-child grants remain an explicit policy decision.
4. Remove `parentSessionId` from `{ kind: 'user' }` interrupt authorities. Replace imports from `@deepseek-ai/dsh-subagent/internal`: authenticated user prompts use `subagents/prompt`; model-authored messages use `ctx.subagents.sendMessage()`. There is no public arbitrary-source host prompt adapter. Custom tools own their instructions through tool descriptions and `systemPrompt.context()`, without identity markers. Keep parent ids in history addresses and creation records.
5. Verify that a target-authorized user can send and interrupt, while a user authorized only for the parent or global resource is refused before any input or cancellation is admitted.
