---
description: "基于宿主阅读记录的 Client 会话状态表与 useSessionStatus hook：运行状态、生效的待交互请求，以及连接同一运行中宿主的前端共享的已读、未读提醒。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-status

[English](README.md) | 中文

## 概述

通过同一张前端状态表显示每个会话的运行状态、优先级最高的待交互请求和已读、未读提醒。提醒来自本包保存在宿主内存中的阅读记录：只要宿主仍在运行，刷新浏览器后提醒仍然保留；已连接的前端共享手动标记和阅读确认，也能收到所有前端离线期间完成的会话提醒。阅读标记不改变对话历史或模型请求。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Web bundle 中唯一的 `ui-session-status` 行同时加载两个面：宿主阅读服务 `ctx.sessionStatus`，以及在 [`dsh-client-ui-session`](../ui-session/README.zh.md) 之后加载、被 Web 前端列为启动必需入口的前端插件。不加载本包的组合没有状态表，也没有 `useSessionStatus` hook；不含 Web bundle 的 profile 不运行阅读服务。本包没有配置项，也不使用持久化存储。重启宿主或重新加载本插件会丢弃全部记录：历史重新按已读处理，之前的轮次结果不再保留。

通过会话行菜单**标为已读**或**标为未读**，连接同一宿主的前端会共享结果；操作失败时保留原有提醒并报告失败。本轮宿主运行期间结束的轮次都会产生未读提醒，无论正常完成、失败还是取消。失败标记只适用于本轮宿主看到失败的轮次；宿主启动前就结束的失败无法得知。已有历史默认为已读。在可见且聚焦的窗口中打开会话后，主视图会在一个渲染帧之后确认已加载的完成内容。主视图切换到某个会话（包括刷新页面后恢复主视图）时，会在内容到达后清除其已有的手动提醒。窗口聚焦和在已打开会话中的其他操作都会保留手动未读。未读提醒不表示任务成功，与运行和待交互状态分别显示。

组件通过根 hook `useSessionStatus` 读取状态表。读取 `ctx.uiSession.sessionStatus` 的前端插件需要在 `inject` 列表中加入 `'uiSession'` 和 `'uiSession.sessionStatus'`；否则 Cordis 会拒绝该属性读取。组件调用 `useSessionStatus` 的插件也注入 `'uiSession.sessionStatus'`，使插件随该 hook 一起卸载和重新加载。该成员声明在 ui-session 的 `UiSessionService`（`ctx.uiSession` 的类型）上；标注为 `UiSession` class 的值看不到它。

| 成员 | 用途 |
|---|---|
| `getSnapshot()` / `subscribe(listener)` | 按会话身份索引的状态；状态事实变化前快照保持同一引用，抛错的 listener 会被报告，不会阻止后续 listener |
| `mark(sessionId, unread)` | 把会话标为已读或未读；阅读状态未同步或宿主拒绝标记时拒绝 |
| `readingReady` | 是否已取得当前宿主的阅读基线 |

每个 `SessionStatus` 有四个字段：

| 字段 | 来源 |
|---|---|
| `running` | 宿主会话列表基线和 `api-session/status` 事件；两者都未建立之前为缺省。Subagent 目录行和已保留子会话的 fallback 行不会建立它。 |
| `pendingInteraction` | `ctx.uiSession.pendingInteractions` 为该会话发布的同一个对象。领域插件通过 `ctx.uiSession.registerPendingInteraction(precedence)` 登记请求。 |
| `completionUnread` | 宿主阅读记录带有手动未读标记，或其最近完成的轮次超过已读轮次；可见且聚焦的主视图正在显示该会话且其已打开时，不显示尚未确认的该轮次 |
| `completionFailed` | 会话未读，且最近完成的轮次以本宿主观察到的执行错误结束 |

宿主面通过 `sessionStatus` Remote 命名空间提供 `mark` 和 `follow`；失败使用 `session-status/not-found` 和 `session-status/unavailable`。前端保存的阅读记录副本是私有的：除 `ctx.uiSession.sessionStatus` 外，没有其他前端服务暴露这些记录。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

阅读记录放在宿主服务的 Map 中，只由 `turn/end` 事件和主动标记更新。每条记录包含 `completedTurn`、`failed`、`readTurn` 和 `manualUnread`。标记不会改变执行结果，也不会触发会话日志刷盘。

