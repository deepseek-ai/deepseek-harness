# Subagent

[English](subagent.md) | 中文

subagent seam 让一个 agent（智能体）将工作委派给子 agent。与 [bash](shell.zh.md) 一样，它是**一项可选能力**，不属于 agent loop（智能体循环），因此其类型定义在此而非 [core.md](core.zh.md) 中。它不同于其他能力 seam，因为**同一上下文中可共存多个提供方实现**，并按名称注册（`ctx.subagents`），而 bash 只允许一个执行器。该注册表遵循 [LLM（大语言模型）适配器注册表](llm-streaming.zh.md)，而非单服务的 bash 执行器。

Service Definition：[dsh-subagent](../../packages/subagent/subagent)（`ctx.subagents` + 下文词汇）。Service Provider 是六个兄弟包：`dsh-subagent-spawn-in-process`、`dsh-subagent-fork-in-process`、`dsh-subagent-acp`、`dsh-subagent-codex`、`dsh-subagent-claude-code`、`dsh-subagent-dsh-sdk`；面向模型的 Consumer 包括 [dsh-tool-subagent](../../packages/subagent/tool-subagent)（按提供方委派）和 [dsh-tool-subagent-control](../../packages/subagent/tool-subagent-control)（可选的全局 `send_message`、`interrupt_agent` 与 `list_agents` 控制工具）。同一个 `ctx.subagents` 服务通过内部激活管理器负责可继续子 agent 编排，并直接基于会话存储和可选的会话持久化提供只读的 child 与后代发现。产品提供方设计理由见 [Codex 与 Claude Code Agent Note](../../.agents/notes/implemented/feature/2026-08-04-claude-code-and-codex-subagent-backends.zh.md)；通用 seam 的设计理由见 [subagent Agent Note](../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.zh.md)、[可继续 subagent Agent Note](../../.agents/notes/implemented/feature/2026-07-28-continuable-subagent-conversations.zh.md)、[相邻 Agent 消息 Agent Note](../../.agents/notes/implemented/architecture/2026-08-27-adjacent-agent-steer-messaging.zh.md)、[持久化目录 Agent Note](../../.agents/notes/implemented/feature/2026-07-22-durable-subagent-catalog-and-list-agents.zh.md)、[列表身份投影 Agent Note](../../.agents/notes/implemented/architecture/2026-08-06-subagent-list-identity-projection.zh.md)和[服务合并 Agent Note](../../.agents/notes/implemented/simplification/2026-07-26-merge-subagent-control-service.zh.md)。

源码：[`packages/subagent/subagent/src/types.ts`](../../packages/subagent/subagent/src/types.ts)、[`packages/subagent/subagent/src/index.ts`](../../packages/subagent/subagent/src/index.ts)和 [`packages/subagent/subagent/src/continuation.ts`](../../packages/subagent/subagent/src/continuation.ts)

## 两类能力，两种发现方式

