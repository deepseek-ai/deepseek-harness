---
kind: upgrade-guide
description: "Agent Teams uses the standard subagent tools and hierarchical names; Team-specific creation, messaging, listing, interruption, and their configuration keys are removed."
---

# Agent Teams uses subagents and hierarchical names

English | [中文](guide.zh.md)

## Change

Full paths rooted at `lead` identify recipients; descriptions label responsibilities. Creation accepts an optional sibling-unique name segment; omission selects the first unused `agent-N`, starting at `agent-1`.

- `spawn_teammate` and the Team-scoped `send_message`, `list_agents`, and `interrupt_agent` are removed. The standard control tools use `name`, not `target`. Members can message across branches of their root tree; interruption remains ancestor-only.
- `list_agents` takes no arguments and lists the entire tree. Remove scripted `scope` arguments. Rows use `kind: root|child|diagnostic`; descendants include parent paths and root-relative depth. The root can assign tasks to itself or any discovered continuable descendant.
- Team adds four task tools, policy, and required identity. `wait_agent` moves to ordinary subagent controls and waits for the caller’s next-step inbox, including pending input. Status changes and unrelated inboxes do not wake it; `noProgress` is removed. Timeout bounds and default are unchanged.
- `agent-team` rejects `maxMembers`, `maxMessageBytes`, and `disposalTimeoutMs`; `tool-agent-team` rejects `interrupt`, `freshProvider`, and `forkProvider`.
- `ctx.agentTeams` removes creation, messaging, interruption, roster, membership, and wait APIs. `TeamMembership`, `TeamMemberView`, spawn/send types, and `TeamWaitResult` are removed; use subagent root resolution and discovery. Service task ownership retains `ownerId`; model tool results use `ownerName`.
- Runtime instances share root ownership; creation ancestry is unchanged. Member settlement does not dispose descendants. Messages restore only their target. Root closure closes the tree; members obtain results explicitly.
- Cold resume preserves saved presets and permissions; missing presets fail restoration. Lifecycle dispatch uses the root scope. Browser continuation requires the root online.
- Historical Team rosters and mailboxes remain readable; their names grant no recipient or task-owner authority. Parent catalog entries carry an optional `name` segment; historical unnamed children use `legacy:<session-id>` path segments.
- The Web Team panel shows tasks; subagent navigation browses members. Wire `agentTeam.members` and `TeamMemberProjection` are removed. Task commits end current waits across the tree; changes outside a wait cannot wake later waits.

## Migration

1. Move `tool-agent-team.interrupt: false` to `tool-subagent-control`. Remove other obsolete keys and patches disabling subagent tools solely for Team support.
2. Replace `spawn_teammate` with `subagent({ name, description, prompt })`, or `subagent_fork` to inherit history. Save the returned path. `subagent_oar` also accepts optional `name`.
3. Use `send_message({ name, message })` and `interrupt_agent({ name })`; discover paths with `list_agents`. Read child task descriptions from `description`, replacing `label`.
4. Task `owner` accepts paths; results expose `ownerName`. The root is `lead`. Host operations retain Session ids; `startActivation()` accepts optional `name`, returning `activation.name` and `childId`.
5. All activations enter the parent catalog, including external `delivery: 'caller'` work. Discovery and the Web child list include them; delivery only controls result routing. Check scripts counting children.
6. Replace removed services with `ctx.subagents`. SDK `session/resume` rejects subagent Sessions; resume the root. Verify navigation, task assignment and active-wait wakeups; re-read tasks after waiting.
