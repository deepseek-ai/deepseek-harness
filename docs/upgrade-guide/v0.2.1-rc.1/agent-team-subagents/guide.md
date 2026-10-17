---
kind: upgrade-guide
description: "Agent Teams uses the standard subagent tools and Session ids; Team-specific creation, messaging, listing, interruption, and their configuration keys are removed."
---

# Agent Teams uses subagents and Session ids

English | [中文](guide.zh.md)

## Change

The experimental Agent Teams plugins share agent creation, discovery, messaging, and interruption with subagents. Start a teammate with `subagent` or `subagent_fork`, describe its responsibility with `description`, and use its returned agent id for messages and task assignment. Descriptions may repeat and never identify a recipient.

- `spawn_teammate` and the Team-scoped `send_message`, `list_agents`, and `interrupt_agent` are removed. The standard control tools use `agent_id`, not `target`. Members of one root tree can message each other across branches by id; interruption remains ancestor-only.
- `list_agents` takes no arguments and lists the entire Team, including the root and caller. Remove scripted `scope` arguments. The root row uses `kind: root`; descendant rows use `kind: child`, with parent ids and root-relative depth. Update consumers that expect `parent` or `sibling` rows. Discovery does not grant task-assignment authority.
- The Team profile no longer disables the subagent tools. Team adds only task tools, `wait_agent`, and collaboration guidance.
- `agent-team` rejects `maxMembers`, `maxMessageBytes`, and `disposalTimeoutMs`; `tool-agent-team` rejects `interrupt`, `freshProvider`, and `forkProvider`.
- `ctx.agentTeams` removes `spawnTeammate()`, `sendMessage()`, `interrupt()`, and `listMembers()`. Task views expose `ownerId` instead of `ownerName`; task ownership uses Session ids, including the Lead's id.
- Historical Team roster and mailbox records remain readable. Names in those records are historical data and do not resolve message recipients or task owners. Subagent catalog payloads are unchanged.

## Migration

1. Remove the obsolete configuration keys and any patch rows that disable subagent tools solely for Team support.
2. Replace `spawn_teammate({ name, description, prompt, context })` with `subagent({ description, prompt })`, or `subagent_fork` for inherited conversation history. Save the returned agent id.
3. Use `send_message({ agent_id, message })` and `interrupt_agent({ agent_id })`. Discover all Team member ids with `list_agents`.
4. Pass member Session ids to task `owner` fields and read `ownerId` in results. Use the Lead's Session id instead of the alias `lead`.
5. Replace removed service calls with `ctx.subagents.startActivation()`, `sendMessage()`, `interrupt()`, and `listDescendants(ctx.subagents.rootOf(caller).id)`. Start a Team-enabled profile and verify that a child's description appears in the Team panel and that an id-addressed message reaches it.
