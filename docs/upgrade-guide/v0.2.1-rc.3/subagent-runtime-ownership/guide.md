---
kind: upgrade-guide
description: Agent factory ownership parameters and registry tree queries are removed in favor of managed subagent lineage.
---

# Subagent runtime ownership

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-agent` removes the create/resume runtime-owner parameter (`parentAgent` or `ownerAgent`), `AgentRegistry.isOwnedBy()`, `AgentRegistry.roots()`, and the owner argument of `enter()`. Direct factory creation no longer enrolls an Agent in a managed subagent tree. Custom factories no longer implement runtime tree ownership.

The subagent service binds local instances during setup, before `agent/created`. `lineageOf(agent)` returns the exact live root and verified creation ancestor ids for a managed local instance, or `undefined` for ordinary, unmanaged, or stale instances. The Session format and Cordis context ownership of handles are unchanged.

## Migration

1. Create delegated work through `ctx.subagents.startActivation()` with a registered provider. Remove ownership parameters from direct `ctx.agents.create()` and `resume()` calls; these operations create independent runtime instances.
2. Use `ctx.agents.get(id)` and `list()` for live lookup. To select ordinary live Agents, filter `list()` by `agent.session.header.origin !== 'subagent'`; historical ordinary forks can still have `parentSession`.
3. Query managed ownership with `ctx.subagents.lineageOf(agent)?.root` and compare Agent objects, not only ids. Use `rootOf(agent)` when an unavailable caller or owner must reject. Read `lineageOf(agent)?.ancestors` for intermediate creators; the runtime root is not necessarily the direct creator.
4. Update custom factory implementations to call `ctx.agents.enter(agent)` after setup. Retain caller-context disposal, initialization rollback, and exact-instance registration checks. Verify delegated callbacks see lineage during `agent/created` and cannot reuse a disposed instance's ownership.
