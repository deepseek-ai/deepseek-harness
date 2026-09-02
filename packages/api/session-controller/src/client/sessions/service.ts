/**
 * ClientSessions: root sessions service — list snapshot store (manager
 * projection; carries `current`, the persisted selection every
 * session-scoped surface keys off), Agent scope tree (mintScope pattern: no-op plugin
 * Fiber + ctx.extend scope tag; one scope per session, agent id === session
 * id), stable SessionBinding cache, breadcrumb-route projection.
 *
 * Scope lifecycle is stage-driven: a scope is minted lazily on first
 * resolution (pure — resolution has no side effects and is render-safe);
 * the event window and deferred teardown key off the STAGED session, which
 * follows `list.current` exactly. Staging is the open signal: the window
 * opens ⟺ the session is on stage (the stage is `current`; the staged
 * state can widen to a multi-pane list later). A session leaving the list
 * tears its scope down immediately unless it is the staged one, whose scope
 * survives frozen (read-only view) until the stage moves on.
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { SESSION_SEARCH_RESULT_LIMIT } from '../../types.ts'
import type { SessionJob as JobView } from '../../types.ts'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import {
  createSnapshotStore, type SnapshotStore,
} from '@deepseek-ai/dsh-client-store'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionEventSource } from '../contract/events.ts'
import type { SessionFace } from '../contract/session.ts'
import type { AgentContext, ISessions } from '../contract/sessions.ts'
import { createScope, scopeOf as scopeTagOf } from '../scope.ts'
import { SessionManager } from './manager.ts'
import type { SessionRemotes } from './remotes.ts'
import type { SessionListPhase, SessionSearchResultItem, SubagentCatalogSnapshot } from './manager.ts'
import type { Session } from './session.ts'

/** Session list row projected from the host list RPC plus live stream increments. */
export interface SessionSummary {
  id: SessionId
  /** Latest durable log-backed title, absent until the host projects one. */
  title?: string
  /** Human-facing label: durable title, project basename, then session id. */
  displayTitle: string
  cwd?: string
  parentId?: SessionId
  /** Coarse durable origin for navigation filtering; not a continuation capability. */
  origin?: 'subagent'
  running: boolean
  /** Finished while not selected and not yet opened — the sidebar's green "done" reminder. Absent = false. */
  completed?: boolean
  /**
   * Empty-log bit (host summary derivation mirror). New Session reuses a blank
   * one targeting the same workspace. Filtering stays with the consumer: the
   * store carries every row, while the Workspace browser shows only the
   * selected blank entry.
   */
  blank: boolean
  updatedAt: number
  /** Current host-computed projection values retained by the object layer. */
  projectionValues?: Readonly<Partial<SessionProjectionMap>>
}

/**
 * Session list store shape. `current` rides the same snapshot (arbitrated:
 * the single useSessions standard hook reads list and selection together —
 * sidebar highlighting and current-session consumers share one fact source).
 */
export interface SessionListState {
  /** Host-list order; addressed breadcrumb-only rows are excluded. */
  ids: SessionId[]
  /** Host rows plus the current addressed subagent route used by navigation. */
  byId: Record<SessionId, SessionSummary>
  current: SessionId | undefined
  /** Arrival lifecycle projected 1:1 from the manager snapshot (see SessionListPhase): empty-with-ready means "truly no sessions". */
  phase: SessionListPhase
  /** Direct durable catalogs keyed by their selected parent address. */
  subagentsByParent: Readonly<Record<SessionId, SubagentCatalogSnapshot>>
  /**
   * Background jobs each session can see, mirrored last-wins from Session
   * Controller's control baseline and `jobs` frames. A missing key is an empty
   * set, so consumers read absence rather than a sentinel.
   */
  jobsBySession: Readonly<Record<SessionId, readonly JobView[]>>
  /** Current session's catalog-derived address, absent on ordinary navigation. */
  currentAddress: SubagentAddress | undefined
}

