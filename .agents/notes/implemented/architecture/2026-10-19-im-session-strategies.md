# Agent Note: IM session strategies

Status: implemented

English | [中文](2026-10-19-im-session-strategies.zh.md)

## Problem

IM deployments differ on how incoming chat messages map to agent sessions. A per-chat conversation deployment gives each chat its own persistent session and delegates long work to background tasks, whereas a multi-chat triage deployment wants one shared dispatcher session to read addressed messages across chats and reply or delegate work from there. Both models need the same message admission, durability, outbound receipts, and authorized `im_*` tools. Hard-coding a single routing model inside the IM host would force a fork of the host for any other routing model.

## Decision

The [IM service](../../../../packages/experimental/im/README.md) owns platform intake, durability, session hosting (`ctx.im.sessions`), outbound publication (`ctx.im.send`/`stream`), and the `im_*` tools, while session selection is handled by listeners on the `im/message` waterfall (and the optional built-in `defaultDispatch` fallback on `@deepseek-ai/dsh-experimental-im`).

The host's own fallback lives in [`dispatcher.ts`](../../../../packages/experimental/im/src/dispatcher.ts): with `defaultDispatch` configured, addressed messages no listener claimed reach a single shared session (`im:dispatcher`) that accumulates bindings for each chat it hears and receives a `<im-chat key="…" source="…" type="…" />` header before each message. Read and publication tools accept an optional `chat` parameter so a multi-chat session can target any chat in its bindings.

## Alternatives considered

**Hard-coding per-chat sessions in `@deepseek-ai/dsh-experimental-im`.** Baking `conversation:<chatKey>` routing into the host would prevent one-shot command plugins, custom routing plugins, or a shared dispatcher session from using the same intake and session store.

**Listing dynamically accumulated chats inside a static system prompt.** A dispatcher session's bound chats grow as new chats send messages; prefixing each delivered message with `<im-chat key="…" />` tells the model which chat sent the message without rewriting earlier turns.

## Consequences

Each session key in `im_sessions` is owned by the `owner` name that created it (`dispatcher` for the default fallback, or the name a plugin picks), and `ctx.im.sessions.ensure` rejects attempts by a different `owner` to claim an existing key. A shared dispatcher session serializes turns across all chats it serves.
