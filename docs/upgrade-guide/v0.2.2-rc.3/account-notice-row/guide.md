---
kind: upgrade-guide
description: "Account notifications move from `settings.launcher.notifications` to `settings.notice.notifications` in a new row above the account launcher."
---

# Account notification slot rename

English | [中文](guide.zh.md)

## Change

The settings shell declares a new `settings.notice` slot and renders it in its own full-width row above the account launcher row; the collapsed rail hides the row. Account settings fills that row and declares the account notification slot there. The slot is renamed from `settings.launcher.notifications` to `settings.notice.notifications`; its owner props `active` and `openAccount` are unchanged. The account launcher no longer renders notifications.

## Migration

1. Rename `settings.launcher.notifications` to `settings.notice.notifications` in `ctx.slots.inject`, `ctx.slots.register`, and `PropsRuntime` references.
2. Remove absolute positioning that placed notification content above the launcher; the row already sits above it at full width.
3. Rebuild the extension and verify that its notification shows above the account row in the expanded sidebar and hides in the collapsed rail.
