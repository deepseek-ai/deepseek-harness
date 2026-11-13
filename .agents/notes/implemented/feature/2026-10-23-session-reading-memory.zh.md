# Agent Note: 宿主内存中的会话阅读状态

Status: implemented

[English](2026-10-23-session-reading-memory.md) | 中文

## 问题

连接同一宿主的前端需要一致的阅读提醒，包括所有前端都离线时结束的轮次。自动阅读确认不能清除尚未看到的完成提醒或手动未读标记。阅读行为不能改变模型历史。这些提醒显示在 [`@deepseek-ai/dsh-client-ui-session-status`](../../../../packages/client/ui-session-status/README.zh.md) 拥有的前端会话状态表中，因此阅读记录、它的前端订阅方和使用它的状态表需要同一个归属方，而且其前端面能够订阅宿主 Remote 流。

## 决策

### 包结构

`@deepseek-ai/dsh-client-ui-session-status` 在两个面上拥有该功能，沿用 ui-trajectory 同时提供宿主面和前端面的先例：

| 面 | 服务 | 职责 |
|---|---|---|
| 宿主（`.`） | `ctx.sessionStatus`（`SessionStatusService`） | 在内存 Map 中为每个会话保存一条阅读记录；Remote 命名空间 `sessionStatus` 提供 `mark` 和 `follow`；失败使用 `session-status/not-found` 和 `session-status/unavailable` |
| 前端（`./client`） | `ctx.uiSession.sessionStatus`（服务名 `uiSession.sessionStatus`） | 订阅宿主阅读流，构建含 `completionUnread` 和 `completionFailed` 的状态表，提供 `mark` 和 `readingReady`，并确认主视图已读 |

前端的阅读记录副本是包内部模块：它不导出任何值或类型，也不提供自己的前端服务，因此 ui-workspace、ui-conversation 等使用方只依赖 `ctx.uiSession.sessionStatus` 和导出的状态类型。Web bundle 中唯一的 `ui-session-status` 行加载两个面，api/remotes 挂载本包的 `/remote` 描述，Web 前端把本包列为启动必需入口。ui-session、待交互登记和 `ctx.uiSession.pendingInteractions` 保持不变。

### 前端依赖规则

订阅宿主流在运行时需要 Gateway 的 `RemoteSnapshotStream`。`verify-client-packages` 允许 `packages/client` 下的功能包通过 `dsh.client.external` 请求 `packages/api/` 下的行，但仍拒绝请求另一个功能插件的行；Remote API 组是基础设施，不是功能插件。本包只请求 `@deepseek-ai/dsh-api-gateway/client`。只有 `ctx.remoteAccess` 允许 `sessionStatus/follow` 时才运行该流；该端点在 LiveShare 中仅限所有者，因此查看者页面不打开该流，`readingReady` 保持 false，也不报告同步失败。

`RemoteStream` 按稳定的 error code `gateway/carrier-lost` 判断是否重连，而不是按 `instanceof RemoteStreamCarrierError`。该 class 自带这个 code，现有调用方行为不变；本包的 `ended` 回调返回带该 code 的普通 `Error`，用导出的 `RemoteStreamCarrierFailure` 类型描述，而不导入该 class。该 code 只在前端进程内产生：宿主返回的 `RemoteError` 即使带有相同 code 也会终止流。

### 宿主记录

宿主服务在内存中为每个会话保存一条记录，自己从 `turn/end` 事件取得最近结束的轮次及其失败标记。修改同步更新 Map。已读请求携带前端已看到的完成轮次；宿主单调推进阅读位置，且不越过已知完成位置。自动确认保留手动未读，主动标记按宿主处理顺序替换它。前端只通过有序基线和整条记录的更新流取得状态，修改回复不需要记录或版本。

对冷会话的标记只读取元信息，不打开历史。没有记录的会话按已读处理，因此历史既不需要启动扫描，也不需要区分冷会话和零轮次的活跃会话。关闭时结束订阅并清空记录；尚在等待元信息的标记请求会在查询返回后被拒绝，不会为了内存写入延迟卸载。

### 自动确认

