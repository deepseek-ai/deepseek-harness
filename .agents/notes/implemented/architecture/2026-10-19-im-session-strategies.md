# Agent Note: IM session strategies

Status: implemented

English | [中文](2026-10-19-im-session-strategies.zh.md)

IM no longer ships a profile, per-chat conversations, task workers, the one-shot example, or turn renderers: [IM runs one shared session as an experimental bundle](../simplification/2026-10-28-im-shared-session-minimal-plane.md) records that decision; the sections below on those plugins describe the design they followed.

The v4 host supersedes the `ctx.imSessions` service seam described here: [IM architecture in v4](2026-10-25-im-architecture-v4.md) documents the current design, where routing plugins listen on the `im/message` waterfall, `ctx.im.sessions` hosts sessions, and `@deepseek-ai/dsh-experimental-im` provides an optional default `dispatcher` session.

## Problem

IM deployments differ on how incoming chat messages map to agent sessions. A per-chat conversation deployment gives each chat its own persistent session and delegates long work to background tasks, whereas a multi-chat triage deployment wants one shared dispatcher session to read addressed messages across chats and reply or delegate work from there. Both models need the same message admission, durability, outbound receipts, and authorized `im_*` tools. Hard-coding a single routing model inside the IM host would force a fork of the host for any other routing model.

## Decision

The [IM service](../../../../packages/experimental/im/README.md) owns platform intake, durability, session hosting (`ctx.im.sessions`), outbound publication (`ctx.im.send`/`stream`), and the `im_*` tools, while session selection is handled by listeners on the `im/message` waterfall (and the optional built-in `dispatcher` fallback on `@deepseek-ai/dsh-experimental-im`).

`dsh-im-session-conversations` implements the per-chat conversation strategy: each admitted chat gets one persistent session (`conversation:<chatKey>`) with that chat as its `home` binding, plus per-source addressing rules, delivery mode, ambient group context, output renderer, and optional task delegation reminder. When an operator instead configures `dispatcher` on `@deepseek-ai/dsh-experimental-im` ([`dispatcher.ts`](../../../../packages/experimental/im/src/dispatcher.ts)), addressed messages not claimed by a strategy reach a single shared session (`im:dispatcher`) that accumulates bindings for each chat it hears and receives a `<im-chat key="…" source="…" type="…" />` header before each message. Read and publication tools accept an optional `chat` parameter so a multi-chat session or task worker can target any chat in its bindings.

Background tasks live in `dsh-im-session-tasks` (`ctx.imTasks`), so any owner session listed in `config.owners` (`['conversation', 'dispatcher']` by default) can start, list, and steer task worker sessions without duplicating worker management in each routing strategy.

## Alternatives considered

**Hard-coding per-chat sessions in `@deepseek-ai/dsh-experimental-im`.** Baking `conversation:<chatKey>` routing into the host prevents one-shot command plugins (`session-oneshot`), custom routing plugins, or a shared dispatcher session from using the same intake and session store.

**Duplicating task worker management inside each routing strategy.** Each strategy would have to reimplement worker session creation, `im_tasks` persistence, `task_*` tools, and completion notices. Keeping task lifecycle in `dsh-im-session-tasks` lets any strategy use `ctx.imTasks`.

**Listing dynamically accumulated chats inside a static system prompt.** A dispatcher session's bound chats grow as new chats send messages; prefixing each delivered message with `<im-chat key="…" />` tells the model which chat sent the message without rewriting earlier turns.

## Consequences

Each session key in `im_sessions` is owned by the `owner` name that created it (`conversation`, `dispatcher`, `session-tasks`, `oneshot`), and `ctx.im.sessions.ensure` rejects attempts by a different `owner` to claim an existing key. A shared dispatcher session serializes turns across all chats it serves, whereas `session-conversations` runs an independent session per chat.
