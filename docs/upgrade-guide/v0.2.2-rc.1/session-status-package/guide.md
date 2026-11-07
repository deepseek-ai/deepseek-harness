---
kind: upgrade-guide
description: "SessionStatus, SessionStatusSnapshot, UseSessionStatus, and the useSessionStatus hook move from @deepseek-ai/dsh-client-ui-session/client to @deepseek-ai/dsh-api-session-status/client, and ctx.uiSession.sessionStatus becomes the separate uiSession.sessionStatus service that readers inject."
---

# Session status moves to `@deepseek-ai/dsh-api-session-status`

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-client-ui-session/client` no longer exports `SessionStatus`, `SessionStatusSnapshot`, or `UseSessionStatus`, and ui-session no longer declares or provides the `useSessionStatus` root hook. Both now belong to the Client half of [`@deepseek-ai/dsh-api-session-status`](../../../../packages/api/session-status/README.md), which the Web bundle loads beside ui-session. The `SessionStatus` fields `running`, `pendingInteraction`, and `completionUnread` and their meaning are unchanged. A Client composition that loads ui-session without session-status has no status table and no `useSessionStatus` hook.

`ctx.uiSession.sessionStatus` is now the separate `uiSession.sessionStatus` service. Reading it through `ctx.uiSession.sessionStatus.getSnapshot()` and `subscribe()` keeps its form, but a plugin that reads it without injecting `'uiSession.sessionStatus'` fails with `cannot get property "uiSession.sessionStatus" without inject`. `ctx.uiSession` now has the type `UiSessionService`, which extends the unchanged `UiSession` class with members such as `sessionStatus`; a value annotated as `UiSession` does not show `sessionStatus`.

Pending interactions stay in ui-session: `ctx.uiSession.registerPendingInteraction(precedence)`, `SessionPendingInteractionBase`, `SessionPendingInteractionMap`, `SessionPendingInteraction`, and `PendingInteractionPublisher` keep their names, behavior, and `@deepseek-ai/dsh-client-ui-session/client` export. Declarations that extend `SessionPendingInteractionMap` keep targeting that module. ui-session additionally exposes the read-only `ctx.uiSession.pendingInteractions` source.

This affects Client plugins and tests that import the three status types, render components that read `useSessionStatus`, or read `ctx.uiSession.sessionStatus`.

## Migration

1. Import `SessionStatus`, `SessionStatusSnapshot`, and `UseSessionStatus` from `@deepseek-ai/dsh-api-session-status/client`. A package whose components read `useSessionStatus` without importing these types adds `import type {} from '@deepseek-ai/dsh-api-session-status/client'` so its program sees the hook declaration. Declare the package in `devDependencies`, `dsh.client.inject`, and the TypeScript project references.
2. In each plugin that reads `ctx.uiSession.sessionStatus`, add `'uiSession.sessionStatus'` after `'uiSession'` in `inject`. A plugin that only needs the effective pending request may read and subscribe to `ctx.uiSession.pendingInteractions` instead.
3. Where code passes `ctx.uiSession` through a parameter or field annotated as `UiSession` and then reads `sessionStatus`, annotate it as `UiSessionService` from `@deepseek-ai/dsh-client-ui-session/client`.
4. Leave `registerPendingInteraction` calls and `declare module '@deepseek-ai/dsh-client-ui-session/client'` augmentations of `SessionPendingInteractionMap` unchanged.
5. A custom Client composition that loads `@deepseek-ai/dsh-client-ui-session` also loads `@deepseek-ai/dsh-api-session-status`, so `useSessionStatus` remains available.
6. Confirm that the plugin type-checks and that a Session row still shows its running or waiting indicator.
