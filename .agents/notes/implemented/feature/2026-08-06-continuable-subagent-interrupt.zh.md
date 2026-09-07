# Agent Note: Continuable subagent 当前轮次中断

Status: implemented

[English](2026-08-06-continuable-subagent-interrupt.md) | 中文

## 问题

一个正在运行的 continuable subagent 无法在不销毁它的前提下被停止。继续执行管理器只在整个 Activation 拆除（结算、drain、scoped drain）内部取消子 Agent，`send_message`／`subagent.prompt` 只能增加工作，而 Web composer 的 Stop 按钮被刻意限制在普通会话。用户看到 continuable child 在错误路径上持续消耗 token 时，除了终止整个 parent 树别无手段；当直接 parent Agent 离线时，即使 child 的 Activation 仍然在线，也完全无法对其进行控制。一次性运行有持有方拥有的 disposal 和 task-kill；continuable child 没有对应的当前轮次控制。

## 决策

`ctx.subagents.interrupt(targetSessionId, authority)` 只停止在线目标的当前轮次。管理器原语同步完成鉴权，调用现有的 `Agent.cancel(cause, { keepInbox: true })`，然后返回 `void`——fire-and-return：保证取消信号已发出，但不等待目标完全停稳。其余一切不变：不 dispose Activation、不释放 handle、不级联后代、不清空 inbox，也不改动 `AgentLoop` 或 `CancelOptions`。由于 `keepInbox` 让尚未领取的待处理队列停在 idle，中断绝不会自动启动下一个排队的 follow-up；已被领取进入中断轮次的工作属于该轮次，不会重新入队。被中断的 driver 进入 idle 后，一次显式唤醒发送会按保留的 FIFO 顺序恢复。

授权是一个封闭的双变体 union，刻意比投递权限更宽，因为停止一个轮次是幂等的且不投递任何内容：

- `{ kind: 'user', parentSessionId }`——人类出示持久化直接 parent 地址。在线目标的 `session.header.parentSession` 必须匹配；不涉及在线 parent Agent、目录读取或持久化访问，这正是 parent Agent 离线时在线 child 仍可被停止的原因。取消 cause 为 `user`。
- `{ kind: 'ancestor', agent }`——一个确切在线的 ancestor Agent（直接 parent 或更深）。调用方必须是注册表中其 id 的当前条目（过期调用方即使目标不存在也被拒绝），不得是目标本身，并且必须出现在 Activation 物化时记录的 `ancestry` WeakSet 中。取消 cause 为 `parent`。

目标只在管理器进程本地的 Activation map 中解析。不存在的 id——未知、一次性或已自然结算——是被接受的 no-op，统一覆盖完成竞态和重复请求而不泄露持久化目录信息；disposal 事务已打开的目标在鉴权后同样是被接受的 no-op。一次性生命周期（持有方 `dispose()`、task-kill）不受影响。`SubagentRuntime.interrupt()` 把未绑定管理器的组合视为被接受的 no-op 而不是 `CONTINUATION_UNAVAILABLE`，因为没有管理器就不可能存在管理器拥有的在线 Activation。

Host RPC `subagent.interrupt` 接收 continuable 的 `SubagentAddress` 并返回 `{ accepted: true }`。它的实现只以 `user` 授权调用核心原语——刻意不调用 `catalogChild()`、`listChildren()`、`sessionQuery` 或 parent 注册表查找。parent 地址不匹配的在线目标映射为 `subagent-unauthorized`；意外失败映射为 `internal`，不把错误文本泄漏到 wire。

## 曾考虑的替代方案

**让人类中断走 `session.cancel`。** 通用会话取消要求附着的普通会话并拒绝 subagent 拥有的会话；放宽它会把 subagent 权限规则缠进普通会话路由。subagent 域的 RPC 让基于地址的鉴权和 parent 离线保证保持显式。

**等待目标静止并返回轮次结果。** 取消是协作式的，静止时间无上界；让 RPC（以及一个 `ChildLock` 槽位）保持打开会招致超时并与投递、disposal 形成排队。调用方需要的唯一事实是信号已被接受，而竞态（自然完成、disposal）本就幂等收敛。

**复用整个 Activation 的 disposal 来做中断。** disposal 的取消不带 `keepInbox`，还会 flush、capture 并释放 handle——它销毁排队工作和 child 的驻留。中断是针对一个轮次的控制操作，不是针对 Activation 的生命周期操作。

**顺手把 `send_message`／`followup` 权限扩展到 ancestor。** 投递向对话注入内容且不幂等；其确切直接 parent 权限保持不变。只有中断获得更宽的 ancestor 与基于地址的用户授权。

