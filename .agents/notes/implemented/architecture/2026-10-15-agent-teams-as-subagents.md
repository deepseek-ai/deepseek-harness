# Agent Note: Agent Teams teammates are subagents

Status: implemented

English | [中文](2026-10-15-agent-teams-as-subagents.zh.md)

The adjacency and parent-lifetime restrictions are superseded by [tree-wide communication](2026-10-16-tree-wide-agent-communication.md). [Task-board inbox coordination](2026-10-19-team-task-board-inbox.md) supersedes the separate roster and Team-owned wait; the single subagent identity decision remains active.

## Problem

Teammates already use the subagent runtime for creation, Session identity, catalog membership, capacity, cold resume, settlement, and interruption. A separate Team roster duplicates identity, provisioning recovery, and teardown. Team-scoped messaging and control tools shadow the standard subagent tools, forcing profiles to disable ordinary delegation and making fork tool schemas diverge from their parent.

## Decision

Use one subagent identity: the Session id. The existing `description` tool argument supplies the catalog label and display text; descriptions may repeat and never address an agent. Creation accepts no member name, reserves no names, and adds no catalog payload version.

[Tree-wide communication](2026-10-16-tree-wide-agent-communication.md) authorizes an exact live sender within one root tree and preserves the actual sender’s id. Interruption retains ancestor authority and id addressing.

Every root Agent and its descendants form the Team identified by the root Session id. Team creates no agents and contributes task tools and task policy. Ordinary subagent controls supply required identity, discovery, messaging, interruption, and inbox waiting. Parent and fork children receive identical tool schemas and shared policies.

Task ownership uses `ownerId`; root reassignment accepts itself or any reachable continuable descendant. Historical roster records remain decode-only. Team persists task changes without ending inbox waits or starting idle turns; [inbox-only waiting](../simplification/2026-10-29-inbox-only-agent-wait.md) owns wake behavior. Historical `team/message/*` records remain readable but are never delivered or acknowledged.

This supersedes the roster, provisioning, recovery, and messaging decisions in [Agent Teams](../feature/2026-08-05-agent-teams.md) and the [Team direct inbox decision](../../archived/simplification/2026-09-26-team-direct-inbox.md). The task-board and shared-checkout decisions remain active. [Adjacent Agent messaging](2026-08-27-adjacent-agent-steer-messaging.md) includes sibling routing, while [required runtime-context identity](2026-10-13-team-identity-runtime-context.md) owns the role statement. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.2/agent-team-subagents/guide.md) lists removed tools, methods, and configuration.

## Alternatives considered

**Separate Team authority and tools.** This retains a second roster and recovery lifecycle for Agents already owned by the subagent runtime, plus same-name tools and a private delivery adapter. The shared parent relation supplies the required authority.

**Unique names as sibling-routing opt-in.** Names add validation, reservation, persistence, and ambiguous resolution beside existing Session ids. Descriptions already explain responsibilities; stable ids distinguish repeated descriptions without another identity system.

**Pluggable address books.** A registry would support groups spanning unrelated parents but add another authorization input. No current consumer needs this; revisit when collaboration must cross parent trees.

## Consequences

Tree members discover and message one another through ordinary controls. Team retains task ownership, dependencies, and task policy. Subagent capacity and lifecycle apply; failed starts create no Team roster row. Existing durable task generations remain unchanged.

Descendants at any depth share the board and can be task owners. Historical members grant no authority. Separate working directories remain explicit caller choices; cross-process task coordination is unsupported.

## Testing

Verification covers tree delivery and cold resume with actual sender attribution, task CAS and owner discovery, historical decoding, inbox wait isolation, and registration disposal. Recorded sessions cover Team policy and identity, plus ordinary subagent return guidance.
