---
kind: upgrade-guide
description: "Agent Teams uses the standard subagent tools and unique agent names; Team-specific creation, messaging, listing, interruption, and their configuration keys are removed."
---

# Agent Teams uses subagents and unique agent names

English | [中文](guide.zh.md)

## Change

The experimental Agent Teams plugins share agent creation, discovery, messaging, and interruption with subagents. Start a teammate with `subagent` or `subagent_fork`, give it a tree-wide unique `name`, describe its responsibility with `description`, and use its returned name for messages and task assignment. Descriptions may repeat and never identify a recipient.

- `spawn_teammate` and the Team-scoped `send_message`, `list_agents`, and `interrupt_agent` are removed. The standard control tools use `name`, not `agent_id` or `target`. Members of one root tree can message each other across branches by name; interruption remains ancestor-only.
- `list_agents` takes no arguments and lists the entire Team, including the root and caller. Remove scripted `scope` arguments. The root row uses `kind: root`; descendant rows use `kind: child`, with parent names and root-relative depth. Update consumers that expect `parent` or `sibling` rows. Discovery does not grant task-assignment authority.
- The Team profile no longer disables the subagent tools. Team adds only task tools, `wait_agent`, and collaboration guidance.
- `agent-team` rejects `maxMembers`, `maxMessageBytes`, and `disposalTimeoutMs`; `tool-agent-team` rejects `interrupt`, `freshProvider`, and `forkProvider`.
- `ctx.agentTeams` removes `spawnTeammate()`, `sendMessage()`, `interrupt()`, and `listMembers()`. Host task views retain `ownerId` Session identities; model-facing task results expose `ownerName`, and task `owner` arguments use names. The root agent is always `lead`.
- Historical Team roster and mailbox records remain readable. Names in those records are historical data and do not resolve message recipients or task owners. New catalog and descriptor records include names, which remain reserved after settlement; older unnamed children receive `legacy:<session-id>` addresses during discovery.

- Custom Team compositions must provide `sessionQuery` so task assignment can verify inactive descendants from persisted Sessions. Profiles built on `@deepseek-ai/dsh-base` already provide it.

## Migration

1. Remove the obsolete configuration keys and any patch rows that disable subagent tools solely for Team support.
2. Replace `spawn_teammate({ name, description, prompt, context })` with `subagent({ name, description, prompt })`, or `subagent_fork` for inherited conversation history. Choose a unique lower-case name with letters, digits, underscores, or hyphens; start with a letter. `lead` and `unowned` are reserved. Duplicate names fail before creation.
3. Use `send_message({ name, message })` and `interrupt_agent({ name })`. Discover all Team member names with `list_agents`.
4. Pass member names to task `owner` fields and read `ownerName` in tool results. Use `lead` for the root agent.
5. Replace removed service calls with `ctx.subagents.startActivation()`, `sendMessage()`, `interrupt()`, and `listChildren()`. Supply `name` to `startActivation()`; host control APIs still use Session ids. Creation and ordinary name lookup require a readable root catalog. A failed root registration leaves no usable named child; retry creation with the same name and a fresh child id. Start a Team-enabled profile and verify that a child's description appears in the Team panel and that a name-addressed message reaches it.