提供方通过一个静态描述符公布其**启动时**功能，服务会在单次 run 存在之前即行检查；如果请求依赖提供方不具备的功能，会被明确拒绝（`SubagentError('UNSUPPORTED_CAPABILITY')`），绝不会被接受后静默忽略。这些 flag 仅描述单次 [`start()`](#the-provider-contract-subagentprovider) 路径，即由提供方组合子 agent 的路径。**可继续**子 agent 由继续执行管理器自行组合，因此它们由唯一一个可选方法把关，方法存在即为能力，并以 TypeScript 的类型收窄作为发现机制：[`SubagentProvider.prepareContinuable`](#the-provider-contract-subagentprovider)。

```ts type-equiv
/**
 * Which START-TIME features a provider supports. Checked by the service before delegating to
 * {@link SubagentProvider.start}: a request that needs a capability the chosen provider lacks
 * is rejected with a typed error rather than accepted-then-ignored (the "fail loud, no silent
 * degradation" rule). These flags describe the ONE-SHOT
 * {@link SubagentProvider.start} path, where the provider composes the child;
 * continuable children are composed by the continuation manager itself and are
 * gated by {@link SubagentProvider.prepareContinuable} instead. Each flag
 * corresponds one-to-one to a {@link SubagentStartRequest} option: `depthLimit`
 * to `maxDepth`; the other names match.
 */
interface SubagentCapabilities {
  readonly agentOptions: boolean
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
}
```

## 单次启动请求

工具层根据模型输入和自身配置构建此请求；服务在 `start` 之前针对指定提供方进行校验。必填的 `parent` 提供会话 cwd、谱系与委派深度。可选的 Agent 提供方、模型、推理强度与 token 覆盖、output schema、depth、工具过滤器和 persona 需要对应的能力 flag 匹配。进程内后端会把 `agentOptions` 合并到父 Agent 选项之上，将 filter 和 persona 的作用域限定在子 agent 创建阶段，并通过强制 capture 工具实现所支持的 object-rooted schema。DSH SDK 后端会把四个 Agent 路由字段合并到实例默认值之上，并在子运行时初始化期间校验；ACP、Codex 与 Claude Code 会在启动传输前拒绝 `agentOptions`。

```ts type-equiv
/**
 * What a caller asks for when starting a ONE-SHOT subagent. The tool layer
 * builds this from the model's `{ description, prompt }` plus its own config;
 * the service validates {@link SubagentCapabilities} against the named provider
 * and resolves the durable descriptor before dispatching to
 * {@link SubagentProvider.start}.
 */
interface SubagentStartRequest {
  /** Optional short display label persisted with a session-backed child. */
  readonly label?: string
  /** Content delivered as the child's user message. */
  readonly prompt: ContentBlock[]
  /**
   * The spawning agent. In-process providers derive workspace, lineage, and
   * delegation depth from its durable session state. ACP reads only its cwd,
   * and only when no deployment `cwd` override is configured.
   */
  readonly parent: Agent
  /**
   * Cancellation signal from the spawning context (the tool's `exec.signal`).
   * This is the canonical cancellation channel both before and after startup:
   * a provider rejects `start()` after cleaning partial resources when it
   * fires before the run is published, and cancels the published run's
   * remaining turn work when it fires afterward.
   */
  readonly signal: AbortSignal
  /**
   * Optional host-Agent provider, model, reasoning-effort, and output-token
   * overrides. Requires {@link SubagentCapabilities.agentOptions}; in-process
   * providers merge them over the parent Agent's options when they create the
   * child, while the DSH SDK provider merges them over its instance defaults
   * before initializing the separate child runtime.
   */
  readonly agentOptions?: AgentOptions
  /**
   * Object-rooted JSON Schema within `assertObjectJsonSchema`'s enforced subset. Start rejects
   * unsupported schemas or providers without the capability. Data must be plain host-realm JSON;
   * a successful child returns the matching value as {@link SubagentResult.structured}.
   */
  readonly outputSchema?: ObjectJsonSchema
  /**
   * Optional absolute delegation-depth cap for the child being started: its
   * computed depth must be less than or equal to this non-negative safe
   * integer. Requires {@link SubagentCapabilities.depthLimit}; rejected at
   * start otherwise.
   */
  readonly maxDepth?: number
  /**
   * Optional child tool scoping. Requires {@link SubagentCapabilities.toolFilter};
   * rejected at start otherwise. In-process backends apply it as a scoped
   * `tools.restrict()` in the child's creation window: the named tools vanish
   * from the child's prompt AND refuse to execute (one visibility), with loud
   * unknown-name validation.
   */
  readonly toolFilter?: ToolRestriction
  /**
   * Optional per-child persona. Requires {@link SubagentCapabilities.persona};
   * rejected at start otherwise. In-process backends register it as a scoped
   * `deployment:persona` section on the child, SHADOWING the deployment's
   * persona for this child alone — same template semantics as the deployment
   * persona (strict `{{…}}` interpolation against the registered variables).
   */
  readonly persona?: string
}
```

`signal` 是就绪前后唯一的取消通道。[subagent 组合控制 Agent Note](../../.agents/notes/implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.zh.md)规定 persona、live 全局工具过滤、绝对深度以及「可见性而非权限」的设计理由。

面向调用方的请求不携带目录格式细节或继续执行状态。`SubagentRuntime.start()` 会在能力检查后解析分离的一次性描述符，再将以下面向提供方的请求传给所选传输；可继续子 agent 绝不会到达 `SubagentProvider.start()`：

```ts type-equiv
/**
 * Provider-facing one-shot request after {@link SubagentRuntime.start} resolves
 * the durable child descriptor.
 */
interface ResolvedSubagentStartRequest extends SubagentStartRequest {
  /** Detached descriptor a session-backed provider persists in the child log. */
  readonly descriptor: SubagentDescriptorData
}
```

## 可继续子 agent 与激活

**可继续后台 subagent** 是一份持久化子 agent 会话（Session），至多关联一个进程内的 **Activation（激活）**，即被重建的子 Agent 处于驻留状态的时段。Activation 不是请求、结果、取消或 Task：它可以执行多个 FIFO 轮次，并在其创建的后代仍在运行期间保持驻留。继续执行管理器负责 activation 准入、直接父级鉴权、实时所有权图、冷恢复（cold resume）与子级优先释放；agent loop 负责一切轮次排序与执行。任何可继续路径都不会创建 Task，也不会创建承载中间结果的包装层。

```text
persisted Session
  -> optional live Activation
       -> one retained AgentHandle
       -> Agent inbox as the only turn FIFO
       -> zero or more owned child Activations
```

`SubagentRuntime.startContinuable()` 会预留稳定的子 agent id，对版本化的 `subagent/descriptor` payload 建立快照，向指定提供方索取其分离的 `ContinuableCreateSpec`，通过私有的 activation-owner 作用域创建子 Agent，建立任何可继续父级的所有权，并提交初始提示词。当收件箱（inbox）准入产出消息 id 时，它以 `{ childId, messageId }` resolve——无需等待轮次开始，也无需等待消息进入会话日志。在该准入之前的任何失败都会以两个 id 都不返回的方式 reject，并 dispose（资源释放）任何已创建的 handle，回滚 Activation 与父级所有权。

`SubagentRuntime.sendMessage()` 是唯一由模型编写消息的操作。它接收确切在线 sender 与目标 id，只允许直接 parent 或直接可继续 child，自行推导 sender 来源信息，并根据目标 child 的 Activation 驻留状态路由：

| 目标 Activation 状态 | `sendMessage` |
|---|---|
| `running` | 在同一 Activation 中 steer 最近的 step |
| `waiting` | 唤醒并 steer 同一 Activation |
| 无 Activation | 冷恢复新的 Activation，然后 steer |

`running` 表示 Agent 拥有活跃的准入或轮次，或正在唤醒收件箱工作；`waiting` 表示它已完全停稳，但仍拥有至少一个尚未完成 dispose 的子 Activation；`settled` 表示已完全停稳且其拥有的每个子级都已 dispose，此时管理器会 dispose [`AgentHandle`](core.zh.md#creation-and-ownership) 并移除该 Activation。管理器根据 Agent 的完全停稳状态与其拥有的子级集合推导这些内部条件，而非维护第二套执行状态机。

Agent 收件箱是唯一队列。每条 Agent 消息都使用 `Agent.steer()`：空闲目标会启动一个轮次，运行中目标则在最近的 step 边界领取消息。投递成功会返回被接受的 `MessageId`；既有的 `agent/inbox/inserted`、`agent/inbox/claimed` 与 `agent/inbox/discarded` 事件仍是消息生命周期的观测点，继续执行层不定义任何 subagent 专属的投递路由。

权限来自确切在线 sender。parent 到 child 的投递要求目标的 `SessionHeader.parentSession` 指向 sender；child 到 parent 的投递要求 sender 的驻留 Activation 指向目标。sibling、相隔多于一条边的 ancestor、self-target、陈旧 Agent 对象与一次性 child 都会被拒绝。每条已接受消息都以 `Agent <sender-id> sent a message:` 作为前缀，并记录 `AgentMessageSource`；来源信息记录 sender，但不授予权限。

对于 `startContinuable()` 与 `sendMessage()`，调用方 signal 仅在收件箱接受之前掌管查找、物化与准入。此后管理器独立掌管该 Activation：之后的调用方取消既不会取消已接受的轮次，也不会 dispose 子 agent。浏览器中的人类提示仍由私有 Queue 适配器处理，因此继续产生独立 FIFO 轮次。

`SubagentRuntime.interrupt(targetSessionId, authority)` 是唯一的公开停止操作：它同步完成鉴权，对在线目标发出 `Agent.cancel(cause, { keepInbox: true })`，然后不等待完全停稳即返回。Activation、其尚未领取的待处理 inbox 工作与已发布的后代均不受影响；已被领取进入中断轮次的工作不会重新入队。被中断的 driver 进入 idle 后，一次唤醒发送会恢复被暂停的 FIFO 队列。不存在的目标——未知、一次性或已结算——以及未绑定管理器的组合是被接受的 no-op。对在线目标，错误的 parent 地址或不在其在线祖先链中的调用方会以 `UNAUTHORIZED` 拒绝；陈旧的 ancestor 对象和指向自身的 ancestor 请求会在查找目标前拒绝。

```ts type-equiv
/**
 * Authority under which one interrupt request is admitted. `user` carries the
 * durable direct-parent address a human client presented; `ancestor` carries
 * the exact live Agent object whose recorded lineage must contain the caller.
 */
type SubagentInterruptAuthority =
  | { readonly kind: 'user'; readonly parentSessionId: SessionId }
  | { readonly kind: 'ancestor'; readonly agent: Agent }
```

每个 Activation 都拥有自己的 `AgentHandle` 和一个 `ownedChildren: Set<SessionId>`；由于一份会话至多有一个存活 Activation，子会话 id 无需另一个运行时化身引用即可标识存活的子 agent。启动子 agent 或提交源自 parent 的工作，会在子 agent 能够运行之前将其注册到受继续执行管理的父级集合中；只要该集合非空，该父级就无法 settle。顶层或其他非继续执行的 Agent 没有 Activation，处于 waiting 图之外。只有当子 Agent 已完全停稳、该子 agent 的每个子级都已 dispose、best-effort 的最终会话 flush 结算完毕，且子 agent 的 `AgentHandle` 完成 dispose 之后，才会释放子 agent。

最终结算会等待 `ctx.sessions.flush(session)`，但会忽略其参与布尔值，因为任意 listener 都无法证明某个持久化后端已存储该状态。rejection 会被记录，但不会使 Activation 失败；管理器仍会 dispose 该 handle 并释放所有权，此后持久化的子 agent 状态在后续恢复时可能缺失或陈旧。管理器卸载会调用内部的管理器全局 drain，关闭准入并 dispose 每片在线森林；`drainContinuableDescendants(parents)` 只关闭由 host 确切拥有的在线 Agent 之下的准入，并 dispose 其可继续后代，而无关森林保持在线。两者都会等待各自作用域内已获准的物化过程，自顶向下传播取消，按 child-first 顺序释放 handle，并且即使个别分支失败也会等待所有选中分支。持久化子会话不受该进程内拆卸的影响。

```ts type-equiv
/** Durable attribution for one model-authored message between adjacent Agents. */
interface AgentMessageSource {
  readonly kind: 'agent-message'
  /** A message another agent addressed to this one (`relay` context form). */
  readonly form: 'relay'
  /** Session id of the Agent whose tool call produced the message. */
  readonly senderSessionId: SessionId
}
```

```ts type-equiv
/** Options for one model-authored message between adjacent Agents. */
interface SubagentSendMessageOptions {
  /** Caller cancellation, owning the operation only until inbox acceptance. */
  readonly signal: AbortSignal
}
```

```ts type-equiv
/** Identities returned once a continuable child accepted its initial prompt. */
interface ContinuableStart {
  /** The durable child session id, stable across activations. */
  readonly childId: SessionId
  /** The accepted initial prompt's inbox message id. */
  readonly messageId: MessageId
}
```

当驻留 Activation 结算时，管理器会向该 child 持久化的直接 parent 投递一条通知，说明该 epoch 如何结束，并携带其最终 assistant 内容。对每个调用方拿到过 id 的 child，这条投递都是无条件的；它发生在会让 parent 被判定为已结算的所有权释放之前，并通过与 Agent 消息相同的唤醒准入记账到达驻留 parent。若 parent 自身所在的谱系已在拆卸中，这条通知会以不唤醒的方式送达，因为唤醒一个静息 Agent 是开启一个轮次，而不是排队等待工作。其来源信息使用一个独立的 kind，因此 transcript（文本记录）绝不会把运行时的记账呈现为 child 自己写下的内容。

```ts type-equiv
/**
 * Durable attribution for the runtime's own account of a continuable child
 * settling. Deliberately a different kind from
 * {@link AgentMessageSource}: an Agent message is content the sender chose,
 * while this message is the manager stating what became of the child, and a
 * transcript that merged them would credit the child with words it never wrote.
 */
interface SubagentSettledMessageSource {
  readonly kind: 'subagent-settled'
  /** A runtime account shown without expanding the row (`notice` context form). */
  readonly form: 'notice'
  /** One-line account of how the child ended. */
  readonly summary: string
  /** Session id of the child that settled. */
  readonly senderSessionId: SessionId
}
```

提供方只参与准备初始创建 spec，`spawn` 与 `fork` 在此有所不同。其返回的 spec 只携带分离的、提供方专属的创建输入——即可选的父级历史种子——不含 Agent、`AgentHandle`、提示词投递、结果、dispose 或恢复操作。冷恢复根本不经由提供方分发：管理器折叠通用描述符，通过同一个 activation-owner 作用域调用 `ctx.agents.resume()`，并提交等待中的轮次。

```ts type-equiv
/**
 * What the continuation manager asks a provider for while materializing one
 * continuable child's FIRST activation. The manager has already reserved the
 * durable child identity and owns every later operation, so this request
 * carries only what distinguishes a fresh child from one seeded with parent
 * history.
 */
interface ContinuableCreateRequest {
  /** The reserved durable child session id, for provider diagnostics. */
  readonly sessionId: SessionId
  /** The delegating parent agent whose history a seeding provider reads. */
  readonly parent: Agent
  /**
   * Caller cancellation, which owns preparation only until the manager accepts
   * the initial prompt into the child's inbox.
   */
  readonly signal: AbortSignal
}
```

```ts type-equiv
/**
 * A provider's detached contribution to one continuable child's creation. This
 * is DATA, never a capability: it carries no Agent, `AgentHandle`, prompt
 * delivery, result, disposal, or resume operation, because the continuation
 * manager owns the child's whole lifecycle after preparation.
 */
interface ContinuableCreateSpec {
  /**
   * Completed-turn prefix of the parent's log to seed the child session with,
   * or absent for a fresh child. Same durable contract as
   * `CreateAgentOptions.seed`: contiguous from seq 0, lossless JSON, balanced.
   */
  readonly seed?: readonly SessionEvent[]
}
```

描述符（[descriptor.ts](../../packages/subagent/subagent/src/descriptor.ts) 中的 `SubagentDescriptorData`）是每个由会话支撑的 subagent 所使用、按模式判别的持久化身份。两种模式都携带提供方名称。`one-shot` 描述符可以携带调用方拥有的可选显示 `label`；`continuable` 描述符要求以委派 `description` 作为持久化创建标签，并另外对已解析的子 agent `agentOptions.provider`／`model`／`reasoningEffort` 与可选的 `persona`／`toolFilter` 建立快照，用于冷恢复。它绝不会对可合并扩展的 `AgentOptions` 对象建立快照，因此无关的扩展值不会破坏继续执行，后续新增组合配置输入则是一次有意的版本更改。描述符省略 `subagentDepth`（冷恢复以持久化 header 中的 `delegationDepth` 作为单调下界）和 `outputSchema`（单次运行或 Activation 的结果约定，而非持久化身份）。

本地一次性提供方会在子 agent 的初始轮次内、首次请求前追加描述符。继续执行管理器会在任何提供方提供的谱系之后、初始提示词获准之前追加描述符；`header.seedLength` 仍是 fork 谱系边界：恢复时的描述符权威读取子 agent 自身的后缀，而供列表使用的身份投影以 last-wins 折叠 `subagent/descriptor`，子 agent 自己的描述符会覆盖 fork seed 中祖先的描述符。该事件只进入日志：不含 `surfaceOp`，绝不进入模型历史，并由仅追加日志跨压缩保留。格式错误的当前版本描述符属于损坏；本运行时无法对不受支持的版本进行分类。

## 持久化枚举：`listChildren()`、`listDescendants()` 与其条目

`SubagentRuntime.listChildren(parentSessionId)` 从 `ctx.sessions.list()` 与可选 `ctx.sessionPersistence.list()` 的实时优先合并中枚举 parent 直接且由会话支撑的 subagent——不经查询服务，也不会加载或恢复任何 Agent。候选是持久 header 携带 `origin: 'subagent'` 的直接 child；该标记只负责枚举分类与粗粒度的通用路由拒绝，不能证明描述符有效、child 可恢复或操作已获授权——身份由投影折叠负责，恢复由 Activation 约定负责。每行的 `mode`／`label` 是已注册 `subagent` projection unit 的值，经三级阶梯供值：存活 child 由 `stateOf()` 供值（零日志读取）；冷 child 先读可选的投影 checkpoint 缓存（`cachedSnapshot`——过 own-suffix seq 门的身份即定值，own descriptor 一经追加不可变）；否则在一次 `persistence.inspect()` 读取上经注册表折叠（有界并发，每次列表重新计算）。该缓存是纯可选加速层：服务缺席、行里是 `null` 哨兵或 key 缺席、seq 门不过、读取出错，都静默落到权威重折。折叠规则是 `subagent/descriptor` last-wins 且没有失败通道：子 agent 自己的描述符覆盖 fork seed 中祖先的描述符，格式错误或版本不认识的载荷折叠为可序列化的 `null` 哨兵，视同无值。结果是按 `createdAt`、再按 id 排序的 `SubagentListEntry[]`：取到身份即生成带有 `mode: 'one-shot' | 'continuable'` 和 `activity: 'running' | 'inactive'` 的 `child` 条目；可继续条目始终携带 `label`，一次性条目则只在启动调用方提供展示元数据时携带该字段。已定局而折叠无身份的候选生成 `corrupt` diagnostic——缺失、格式错误与版本不认识的描述符有意不再细分（`unsupported` 仍保留在类型中但从不产出）；运行中而无身份的候选被省略（描述符落盘前的创建窗口）；冷检查失败生成一条 `unavailable` diagnostic 并在下次列表自然重试，因此一个损坏的 sibling 不会隐藏健康 child。`hasChildren` 标记存在持久 subagent origin 的直接后代，读取自同一份合并材料。活动状态只表示逻辑记录是否在 `ctx.sessions` 中存活，而不表示结果或可恢复性。缺少持久化时，枚举退化为仅存活枚举而不是报错——此时冷 child 本就无法恢复。`listChildren()` 要求运行时的投影注册表；缺少会话存储时会抛出携带错误码 `SUBAGENT_CONTROL_SESSION_STORE_UNAVAILABLE` 的 `SubagentError`，并在任何读取之前检查，因此零 child 的部署同样确定失败；列表工具在插件加载时要求 `ctx.subagents` 与 `ctx.agents`。UI 等服务消费方可以展示两种模式，并为无标签的一次性 child 选择回退展示；面向模型的 `list_agents` 适配器（[dsh-tool-subagent-control](../../packages/subagent/tool-subagent-control) 中可单独加载的 `/list-agents` 插件）则只保留可继续条目，并通过在线 Agent 注册表将状态细化为自己的 `running`／`idle`／`ready` 词汇，其中 `ready` 把仅存于存储的 child 命名为可恢复而非终态。枚举不会查询继续执行管理器的 Activation map、Agent 注册表或提供方可用性；`send_message` 仍是消息送达时的权威操作，列表中的运行中可继续 child 仍可能因所有权冲突而拒绝投递。读路径的设计理由见[列表身份投影 Agent Note](../../.agents/notes/implemented/architecture/2026-08-06-subagent-list-identity-projection.zh.md)。

`SubagentRuntime.listDescendants(rootSessionId)` 将同一份实时优先语料与基于投影的解释应用到根的完整后代树，并按稳定 pre-order 输出。普通会话和一次性 child 仍作为遍历节点，因此其下的可继续后代仍可发现；只有 `origin: 'subagent'` 的候选会生成条目。每个返回的 child 或 diagnostic 都从枚举所得的持久 header 附加树位置；冷检查在提供身份前还会重新校验完整生命周期：

```ts type-equiv
/**
 * One entry of a descendant listing: the interpreted subagent facts plus its
 * position in the complete session tree. `parentId` is the durable direct
 * parent from the enumerated header, and `depth` counts edges from the root.
 */
type SubagentDescendantListEntry = SubagentListEntry & {
  /** Durable direct parent of this candidate in the enumerated tree. */
  readonly parentId: SessionId
  /** Edge distance from the requested root; direct children are `1`. */
  readonly depth: number
}
```


<a id="the-terminal-result-subagentresult"></a>

## 终态结果：`SubagentResult`

单次 run 的最终产出，由 `SubagentRun.result` resolve。`structured` 仅在请求了 `outputSchema` 且成功满足时才存在；请求 schema 不保证一定能得到它，当子 agent 失败或结束时未产出有效 capture 时，提供方可能返回 `stopReason: 'error'`。提供方可以为非 `completed` 结果附带安全且不属于 assistant 内容的 `diagnostic`；在消费方将它与 `output` 分开呈现前，提供方会排除工具输入、文件内容、环境值、凭证与原始协议载荷，并把完整值限制在 4096 个 UTF-8 字节以内。非 `completed` 的 `stopReason` 意味着 `output` 可能不完整——消费方将其映射为 `isError` 的工具结果，而非将部分输出报告为成功。

```ts type-equiv
/**
 * The terminal outcome of a subagent run, resolved by {@link SubagentRun.result}.
 */
interface SubagentResult {
  /**
   * The child's final assistant output is the content of its last non-empty
   * assistant message. Empty-content messages, including usage-only messages,
   * are skipped. Without a non-empty message, the output is its accumulated
   * assistant text stream, or `[]` when the child produced neither.
   */
  readonly output: ContentBlock[]
  /**
   * The structured result after a requested `outputSchema` was successfully
   * satisfied. Requesting a schema does not guarantee presence: a provider can
   * end with `stopReason: 'error'` when the child fails or finishes without a
   * valid capture. The structured value is validated against the requested
   * output schema by the provider; `unknown` here because the seam is
   * schema-agnostic.
   */
  readonly structured?: unknown
  /**
   * Provider-authored, non-assistant failure detail for a non-`completed`
   * result. Providers keep this text free of tool inputs, file contents,
   * environment values, credentials, and raw protocol payloads, and limit it
   * to 4096 UTF-8 bytes. Consumers present it separately from {@link output}.
   */
  readonly diagnostic?: string
  /** Why the run ended. A non-`completed` reason means `output` may be partial. */
  readonly stopReason: SubagentStopReason
}
```

`SubagentStopReason` 是一个[可合并扩展的派生联合类型](core.zh.md#the-map--derived-union-pattern)——后端可以添加变体，因此消费方应对已知 case 分支处理，将未知的终态原因视为失败：

```ts type-equiv
/**
 * Why a subagent run ended. Merge-extensible (a backend may add variants);
 * consumers branch on the known cases and fall through `default`. The known
 * cases mirror the harness turn-end vocabulary so the tool layer can map a
 * non-`completed` result to an `isError` tool result.
 */
interface SubagentStopReasonMap {
  /** The child finished its turn normally. */
  completed: 'completed'
  /** Cancelled through the request signal or disposal. */
  aborted: 'aborted'
  /** Model or transport failure. */
  error: 'error'
  /** The child hit its token ceiling before finishing. */
  'max-tokens': 'max-tokens'
  /** The child declined the task. */
  refusal: 'refusal'
}
```

## 单次 run：`SubagentRun`

`SubagentRun` 是消费方持有的、指向一个已发布单次子 agent 的句柄——一次可 dispose 的前台委派，只有一个结果，绝不是持久化子 agent handle。发布后的提示词提交、轮次工作与基础设施故障归 `result` 所有。消费方 await 该结果并始终 dispose 该 run，直至完全停稳。子 agent 失败时以非 completed 的 stop reason resolve；只有无法表示的基础设施故障才会 reject。run 没有 steering，也没有恢复：可继续对话根本没有 run，因为继续执行管理器直接持有它们的 `AgentHandle`，并通过子 agent 自己的收件箱为每个轮次排序。

```ts type-equiv
/**
 * ONE-SHOT child handle returned after publication. Prompt submission, turn
 * work, and infrastructure faults after that boundary belong to {@link result}.
 * Consumers await that result and must always {@link dispose} to cancel
 * remaining work and reach quiescence. A run is one disposable foreground
 * delegation with one result; continuable conversations have no run — the
 * continuation manager holds their `AgentHandle` directly and orders every
 * turn through the child's own inbox.
 */
interface SubagentRun {
  /**
   * Parent-scoped run id. For a local run, this MUST equal the published child
   * session id, whose `parentSession` records `request.parent.session.id`; a
   * remote provider mints an id unique in the parent namespace.
   */
  readonly id: SessionId
  /**
   * The exact published in-process child, or `undefined` for a remote run.
   * When present, its id is {@link id}; the provider retains no ownership
   * implication beyond the run's ordinary {@link dispose} contract.
   */
  readonly localAgent: Agent | undefined
  /**
   * Resolves with the child's terminal {@link SubagentResult} when the run
   * settles. Does NOT reject on a child-level failure — a model/transport
   * failure resolves with `stopReason: 'error'` so the consumer maps it to an
   * `isError` tool result. Rejects on an infrastructure fault the seam cannot
   * represent as a stop reason.
   */
  readonly result: Promise<SubagentResult>
  /**
   * Cancel remaining work, reach child quiescence, and release resources.
   * Idempotent.
   */
  dispose(): Promise<void>
}
```

本地单次 run 必须在 `start()` fulfill 之前发布一个普通子 agent／会话，将该子会话 id 作为 `SubagentRun.id` 返回，以 `localAgent` 暴露确切的子 agent，在子 agent 的 `parentSession` header 中记录 `request.parent.session.id`，并在子 agent 的初始轮次内、首次请求前追加已解析的描述符。运行时所有权可以把子 agent 放在 parent、提供方或 root 作用域下。远程提供方则返回 parent 作用域的生命周期 id 与 `localAgent: undefined`；由于没有本地 child Session，它不会出现在持久化枚举结果中。

<a id="the-provider-contract-subagentprovider"></a>

## 提供方约定：`SubagentProvider`

每个提供方都是一个具名的子 agent 传输层，多个提供方可以共存。服务在 `start()` 之前校验请求的启动时能力，并拒绝在没有 `prepareContinuable` 的提供方上发起可继续 start。`inheritsParentContext` 仅描述对话种子注入（`fork`：true；`spawn` 和 `acp`：false），使消费方能生成准确的面向模型措辞，而不暗示继承了工具、服务或权限。如果某个提供方的一次性路由拥有静态的提供方自有默认值，它会公开可选且不可变的 `agentRouteDefaults`，使 Consumer 能够在预检前以正确基线合并模型与工具覆盖。

```ts type-equiv
/**
 * One registered transport for running child agents. Providers are trusted
 * same-process implementations; callers treat descriptors and returned values
 * as borrowed immutable data. The service may call one provider concurrently
 * for distinct children. Providers isolate operation-local mutable state; a
 * shared capacity controller may delay an operation but must not couple its
 * settlement or cleanup to a sibling.
 */
interface SubagentProvider {
  /** Unique registry name (e.g. `spawn`, `fork`, `acp`). */
  readonly name: string
  /** The start-time features this provider supports (see {@link SubagentCapabilities}). */
  readonly capabilities: SubagentCapabilities
  /**
   * Whether the child sees the parent's completed-turn prefix. This is descriptive, not a
   * service-validated start capability: the model-facing tool derives truthful wording from it.
   * It says nothing about tool registration, injected services, or authority inheritance.
   */
  readonly inheritsParentContext: boolean
  /**
   * Optional static provider-owned provider/model route for one-shot Agent
   * options. Consumers merge tool/model overrides over these values before
   * preflight; providers whose route derives from the parent omit it. The value
   * is detached immutable data and requires `agentOptions` support.
   */
  readonly agentRouteDefaults?: Readonly<{ provider: string; model: string }>
  /**
   * Establish a ONE-SHOT child and return its handle after publication.
   * The service has already validated that every requested start-time
   * capability is supported and resolved `request.descriptor`, so a
   * session-backed implementation appends that descriptor inside the child's
   * initial turn. Before fulfillment, the provider owns setup and cleans any
   * unpublished partial resources before rejecting. Ownership transfers on
   * fulfillment; subsequent turn or infrastructure failure settles through
   * the returned run. Distinct starts may overlap; cancellation, failure,
   * result settlement, and disposal remain independent for each run.
   */
  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>
  /**
   * OPTIONAL (continuable-creation capability): contribute the detached
   * creation inputs that distinguish this provider's continuable children —
   * only whether the child session is seeded with parent history. Method
   * presence IS the capability: the service rejects continuable starts on
   * providers without it, while a provider that has it may still serve
   * ordinary one-shot delegations.
   *
   * This is the provider's ONLY participation in a continuable child. The
   * continuation manager owns identity reservation, composition, Agent
   * creation, prompt delivery, cold resume, ownership, and disposal, so a
   * provider never sees the child's Agent, handle, turns, or teardown.
   * Distinct preparations may overlap; each follows its own signal and returns
   * data belonging only to `request.sessionId`.
   */
  prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
}
```

提供方的 `start()` 会以已发布的 run fulfill。服务铸造唯一的 `runId`，从提供方确切的 `localAgent` 快照 `local`，观察结果，emit `subagent/start`，并返回同一个 run；`start()` rejection 意味着未发布资源已清理，且不会 emit 生命周期事件对，而发布后的结果 rejection 会结束已经 emit 的事件对。每个可继续 Activation 都会为其驻留纪元 emit 相同的仅观察事件对，因此一次冷恢复就是一段拥有自己 `runId` 的新纪元。配对的 `subagent/end` 携带相同标识与最终输出或基础设施失败。两个事件都仅用于观察，且会隔离各自的 listener 异常。其中的 `provider` 字段标明了启动 run 或 Activation 时段的提供方，并不声明该 edge 发出时提供方仍处于注册状态。

## 进程内后端：深度与种子

spawn 和 fork 后端通过 `parent.ctx` 创建一个普通的单次 agent，将取消信号传入核心创建流程，并通过 `AgentHandle` 进行 dispose；而可继续子 agent 则由继续执行管理器通过其自己的 activation-owner 作用域创建。移除提供方会阻止新的 start，但不会撤销已接受的 run。每个子 agent 获得一个新的扁平作用域，而非继承父级注册。深度与 fork 种子注入复用既有的 agent 和会话词汇：

- **委派深度**由持久 `SessionHeader.delegationDepth` 与可合并扩展的运行时字段 `AgentOptions.subagentDepth` 共同表示；缺失表示顶层深度为零，存在的较大值具有权威性。两个字段都归该 seam 所有——循环既不设置也不读取它们——因此进程内子 agent 会持久保存 parent 深度 + 1，冷恢复无法降低深度，而且每次 start 都会拒绝超出安全整数域、或高于已定义绝对 `request.maxDepth` 上限的派生深度。
- **Fork 种子注入**使用 [`CreateAgentOptions.seed`](core.zh.md#creation-and-ownership)（一个 `SessionEvent[]` 前缀，经由 `AgentLoop.createAgent` → `ctx.sessions.prepare({ seed })` 传递，与 `ctx.agents.resume()` 使用的原语相同）。fork 后端传入父级日志的一段*平衡的已完成轮次前缀*——父级事件直到并包括其最后一个 `turn/end`——因此种子从 0 连续，[invariants](../../packages/runtime-diagnostics/invariants) 回放可以接受它（进行中的、未平衡的轮次被排除在外）。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsubagentmodelselection--subagentmodelselectionconfig"></a>

### `ctx.subagentModelSelection` — `SubagentModelSelectionConfig`

Singleton settings owner read by delegation tools when an Agent is published.

```ts cordis-catalog
/**
 * Read a detached selection preference for the next eligible Agent publication.
 * @returns the enabled state and exact allowed routes.
 */
current(): SubagentModelSelectionSettings
```

Source: [`packages/subagent/tool-subagent/src/model-selection-settings.ts`](../../packages/subagent/tool-subagent/src/model-selection-settings.ts)

<a id="ctxsubagents--subagentruntime"></a>

### `ctx.subagents` — `SubagentRuntime`

Named provider registry with one-shot runs, durable discovery, and continuable-child operations.

```ts cordis-catalog
/**
 * Establish one durable continuable child and deliver its initial prompt.
 * Resolves when the child's inbox accepts that prompt, without waiting for the
 * turn to start or for the message to reach the Session log; any earlier
 * failure rejects with no ids and rolls back the child entirely.
 * @param spec - provider, delegation request, and caller cancellation.
 * @returns the durable child id and the accepted prompt's message id.
 * @throws when continuation services are unavailable or materialization fails.
 */
async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>

/**
 * Steer one model-authored message to the sender's direct parent or direct
 * continuable child. A running target admits it at the nearest step boundary;
 * an idle target starts a turn, and an absent direct child cold-resumes from
 * persistence. The service derives durable sender attribution from the exact
 * live sender. Caller cancellation stops only pre-acceptance work.
 * @param sender - exact live Agent authorizing and originating the message.
 * @param targetId - durable direct-parent or direct-child session id.
 * @param content - model-authored content to deliver.
 * @param options - caller cancellation before inbox acceptance.
 * @returns the accepted message's inbox id.
 * @throws when continuation services are unavailable, adjacency is rejected,
 *   or the message was not admitted.
 */
async sendMessage( sender: Agent, targetId: SessionId, content: ContentBlock[], options: SubagentSendMessageOptions, ): Promise<MessageId>

/**
 * Interrupt one live continuable child's current turn under a human parent
 * address or an exact live ancestor Agent. Fire-and-return: the cancel
 * signal is issued before this returns, but the target may keep running
 * until it observes the signal. Unclaimed pending inbox work, the Activation,
 * and published descendants are preserved; claimed work is not requeued.
 * Once the interrupted driver is idle, a waking send resumes the parked FIFO
 * queue. An absent target — including a one-shot or unknown id —
 * is an accepted no-op, as is a manager-less composition, which cannot own a
 * live Activation.
 * @param targetSessionId - the durable child session id to interrupt.
 * @param authority - the human parent address or exact live ancestor Agent.
 * @throws {SubagentError} `UNAUTHORIZED` when the authority does not own the
 *   live target.
 */
interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void

/**
 * Close continuable admission below exact live parent Agents, stop only their
 * visible descendant Activations synchronously, then await admitted scoped
 * materializations and release those forests child-first. The scoped cutoff
 * lasts until each exact parent leaves the registry; unrelated parent trees
 * remain live.
 * @param parents - exact host-owned parent Agents entering teardown.
 * @returns once every retained descendant Activation released its `AgentHandle`.
 * @throws an aggregate error after all branches settle when any failed.
 */
async drainContinuableDescendants(parents: readonly Agent[]): Promise<void>

/**
 * Release selected resident continuable direct children of one exact live
 * parent. Other children of the same parent remain admitted and resident.
 * Absent targets and a manager-less composition are accepted no-ops.
 * @param parent - exact live direct parent authorizing the selected release.
 * @param childIds - durable direct-child ids to release when resident.
 * @returns once every selected Activation released its `AgentHandle`.
 * @throws {SubagentError} `UNAUTHORIZED` when a resident target belongs to a
 *   different parent or the supplied parent identity is stale.
 */
async drainContinuableChildren(parent: Agent, childIds: readonly SessionId[]): Promise<void>

/**
 * Enumerate the parent's direct session-backed subagents without loading or
 * resuming an Agent. The Session query service supplies one live-preferred
 * corpus and shared point observations; the projection cache supplies
 * immutable descriptor hits without opening cold logs. The registered
 * `subagent` projection remains the sole mode/label classifier.
 *
 * Every query receives `signal`, and the listing rechecks cancellation
 * around each await. Read rejections that settle
 * after an abort become a stable `SubagentError` with code `CANCELLED`.
 * @param parentSessionId - parent session whose direct children are listed.
 * @param signal - caller-owned cancellation forwarded to Session queries
 *   and observed around every read await.
 * @returns children and per-child diagnostics ordered by `createdAt`, then id.
 * @throws {@link SubagentError} when the projection registry or the session
 *   store is not mounted, or the caller cancels the listing.
 */
listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentListEntry[]>

/**
 * Enumerate the root's complete session-backed subagent tree in stable
 * pre-order from one live-preferred corpus, without loading or resuming an
 * Agent. Ordinary sessions and one-shot children remain traversal nodes so
 * continuable descendants below them are discovered; each returned entry
 * adds its durable `parentId` and root-relative `depth`. Identity resolution,
 * diagnostics, optional persistence, and cancellation follow the same
 * projection-backed contract as {@link listChildren}.
 * @param rootSessionId - session whose complete descendant tree is listed.
 * @param signal - caller-owned cancellation forwarded to persistence reads
 *   and observed around every read await.
 * @returns children and per-candidate diagnostics with tree position, in
 *   stable pre-order.
 * @throws {@link SubagentError} under the same conditions as {@link listChildren}.
 */
listDescendants(rootSessionId: SessionId, signal?: AbortSignal): Promise<SubagentDescendantListEntry[]>

/**
 * Remote face of {@link listChildren} for one browser: the durable listing
 * plus live Agent activity and the delivery-time parent availability hint.
 * Parent availability is a hint; {@link prompt} performs the authoritative
 * check. Named apart from the provider-name {@link list}, which owns the
 * member.
 * @param parentSessionId - parent session whose direct children are listed.
 * @param signal - carrier cancellation forwarded to Session queries.
 * @returns the catalog view for that parent.
 * @throws {RemoteError} `gateway/bad-request` for an empty parent id,
 *   `gateway/cancelled` for an aborted read, `subagent/projections-unavailable` when
 *   the deployment has no projection registry, otherwise `gateway/internal`.
 */
@Remote('list') async remoteExportList(parentSessionId: SessionId, signal: AbortSignal): Promise<SubagentCatalog>

/**
 * Deliver one browser-authored message to a continuable child through the
 * exact live direct parent, retaining the caller-minted request identity and
 * validated browser zone on the accepted message. Success identifies the
 * message the child's FIFO inbox accepted; later execution is independent of
 * this call.
 * Image parts are admitted and persisted through the attachment store
 * before delivery, and the child's model must accept image input.
 * @param request - durable address, minted identity, content, and optional browser zone.
 * @param signal - carrier cancellation, owning the call until inbox acceptance.
 * @returns the accepted message's inbox identity.
 * @throws {RemoteError} `gateway/bad-request`, `subagent/attachment-invalid`,
 *   `subagent/invalid-time-zone`, `subagent/parent-unavailable`,
 *   `subagent/not-resumable`, `subagent/unauthorized`,
 *   `subagent/delivery-unavailable`, `gateway/cancelled`, or `gateway/internal`.
 */
@Remote('prompt') async prompt(request: SubagentPromptRequest, signal: AbortSignal): Promise<SubagentPromptReceipt>

/**
 * Remote face of {@link interrupt} under one durable parent address. No
 * catalog, history, persistence, or parent Agent lookup runs: the core
 * primitive alone authorizes the address against the live Activation, which
 * is what keeps a live child interruptible while its parent Agent is offline.
 * Absent, idle, and already-completed targets are accepted no-ops there.
 * @param childSessionId - durable child session id to interrupt.
 * @param parentSessionId - durable direct parent whose authority is claimed.
 * @param mode - required continuable-address discriminator.
 * @returns acknowledgement that the cancel signal was admitted, not that the target is quiescent.
 * @throws {RemoteError} `gateway/bad-request` for an empty id,
 *   `subagent/unauthorized` when the address does not own the live target,
 *   otherwise `gateway/internal`.
 */
@Remote('interruptByParent') interruptByParent( childSessionId: SessionId, parentSessionId: SessionId, mode: 'continuable', ): SubagentInterruptReceipt

/**
 * Register a provider under its name. Registration is effect-scoped and HMR
 * safe; removing a provider blocks new starts but does not revoke runs that
 * were already returned to their holders.
 * @param provider - the trusted provider implementation.
 * @returns the exact Cordis effect disposer.
 */
registerProvider(provider: SubagentProvider): () => void

/**
 * Look up a provider by name.
 * @param name - the provider name.
 * @returns the provider, or undefined when absent.
 */
getProvider(name: string): SubagentProvider | undefined

/**
 * List registered provider names in insertion order.
 * @returns the registered names.
 */
list(): string[]

/**
 * Establish a published child on the named provider. Capability and semantic
 * checks run before delegation. Provider ownership lasts until its promise
 * fulfills; a rejection therefore has no run for the caller to dispose and
 * emits no run lifecycle events. Post-publication turn and infrastructure
 * failures settle through the returned run.
 * @param name - the provider to use.
 * @param request - child label, prompt, parent, signal, and optional capabilities.
 * @returns the published holder-owned run.
 */
async start(name: string, request: SubagentStartRequest): Promise<SubagentRun>
```

Types: [Agent](core.zh.md) · [ContentBlock](llm-streaming.zh.md) · [MessageId](llm-streaming.zh.md) · [SessionId](core.zh.md)

Source: [`packages/subagent/subagent/src/index.ts`](../../packages/subagent/subagent/src/index.ts)

<a id="subagent-events"></a>

### `subagent/*` events

<a id="subagentend--emit"></a>

#### `subagent/end` — emit

A published child settled. Scope-filtered dispatch uses the same delegating parent carrier as `subagent/start`, so the lifecycle pair reaches the same scoped audience.

```ts cordis-catalog
/**
 * A published child settled. Scope-filtered dispatch uses the same delegating
 * parent carrier as `subagent/start`, so the lifecycle pair reaches the
 * same scoped audience.
 * @param info - the run identity and terminal outcome.
 * @dshScopeScan unsupported
 * @mode emit
 */
'subagent/end'(this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo): void
```

Types: [Scoped](scope.zh.md)

Source: [`packages/subagent/subagent/src/index.ts`](../../packages/subagent/subagent/src/index.ts)

<a id="subagentprovider-added--emit"></a>

#### `subagent/provider-added` — emit

A provider became resolvable in the registry.

```ts cordis-catalog
/**
 * A provider became resolvable in the registry.
 * @param provider - the registered provider.
 * @mode emit
 */
'subagent/provider-added'(provider: SubagentProvider): void
```

Source: [`packages/subagent/subagent/src/index.ts`](../../packages/subagent/subagent/src/index.ts)

<a id="subagentprovider-removed--emit"></a>

#### `subagent/provider-removed` — emit

A provider left the registry. Accepted runs remain holder-owned.

```ts cordis-catalog
/**
 * A provider left the registry. Accepted runs remain holder-owned.
 * @param name - the provider name that no longer resolves.
 * @mode emit
 */
'subagent/provider-removed'(name: string): void
```

Source: [`packages/subagent/subagent/src/index.ts`](../../packages/subagent/subagent/src/index.ts)

<a id="subagentstart--emit"></a>

#### `subagent/start` — emit

A provider established a published child. For in-process providers, `ctx.agents.get(info.id)` resolves during this notification. Scope-filtered dispatch keys the carrier by the delegating parent, so a parent-scoped listener observes only its own delegations. Paired with `subagent/end`.

```ts cordis-catalog
/**
 * A provider established a published child. For in-process providers,
 * `ctx.agents.get(info.id)` resolves during this notification.
 * Scope-filtered dispatch keys the carrier by the delegating parent, so a
 * parent-scoped listener observes only its own delegations. Paired with
 * `subagent/end`.
 * @param info - the provider and published child identity.
 * @dshScopeScan unsupported
 * @mode emit
 */
'subagent/start'(this: Scoped<SubagentRuntime>, info: SubagentRunInfo): void
```

Types: [Scoped](scope.zh.md)

Source: [`packages/subagent/subagent/src/index.ts`](../../packages/subagent/subagent/src/index.ts)
<!-- END GENERATED cordis-surface -->
