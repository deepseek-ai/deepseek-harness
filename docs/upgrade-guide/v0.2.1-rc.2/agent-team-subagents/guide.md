---
kind: upgrade-guide
description: "Agent Teams uses the standard subagent tools and hierarchical names; Team-specific controls and their configuration keys are removed."
---

# Agent Teams uses subagents and hierarchical names

English | [中文](guide.zh.md)

## Change

New Sessions default off. Enable Team in the model menu or with `/team on`; `/team off` preserves tasks and subagents. Historical task boards remain enabled until explicitly disabled.

Subagent paths rooted at `lead` identify recipients; descriptions label responsibilities. Creation requires sibling-unique names.

- `spawn_teammate` and the Team-scoped `send_message`, `list_agents`, and `interrupt_agent` are removed. Control tools replace `target` with `name`. Members can message across branches of their root tree; interruption remains ancestor-only.
- `list_agents` takes no arguments and lists the entire tree. Remove scripted `scope` arguments. Rows use `kind: root` or `kind: child`; descendants include parent paths and root-relative depth. The root can assign tasks to itself or any discovered continuable descendant.
- Team adds four task tools, policy, and required identity. `wait_agent` moves to ordinary subagent controls and waits for the caller’s next-step inbox, including pending input. Status changes and unrelated inboxes do not wake it; `noProgress` is removed.
- `agent-team` rejects `maxMembers`, `maxMessageBytes`, and `disposalTimeoutMs`; `tool-agent-team` rejects `interrupt`, `freshProvider`, and `forkProvider`.
- `ctx.agentTeams` removes creation, messaging, interruption, roster, membership, and wait APIs. `TeamMembership` and `TeamMembers` are removed; use subagent root resolution and discovery. Service task ownership retains `ownerId`; model tool results use `ownerName`.
- Root closure closes the tree; member settlement preserves descendants. Messages restore only their target. Members obtain results explicitly.
- Cold resume uses saved presets and permissions. Missing presets fail restoration; historical targets without one use host composition plus descriptor overrides. Lifecycle dispatch uses the root scope while retaining the direct creator in `parentSessionId`. Browser continuation requires the root online; failure uses `subagent/delivery-unavailable`.
- Historical Team rosters and mailboxes remain readable; their names grant no recipient or task-owner authority. New child descriptors and parent catalog entries carry an optional `name` segment; historical unnamed children use `legacy:<session-id>` path segments.
- The Web Team panel shows tasks; subagent navigation browses members. Historical `agentTeam.members` remains decodable but grants no authority. After flush, task commits end all resident Agents’ active waits in the tree. Signals retain no unread state and start no agents; changes outside a wait cannot wake later waits.

## Migration

1. Remove obsolete configuration keys and patches disabling subagent tools solely for Team support.
2. Replace `spawn_teammate({ name, description, prompt, context })` with `subagent({ name, description, prompt })`; use `subagent_fork` to inherit conversation history. Save the returned path. `subagent_oar` also requires `name` and returns a path.
3. Use `send_message({ name, message })` and `interrupt_agent({ name })`; discover member paths with `list_agents`.
4. Task `owner` fields accept paths; results expose `ownerName`. Use `lead` for the root. Host APIs retain Session ids.
5. Replace removed services with `ctx.subagents`. Verify member navigation, nested-descendant assignment, and task-board wakeups during active waits. Re-read tasks after waiting.
6. To retain automatic enablement, set `agent-team.config.enabledByDefault: true`. Verify the menu and task tools in a new Session.
