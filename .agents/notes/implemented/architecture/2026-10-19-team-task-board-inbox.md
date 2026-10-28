# Agent Note: Team task boards share ordinary subagent waits

Status: implemented

English | [中文](2026-10-19-team-task-board-inbox.zh.md)

## Problem

The subagent tree already supplies identity, discovery, routing, and lifecycle. A second Team roster can grant assignment authority from stale history and duplicates member navigation. Team-wide status waits observe unrelated activity and miss input already pending for the caller. Persisting task-board wakeups as messages adds unread state and message schemas even though the task journal already owns the state to inspect.

## Decision

The subagent tree is the Team. Ordinary controls own communication, discovery, interruption, and `wait_agent`, independently of the optional task board. Team tools own task policy and required Team identity, without adding either to ordinary subagent compositions. Team owns task storage, dependencies, and compare-and-set commands. Assignment accepts the root or any discovered continuable descendant. Historical roster records grant no authority; the Team panel shows tasks and ordinary navigation owns members.

`wait_agent` subscribes before checking the exact caller’s next-step inbox. Pending input returns immediately; later input ends the wait. A `subagent/tree-wait-notified` event matching the exact live root captured at entry also ends an active wait. Other inboxes, other trees’ signals, queued next-turn input, and status changes do not end it. Waiting neither consumes input nor starts Agents. Settlement removes listeners and the timer, including on timeout, cancellation, disposal, or plugin unload.

After task append and flush succeed, Team calls `subagents.notifyTreeWaits(root)` once. Only current wait subscriptions check the root; Team neither enumerates live Agents nor maintains a membership index. Signals only end current waits: they leave no unread state, add no inbox entry, and cannot make a later wait return immediately. They never restore cold members or start idle turns. After waiting, the caller reads current tasks before acting.

Task state remains in the existing journal. Signals are transient runtime events, not Session events or messages; ordinary tool results record what the waiting model observes. Historical roster, mailbox, and task generations remain readable and unchanged. This partially supersedes the roster and wait decisions in [Agent Teams](../feature/2026-08-05-agent-teams.md) and [subagent teammates](2026-10-15-agent-teams-as-subagents.md). Their task durability and single-identity rationale remain active; [required runtime identity](2026-10-13-team-identity-runtime-context.md) owns retention.

## Alternatives considered

**Keep Team membership and a separate wait tool.** This duplicates tree authority and wait lifecycle, allowing stale roster rows or unrelated activity to affect current work.

**Persist task-board notices in every inbox.** The task journal already preserves every revision. Durable notices add message types, unread state, coalescing, and delivery-failure recovery solely to interrupt a current wait.

**Poll Agent status or start every idle task owner.** Activity does not identify useful input, and task readiness does not authorize a new turn. Explicit messages continue idle work when needed.

## Consequences

Task completion, inbox availability, current waiting, and Agent lifetime remain separate. Changes outside a wait are deliberately not remembered; callers inspect current tasks when deciding what to do. The task journal retains committed revisions without storing redundant notifications in recipient Sessions.

Verification distinguishes pending inbox input from transient signals, isolates callers and trees, excludes next-turn input and status changes, and covers wait cleanup and post-flush signaling. Assignment coverage retains arbitrary depth and historical non-authority.
