---
kind: upgrade-guide
description: "Move account plugin composition and Remote imports to the concrete deepseek-account service."
---

# Account service and Remote imports

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-deepseek-account` is a concrete `DeepSeekAccount` service owning browser login, stored credentials, and the `account` Remote namespace. The abstract account class, `@deepseek-ai/dsh-deepseek-account-platform`, and `@deepseek-ai/dsh-api-account-controller` are removed. Existing `ctx.deepseekAccount` and `ctx.remote.account` operations retain their names and arguments. Host-only credential methods are not Remote operations. The `/types` entry remains available without loading the service implementation.

Stored credentials keep the `deepseek-account-platform/default` and `deepseek-account-platform/device` keys; this package change does not require signing in again.

## Migration

1. Replace `@deepseek-ai/dsh-deepseek-account-platform` with `@deepseek-ai/dsh-deepseek-account` in custom plugin rows and dependencies. Keep the existing `deepseek-account` row id and configuration. Remove any `account-controller` row and its package dependency.
2. Import `DeepSeekAccount` instead of `PlatformAccount`. The class is concrete; custom subclasses of the former abstract account definition must be updated. Existing imports of shared types from `@deepseek-ai/dsh-deepseek-account/types` remain valid.
3. Replace old provider or controller `/remote` and `/typert` imports with `@deepseek-ai/dsh-deepseek-account/remote` and `@deepseek-ai/dsh-deepseek-account/typert`.
4. Import Platform header and cookie helpers from `@deepseek-ai/dsh-deepseek-account/client-metadata`. Read the configuration schema from `DeepSeekAccount.Config`. Stop calling `installAccountTaskCancellation` directly: mounting the service installs it. `isRunningAccountTask` is internal.
5. Rebuild custom compositions and verify login, notification queries, sign-out, and cancellation of account state subscriptions. Confirm that Remote exports omit `resolveToken`, `rejectToken`, `getPlatformSession`, and `getDeviceIdentity`.
