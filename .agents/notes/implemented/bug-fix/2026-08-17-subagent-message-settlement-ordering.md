# Agent Note: Child Agent messages precede their settlement notices

Status: implemented

English | [中文](2026-08-17-subagent-message-settlement-ordering.zh.md)

## Problem

A continuable child can send selected content and later produce an unconditional manager-authored settlement notice. If those two messages enter queues with different claim priority, the later settlement notice can reach the parent model before the earlier child message. The first step of a turn claims the complete `next-step` batch before one `next-turn` message, so mixing a FIFO later-turn send with a next-step settlement reverses causal order. [Issue #2600](https://github.com/deepseek-harness/deepseek-harness/issues/2600) records the defect.

The child instruction says to send a finding whenever it changes what the parent should do next. Deferring that message to a later turn contradicts its scheduling meaning and separates causally ordered messages across queues with different claim priority.

## Decision

Every model-authored adjacent-Agent message uses fixed Steer delivery through `SubagentRuntime.sendMessage()`. A running parent reads the child message at its nearest safe step boundary and an idle parent starts a turn. There is no quiet or next-turn model delivery option.

The continuation manager retains `sendWaking()` around messages delivered to resident continuable parents and routes the synchronous send through the parent's private `SubagentInbox`. The wrapper accepts the send before its closing promise is installed or rejects it afterwards, and an accepted attempt renews the Activation's wake generation before returning. The receiving Activation therefore cannot settle over an accepted waking send.

### Ordering across parent states

A running parent receives an accepted child message and the child's later settlement notice in the same `next-step` FIFO. If the parent becomes idle before settlement arrives, it has already claimed the child message; settlement may then open a later turn without reversing observed order.

During parent maintenance, the child message occupies `next-step` and latches a wake, while settlement may occupy `next-turn` because maintenance reports idle status. The initial claim still takes next-step input before the queued turn. Waking input submitted after cancellation follows the core Agent's cancellation convergence rather than bypassing it.

### Verification

The control-tool suite holds a parent inside an active model request, submits child messages, settles the child, and verifies sender identity, Steer admission, FIFO batching, and preservation after settlement. Continuation coverage pins waking admission accounting for a resident continuable parent and keeps the runtime-owned settlement source distinct from `agent-message`.

The keyless continuable-subagent snapshot uses the shipped fixed delivery. Its child-visible tool schema is the same as the parent's, and the accepted child message precedes the later settlement notice without a scheduling overlay.

## Alternatives considered

**Offer quiet delivery.** A quiet message can remain unread after an idle parent parks. It also gives equivalent model-authored messages different liveness semantics and reopens deployment-dependent ordering.

**Offer next-turn delivery.** A later next-step settlement notice can still overtake it. Preserving message-before-settlement would require a cross-queue ordering barrier, and no current model operation requires later-turn isolation strongly enough to own that mechanism.

**Move settlement notices to `next-turn`.** Settlement batching uses the next-step queue so several children finishing together cost one parent step instead of one turn each. Moving settlement would increase latency and model work to retain an unnecessary message scheduling mode.

## Consequences

- A child message may extend an open parent turn. It never interrupts the active model request or tool execution; the agent loop admits it only at a step boundary.
- Messages accepted together share one next-step batch, preserving FIFO order and limiting turn amplification.
- Model callers cannot choose a delivery mode, so ordering and wake behavior do not vary by deployment or call.
- A child-to-parent send still requires the direct parent to remain live; the service provides no durable parent mailbox.
