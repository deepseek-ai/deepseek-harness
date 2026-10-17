# Agent Teams

English | [中文](agent-team.zh.md)

Types shared by the experimental implicit-root Team domain, model tools, and host adapters. The [subagent teammates Agent Note](../../.agents/notes/implemented/architecture/2026-10-15-agent-teams-as-subagents.md) owns the membership, roster, and messaging decisions; this page records the durable and client-visible forms from [`packages/experimental/agent-team/src/types.ts`](../../packages/experimental/agent-team/src/types.ts).

## Identity and roster

`TeamId` brands the root `SessionId`; `TeamTaskId` uses `task-<n>`. `TeamMessageId` remains only for historical mailbox records. Team writes no roster records: the browser combines the Lead and historical members from `agentTeam` with direct continuable children from `subagentCatalog`. Descriptions may repeat; ids address members.

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

Historical records keep their `provisioning`, `active`, or `failed` phase; direct continuable children are `active`. Turn activity (`running` or `inactive`) is derived separately.

## Messages and historical mailbox

Members exchange ordinary [subagent messages](subagent.md): the target stores the `agent-message` source with the real sender Session id. Team has no outbox, mailbox, or resend deduplication. The following mailbox types remain readable so historical Lead logs still replay; Team never delivers their pending records.

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

Historical `team-message` sources retain the old message id and sender attribution; the client uses them for the message title and icon.

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

## Shared task DAG

Every task event stores a complete snapshot. `revision` is the compare-and-set value and increments by one per mutation. `blockedBy` edges must name non-deleted tasks and keep the graph acyclic. `writeScopes` are normalized advisory path prefixes rather than locks.

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

`pending` is unstarted or released, `in_progress` carries an owner, `completed` satisfies blockers, and `deleted` is a retained tombstone. Views expose `ownerId`, readiness, and advisory write-scope overlap without changing the durable snapshot.

<a id="web-projection"></a>

## Web projection

The Lead Session publishes `SessionProjectionMap.agentTeam` with the Lead, historical roster rows, and non-deleted task views. The browser combines these rows with continuable entries from `subagentCatalog`, preferring the catalog for duplicate ids. `failure` reports a rejected persisted Team record beside the last valid state. Member activity comes from Session status; model labels come from each member’s `modelSelection` projection.

```ts type-equiv
/**
 * One roster row published through the `agentTeam` Session projection: the
 * Lead and each historical roster member. Current children come from `subagentCatalog`.
 */
interface TeamMemberProjection {
  readonly id: SessionId
  /** Delegated responsibility; absent for the Lead. Never used as an address. */
  readonly description?: string
  readonly role: 'lead' | 'teammate'
  /** The Lead and continuable children are always `active`. Turn activity comes from Session status. */
  readonly phase: TeamMemberPhase
  readonly error?: string
}
```

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
 * record; members and tasks then stay at the last valid state.
 */
interface TeamProjection {
  readonly members: TeamMemberProjection[]
  readonly tasks: TeamTaskView[]
  readonly failure?: string
}
```

## Replay

The `agentTeam` projection replays historical roster, tasks, and historical mailbox records selected by `TeamId`. The separate `subagentCatalog` projection owns child discovery and skips inherited catalog facts. Descriptions do not participate in identity checks. Session event `seq` and `time` own ordering and timing. Callers receive roster and task views, not pending mail. The [package README](../../packages/experimental/agent-team/README.md) defines operations, authorization, and limits.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagentteams--teamservice"></a>

### `ctx.agentTeams` — `TeamService`

Agent Teams service backed by the exact live Lead Session log.

```ts cordis-catalog
/**
 * Resolve one exact live Agent's Team role.
 * @param agent - exact live Agent used as the authority credential.
 * @returns its Lead, Team identity, and role.
 */
membership(agent: Agent): TeamMembership

/**
 * Resolve a caller without throwing, used by scoped-tool installation and observers.
 * @param agent - candidate exact live Agent.
 * @returns Team membership, or undefined for stale identities and children whose parent left the registry.
 */
tryMembership(agent: Agent): TeamMembership | undefined

/**
 * Whether another live member of the caller's Team is currently running a turn.
 * @param caller - exact live Team member.
 * @returns whether a peer can still produce a Team change.
 */
hasActivePeer(caller: Agent): boolean

/**
 * Create one unowned pending task in the Team Lead log.
 * @param caller - exact live Team member creating the task.
 * @param request - task text, blockers, and advisory write scopes.
 * @returns the revision-one task view.
 */
async createTask(caller: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView>

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
 * @returns the committed next task revision.
 */
async updateTask(caller: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskView>

/**
 * Wait for the next task change, member status change, or message a member's inbox accepts.
 * @param caller - exact live Team member waiting for activity.
 * @param timeoutMs - bounded wait duration from ten seconds through one hour.
 * @param signal - caller cancellation for the wait only.
 * @returns one observed change or a timeout result.
 */
async waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult>
```

Types: [Agent](core.md)

Source: [`packages/experimental/agent-team/src/index.ts`](../../packages/experimental/agent-team/src/index.ts)
<!-- END GENERATED cordis-surface -->
