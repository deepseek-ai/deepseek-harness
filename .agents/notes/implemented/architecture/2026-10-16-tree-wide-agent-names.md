# Agent Note: Tree-wide agent names

Status: implemented

English | [中文](2026-10-16-tree-wide-agent-names.zh.md)

## Problem

Session ids identify executions durably but make model coordination difficult to read. Descriptions can repeat and cannot identify recipients. The user requires explicit, unique names for subagents and teammates, with `lead` reserved for the root.

## Decision

Keep Session ids for persistence and authorization. Model tools accept immutable names unique throughout one agent tree. A root-owned `subagent/named` event records each successful assignment; the projection excludes fork-inherited facts. The manager reserves names before asynchronous preparation and releases failed unpublished reservations. Committed names remain taken after settlement so delayed messages cannot reach a different agent.

This supersedes the name-free interface in [Agent Teams as subagents](2026-10-15-agent-teams-as-subagents.md). Its lineage authority and shared subagent lifecycle remain unchanged. Resolution never grants messaging, interruption, or task-assignment authority. Older unnamed descendants receive stable `legacy:<session-id>` addresses; Team assignment also accepts such addresses for active historical members.

## Alternatives considered

**Parent-local names.** Descendant discovery would require path-qualified names. One tree-wide namespace gives every caller the same address.

**Recyclable names.** Reuse could redirect queued or delayed work after the original agent settles. Retaining assignments keeps recipient identity stable.

**A second committed registry.** The root projection already reconstructs assignments after restart. A second cache would require synchronization and recovery; only unpublished reservations need separate state.

## Consequences

Creation requires a name and rejects duplicates before dispatch. Independent roots can reuse names. Tool results, initial child guidance, message prefixes, and settlement notices use names. Internal Session and task-owner ids stay stable. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-alpha.4/agent-team-subagents/guide.md) lists changed tool arguments and results.

## Testing

Name tests exercise concurrent duplicate rejection, failed-start release, nested-tree uniqueness, independent roots, retained projection state, invalid durable assignments, and legacy lookup. Recorded Headless and SDK sessions cover creation, messages, listing, and completion notices; Team tests preserve historical assignment without granting message authority.
