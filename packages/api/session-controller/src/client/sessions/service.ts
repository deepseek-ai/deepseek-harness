/** Client catalog and source-labelled ownership of exact Session generations. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { SESSION_SEARCH_RESULT_LIMIT } from '../../types.ts'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import {
  createSnapshotStore, notifySubscribers, type ObservableSnapshot, type SnapshotStore,
} from '@deepseek-ai/dsh-client-store'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionEventSource } from '../contract/events.ts'
import type { SessionFace } from '../contract/session.ts'
import type {
  AgentContext, ISessions, SessionReference, SessionRetainInfo, SessionRetainOptions, SessionTarget,
} from '../contract/sessions.ts'
import type { SessionReferenceSource } from '../index.ts'
import { createScope, scopeIdentityOf, scopeOf as scopeTagOf } from '../scope.ts'
import { SessionManager } from './manager.ts'
import type { SessionRemotes } from './remotes.ts'
import type { SessionListPhase, SessionSearchResultItem, SessionProjectionSnapshot } from './manager.ts'
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
  /** Host running state for `ids` members; a display fallback for other rows. */
  running: boolean
  /** Local ownership counts; Host metadata refreshes cannot overwrite them. */
  readonly retainedBy: SessionRetainInfo['retainedBy']
  /**
   * New Session presentation and reuse eligibility, derived from the Host
   * summary, `sessionListMetadata`, and client acceptance/running observations.
   * New Session reuses a blank one targeting the same workspace. Filtering
   * stays with the consumer: the store carries every row, while the Workspace
   * browser shows only the selected blank entry.
   */
  blank: boolean
  updatedAt: number
  /** Current host-computed projection values retained by the object layer. */
  projectionValues?: Readonly<Partial<SessionProjectionMap>>
}

