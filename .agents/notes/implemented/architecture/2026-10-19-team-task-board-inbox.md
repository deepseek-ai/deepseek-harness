# Agent Note: Team task boards share ordinary subagent waits

Status: implemented

English | [中文](2026-10-19-team-task-board-inbox.zh.md)

## Problem

The subagent tree already supplies identity, discovery, routing, and lifecycle. A second Team roster can grant assignment authority from stale history and duplicates member navigation. Team-wide status waits observe unrelated activity and miss input already pending for the caller. Persisting task-board wakeups as messages adds unread state and message schemas even though the task journal already owns the state to inspect.

## Decision

The subagent tree is the Team. Ordinary controls own required identity, communication, discovery, interruption, and `wait_agent`, independently of the optional task board. Team tools own task policy, without adding it to ordinary subagent compositions. Team owns task storage, dependencies, and compare-and-set commands. Assignment accepts the root or any discovered continuable descendant. Historical roster records grant no authority; the Team panel shows tasks and ordinary navigation owns members.

The wait-signal decision is superseded by [inbox-only Agent waits](../simplification/2026-10-29-inbox-only-agent-wait.md). Tree ownership, task durability, and historical non-authority remain unchanged.

Task state remains in the existing journal. Ordinary tool results record what the waiting model observes. Historical roster, mailbox, and task generations remain readable and unchanged. This partially supersedes the roster and wait decisions in [Agent Teams](../feature/2026-08-05-agent-teams.md) and [subagent teammates](2026-10-15-agent-teams-as-subagents.md). Their task durability and single-identity rationale remain active; [required runtime identity](2026-10-13-team-identity-runtime-context.md) owns retention.

## Alternatives considered

**Keep Team membership and a separate wait tool.** This duplicates tree authority and wait lifecycle, allowing stale roster rows or unrelated activity to affect current work.

**Persist task-board notices in every inbox.** The task journal already preserves every revision. Durable notices add message types, unread state, coalescing, and delivery-failure recovery solely to interrupt a current wait.

**Poll Agent status or start every idle task owner.** Activity does not identify useful input, and task readiness does not authorize a new turn. Explicit messages continue idle work when needed.

## Consequences

Task completion, inbox availability, current waiting, and Agent lifetime remain separate. Task updates do not end waits; callers inspect current tasks when deciding what to do. The task journal retains committed revisions without storing redundant notifications in recipient Sessions.

Verification distinguishes pending inbox input from task commits, isolates callers, excludes next-turn input and status changes, and covers wait cleanup and task persistence. Assignment coverage retains arbitrary depth and historical non-authority.
