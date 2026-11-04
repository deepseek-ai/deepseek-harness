# Agent Teams

[English](agent-team.md) | 中文

共享任务板、模型工具和 host 适配器共享的类型。[任务板等待决策](../../.agents/notes/implemented/architecture/2026-10-19-team-task-board-inbox.zh.md)负责协调语义；本页记录 [`packages/team/agent-team/src/types.ts`](../../packages/team/agent-team/src/types.ts) 中的持久化和客户端可见形式。

## 身份与历史名册

`TeamId` 品牌化根 `SessionId`；`TeamTaskId` 使用 `task-<n>`。`TeamMessageId` 和名册记录为历史解码保留。subagent 运行时解析树，并发现任意深度的有效任务所有者；历史名册条目不授予权限。

```ts type-equiv
/** Historical roster value written by earlier Team builds on every teammate lifecycle change. */
interface TeamMemberSnapshot {
  readonly id: SessionId
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly context: 'fresh' | 'fork'
  readonly phase: TeamMemberPhase
  readonly error?: string
}
```

历史记录保留其记录的 `provisioning`、`active` 或 `failed` 阶段。当前轮次活动属于普通 subagent 发现和 Session 状态，与任务完成相互独立。

## 消息与历史 mailbox

成员交换普通 [subagent 消息](subagent.zh.md)，保留真实发送方 Session id。任务变更不会结束收件箱等待、添加收件箱消息或启动空闲 agent。需要 agent 处理任务更新时，发送明确消息。下列历史邮箱类型保持可读；Team 绝不投递其待处理记录。

```ts type-equiv
/** One peer message recorded by the historical Team mailbox. */
interface TeamMessageSnapshot {
  readonly id: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
  readonly targetId: SessionId
  readonly content: ContentBlock[]
}
```

历史 `team-message` source 保留旧消息 id 与发送者归属；客户端用它们展示消息标题和图标。

```ts type-equiv
/** Source recorded by a target Session for one historical Team mailbox delivery. */
interface TeamMessageSource {
  readonly kind: 'team-message'
  readonly teamId: TeamId
  readonly messageId: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
}
```

## 共享任务 DAG

每条 task event 都存储完整快照。`revision` 是 compare-and-set 值，每次变更递增 1。`blockedBy` edge 必须指向未删除任务，并维持无环图。`writeScopes` 是规范化的提示性路径前缀，不是锁。

```ts type-equiv
/** Whole durable task snapshot; every mutation increments {@link revision}. */
interface TeamTaskSnapshot {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly ownerId?: SessionId
  /** Immutable agent path captured at assignment; absent on unnamed historical owners. */
  readonly ownerName?: string
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
}
```

`pending` 表示未开始或已释放，`in_progress` 携带负责人，`completed` 满足依赖，`deleted` 是保留的墓碑记录。视图提供 `ownerId`、就绪性和写入范围重叠提示，不改变持久快照。

<a id="web-projection"></a>

## Web 投影

`agentTeam.enabled` 提供根 Session 保存的选择。新 Session 默认为 false；`team/mode` 记录显式选择。历史任务在显式选择前视为开启。仅根可调用 `setEnabled`；后代共享该模式。Web 菜单通过 `remote.agentTeams.setEnabled` 调用同一方法，Gateway 将根 Session id 解析为其存活 Agent。模式写入先立即生效，再等待刷盘。工具在步骤准备时确定可用性；提示词提供方在求值时读取选择。任务修改在排队操作开始时检查当前模式；已获准的修改可继续完成。模式变更不会结束收件箱等待。刷盘失败时已追加的选择仍然生效；重试相同选择会再次刷盘，不重复追加事件。

根 Session 通过 `SessionProjectionMap.agentTeam` 发布未删除任务视图。`failure` 在最后有效状态旁报告被拒绝的持久化任务或模式记录。历史名册与邮箱记录不参与投影。视图以 Session id 标识每个负责人；任务面板和任务工具显示负责人的 agent 名称，负责人没有名称时显示其 Session id。

