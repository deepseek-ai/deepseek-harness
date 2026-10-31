---
kind: upgrade-guide
description: "Agent Teams uses the standard subagent tools and Session ids; Team-specific creation, messaging, listing, interruption, and their configuration keys are removed."
---

# Agent Teams uses subagents and Session ids

English | [中文](guide.zh.md)

## Change

Descriptions label responsibilities; only Session ids identify recipients.

- `spawn_teammate` and the Team-scoped `send_message`, `list_agents`, and `interrupt_agent` are removed. The standard control tools use `agent_id`, not `target`. Members of one root tree can message each other across branches by id; interruption remains ancestor-only.
- `list_agents` takes no arguments and lists the entire tree. Remove scripted `scope` arguments. Rows use `kind: root`, `kind: child`, or `kind: diagnostic`; descendants include parent ids and root-relative depth.
- Team supplies four task tools and policy; controls supply required identity. `wait_agent` moves to ordinary subagent controls and waits for the caller’s next-step inbox, including pending input. Status changes and unrelated inboxes do not wake it; `noProgress` is removed. Timeout bounds/default remain unchanged.
- `agent-team` rejects `maxMembers`, `maxMessageBytes`, and `disposalTimeoutMs`; `tool-agent-team` rejects `interrupt`, `freshProvider`, and `forkProvider`.
- `ctx.agentTeams` removes creation, messaging, interruption, roster, membership, and wait APIs. `TeamMembership`, `TeamMemberView`, spawn/send request/result types, and `TeamWaitResult` are removed. Task ownership uses `ownerId`, including the root’s Session id.
- Runtime instances share root ownership without changing creation ancestry. Member settlement does not dispose descendants. Messages restore only their target. Hosts close the tree when its root closes; members obtain required results explicitly.
- Cold resume uses saved presets and permissions, not the creator’s current generation. Missing presets fail restoration; historical targets without one use host composition plus descriptor overrides. Lifecycle dispatch uses the root scope while retaining the direct creator in `parentSessionId`. Browser continuation requires the root online; failure uses `subagent/delivery-unavailable`.
- Historical Team roster and mailbox records remain readable. Historical names do not resolve message recipients or task owners. Subagent catalog payloads are unchanged.
- The Web Team panel shows tasks only; subagent navigation owns member browsing. The wire `agentTeam.members` field and `TeamMemberProjection` are removed; persisted roster state still decodes. Task commits do not end waits, deliver messages, or start idle Agents. Message another Agent when it needs to act on task changes.

## Migration

1. Move `interrupt: false` from `tool-agent-team` to `tool-subagent-control`. Remove other obsolete keys and any patch rows that disable subagent tools solely for Team support.
2. Replace `spawn_teammate({ name, description, prompt, context })` with `subagent({ description, prompt })`, or `subagent_fork` for inherited conversation history. Save the returned agent id.
3. Use `send_message({ agent_id, message })` and `interrupt_agent({ agent_id })`. Discover all Team member ids with `list_agents`.
4. Pass member Session ids to task `owner` fields and read `ownerId` in results. Use the Lead's Session id instead of the alias `lead`.
5. Replace `spawnTeammate`, `sendMessage`, and `interrupt` with `ctx.subagents.startActivation`, `sendMessage`, and `interrupt`. Replace `membership`/`tryMembership` with `rootOf`, and `listMembers` with `listDescendants`. Replace `waitForChange` with `wait_agent`, then re-read tasks.
6. SDK `session/resume` rejects subagent sessions. Resume the root Session instead. Verify navigation, nested task assignment, and that messages end inbox waits while task commits do not.
