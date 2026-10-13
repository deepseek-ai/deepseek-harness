# Agent Note: Exclusive Conversation matches

Status: implemented

English | [中文](2026-10-12-exclusive-conversation-matches.zh.md)

## Problem

Every event Definition matches each event independently, and a target may hold a generic Definition that presents a whole event family. When a business Definition presents one kind of that family itself, both Definitions match the same event and each builds a Context and a Node. Nothing let the business Definition say that the event belongs to it on that target.

The late question reply is the shipped case. Chat's generic `input-message` Definition matches every appended `user/message`, and the questions UI's `question-reply` Definition matches the reply message it presents. Chat process grouping therefore dropped the duplicate `turn-trigger` presentation by message id, in both the Turn-owned and unscoped paths, and anchored the Turn control to the first group member so it stayed above the reply. The duplicate Node remained in the Node Store, and the generic Definition kept treating the reply as context or a trigger notice.

## Decision

A match result may claim its event on the Definition's target:

```ts
interface ConversationMatchResult {
  readonly id: string
  readonly role: 'start' | 'update'
  readonly exclusive?: true
}
```

- **Dispatch.** `ConversationNodeAssembler.dispatchInput()` evaluates every match of one event into two reused arrays before accepting any, then settles claims. Other Definitions of a claimed target build no Context for the event, and that target's unmatched-event fallback does not run. Definitions of other targets and Definitions without a target still receive it. The outcome is independent of registration order. Live append and window collection share this dispatch.
- **Failures.** Two claims on one target, or a claim from a Definition without a target, throw during dispatch and name the event, its `seq`, and the claiming Definition kinds.
- **Scope.** A claim belongs to one event and comes from `match()`, so a Definition claims only the events it recognizes. The generic Definition declares nothing.
- **Current use.** `question-reply` returns `exclusive: true` for a recorded `user-question-reply` message. Chat no longer aggregates by message id, and the reply's placement is unchanged.

## Alternatives considered

**Definition precedence (`specific` / `default`).** A generic Definition would declare itself overridable, and dispatch would become a priority order rather than a statement of which Definition presents an event. A claim needs no change to the generic Definition, and two claims fail instead of silently ranking.

**Declare human sources in a registry and render the reply through user-text rules.** The reply would stay a generic message Node with customized text. Chat's message and Inbox Definitions would need a service-backed predicate, registry changes would have to reassemble every bound Conversation, and the text rule would need the message source as a fact. A claim keeps the reply in its owning Definition.

**Mark human-authored sources in durable data.** A generic field on the message source would let the generic Definition classify the reply, but it changes a persisted type, and replies recorded by released builds do not carry it.

**Skip the reply kind in `input-message`.** The generic Chat Definition would name a plugin's source kind.

**Deduplicate in the grouping output.** This is the replaced mechanism: the duplicate Node stays stored and visible to every other Chat reader, and each grouping path repeats the aggregation.

## Consequences

- A claimed event has exactly one Context per claimed target, so no hidden duplicate remains in the Node Store.
- A conflicting claim fails at dispatch rather than at registration, because claims are decided per event from event data.
- Dispatch makes one extra pass over an event's matches, usually one to three, and allocates nothing for events without a claim.
- A plugin that presents part of a generic Definition's event family on one target uses a claim; it does not need the generic Definition's cooperation.

## Testing

- `packages/client/ui-conversation/tests/conversation-assembler.client.spec.ts` ("exclusive matches"): a claim withholds the event from other Definitions of its target in either registration order and on live append; other targets, target-less Definitions, and no fallback; two claims and a target-less claim throw.
- `packages/client/ui-user-questions/tests/question-reply.client.spec.ts`: the reply match claims its event, and an assembler holding both message Definitions produces one Chat Node for the reply.
