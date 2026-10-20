---
kind: upgrade-guide
description: "Session projection registration resolves asynchronously to a retained reader; the callable result and registry-level state reads are deprecated."
---
# Session projection registration handles

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-session-projection` changes `SessionProjectionRegistry.register(definition)` from a synchronous disposer to `Promise<ProjectionHandle<S>>`. The definition installs synchronously; awaiting the result yields a handle with `stateOf(session)` and `dispose()`, and registration errors reject it. The runtime value is a callable thenable, not a native Promise: calling it still releases the registration, but that call is deprecated. `typeof registration` is `"function"` and `registration instanceof Promise` is false, so code that branches on those checks or treats functions as callbacks is affected; Vitest's `.rejects` calls it instead of observing the rejection.

Registry-level `stateOf(session, key): unknown` is deprecated. It returns `undefined` whenever no plugin currently registers the key: its owner is not composed, has not reached registration, or has released its last registration. `SessionProjectionStateMap` is removed; host state types stay local to `ProjectionDefinition<K, S>` and are inferred from `stateSchema`. After the last registration is disposed, the unit leaves snapshots, checkpoints, and live notifications, but retained handles still fold Session events on demand. [Runtime compatibility](../../../../packages/session/session-projection/README.md#deprecated-plugin-compatibility) details the deprecated calls.

`@deepseek-ai/dsh-agent` and `@deepseek-ai/dsh-subagent` require `sessionProjections`. AgentRegistry owns turn and step state and provides `ctx.agents.turnBoundaryOf(session)`; `@deepseek-ai/dsh-agent-loop` no longer exports `turnBoundaryProjectionDefinition`. Turn-state consumers, including the Claude Code mods bridge, require `agents`. Preset and context-pressure reads use `ctx.agentPresets.presetForSession(session)` and `ctx.tokenMeter.contextPressure(session)`. The API controller and mods bridge no longer register those definitions independently; their optional-service behavior applies when the owning service is absent. `@deepseek-ai/dsh-api-session-controller` removes `installModelSelectionProjection`.

## Migration

1. Mount `SessionProjectionRegistry` before `AgentRegistry`, `SubagentRuntime`, and other projection owners in custom compositions. Include `@deepseek-ai/dsh-agent` wherever a plugin requires `agents`.
2. For a plugin's own definitions, await `ctx.sessionProjections.register(definition)` in asynchronous `apply()` or `[Service.init]()` and retain the handle before publishing dependent operations. Remove `SessionProjectionStateMap` augmentations and pass the state type as the second `ProjectionDefinition<K, S>` argument. Keep client-value declarations in `SessionProjectionMap`.
3. Replace `registry.stateOf(session, key)` with the owning service's method, such as `ctx.agents.turnBoundaryOf(session)`, or `handle.stateOf(session)` inside the owner; until then, handle its `undefined` result. Replace calls to the registration result with an awaited `handle.dispose()`; fiber disposal still releases registrations automatically.
4. Where a native Promise is required, pass `Promise.resolve(registration)`, including `await expect(Promise.resolve(registration)).rejects.toThrow(...)` in Vitest. Replace `typeof` or `instanceof Promise` checks on the result with awaiting.
5. Replace `installModelSelectionProjection(ctx)` with `await ctx.sessionProjections.register(modelSelectionProjection)`, importing the definition from `@deepseek-ai/dsh-api-session-controller/src/model-selection-projection.ts`.
6. Typecheck custom plugins, then verify activation, a Session state read, a rejected registration, and owner disposal.
