# 子代理

[English](subagent.md) | 中文

统一的 activation API 管理本地对话和外部执行。创建祖先关系、运行归属和通信由 subagent 树管理。[subagent 控制工具](../../packages/subagent/tool-subagent-control/README.zh.md)负责 agent 身份和当前调用者的收件箱等待；Team 工具添加共享任务与任务策略。

## 能力与 activation 请求

所有后端都使用 startActivation。能力标记校验请求选项；prepareContinuable 选择本地 Agent 创建，start 选择一次外部执行。面向模型的工具采用 parent 回传。Workflow 与 code mode 消费者可以等待 caller 结果，不额外向父代理注入消息。历史子会话的 descriptor 不可用时，以 `mode: 'unknown'` 保持可发现性，但不授予继续执行能力；[包 README](../../packages/subagent/subagent/README.zh.md) 定义目录持久化语义。

可选的 `cwd` 指定子级的初始目录；相对路径以父级当前有效目录为基准解析。省略时，在准入阶段捕获该目录。本地子 Session 保留父级的原始项目，冷恢复保留其日志中的目录状态。

```ts type-equiv
/**
 * Start-time options supported by a registered backend. The manager checks
 * every requested option before preparing a local child or starting an external
 * execution. depthLimit controls maxDepth; the remaining flag names match
 * SubagentStartRequest fields.
 */
interface SubagentCapabilities {
  readonly agentOptions: boolean
  /** Supports selecting a preset independently of the parent's composition. */
  readonly agentPreset: boolean
  readonly outputSchema: boolean
  readonly depthLimit: boolean
}
```

```ts type-equiv
/** One managed child execution and its result delivery policy. */
interface SubagentActivationSpec extends Omit<SubagentStartRequest, 'label' | 'signal'> {
  /** Registered backend to use. */
  readonly provider: string
  /** Short task label retained in cataloged child membership. */
  readonly label: string
  /**
   * Requested name, unique among the parent's children: 1–32 lower-case
   * letters, digits, or hyphens starting with a letter, other than `lead`.
   * Omission selects the first free `agent-N`.
   */
  readonly name?: string
  /** Optional reserved identity for a local child; external backends allocate their own ids. */
  readonly childId?: SessionId
  /** Cancellation before publication; callers own later cancellation through dispose. */
  readonly signal: AbortSignal
  /** Parent delivery notifies the model; caller delivery only returns the result. Local children always enter the parent catalog. */
  readonly delivery: 'parent' | 'caller'
}
```

```ts type-equiv
/** A managed execution; disposal addresses this exact activation, never a later resume. */
interface SubagentActivation {
  /** Stable identity of the child. */
  readonly childId: SessionId
  /**
   * Model-facing name: slash-separated names from the root when every creator
   * below the root is named, otherwise the child Session id.
   */
  readonly name: string
  /** Accepted inbox message, when the backend has a local inbox. */
  readonly messageId?: MessageId
  /**
   * Execution result after teardown settles and notifications are sent; capture failures reject.
   * Teardown failures are reported by dispose() without replacing a captured result.
   */
  readonly result: Promise<SubagentResult>
  /** Stop and release only this activation; rejects on teardown failure. */
  dispose(): Promise<void>
}
```

```ts type-equiv
/**
 * Task and optional capabilities supplied to a backend. The activation spec
 * shares these task options and defines its own label and cancellation policy.
 */
interface SubagentStartRequest {
  /** Initial child directory; relative paths resolve against the parent's current directory. Omitted inherits that directory at start. */
  readonly cwd?: string
  /**
   * Independent preset id; omission joins the parent's current generation.
   * Requires a provider with `capabilities.agentPreset` that does not inherit
   * parent context.
   */
  readonly agentPreset?: string
  /** Optional short display label persisted with a session-backed child. */
  readonly label?: string
  /** Content delivered as the child's user message. */
  readonly prompt: ContentBlock[]
  /**
   * The spawning agent. Its effective directory supplies the default cwd;
   * in-process children retain its origin, lineage, and delegation depth.
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
}
```

