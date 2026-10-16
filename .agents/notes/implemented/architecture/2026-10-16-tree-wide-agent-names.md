# Agent Note: Tree-wide agent names

Status: implemented

English | [中文](2026-10-16-tree-wide-agent-names.zh.md)

## Problem

Session ids identify executions durably but make model coordination difficult to read. Descriptions can repeat and cannot identify recipients. The user requires explicit, unique names for subagents and teammates, with `lead` reserved for the root.

## Decision

Keep Session ids for persistence and authorization. Model tools accept immutable names unique throughout one agent tree. The root catalog records all committed assignments: a named direct-child fact or a name-only descendant fact. The existing catalog projection owns both, while its wire view remains direct-child discovery. Local descriptors carry each child’s own name. Only pending reservations live in a root-scoped runtime Set; committed names survive settlement and restart.

This supersedes the name-free interface in [Agent Teams as subagents](2026-10-15-agent-teams-as-subagents.md). Its lineage authority and shared subagent lifecycle remain unchanged. Resolution never grants messaging, interruption, or task-assignment authority. Older unnamed descendants receive stable `legacy:<session-id>` addresses; Team assignment also accepts such addresses for active historical members.

## Alternatives considered

**Parent-local names.** Descendant discovery would require path-qualified names. One tree-wide namespace gives every caller the same address.

**Recyclable names.** Reuse could redirect queued or delayed work after the original agent settles. Retaining assignments keeps recipient identity stable.

**Separate root assignment events.** A catalog variant expresses registration without another event type or projection. Root registration avoids a traversal of historical descendants for ordinary name checks. Its cost is a second synchronous append for nested children: the parent discovery fact may survive a failed root registration. Discovery and cold resume check the root assignment before accepting such named children.

## Consequences

Creation requires a name and rejects duplicates before dispatch. Independent roots can reuse names. Tool results, initial child guidance, message prefixes, and settlement notices use names. Internal Session and task-owner ids stay stable. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-alpha.4/agent-team-subagents/guide.md) lists changed tool arguments and results.

## Testing

Name tests exercise concurrent duplicate rejection, failed-start release, nested-tree uniqueness, independent roots, root registration recovery, failed second writes, unavailable historical branches, repeated child identities, invalid durable assignments, and legacy lookup. Recorded Headless and SDK sessions cover creation, messages, listing, and completion notices; Team tests preserve historical assignment without granting message authority.
