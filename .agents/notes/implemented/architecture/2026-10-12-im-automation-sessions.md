# Agent Note: IM integration through automation sessions

Status: implemented

English | [中文](2026-10-12-im-automation-sessions.zh.md)

## Problem

IM combines delayed input, multiple participants, quoted messages, and platform redelivery. A task can consume several messages without publishing an answer to each one. Treating every message as a GUI prompt and every assistant response as a platform reply couples input scheduling to publication.

## Decision

IM hosts persistent sessions through the existing agent factory, inbox, presets, and persistence APIs, and lets a plugin decide which session an admitted message reaches. The agent loop and core Session categories are unchanged. The [IM service](../../../../packages/experimental/im/README.md) admits external context and provides [explicit tools](../../../../packages/experimental/im/src/tools.ts) for reading and publishing; the [IM bundle](../../../../packages/experimental/im-bundle/README.md) mounts the service and the adapters as Host rows of an existing profile.

Source admission, write grants, delivery mode, model route, working directory, and preset are explicit deployment choices: a `sources` rule decides which chats may reach the host and how their messages are stored, and `defaultDispatch` composes the single session every unhandled addressed message reaches. Every chat shares that session's history, so a deployment that needs per-chat history or background workers mounts its own plugin on the `im/message` waterfall.

The transport layer uses the vendored Satori packages (`plugin-im-core`, `satori-element`, `plugin-im-adapter-lark`, and `plugin-im-adapter-qq`). The [vendor manifest](../../../../vendor/im/README.md) documents exact upstream pins and local modifications. Generated Feishu declarations stay outside Git and are regenerated from hash-checked pinned sources during installation.

## Durability and ownership

One service instance holds the live `Agent` for each hosted session. The `im_sessions` storage domain records each hosted session with its owner, composition, and bindings, and rejects a session id that already exists outside the IM store. `im_messages` records each external event digest and message before platform ACK. A deterministic inbox message ID (`deliveryMessageId`) and a Session log check reconcile admission across restarts so redeliveries and crash recoveries do not duplicate inbox messages.

Outbound sends with an `operationId` record a `pending` receipt in `im_receipts` before network dispatch and update it with the result afterwards. Replaying the same `operationId` returns the recorded receipt without resending. A platform error code indicating nothing was published is recorded as `failed`; a lost response, timeout, or crash after dispatch is recorded as `uncertain` and is never automatically resent.

The `im` message source is attribution metadata only ([compatibility record](../../../../docs/persistence-changes/2026-10-28-im-message-source.md)). Permission decisions remain in the live IM service, and existing sandbox and approval policies continue to apply.

## Alternatives considered

**Another GUI client through Host controllers.** Suitable for transcript mirroring and typed interaction controls, but it introduces conversation policy and output coupling that automation does not need. IM uses the agent factory directly while retaining the existing loop.

**ACP between IM and the harness.** ACP supports persistent programmatic sessions and suits process separation. Independent IM publication still requires a channel or tool route; in-process Cordis composition avoids an additional process without changing automation semantics.

**Operator-configured fixed sessions per chat.** Naming each session and its sources by hand requires a configuration change and restart for every new chat. One session composed from `sources` and `defaultDispatch` keeps access control in source rules without per-chat configuration.

**Automatic retries for uncertain sends.** A lost response cannot establish whether the platform created the message. Keeping `uncertain` for inspection avoids automatic duplicates while allowing an intentional new tool call to send again.

## Consequences

One host process owns each IM store and session set; multi-host coordination requires a separate design. Hosted sessions stay resident in memory after first use (except `ephemeral` sessions, which dispose their agent after the first turn). Finite receipt retention (`retentionMs`) bounds event deduplication, while pending messages and pending receipts do not expire automatically. Scanning Session logs for inbox message IDs increases recovery cost for long session histories.
