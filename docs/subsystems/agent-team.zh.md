# Agent Teams

[English](agent-team.md) | 中文

实验性任务板、模型工具和 host 适配器共享的类型。[任务板等待决策](../../.agents/notes/implemented/architecture/2026-10-19-team-task-board-inbox.zh.md)负责协调语义；本页记录 [`packages/experimental/agent-team/src/types.ts`](../../packages/experimental/agent-team/src/types.ts) 中的持久化和客户端可见形式。

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

成员交换普通 [subagent 消息](subagent.zh.md)，保留真实发送方 Session id。任务提交刷盘后，向同树所有驻留 Agent（包括调用者和根）的当前等待发出信号。这些内存信号不持久化未读状态，不恢复冷成员，也不启动空闲轮次。不在等待期间发生的变更不能唤醒后续等待。下列历史邮箱类型保持可读；Team 绝不投递其待处理记录。

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
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
}
```

`pending` 表示未开始或已释放，`in_progress` 携带负责人，`completed` 满足依赖，`deleted` 是保留的墓碑记录。视图提供 `ownerId`、就绪性和写入范围重叠提示，不改变持久快照。

<a id="web-projection"></a>

## Web 投影

根 Session 通过 `SessionProjectionMap.agentTeam` 发布未删除任务视图。`failure` 在最后有效状态旁报告被拒绝的持久化 Team 记录。历史成员字段保留在持久化投影状态中，但不发送到浏览器。任务面板将根标记为主代理，其他负责人依次使用目录标签、Session 标题或 id。

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
  readonly tasks: TeamTaskView[]
  readonly failure?: string
}
```

## 回放

`agentTeam` 投影按 `TeamId` 重放历史名册、任务和邮箱记录。subagent 发现负责当前树成员关系，不将继承目录作为权限来源。Session 事件的 `seq` 和 `time` 负责排序和时间。已提交的持久化代次保持不变。[包 README](../../packages/experimental/agent-team/README.zh.md)定义任务操作、等待信号和限制。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagentteams--teamservice"></a>

### `ctx.agentTeams` — `TeamService`

Agent Teams service backed by the exact live Lead Session log.

```ts cordis-catalog
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

Source: [`packages/experimental/agent-team/src/index.ts`](../../packages/experimental/agent-team/src/index.ts)
<!-- END GENERATED cordis-surface -->
