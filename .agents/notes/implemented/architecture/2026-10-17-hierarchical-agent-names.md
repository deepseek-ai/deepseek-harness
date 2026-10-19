# Agent Note: Hierarchical agent names

Status: implemented

English | [中文](2026-10-17-hierarchical-agent-names.zh.md)

## Problem

Session ids are durable execution identities but difficult to read in model coordination. Descriptions may repeat. Flat tree-wide names require every parent to coordinate reservations and publish descendant assignments in the root, introducing a second Session write and incomplete-registration recovery.

## Decision

Keep Session ids for persistence and authorization. Each child has an immutable name segment unique among its direct siblings. Model tools return and accept full paths rooted at `lead`, such as `lead/reviewer` and `lead/explore/alice`. Parent catalogs already record the required relationships; local descriptors retain the child’s segment. Path lookup reads only intermediate parent catalogs. Temporary reservations belong to the exact live parent and reject concurrent sibling duplicates before provider dispatch. A parent catalog append commits creation, and committed names survive settlement and restart.

This consolidates the tree-wide naming decision and supersedes the name-free interface in [Agent Teams as subagents](2026-10-15-agent-teams-as-subagents.md). Its lineage authority and shared subagent lifecycle remain current. Resolution grants no messaging, interruption, or assignment authority. Historical unnamed children use `legacy:<session-id>` segments; historical Team members without a catalog grant no assignment authority.

## Alternatives considered

**Flat tree-wide names.** Short addresses are convenient and root registration avoids intermediate catalog reads. That convenience requires shared name admission, a root assignment record, and recovery when the parent write succeeds but root registration fails. Paths give every caller the same unambiguous address while reusing parent-owned records. Reintroducing a flat namespace would require a demonstrated need for globally unique short aliases that outweighs these costs.

**Recyclable names.** Reuse could redirect delayed work after the original agent settles. Retaining assignments keeps recipient identity stable.

**Checking only before asynchronous startup.** Two concurrent sibling creations could both pass. Parent-local temporary reservations prevent duplicate external work before it starts; failed creation releases the reservation.

## Consequences

Creation takes one segment; tool results, child guidance, message prefixes, task owners, and settlement notices use full paths. Different parents and independent roots can reuse segments. Cold path lookup depends on intermediate catalogs, but not unrelated branches. A failed parent catalog append can leave a local descriptor; a named child cannot resume without its matching parent entry. Internal Session and task-owner ids stay stable. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.2/agent-team-subagents/guide.md) describes caller changes.

## Testing

Focused tests cover same-name children in separate branches, concurrent sibling rejection before dispatch, failed-start release, parent catalog failure, restoration, fork isolation, legacy paths, and ambiguous persisted names. Recorded Headless and SDK sessions cover creation, nested paths, messages, listing, and completion notices; Team tests reject historical membership as assignment or message authority.
