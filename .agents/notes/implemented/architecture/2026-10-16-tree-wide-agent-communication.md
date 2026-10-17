# Agent Note: Communication follows the subagent tree

Status: implemented

English | [中文](2026-10-16-tree-wide-agent-communication.zh.md)

## Problem

A Team shares one task board across the root's entire subagent tree. Restricting discovery and messages to adjacent relatives forces deeper members to relay work through parents despite sharing tasks.

## Decision

`list_agents` starts at the caller's live root and lists that root and all reachable continuable descendants, including the caller. Parent ids and depth remain relative to the root. The existing parent catalogs remain authoritative; no Team directory is stored separately.

`send_message` accepts another root or continuable member of the same tree. The sender must be the exact live root or a resident continuable subagent. Cross-branch routing preserves the actual sender, verifies durable child descriptors and parent catalogs, and restores cold ancestors under their recorded parents. Ancestor restoration does not deliver the target's message to those ancestors. Final inbox admission rechecks the sender and target parent. Cancellation or rejection before acceptance releases new restoration work; accepted input follows normal Agent persistence.

Parent ownership still governs capacity, restoration, and disposal. `interrupt_agent` retains ancestor-only authority. Ordinary Session forks lead independent trees; external and one-shot executions cannot receive follow-ups.

This supersedes only the adjacency and discovery restrictions in [adjacent messaging](2026-08-27-adjacent-agent-steer-messaging.md) and [subagent teammates](2026-10-15-agent-teams-as-subagents.md). Their shared inbox, scheduling, attribution, lifecycle, and Team reuse decisions remain active. Members use Session ids for addressing.

## Alternatives considered

**Relay through parents.** This preserves the narrower routing implementation but makes the creation hierarchy determine who can collaborate. Shared work requires direct communication across branches.

**Separate Team directory and delivery.** A second member list and message path would duplicate the existing catalogs, inbox, and restoration lifecycle. Tree membership supplies the required communication scope without another registry.

## Consequences

Discovery output grows with the whole tree. Cold delivery can consume several activation slots while restoring ancestors and rejects when capacity or history is unavailable. The sender's live ancestry must remain intact. Listing is a snapshot; it does not promise that a later send will succeed. Concurrent operations retain ordinary inbox acceptance and disposal ordering.
