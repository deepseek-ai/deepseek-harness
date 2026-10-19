# Agent Note: Precompute the steering batch start in Conversation Node Definition state

Status: implemented

English | [中文](2026-10-16-steering-batch-start-in-definition-state.zh.md)

## Problem

Chat keeps a 44px slot, the height of the running status row, above the first steering row of each claim that lands after the running Turn's process output, so admitting steering swaps the status and the bubble without moving the bubble ([conversation-nodes README](../../../../packages/client/ui-chat/src/client/conversation-nodes/README.md)). Deciding that a steering row starts such a batch needs two facts its own `user/message` event does not carry: whether it is the first human message of its `next-step` claim, and whether the same Turn already has durable visible output before it, which places the row after the Turn's process control. The answer must hold for live appends, replay, and loading earlier history, and must not scan the event window or the Chat Nodes.

## Decision

The batch start is a fact in Conversation Node State, computed by Definitions through the existing [`reader.previous`](2026-08-09-client-conversation-node-assembly.md) lookup:

- [`inbox.ts`](../../../../packages/client/ui-chat/src/client/conversation-nodes/inbox.ts) records `firstClaimedHuman`, the first human message removed by each `next-step` claim, in the Client Inbox State.
- [`turn-process.ts`](../../../../packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts) registers `processEvidenceDefinition` (kind `process-evidence`, `publication: () => 'none'`): one Context per Step with durable visible output, id `turn:step`, matched from `assistant/message`, `tool/call`, `tool/result`, and `llm/retry` through the existing `processEvidence` test. Streaming chunks never reach it. Its State holds the Turn number; the Context's matches accumulate that Step's evidence events, and nothing reads them.
- [`message.ts`](../../../../packages/client/ui-chat/src/client/conversation-nodes/message.ts) calls `reader.previous('process-evidence')` in `start`, only for the claim's first human message. When the nearest earlier record belongs to the same Turn, the steering State carries `batchStart: true`. Later appends have larger seqs and cannot change the answer; loading earlier history replays the dependency through the assembler's tracking of `reader.previous`, as Message already does for Inbox.
- The steering renderer reads only `data.batchStart` and writes `data-chat-steering-batch="start"` on its bubble root; CSS gives the containing row the slot.

The lookup costs O(log N) per claim-leading human message, where N is the number of Steps with output in the loaded window. The change adds no framework API and no persisted or wire data.

## Alternatives considered

**Compute it in the renderer from props.** The renderer would need neighbouring rows and the Turn's process state, which puts a steering branch into the business-free node list and Seat, and the row would not re-render when only a neighbour changes.

**Compute it in the Chat snapshot builder.** A projector over the ordered entries would put a steering-specific rule and an extra pass into the generic build layer.

**Add tracked Turn-data reads to the framework (`reader.turnData`).** It changes the `ConversationNodeBuildReader` contract and the assembler's dependency tracking for one consumer, while `reader.previous` already gives the needed ordering, dependency, and replay.

## Consequences

The decision lives in node data, follows replay and earlier-history loading through existing dependency tracking, and leaves the renderer, Seat, node list, and ui-conversation framework unchanged. It costs one more Definition and one Context per Step with output; each State is one number, and each Context holds references to its Step's evidence events. The slot follows the claim's first human message rather than its first rendered row, so a runtime-context notice logged before that message in the same claim sits above the slot; this follows from the README's rule that the claim's first human message keeps the slot.

## Testing

- [conversation-node-definitions.client.spec.ts](../../../../packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts): `records durable process evidence once per Step and ignores live chunks and invisible replies` pins evidence matching; `marks each claim lead and starts a batch only after the Turn control`, run for replay, live appends, and prepends, pins batch starts for the first and a later claim, no batch start for the second row of a claim, an idle claim that opens a Turn, or a claim after a Step without output.
- [chat-view.client.spec.tsx](../../../../packages/client/ui-chat/tests/chat-view.client.spec.tsx): `marks the steering row whose data carries a batch start, and no other input` pins the rendered attribute; [turn-tail-spacing.client.spec.ts](../../../../packages/client/ui-chat/tests/turn-tail-spacing.client.spec.ts) pins the 44px slot rule.
