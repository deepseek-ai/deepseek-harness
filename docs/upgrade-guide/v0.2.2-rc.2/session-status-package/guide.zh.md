---
kind: upgrade-guide
description: "会话状态类型与 useSessionStatus hook 移到 @deepseek-ai/dsh-client-ui-session-status/client，ctx.uiSession.sessionStatus 改为需要注入的服务，完成提醒改为跟随宿主阅读记录。"
---

# 会话状态移到 `@deepseek-ai/dsh-client-ui-session-status`，完成提醒改由宿主阅读记录提供

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-client-ui-session/client` 不再导出 `SessionStatus`、`SessionStatusSnapshot` 或 `UseSessionStatus`，ui-session 也不再声明或提供根 hook `useSessionStatus`。它们现在属于 Client 插件 [`@deepseek-ai/dsh-client-ui-session-status`](../../../../packages/client/ui-session-status/README.zh.md)，即 Web bundle 中同时提供宿主阅读服务和前端状态表的一行。只加载 ui-session、不加载 ui-session-status 的 Client 组合没有状态表，也没有 `useSessionStatus` hook。

`ctx.uiSession.sessionStatus` 现在是独立的 `uiSession.sessionStatus` 服务。通过 `ctx.uiSession.sessionStatus.getSnapshot()` 和 `subscribe()` 读取的写法不变，但未注入 `'uiSession.sessionStatus'` 就读取它的插件会报错 `cannot get property "uiSession.sessionStatus" without inject`。未注入该服务的插件，其组件会在状态表卸载后报错 `useSessionStatus is not a function`。`ctx.uiSession` 的类型改为 `UiSessionService`，它在不变的 `UiSession` class 之上加入 `sessionStatus` 等成员；标注为 `UiSession` 的值看不到 `sessionStatus`。

待交互仍归 ui-session：`ctx.uiSession.registerPendingInteraction(precedence)`、`SessionPendingInteractionBase`、`SessionPendingInteractionMap`、`SessionPendingInteraction` 和 `PendingInteractionPublisher` 的名称、行为以及从 `@deepseek-ai/dsh-client-ui-session/client` 的导出都不变。扩展 `SessionPendingInteractionMap` 的声明继续指向该模块。ui-session 另外提供只读的 `ctx.uiSession.pendingInteractions` 数据源。

`completionUnread` 跟随宿主内存中、由所有前端共享的阅读记录，因宿主完成轮次、主动标记和可见主视图的确认而变化；只有主视图切换到该会话（包括刷新后恢复）会自动清除手动标记。正在查看且已打开的会话不显示尚未确认的轮次；宿主启动前已有的历史按已读处理。新增的必填字段 `completionFailed` 标记最近一轮失败的未读会话。新增的 `mark(sessionId, unread)` 在 `readingReady` 报告取得宿主基线之前会拒绝。

受影响的是导入这三个状态类型、构造 `SessionStatus` 值、渲染读取 `useSessionStatus` 的组件，或读取 `ctx.uiSession.sessionStatus` 的 Client 插件和测试。

## 迁移

1. 从 `@deepseek-ai/dsh-client-ui-session-status/client` 导入 `SessionStatus`、`SessionStatusSnapshot` 和 `UseSessionStatus`。只导入这些类型（例如只在测试中导入）的包，在 `devDependencies` 和 TypeScript 项目引用中声明 `@deepseek-ai/dsh-client-ui-session-status`。
2. 组件调用 `useSessionStatus` 的包，另外在 `dsh.client.inject` 中列出该包；不导入任何上述类型时加入 `import type {} from '@deepseek-ai/dsh-client-ui-session-status/client'`；并在注册这些组件的插件的 Cordis `inject` 中加入 `'uiSession.sessionStatus'`。
3. 每个读取 `ctx.uiSession.sessionStatus` 的插件把 `'uiSession.sessionStatus'` 加入 `inject`；只需要生效待交互请求的插件，可以改为订阅 `ctx.uiSession.pendingInteractions`。
4. 代码把 `ctx.uiSession` 传给标注为 `UiSession` 的参数或字段、之后又读取 `sessionStatus` 时，把标注改为 `@deepseek-ai/dsh-client-ui-session/client` 的 `UiSessionService`。
5. `registerPendingInteraction` 调用和对 `SessionPendingInteractionMap` 的 `declare module '@deepseek-ai/dsh-client-ui-session/client'` 扩展保持不变。
6. 在测试和 fixture 的 `SessionStatus` 值中加入 `completionFailed`，并编排宿主阅读记录来驱动 `completionUnread`。
7. 加载 `@deepseek-ai/dsh-client-ui-session` 的自定义组合同时以插件行加载 `@deepseek-ai/dsh-client-ui-session-status`，使其宿主阅读服务和 `useSessionStatus` 可用。
8. 确认插件通过类型检查、会话行仍显示运行或等待标记，并且在主视图之外结束的会话显示未读提醒。
