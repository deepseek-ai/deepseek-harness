# Agent Note: Agent Teams teammates are subagents

Status: implemented

English | [中文](2026-10-15-agent-teams-as-subagents.zh.md)

The name-free model interface below is superseded by [tree-wide agent names](2026-10-16-tree-wide-agent-names.md). Session identity, lineage authority, and Team reuse remain current.

## Problem

Teammates already use the subagent runtime for creation, Session identity, catalog membership, capacity, cold resume, settlement, and interruption. A separate Team roster duplicates identity, provisioning recovery, and teardown. Team-scoped messaging and control tools shadow the standard subagent tools, forcing profiles to disable ordinary delegation and making fork tool schemas diverge from their parent.

## Decision

Use one subagent identity: the Session id. The existing `description` tool argument supplies the catalog label and display text; descriptions may repeat and never address an agent. Creation accepts no member name, reserves no names, and adds no catalog payload version.

An exact live sender may message a direct continuable child. A resident continuable child may additionally message its direct parent or continuable siblings by id. Sibling delivery uses the shared live parent’s child authority and cold resume; the message retains the actual sender’s id. `list_agents` exposes parent and sibling ids. Interruption keeps ancestor authority and id addressing.

Every root Agent leads the Team identified by its Session id; every live subagent below it shares the task board and waits. The roster projects the root, its direct continuable catalog children, and historical `team/member` records. Team creates no agents and registers no messaging, listing, or interruption tools. The Team profile only adds rows. Parent and fork children receive identical Team policies and tool schemas, with role identity in required runtime context.

Task ownership uses `ownerId`, and reassignment accepts a Session id. Team persists only task changes. Messages use the target Agent inbox; historical `team/message/*` records remain readable but are never delivered or acknowledged.

This supersedes the roster, provisioning, recovery, and messaging decisions in [Agent Teams](../feature/2026-08-05-agent-teams.md) and the [Team direct inbox decision](../../archived/simplification/2026-09-26-team-direct-inbox.md). The task-board and shared-checkout decisions remain active. [Adjacent Agent messaging](2026-08-27-adjacent-agent-steer-messaging.md) includes sibling routing, while [required runtime-context identity](2026-10-13-team-identity-runtime-context.md) owns the role statement. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-alpha.4/agent-team-subagents/guide.md) lists removed tools, methods, and configuration.

## Alternatives considered

**Separate Team authority and tools.** This retains a second roster and recovery lifecycle for Agents already owned by the subagent runtime, plus same-name tools and a private delivery adapter. The shared parent relation supplies the required authority.

**Unique names as sibling-routing opt-in.** Names add validation, reservation, persistence, and ambiguous resolution beside existing Session ids. Descriptions already explain responsibilities; stable ids distinguish repeated descriptions without another identity system.

**Pluggable address books.** A registry would support groups spanning unrelated parents but add another authorization input. No current consumer needs this; revisit when collaboration must cross parent trees.

## Consequences

Ordinary continuable siblings can discover and message one another. Team retains task ownership, dependencies, waits, policy, and role identity. Its member and message-size limits and Team-owned teardown disappear; subagent capacity and lifecycle apply. Failed starts leave no Team roster row. No new Session payload generation is required, and historical member names remain decode-only data.

Deeper descendants share tasks and waits but are not roster rows; their message routes remain limited to their own parent, children, and continuable siblings. Separate working directories and cross-process coordination remain unsupported.

## Testing

Verify sibling delivery and cold resume with actual sender attribution and repeated descriptions; reject unrelated targets. Verify Team lineage, inherited catalog isolation, historical reads, task CAS, waits, and registration disposal. Recorded Team sessions and the headless profile exercise the complete model-facing workflow and parent/fork request-prefix equality.
