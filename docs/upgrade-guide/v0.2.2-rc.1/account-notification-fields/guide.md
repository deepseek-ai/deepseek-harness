---
kind: upgrade-guide
description: "Generic account notification APIs replace bonus-specific methods and notification requests use the Harness domain."
---

# Update account notification consumers

English | [中文](guide.zh.md)

## Change

`DeepSeekAccount.getNotifications()` and `account/getNotifications` replace `getUnnotifiedBonuses()`. They return `AccountNotificationBatch.notifications` with opaque string `id`, `createdAt`, nullable `displayUntil`, localized `title` and `body`, ordered `actions`, and optional JSON `data`. The batch also requires `nextPollAfterSeconds`, projected from the wire field `next_poll_after`. Bonus metadata belongs in `data`; the bonus-specific types and fields are removed. `reportNotificationEvent()` replaces `ackBonusNotified()` and takes `(id, event, client)` to report `displayed`, `cta_clicked`, or `dismissed` using the notification ID. `getNotificationContent()` reads localized content by notification ID, including consumed notifications, without changing consumption.

`DeepSeekAccount.watch()` and `account/watch` emit `AccountUpdate` items containing `type` and the complete `state`. Initial subscription and login progress use `snapshot`; credential writes and removal use `credentials-changed`.

The account provider adds `harnessOrigin`, defaulting to `https://harness.deepseek.com`, for notification list, content, and events. `platformOrigin` retains its `https://platform.deepseek.com` default for login, profile, balance, logout, external navigation, and native embedded pages. Grant issuer checks still use `platformOrigin`.

`ui-account-notifications` owns notifications; `ui-settings-account` supplies its account state, refresh events, and presentation slot.

## Migration

1. Read account state from `update.state`. A `credentials-changed` event or new Remote-stream generation clears notification state and restarts polling when signed in; progress snapshots retain it. Update providers, Remote consumers, and fixtures to use the new fields, opaque string IDs, and required delay in seconds. List decoding skips malformed or unsupported notifications individually; malformed envelopes still fail the request.
2. Remove notification account-ID arguments and the batch accountId field. `getNotificationContent(id, client)` and `reportNotificationEvent(id, event, client)` use the current token directly, without a profile preflight. Credential changes end old requests, cards, and polls; late replies are discarded. Report each event once; valid `acked: true` and `acked: false` responses both finish the attempt. Failed reports keep local card state and are not retried. Report `displayed` after presentation, `cta_clicked` for every non-dismiss action with no action ID, and only `dismissed` after explicit close. Action clicks retain the card and execute without waiting for the report; closing before presentation does not generate a display event; expiry and account cleanup do not count as dismissal. Refresh current cards through `getNotificationContent()` when the language changes; retain their position and avoid another display event.
3. Remove `bonusAckRetryDelayMs` and `bonusAckRetryMaxDelayMs` from `ui-settings-account` configuration; event reporting has no retry settings. A failed report does not undo the current interaction or retry that report. If a later list offers a closed notification again, the client displays it again.
4. Keep existing `platformOrigin` configuration. Private deployments and loopback fixtures set `harnessOrigin` to their notification service origin. Confirm only list, content, and events use that origin; login, profile, balance, logout, and pages retain `platformOrigin`.
5. Load `@deepseek-ai/dsh-client-ui-account-notifications` beside account settings. Set its new `notificationPollIntervalMs` option when the ten-minute initial interval is unsuitable. Move notification-state and reporting consumers to the new plugin. Verify both plugins share one account stream, including after notification-plugin reload.
