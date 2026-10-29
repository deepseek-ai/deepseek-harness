---
kind: upgrade-guide
description: "Base-backed profiles address subagents by names in model-facing tools while host APIs retain Session ids."
---

# Subagent tools require the naming plugin

English | [中文](guide.zh.md)

## Change

Subagent tools require `@deepseek-ai/dsh-subagent-names`, which base-backed profiles mount by default. `subagent` and `subagent_fork` accept an optional sibling `name` and return `subagentId` plus a full `name` such as `lead/reviewer`. Omission allocates the first unused `agent-N`. `send_message` and `interrupt_agent` use the `name` argument, which accepts a discovered path or an existing member's Session id. `list_agents` adds names and parent paths to its ID fields. Experimental Team tools expose `ownerName`; the OAR tool also returns a name.

The subagent service, provider requests, Session catalog and SDK handles retain their existing ID interfaces. The message service resolves display names from the actual sender: `lead` for the root, a bound path for a named child, or the Session id when no name is available. Durable message sources and completion notices retain Session ids. The naming plugin records name-to-id bindings in the root Session after startup succeeds. A child can begin its first step before its name is bound. Delegation, control, experimental Team and OAR tools all require the naming service; unloading it removes their definitions.

## Migration

1. Update scripted model tool calls from `send_message({ agent_id: id, ... })` to `send_message({ name: id, ... })`, and from `interrupt_agent({ agent_id: id })` to `interrupt_agent({ name: id })`. Use the returned `name` for subsequent calls when available.
2. Read `name` alongside the existing ID from creation results and available names from discovery results, and `ownerName` from experimental Team task results. Keep existing host `startActivation`, `sendMessage`, `interrupt`, and `ownerId` calls unchanged.
3. In custom compositions using subagent tools, mount `@deepseek-ai/dsh-subagent-names` alongside the subagent service and Session projection service. The shipped base bundle supplies this plugin.
4. Create a child with `name: "reviewer"`, confirm the result is `lead/reviewer`, and confirm `list_agents` and a follow-up message resolve that path. Names remain reserved for the lifetime of the root Session.
