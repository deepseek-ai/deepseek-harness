---
kind: upgrade-guide
description: "Agent Teams removes its pending-message limit and stops delivering historical queued mail."
---

# Agent Teams messages use target inboxes

English | [中文](guide.zh.md)

## Change

The experimental Agent Teams plugin sends new messages directly to the target Agent inbox instead of retaining a separate Team mailbox. `send_message` returns only `{ "sent": true }`; it exposes neither a message ID nor an `accepted` or `queued` status. Acceptance does not confirm model processing or a synchronous storage flush. Failed sends are not retained for retry, and explicit resends are not deduplicated.

The `maxPendingMessagesPerMember` configuration key is removed. Historical `team/message/queued` and `team/message/delivered` records remain readable, but queued messages that were not delivered before upgrading are never dispatched. Roster and task state remain durable.

## Migration

1. Before upgrading, let pending Team messages finish and confirm that their targets received them. After upgrading, explicitly resend any required undelivered message; check the target's history first to avoid duplicates. Do not edit historical Session records.
2. Remove `maxPendingMessagesPerMember` from the `@deepseek-ai/dsh-experimental-agent-team` plugin configuration in your `cordis.yml` or overlays. There is no replacement Team queue limit; `maxMessageBytes` still bounds each complete sender-framed message.
3. Update any consumer of `send_message` results to read `sent` instead of message IDs or delivery statuses, and handle send errors explicitly. Do not treat success as completed target work. The `ctx.agentTeams.sendMessage()` service still returns `messageId`.
4. Start your Team-enabled profile, send a message to another member, and confirm that the tool returns `{ "sent": true }` and that the target receives it. Consult the [package reference](../../../../packages/experimental/agent-team/README.md#use-this-package) for delivery semantics.
