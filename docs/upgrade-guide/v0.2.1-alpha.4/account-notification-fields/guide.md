---
kind: upgrade-guide
description: "AccountBonusNotification exposes unvalidated optional metadata and permits notices without an expiry."
---

# Update account notification consumers

English | [中文](guide.zh.md)

## Change

The public `AccountBonusNotification` returned by `DeepSeekAccount.getUnnotifiedBonuses()` and `account/getUnnotifiedBonuses` preserves `campaign`, `amount`, `currency`, and `grantedAt` as optional, unvalidated metadata typed as `JsonValue`. Notifications retain `orderId`, `message`, and `expiresAt`, and add an optional `title`. An empty `expiresAt` means the notification never expires. `orderId` accepts arbitrary strings rather than requiring UUIDs.

## Migration

1. Narrow the optional metadata values before using them; their presence and format are no longer guaranteed. Display `message` and use the client's default title when `title` is absent.
2. Treat an empty `expiresAt` as no expiry before parsing timestamps. Keep `orderId` unchanged when acknowledging a notification.
3. Update provider fixtures to use the current fields. Confirm that a notification with a non-UUID ID and empty expiry displays and can be acknowledged.
