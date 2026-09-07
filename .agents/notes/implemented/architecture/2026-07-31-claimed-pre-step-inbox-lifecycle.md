# Agent Note: Claim inbox input before one pre-step decision

Status: implemented

English | [中文](2026-07-31-claimed-pre-step-inbox-lifecycle.zh.md)

## Problem

The loop previously split one step boundary across prompt preparation, prompt admission, and a serial step hook. Claimed input could be retained or discarded by an admission result, and live queue events carried shapes that duplicated durable inbox state. Plugins had to choose whether to mutate the inbox, rewrite a submitted batch, or append directly to session history, while observers could not rely on one exact ordering.

Occurrence-local inbox wrappers also duplicated the identity already carried by every `UserMessage`. They made insertion, editing, claiming, cancellation, reconnect projection, and step entry one combined protocol even though the append-only session already owned the durable queue projection.

## Decision

Before every proposed step, the loop's package-internal `ReactLoopInbox` atomically claims the complete batch: all `next-step` messages and, at a turn boundary, one `next-turn` message. At the initial boundary the loop first commits `turn/start`, so the claim and its single `agent/pre-step` decision have durable turn ownership. Claiming records normalized `agent/inbox/spliced` pure deletions with no outcome, emits `agent/inbox/claimed { message, turn }` once per claimed message, and returns the exclusive batch for the loop's waterfall with `{ turn, step, signal }`.

`PreStepDecision` is `{ kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }`. Reject opens no step, leaves the claimed batch removed, and closes the turn as blocked without any step events. Empty entry, cancellation, and failure before `step/start` likewise close a balanced no-step turn. Enter supplies the complete batch appended as `user/message` events after `step/start`. A listener wrapping `next()` preserves downstream changes unless it intentionally replaces them, so all message rewrites settle once in the final return value. There is no `agent/prompt-prepare`, `agent/prompt-submit`, or `agent/step` extension point.

The durable inbox remains two `UserMessage[]` lists addressed by `MessageId`. `append`, `prepend`, and `splice` take a target, while `replace(messageId, newMessage)` and `remove(messageId)` locate the pending message across both lists before committing a normalized splice. Replacement may change identity and emits the old message as discarded followed by the new message as inserted. Every insertion emits `agent/inbox/inserted { message }`; an ordinary removal records `outcome: 'canceled'` and emits `agent/inbox/discarded { message }`. Claiming records pure deletions without an outcome and emits claimed events from `ReactLoopInbox`. These live events add no placement, outcome, or batch fields.

`Agent.inbox` exposes only the structural `Inbox` interface for reading and mutating pending work; loop-only `hasPending` and claim operations are absent from that public face. dsh-agent-loop constructs one `ReactLoopInbox` and uses it for both structural commands and driver operations. The concrete constructor receives `SessionProjectionRegistry` directly instead of the wider Cordis `Context` and registers the standard definition on the agent scope before its first read. `AgentLoop` requires the registry service at activation, and the registry reference-counts the definition across live agent scopes.

The two event surfaces have separate consumers. Observers following one message use `agent/inbox/inserted`, `claimed`, and `discarded`. Each `ReactLoopInbox` contributes the standard `inbox` projection over the durable `agent/inbox/spliced` stream from its agent scope; UI edits and removals route through an Inbox mutation method so the same projection records every change. When that projection reconstructs durable history, it rejects unsafe or out-of-range coordinates and duplicate `MessageId` values across both lists, and reports the offending event seq. Whole-queue control consumers use the projection change feed: the Session controller publishes the projection frame, then derives the queue replacement from the same post-fold inbox value.

Plugins that need current-step atomic rewriting return messages from `agent/pre-step`. Plugins that only need later context may mutate `agent.inbox` directly. Workspace context uses both paths: asynchronous filesystem projections stage one replaceable `next-step` item, while the next entering pre-step folds that item or a newly composed baseline into its final batch and removes the pending copy. Rejection keeps the item queued.

The archived [addressable queue occurrence decision](../../archived/feature/2026-07-29-addressable-queue-operations.md) describes the superseded occurrence-wrapper design. `MessageId` owns addressability, while `ReactLoopInbox` contributes `inbox` as the standard session projection over durable splices. The generic projection carrier serves that fold for live updates, history-tail reconnect baselines, and cold process-restart recovery without a live Agent mirror.

## Alternatives considered

**Keep separate prepare and admit hooks.** This lets preparation mutate the inbox before claiming and admission rewrite afterward, but it creates two ordering surfaces for one boundary and makes cancellation ownership ambiguous.

**Let rejection requeue the claimed batch.** This preserves retry-like behavior but turns a veto into hidden queue mutation, duplicates later work unless every race is fenced, and prevents claim from being an atomic ownership transfer.

**Put placement and outcome on every live event.** Durable splices already own those facts. Repeating them on live notifications creates a second contract that can drift and is unnecessary for consumers holding the exact message identity.

## Verification

Agent-loop coverage pins turn-start-before-claim-before-pre-step ordering, exact live event payloads, balanced no-step rejection, final-batch rewriting, input inserted after a claim, listener failure, cancellation, and agent-scope projection removal after the last owner unloads. Inbox and consumer tests pin pure claim deletions, canceled ordinary removals, agent-instructions staging, replacement, and same-step entry, plan/goal/hook behavior, UI cleanup, compaction, checkpointing, resumed durable projection, rejection of invalid persisted coordinates or cross-list identities, and post-fold queue replacement when the controller registers before the projection registry. Consumer-domain tests use a process-local Inbox stub only when durability is outside the test subject; claiming, durable projection, recovery, validation, and live-notification tests create Agents through the production AgentLoop test harness, so test support never reimplements the projection. Generated event and type catalogs expose only the new waterfall and payloads.

## Consequences

The loop has one awaited decision before each step and one ownership transfer for its input. Claimed messages never return to the inbox implicitly; later insertions remain independent. Live events are symmetrical with other inbox notifications without mirroring durable metadata, and plugins can choose exact-current-step rewriting or ordinary later inbox delivery explicitly.
