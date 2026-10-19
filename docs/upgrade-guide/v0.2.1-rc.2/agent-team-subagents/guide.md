---
kind: upgrade-guide
description: "Agent Teams uses the standard subagent tools and Session ids; Team-specific creation, messaging, listing, interruption, and their configuration keys are removed."
---

# Agent Teams uses subagents and Session ids

English | [中文](guide.zh.md)

## Change

The experimental Agent Teams plugins use standard subagent tools and Session ids. Descriptions label responsibilities; repeated descriptions never identify recipients.

- `spawn_teammate` and the Team-scoped `send_message`, `list_agents`, and `interrupt_agent` are removed. The standard control tools use `agent_id`, not `target`. Members of one root tree can message each other across branches by id; interruption remains ancestor-only.
- `list_agents` takes no arguments and lists the entire tree. Remove scripted `scope` arguments. Rows use `kind: root` or `kind: child`; descendants include parent ids and root-relative depth. The root can assign tasks to itself or any discovered continuable descendant.
- Team adds four task tools and task policy. `wait_agent` moves to ordinary subagent controls and waits for the caller’s next-step inbox, including pending input. Status changes and unrelated inboxes do not wake it; `noProgress` is removed. Timeout bounds and default are unchanged.
- `agent-team` rejects `maxMembers`, `maxMessageBytes`, and `disposalTimeoutMs`; `tool-agent-team` rejects `interrupt`, `freshProvider`, and `forkProvider`.
- `ctx.agentTeams` removes creation, messaging, interruption, roster, membership, and wait APIs. `TeamMembership` and `TeamMembers` are removed; use subagent root resolution and discovery. Task ownership uses `ownerId`, including the root’s Session id.
- Runtime instances share root ownership without changing creation ancestry. Member settlement does not dispose descendants. Messages restore only their target. Hosts close the tree when its root closes; members obtain required results explicitly.
- Cold resume uses saved presets and permissions, not the creator’s current generation. Missing presets fail restoration; historical targets without one use host composition plus descriptor overrides. Lifecycle dispatch uses the root scope while retaining the direct creator in `parentSessionId`. Browser continuation requires the root online; failure uses `subagent/delivery-unavailable`.
- Historical Team roster and mailbox records remain readable. Historical names do not resolve message recipients or task owners. Subagent catalog payloads are unchanged.
- The Web Team panel shows tasks only; ordinary subagent navigation owns member browsing. Historical `agentTeam.members` remains decodable but grants no authority. Task commits send coalesced non-waking notices only to live local peers. `TEAM_TASK_NOTIFICATION_FAILED` reports `committedTask` and `failedRecipients`; the mutation is already committed.

## Migration

1. Remove the obsolete configuration keys and any patch rows that disable subagent tools solely for Team support.
2. Replace `spawn_teammate({ name, description, prompt, context })` with `subagent({ description, prompt })`, or `subagent_fork` for inherited conversation history. Save the returned agent id.
3. Use `send_message({ agent_id, message })` and `interrupt_agent({ agent_id })`. Discover all Team member ids with `list_agents`.
4. Pass member Session ids to task `owner` fields and read `ownerId` in results. Use the Lead's Session id instead of the alias `lead`.
5. Replace removed service calls with `ctx.subagents` operations. Supply `systemPrompt` to `tool-subagent-control`. Replace `TEAM_IDENTITY` context order with `SUBAGENT_IDENTITY`. Verify member navigation, assignment to a nested descendant, and task notices. On notification failure, read `committedTask` before recovery; never blindly retry creation.
