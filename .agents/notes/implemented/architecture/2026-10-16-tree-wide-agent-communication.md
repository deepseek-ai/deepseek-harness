# Agent Note: Communication follows the subagent tree

Status: implemented

English | [中文](2026-10-16-tree-wide-agent-communication.zh.md)

## Problem

A Team shares one task board across the root's entire subagent tree. Restricting discovery and messages to adjacent relatives forces deeper members to relay work through parents despite sharing tasks.

## Decision

`list_agents` starts at the caller's live root and lists that root and all reachable continuable descendants, including the caller. Full names remain relative to the root. The existing parent catalogs remain authoritative; no Team directory is stored separately.

`send_message` accepts another root or continuable member of the same tree. The sender must be the exact live root or a resident continuable subagent. Cross-branch delivery verifies the target descriptor and creation catalogs, then restores only the target under the Team root. Final inbox admission rechecks the sender and root. Cancellation or rejection before acceptance releases the new target instance; accepted input follows normal Agent persistence.

The existing Agent registry records runtime ownership by the Team root. Creation parent ids and catalogs preserve ancestry for discovery and interrupt authority. A member finishing or being released affects only its own instance; Team-root shutdown joins all startup and cleanup. This removes ancestor restoration, parent retention, and recursive disposal without adding a Team runtime registry. Saved target presets and permission events supply restoration configuration.

This supersedes the adjacency, discovery, and parent-lifetime restrictions in [adjacent messaging](2026-08-27-adjacent-agent-steer-messaging.md) and [subagent teammates](2026-10-15-agent-teams-as-subagents.md). Their shared inbox, scheduling, attribution, and Team reuse decisions remain active. Members address one another by the names that [catalog names](2026-11-02-subagent-catalog-names.md) define, or by Session id; ordinary Session forks lead independent Teams.

## Alternatives considered

**Relay through parents.** This preserves the narrower routing implementation but makes the creation hierarchy determine who can collaborate. Shared work requires direct communication across branches.

**Separate Team directory and delivery.** A second member list and message path would duplicate the existing catalogs, inbox, and restoration lifecycle. Tree membership supplies the required communication scope without another registry.

## Consequences

Discovery output grows with the whole tree. Cold delivery requires one capacity slot and readable creation history. Intermediate creators may be offline. Completion notices reach only online creators, so work that requires descendant results must explicitly wait. Listing is a snapshot and does not promise that a later send succeeds. External and one-shot executions cannot receive follow-ups.
