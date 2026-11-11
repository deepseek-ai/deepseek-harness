---
kind: upgrade-guide
description: "SessionStatus, SessionStatusSnapshot, UseSessionStatus, and the useSessionStatus hook move from @deepseek-ai/dsh-client-ui-session/client to @deepseek-ai/dsh-client-ui-session-status/client, and ctx.uiSession.sessionStatus becomes the separate uiSession.sessionStatus service that readers inject."
---

# Session status moves to `@deepseek-ai/dsh-client-ui-session-status`

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-client-ui-session/client` no longer exports `SessionStatus`, `SessionStatusSnapshot`, or `UseSessionStatus`, and ui-session no longer declares or provides the `useSessionStatus` root hook. Both now belong to the Client plugin [`@deepseek-ai/dsh-client-ui-session-status`](../../../../packages/client/ui-session-status/README.md), which the Web bundle loads beside ui-session. The `SessionStatus` fields `running`, `pendingInteraction`, and `completionUnread` and their meaning are unchanged. A Client composition that loads ui-session without ui-session-status has no status table and no `useSessionStatus` hook.

`ctx.uiSession.sessionStatus` is now the separate `uiSession.sessionStatus` service. Reading it through `ctx.uiSession.sessionStatus.getSnapshot()` and `subscribe()` keeps its form, but a plugin that reads it without injecting `'uiSession.sessionStatus'` fails with `cannot get property "uiSession.sessionStatus" without inject`. A plugin whose components call `useSessionStatus` without that injection stays active when the status table unloads, and its components then fail with `useSessionStatus is not a function`. `ctx.uiSession` now has the type `UiSessionService`, which extends the unchanged `UiSession` class with members such as `sessionStatus`; a value annotated as `UiSession` does not show `sessionStatus`.

Pending interactions stay in ui-session: `ctx.uiSession.registerPendingInteraction(precedence)`, `SessionPendingInteractionBase`, `SessionPendingInteractionMap`, `SessionPendingInteraction`, and `PendingInteractionPublisher` keep their names, behavior, and `@deepseek-ai/dsh-client-ui-session/client` export. Declarations that extend `SessionPendingInteractionMap` keep targeting that module. ui-session additionally exposes the read-only `ctx.uiSession.pendingInteractions` source.

This affects Client plugins and tests that import the three status types, render components that read `useSessionStatus`, or read `ctx.uiSession.sessionStatus`.

## Migration

1. Import `SessionStatus`, `SessionStatusSnapshot`, and `UseSessionStatus` from `@deepseek-ai/dsh-client-ui-session-status/client`. A package that only imports these types, for example in tests, declares `@deepseek-ai/dsh-client-ui-session-status` in `devDependencies` and its TypeScript project references.
2. A package whose source components call `useSessionStatus` additionally lists the package in `dsh.client.inject`, adds `import type {} from '@deepseek-ai/dsh-client-ui-session-status/client'` when it imports none of the types, and adds `'uiSession.sessionStatus'` to the Cordis `inject` of the plugin that registers those components, so the plugin unloads and reloads with the status table.
3. In each plugin that reads `ctx.uiSession.sessionStatus` in JavaScript, add `'uiSession.sessionStatus'` to `inject`. A plugin that only needs the effective pending request may read and subscribe to `ctx.uiSession.pendingInteractions` instead.
4. Where code passes `ctx.uiSession` through a parameter or field annotated as `UiSession` and then reads `sessionStatus`, annotate it as `UiSessionService` from `@deepseek-ai/dsh-client-ui-session/client`.
5. Leave `registerPendingInteraction` calls and `declare module '@deepseek-ai/dsh-client-ui-session/client'` augmentations of `SessionPendingInteractionMap` unchanged.
6. A custom Client composition that loads `@deepseek-ai/dsh-client-ui-session` also loads `@deepseek-ai/dsh-client-ui-session-status`, so `useSessionStatus` remains available.
7. Confirm that the plugin type-checks and that a Session row still shows its running or waiting indicator.
