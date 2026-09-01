# Agent Note: Intent-named subagent continuation operations

Status: implemented

English | [中文](2026-07-27-intent-named-subagent-continuation-operations.zh.md)

The provider-request and session-flush decisions remain current. [Adjacent Agents share one Steer messaging operation](../architecture/2026-08-27-adjacent-agent-steer-messaging.md) supersedes this record's `followup` naming and options: the public operation is now `sendMessage(sender, targetId, content, { signal })` for either adjacent direction.

## Problem

Merging continuable-child orchestration into `ctx.subagents` left provider dispatch and caller intent on the same public service. `resume(name, request)` accepted a descriptor, authorized parent, durable child id, and activation signal that only the internal continuation manager could resolve correctly. Direction-specific `followup` and `reportFrom` operations would also encode routing and scheduling differences for one adjacent-Agent capability.

The durability boundary also exposed both `SessionStore.flush()` and `flushRequired()`. They performed the same scoped parallel dispatch and differed only in whether an empty listener snapshot was accepted, so the session interface encoded one consumer's policy as a second operation.

## Decision

`SubagentRuntime` separates three caller intents: `start(name, request)` returns an ordinary holder-owned one-shot run; `startContinuable(spec)` establishes a durable child and returns its id plus the accepted initial `MessageId`; and `sendMessage(sender, targetId, content, { signal })` sends model-authored content across one direct parent-child edge. The message operation derives attribution from the exact live sender and owns adjacency checks, cold resume, and fixed Steer scheduling. The single model-facing `send_message({ agent_id, message })` tool delegates to that operation in either direction.

Caller and provider requests are distinct. `SubagentStartRequest` contains caller-supplied one-shot data; `ResolvedSubagentStartRequest` adds the service-resolved descriptor before `SubagentProvider.start()`. For continuable creation, the manager passes a `ContinuableCreateRequest` to optional `SubagentProvider.prepareContinuable()` and receives detached creation data only. `SubagentRuntime.resume()` and provider resume dispatch are absent: the continuation manager loads the descriptor, authorizes the parent, and owns Agent materialization, prompt delivery, cold resume, and teardown.

`SessionStore.flush(session)` is the single durability barrier and returns `Promise<boolean>`. It resolves `true` after at least one scoped listener participates successfully, resolves `false` for an empty listener snapshot, and rejects with the first registered listener failure after all listeners settle. Participation cannot identify whether a selected persistence backend stored the state. Ordinary checkpoints may ignore the boolean; the continuation manager also treats its final flush as a best-effort barrier, deliberately ignores participation, logs rejection, and still disposes the child and releases ownership.

## Alternatives considered

**Keep public provider resume dispatch.** No production caller outside the continuation manager owns descriptor lookup, direct-parent authorization, Agent materialization, Activation ownership, and child-first teardown. A public method would expose resolved implementation data without a valid independent intent; providers instead contribute detached first-creation data through `prepareContinuable` and never participate in cold resume.

**Keep direction-specific `followup` and `reportFrom` operations.** They would preserve shorter recipient-free child calls, but duplicate authority, attribution, and delivery behavior while making the service vocabulary depend on direction. One `sendMessage` operation names the shared intent and keeps the target explicit.

**Keep `flushRequired()`.** A second method hides only an empty-listener check. Returning participation from the existing barrier keeps dispatch in one implementation and lets each caller state whether absence is acceptable.

**Fold ordinary and continuable starts together.** A flag would make one method return either an awaited holder-owned one-shot run or immediate durable child and message identities. Separate intent methods preserve the ownership and timing distinction without a return union.

## Consequences

- The Cordis service catalog contains only caller operations; a provider can opt into continuable first creation through `SubagentProvider.prepareContinuable?()` without receiving Agent lifecycle authority or a public resume operation.
- Sender authority is an exact live `Agent`; cancellation travels in one options object and owns work only until inbox acceptance.
- Session durability has one barrier operation. Its participation result remains observable, but no continuable-child path treats arbitrary listener participation as proof that a persistence backend stored the state.
- The single `send_message` schema, accepted message identities, `AgentHandle` ownership, durable event vocabulary, and model-visible transcript follow the activation-based realization linked above.