前端提交自己已看到的完成轮次。宿主只向前推进 `readTurn`，上限是提交位置与已知完成位置的较小值；自动确认保留 `manualUnread`。主动标为已读或未读按宿主处理顺序清除或设置该标记。冷会话的菜单操作只检查元数据，不打开历史。

只有有序订阅流更新前端记录，修改请求仅回复成功或失败。同步流先发送有权访问的完整快照，再推送完整记录。只有 `ctx.remoteAccess` 允许 `sessionStatus/follow` 时，前端才通过 `ctx.remote.$stream` 和 Gateway 的 `RemoteSnapshotStream` 跟随这些记录，因此 LiveShare 查看者不打开该流，`readingReady` 保持 false；流正常结束时返回带 Gateway `gateway/carrier-lost` code 的错误，因此流会重连，下一个快照替换记录。已有的访问流在授权变化时结束阅读订阅，前端重连后取得新快照。卸载会关闭订阅并清空记录，尚未返回的元数据查询不能再提交标记。

前端插件把会话列表基线、`api-session/status` 事件、ui-session 的待交互请求和阅读记录汇总为状态表，并以 `uiSession.sessionStatus` 的名字挂在 `ctx.uiSession` 下。它还确认主视图持有的会话。确认需要窗口可见且聚焦、会话已打开、经过一个渲染帧，且已加载的正文到达完成轮次。窗口聚焦只推进自然已读位置。主视图切换到另一个会话时，插件会在阅读基线就绪后检查该会话的手动未读标记，并在下一次确认时清除已有标记；同一会话只是更换 binding 不算切换，之后的确认保留手动标记。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [会话阅读记忆决策](../../../.agents/notes/implemented/feature/2026-10-23-session-reading-memory.zh.md)——包结构、宿主内存归属、并发和暂缓的持久化。
- [会话 UI 适配层](../ui-session/README.zh.md)——上级服务 `ctx.uiSession` 与待交互登记。
- [工作区浏览器](../ui-workspace/README.zh.md)——会话菜单与提醒。

-----

<a id="model-experience"></a>
## 模型体验

无，阅读记录和状态表不添加工具、提示词或会话事件。

#### KV Cache 影响

无；阅读标记和状态表不参与模型请求构建。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

阅读状态有以下运行限制：

- **并发主动标记**——以宿主最后处理的操作为准，不比较版本；延迟的主动已读可能清除较新的手动未读。自动确认（`acknowledge`）不会清除手动未读，也不会越过提交的阅读位置。唯一会自动清除手动未读的是上文的主视图切换规则，包括刷新后恢复主视图；它只在该页面可见、聚焦且正在显示该会话时生效。
- **单个宿主进程**——不同宿主进程或机器之间不互相同步。
- **宿主重启或插件重载**——全部阅读状态重置，历史按已读处理。重启前失败的轮次不保留结果，因此把这类会话标为未读时显示普通未读提醒。重载宿主插件会结束所有阅读流；前端重连时如果新服务尚未就绪，会收到终止错误并禁用阅读操作，只有刷新页面后才能恢复。持久化提醒由单独跟踪的后续需求负责；本包不写入阅读状态文件。
- **仅 Web profile**——本包的行位于 Web bundle，不包含该行的 profile 不运行阅读服务。
- **元信息和传输失败**——元信息查询失败不改变阅读状态。流或协议的终态失败会禁用阅读操作，直到刷新页面；普通连接中断会自动重连。
- **已卸载和已归档的会话**——会话从内存卸载后，其记录保留到服务停止；回收记录需要会话删除生命周期。归档行隐藏未读样式和状态，按已读处理，行菜单和快捷键都不提供阅读标记。
- **主视图可见性**——主视图保留信号不能区分所有设置或辅助面板，因此这类面板遮住对话时仍可能确认阅读，状态表也会隐藏该已打开会话尚未确认的完成轮次；该细化属于通知工作的范围。
- **不提供消息计数或他人的阅读回执**——状态属于宿主的使用者，只记录会话级提醒。LiveShare 查看者不能读取或修改该状态。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文——点击展开</summary>

无。

</details>