```ts type-equiv
/** Provider-facing request with an absolute directory selected before startup. */
interface ResolvedSubagentStartRequest extends SubagentStartRequest {
  /** Absolute child directory captured from the parent or explicit request. */
  readonly cwd: string
}
```

## 本地子代理与 activation

只有 spawn 支持独立的 `agentPreset`；省略选择与 fork 都继承父方的活跃组装。[子级 preset 规则](../../packages/subagent/subagent/README.zh.md#restoring-child-composition)定义显式选择、事件顺序和历史恢复行为。

本地子代理拥有持久 Session，最多有一个在线 activation。Manager 预留身份和容量，通过后端准备子代理，并管理输入准入、冷恢复以及先子后父的释放顺序。activation 结果在资源释放和完成通知之后结算。释放操作单独报告清理失败，不会覆盖已捕获的结果。结构化结果提交会关闭该 activation 的输入；之后的冷恢复不会继承输出 schema。

```ts type-equiv
/**
 * What the continuation manager asks a provider for while materializing one
 * continuable child's FIRST activation. The manager has already reserved the
 * durable child identity and owns every later operation, so this request
 * carries only what distinguishes a fresh child from one seeded with parent
 * history.
 */
interface ContinuableCreateRequest {
  /** Absolute initial directory captured before provider preparation. */
  readonly cwd: string
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

## Agent 名称

Session id 仍是路由、授权、持久化和任务归属使用的唯一执行身份；名称是面向模型的引用。`SubagentActivation.name` 是子级的完整名称；当从根开始的每一级都有名称时，`listDescendants()` 的行以 `path` 携带该名称。`namesOf(agent)` 报告在线成员及其直接创建者的名称；根的名称为 `lead`。`resolveName(caller, name, signal)` 为 `lead` 或完整名称返回对应 Session id；树中不存在的其他文本原样作为 Session id 返回，而指向无成员的斜杠路径以 `AGENT_NAME_NOT_FOUND` 失败。调用方授权解析结果；解析本身不授予权限。[包 README](../../packages/subagent/subagent/README.zh.md#agent-names) 定义名称规则、默认值、失败和目录持久化。

```ts type-equiv
/** Model-facing names of one live tree member and its direct creator. */
interface SubagentMemberNames {
  /** `lead` for the root, the slash-separated path for a named descendant, otherwise the Session id. */
  readonly self: string
  /** The direct creator's name by the same rule; absent for the root. */
  readonly parent?: string
}
```

## 消息与中断

`sendMessage` 要求确切在线发送方和同一根树中的目标 Session id。根和可继续成员可跨分支发消息；接纳时重新校验发送方和根。运行中目标接收 Steer；只冷恢复不在线的目标，其创建祖先可以保持离线。外部执行拒绝后续输入。本地和外部执行仅向仍在线的直接创建者报告最终文本、结构化输出、诊断和状态；caller 投递抑制这些通知。`drainDescendants` 等待整棵树释放；activation 回执的 `dispose()` 仅释放那一次执行。

```ts type-equiv
/** Durable attribution for one model-authored message between Agents. */
interface AgentMessageSource {
  readonly kind: 'agent-message'
  /** A message another agent addressed to this one (`relay` context form). */
  readonly form: 'relay'
  /** Session id of the Agent whose tool call produced the message. */
  readonly senderSessionId: SessionId
}
```

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
  /** Exact execution stop reason; absent on historical notices. Writers always include it. */
  readonly stopReason?: SubagentResult['stopReason']
  /** Session id of the child that settled. */
  readonly senderSessionId: SessionId
}
```

```ts type-equiv
/** Options for one model-authored message within a subagent tree. */
interface SubagentSendMessageOptions {
  /** Caller cancellation, owning the operation only until inbox acceptance. */
  readonly signal: AbortSignal
}
```

```ts type-equiv
/**
 * Authority under which one interrupt request is admitted. `user` is a trusted
 * host operation; Remote callers need permission on the target Session before
 * invoking it. `ancestor` carries an exact live Agent in the target's creation ancestry.
 */
type SubagentInterruptAuthority =
  | { readonly kind: 'user' }
  | { readonly kind: 'ancestor'; readonly agent: Agent }
```

## 持久枚举

父级拥有的 `subagentCatalog` 投影列出所有本地子级及 parent 投递的外部子级。caller 投递的外部执行由调用方负责成员关系与结果收集；本地工作流子级在完成后仍可被发现。外部条目携带 `mode: 'external'`，不能打开子 Session 或接受后续消息。目录在创建时记录成员关系，不携带执行状态。`list_agents` 展示根和可达的可继续后代，其活跃状态为 `running` 或 `inactive`；参见[控制工具](../../packages/subagent/tool-subagent-control/README.zh.md#list_agents)。

## 结果与后端句柄

SubagentResult 供程序消费方读取。activation 注册表保留外部后端句柄，直到释放完成。清理失败不会覆盖已捕获的执行结果：activation 结果与父级通知保留该结果，dispose 拒绝，而在线 subagent/end 事件报告 error。后端提供的诊断必须满足下述安全信息要求。

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
  readonly output: readonly ContentBlock[]
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

```ts type-equiv
/**
 * Backend execution handle owned directly by the activation registry.
 * A result may become available before resource release; the manager always
 * disposes the handle and awaits cleanup. Backend startup failures clean up
 * partial resources before rejecting, while accepted execution failures settle
 * through result.
 */
interface SubagentRun {
  /** Provider-minted id, unique across all parents, providers, and local Sessions in this runtime. */
  readonly id: SessionId
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

## 提供方约定：SubagentProvider

`SubagentManager` 统一管理启动、消息准入与执行生命周期。Spawn 与 Fork 提供用于本地 Agent 的独立创建输入。Codex、Claude Code、ACP 和 DSH SDK 提供一个执行句柄，不增加多轮能力。每条 activation 都是直接持有 AgentHandle 或 SubagentRun 的执行期记录。外部完成由句柄的 result promise 确定；inbox 与空闲准入仅属于本地执行。两条路径共用准入、容量、父子所有权、取消和释放机制。[包参考](../../packages/subagent/subagent/README.zh.md)说明组合与部署要求。

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
   * Optional static provider-owned provider/model route for child Agent
   * options. Consumers merge tool/model overrides over these values before
   * preflight; providers whose route derives from the parent omit it. The value
   * is detached immutable data and requires `agentOptions` support.
   */
  readonly agentRouteDefaults?: Readonly<{ provider: string; model: string }>
  /**
   * Establish one external execution and return its owned handle.
   * The service has already validated that every requested start-time
   * capability is supported. Before fulfillment, the provider owns setup and
   * cleans any unpublished partial resources before rejecting. Ownership transfers on
   * fulfillment; subsequent turn or infrastructure failure settles through
   * the returned run. Distinct starts may overlap; cancellation, failure,
   * result settlement, and disposal remain independent for each run.
   */
  start?(request: ResolvedSubagentStartRequest): Promise<SubagentRun>
  /**
   * OPTIONAL (continuable-creation capability): contribute the detached
   * creation inputs that distinguish this provider's continuable children —
   * only whether the child session is seeded with parent history. Method
   * presence selects local activation execution. Providers without it execute
   * through start and do not accept subsequent messages.
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

## 持久化枚举：`listDescendants()` 与目录条目

模型侧的 `list_agents` 适配器将当前活动表示为 `running` 或 `inactive`。这些值不描述任务完成情况，也不保证 `send_message` 会成功。

通过 `ctx.sessionQuery.observeSession(parentSessionId, { signal })`，可从 `observation.projections?.values.subagentCatalog` 获取直接子级条目；调用方使用 `using` 释放观察对象。条目遵循父会话事件顺序，不读取子级日志，也不枚举 Session 语料库。查询失败直接传播；缺少目录投影意味着发现功能不可用。浏览器条目从共享 projection store 派生成员关系，并从 Session 状态补充活动状态；control stream 推送完整目录更新。`listDescendants()` 递归读取这些目录，并从每个子级目录推导 `hasChildren`。[父目录 Agent Note](../../.agents/notes/implemented/architecture/2026-09-01-parent-owned-subagent-catalog.zh.md) 说明创建、fork 隔离、排序和持久化成本。

`SubagentRuntime.listDescendants(rootSessionId)` 以稳定前序递归调用同一目录读取函数，保留每个父级的事件顺序。外部条目是没有本地 Session 的叶节点。一次性和未知模式条目仍是遍历节点；未知模式产生 `unsupported` 诊断。无法读取的子级目录产生 `corrupt` 或 `unavailable`，只停止该分支。根读取失败、服务或投影缺失、取消会使整个查询失败。每个可达目录只观察一次，并在下一次读取前释放；重复 id 和循环引用会被跳过。可达目录中不存在的 Session 不会被发现，包括普通 Session fork 及其下的子 agent。每行携带目录中的父级、相对根的深度；当从根开始的每一级都有名称时，还以 `path` 携带完整名称：

```ts type-equiv
/** One catalog descendant with its direct parent and edge distance from the requested root. */
type SubagentDescendantListEntry = SubagentListEntry & {
  /** Parent whose catalog contains this child. */
  readonly parentId: SessionId
  /** Edge distance from the requested root; direct children are `1`. */
  readonly depth: number
  /** Slash-separated names from the requested root; absent when this child or an ancestor below the root has no name. */
  readonly path?: string
}
```


<a id="the-terminal-result-subagentresult"></a>


<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsubagentmodelselection--subagentmodelselectionconfig"></a>

### `ctx.subagentModelSelection` — `SubagentModelSelectionConfig`

Host settings owner that records Session authorization before the first model request.

Source: [`packages/subagent/tool-subagent/src/model-selection-settings.ts`](../../packages/subagent/tool-subagent/src/model-selection-settings.ts)

<a id="ctxsubagents--subagentruntime"></a>

### `ctx.subagents` — `SubagentRuntime`

Named provider registry with managed activations, durable discovery, and local child messaging.

```ts cordis-catalog
/**
 * Resolve a delegation tool's depth policy against the current user setting.
 * @param configured - Explicit tool limit, or provider-managed for external delegation.
 * @returns The numeric limit, or undefined when the provider owns depth enforcement.
 */
resolveMaxDepth(configured?: number | 'provider-managed'): number | undefined

/**
 * Start a local child under its reserved identity.
 * @param spec - local task, reserved child id, and result recipient.
 * @returns activation with its accepted initial message id.
 */
startActivation(spec: SubagentActivationSpec & { readonly childId: SessionId }): Promise<SubagentActivation & { readonly messageId: MessageId }>

/**
 * Start a local or external child.
 * @param spec - task, backend, and result recipient.
 * @returns activation with a message id only for local children.
 */
startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>

/**
 * Resolve the root shared by an Agent and its other agents in its subagent tree.
 * @param caller - exact live Agent whose subagent ancestry selects the tree.
 * @returns the live root; ordinary Session forks lead independent trees.
 * @throws when the caller or its runtime owner is unavailable.
 */
rootOf(caller: Agent): Agent

/**
 * Report the model-facing names of a live tree member and its direct creator.
 * The root is `lead`; a descendant is the slash-separated path of names from
 * the root, or its Session id when it or a creator below the root has no name.
 * @param agent - exact live root or resident tree member.
 * @returns the member's name and, for a descendant, its creator's name.
 * @throws when the caller or its runtime owner is unavailable.
 */
namesOf(agent: Agent): SubagentMemberNames

/**
 * Resolve a model-supplied agent reference within the caller's tree. `lead`
 * selects the root and a slash-separated path is looked up through the
 * catalogs along it. Any other text that is not a name in the tree is
 * returned as a Session id, because a single token can be one; a
 * slash-separated address never is, so an unmatched path fails instead of
 * reaching a member lookup as an unknown id. Resolution grants no authority:
 * messaging, interruption, and assignment authorize the result.
 * @param caller - exact live Agent whose tree root anchors the lookup.
 * @param name - `lead`, a full name from the root, or a Session id.
 * @param signal - cancellation forwarded to each catalog read.
 * @returns the referenced Session id.
 * @throws {@link SubagentError} `AGENT_NAME_NOT_FOUND` when a path names no member;
 *   when the caller's root is unavailable; or when a catalog along the path cannot be read.
 */
async resolveName(caller: Agent, name: string, signal: AbortSignal): Promise<SessionId>

/**
 * Join progressing subagent tree work for its root. Idle members with parked input
 * stay resident without delaying host completion. Ordinary members return false.
 * @param root - exact live subagent tree root whose member work is awaited.
 * @returns whether work was joined; hosts recheck root idle after true.
 */
async waitForTreeWork(root: Agent): Promise<boolean>

/**
 * Steer one model-authored message to another member of the same subagent tree.
 * A running target receives it at its next step; an idle target starts a turn.
 * A cold target resumes under its runtime subagent tree root without restoring
 * its creation ancestors. Sender identity is rechecked before inbox acceptance; cancellation
 * stops only pre-acceptance work and never retracts an accepted message.
 * @param sender - exact live root or resident continuable Agent originating the message.
 * @param targetId - another root or continuable member's durable Session id.
 * @param content - model-authored content to deliver.
 * @param options - caller cancellation before inbox acceptance.
 * @returns the accepted message's inbox id.
 * @throws when the target is outside the tree, cannot resume, or rejects input.
 */
async sendMessage( sender: Agent, targetId: SessionId, content: ContentBlock[], options: SubagentSendMessageOptions, ): Promise<MessageId>

/**
 * Interrupt one live child's current execution under a trusted user
 * operation or an exact live ancestor Agent. Fire-and-return: the cancel
 * signal is issued before this returns, but the target may keep running
 * until it observes the signal. Unclaimed pending inbox work, the Activation,
 * and published descendants are preserved; claimed work is not requeued.
 * Once the interrupted Agent is idle, a waking send resumes the parked FIFO
 * queue. External backends stop their single execution. An absent target
 * is an accepted no-op, as is a manager-less composition, which cannot own a
 * live Activation.
 * @param targetSessionId - the durable child session id to interrupt.
 * @param authority - a trusted user operation or exact live ancestor Agent.
 * @throws {SubagentError} `UNAUTHORIZED` when the authority does not own the
 *   live target.
 */
interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void

/**
 * Close admission and stop all instances in the selected subagent trees, then await
 * pending startup and cleanup. Ordinary members are ignored. The cutoff lasts
 * until each exact root leaves the registry; unrelated subagent trees remain live.
 * @param parents - exact live subagent tree roots entering teardown.
 * @returns once all admitted startup and member cleanup have settled.
 * @throws an aggregate error after all branches settle when any failed.
 */
async drainDescendants(parents: readonly Agent[]): Promise<void>

/**
 * Recursively list reachable parent catalogs in stable pre-order, preserving
 * each catalog's event order. Each row carries its catalog parent and depth;
 * external children are leaves; one-shot and unknown-mode children remain
 * traversal nodes. Unknown modes
 * produce unsupported diagnostics. Unreadable child catalogs produce corrupt
 * or unavailable diagnostics and stop only that branch. Root read failures,
 * missing services or projections, and cancellation reject the whole listing.
 * Each catalog is observed once and released before the next read. No Agent
 * is loaded or resumed; Sessions absent from reachable catalogs are omitted.
 * @param rootSessionId - session whose catalog starts descendant discovery.
 * @param signal - cancellation forwarded to and checked around each catalog read.
 * @returns children and branch diagnostics in parent-catalog pre-order.
 * @throws {@link SubagentError} when listing dependencies are unavailable or the caller cancels.
 * @throws SessionQueryError when the root catalog cannot be read.
 */
listDescendants(rootSessionId: SessionId, signal?: AbortSignal): Promise<SubagentDescendantListEntry[]>

/**
 * Deliver one browser-authored message to a continuable child through its
 * live subagent tree root, retaining the caller-minted request identity and
 * validated browser zone on the accepted message. Success identifies the
 * message the child's inbox accepted; later execution is independent of this
 * call. Queue delivery targets a later turn; steer delivery targets the
 * nearest step and retains the Agent loop's best-effort fallback semantics.
 * Image parts are admitted and persisted through the attachment store
 * before delivery, and the child's model must accept image input.
 * Cold resume at capacity rejects with `subagent/delivery-unavailable`.
 * Access is checked on the target Session before attachment admission or restoration.
 * @param request - target id, delivery, minted identity, content, and optional browser zone.
 * @param signal - carrier cancellation, owning the call until inbox acceptance.
 * @returns the accepted message's inbox identity.
 * @throws {RemoteError} `gateway/bad-request`, `subagent/attachment-invalid`,
 *   `subagent/invalid-time-zone`,
 *   `subagent/not-resumable`, `subagent/unauthorized`,
 *   `subagent/delivery-unavailable`, `gateway/cancelled`, or `gateway/internal`.
 */
@Remote({ name: 'prompt', resources: { session: request => request.childSessionId } }) async prompt(request: SubagentPromptRequest, signal: AbortSignal): Promise<SubagentPromptReceipt>

/**
 * Remote face of {@link interrupt}, authorized on the target Session by the Gateway.
 * No catalog, history, persistence, or parent Agent lookup runs.
 * Absent, idle, and already-completed targets are accepted no-ops there.
 * @param childSessionId - durable child session id to interrupt.
 * @returns acknowledgement that the cancel signal was admitted, not that the target is quiescent.
 * @throws {RemoteError} `gateway/bad-request` for an empty id,
 *   otherwise `gateway/internal`.
 */
@Remote({ name: 'interruptByUser', resources: { session: childSessionId => childSessionId } }) interruptByUser(childSessionId: SessionId): SubagentInterruptReceipt

/**
 * Register a provider under its name. Registration is effect-scoped and HMR
 * safe; removing a provider blocks new starts but does not revoke runs that
 * were already returned to their holders. Providers without either execution
 * method are rejected with UNSUPPORTED_CAPABILITY before registration.
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
```

Types: [Agent](core.zh.md) · [ContentBlock](llm-streaming.zh.md) · [MessageId](llm-streaming.zh.md) · [SessionId](core.zh.md)

Source: [`packages/subagent/subagent/src/index.ts`](../../packages/subagent/subagent/src/index.ts)

<a id="subagent-events"></a>

### `subagent/*` events

<a id="subagentend--emit"></a>

#### `subagent/end` — emit

A published child settled. Scope-filtered dispatch uses the same subagent tree-root carrier as `subagent/start`, so the lifecycle pair reaches the same scoped audience.

```ts cordis-catalog
/**
 * A published child settled. Scope-filtered dispatch uses the same subagent tree-root
 * carrier as `subagent/start`, so the lifecycle pair reaches the
 * same scoped audience.
 * @param info - run identity, durable direct creator `parentSessionId`, and terminal outcome.
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

A provider established a published child. For in-process providers, `ctx.agents.get(info.id)` resolves during this notification. Scope-filtered dispatch keys the carrier by the subagent tree root, so a root-scoped listener observes all subagent tree activations. Paired with `subagent/end`.

```ts cordis-catalog
/**
 * A provider established a published child. For in-process providers,
 * `ctx.agents.get(info.id)` resolves during this notification.
 * Scope-filtered dispatch keys the carrier by the subagent tree root, so a
 * root-scoped listener observes all subagent tree activations. Paired with
 * `subagent/end`.
 * @param info - provider, child identity, and durable direct creator `parentSessionId`.
 * @mode emit
 */
'subagent/start'(this: Scoped<SubagentRuntime>, info: SubagentRunInfo): void
```

Types: [Scoped](scope.zh.md)

Source: [`packages/subagent/subagent/src/index.ts`](../../packages/subagent/subagent/src/index.ts)
<!-- END GENERATED cordis-surface -->
