# Agent Note: Client Session、Conversation 与 UI 所有权分层

Status: implemented

[English](2026-08-20-client-session-conversation-ownership.md) | 中文

## 问题

Web Client 曾由一个通用 Runtime 同时承载 Session 与 Workspace 对象、事件窗口、Conversation 组装、React hooks、Slot 注册表和 Store 引擎。协议状态、业务投影、React 绑定和页面呈现共享同一个依赖汇点，任何一层的变化都可能扩大到完整前端。

Session 快照也容易混入事件数组、Conversation View、Chat Node 和待处理交互等并非 Session 自身拥有的数据。普通消费者由此需要理解事件重放与具体视图，新增一个 Conversation target 也可能要求修改 Session、Runtime 和 renderer。

React 生命周期与 Session 生命周期之间缺少明确接口时，binding 释放、Hook source 替换和 Slot store 清理会演变为互相回调的专用协议。Approval 与 Question 同时影响侧边栏状态和 composer takeover；若两处各自维护状态，它们还可能选择不同的待处理请求。

需要把数据 owner、React adapter、通用渲染机制和具体视图拆成单向依赖，同时保持既有应用行为。

## 决定

Client 采用“Controller 与领域对象 → UI adapter → renderer → Slot component”的分层。Controller 和领域对象发布不依赖 React 的 observable source；所属 `ui-*` package 声明标准 props 并注册 source；`ui-renderer` 在 Slot binding 点生成 selector hook；组件只从 Slot props 读取数据与操作。

```text
[Remote / Controller / domain object]
                  |
                  | bare observable source
                  v
             [ui-* adapter]
                  |
                  | standard source registration
                  v
              [ui-renderer]
                  |
                  | selector hook binding
                  v
            [Slot component]
```

Session 与 Workspace 的 Client 对象分别归 `api/session-controller/client` 和 `api/workspace-controller/client`。Conversation 的 target-neutral 数据结构和组装归 `client/ui-conversation`，Chat 与 Trajectory 分别归 `client/ui-chat` 和 `client/ui-trajectory`。

Session 与 Workspace 的 React 适配分别归 `client/ui-session` 和 `client/ui-workspace`。Store engine 归 `client/store`，Slot registry、scope materialization 和 observable-to-hook 绑定归 `client/ui-renderer`。

系统不提供聚合式 `client/runtime` package，也不设置替代它的总控 facade。Session history、Remote stream、分页 cursor 和重连连续性由 [Session 历史与事件传输](2026-08-18-session-history-and-event-transport.zh.md) 定义；本 Note 从 Controller 发布的 Client 对象与 source 开始。

## 分层原则

### Controller 是无 React 的逻辑 owner

Controller 可以作为 Cordis service 安装，但不拥有 React Context、React hook、Slot props 或组件。Controller snapshot 只包含自身拥有的事实，命令只改变 Host 或领域对象状态。

UI 层可以同时读取多个 Controller 做一次导航决定，但不得把组合结果写回任一 Controller snapshot。UI adapter 也不复制 Controller 命令的业务实现。

### UI adapter 拥有 React 接入

每个标准 hook 归最接近其数据语义的 `ui-*` package。

| Hook | Owner | Source |
| --- | --- | --- |
| `useSessions` | `client/ui-session` | Session Controller 全局列表 |
| `useSession` | `client/ui-session` | 当前 Session snapshot |
| `useProjection` | `client/ui-session` | 当前 Session keyed projection |
| `useSessionPendingInteraction` | `client/ui-session` | pending domain 聚合结果 |
| `useWorkspaces` | `client/ui-workspace` | Workspace Controller 列表 |
| `useConversation` | `client/ui-conversation` | Conversation binding snapshot |
| `useChat` | `client/ui-chat` | `chat` target source |
| `useTrajectory` | `client/ui-trajectory` | `trajectory` target source |

