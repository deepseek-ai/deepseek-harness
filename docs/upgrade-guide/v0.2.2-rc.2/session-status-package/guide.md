---
kind: upgrade-guide
description: "Session status types and the useSessionStatus hook move to @deepseek-ai/dsh-client-ui-session-status/client, ctx.uiSession.sessionStatus becomes an injected service, and completion reminders follow Host reading records."
---

# Session status moves to `@deepseek-ai/dsh-client-ui-session-status` and completion reminders follow Host reading records

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-client-ui-session/client` no longer exports `SessionStatus`, `SessionStatusSnapshot`, or `UseSessionStatus`, and ui-session no longer declares or provides the `useSessionStatus` root hook. Both now belong to the Client plugin [`@deepseek-ai/dsh-client-ui-session-status`](../../../../packages/client/ui-session-status/README.md), one Web bundle row with a Host reading service and the Client table. A Client composition that loads ui-session without ui-session-status has no status table and no `useSessionStatus` hook.

`ctx.uiSession.sessionStatus` is now the separate `uiSession.sessionStatus` service. Reading it through `ctx.uiSession.sessionStatus.getSnapshot()` and `subscribe()` keeps its form, but a plugin that reads it without injecting `'uiSession.sessionStatus'` fails with `cannot get property "uiSession.sessionStatus" without inject`. Components of a plugin without that injection fail with `useSessionStatus is not a function` after the table unloads. `ctx.uiSession` now has the type `UiSessionService`, which extends the unchanged `UiSession` class with members such as `sessionStatus`; a value annotated as `UiSession` does not show `sessionStatus`.

Pending interactions stay in ui-session: `ctx.uiSession.registerPendingInteraction(precedence)`, `SessionPendingInteractionBase`, `SessionPendingInteractionMap`, `SessionPendingInteraction`, and `PendingInteractionPublisher` keep their names, behavior, and `@deepseek-ai/dsh-client-ui-session/client` export. Extensions of `SessionPendingInteractionMap` keep targeting that module. ui-session additionally exposes the read-only `ctx.uiSession.pendingInteractions` source.

`completionUnread` follows Host-memory reading records shared by every Client and changes through Host completions, explicit marks, and visible main-view acknowledgement; only a main-view switch, including a reload, clears a manual mark. The open viewed Session hides its unacknowledged turn; earlier history reads as read. The required `completionFailed` field marks an unread Session whose latest turn failed. The new `mark(sessionId, unread)` rejects until `readingReady` reports the Host baseline.

This affects Client plugins and tests that import the three status types, construct `SessionStatus` values, render components that read `useSessionStatus`, or read `ctx.uiSession.sessionStatus`.

## Migration

1. Import `SessionStatus`, `SessionStatusSnapshot`, and `UseSessionStatus` from `@deepseek-ai/dsh-client-ui-session-status/client`. A package that only imports these types, for example in tests, declares `@deepseek-ai/dsh-client-ui-session-status` in `devDependencies` and its TypeScript project references.
2. A package whose components call `useSessionStatus` also lists the package in `dsh.client.inject`, adds `import type {} from '@deepseek-ai/dsh-client-ui-session-status/client'` when it imports none of the types, and adds `'uiSession.sessionStatus'` to the Cordis `inject` of the plugin that registers them.
3. Each plugin that reads `ctx.uiSession.sessionStatus` adds `'uiSession.sessionStatus'` to `inject`; one that needs only the effective pending request may subscribe to `ctx.uiSession.pendingInteractions` instead.
4. Where code passes `ctx.uiSession` through a parameter or field annotated as `UiSession` and then reads `sessionStatus`, annotate it as `UiSessionService` from `@deepseek-ai/dsh-client-ui-session/client`.
5. Leave `registerPendingInteraction` calls and `declare module '@deepseek-ai/dsh-client-ui-session/client'` augmentations of `SessionPendingInteractionMap` unchanged.
6. Add `completionFailed` to `SessionStatus` values in tests and fixtures, and script Host reading records to drive `completionUnread`.
7. A custom composition that loads `@deepseek-ai/dsh-client-ui-session` also loads `@deepseek-ai/dsh-client-ui-session-status` as a plugin row, so its Host reading service and `useSessionStatus` are available.
8. Confirm that the plugin type-checks, that a Session row still shows its running or waiting indicator, and that a Session finishing outside the main view shows an unread reminder.