/** Persisted navigation cell: address survives refresh for correct history routing. */
interface SessionSelection {
  sessionId?: SessionId
  subagentAddress?: SubagentAddress
}

/** Structured session-create failure. */
export class SessionCreateError extends Error {
  override readonly name = 'SessionCreateError'

  /**
   * @param rpcError - Host business or folded transport error.
   * @param requestedSessionId - caller-preallocated id used for later stream/list reconciliation.
   */
  constructor(
    readonly rpcError: RemoteFailure,
    readonly requestedSessionId: SessionId | undefined,
  ) {
    super(`session create failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/** Structured session-fork failure. */
export class SessionForkError extends Error {
  override readonly name = 'SessionForkError'

  /**
   * @param rpcError - Host business or folded transport error.
   * @param sourceSessionId - the session the fork was cut from.
   */
  constructor(
    readonly rpcError: RemoteFailure,
    readonly sourceSessionId: SessionId,
  ) {
    super(`session fork failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/** Identity-stable logical binding for one materialized Client Session. */
export interface SessionBinding {
  readonly sessionId: SessionId
  /** The outward session face only — feature code never sees the concrete class. */
  readonly session: SessionFace
  /** Contiguous event window reserved for Conversation assembly. */
  readonly eventSource: SessionEventSource
  readonly ctx: AgentContext
}

// Scope primitives live in ../scope.ts (the client mirror of host
// dsh-scope, keyed by Agent identity); re-exported here so existing
// consumers keep their import site.
export { scopeOf } from '../scope.ts'

/**
 * Display title projection: durable title, project directory basename, then
 * the raw id.
 */
function displayTitleOf(title: string | undefined, cwd: string | undefined, id: SessionId): string {
  if (title !== undefined) return title
  if (cwd !== undefined && cwd !== '') {
    const base = workspaceTitleOf(cwd)
    if (base !== '') return base
  }
  return id
}

/**
 * Increment a trailing fork number while preserving its half-width or
 * full-width parentheses; an unnumbered title starts with ` (1)`.
 * @param title - source session's durable title.
 * @returns the title assigned to the fork child.
 */
function increasedForkTitle(title: string): string {
  const ascii = /^(.*?)\((\d+)\)$/u.exec(title)
  if (ascii?.[1] !== undefined && ascii[2] !== undefined) {
    return `${ascii[1]}(${BigInt(ascii[2]) + 1n})`
  }
  const fullWidth = /^(.*?)（(\d+)）$/u.exec(title)
  if (fullWidth?.[1] !== undefined && fullWidth[2] !== undefined) {
    return `${fullWidth[1]}（${BigInt(fullWidth[2]) + 1n}）`
  }
  return `${title} (1)`
}

interface ScopeRecord {
  fiber: Fiber
  ctx: AgentContext
  binding: SessionBinding
  /** The concrete Session for runtime-internal entry points (staging open()); the binding carries only the outward face. */
  session: Session
}

/** Root sessions service: list store, current selection, object-layer manager, scope tree, bindings, and breadcrumb routes. */
export class ClientSessions implements ISessions {
  /**
   * The wire schema's own result bound, re-exposed for presentation plugins as
   * injected data. Not per-connection state: the `session.search` response
   * schema caps `items` at this constant, so every transport (fixture included)
   * reports the same number.
   */
  readonly searchResultLimit = SESSION_SEARCH_RESULT_LIMIT
  /** List snapshot store (list RPC + host stream increments; re-pulled on reconnect) — the useSessions standard feed, current included. */
  readonly list: SnapshotStore<SessionListState>
  /** The object-layer instance cluster and frame dispatch entry. */
  private readonly manager: SessionManager
  /**
   * Persisted selection cell (the durable half of `list.current`). Private on
   * purpose: reads go through the list snapshot; writes through {@link
   * ClientSessions.open} / {@link ClientSessions.clear}. Projection
   * validates it against the live list instead of destructively pruning, so a
   * selection survives transient list states (reconnect re-pull) and
   * resurfaces when its session returns.
   */
  private readonly selection: SnapshotStore<SessionSelection>

  private readonly scopes = new Map<SessionId, ScopeRecord>()
  /** In-flight scope drops remain here after records leave `scopes`, so root disposal can await quiescence. */
  private readonly scopeDrops = new Set<Promise<void>>()
  /**
   * The staged session id — follows `list.current` exactly, holding its last
   * defined value across masked gaps (a transiently absent selection blanks
   * `current` without moving the stage, so reconnect re-pulls and removals
   * keep the staged scope's frozen view alive until the stage moves on).
   */
  private watched: SessionId | undefined
  /** Removed-while-staged sessions whose teardown waits for the stage to move away. */
  private readonly deferredRemovals = new Set<SessionId>()

  /**
   * @param ctx - client root context (scope fibers mount under it).
   * @param remote - generated Remote namespaces shared with every Session.
   */
  constructor(
    private readonly rootCtx: Context,
    remote: SessionRemotes,
  ) {
    this.selection = createSnapshotStore<SessionSelection>(
      {},
      { persist: { name: 'dsh.sessions.current' } })
    const restored = this.selection.getSnapshot()
    this.manager = new SessionManager(
      remote,
      restored.sessionId,
      restored.subagentAddress,
    )
    this.list = createSnapshotStore<SessionListState>({
      ids: [], byId: {}, current: undefined, phase: 'pending',
      subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    })
    // The manager owns wire truth; the store is its projection. Manager
    // notifications are already microtask-batched.
    const disposeManagerProjection = this.manager.subscribe(() => {
      this.projectList()
    })
    // Stage follower: every current write (open() and projection alike)
    // re-evaluates staging, so startup restore (persisted selection validated
    // by the projection) and reconnect resurfacing open their window with no
    // dedicated code path. Safe to run synchronously inside the store notify:
    // the follower writes no list state — session.open()'s synchronous prefix
    // touches only session-side state and its own microtask-batched notifier.
    const disposeStageFollower = this.list.subscribe(() => {
      this.followCurrent()
    })
    rootCtx.effect(() => async () => {
      disposeStageFollower()
      disposeManagerProjection()
      const scopes = [...this.scopes]
      this.scopes.clear()
      this.deferredRemovals.clear()
      this.watched = undefined
      for (const [id, record] of scopes) this.startScopeDrop(id, record)
      await this.drainScopeDrops()
      await this.manager.dispose()
    }, 'session-controller.client.sessions')
    rootCtx.reflect.provide('sessions', this, undefined)
  }

  /**
   * Select a listed or retained catalog-addressed session as current.
   * @param id - listed or addressed session id.
   */
  open(id: SessionId): void {
    this.manager.select(id)
  }

  /**
   * Open a healthy catalog child through its direct-parent address.
   * @param address - catalog-derived parent and child ids.
   */
  openSubagent(address: SubagentAddress): void {
    this.manager.selectSubagent(address)
  }

  /**
   * Resolve an already discovered direct-parent address without opening it.
   * Feature plugins use this to avoid Agent-bound RPCs in persisted child views.
   * @param id - possible addressed child id.
   * @returns The retained address, when present.
   */
  subagentAddress(id: SessionId): SubagentAddress | undefined {
    return this.manager.subagentAddress(id)
  }

  /**
   * Inform the Session Controller whether a catalog menu is consuming membership updates.
   * @param parentSessionId - selected parent.
   * @param open - menu state.
   */
  setSubagentCatalogOpen(parentSessionId: SessionId, open: boolean): void {
    this.manager.setSubagentCatalogOpen(parentSessionId, open)
  }

  /**
   * Refresh one direct-child catalog.
   * @param parentSessionId - catalog owner.
   */
  refreshSubagents(parentSessionId: SessionId): Promise<void> {
    return this.manager.refreshSubagents(parentSessionId)
  }

  /**
   * Clear the current selection so the layout shows the no-session empty
   * state (new-session affordance and the workspace preselection flow).
   * Wipes the persisted selection too — a reload stays on empty until the
   * user opens or starts a session. The staged scope keeps its frozen view
   * per the masked-gap contract until the next open() moves the stage.
   */
  clear(): void {
    this.manager.clearSelection()
  }

  /**
   * Refresh the real Session baseline, reusing an in-flight pull.
   * @returns completion of the current or newly started baseline pull.
   */
  refresh(): Promise<void> {
    return this.manager.refreshList()
  }

  /**
   * Search the Host's visible message-content index. Results stay
   * request-local; the list snapshot remains the metadata authority.
   * @param query - non-blank literal phrase.
   * @param signal - cancellation for a superseded search.
   * @returns bounded results or a business/transport error.
   */
  search(
    query: string,
    signal: AbortSignal,
  ): Promise<RemoteResult<{ items: SessionSearchResultItem[]; hasMore: boolean }>> {
    return this.manager.search(query, signal)
  }

  /**
   * Apply one Session Controller live-control frame.
   * @param frame - baseline or live control replacement.
   */
  handleControlFrame(frame: Parameters<SessionManager['handleControlFrame']>[0]): void {
    this.manager.handleControlFrame(frame)
  }

  /**
   * Apply one remotely forwarded Session-list addition.
   * @param summary - current Host summary for the added Session.
   */
  handleSessionAdded(summary: Parameters<SessionManager['handleSessionAdded']>[0]): void {
    this.manager.handleSessionAdded(summary)
  }

  /**
   * Apply one remotely forwarded Session removal.
   * @param sessionId - removed Session identity.
   */
  handleSessionRemoved(sessionId: Parameters<SessionManager['handleSessionRemoved']>[0]): void {
    this.manager.handleSessionRemoved(sessionId)
  }

  /**
   * Apply one remotely forwarded running-state change.
   * @param args - Session identity and current Agent running state.
   */
  handleSessionStatus(...args: Parameters<SessionManager['handleSessionStatus']>): void {
    this.manager.handleSessionStatus(...args)
  }

  /**
   * Apply one remotely forwarded list-activity change.
   * @param args - Session identity and durable activity timestamp.
   */
  handleSessionActivity(...args: Parameters<SessionManager['handleSessionActivity']>): void {
    this.manager.handleSessionActivity(...args)
  }

  /**
   * Apply one remotely forwarded Agent failure.
   * @param args - Session identity and caller-visible failure description.
   */
  handleSessionError(...args: Parameters<SessionManager['handleSessionError']>): void {
    this.manager.handleSessionError(...args)
  }

  /** Rebuild the Session baseline and every opened window after connection. */
  handleConnected(): void {
    this.manager.handleConnected()
  }

  /**
   * Create a session on the host. Resolution guarantee: by the time the
   * promise resolves, the created session is in the list store and
   * {@link ClientSessions.binding} resolves it — callers (New Session
   * draft hand-off) may address the scope synchronously, without waiting a
   * notifier flush. The synchronous projection below makes this structural
   * rather than an accident of microtask ordering.
   * @param opts - target workspace or directory and an optional preallocated id.
   * @returns the new session id.
   * @throws {SessionCreateError} with the requested id.
   */
  async create(opts: { workspaceId?: WorkspaceId; cwd?: string; sessionId?: SessionId } = {}): Promise<SessionId> {
    const result = await this.manager.create(opts)
    if (!result.ok) throw new SessionCreateError(result.error, opts.sessionId)
    this.projectList()
    return result.value.sessionId
  }

  /**
   * Fork a session from a completed-turn prefix of the source (same
   * synchronous-addressability guarantee as {@link ClientSessions.create}:
   * on resolution the child is in the list store and open() can target it).
   * @param opts - source session id, the optional event seq anchoring the
   *   cut (the boundary is the first turn/end at or after it; an in-log
   *   anchor in an open turn is unavailable rather than clipped backward),
   *   and whether to increment an inherited durable title before resolving.
   *   A fractional anchor floors to a real event seq: the frozen nodes of an
   *   interrupted turn carry flow-ordering seqs between two events, and the
   *   wire takes integers only.
   * @returns the child session id.
   * @throws {SessionForkError} with the source id.
   * @throws {Error} when a requested child-title rename fails after creation.
   */
  async fork(opts: {
    sessionId: SessionId
    atSeq?: number
    increaseTitle?: boolean
  }): Promise<SessionId> {
    const sourceTitle = opts.increaseTitle
      ? this.list.getSnapshot().byId[opts.sessionId]?.title
      : undefined
    const result = await this.manager.fork({
      sessionId: opts.sessionId,
      // Flooring lands inside the anchor's own turn (every turn opens with a
      // turn/start), so the host's first-turn/end-at-or-after cut still ends
      // on that turn — never clipped back to the previous one.
      ...(opts.atSeq === undefined ? {} : { atSeq: SessionSeq(Math.floor(opts.atSeq)) }),
    })
    if (!result.ok) throw new SessionForkError(result.error, opts.sessionId)
    this.projectList()
    const childId = result.value.sessionId
    if (sourceTitle !== undefined) {
      const child = this.binding(childId)?.session
      if (child === undefined) throw new Error(`fork child "${childId}" is not locally addressable`)
      const renamed = await child.rename(increasedForkTitle(sourceTitle))
      if (!renamed.ok) throw new Error(`fork child rename failed: ${renamed.error.code}: ${renamed.error.message}`)
    }
    return childId
  }

  /**
   * Resolve an Agent-scoped context view (use-and-discard).
   * @param id - session id (the agent identity — 1:1 same axis).
   * @returns scoped ctx, or undefined for a session neither listed nor already scoped.
   */
  scope(id: SessionId): AgentContext | undefined {
    return this.resolve(id)?.ctx
  }

  /**
   * Materialize the Agent scope named by a validated Host Remote Event.
   * The first successful Session-list baseline becomes authoritative for its
   * lifetime; until then, transport streams may address the scope in either
   * arrival order.
   * @param id - Host-projected Agent identity (the matching Session id).
   * @returns the identity-stable Agent Context.
   */
  resolveAgentScope(id: SessionId): AgentContext {
    return (this.scopes.get(id) ?? this.materializeScope(id)).ctx
  }

  /**
   * Read the Agent scope tag off a context. Service-method boundary: fetch
   * bundles must reach scope resolution through ctx.sessions — a cross-bundle
   * value import of the standalone helper would inline a second module
   * instance whose private tag Symbol never matches.
   * @param ctx - any client context.
   * @returns the session id, or undefined on root contexts.
   */
  scopeOf(ctx: Context): SessionId | undefined {
    return scopeTagOf(ctx)
  }

  /**
   * Resolve the business Session behind an Agent-scoped context — the one
   * hop every scoped consumer (event listeners, per-session controllers)
   * takes from ctx-space into object-space (the client mirror of host
   * `agent.session`). Same service-method boundary as
   * {@link ClientSessions.scopeOf}.
   * @param ctx - an Agent-scoped context.
   * @returns the session face, or undefined when the ctx is untagged or its scope was pruned.
   */
  sessionOf(ctx: Context): SessionFace | undefined {
    const id = scopeTagOf(ctx)
    if (id === undefined) return undefined
    return this.scopes.get(id)?.binding.session
  }

  /**
   * Resolve the stable session binding (scope-addressed assembly feed). Pure
   * resolution — no staging, no window side effects.
   * @param id - session id.
   * @returns binding, or undefined for a session neither listed nor already scoped.
   */
  binding(id: SessionId): SessionBinding | undefined {
    return this.resolve(id)?.binding
  }

  /**
   * Move the stage to the list's current session: sweep teardowns deferred
   * behind the previous occupant and pull the new occupant's history window.
   * Staging IS the open signal — the window opens ⟺ the session is on stage
   * — and open() is idempotent (an in-flight or completed open no-ops; a
   * failed one retries the next time current is touched).
   */
  private followCurrent(): void {
    const snapshot = this.list.getSnapshot()
    const current = snapshot.current
    // A masked gap (current blanked while the selection's session is
    // transiently absent) holds the stage: tearing down on the gap would
    // destroy exactly the frozen scope the mask exists to preserve.
    if (current === undefined || snapshot.byId[current] === undefined || current === this.watched) return
    this.watched = current
    this.sweepDeferred()
    const record = this.resolve(current)
    /* v8 ignore next 3 -- defensive: current is always a listed id (open()
     * validates and the projection masks absent selections), so resolve
     * cannot miss; kept so a future current writer cannot crash the notify. */
    if (record !== undefined) {
      void record.session.open()
      void this.manager.refreshSubagents(current)
    }
  }

  /**
   * Lazily mint the scope + binding for an eligible session. Eligibility and
   * prune share one predicate: listed on the host or selected
   * through a retained subagent address. Breadcrumb-only ancestors remain
   * summary data and do not keep scopes alive.
   */
  private resolve(id: SessionId): ScopeRecord | undefined {
    const existing = this.scopes.get(id)
    if (existing !== undefined) return existing
    if (!this.eligible(id)) return undefined
    return this.materializeScope(id)
  }

  /** Materialize one scope after its caller establishes that the id may be addressed. */
  private materializeScope(id: SessionId): ScopeRecord {
    const { fiber, ctx } = createScope(this.rootCtx, id)
    const session = this.manager.get(id)
    // The Session owns its scoped dispatch point (host Agent.loopCtx mirror);
    // mint and bind are one step so a live scope record implies a bound actx.
    session.bindScope(ctx)
    const binding: SessionBinding = { sessionId: id, session, eventSource: session.eventSource, ctx }
    const record: ScopeRecord = {
      fiber,
      ctx,
      binding,
      session,
    }
    this.scopes.set(id, record)
    return record
  }

  /** The one aliveness predicate shared by scope mint and prune: host-listed or currently addressed. */
  private eligible(id: SessionId): boolean {
    const { ids, current } = this.list.getSnapshot()
    return current === id || ids.includes(id)
  }

  /** Project the manager's list snapshot into the store (title derivation is display-only). */
  private projectList(): void {
    const {
      items, current, phase, subagentsByParent, jobsBySession, currentAddress,
    } = this.manager.getListSnapshot()
    const ids: SessionId[] = []
    const byId: Record<SessionId, SessionSummary> = {}
    for (const entry of items) {
      ids.push(entry.sessionId)
      byId[entry.sessionId] = {
        id: entry.sessionId,
        displayTitle: displayTitleOf(entry.title, entry.cwd, entry.sessionId),
        running: entry.running,
        ...(entry.completed ? { completed: true } : {}),
        blank: entry.blank,
        updatedAt: entry.updatedAt,
        ...(entry.projectionValues === undefined
          ? {}
          : { projectionValues: entry.projectionValues }),
        ...(entry.title !== undefined ? { title: entry.title } : {}),
        ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
        ...(entry.parentSessionId !== undefined ? { parentId: entry.parentSessionId } : {}),
        ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
      }
    }
    if (current !== undefined && currentAddress !== undefined) {
      const seen = new Set<SessionId>()
      let address: SubagentAddress | undefined = currentAddress
      while (address !== undefined && !seen.has(address.childSessionId)) {
        const childId = address.childSessionId
        seen.add(childId)
        const child = subagentsByParent[address.parentSessionId]?.entries
          .find(entry => entry.kind === 'child' && entry.id === childId)
        if (child?.kind !== 'child') break
        const displayTitle = child.label ?? childId
        const summary = byId[childId]
        if (summary === undefined) {
          byId[childId] = {
            id: childId,
            displayTitle,
            parentId: address.parentSessionId,
            origin: 'subagent',
            running: child.activity === 'running',
            blank: false,
            updatedAt: 0,
          }
        } else if (summary.displayTitle !== displayTitle) {
          byId[childId] = { ...summary, displayTitle }
        }
        const parent = byId[address.parentSessionId]
        if (parent !== undefined && parent.origin !== 'subagent') break
        address = this.manager.navigationAddress(address.parentSessionId)
      }
    }
    const persisted = this.selection.getSnapshot().sessionId
    // No current (cleared, or masked gap) wipes the persisted cell — a reload
    // stays on empty; the in-memory selection still resurfaces a masked id.
    if (current === undefined) {
      if (persisted !== undefined) this.selection.set({})
    } else if (byId[current] !== undefined
      && (persisted !== current
        || this.selection.getSnapshot().subagentAddress?.childSessionId !== currentAddress?.childSessionId
        || this.selection.getSnapshot().subagentAddress?.parentSessionId !== currentAddress?.parentSessionId
        || this.selection.getSnapshot().subagentAddress?.mode !== currentAddress?.mode)) {
      this.selection.set({
        sessionId: current,
        ...(currentAddress === undefined ? {} : { subagentAddress: currentAddress }),
      })
    }
    this.list.set({ ids, byId, current, phase, subagentsByParent, jobsBySession, currentAddress })
    this.pruneScopes()
  }

  /** Tear down scope + instance for no-longer-eligible sessions off stage; the staged one defers until the stage moves. */
  private pruneScopes(): void {
    if (this.list.getSnapshot().phase === 'pending') return
    for (const [id, record] of this.scopes) {
      if (this.eligible(id)) continue
      if (id === this.watched) {
        this.deferredRemovals.add(id)
        continue
      }
      this.scopes.delete(id)
      this.deferredRemovals.delete(id)
      this.startScopeDrop(id, record)
    }
  }

  private startScopeDrop(id: SessionId, record: ScopeRecord): void {
    const drop = this.dropScope(id, record)
    this.scopeDrops.add(drop)
    void drop.then(
      () => { this.scopeDrops.delete(drop) },
      () => { this.scopeDrops.delete(drop) },
    )
  }

  private async drainScopeDrops(): Promise<void> {
    while (this.scopeDrops.size > 0) {
      await Promise.allSettled([...this.scopeDrops])
    }
  }

  /**
   * One teardown for the whole per-session axis: the scope
   * fiber (cascading every actx-registered effect: input shell, slash
   * controller, popup, plugin stores, listeners), the session-keyed slot
   * registrations and the Session instance itself — the host session log is the
   * durable truth, a reopen lazily rebuilds and backfills via open().
   */
  private async dropScope(id: SessionId, record: ScopeRecord): Promise<void> {
    // Release the Session's dispatch point with the scope it belongs to (a
    // surviving instance — the live Intent — rebinds when resolve re-mints).
    record.session.unbindScope()
    await Promise.allSettled([
      record.fiber.dispose(),
      this.manager.drop(id),
    ])
  }

  /** Run deferred teardowns whose session is no longer staged (called when the stage moves). */
  private sweepDeferred(): void {
    for (const id of [...this.deferredRemovals]) {
      /* v8 ignore next -- defensive: only the staged id ever defers, and every
       * stage move sweeps first, so the set cannot contain the id the stage just
       * moved to; kept as a guard against future extra sweep call sites. */
      if (id === this.watched) continue
      // Eligible again? (A re-added id cancels the deferred teardown.)
      if (this.eligible(id)) {
        this.deferredRemovals.delete(id)
        continue
      }
      const record = this.scopes.get(id)
      this.deferredRemovals.delete(id)
      /* v8 ignore next -- defensive: prune deletes a scope and its deferral
       * together, so a deferred id always still owns its record; kept so a
       * future teardown path cannot double-dispose. */
      if (record !== undefined) {
        this.scopes.delete(id)
        this.startScopeDrop(id, record)
      }
    }
  }
}
