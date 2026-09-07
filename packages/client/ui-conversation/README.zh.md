---
description: "Target-neutral 对话装配与浏览器 shell：事件和视图注册表、逐会话 binding、输入状态、slot 与临时 composer takeover。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-conversation

[English](README.md) | 中文

## 概述

`ui-conversation` 拥有与 target 无关的 Conversation 组装和共享浏览器 shell。它消费 Session Controller 的 `SessionEventLikeEntry` feed，通过 `ctx.uiConversation` 暴露不依赖 React 的 registry 与逐 Session binding，并通过 `ctx.uiSession` 提供 `useConversation`、`useInput` 和 `inputActions` 标准 props。它还拥有按会话的持久化图片 URL 缓存：`ctx.uiConversation.imageUrl(sessionId, attachment)` 为每个附件解析一个经会话授权的浏览器 URL，并随 Session binding 释放而撤销，因此所有 Conversation target 共享一次 `session.attachment` 读取。Chat 等具体 target 位于独立 package，由各自 package 注册 Definition、snapshot builder、View 和 renderer。

## 目录

- [Conversation 组装](#conversation-assembly)
- [Shell 与标准 props](#shell-and-standard-props)
- [临时 composer entry](#temporary-composer-entries)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="conversation-assembly"></a>
## Conversation 组装

`UiConversation.events` 是 event Definition 的唯一 registry，`UiConversation.views` 是 target snapshot builder 的唯一 registry。两者都拒绝重复 key、保持注册顺序、返回幂等 disposer，并在 contribution roster 变化时重建现有 binding。`UiConversation.binding(bindingOrSessionId)` 为当前 Session Controller binding 返回 identity 稳定的 Conversation binding，不会另开 event source。

adapter 把每个 `SessionEventLikeEntry` 直接交给 assembler。外层 `type` 区分持久 event 与 Client-only transient event，内部 `event` 则统一公开 `type`、`seq`、`time` 与 `data`；Definition 接收这个内部 `SessionEventLike`。replacement window 可以包含两种 entry，历史 prepend 携带持久 entry，实时 append 则可以携带任一种。两种 event 都使用 Definition 的同一组 `match` 与 `update` 方法，`start` 只接收持久 event，assembler 会拒绝 transient start。不消费 Assistant delta 的 Definition 对 `assistant/live-chunk` 返回 `null`。replace window 或 revision 断档从完整已加载窗口重建；连续 revision 的 append、prepend 与 Assistant settlement 使用增量组装。settlement 只删除具名 attempt 的 transient match，应用可选持久 entry，并重放受影响的 Context 及其 dependent，不替换无关 target node。assembler 拥有 Context 匹配、Turn/Step location、target node 物化、target activity 和稳定 target source。`ConversationSnapshot` 只包含与 target 无关的 View 与 active-target 事实；Session lifecycle 状态仍属于 `SessionSnapshot`。

shell 选择解析出 target 或 target source 收到首个 subscriber 时，该 target 进入 active 状态。assembler 从当前 Context 对它执行一次 replace，并使它参与后续增量 flush；创建 source 不会激活 target，取消订阅也不会停用 target。

target package 通过 declaration merge 扩展 snapshot 与 Location data map，再调用 `ctx.uiConversation.events.register(...)` 和 `ctx.uiConversation.views.register(...)`。target 通过 `ctx.uiConversation.binding(binding).target(targetId)` 读取其 Session-owned source。注册属于 Cordis effect，返回的 disposer 从同一个 registry 移除 contribution。

<a id="shell-and-standard-props"></a>
## Shell 与标准 props

本包注册 optional-Session `conversation` shell、strict Session header/body、View list、composer chain 与 bar、输入区域、Hero 区域、queue dock、草稿持久化和 phase 计算。`ctx.uiSession.provide()` 从同一个 Session binding 物化 Conversation 与 input source，并将 `inputActions` 作为稳定标准 prop 提供。

View 选择规则固定：有效且已注册的持久化选择优先，其次是已注册的 `chat`，否则不渲染 View；绝不选择第一个已注册 View。Shell phase 只组合 Session lifecycle 与 active-target set，不读取任何 target-specific snapshot。

Session 首次绑定或缓存的 Session 成为 current 时，shell 会在渲染前读取持久化 View 偏好，激活已注册的偏好 View 或 Chat fallback，并在后续 tab 或 focus 选择写入 store 前先激活对应 target。blank Session 仍不渲染 `conversation.view` slot；未选中的 target 不会激活。

常驻 composer 在无 Session 与有 Session 之间保持挂载。无 Session 时，同一个编辑器表面保持 inert，Workspace picker 连接 blank Session。该表面是 shell 所有的 Lexical 编辑器：引用 chip 是携带 owner 序列化身份的原子 decorator 节点（提交时经 owner codec 展开），已认领的 slash command 保持为带样式的行首文本，文件夹文本引用以图标前缀携带文件夹图形，草稿的剪贴板投影镜像到逐 Session Conversation store。Queue 操作通过 scoped `ctx.conversation` service 寻址准确的 queue occurrence；queue 预览经 `ui-primitives` 的共享行内引用投影渲染已发送文本（wire 会话形式折叠为其标签），并按原始附件顺序展示本地或持久化的图片和文件。图片使用缩略图，文件使用紧凑的名称与大小卡片。编辑态展示字面发送文本，持久化缩略图通过会话图片 URL 缓存解析。繁忙时 Enter 行为保存在 Host-backed `ui-conversation` settings namespace。

默认发送采用乐观提交：Enter 在同一事务里清空草稿、occurrence 表和撤销历史，composer 保持 `plain`，发送作为 detached attempt 运行，发送期间可以继续输入和提交。`sendSession` 在序列化之前用投递模式注册 Session 提交回显（`session.beginSubmission`），并在 `pendingSubmissions` 中保留图片与文件的选择顺序；Session 根据该模式与当前运行状态推导位置，因此空闲发送进入 transcript，繁忙时 Queue 进入 QueueDock，繁忙时 Steer 进入 pending-steering 区域。随后让出一帧，图片经浏览器原生 `FileReader` data-URL 路径编码，文件则引用已暂存凭证。命令提交也用同一凭证表示通用文件，因此发送 `/goal` 或 `/plan` 时不会再次读取这些浏览器文件。prompt 复用提交 `requestId`；queue 或历史以同一 `rpcId` 被观察后，回显只退休一次。多个并发发送失败时，在用户编辑还原内容之前按提交顺序合并还原；命令提交保持冻结的 `submitting` 阶段。Detached attempt 持有附件 id，直到 admission 完成或 Session scope 销毁。回显以 observed 退休时，durable 图片缓存立即公开每个预览 URL，读取 admitted 附件后用规范化 URL 替换预览，并在各 URL 停止使用后撤销，同时释放文件卡。选中的通用文件进入同一个先进先出的后台上传队列；`maxConcurrentFileUploads` 默认允许两个 Worker transport 同时运行，Conversation service 在切换 Session 时继续持有排队和运行中的传输操作及字节进度，移除草稿会跳过排队中的传输或中止正在运行的传输。continuable 子代理禁用附件入口，也不创建本地回显，因为其 transport 不保留浏览器 request id。

排队提交的本地回显在禁用的编辑、删除、插话按钮旁显示“发送中…”；折叠后的队列在标题栏保留发送状态。匹配的 Host 队列行替换回显后，各操作按原有的纯文本内容和运行状态要求启用。仅收到 prompt 确认不会启用队列操作。提交失败会移除回显并显示错误；输入框为空或仍保留上一次自动恢复的内容时，composer 恢复失败草稿，保留用户随后输入的文字。

普通 composer 运行时，如果草稿为空或输入不可用，主指针操作保持为 Stop。可提交的文字或附件会把同一位置切换为 Queue Send；清空或成功提交草稿后恢复 Stop。繁忙态 Enter 设置会为普通 Session 与可继续 child 选择 Queue 或 Steer 键盘操作。它们的 QueueDock 行共享 Edit、Remove 与 Steer，空草稿也共享 steer-all 组合键。One-shot child 继续只读。Plan Mode 与 active goal 不改变附件入口。可继续 child 保留独立的 Send 与 Stop 操作，但不提供回形针、粘贴或拖放入口；parent 离线时，Send 与 composer 手势锁定，但在线 inbox 的 QueueDock 控制仍可使用（[决策](../../../.agents/notes/archived/bug-fix/2026-08-20-running-draft-primary-send.md)、[inbox 控制](../../../.agents/notes/implemented/feature/2026-08-27-continuable-subagent-human-inbox-control.zh.md)）。

<a id="temporary-composer-entries"></a>
## 临时 composer entry

`conversation.composer` 是通用 chain，其完整 owner currency 为：

```ts type-equiv
/** Owner values used to elect a composer takeover. */
interface ComposerChainProps {
  /** Current Session identity used by temporary business-owned entries. */
  sessionId: SessionId | undefined
  /** Current Session lifecycle state, absent without a selected Session. */
  session: SessionSnapshot | undefined
  /** Effective business-owned interaction awaiting the user in this Session. */
  pendingInteraction: SessionPendingInteraction | undefined
}
```

业务 package 可仅在一个 Remote waterfall request pending 期间安装 entry：

```tsx
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChainSelect, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

interface Request {
  readonly sessionId: SessionId
}

type RequestComposerProps =
  PropsRuntime<'conversation.composer'> & { matched: Request }

const select: ChainSelect<ComposerChainProps, Request> = owner =>
  owner.sessionId === request.sessionId ? request : null

const dispose = ctx.slots.register(
  { name: 'conversation.composer', select },
  RequestComposer,
)

try {
  return await request.result
} finally {
  dispose()
}
```

selector 必须是 owner currency 的纯函数。非 null 返回值作为 `matched` 传给组件；`PropsRuntime<'conversation.composer'>` 提供标准 Session 与 global props。Chain 顺序仍按 `priority` 升序，再按注册顺序；首个返回非 null 的 selector 获选。Shell 会在 takeover 下保持默认 composer 挂载。Request 状态、listener、response encoding 和任何 request-specific child slot 都属于业务 package，不进入 `SessionSnapshot`，也不由 core package 声明。

<a id="model-experience"></a>
## 模型体验

无，因为本包渲染浏览器状态，并通过 Session Controller API 发送用户确认提交的输入，而不构造模型请求。

#### KV Cache 影响

无；Conversation 组装和浏览器输入状态不会改变提供方侧的 prompt cache。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **只有已注册 target 可以渲染**——除已注册的 `chat` 偏好外，shell 刻意不提供隐式 fallback target。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。Conversation Definition、target builder 与 View 已由其所属注册表和 Slot ledger 校验。
