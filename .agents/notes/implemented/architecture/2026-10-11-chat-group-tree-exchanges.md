# Agent Note: Chat group-tree positions and exchanges

Status: implemented

English | [中文](2026-10-11-chat-group-tree-exchanges.zh.md)

## Problem

On next message folding kept only the last Turn of the loaded timeline expanded. A Turn woken by a notice (a settled subagent, goal round, schedule, or background job) is not submitted by this Client, yet its arrival made the preceding Turn historical and folded it. No own-input driver computed the exact remaining room for that fold, so the scroll layer reserved generic bottom space and a reader following the tail saw blank space. In the recorded Session the notice woke the next Turn 13–15 ms after the previous Turn ended; the minimal reproduction left 596 px blank that had not recovered after five seconds.

## Decision

A notice is neither body text nor a user message: folding and bottom advancement ignore it. The bottom changes from the last Turn to the latest exchange.

- **Group-tree positions.** `ChatConversationViewNode.groupTree` declares a Node's position in the group tree, typed `ChatGroupTree = 'exchange' | 'input' | 'turn' | 'process'` and ordered outermost first; a Node at a position also has the effect of every inner position. `exchange` opens an exchange. `input` makes the Node an input of its Turn: before the Turn's process it is the opening input, after it an interleaved input that keeps the whole Turn open. `turn` keeps the Node outside the Turn's process disclosure, `process` keeps it inside the disclosure but outside step runs, and a Node without a position joins the surrounding step run. `isAtOrOutside(node, position)` is the single reader of that order: process grouping reads `process`, whole-Turn folding reads `turn`, Turn-input detection reads `input`, and exchanges read `exchange`.
- **Exchanges.** A Turn holding an `exchange` Node opens an exchange, which lasts until the next opening Turn. The business message Definition marks only human input claimed in Step 1 (`user` or `steering`) as `exchange`; later human input and trigger notices stand at `input` and never open an exchange.
- **Built-in positions.** `turn-error`, `turn-max-tokens`, `turn-tail`, and the `turn-process` control stand at `turn`; `model-retry` stands at `process`. Two placement rules stay with ui-chat's own `assistant-step` Node: its reasoning row joins the step run while its reply row stands outside it, and the Turn's process specification keeps the finalized answer's reply outside the disclosure because which step answers changes as later steps arrive.
- **Mechanism.** `GroupTreeSegments(position)` splits the loaded Turns at the Turns holding a Node at that position. The latest segment starts at the last opening Turn, or at the first loaded Turn when the window holds none. It counts per Turn incrementally without scanning loaded Nodes, and a start move returns only the Turns that entered or left the latest segment. The Chat Builder's `bottomSource` is "the Node is visible and belongs to the latest exchange".

As a result, a notice-woken Turn no longer folds earlier Turns, so no room is reserved; the human's next ordinary message folds the whole exchange through the own-input path.

## Why mark the opening rather than the notice

The host claims the waking input right after `turn/start`, assembles the system prompt, and only then logs `step/start` and `user/message`; the recorded Session spent 187 ms in that gap. Marking only the notice leaves the new Turn untagged during the gap, so the bottom still advances and the previous Turn folds and then reopens. Marking the human opening and letting unmarked Turns continue the exchange keeps the gap inert.

## Alternatives considered

**Tag the notice as a continuation.** The 187 ms gap above makes it fold and reopen, and a claim that mixes a notice with human input needs extra classification.

**Name opening kinds in a list (`user`, `steering`).** A kind cannot separate Step 1 steering from mid-Turn steering, so a human steering into a notice-woken Turn would wrongly fold the previous exchange.

**Publish Turn-level Location data.** Only one Context may publish a key for a Turn, while opening input comes from several message Contexts; aggregating per Turn would repeat the inbox claim classification in a new Definition and read every Turn on each update.

**Declare a business role (`input`, `notice`) on Nodes.** That places business semantics in the grouping mechanism; group-tree positions describe structure only, and each business Definition chooses its position.

**Correct the scroll room for folds not caused by own input.** Notices should not fold at all, and correcting the room would not remove that unnecessary fold. Folds caused by human input without an echo on this page are handled by [one fold motion for collapsing on the next message](2026-10-13-chat-single-fold-motion.md).

**Read Turn inputs at `turn`.** Terminal errors, max-token notices, and the completed-turn footer also stand outside the process disclosure, so reading `turn` would treat them as opening input; Turn inputs need their own position.

**Derive the exchange from an `input` in Step 1.** A trigger notice is its Turn's opening input but must not open an exchange. Deriving the exchange would drop trigger notices from `input` and change how notice-woken Turns order their process rows.

## Consequences

- Notice-woken Turns no longer cause a fold, reserved room, or blank space.
- External Definitions place their Chat rows through `groupTree`. Apart from the two `assistant-step` rules, ui-chat names no kind when it groups, folds, or detects Turn inputs, and built-in kinds keep the placement their former kind lists gave them.
- Under On next message, a long run of notice-woken Turns (up to 31 goal-mode Turns in sampled Sessions) stays expanded until the human types again.
- When the loaded window holds no opening Turn, every loaded Turn belongs to the latest exchange.
- Human input from another tab folds when its `user/message` arrives, about 200 ms later than the former `turn/start` fold; its landing follows [one fold motion for collapsing on the next message](2026-10-13-chat-single-fold-motion.md).

## Testing

- `packages/client/ui-chat/tests/group-tree-segments.client.spec.ts`: position order, segmentation, count fallback, and the empty window.
- `packages/client/ui-chat/tests/chat-node-bottom.client.spec.ts`: latest-exchange membership and notification scope.
- `packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts`: a real assembler across an opening Turn, mid-Turn steering, the pre-Step gap, a notice wake, and an idle steer, with non-opening inputs at `input`.
- `packages/client/ui-chat/tests/process-groups.client.spec.ts`: a Node at any position splits the step run regardless of its kind, and a position change regroups.
- `apps/web/tests/notice-wake-tail.e2e.ts`: after a long Turn a notice wakes the next Turn; the long Turn stays expanded through the pre-Step gap and after the notice reply, and a following reader sees the notice and the reply.