```ts type-equiv
/** Runtime-enriched task view returned to tools and hosts. */
interface TeamTaskView {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
  readonly ownerId?: SessionId
  /** Immutable agent path captured at assignment; absent on unnamed historical owners. */
  readonly ownerName?: string
  readonly ready: boolean
  readonly writeScopeWarnings: string[]
}
```

```ts type-equiv
/**
 * Durable Team state published to browser clients through the Lead Session's
 * `agentTeam` projection. `failure` names the first rejected persisted Team
 * record; tasks then stay at the last valid state.
 */
interface TeamProjection {
  readonly enabled: boolean
  readonly tasks: TeamTaskView[]
  readonly failure?: string
}
```

## 回放

`agentTeam` 投影按 `TeamId` 重放任务记录，并重放 Session 自身的模式选择。subagent 发现负责当前树成员关系，不将继承目录作为权限来源。Session 事件的 `seq` 和 `time` 负责排序和时间。已提交的持久化代次保持不变。[包 README](../../packages/team/agent-team/README.zh.md)定义任务操作和限制。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagentteams--teamservice"></a>

### `ctx.agentTeams` — `TeamService`

Agent Teams service backed by the exact live Lead Session log.

```ts cordis-catalog
/**
 * Read the Team selection shared by the caller's subagent tree.
 * @param caller - exact live root or descendant.
 * @returns whether Team tools and guidance are enabled.
 */
isEnabled(caller: Agent): boolean

/**
 * Save a root Session's Team selection without stopping children or deleting tasks.
 * The selection takes effect before awaiting persistence. Tools resolve availability at
 * step preparation; prompt providers read the selection when evaluated. Task mutations
 * check the current mode when their queued operation starts; admitted operations finish.
 * @param agent - exact live root whose tree receives the selection.
 * @param enabled - selected Team mode.
 * @param signal - cancellation checked before changing the selection.
 * @returns fulfillment after the selection flushes.
 * @throws when called by a descendant or persistence fails. An appended selection remains active;
 * retrying the same selection flushes without a duplicate event.
 */
@Remote async setEnabled(agent: Agent, enabled: boolean, signal?: AbortSignal): Promise<void>

/**
 * Create one unowned pending task in the Team Lead log.
 * @param caller - exact live Team member creating the task.
 * @param request - task text, blockers, and advisory write scopes.
 * @param signal - cancellation before the task event is appended; omitted means no cancellation.
 * @returns the revision-one task view.
 * @throws TEAM_TASK_PERSISTENCE_UNCONFIRMED when the task is visible but durability is unknown; read it before retrying.
 */
async createTask(caller: Agent, request: CreateTeamTaskRequest, signal?: AbortSignal): Promise<TeamTaskView>

/**
 * Return one task, including a deleted tombstone.
 * @param caller - exact live Team member reading the task.
 * @param id - Team-local task identity.
 * @returns the latest task value and derived readiness diagnostics.
 */
getTask(caller: Agent, id: TeamTaskId): TeamTaskView

/**
 * List current non-deleted tasks in numeric creation order.
 * @param caller - exact live Team member reading the board.
 * @returns detached current task views.
 */
listTasks(caller: Agent): TeamTaskView[]

/**
 * Compare-and-set one authorized task transition.
 * @param caller - exact live Team member authorizing the mutation.
 * @param request - task identity, expected revision, action, and action fields.
 * @param signal - cancellation before the task event is appended; omitted means no cancellation.
 * @returns the committed next task revision.
 * @throws TEAM_TASK_PERSISTENCE_UNCONFIRMED when the task is visible but durability is unknown; read it before retrying.
 */
async updateTask(caller: Agent, request: UpdateTeamTaskRequest, signal?: AbortSignal): Promise<TeamTaskView>
```

Types: [Agent](core.zh.md)

Source: [`packages/team/agent-team/src/index.ts`](../../packages/team/agent-team/src/index.ts)
<!-- END GENERATED cordis-surface -->