**中断后自动恢复被暂停的队列。** 在中止 A 后立即启动排队的 follow-up B 会让中断看起来被忽略，并夺走人类重新引导 child 的窗口。暂停到显式唤醒发送为止，让停止可观察且 FIFO 顺序完整。

## 后果

人类或 ancestor 可以停止一个失控的 continuable 轮次，而不丢失 child、其尚未领取的排队工作或正在运行的后代；代价是一个刻意保持弱的后置条件（`accepted` 表示“信号已发出”，目标在观察到信号前可能仍显示 `running`），客户端必须如实呈现。暂停队列规则意味着被中断的 child 会带着保留的工作停在 idle，直到 driver 进入 idle 后收到唤醒消息——这是有意的 human-in-the-loop 暂停，不是调度器缺陷。在 abort 收敛期间被接受的唤醒发送目前会保持排队而不锁存 wake；Issue #1838 跟踪共享的 agent-loop 修正。

仅凭地址的 RPC 会暴露一项关于在线驻留状态的二值信息：不存在的目标会被接受，而 parent 不匹配的在线目标会返回 `subagent-unauthorized`。单用户本地 Host 的信任模型接受这种可观察性；未来的多主体 Host 必须重新审视权限和响应不可区分性。

在 Web 侧，正在运行的 continuable child 使用相互独立的 Send 与 Stop 操作：客户端 `Session.cancel()` 将 Stop 路由到 `subagent.interrupt`（one-shot 地址保持不可取消，普通会话仍通过 `session.cancel` 保留既有的 primary Send/Stop 切换），同时 Send 继续将后续消息加入队列。parent 离线但仍在运行的 continuable child 保留默认 composer，禁用输入区与 Send，但 Stop 仍然可达；停止后恢复为只读接管界面（周边目录与 composer 约定由 [Web subagent 对话](2026-07-27-web-subagent-conversations.zh.md)拥有）。

`dsh-tool-subagent-control` 中面向模型的 `interrupt_agent(agent_id)` 工具把 `exec.agent` 作为 `ancestor` 授权传入，自身不增加任何权限：核心原语校验在线注册表身份与记录的 lineage，因此该工具可以用同一个通用 `agent_id` 参数指定直接 child 或更深的后代——刻意不用会暗示仅限直接 child 的 `subagent_id`。发现依赖 `list_agents({ scope: 'descendants' })`，其底层是新的 `SubagentRuntime.listDescendants()` 单次追踪 pre-order 遍历，每个条目带经校验的 `parentId`／`depth`（列表约定由[持久化目录 note](../../archived/feature/2026-07-22-durable-subagent-catalog-and-list-agents.md)拥有）；发现只是提示，绝非权限。`send_message` 保持其确切直接 parent 权限——只有中断是 ancestor 级的。

## 测试

`packages/subagent/subagent/tests/continuation.spec.ts` 中的核心覆盖证明了持久化 `turn/end` 中止、队列先暂停后按 FIFO 恢复、后代不受影响、两种授权及其取消 cause、self/sibling/stale/非 ancestor 拒绝、absent/一次性/disposal 竞态 no-op，以及 `keepInbox` 循环行为不变。`packages/subagent/subagent/tests/control.spec.ts` 中的 Remote 覆盖证明 Remote 只调用核心原语（不读 agents/目录/历史）、映射 `subagent-unauthorized` 与 `internal`，并执行 continuable 模式围栏；`packages/api/session-controller/tests/transport.host.spec.ts` 固定传输校验。`packages/api/session-controller/tests/session.client.spec.ts` 中的客户端覆盖固定按地址路由的 `Session.cancel()`；InputBar 套件覆盖独立的 Send 与 Stop 操作、parent 离线时锁定输入区和 Send 的状态，以及只读 composer selector 的运行例外。keyless 组装 Web 场景（`apps/web/tests/subagent-interrupt.e2e.ts`、`subagent-interrupt-ui.e2e.ts`）通过多条 replay hang 条目保持多个真实 child 轮次打开，端到端证明 parent 离线时从 UI 到 RPC 的中止路径、Send 入队、follow-up 暂停以及 FIFO 恢复。`packages/subagent/tool-subagent-control/tests` 中的工具覆盖证明直接与更深 ancestor 以 `parent` cause 中断并暂停队列、self/sibling/陌生调用方被拒绝且不触碰目标、目标不存在时 no-op 且不冷恢复，以及 descendants 列表的 pre-order 位置；keyless ACP 快照通过组装应用，针对一个已结算的 child 执行 `list_agents({ scope: 'descendants' })` 与 `interrupt_agent`，同时已录制的请求 header 仍固定这两个 schema。
