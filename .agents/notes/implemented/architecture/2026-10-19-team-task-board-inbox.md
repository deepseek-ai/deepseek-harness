# Agent Note: Team tasks notify the ordinary subagent inbox

Status: implemented

English | [中文](2026-10-19-team-task-board-inbox.zh.md)

## Problem

A subagent tree already supplies agent identity, discovery, routing, and lifecycle. A second Team roster grants assignment authority from stale historical records and duplicates the ordinary member UI. Team-owned waits observe unrelated status changes and miss input already pending for the caller. Requiring an active peer before waiting also confuses turn activity with whether useful input can arrive.

## Decision

The subagent tree is the Team. Ordinary subagent controls own identity, communication, discovery, interruption, and `wait_agent`, independently of the optional task board. Required runtime context states current identity; shared policy explains message acceptance, result collection, waiting, and shared-file coordination. The existing runtime-context mechanism logs and retains this identity without loop changes.

`wait_agent` subscribes before checking the exact caller’s next-step inbox. Pending input returns immediately; subsequent input ends the wait. Queued next-turn input, unrelated inboxes, and bare status changes do not end it. Waiting neither consumes input nor starts agents. Timeout, cancellation, caller disposal, and plugin unload settle the wait and remove its resources.

Team owns task storage, compare-and-set commands, dependencies, and task policy. The root may assign itself or any reachable continuable descendant discovered by the subagent service. Historical roster records grant no authority. The browser Team panel shows tasks; ordinary subagent navigation owns the member list.

After task append and flush succeed, Team admits a compact notice to each other live local member’s next-step inbox. Pending notices for the same board coalesce by replacement with the existing inbox id. Notices never restore cold members or start idle turns. The recipient reads current tasks before acting. A delivery failure reports the committed task revision and failed recipients after attempting all recipients; callers cannot treat it as a failed commit or blindly retry creation.

Historical roster, mailbox, and task generations remain readable and are never rewritten. Accepted notices use ordinary inbox persistence. This partially supersedes the roster and wait decisions in [Agent Teams](../feature/2026-08-05-agent-teams.md) and [subagent teammates](2026-10-15-agent-teams-as-subagents.md); their task durability and single-agent-identity rationale remain active. [Required runtime identity](2026-10-13-team-identity-runtime-context.md) remains the retention decision.

## Alternatives considered

**Keep separate Team membership and waits.** This introduces a second authority and observer beside the tree and inbox, allowing historical roster rows and unrelated activity to affect current work.

**Poll the task board or wait for Agent status.** Neither identifies input the caller can process. Post-commit notices let one ordinary inbox wait serve messages, completion, steering, and task changes.

**Wake every task owner automatically.** Task readiness does not establish an instruction to start a turn. Non-waking notices preserve explicit continuation and avoid cold restores for background board updates.

**Report notice failure as a failed mutation.** The task is already durable. Hiding that fact can duplicate creation or cause stale retries; the committed revision and failed recipients preserve recovery information.

## Consequences

Task completion, inbox availability, Agent activity, and Agent lifetime remain separate. Idle members retain notices until continuation; cold members discover current tasks when they next run. Coalescing deliberately omits intermediate notices, while the task journal retains every committed revision.

Verification covers pending-input and subscribe races, exact-recipient isolation, next-turn exclusion, wait cleanup, arbitrary-depth assignment, historical non-authority, coalescing, non-waking delivery, and committed-state error reporting. Recorded subagent and Team workflows cover the model guidance and notices.