/** Catalog metadata and local source counts; catalog membership owns no Client generation. */
export interface SessionListState {
  /** Host list order; every id has a matching byId row in the same snapshot. */
  ids: SessionId[]
  /** Host/catalog rows plus retained subagent fallbacks; only `ids` expresses Host-list membership. */
  byId: Record<SessionId, SessionSummary>
  /** Arrival lifecycle projected 1:1 from the manager snapshot (see SessionListPhase): empty-with-ready means "truly no sessions". */
  phase: SessionListPhase
  /** Shared projection values and explicit-read state, including unopened Sessions. */
  projectionsBySession: Readonly<Record<SessionId, SessionProjectionSnapshot>>
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

/** Source labels are dictionary keys, including names also present on Object.prototype. */
function freezeRetainedBy(counts: Partial<Record<SessionReferenceSource, number>>): SessionRetainInfo['retainedBy'] {
  Object.setPrototypeOf(counts, null)
  return Object.freeze(counts)
}

const EMPTY_RETAIN_INFO: SessionRetainInfo = Object.freeze({ referenceCount: 0, retainedBy: freezeRetainedBy({}) })

interface ScopeRecord {
  fiber: Fiber
  ctx: AgentContext
  binding: SessionBinding
  session: Session
  retention: SessionRetainInfo
  live: boolean
}

interface RetentionObserver {
  readonly source: ObservableSnapshot<SessionRetainInfo>
  readonly listeners: Set<() => void>
  published: SessionRetainInfo
}

/** A cancelled waiter releases only its own reference, not the shared opening. */
async function waitForOpen(opening: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return opening
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => { aborted.reject(signal.reason) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    if (signal.aborted) onAbort()
    await Promise.race([opening, aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

class ClientSessionReference implements SessionReference {
  private readonly released = new AbortController()
  private readonly readiness = Promise.withResolvers<SessionBinding>()
  readonly ready = this.readiness.promise

  constructor(
    readonly sessionId: SessionId,
    private record: ScopeRecord | undefined,
    private releaseReference: (() => void) | undefined,
  ) {
    void this.ready.catch(() => {})
  }

  get binding(): SessionBinding {
    if (this.record === undefined || !this.record.live) throw new Error(`Session reference "${this.sessionId}" is released`)
    return this.record.binding
  }

  attachOpening(opening: Promise<void>, signal?: AbortSignal): void {
    const waitSignal = signal === undefined
      ? this.released.signal
      : AbortSignal.any([this.released.signal, signal])
    void waitForOpen(opening, waitSignal).then(
      () => {
        try {
          waitSignal.throwIfAborted()
          this.readiness.resolve(this.binding)
        } catch (error: unknown) {
          this.readiness.reject(error)
        }
      },
      (error: unknown) => { this.readiness.reject(error) },
    )
  }

  release(): void {
    const reason = new Error(`Session reference "${this.sessionId}" is released`)
    const release = this.releaseReference
    this.released.abort(reason)
    this.readiness.reject(reason)
    this.record = undefined
    this.releaseReference = undefined
    release?.()
  }

  [Symbol.dispose](): void {
    this.release()
  }
}

/** Host catalog and local reference allocator; view selection remains outside the Controller. */
export class ClientSessions implements ISessions {
  /**
   * The wire schema's own result bound, re-exposed for presentation plugins as
   * injected data. Not per-connection state: the `session.search` response
   * schema caps `items` at this constant, so every transport (fixture included)
   * reports the same number.
   */
  readonly searchResultLimit = SESSION_SEARCH_RESULT_LIMIT
  /** Catalog metadata and local reference-source projection. */
  readonly list: SnapshotStore<SessionListState>
  /** The object-layer instance cluster and frame dispatch entry. */
  private readonly manager: SessionManager
  private readonly scopes = new Map<SessionId, ScopeRecord>()
  /** Stable per-id sources retained for the Client root lifetime, including across generation replacement. */
  private readonly retainObservers = new Map<SessionId, RetentionObserver>()
  private readonly scopeDrops = new Set<Promise<void>>()
  private closed = false

  /**
   * @param ctx - client root context (scope fibers mount under it).
   * @param remote - generated Remote namespaces shared with every Session.
   */
  constructor(
    private readonly rootCtx: Context,
    remote: SessionRemotes,
  ) {
    this.manager = new SessionManager(remote)
    this.list = createSnapshotStore<SessionListState>({
      ids: [], byId: {}, phase: 'pending', projectionsBySession: {},
    })
    const disposeManagerProjection = this.manager.subscribe(() => { this.projectList() })
    rootCtx.effect(() => async () => {
      this.closed = true
      disposeManagerProjection()
      const scopes = [...this.scopes]
      this.scopes.clear()
      for (const [, record] of scopes) {
        record.live = false
        record.session.unbindScope()
      }
      const managerDisposal = this.manager.dispose()
      for (const [id, record] of scopes) {
        this.startScopeDrop(id, record)
        this.publishRetention(id)
      }
      await this.drainScopeDrops()
      await managerDisposal
    }, 'session-controller.client.sessions')
    rootCtx.reflect.provide('sessions', this, undefined)
  }

  retain(target: SessionTarget, options: SessionRetainOptions): SessionReference {
    const { source, signal } = options
    signal?.throwIfAborted()
    if (this.closed) throw new Error('Session Controller is disposed')
    const id = this.manager.resolveTarget(target)
    const reference = this.retainScope(id, source)
    try {
      reference.attachOpening(this.manager.get(id).open(), signal)
      return reference
    } catch (error) {
      reference.release()
      throw error
    }
  }

  async using<T>(
    target: SessionTarget,
    options: SessionRetainOptions,
    operation: (reference: SessionReference) => T | Promise<T>,
  ): Promise<T> {
    const reference = this.retain(target, options)
    try {
      await reference.ready
      return await operation(reference)
    } finally {
      reference.release()
    }
  }

  retainInfo(id: SessionId): ObservableSnapshot<SessionRetainInfo> {
    let observer = this.retainObservers.get(id)
    if (observer === undefined) {
      const listeners = new Set<() => void>()
      observer = {
        listeners,
        published: this.retentionSnapshot(id),
        source: {
          getSnapshot: () => this.retentionSnapshot(id),
          subscribe: (listener) => {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
          },
        },
      }
      this.retainObservers.set(id, observer)
    }
    return observer.source
  }

  /**
   * Resolve an already discovered direct-parent address without opening it.
   * Feature plugins use this to avoid Agent-bound RPCs in persisted child views.
   * @param id - possible addressed child id.
   * @returns A retained or loaded-catalog address, without retaining a new selection or scope.
   */
  subagentAddress(id: SessionId): SubagentAddress | undefined {
    return this.manager.subagentAddress(id)
  }

  /**
   * Load all Session projections once per connection; retry an unsuccessful initial read.
   * @param sessionId - Session to inspect without opening its conversation.
   */
  refreshProjections(sessionId: SessionId): Promise<void> {
    return this.manager.refreshProjections(sessionId)
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
   * Create a Host Session and publish its catalog row before resolving.
   * Callers retain the returned identity before borrowing its binding.
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
   * Fork a session from an exact inclusive prefix of the source (same
   * synchronous-addressability guarantee as {@link ClientSessions.create}:
   * on resolution the child is catalogued and may be explicitly retained).
   * @param opts - source session id, the optional exact inclusive boundary
   *   seq (a real event seq the caller already knows; a cut inside an open
   *   turn is balanced Host-side with synthetic closers, and omission selects
   *   the latest completed-turn prefix), and whether to increment an
   *   inherited durable title before resolving.
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
      ...(opts.atSeq === undefined ? {} : { atSeq: SessionSeq(opts.atSeq) }),
    })
    if (!result.ok) throw new SessionForkError(result.error, opts.sessionId)
    this.projectList()
    const childId = result.value.sessionId
    if (sourceTitle !== undefined) {
      const renamed = await this.manager.rename(childId, increasedForkTitle(sourceTitle))
      if (!renamed.ok) throw new Error(`fork child rename failed: ${renamed.error.code}: ${renamed.error.message}`)
    }
    return childId
  }

  /**
   * Borrow an already-retained Agent-scoped Context.
   * @param id - session id (the agent identity — 1:1 same axis).
   * @returns the scoped Context, or undefined without a retained generation.
   */
  scope(id: SessionId): AgentContext | undefined {
    return this.scopes.get(id)?.ctx
  }

  /**
   * Retain a validated Gateway identity synchronously, without history or catalog I/O.
   * @param id - Host-projected Session identity, possibly not yet catalogued.
   * @returns a Gateway-source reference owned by the invocation.
   */
  retainAgentScope(id: SessionId): SessionReference {
    if (this.closed) throw new Error('Session Controller is disposed')
    return this.retainScope(id, 'gateway')
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
   * @returns the matching live Session, or undefined for an untagged or ended generation.
   */
  sessionOf(ctx: Context): SessionFace | undefined {
    const id = scopeTagOf(ctx)
    if (id === undefined) return undefined
    const record = this.scopes.get(id)
    return record !== undefined && scopeIdentityOf(record.ctx) === scopeIdentityOf(ctx)
      ? record.binding.session
      : undefined
  }

  /**
   * Borrow an already-retained binding without extending its lifetime.
   * @param id - Session identity.
   * @returns the live binding, or undefined without a retained generation.
   */
  binding(id: SessionId): SessionBinding | undefined {
    return this.scopes.get(id)?.binding
  }

  private retainScope(id: SessionId, source: SessionReferenceSource): ClientSessionReference {
    const record = this.scopes.get(id) ?? this.materializeScope(id)
    const previous = record.retention
    record.retention = Object.freeze({
      referenceCount: previous.referenceCount + 1,
      retainedBy: freezeRetainedBy({ ...previous.retainedBy, [source]: (previous.retainedBy[source] ?? 0) + 1 }),
    })
    const reference = new ClientSessionReference(id, record, () => {
      if (!record.live) return
      const count = record.retention.referenceCount - 1
      const { [source]: sourceCount = 0, ...otherSources } = record.retention.retainedBy
      const retainedBy = sourceCount > 1 ? { ...otherSources, [source]: sourceCount - 1 } : otherSources
      record.retention = count === 0
        ? EMPTY_RETAIN_INFO
        : Object.freeze({ referenceCount: count, retainedBy: freezeRetainedBy(retainedBy) })
      if (count === 0) this.retireScope(id, record)
      else this.publishRetention(id)
    })
    if (this.list.getSnapshot().byId[id] === undefined && this.manager.subagentAddress(id) !== undefined) {
      this.projectList()
    }
    this.publishRetention(id)
    return reference
  }

  private retentionSnapshot(id: SessionId): SessionRetainInfo {
    return this.scopes.get(id)?.retention ?? EMPTY_RETAIN_INFO
  }

  private publishRetention(id: SessionId): void {
    const state = this.list.getSnapshot()
    const row = state.byId[id]
    const retainedBy = this.retentionSnapshot(id).retainedBy
    if (row !== undefined && row.retainedBy !== retainedBy) {
      this.list.set({ ...state, byId: { ...state.byId, [id]: { ...row, retainedBy } } })
    }
    const observer = this.retainObservers.get(id)
    const snapshot = this.retentionSnapshot(id)
    if (observer === undefined || observer.published === snapshot) return
    observer.published = snapshot
    notifySubscribers(observer.listeners, '[session-controller] reference sources')
  }

  private retireScope(id: SessionId, record: ScopeRecord, disposeFiber = true): void {
    if (!record.live) return
    record.live = false
    if (this.scopes.get(id) === record) this.scopes.delete(id)
    record.session.unbindScope()
    const sessionDisposal = this.manager.drop(id, record.session)
    this.projectList()
    this.publishRetention(id)
    this.startScopeDrop(id, record, disposeFiber, sessionDisposal)
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
      retention: EMPTY_RETAIN_INFO,
      live: true,
    }
    this.scopes.set(id, record)
    ctx.effect(() => () => { this.retireScope(id, record, false) }, 'session-controller: exact generation')
    return record
  }

  /** Project the manager's list snapshot into the store (title derivation is display-only). */
  private projectList(): void {
    const previousById = this.list.getSnapshot().byId
    const {
      items, phase, projectionsBySession,
    } = this.manager.getListSnapshot()
    const ids: SessionId[] = []
    const byId: Record<SessionId, SessionSummary> = {}
    for (const entry of items) {
      ids.push(entry.sessionId)
      byId[entry.sessionId] = {
        id: entry.sessionId,
        displayTitle: displayTitleOf(entry.title, entry.cwd, entry.sessionId),
        running: entry.running,
        retainedBy: this.retentionSnapshot(entry.sessionId).retainedBy,
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
    for (const [parentId, projection] of Object.entries(projectionsBySession)) {
      for (const child of projection.values.subagentCatalog ?? []) {
        const childId = child.id
        const summary = byId[childId]
        const projectionValues = summary?.projectionValues ?? this.manager.projectionValues(childId)
        const projectedTitle = projectionValues?.title
        const title = typeof projectedTitle === 'string' && projectedTitle !== '' ? projectedTitle : undefined
        const displayTitle = title ?? child.label ?? childId
        if (summary === undefined) {
          byId[childId] = {
            id: childId, displayTitle, parentId: parentId as SessionId,
            origin: 'subagent', running: this.scopes.get(childId)?.session.getSnapshot().running ?? false, blank: false, updatedAt: 0,
            retainedBy: this.retentionSnapshot(childId).retainedBy,
            ...(projectionValues === undefined ? {} : { projectionValues }),
            ...(title === undefined ? {} : { title }),
          }
        } else if (summary.displayTitle !== displayTitle || summary.projectionValues !== projectionValues) {
          byId[childId] = {
            ...summary,
            displayTitle,
            ...(projectionValues === undefined ? {} : { projectionValues }),
          }
        }
      }
    }
    for (const [id, record] of this.scopes) {
      if (byId[id] !== undefined) continue
      const address = this.manager.subagentAddress(id)
      if (address === undefined) continue
      const previous = previousById[id]
      const snapshot = record.session.getSnapshot()
      const projectionValues = this.manager.projectionValues(id)
      const projectedTitle = projectionValues?.title
      const title = typeof projectedTitle === 'string' && projectedTitle !== '' ? projectedTitle : previous?.title
      byId[id] = {
        ...(previous ?? { id, displayTitle: id, updatedAt: 0 }),
        running: snapshot.running,
        retainedBy: record.retention.retainedBy,
        blank: snapshot.blank,
        parentId: address.parentSessionId,
        origin: 'subagent',
        ...(projectionValues === undefined ? {} : { projectionValues }),
        ...(title === undefined ? {} : { title, displayTitle: title }),
      }
    }
    this.list.set({ ids, byId, phase, projectionsBySession })
  }

  private startScopeDrop(
    id: SessionId,
    record: ScopeRecord,
    disposeFiber = true,
    sessionDisposal = this.manager.drop(id, record.session),
  ): void {
    const drop = this.dropScope(record, disposeFiber, sessionDisposal)
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

  /** Await the already-withdrawn Session and scoped cleanup to quiescence. */
  private async dropScope(
    record: ScopeRecord,
    disposeFiber: boolean,
    sessionDisposal: Promise<void>,
  ): Promise<void> {
    await Promise.allSettled([sessionDisposal, ...disposeFiber ? [record.fiber.dispose()] : []])
  }
}
