# Agent Note: Create every message as an identified immutable value

Status: implemented

English | [中文](2026-07-28-identified-immutable-message-values.zh.md)

## Problem

The harness had several message-shaped representations with different identity rules. Agent input acquired an inbox correlation id only when the loop accepted it, while durable user messages, assistant messages, tool results, and model-request messages could have no identity. Prompt admission therefore sat between creation and identity, and equivalent content was copied across live events, durable events, and model requests without one value that named the message throughout its lifetime.

This made identity a routing side effect rather than a message invariant. Producers could not refer to a message before calling the agent, prompt hooks received content and source separately, and later projections had to reconstruct a message while deciding whether an id existed. Immutability also began at different boundaries: some inputs were frozen by the loop, some only by session append, and provider-produced assistant output used a separate shape carrying provider, model, and replay state.

## Decision

`@deepseek-ai/dsh-llm` owns one `Message` value with required `id`, `role`, `content`, and `source`. `MessageId` is opaque and shared by user, assistant, and tool-result messages. A message receives its id at creation, before inbox routing, claim, pre-step rewriting, durable append, or request projection. The same id survives every representation boundary.

`createMessage(input)` is the canonical role-generic creation boundary. It mints a `MessageId`, detaches the supplied role, content, and source, and deep-freezes the complete value before returning it. `createUserMessage({ content, source })` fixes the user role for prompt and context producers. `createAssistantMessage({ content, source })` fixes both the assistant role and the model source kind, so model-output producers supply only content plus provider, model, and optional replay state. All creation helpers exclude an input id so callers cannot accidentally present creation as import. `freezeMessage(message)` is the separate import or transformation boundary: it detaches and deep-freezes a message whose identity already exists, without minting a replacement.

The message helpers live in `dsh-llm` beside the base message vocabulary because their complete contracts depend only on that vocabulary. They use `dsh-brand`'s stateless `brandString()` constructor for `MessageId` and `dsh-util-values`'s shared `deepFreeze()` implementation after detaching input with `structuredClone()`. `createToolResultMessage()` belongs with the other creation helpers: it couples a tool call id to the exact user-role tool-result block and source without depending on session state or events. `dsh-session` consumes complete messages rather than owning their construction.

The `Agent` interface accepts a complete `UserMessage` through `followup`, `steer`, and `inject`. These operations never allocate or return identity; they freeze an imported value whose id the caller already holds. Inbox claims and `agent/pre-step` receive that message directly. A content rewrite creates a frozen replacement with the same id, while an additional context is a separately created `UserMessage` with its own id.

Durable message-producing events store complete messages. `user/message` stores its `UserMessage` directly; `assistant/message` and `tool/result` wrap their role-specialized message beside event-local position, usage, failure, or presentation facts. Session derivation returns those frozen values instead of reconstructing anonymous messages. Assistant assembly creates a model-sourced message when a response completes, and tool execution creates a tool-sourced message when a result is committed.

Any operation that changes only the representation of an existing semantic message preserves its id and returns another frozen value. An operation that creates a new semantic message mints a new id. Compaction content rewrites therefore preserve the rewritten tool-result identity, while a summary checkpoint is a new message.

## Alternatives considered

**Keep ids optional on the base message.** This would minimize fixture migration and allow provider or persistence shapes to remain anonymous. It would also preserve the original ambiguity: every consumer would need to branch on whether identity exists, and no type would prove that admission, logging, or projection retained it.

**Let agent delivery allocate the id.** This keeps identity scoped to inbox correlation but makes the agent call the earliest point at which a producer can name its own message. Prompt construction, UI attachments, and synchronous enqueue/discard coordination then need content matching or an out-of-band token before delivery returns.

**Let each durable event allocate a new id.** This gives persisted messages identities but deliberately breaks correlation with the live input and makes replayed requests appear to contain different messages. Identity belongs to the semantic value, not to each envelope that carries it.

**Freeze only at agent or session admission.** This avoids a creation helper but leaves an identified mutable interval in which caller code can change the meaning associated with an id. The decision makes “has an id” and “is an immutable snapshot” coincide.

## Consequences

Every message producer must choose creation or import explicitly, and tests construct complete values rather than partial content/source records. UUID generation moves outward to the first semantic creation point, so deterministic fixtures that provide an existing id use `freezeMessage()` instead of `createMessage()`.

Live inbox events, durable events, derived history, and model requests can correlate one message without content equality or envelope-specific ids. Pending-input policy and UI attachment cleanup can compare `MessageId` before a turn exists, while claims retain that identity inside the open turn. Deep freezing prevents a producer, hook, or observer from changing the value after identity is established.

The shared representation removes the old `UserMessageData`/`AgentMessage` split and puts provider, model, and optional replay state into typed message sources. Event envelopes still own facts that are not message semantics, such as turn and step position, token usage, internal tool failure identity, and presentation metadata.

The message and helper unit tests pin immediate identity, detachment, deep immutability, and preservation of an imported id. Agent-loop tests pin identity across admission, inbox lifecycle, durable append, content rewriting, and cancellation; session tests pin frozen derivation and identity-preserving replacement.

## Related

- [Unified agent delivery routing and coalesced injected context](../../archived/architecture/2026-07-22-unified-send-and-coalesced-user-messages.md) — this note supersedes its input-representation and agent-assigned-id details while retaining its routing decision.
- [Reconstructable requests](2026-07-05-reconstructable-requests.md) — the session log remains the authority for every model-visible input.
