# Agent Note: IM integration through automation sessions

Status: implemented

English | [中文](2026-10-12-im-automation-sessions.zh.md)

IM no longer ships a profile, per-chat conversations, task workers, the one-shot example, or turn renderers: [IM runs one shared session as an experimental bundle](../simplification/2026-10-28-im-shared-session-minimal-plane.md) records that decision; the sections below on those plugins describe the design they followed.

See [IM architecture in v4](2026-10-25-im-architecture-v4.md) for the current host and plugin split across `@deepseek-ai/dsh-experimental-im`, `session-conversations`, `session-commands`, `session-tasks`, and the output renderers.

## Problem

IM combines delayed input, multiple participants, quoted messages, and platform redelivery. A task can consume several messages without publishing an answer to each one. Treating every message as a GUI prompt and every assistant response as a platform reply couples input scheduling to publication.

## Decision

IM hosts persistent sessions through the existing agent factory, inbox, presets, and persistence APIs, and lets conversations delegate multi-step work to background task worker sessions. The agent loop and core Session categories are unchanged. The [IM service](../../../../packages/experimental/im/README.md) admits external context and provides [explicit tools](../../../../packages/experimental/im/src/tools.ts) for reading and publishing; the [IM profile](../../../../packages/experimental/im-bundle/README.md) launches the assembled application through `dsh`.

Source admission, write grants, delivery mode, model route, working directory, and preset are explicit deployment choices. `dsh-im-session-conversations` derives one session per admitted chat (`conversation:<chatKey>`), answers quick questions directly, and delegates multi-step work to background task workers via `dsh-im-session-tasks`. Each task opens a top-level worker session (`task:<id>`) that inherits the conversation's composition and answers in the chat (and thread) of the triggering message. The conversation inspects and steers tasks with `task_list` and `task_message`, and a worker's `done` or `failed` `task_update` injects a completion notice into the conversation's next turn.

The transport layer uses the vendored Satori packages (`plugin-im-core`, `satori-element`, `plugin-im-adapter-lark`, and `plugin-im-adapter-qq`). The [vendor manifest](../../../../vendor/README.md) documents exact upstream pins and local modifications. Generated Feishu declarations stay outside Git and are regenerated from hash-checked pinned sources during installation.

## Durability and ownership

One service instance holds the live `Agent` for each hosted session. The `im_sessions` storage domain records each hosted session with its owner, composition, and bindings, and rejects a session id that already exists outside the IM store. `im_messages` records each external event digest and message before platform ACK. A deterministic inbox message ID (`deliveryMessageId`) and a Session log check reconcile admission across restarts so redeliveries and crash recoveries do not duplicate inbox messages.

Outbound sends with an `operationId` record a `pending` receipt in `im_receipts` before network dispatch and update it with the result afterwards. Replaying the same `operationId` returns the recorded receipt without resending. A platform error code indicating nothing was published is recorded as `failed`; a lost response, timeout, or crash after dispatch is recorded as `uncertain` and is never automatically resent.

The `im` message source is attribution metadata only ([compatibility record](../../../../docs/persistence-changes/2026-10-28-im-message-source.md)). Permission decisions remain in the live IM service, and existing sandbox and approval policies continue to apply.

## Alternatives considered

**Another GUI client through Host controllers.** Suitable for transcript mirroring and typed interaction controls, but it introduces conversation policy and output coupling that automation does not need. IM uses the agent factory directly while retaining the existing loop.

**ACP between IM and the harness.** ACP supports persistent programmatic sessions and suits process separation. Independent IM publication still requires a channel or tool route; in-process Cordis composition avoids an additional process without changing automation semantics.

**Operator-configured fixed sessions per chat.** Naming each session and its sources by hand requires a configuration change and restart for every new chat. Deriving one session per admitted chat keeps access control in source rules without per-chat configuration.

**Subagents as the unit of delegated work.** A subagent is owned by its parent's turn activation: its lifetime and result delivery follow the parent turn. Background work in chats outlives the turn that started it and can be steered while running, so a task is an IM-hosted top-level session with its own record and status. Workers can still use subagents internally.

**Automatic retries for uncertain sends.** A lost response cannot establish whether the platform created the message. Keeping `uncertain` for inspection avoids automatic duplicates while allowing an intentional new tool call to send again.

## Consequences

One host process owns each IM store and session set; multi-host coordination requires a separate design. Hosted sessions stay resident in memory after first use (except `ephemeral` sessions, which dispose their agent after the first turn). Finite receipt retention (`retentionMs`) bounds event deduplication, while pending messages and pending receipts do not expire automatically. Scanning Session logs for inbox message IDs increases recovery cost for long session histories.
