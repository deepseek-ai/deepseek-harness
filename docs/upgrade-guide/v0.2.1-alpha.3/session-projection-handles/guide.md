---
kind: upgrade-guide
description: "Session projection registration is asynchronous and returns a retained reader instead of a disposer."
---
# Session projection registration handles

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-session-projection` changes `SessionProjectionRegistry.register(definition)` from a synchronous disposer to `Promise<ProjectionHandle<S>>`. Registry-level `stateOf(session, key)` and `SessionProjectionStateMap` are removed. Host state types stay local to `ProjectionDefinition<K, S>` and are inferred from `stateSchema` during registration. Registration errors now reject the returned promise. After the last registration is disposed, the unit leaves snapshots, checkpoints, and live notifications, but retained handles can still fold Session events on demand.

`@deepseek-ai/dsh-agent` and `@deepseek-ai/dsh-subagent` require `sessionProjections`. AgentRegistry owns turn and step state; consumers use `ctx.agents.turnBoundaryOf(session)` instead of importing `turnBoundaryProjectionDefinition`. Turn-state consumers, including the Claude Code mods bridge, require `agents`. Preset and context-pressure reads use `ctx.agentPresets.presetForSession(session)` and `ctx.tokenMeter.contextPressure(session)`. The API controller and mods bridge no longer register those definitions independently; their optional-service behavior applies when the owning service is absent. `@deepseek-ai/dsh-api-session-controller` also removes `installModelSelectionProjection`.

## Migration

1. Mount `SessionProjectionRegistry` before `AgentRegistry`, `SubagentRuntime`, and other projection owners in custom compositions. Include `@deepseek-ai/dsh-agent` wherever a plugin requires `agents`. Consumers of domain data inject the owning service.
2. Remove host-state map augmentations and imports; pass the local state type as the second `ProjectionDefinition<K, S>` argument. Keep client-value declarations in `SessionProjectionMap`. For a plugin's own definitions, await `ctx.sessionProjections.register(definition)` in asynchronous `apply()` or `[Service.init]()` and retain the handle privately before publishing dependent operations. Keep existing function-plugin namespace exports.
3. Replace `registry.stateOf(session, key)` with a business service method for another domain, or `handle.stateOf(session)` inside the owner. Replace stored unregister callbacks with `handle.dispose`, which always returns `Promise<void>`, and await explicit disposal; fiber disposal still releases registrations automatically. Await registration when handling initialization failures.
4. Replace `installModelSelectionProjection(ctx)` with `await ctx.sessionProjections.register(modelSelectionProjection)`, importing the definition from `@deepseek-ai/dsh-api-session-controller/src/model-selection-projection.ts`.
5. Typecheck custom plugins, then verify activation, a Session state read, and owner disposal. A released reader remains usable, while the released unit disappears from new snapshots once its final registration is gone.