只有可见且聚焦的主视图会确认阅读，并等待一次渲染帧及正文已到达完成轮次的证据。窗口聚焦只推进自然已读位置。主视图切换到另一个会话（包括页面加载后的首次选中）时，会在正文到达后清除该会话已有的手动提醒；检查会等待阅读基线就绪。窗口聚焦、同一会话更换 binding 以及在已打开会话中的操作都不会清除它，因此在已打开会话中做的标记会保留到视图切走再切回。后续自动确认保留手动标记，包括正文加载期间收到的标记。把规则留在确认插件内部，可以避免跨包的阅读事件，也不需要修改 Conversation 正文。可见且聚焦的主视图持有某个已打开的会话时，状态表不显示该会话尚未确认的完成轮次，避免在确认往返完成前闪现未读；手动标记照常显示，窗口失焦或视图先行切走时提醒会重新出现。归档行按已读处理，不提供阅读标记。

## 考虑过的替代方案

- **ui-session 读取阅读状态：** 基础 UI 包会依赖功能包，阅读插件缺席时其上的所有界面都无法启动。
- **单独的阅读包并提供前端服务：** 使用方会在 `ctx.uiSession.sessionStatus` 之外看到第二套阅读 API，状态表也只为汇总记录而依赖另一个包的服务。
- **在前端状态表旁另建 api 组阅读包：** 把一个功能拆到两个包中，而宿主接口、前端订阅方和状态表同步演进；放宽 external 规则后，前端包可以自己订阅该流。
- **在 `ctx.remote.$stream` 之上重写快照协议：** 会在功能包中复制 Gateway 负责的基线与重连逻辑。
- **在前端包中导入 `RemoteStreamCarrierError`：** 功能包会为一次重试判断依赖 Gateway 的 class 身份；稳定的 code 能表达这一判断，而不依赖跨独立打包模块的 class 身份。
- **宿主面放在共享基础 bundle：** 没有 Web 前端的 profile 会运行无人读取的阅读服务，宿主面也会与前端面从不同的 bundle 加载。
- **前端内存或本地存储：** 无法为浏览器和 Desktop 前端提供共同的权威状态，也无法收集所有前端离线期间的完成提醒。
- **宿主持久化记录：** 能够让提醒跨宿主重启保留，但需要单独设计会话检查点、存储域归属、后端关闭及写入失败的生命周期。本实现将状态限制在内存，持久化另行实现。
- **在会话日志中记录阅读事件：** 会把使用者意图混入模型历史，并使只需元信息的操作也要加载冷会话历史。
- **按版本条件写入：** 可防止延迟的主动操作覆盖较新的手动意图，但需要冲突响应、版本维护和请求响应的状态合并。会话提醒接受宿主处理顺序，仍保留阅读位置以防误读新完成内容。
- **消息 ID 游标：** 只能定位消息，不能直接排序已完成轮次，也不能覆盖未产生新助手消息的失败。已有完成轮次直接对应本功能的进度单位。

## 结果

宿主服务运行期间，刷新浏览器或临时断线会保留提醒。宿主重启或插件重载会重置全部阅读记录，并把已有历史视为已读；重启前失败的轮次不留下结果，因此把该会话标为未读时显示普通提醒。不含 Web bundle 的 profile 不运行阅读服务。没有阅读状态文件、存储域依赖、检查点写入或跨进程同步保证。会话从内存卸载后，其提醒保留到服务停止；回收记录需要会话删除生命周期。

并发主动操作以宿主最后处理的操作为准；进入视图的确认可能清除处理前到达的另一条手动标记。验证覆盖双订阅、单调阅读位置与自动确认保留手动标记、手动标记后的首次完成、访问权限变化后的新基线、元信息查询期间关闭、服务重载、不依赖会话刷盘，以及结束轮次的失败标记。前端测试覆盖阅读流的基线替换与终态失败、正文延迟、加载期间的手动标记，以及主视图切换时清除手动提醒、窗口聚焦或更换 binding 时不清除。Gateway 测试覆盖带 carrier code 的普通错误会重连、不带 code 时终止。启用持久化前，需单独验证重启恢复、崩溃一致性、存储提供方关闭顺序和跨进程写入。当前主视图保留信号不能区分所有设置或辅助面板；该可见性细化仍属于通知工作的范围。
