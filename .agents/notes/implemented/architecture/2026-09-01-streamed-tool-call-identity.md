# Agent Note: Streamed tool-call identity survives empty continuation deltas

Status: implemented

English | [中文](2026-09-01-streamed-tool-call-identity.zh.md)

## Problem

The DeepSeek SSE translator assigned `id` and `name` on every tool-call delta that carried the field, so a continuation delta repeating either as an empty string erased the identity established by the call's first delta. The assembled block reached the loop with an empty name, which the tool registry refuses as `unknown tool ""`, leaving the affected models unable to run any tool. Gateways that fill those fields with `null` erased the identity the same way, and `WireToolCallDelta` declared both as `string | undefined`, keeping the observed `null` out of the compiler's reach.

The empty identity outlived the turn. `appendToolCall` and `appendToolResult` write the block's id verbatim and no write path validates it, while `adoptSessionEvent` refuses a `tool/result` whose `callId` is empty, so the persistence coordinator wrapped that refusal in `SessionPersistenceCorruptionError`. A session that recorded one such call was writable and no longer loadable.

## Decision

`acceptIdentity` accepts only a non-empty string for a tool call's `id` and `name`; `undefined`, `null`, `''`, and any non-string leave the established value in place. The assignment set only narrows, so no input reaches a worse outcome than before. `WireToolCallDelta` widens `id`, `function.name`, and `function.arguments` to admit `null`, putting the values gateways actually send into the type system and making the runtime guard load-bearing rather than speculative.

## Alternatives considered

**Concatenate `id` and `name` across deltas.** Rejected: they are identity, not accumulation. Concatenation produces `Globnull` against a gateway that sends `null`, and a doubled name against one that repeats a non-empty value.

**Refuse a conflicting non-empty identity mid-stream.** Deferred: a gateway that fragments a long tool name would be refused for it, and no observed provider re-sends a different non-empty identity within one call index.

**Refuse a response whose tool call never receives an identity.** Deferred. It requires a new failure code, a change to the default retryable set, and a `[DONE]` gate that must not override the finish reason a provider already sent — cost and risk that the reported defect does not carry. The lenient wire it guards against is hypothetical: no report describes a stream that omits identity entirely.

**Relax the session reader's empty-`callId` refusal.** Rejected: an empty `callId` cannot be paired back to the provider on the next request, so accepting it moves the failure into the model request. That refusal is the durable-boundary gate; the producer was the defect.

## Consequences

A continuation delta repeating identity empty or null is inert, so a call keeps the identity its first delta established, and the reported path to `unknown tool ""` and an unreadable session is closed. A stream that never carries identity at all still assembles an empty one, exactly as before; that path and the recovery of sessions already holding an empty `callId` are outside this change.

## Testing

`translate.spec.ts` covers empty and null continuation deltas, a repeated identical identity, and parallel calls holding separate identities under empty continuations. The existing cases for a wire that omits identity entirely keep their recorded empty-identity output.
