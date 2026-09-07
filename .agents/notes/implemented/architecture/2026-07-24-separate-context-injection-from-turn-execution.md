# Agent Note: Separate context injection from turn execution

Status: implemented

English | [中文](2026-07-24-separate-context-injection-from-turn-execution.zh.md)

## Problem

The agent API represented supplementary model-facing input in three overlapping ways: callers attached `HookContext[]` through `SendOptions.contexts`, interception and tool hooks returned `additionalContexts`, and plugins called `agent.inject()`. These paths eventually wrote context into the same model history, but carried different placement, metadata, admission, queue, and turn-lifecycle rules.

Atomic attachment to an inbox message forced the loop to preserve context through prompt admission, steering conversion, cancellation, and terminal discard. `prompt-prefix` placement then combined context and the direct prompt into one event, requiring a model-hidden envelope so transcript consumers could recover what the user actually wrote. The result made outbox entries, session projection, and UI replay responsible for a distinction that belongs to the producer.

Idle `inject()` exposed a second mismatch. Injection did not request model execution, yet the implementation opened and closed a zero-step `injection` turn solely to satisfy the turn-enclosure invariant and obtain a durability checkpoint. A turn therefore sometimes meant “run the agent loop” and sometimes meant “persist context without running it.”

`HookContext` also named its producer rather than its role. The value could come from a native plugin, a hook bridge, prompt admission, or tool post-processing; its stable meaning was additional model-facing context whose source named the producer.

## Decision

`inject()` is the only caller-facing operation for supplementary model-facing input, and a turn means one execution of the model loop.

A caller that owns context delivers an identified, frozen `UserMessage` through `inject()` and submits the direct message independently with `followup()` or `steer()`.

An entering pre-step returns the complete `PreStepDecision.messages` batch for the request being finalized. Tool extension points still return `additionalContexts`, which enter the next-step inbox only after the corresponding tool results. These values are extension-point outputs, not attachments captured from a caller's inbox item.

Every additional context is an independent `UserMessage` whose `source` names its producer and carries producer-specific fields. Inbox insertion is durable immediately; admission later records the same value as `user/message`. There is no `context/message`, prompt-prefix placement, stable request delimiter, or prompt envelope. Transcript and UI consumers distinguish direct user messages from injected context by `source`.

## Injection lifecycle

`inject()` always inserts context into the non-waking `next-step` inbox and commits that queue mutation as `agent/inbox/spliced`. A running driver claims it at the nearest later pre-step boundary. An idle driver leaves it pending until `followup()` or `steer()` supplies waking work; cancellation or disposal may discard it first without erasing the durable queue history.

The loop claims the current next-step batch before running `agent/pre-step`, so an injection that arrives after that claim may miss the request already being finalized. The next boundary claims it instead. An enter decision appends its returned messages inside the owning turn before the request consumes them. Context produced during an assistant tool-call batch therefore appears after that batch's complete ordered results.

If pre-step rejects or throws, its claimed injected context, steering, and queued prompt stay removed and no returned batch is appended. Messages inserted after that atomic claim are unaffected and remain pending.

The loop appends injected `user/message` events only from entered batches inside a turn. Core execution events, steering, assistant output, and tools remain turn-enclosed; merge-extensible event relations belong to their declaring plugin rather than a core default.

## Extension and caller semantics

The enter branch's `PreStepDecision.messages` is the complete batch for the proposed step. A waterfall listener that delegates with `next()` preserves downstream messages unless it intentionally replaces them; additions follow natural waterfall return order. Tool-result `additionalContexts` retain FIFO order and each message's source.

Caller-driven injection and current-step context deliberately use different timing. `inject()` joins the next pre-step available and cannot promise that a request already being finalized will consume it. A listener that must affect that exact request returns the context in `PreStepDecision.messages`; downstream rejection or failure then prevents it from materializing.

Cross-session references use that domain composition: TUI prepares the snapshot, returns it from the idle direct message's pre-step beside that message, or injects it before waking steering during a running turn. The target log contains two simple messages, so later source mutation cannot change replay and transcript consumers do not need a prompt envelope. This supersedes the attachment mechanism in the [cross-session reference decision](../../archived/feature/2026-07-21-cross-session-references.md) while retaining its snapshot and trust-boundary rules.

This decision preserves the caller-owned framing decision from [unwrapped injected content](../simplification/2026-07-20-unwrap-injected-content-envelopes.md) and the one-item turn rule from [one send, one turn](../simplification/2026-07-17-one-send-one-turn.md). The later [standalone log-only event decision](../simplification/2026-07-28-remove-synthetic-log-only-turns.md) applies the same execution-only meaning to plugin-owned records.

## Alternatives considered

**Keep `SendOptions.contexts` as an atomic attachment.** This preserves all-or-nothing delivery when prompt admission blocks, but it keeps context inside inbox lifecycle state and requires every queue transition and observation event to carry it. The generic agent API should not encode a domain transaction that most callers can express as context injection followed by message delivery.

**Keep a distinct `context/message` session event.** User-role model input would again have two event types with identical projection. `user/message.source` already carries the distinction needed by policy, transcript, and replay consumers.

**Keep one-shot turns for idle injection.** Durable inbox insertion already records idle context without opening a turn. A synthetic turn would make turn counts and observers report work that never ran the model; non-waking context remains pending until real waking work supplies a request.

**Keep `prompt-prefix` as an optional placement.** Prefix baking can make the context and request appear in one provider message, but it introduces a second representation of the direct prompt and spreads placement handling across admission, steering, logging, replay, and UI code. Producers that require textual framing may include it in their own context content.

**Let prompt hooks call `inject()` instead of returning messages.** An injection may miss the request whose prompt is already being finalized and would escape a downstream block of that decision. Returning the complete message batch keeps current-request context under the waterfall's authority.

## Verification

- Delivery inputs and steering inbox records contain no attached contexts; `agent/inbox/inserted` reports only the inserted message, while the durable splice retains its target list.
- `UserMessage` is the shared identified, frozen shape across prompt interception, tool execution, hook bridges, guards, and context producers.
- Prompt-prefix placement, prompt envelopes, and `context/message` are absent from public types, durable events, projection, and UI replay.
- Idle `inject()` immediately appends one durable inbox insertion but no model-visible `user/message`; a later waking delivery may start pre-step processing.
- Active-turn injection is claimed at the nearest later pre-step boundary, after complete tool-result batches and before the request that consumes it.
- Rejected or failed pre-step drops its claimed batch; input inserted after the claim remains pending.
- Unit, persistence/resume, invariant, and TUI coverage pin event order, claim ownership, and durable replay.

## Consequences

- Idle injection is not model-visible until a later pre-step enters it and may be discarded by cancellation or disposal, while its durable inbox lifecycle remains recorded.
- Consecutive user-role messages replace one baked prompt message; provider adapters preserve that ordering.
- Exact-current-request context must be returned from `agent/pre-step`; ordinary injection provides only nearest-later-boundary delivery.
- The public delivery contract and inbox records remain small: no context attachment, context-placement metadata, prompt envelope, or duplicate durable event type.