`ui-renderer` 只实现通用绑定，不 import Session、Workspace、Conversation、Chat 或 Trajectory 的业务类型和值。

### Slot scope 与标准 props 分离

`ui-slots` 声明 root、session 和 session-maybe scope，以及可通过 declaration merge 扩展的标准 props 类型；它不决定每个 scope 安装哪些 hook。

`ui-renderer` 实现通用 scope adapter 与 source materialization。`ui-session` 安装 Session scope 并提供内建 source，其他领域 package 只注册自己的 source 和消费它的 Slot entry。

新增 target 不要求 renderer 或 Session Controller 增加分支。数据 owner 负责状态身份、更新、错误和释放；UI adapter 负责 hook；显示 owner 负责 target-specific projection 与交互状态。

## Package 所有权

| Package | 拥有内容 | 明确不拥有 |
| --- | --- | --- |
| `api/session-controller/client` | Session 对象、列表、选择、命令、projection、queue、事件窗口和 Agent Context | Conversation target、React、Slot、Workspace |
| `api/workspace-controller/client` | Workspace 对象、顺序、归档、命令和 snapshot | React、Session 导航策略、目录 UI |
| `client/ui-session` | Session scope、标准 source、`SessionProvider`、pending interaction 聚合 | Session transport、Conversation 组装、Approval/Question 结果 |
| `client/ui-workspace` | Workspace hook、浏览器 UI 和跨 Controller 导航策略 | Workspace transport、Session 数据副本 |
| `client/ui-conversation` | Conversation core、registry、binding、shell、input、composer、queue 和 View 导航 | Session transport、Chat/Trajectory snapshot |
| `client/ui-chat` | Chat target、Node definitions、renderer、selection、details 和 locale | Session 生命周期、通用 View 导航、Trajectory、历史图片 cache |
| `client/ui-trajectory` | Trajectory target、事件记录投影和检查视图 | Session snapshot、Chat snapshot |
| `client/ui-approval` | Pending Approval、Remote listener、composer 和审批 UI | Session control、通用 composer election |
| `client/ui-user-questions` | Pending Question、Remote listener、composer 和问题 UI | Session control、通用 composer election |
| `client/store` | React-free store contract 与实现 | 领域对象、React hook、Slot 生命周期 |
| `client/ui-renderer` | SlotRegistry、scope binding、selector hook、outlet 和 React root | Session、Workspace 与 Conversation 业务逻辑 |

## 总体数据流

Session 数据按以下路径进入 UI：

```text
[ctx.remote.session]
          |
          v
[api/session-controller/client]
  |-- SessionListState --------------------------> [ui-session] -> useSessions
  |-- SessionSnapshot ----------------------------> [ui-session] -> useSession
  |-- ProjectionValueSource ----------------------> [ui-session] -> useProjection
  `-- per-Session SessionEventSource
                    |
                    v
             [client/ui-conversation]
                    |
                    | assemble
                    v
             ConversationSnapshot ----------------> useConversation
                    |
          |---------+----------|
          v                    v
      [ui-chat]           [ui-trajectory]
          |                    |
       useChat            useTrajectory
