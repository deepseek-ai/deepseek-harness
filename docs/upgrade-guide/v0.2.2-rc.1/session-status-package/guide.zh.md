---
kind: upgrade-guide
description: "SessionStatus、SessionStatusSnapshot、UseSessionStatus 和 useSessionStatus hook 从 @deepseek-ai/dsh-client-ui-session/client 移到 @deepseek-ai/dsh-client-ui-session-status/client，ctx.uiSession.sessionStatus 改为读取方需要注入的独立 uiSession.sessionStatus 服务。"
---

# 会话状态移到 `@deepseek-ai/dsh-client-ui-session-status`

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-client-ui-session/client` 不再导出 `SessionStatus`、`SessionStatusSnapshot` 或 `UseSessionStatus`，ui-session 也不再声明或提供根 hook `useSessionStatus`。它们现在属于 Client 插件 [`@deepseek-ai/dsh-client-ui-session-status`](../../../../packages/client/ui-session-status/README.zh.md)，Web bundle 会与 ui-session 一起加载它。`SessionStatus` 的字段 `running`、`pendingInteraction`、`completionUnread` 及其含义不变。只加载 ui-session、不加载 ui-session-status 的 Client 组合没有状态表，也没有 `useSessionStatus` hook。

`ctx.uiSession.sessionStatus` 现在是独立的 `uiSession.sessionStatus` 服务。通过 `ctx.uiSession.sessionStatus.getSnapshot()` 和 `subscribe()` 读取的写法不变，但未注入 `'uiSession.sessionStatus'` 就读取它的插件会报错 `cannot get property "uiSession.sessionStatus" without inject`。`ctx.uiSession` 的类型改为 `UiSessionService`，它在不变的 `UiSession` class 之上加入 `sessionStatus` 等成员；标注为 `UiSession` 的值看不到 `sessionStatus`。

待交互仍归 ui-session：`ctx.uiSession.registerPendingInteraction(precedence)`、`SessionPendingInteractionBase`、`SessionPendingInteractionMap`、`SessionPendingInteraction` 和 `PendingInteractionPublisher` 的名称、行为以及从 `@deepseek-ai/dsh-client-ui-session/client` 的导出都不变。扩展 `SessionPendingInteractionMap` 的声明继续指向该模块。ui-session 另外提供只读的 `ctx.uiSession.pendingInteractions` 数据源。

受影响的是导入这三个状态类型、渲染读取 `useSessionStatus` 的组件，或读取 `ctx.uiSession.sessionStatus` 的 Client 插件和测试。

## 迁移

1. 从 `@deepseek-ai/dsh-client-ui-session-status/client` 导入 `SessionStatus`、`SessionStatusSnapshot` 和 `UseSessionStatus`。组件读取 `useSessionStatus` 但不导入这些类型的包，加入 `import type {} from '@deepseek-ai/dsh-client-ui-session-status/client'`，让其程序看到该 hook 的声明。在 `devDependencies`、`dsh.client.inject` 和 TypeScript 项目引用中声明该包。
2. 在每个读取 `ctx.uiSession.sessionStatus` 的插件中，把 `'uiSession.sessionStatus'` 加到 `inject` 列表的 `'uiSession'` 之后。只需要生效待交互请求的插件，可以改为读取并订阅 `ctx.uiSession.pendingInteractions`。
3. 代码把 `ctx.uiSession` 传给标注为 `UiSession` 的参数或字段、之后又读取 `sessionStatus` 时，把标注改为 `@deepseek-ai/dsh-client-ui-session/client` 的 `UiSessionService`。
4. `registerPendingInteraction` 调用和对 `SessionPendingInteractionMap` 的 `declare module '@deepseek-ai/dsh-client-ui-session/client'` 扩展保持不变。
5. 加载 `@deepseek-ai/dsh-client-ui-session` 的自定义 Client 组合同时加载 `@deepseek-ai/dsh-client-ui-session-status`，使 `useSessionStatus` 继续可用。
6. 确认插件通过类型检查，并且会话行仍显示运行或等待标记。
