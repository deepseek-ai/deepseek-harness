---
kind: upgrade-guide
description: Agent factory ownership parameters and registry tree queries are removed; subagent Activations own runtime tree membership.
---

# Subagent runtime ownership

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-agent` removes the create/resume runtime-owner parameter (`parentAgent` or `ownerAgent`), `AgentRegistry.isOwnedBy()`, `AgentRegistry.roots()`, and the owner argument of `enter()`. Direct factory creation no longer enrolls an Agent in a managed subagent tree. Custom factories no longer implement runtime tree ownership.

The subagent service resolves runtime membership from its existing Activations through `rootOf(agent)`. The Session format and Cordis context ownership of handles are unchanged.

## Migration

1. Create delegated work through `ctx.subagents.startActivation()` with a registered provider. Remove ownership parameters from direct `ctx.agents.create()` and `resume()` calls; these operations create independent runtime instances.
2. Use `ctx.agents.get(id)` and `list()` for live lookup. To select ordinary live Agents, filter `list()` by `agent.session.header.origin !== 'subagent'`; historical ordinary forks can still have `parentSession`.
3. Query the live tree root with `ctx.subagents.rootOf(agent)` and compare Agent objects, not only ids. Ordinary live Agents resolve to themselves; unmanaged delegated or stale instances throw `SubagentError` with code `UNAUTHORIZED`. Read `session.header.parentSession` for the direct creator; use durable subagent catalogs when traversing offline creation ancestors.
4. Update custom factory implementations to call `ctx.agents.enter(agent)` after setup. Retain caller-context disposal, initialization rollback, and exact-instance registration checks. Runtime tree membership is available after managed activation publication; `agent/created` runs before that point. Verify stale instances cannot reuse a disposed instance's ownership.