```

Workspace 数据从 `ctx.remote.workspace` 进入 Workspace Controller，再由 `ui-workspace` 暴露为 `useWorkspaces`；需要跨域导航时，`ui-workspace` 临时读取 Session Controller 并发出选择或命令。

Approval 与 Question 从 Host waterfall 经 `ctx.remote.$on` 到达各自 UI owner。Owner 发布 Pending 对象，`ui-session.pendingInteractions` 再把同一对象送往 Session 导航状态和 Conversation composer selection。

## Session Controller Client

### SessionSnapshot 的范围

`SessionSnapshot` 表示 Session 自身的控制与生命周期事实。它可以包含 identity、running、removed、blank、subagent address、open phase、history phase、prompt error、agent error 和 queue 状态。

它不包含以下数据：

- raw event array；
- Conversation View；
- Chat Node；
- Trajectory row；
- Approval 或 Question 的待处理对象；
- 要求调用者遍历 event 才能解释的呈现状态。

字段由 event、control frame 或本地命令推导，并不自动决定其 owner；消费语义决定 owner。`composerPhase` 同时依赖 Session lifecycle 与 Conversation target activity，因此由 `ui-conversation` 合成，不进入 `SessionSnapshot`。

### 三个读取面

Session Controller 对外提供三个互不替代的读取面：

1. 全局 Session list 与 current selection source，供导航和 `useSessions` 使用。
2. 每个 Session 的逻辑 binding，包含 `sessionId`、`SessionSnapshot` source、commands 与 projection sources。
3. Conversation-facing `SessionEventSource`，只供 Conversation assemble core 使用。

普通 UI component 不直接读取 `SessionEventSource`。`ui-session` 不读取私有 event window，`ui-conversation` core 也不接收 React binding 或 Slot API。

### SessionEventSource

`SessionEventSource` 暴露已经物化的事件窗口，而不是 transport。

窗口携带有序 `entries`、`hasMore`、单调 `revision`，以及 `replace | prepend | append` 变更描述。Append 以常数时间连接不可变片段；需要完整 `entries` 数组的消费者才为该 snapshot 物化并缓存数组。

首次打开、重连、gap repair 和无法证明连续性的更新发布 `replace`；历史分页发布 `prepend`；连续 live event 发布 `append`。Conversation core 依据 revision 与 change 选择增量更新或完整 rebuild。

`MutableSessionEventSource` 是 Session Controller 内部写端，消费者只依赖只读的 `SessionEventSource`。

### Session binding 生命周期

每个 Session binding 持有自己的 Cordis Context 与 Fiber。Session Controller 创建 binding，也负责释放它。

依赖 Session 的对象把清理注册到 `binding.ctx.effect()`。Binding 释放会触发 Conversation binding、UI materialization 和 scoped Slot store 的清理，不存在额外的 `onBindingRelease` 或 `onRelease` 回调协议。

这种清理方式不要求 Session Controller 了解上层消费者名册。

## UI Session

### 服务职责

`client/ui-session` 是 Session Controller 与 React/Slot 系统之间唯一的 Session adapter。它提供 `ctx.uiSession`，并负责：

- 观察 Session list、current selection 和 per-Session binding；
- 安装 session 与 session-maybe scope adapter；
- 提供 `SessionProvider` 的呈现语义；
- 内建 session snapshot、projection 和 sessionId source；
- 接收其他领域 package 的 Session-scoped source contribution；
- 聚合业务 package 注册的 pending interaction。

它不拥有 Session transport、event folding、Conversation target 或具体业务结果。

### 标准 source 注册

领域 package 调用 `ctx.uiSession.provide()` 注册 bare source。Descriptor 静态声明 hooks、keyedHooks 和 props 名册，`resolve(binding)` 为一个 Session binding 返回完全对应的值；例如 `ui-conversation` 把每个 binding 的 snapshot 注册为 `conversation` hook source。

普通 source 被 renderer 转换成 `use<Name>`，Projection 等开放 key 空间通过 keyed hook resolver 暴露，稳定值通过 props 暴露。

运行时拒绝未声明、缺失或重复的标准 prop。`ui-session` 自身也走相同 materialization，renderer 不为 Session 名字写特殊分支。

### Scope binding

session 与 session-maybe 使用同一个 adapter，但绑定语义不同：

- strict session scope 在没有 current binding 时拒绝渲染；
- session-maybe 使用稳定 absent binding，保持 hook 调用顺序；
- current Session 切换以 `sessionId` 为 key 重建严格 Session subtree；
- root 与 session-maybe entry 可以跨 Session 切换常驻。

每个真实 materialized binding 保留 Controller binding 的 Context。`ui-session` 通过 `binding.ctx.effect()` 删除缓存项并撤销 current binding。

Contribution roster 变化会重建已 materialize 的 binding 并发布新的 source 集合。同一 binding 生命周期内，source identity 保持稳定，以满足 `useSyncExternalStore` 的缓存要求。

### SessionProvider

`SessionProvider` 是 `PropsRenderSlots` 根据 session-scoped child 声明派生的标准席，不是业务 component 直接 import 的 React Context。

它接收普通 `ReactNode` children，不接收 `(sessionId) => ReactNode` render function；调用方直接用它包裹 `renderSlot('details', {})`。

Session identity 通过 scope binding 和标准 `sessionId` prop 提供。Provider 只负责 absent branch 与按 Session identity 隔离 subtree，组件不得借助 Provider 回调取得 Session 数据。

### Pending interaction

`SessionPendingInteractionMap` 由业务 package declaration merge 扩展。每个 pending object 至少携带稳定 `key`、领域 `kind` 和 `sessionId`；`ui-session` 不 import Approval 或 Question 的具体类型。

业务 plugin 在 `apply()` 中调用 `registerPendingInteraction(precedence)`，为自己的 pending domain 建立稳定注册。该调用返回逐请求 publication function；publication function 同时发布精确对象及其 waterfall 委托回调，并返回移除该对象的幂等 disposer。Plugin teardown 会先移除所有已发布对象，再调用并等待其委托回调，避免 Client 回答者卸载后 Host 请求继续悬挂。

相同 key 的并发对象被拒绝，替换请求必须使用新 key。同一 Session 可以同时存在多个领域或多个请求。

`ui-session` 使用各 domain 的 precedence 选出每个 Session 当前生效的对象。较高 precedence 胜出，相同 precedence 下后遍历到的有效对象胜出。

聚合结果发布为 `pendingInteractions: ObservableSnapshot<ReadonlyMap<SessionId, SessionPendingInteraction>>`，`useSessionPendingInteraction` 是其 React 读取面。

Session 导航状态和 composer takeover 必须读取同一个 effective object，不得分别维护 status map 或 takeover roster。

## Workspace Controller 与 UI Workspace

### WorkspaceSnapshot 的范围

`WorkspaceSnapshot` 只包含 Workspace Controller 拥有的 Host-authoritative 数据，包括 Workspace rows、顺序、archive set、follow phase 和错误。Workspace row 的 `sessionIds` 是关联字段，不等于把 Session 对象复制进 Workspace snapshot。

以下组合事实不进入 `WorkspaceSnapshot`：

- Workspace 与 Session 两条 baseline 是否同时 ready；
- 根据 Session 更新时间推导的最近 Workspace；
- 当前 Session 是否因归档而清除；
- New Session 应复用哪个 blank Session；
- 首次启动应选择哪个 Session。

### UI Workspace 的组合职责

`client/ui-workspace` 把 Workspace list source 注册为 root 标准 source `workspaces`，renderer 由此提供 `useWorkspaces`。

初始选择、blank Session 复用、新建导航、并发创建合并和归档后导航属于 UI navigation policy。该 policy 可以在决定时同时读取 `ctx.workspaces` 与 `ctx.sessions`，但只调用 Controller command 和 selection action，不发布联合 snapshot。

目录 picker、目录浏览和 `openPath` 属于独立目录能力，不进入 Workspace Controller。

## UI Conversation

### Assemble core

`client/ui-conversation` 同时包含不依赖 React 的 Conversation assemble core 和同领域的 React adapter。

Core 拥有 `ConversationSnapshot`、Definition registry、View registry、event assembler、location index、每 Session binding、target source 和 target activity。

Core 从 Session binding 取得 `SessionEventSource`。连续 revision 的 append 与 prepend 使用增量组装；replace 或 revision 断档从完整窗口 rebuild。

Definition 或 View roster 变化只重建 Conversation binding，不重建 Session 或重开 Remote stream。Core 不 import React，可独立测试事件折叠、增量更新和 registry lifecycle。

`ConversationSnapshot` 不复制 `SessionSnapshot`，也不暴露 raw events；它只发布 target-neutral 的 View 名册、target activity 和 target source lookup。

`useSession` 与 `useConversation` 来自两个 source，不承诺在同一个 React commit 原子发布。同时读取两者的组件按当前 snapshot 纯计算，不把通知顺序解释为业务因果。

### Definition 与 View registry

`UiConversation.events` 是 event Definition 的唯一 registry，`UiConversation.views` 是 target snapshot builder 的唯一 registry。

Registry 拒绝重复 key，保持注册顺序并返回幂等 disposer。Roster 变化时，现有 Conversation binding 使用当前 event window 重建；同一同步注册轮次中的变化会合并为一次 microtask 重建。

Target package 通过 declaration merge 扩展 snapshot 与 location data map，再向 registry 注册自己的 Definition、builder 和 View。注册随 Cordis effect 释放。

`ui-conversation` 不 import 具体 target package。

### Conversation React adapter

React adapter 把每个 Conversation binding 的 snapshot 注册为 Session 标准 source `conversation`，renderer 由此提供 `useConversation`。

同包还拥有 shell、input、composer chain、queue UI、draft、View navigation 和 phase 合成；Core 不读取 React Context、Slot props 或 component state。

View 选择顺序固定为：有效的持久化 selection、已注册的 `chat`、无 View。无效 selection 不覆盖持久化值，系统不 fallback 到第一个已注册 View。

没有 `ui-chat` 时 shell 仍能激活和 mount，但不会隐式选择 Trajectory 或其他 target。

Shell phase 由 Session lifecycle 与 Conversation target activity 纯合成。Session 已 active 或任一 target 报告可见内容时显示 active；首条 prompt 失败仍保持 engaging。

### Input 与 composer

Composer chain 属于 `ui-conversation`，具体 takeover 属于业务 package。`ConversationRoot` 从 `useSessionPendingInteraction` 读取当前 Session 的 effective object，并作为 `ComposerChainProps.pendingInteraction` 交给 chain selector。

Selector 是 owner currency 的纯函数，非 null 结果作为 `matched` 传给获选 component。Stable composer entry 与默认 composer 可以同时常驻，chain 只选择一个有效呈现。

Draft 与输入状态属于 Conversation UI，不进入 Session snapshot。Queue command 通过 Session-scoped service 寻址，不把 queue UI 写入 Conversation core。

## Chat 与 Trajectory target

### Chat owner

`client/ui-chat` 注册 target id `chat`，并拥有 Chat snapshot builder、Conversation Node definitions、keyed node renderers、selection、details、stats、locale 和 tool inspection 协作。

它通过 `ctx.uiSession.provide()` 注册 `chat` target source。`ChatView` 使用 `useChat` 读取聚合 order、navigation 与 timeline；每个 `ChatNodeSeat` 从该 snapshot 接收身份稳定的 Node 与 Turn-process source，不订阅聚合 source。

Chat activity 只由可见且非 command 的 Chat Node 激活。普通 command-only history 保持 Hero，`/goal` 的 `command-input` Node 激活 fresh Conversation。

历史图片 cache 已移入 `ui-conversation`（`ctx.uiConversation.imageUrl`），Chat 与 Trajectory 对同一会话附件共享一次授权读取和一个浏览器 URL（[Trajectory 持久化图片附件](../../archived/feature/2026-08-24-trajectory-image-attachments.md)）；Draft 图片仍属于 Conversation input。

### Trajectory owner

`client/ui-trajectory` 通过相同 target 协议注册 `trajectory`。它拥有事件记录、时间线、虚拟行、selection 和 inspection view，并通过标准 source 提供 `useTrajectory`。

Session 生命周期读取 `useSession`，Trajectory 数据读取 `useTrajectory`。Trajectory 不通过 Session snapshot 或 Chat snapshot 取得自己的数据。

其他 target 使用同一注册流程，不修改 renderer、Session Controller 或 ui-session。

## Approval 与 Question

### 稳定注册

Approval 和 Question 的 plugin 安装分为稳定注册与单次请求处理。`apply()` 注册 locale、调用 `registerPendingInteraction()` 注册本领域 pending domain，并向 `conversation.composer` 注册唯一稳定 entry。

Approval 的 detail child Slot 也由稳定 entry 声明。并发请求和 Session 数量不会增加 composer entry 或重复声明 Slot，所有注册随 plugin fiber 释放。

### 单次 waterfall 请求

Remote Event listener 从自身 Agent Context 解析 Session。没有 Session scope 时调用 `next()` 继续 waterfall；存在 Session scope 时创建 `PendingApproval` 或 `PendingQuestion`。

Listener 通过已注册 domain 的 publication function 发布对象，等待用户完成、取消或请求 signal 中止，并在 `finally` 中精确移除对象。

单次请求不注册 Slot，不创建第二套 lifecycle effect，也不修改 Session snapshot。

Approval 暴露 allow 与 reject，Question 暴露 answer 与 cancel。用户主动取消 Question 返回 `ASK_CANCELLED`；等待中的请求被 `AbortSignal` 中止时返回 `UserQuestionError(ASK_ABORTED)`，不泄漏载体的 `AbortError` 或普通 `Error`。

Gateway 只要求 Remote Event 参数和结果是合法 JSON 传输值，不复制 Question 选项的领域校验。

### 单一 pending 投影

Sidebar 与 composer 使用相同 `pendingInteractions` snapshot。导航根据 effective object 的 `kind` 显示审批、计划审阅或问题状态，composer entry 根据对象实例选择自己的面板。

同一请求 identity 同时驱动两处 UI。新请求替换同类型旧请求时使用新 key，因此 selector 与订阅者都观察到身份变化。

`ui-session` 只实现跨领域 precedence，不解释 Approval 或 Question 的字段。

## UI Renderer 与 Store

### UI Renderer

`client/ui-renderer` 拥有 `SlotRegistry` service 和 React renderer。它负责：

- `ctx.slots.register()`、`inject()`、`renderSlot()` 与声明生命周期；
- root、session 和 session-maybe scope adapter；
- 标准 observable source 到 selector hook 的绑定；
- Slot outlet、错误隔离、root mount 与 hydration；
- 按 scope key 管理 Slot store instance 生命周期。

Renderer 可以认识通用 scope 名称和 binding 协议，但不读取领域 service。渲染 Session scope 而没有安装 adapter 是装配错误，并立即失败。

### Store

`client/store` 是 React-free 普通库，拥有 `ObservableSnapshot`、`SnapshotStore`、`defineStore`、`createSnapshotStore` 和 `shallowEqual`。

`ui-slots` 引用 store contract，`ui-renderer` 管理 store instance 并提供 `useStore`。

Store 只承载 draft、View selection、Chat selection、inspection request 和面板尺寸等观看或交互状态。Session、Workspace、Conversation、Remote stream 和 connection generation 不进入 Store。

### 注册与释放顺序

一个 plugin 同时提供 source 与 Slot entry 时，先注册 source，再注册 entry。Cordis 反向 disposal 先移除 entry，再移除 source，仍挂载的 entry 因而不会短暂失去必需 hook。

Session binding 释放通过 `binding.ctx.effect()` 清理 UI materialization 与 scoped store。Plugin fiber 释放通过 registration disposer 清理 source、listener 和 Slot entry。

所有 disposer 都可重复调用，不依赖 Cordis 生命周期以外的隐式回调。

## 组合与依赖方向

应用 bundle 显式安装所需 Controller、adapter、target 和 renderer plugin。每个 owner 的 `apply()` 只安装自己的 service、listener 和 contribution。

运行时消费方向是 `session-controller → ui-session → ui-conversation → target UI`、`workspace-controller → ui-workspace` 和 `store → ui-slots → ui-renderer`；Approval 与 Question 只依赖 `ui-session` 提供的 pending 注册点。

图中的箭头表示运行时消费关系，不覆盖 type-only declaration merge 边。Controller 不反向依赖 UI adapter，renderer 不反向依赖领域 package，Conversation core 不依赖具体 target。

UI component 不接收 `ctx`。跨 package 协作使用 Cordis service、standard source 或 Slot registration，不新增聚合 facade。

## 开发者遵循方式

### 先确定数据 owner

新增状态前先按消费语义确定唯一 owner：Host 通信、命令和实体生命周期归 API Controller；由 Session events 形成且与 target 无关的数据归 Conversation core；只服务一种 View 的投影归对应 target package；草稿、选择和面板状态归拥有该交互的 UI package。

同一事实不得同时保存在 Controller snapshot、Conversation snapshot 和 Store。需要跨域决策时读取多个 source 并立即发出 command，不创建联合 snapshot，也不缓存另一领域的对象副本。

以下信号表示 owner 选择错误：Controller 开始 import React；renderer 出现业务类型分支；组件遍历 Session events；Store 保存 Session 或 Workspace 实体；一个 target 的变化要求修改 Session Controller。

### 新增 Session-scoped 数据

1. 在领域 owner 中提供 React-free observable source。
2. 在所属 UI adapter 中 declaration-merge 标准 prop 类型。
3. 通过 `ctx.uiSession.provide()` 声明固定 roster，并从 Session binding 解析 source。
4. 让 Slot component 从 `PropsRuntime` 获得生成的 hook，不向组件传 `ctx`。
5. 把每个 binding 的资源清理挂到 `binding.ctx.effect()`，把 registration 清理留给 plugin fiber。
6. 测试缺失值、重复名字、roster 替换、Session 切换和 binding disposal。

只有开放 key 空间使用 keyed hook；有限且稳定的 source 使用普通 hook；不会变化的标识使用 prop。不得为了减少一次注册而把业务名称硬编码进 renderer。

### 新增 Conversation target

1. 在 target package 中扩展 Conversation snapshot 或 location data map。
2. 向 `UiConversation.events` 注册所需 event Definition。
3. 向 `UiConversation.views` 注册 snapshot builder、target id、View 与 activity 规则。
4. 通过 `ctx.uiSession.provide()` 暴露该 target 的标准 selector hook。
5. 在同一 package 中注册 renderer、locale 和 target-specific Slot entry。
6. 验证 target 卸载只重建 Conversation binding，不改变 Session、其他 target 或 Remote stream。

Target 不得读取另一个 target 的 snapshot 作为自己的数据源。可选协作通过窄 port 或 Slot 完成；缺失 target 时，shell 必须保持可启动且不得猜测 fallback。

### 新增 pending-interaction 业务

1. 业务 package 定义 Pending 对象及其完成、取消和中止语义。
2. 通过 declaration merge 把对象加入 `SessionPendingInteractionMap`。
3. 在 `apply()` 中调用 `registerPendingInteraction()` 一次，并注册唯一稳定的 composer entry。
4. Remote waterfall listener 从 Agent Context 解析 Session；无法处理时调用 `next()`。
5. 可处理时创建 Pending 对象，使用 publication function 发布，等待结果，并在 `finally` 中移除。
6. 测试并发 key、precedence、用户取消、transport abort、plugin disposal 和无 Session delegation。

单次请求不得注册 Slot、声明 child Slot、修改 Session snapshot 或另建状态索引。Sidebar 与 composer 都从 `useSessionPendingInteraction` 读取同一个 effective object。

### Review 检查点

- 每个新 source、registry contribution、listener 和 cache 都有明确 Cordis fiber 或 Session binding owner。
- 每个公共 hook 能追溯到唯一 React-free source；不存在只为传参而层层转发的 selector。
- 每个 component 的数据与 action 都来自标准 props 或所属 Slot inject face。
- 每个 target 在缺席、动态注册和卸载时都有定义明确的结果。
- 每个跨层 import 都沿 Controller、adapter、renderer、component 的单向关系前进。
- 每个错误由最早能解释其语义的 owner 归类；载体错误不直接泄漏成业务错误。

## 验证

各 owner 的测试分别固定 Controller binding 与 event source、UI scope 与 pending precedence、Conversation 增量组装与 View fallback、target projection、waterfall 结果以及 renderer 的 scope/store 生命周期。应用组装测试同时覆盖完整 roster 和缺少具体 target 的启动；组件测试不替代对象层、重放和生命周期测试。

## 备选方案

- **保留 Runtime facade。** 它维持单一入口，却继续形成依赖汇点并允许新代码绕过领域 owner；系统因此不保留 facade 或兼容出口。
- **把所有 Client 状态放进 API Controller。** 这会让协议对象承担 React、View 和 presentation policy；Controller 因而只保留无 React 的领域状态。
- **让 Controller 直接提供 React hooks。** 这会阻止非 React 消费者复用同一对象，也使 transport 与 renderer 生命周期相互依赖。
- **把 Conversation 放进 SessionSnapshot。** 这会扩大 Session API，并迫使普通 Session 消费者理解 event folding 与 target roster。
- **让 Chat 和 Trajectory 各自重放 Session events。** 这会重复维护顺序、location 和 registry rebuild；共享 assemble core 因而留在 `ui-conversation`。
- **把 Conversation core 拆成额外的非 UI package。** Core 与 adapter 当前共同演化且没有其他非 UI package 消费者；同包目录隔离足以保持 React-free core。
- **把 Workspace 与 Session 合成联合 snapshot。** 这会制造新的跨域 owner；跨域逻辑保留为 `ui-workspace` 的即时决策。
- **让 renderer 内建所有标准 hook。** 这会要求通用基础设施认识每个领域；standard source registration 保持 renderer 与业务类型解耦。
- **让每个 pending 请求动态注册 composer entry。** 这会重复声明 child Slot，并让并发请求竞争注册顺序；稳定 entry 与请求期对象发布保持分离。
- **把 pending interaction 写回 Session projection。** 待回答 waterfall 不是已提交的持久 Session 事实，刷新恢复由 Remote Event replay 负责，因此它留在业务 UI source。
- **为 binding 增加专用 release callback。** 这会重复 Cordis 生命周期；`binding.ctx.effect()` 已能把消费者清理挂到同一 owner。
- **让 SessionProvider 通过 render function 传 Session id。** 这会产生另一条数据注入路径；普通 children 与标准 `sessionId` prop 保持 scope 数据只有一个入口。
- **把 Store 留在 renderer。** Store contract 不依赖 React，并被对象与测试基础设施复用；独立 `client/store` 保持 engine 与渲染生命周期分离。

## 后果

Session、Workspace、Conversation 与具体 target 各自拥有一份权威状态，非 React consumer 可以直接复用 Controller 和 assemble core。新增 Conversation target 只需注册 Definition、builder、View、标准 source 和 Slot entry；新增 pending-interaction 业务只需声明类型、注册 domain 并提供稳定 composer entry。

Renderer 和 Session Controller 不因新增业务领域而增加分支，Session binding 与 plugin fiber 则提供两条明确且可组合的释放路径。UI 可以观察到 Session 与 Conversation source 的独立发布，消费者不得依赖二者的通知顺序。

组合包必须显式装载所需 adapter 与 target plugin。缺失具体 target 时 shell 仍可运行，但不会生成或猜测该 target 的 View。更多 package 和显式注册增加了装配工作，但依赖方向、测试范围与故障 owner 均可局部确定。
