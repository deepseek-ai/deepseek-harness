// SessionManager: the instance cluster Map<SessionId, Session> (lazy-built, resident) + the frame
// dispatch entry + list state, constructed and held by ClientSessions (one per browser client).
// List data never enters zustand; React connects via subscribe/getListSnapshot.

import type { SubagentAddress, SubagentCatalog } from '@deepseek-ai/dsh-subagent/client'
import { SessionSeq, type SessionId, type SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {
  SessionControlBaseline,
  SessionControlFrame,
  SessionQueuedItem,
  SessionSummary,
  SessionJob as JobView,
} from '../../types.ts'
import { mergeOrderedBaseline } from '../ordered-baseline.ts'
import { isRemoteFailure } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionListEntry, TitledSessionSummary } from './lineage.ts'
import { flattenLineage } from './lineage.ts'
// Type-only merge edge: the title domain's client-namespace outlet declares
// the 'title' projection key this manager projects into list rows (and any
// useProjection('title') consumer reads). Zero value imports by construction.
import type {} from '@deepseek-ai/dsh-session-title/client'
import { Notifier } from './notifier.ts'
import { ProjectionValueStore } from './projection-store.ts'
import { Session } from './session.ts'
import type { SessionRemotes } from './remotes.ts'

function sessionSeqCursor(value: number): SessionSeqCursor {
  return value === -1 ? -1 : SessionSeq(value)
}

/**
 * List arrival lifecycle, orthogonal to the pull-activity `state` axis:
 * `pending` (no successful pull yet — an empty items array means "nothing
 * arrived", not "nothing exists") → `ready` (at least one pull landed).
 * Monotone: `ready` never steps back — later pull failures and reconnect
 * re-pulls ride the `state`/`error` axis, which is where failure is modeled
 * (no `error` phase here; that would duplicate `state`).
 */
export type SessionListPhase = 'pending' | 'ready'

/** Request-local content hit returned to sidebar search consumers. */
export interface SessionSearchResultItem {
  sessionId: SessionId
  snippet: string
}

/** Immutable session-list snapshot for useSessionList. */
export interface SessionListSnapshot {
  items: readonly SessionListEntry[]
  /** Selected Session id (validated against items; masked to undefined while its session is off the list). */
  current: SessionId | undefined
  state: 'idle' | 'loading' | 'error'
  /** Arrival lifecycle (see {@link SessionListPhase}); `state` stays the pull-activity axis. */
  phase: SessionListPhase
  error: RemoteFailure | null
  subagentsByParent: Readonly<Record<SessionId, SubagentCatalogSnapshot>>
  /** Background jobs per session; an absent key is an empty set. */
  jobsBySession: Readonly<Record<SessionId, readonly JobView[]>>
  currentAddress: SubagentAddress | undefined
}

/** One parent-addressed durable catalog projected through the sessions snapshot. */
export type SubagentCatalogSnapshot = Omit<SubagentCatalog, 'parentAvailable'> & {
  /** Absent until the first successful catalog read. */
  readonly parentAvailable?: boolean
  state: 'loading' | 'ready' | 'error'
  error: RemoteFailure | null
}

function catalogAvailability(parentAvailable: boolean | undefined): {
  readonly parentAvailable?: boolean
} {
  return parentAvailable === undefined ? {} : { parentAvailable }
}

interface CatalogInflight {
  readonly promise: Promise<void>
  readonly expandableRows: Set<SessionId>
  readonly activityRows: Map<SessionId, 'running' | 'inactive'>
  /** Removal-time invalidation replayed over the response this request predates. */
  parentAvailableOverride: false | undefined
}

type SessionListMutation =
  | { kind: 'upsert'; summary: SessionSummary }
  | { kind: 'remove'; sessionId: SessionId }
  | { kind: 'status'; sessionId: SessionId; running: boolean }
  | { kind: 'activity'; sessionId: SessionId; updatedAt: number }
  /** Local first-send flip: the sender clears blank without waiting for a host frame. */
  | { kind: 'engaged'; sessionId: SessionId }

/** Instance cluster + frame entry + the session list. */
export class SessionManager {
  private readonly sessions = new Map<SessionId, Session>()
  /** In-flight Session disposals remain here after instances leave `sessions`, so manager disposal can await quiescence. */
  private readonly sessionDisposals = new Set<Promise<void>>()
  /** Latest transient queues, retained independently of Session object materialization. */
  private readonly queues = new Map<SessionId, readonly SessionQueuedItem[]>()
  /**
   * Sessions that finished running while not selected — the sidebar's green
   * "done" reminder (manager-owned, survives connection generations; cleared
   * on select and session-removed, re-armed by the next completion).
   */
  private readonly completedNotifications = new Set<SessionId>()
  /** Last-observed running bits per session; the true→false edge here arms {@link completedNotifications}. */
  private readonly prevRunning = new Map<SessionId, boolean>()
  /** Per-session projection value stores, retained independently of instance arrival (the
   *  title-snapshot precedent, generalized): push frames land here whether or not the Session
   *  is instantiated (list rows read the 'title' key), and an instantiated Session adopts the
   *  same store so history-baseline seeding and frames converge on one row set. */
  private readonly projectionStores = new Map<SessionId, ProjectionValueStore>()
  private summaries: SessionSummary[] = []
  private listState: 'idle' | 'loading' | 'error' = 'idle'
  /** Arrival phase; the pending → ready edge fires on the first successful pull (see SessionListPhase). */
  private listPhase: SessionListPhase = 'pending'
  private listError: RemoteFailure | null = null
  private listInflight: Promise<void> | null = null
  /** Mutations arriving after a list request starts are replayed over its response. */
  private listMutations: SessionListMutation[] | null = null
  private readonly addresses = new Map<SessionId, SubagentAddress>()
  private readonly catalogs = new Map<SessionId, SubagentCatalogSnapshot>()
  private readonly catalogInflight = new Map<SessionId, CatalogInflight>()
  /** Catalog owners whose membership changed while a pull was in flight: one trailing refresh after it settles. */
  private readonly catalogStale = new Set<SessionId>()
  private readonly openCatalogs = new Set<SessionId>()
  private readonly catalogDebounce = new Map<SessionId, ReturnType<typeof setTimeout>>()
  /**
   * Background jobs per session, last-wins from Session Controller's control
   * stream. An empty set is stored as an absent key, so absence and `[]` are
   * one representation.
   */
  private readonly jobsBySession = new Map<SessionId, readonly JobView[]>()

  private selected: SessionId | undefined

  private listSnapshotCache: SessionListSnapshot
  /** Entry-identity cache (reference stability): list rebuilds reuse the previous entry
   *  object when every field matches — wire refreshes mint all-new summary objects, so identity
   *  must be recovered by value or every SessionListItem memo misses on every refresh. */
  private entryCache = new Map<SessionId, SessionListEntry>()
  private itemsCache: readonly SessionListEntry[] = []
  private readonly notifier = new Notifier(() => {
    this.listSnapshotCache = this.buildListSnapshot()
  })

  /**
   * @param remote - generated Remote namespaces the Session cluster calls.
   * @param restoredSelection - persisted real-Session selection candidate.
   */
  constructor(
    private readonly remote: SessionRemotes,
    restoredSelection?: SessionId,
    restoredAddress?: SubagentAddress,
  ) {
    this.selected = restoredSelection
    if (restoredAddress !== undefined) this.addresses.set(restoredAddress.childSessionId, restoredAddress)
    this.listSnapshotCache = this.buildListSnapshot()
  }

  // ---- Selection ----

  /**
   * Select a listed Session or a retained catalog-addressed child.
   * @param sessionId - listed or catalog-addressed Session id.
   */
  select(sessionId: SessionId): void {
    const address = this.navigationAddress(sessionId)
    if (!this.summaries.some(summary => summary.sessionId === sessionId) && address === undefined) {
      throw new Error(`sessions.select: unknown session ${sessionId}`)
    }
    if (address !== undefined) this.addresses.set(sessionId, address)
    this.sessions.get(sessionId)?.configureSubagent(
      address,
      address === undefined
        ? undefined
        : this.catalogs.get(address.parentSessionId)?.parentAvailable,
    )
    this.selected = sessionId
    // Looking at the session consumes its completion reminder (dot clears).
    this.completedNotifications.delete(sessionId)
    void this.refreshSubagents(sessionId)
    this.notifier.notifyNow()
  }

  /**
   * Select a healthy child through its durable direct-parent address.
   * @param address - catalog-derived parent and child ids.
   */
  selectSubagent(address: SubagentAddress): void {
    const catalog = this.catalogs.get(address.parentSessionId)
    const entry = catalog?.entries.find(candidate => candidate.id === address.childSessionId)
    if (entry === undefined || entry.kind !== 'child' || entry.mode !== address.mode) {
      throw new Error(`sessions.selectSubagent: ${address.childSessionId} is not a healthy catalog child`)
    }
    this.addresses.set(address.childSessionId, address)
    this.sessions.get(address.childSessionId)?.configureSubagent(address, catalog?.parentAvailable)
    this.selected = address.childSessionId
    this.completedNotifications.delete(address.childSessionId)
    void this.refreshSubagents(address.childSessionId)
    this.notifier.notifyNow()
  }

  /** Clear the selection (the layout falls to the no-session view state). */
  clearSelection(): void {
    this.selected = undefined
    this.notifier.notifyNow()
  }

  /**
   * Return the durable catalog address retained for one child.
   * @param sessionId - possible addressed child id.
   * @returns The direct-parent address, when navigation discovered one.
   */
  subagentAddress(sessionId: SessionId): SubagentAddress | undefined {
    return this.addresses.get(sessionId)
  }

  /**
   * Resolve an address for breadcrumb navigation without retaining transport authority.
   * @param sessionId - possible child id in an already-loaded catalog.
   * @returns A retained or catalog-derived direct-parent address.
   */
  navigationAddress(sessionId: SessionId): SubagentAddress | undefined {
    const retained = this.addresses.get(sessionId)
    if (retained !== undefined) return retained
    for (const [parentSessionId, catalog] of this.catalogs) {
      const child = catalog.entries.find(entry => entry.kind === 'child' && entry.id === sessionId)
      if (child?.kind === 'child') {
        return { parentSessionId, childSessionId: sessionId, mode: child.mode }
      }
    }
    return undefined
  }

  // ---- Instance management ----

  /**
   * Drop a session instance (scope-prune companion: instance
   * and scope share one lifecycle). The host session log is the durable
   * truth — a later get() lazily rebuilds and open() backfills history.
   * @param sessionId - the session to drop.
   */
  async drop(sessionId: SessionId): Promise<void> {
    const session = this.sessions.get(sessionId)
    this.sessions.delete(sessionId)
    if (session !== undefined) await this.startSessionDisposal(session)
  }

  /**
   * Stop owned timers and every remaining Session instance.
   * @returns when every Session Remote iterator has completed teardown.
   */
  async dispose(): Promise<void> {
    for (const timer of this.catalogDebounce.values()) clearTimeout(timer)
    this.catalogDebounce.clear()
    this.catalogStale.clear()
    this.openCatalogs.clear()
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    for (const session of sessions) void this.startSessionDisposal(session)
    await this.drainSessionDisposals()
  }

  private startSessionDisposal(session: Session): Promise<void> {
    const disposal = session.dispose()
    this.sessionDisposals.add(disposal)
    void disposal.then(
      () => { this.sessionDisposals.delete(disposal) },
      () => { this.sessionDisposals.delete(disposal) },
    )
    return disposal
  }

  private async drainSessionDisposals(): Promise<void> {
    while (this.sessionDisposals.size > 0) {
      await Promise.allSettled([...this.sessionDisposals])
    }
  }

  /**
   * Lazy build: return the existing instance or construct one (no auto-open —
   * open is triggered by the container's select callback).
   * @param sessionId - the session to get.
   * @returns the resident instance.
   */
  get(sessionId: SessionId): Session {
    let session = this.sessions.get(sessionId)
    if (session === undefined) {
      session = this.createSession(sessionId)
      this.sessions.set(sessionId, session)
      // Install the latest control baseline before the running-bit sync: a
      // not-running summary must sweep replayed queue
      // rows the same way a live status flip would (their retirement events dropped
      // while the session was uninstantiated).
      session.replaceControl(this.queues.get(sessionId) ?? [])
      // Sync the running and blank bits from the list snapshot into the new
      // instance (consistency when the list precedes open).
      const summary = this.summaries.find(s => s.sessionId === sessionId)
      if (summary !== undefined) {
        session.handleBlank(summary.blank)
        session.handleRunning(summary.running)
      } else {
        const address = this.addresses.get(sessionId)
        const child = address === undefined ? undefined : this.catalogs.get(address.parentSessionId)?.entries
          .find(entry => entry.kind === 'child' && entry.id === sessionId)
        if (child?.kind === 'child') {
          // A catalogued child exists only after its delegated session has
          // durable history, even though child rows do not carry `blank`.
          session.handleBlank(false)
          session.handleRunning(child.activity === 'running')
        }
      }
    }
    return session
  }

  private createSession(sessionId: SessionId): Session {
    const address = this.addresses.get(sessionId)
    const parentAvailable = address === undefined
      ? undefined
      : this.catalogs.get(address.parentSessionId)?.parentAvailable
    return new Session(sessionId, this.remote, {
      ...(address === undefined ? {} : {
        address,
        ...catalogAvailability(parentAvailable),
      }),
      // The sender's local first-send flip mirrors into the list row so the
      // session surfaces (lists filter on blank) before any host frame lands.
      onEngaged: (engaged) => {
        this.recordMutation({ kind: 'engaged', sessionId: engaged.sessionId })
      },
      projections: this.projectionStore(sessionId),
    })
  }

  /** Resident per-session projection store (create-on-demand; outlives instantiation). */
  private projectionStore(sessionId: SessionId): ProjectionValueStore {
    let store = this.projectionStores.get(sessionId)
    if (store === undefined) {
      store = new ProjectionValueStore()
      // List rows project off store keys (title); any-key changes re-enter
      // the manager's own batched rebuild channel.
      store.subscribeAny(() => { this.notifier.markDirty() })
      this.projectionStores.set(sessionId, store)
    }
    return store
  }

  /**
   * Refresh one direct-child catalog, reusing its in-flight request.
   * @param parentSessionId - catalog owner.
   */
  refreshSubagents(parentSessionId: SessionId): Promise<void> {
    const existing = this.catalogInflight.get(parentSessionId)
    if (existing !== undefined) return existing.promise
    const previous = this.catalogs.get(parentSessionId)
    const expandableRows = new Set<SessionId>()
    const activityRows = new Map<SessionId, 'running' | 'inactive'>()
    this.catalogs.set(parentSessionId, {
      entries: previous?.entries ?? [],
      ...(previous?.parentAvailable === undefined
        ? {}
        : { parentAvailable: previous.parentAvailable }),
      state: 'loading',
      error: null,
    })
    this.notifier.markDirty()
    const operation = (async () => {
      try {
        const result = await this.remote.subagents.list(parentSessionId)
        if (result.ok) {
          const parentAvailable = this.catalogInflight.get(parentSessionId)?.parentAvailableOverride
            ?? result.value.parentAvailable
          this.catalogs.set(parentSessionId, {
            ...result.value,
            entries: this.withCatalogMutations(result.value.entries, expandableRows, activityRows),
            parentAvailable,
            state: 'ready',
            error: null,
          })
          for (const [childId, address] of this.addresses) {
            if (address.parentSessionId !== parentSessionId) continue
            this.sessions.get(childId)?.handleSubagentParentAvailable(parentAvailable)
          }
        } else {
          this.catalogs.set(parentSessionId, {
            entries: this.withCatalogMutations(
              previous?.entries ?? [], expandableRows, activityRows,
            ),
            ...catalogAvailability(
              this.catalogInflight.get(parentSessionId)?.parentAvailableOverride
                ?? previous?.parentAvailable,
            ),
            state: 'error',
            error: result.error,
          })
        }
      } catch (error: unknown) {
        if (!isRemoteFailure(error)) throw error
        this.catalogs.set(parentSessionId, {
          entries: this.withCatalogMutations(
            previous?.entries ?? [], expandableRows, activityRows,
          ),
          ...catalogAvailability(
            this.catalogInflight.get(parentSessionId)?.parentAvailableOverride
              ?? previous?.parentAvailable,
          ),
          state: 'error',
          error,
        })
      } finally {
        this.catalogInflight.delete(parentSessionId)
        // Re-arm the trailing pull before the dirty notify: the response the
        // caller observed predates the stale-marking change, so the follow-up
        // refresh is the only carrier of that change.
        if (this.catalogStale.delete(parentSessionId)) void this.refreshSubagents(parentSessionId)
        this.notifier.markDirty()
      }
    })()
    this.catalogInflight.set(parentSessionId, {
      promise: operation,
      expandableRows,
      activityRows,
      parentAvailableOverride: undefined,
    })
    return operation
  }

  /**
   * Mark whether a catalog menu is consuming live membership updates.
   * @param parentSessionId - catalog owner.
   * @param open - current menu state.
   */
  setSubagentCatalogOpen(parentSessionId: SessionId, open: boolean): void {
    if (open) {
      this.openCatalogs.add(parentSessionId)
      void this.refreshSubagents(parentSessionId)
    } else {
      this.openCatalogs.delete(parentSessionId)
      const timer = this.catalogDebounce.get(parentSessionId)
      if (timer !== undefined) {
        clearTimeout(timer)
        this.catalogDebounce.delete(parentSessionId)
      }
    }
  }

  // ---- List API ----

  /** Full refresh via session.list (single-flight: an in-flight call is reused). */
  refreshList(): Promise<void> {
    if (this.listInflight !== null) return this.listInflight
    this.listState = 'loading'
    this.listError = null
    const established = this.summaries
    const mutations: SessionListMutation[] = []
    this.listMutations = mutations
    this.notifier.markDirty()
    this.listInflight = (async () => {
      try {
        const result = await this.remote.session.list({})
        if (result.ok) {
          const baseline: SessionSummary[] = this.listPhase === 'pending'
            ? [...result.value.items]
            : mergeOrderedBaseline(established, result.value.items, summary => summary.sessionId)
          // Seed first observations from the pull-time baseline BEFORE replaying
          // in-flight mutations, then reconcile the reminders after EVERY
          // replayed mutation: an edge that happens entirely between mutations
          // (baseline idle → running → idle) must still arm, which a single
          // sync on the folded result would collapse away.
          for (const s of baseline) {
            if (!this.prevRunning.has(s.sessionId)) this.prevRunning.set(s.sessionId, s.running)
          }
          let summaries = baseline
          for (const mutation of mutations) {
            summaries = applyMutation(summaries, mutation)
            this.summaries = summaries
            this.syncCompletedNotifications()
          }
          this.summaries = summaries
          this.listState = 'idle'
          this.listPhase = 'ready'
          // Covers the empty-mutations pull (a plain baseline carries no edge).
          this.syncCompletedNotifications()
          // Push running/blank bits down to instantiated Sessions (the list is the authoritative summary source).
          for (const s of this.summaries) {
            const session = this.sessions.get(s.sessionId)
            if (session === undefined) continue
            session.handleBlank(s.blank)
            session.handleRunning(s.running)
          }
          // Seed each row's projection baseline into the per-session value
          // store (cold titles surface without opening the session). Per-key
          // apply, not seed(): the list block is a partial baseline — the
          // cold cache serves only version-matching keys — so an absent key
          // must not clear; higher-seq-wins still keeps a stale list block
          // from overwriting a newer push frame or tail baseline.
          for (const s of result.value.items) {
            const block = s.projections
            if (block === undefined) continue
            const store = this.projectionStore(s.sessionId)
            const values = block.values as Record<string, unknown>
            for (const key of Object.keys(values)) store.apply(key, values[key], sessionSeqCursor(block.asOfSeq))
          }
        } else {
          this.listState = 'error'
          this.listError = result.error
        }
      } catch (error) {
        if (!isRemoteFailure(error)) throw error
        this.listState = 'error'
        this.listError = error
      } finally {
        this.listMutations = null
        this.listInflight = null
        this.notifier.markDirty()
      }
    })()
    return this.listInflight
  }

  /**
   * Search visible session message content without adding transient query
   * state to the list snapshot.
   * @param query - non-blank literal phrase.
   * @param signal - cancellation for superseded UI queries.
   * @returns the Host result or a folded transport error.
   */
  async search(
    query: string,
    signal: AbortSignal,
  ): Promise<RemoteResult<{ items: SessionSearchResultItem[]; hasMore: boolean }>> {
    const result = await this.remote.session.search({ query }, signal)
    if (!result.ok) return result
    return {
      ok: true,
      value: {
        items: [...result.value.items],
        hasMore: result.value.hasMore,
      },
    }
  }

  /**
   * Contract session.create; on success merge into summaries immediately (no
   * wait for the next refresh). A created session is blank by definition
   * (entity birth precedes the first message).
   * @param opts - target workspace or working directory, plus an optional caller-owned id.
   * @returns the create result.
  */
  async create(
    opts: {
      workspaceId?: WorkspaceId
      cwd?: string
      sessionId?: SessionId
    } = {},
  ): Promise<RemoteResult<{ sessionId: SessionId }>> {
    const shared = opts.sessionId === undefined ? {} : { sessionId: opts.sessionId }
    const payload = opts.workspaceId !== undefined
      ? { workspaceId: opts.workspaceId, ...shared }
      : { ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }), ...shared }
    const result = await this.remote.session.create(payload)
    if (result.ok) {
      this.recordMutation({ kind: 'upsert', summary: {
        sessionId: result.value.sessionId, updatedAt: Date.now(), running: false, blank: true,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      } })
    } else {
      const publishedSessionId = workspaceAttachSessionId(result.error)
      // Publication precedes attachment. The error's id is a real Session,
      // so expose it immediately as Ungrouped while the caller keeps the
      // prompt buffer and decides whether to retry attachment.
      if (publishedSessionId !== undefined) {
        this.recordMutation({ kind: 'upsert', summary: {
          sessionId: publishedSessionId,
          updatedAt: Date.now(),
          running: false,
          blank: true,
        } })
      }
    }
    return result
  }

  /**
   * Contract session.fork; on success merge the child into summaries
   * immediately (same synchronous-addressability guarantee as create). The
   * child carries the source's history, so it is never blank; lineage rides
   * parentSessionId so the list nests it under its source. A child published
   * before Workspace attachment fails is also reconciled into the list.
   * @param opts - source session and the optional seq anchoring the cut.
   * @returns the fork result (the child session id).
   */
  async fork(
    opts: { sessionId: SessionId; atSeq?: SessionSeq },
  ): Promise<RemoteResult<{ sessionId: SessionId }>> {
    const source = this.summaries.find(s => s.sessionId === opts.sessionId)
    const result = await this.remote.session.fork({
      sessionId: opts.sessionId,
      ...opts.atSeq === undefined ? {} : { atSeq: opts.atSeq },
    })
    const childId = result.ok
      ? result.value.sessionId
      : workspaceAttachSessionId(result.error)
    if (childId !== undefined) {
      this.recordMutation({ kind: 'upsert', summary: {
        sessionId: childId, updatedAt: Date.now(), running: false, blank: false,
        parentSessionId: opts.sessionId,
        ...(source?.cwd !== undefined ? { cwd: source.cwd } : {}),
      } })
    }
    return result
  }

  /**
   * Insert-or-enrich a locally synthesized summary: a new id prepends; an
   * existing entry only gains fields it lacks (the session-added frame and the
   * create() echo race — whichever lands second must fill the placeholder's
   * missing cwd/parentSessionId, never overwrite list-refresh data).
   */
  private mergeSummary(summary: SessionSummary): void {
    this.recordMutation({ kind: 'upsert', summary })
  }

  /** Apply immediately and retain for replay when a list response is in flight. */
  private recordMutation(mutation: SessionListMutation): void {
    this.listMutations?.push(mutation)
    this.summaries = applyMutation(this.summaries, mutation)
    // Eager edge reconciliation — a snapshot-build-time pass would miss consecutive status frames.
    this.syncCompletedNotifications()
    this.notifier.markDirty()
  }

  // ---- Subscription API (for useSessionList) ----

  /**
   * uSES subscription entry for useSessionList.
   * @param listener - change callback.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    return this.notifier.subscribe(listener)
  }

  /**
   * Cached list snapshot (rebuilt lazily when dirty with no listeners).
   * @returns the cached reference (stable until the next flush).
   */
  getListSnapshot(): SessionListSnapshot {
    this.notifier.ensureFresh()
    return this.listSnapshotCache
  }

  // ---- Live control and Host-event sinks ----

  /**
   * Apply a complete control baseline or one later replacement frame.
   * @param frame - baseline or live control replacement from Session Controller.
   */
  handleControlFrame(frame: SessionControlFrame): void {
    if (frame.type === 'baseline') {
      this.replaceControlBaseline(frame.value)
      return
    }
    if (frame.type === 'projection') {
      this.projectionStore(frame.sessionId).apply(frame.key, frame.value, SessionSeq(frame.seq))
      this.notifier.markDirty()
      return
    }
    if (frame.type === 'jobs') {
      if (frame.jobs.length === 0) this.jobsBySession.delete(frame.sessionId)
      else this.jobsBySession.set(frame.sessionId, frame.jobs)
      this.notifier.markDirty()
      return
    }
    this.queues.set(frame.sessionId, frame.items)
    this.sessions.get(frame.sessionId)?.handleControlFrame(frame)
  }

  private replaceControlBaseline(baseline: SessionControlBaseline): void {
    this.queues.clear()
    for (const [sessionId, items] of Object.entries(baseline.queues)) {
      this.queues.set(sessionId as SessionId, items)
    }

    this.jobsBySession.clear()
    for (const [sessionId, jobs] of Object.entries(baseline.jobs)) {
      if (jobs.length > 0) this.jobsBySession.set(sessionId as SessionId, jobs)
    }

    for (const [sessionId, block] of Object.entries(baseline.projections)) {
      const store = this.projectionStore(sessionId as SessionId)
      const asOfSeq = sessionSeqCursor(block.asOfSeq)
      store.truncate(asOfSeq)
      store.seed({ ...block, asOfSeq })
    }
    for (const [sessionId, session] of this.sessions) {
      session.replaceControl(this.queues.get(sessionId) ?? [])
    }
    this.notifier.markDirty()
  }

  /**
   * Apply one Session-list addition forwarded through `ctx.remote.$on`.
   * @param summary - current Host summary for the added Session.
   */
  handleSessionAdded(summary: SessionSummary): void {
    this.mergeSummary(summary)
    this.sessions.get(summary.sessionId)?.handleBlank(summary.blank)
    const projections = summary.projections
    if (projections !== undefined) {
      const store = this.projectionStore(summary.sessionId)
      for (const [key, value] of Object.entries(projections.values)) {
        store.apply(key, value, sessionSeqCursor(projections.asOfSeq))
      }
    }
    if (summary.origin === 'subagent' && summary.parentSessionId !== undefined) {
      this.markCatalogParentExpandable(summary.parentSessionId)
    }
    if (summary.parentSessionId !== undefined
      && (this.selected === summary.parentSessionId || this.openCatalogs.has(summary.parentSessionId))) {
      this.scheduleCatalogRefresh(summary.parentSessionId)
    }
  }

  /**
   * Apply one Session removal forwarded through `ctx.remote.$on`.
   * @param sessionId - removed Session identity.
   */
  handleSessionRemoved(sessionId: SessionId): void {
    const summary = this.summaries.find(candidate => candidate.sessionId === sessionId)
    const durableSubagent = summary?.origin === 'subagent' || this.addresses.has(sessionId)
    this.recordMutation(durableSubagent
      ? { kind: 'status', sessionId, running: false }
      : { kind: 'remove', sessionId })
    this.updateCatalogActivity(sessionId, false)
    if (durableSubagent) this.sessions.get(sessionId)?.handleRunning(false)
    else this.sessions.get(sessionId)?.handleRemoved()
    this.queues.delete(sessionId)
    this.jobsBySession.delete(sessionId)
    if (!durableSubagent) this.projectionStores.delete(sessionId)
    const inflightCatalog = this.catalogInflight.get(sessionId)
    if (inflightCatalog !== undefined) {
      inflightCatalog.parentAvailableOverride = false
      this.catalogStale.add(sessionId)
    }
    const ownedCatalog = this.catalogs.get(sessionId)
    if (ownedCatalog !== undefined && ownedCatalog.parentAvailable) {
      this.catalogs.set(sessionId, { ...ownedCatalog, parentAvailable: false })
    }
    for (const [childId, address] of this.addresses) {
      if (address.parentSessionId === sessionId) {
        this.sessions.get(childId)?.handleSubagentParentAvailable(false)
      }
    }
  }

  /**
   * Apply one live Agent running-state change.
   * @param sessionId - Session whose Agent state changed.
   * @param running - current Agent running state.
   */
  handleSessionStatus(sessionId: SessionId, running: boolean): void {
    this.recordMutation({ kind: 'status', sessionId, running })
    this.sessions.get(sessionId)?.handleRunning(running)
    this.updateCatalogActivity(sessionId, running)
  }

  /**
   * Advance Session-list activity from one user-authored durable message.
   * @param sessionId - Session whose activity changed.
   * @param updatedAt - durable message timestamp.
   */
  handleSessionActivity(sessionId: SessionId, updatedAt: number): void {
    this.recordMutation({ kind: 'activity', sessionId, updatedAt })
  }

  /**
   * Surface one live Agent failure on an already-materialized Session.
   * @param sessionId - Session whose Agent failed.
   * @param message - caller-visible failure description.
   */
  handleSessionError(sessionId: SessionId, message: string): void {
    this.sessions.get(sessionId)?.handleAgentError(message)
  }

  /**
   * Repair one re-established Host-event generation with queryable baselines.
   * Opened Session follow streams resume independently through API Gateway.
   */
  handleConnected(): void {
    void this.refreshList()
    const selectedAddress = this.selected === undefined ? undefined : this.addresses.get(this.selected)
    if (selectedAddress !== undefined) void this.refreshSubagents(selectedAddress.parentSessionId)
    if (this.selected !== undefined) void this.refreshSubagents(this.selected)
    for (const parentSessionId of this.openCatalogs) void this.refreshSubagents(parentSessionId)
  }

  /** Debounce membership refetches while one parent catalog is selected or open. */
  private scheduleCatalogRefresh(parentSessionId: SessionId): void {
    if (this.catalogDebounce.has(parentSessionId)) return
    const timer = setTimeout(() => {
      this.catalogDebounce.delete(parentSessionId)
      // The in-flight response predates the membership frame that scheduled
      // this callback. Queue one post-settlement pull instead of treating an
      // ordinary overlapping read as evidence that catalog membership changed.
      if (this.catalogInflight.has(parentSessionId)) {
        this.catalogStale.add(parentSessionId)
        return
      }
      void this.refreshSubagents(parentSessionId)
    }, 50)
    this.catalogDebounce.set(parentSessionId, timer)
  }

  /** Apply one Agent-driver transition to loaded and in-flight catalogs. */
  private updateCatalogActivity(childSessionId: SessionId, running: boolean): void {
    const activity = running ? 'running' as const : 'inactive' as const
    for (const inflight of this.catalogInflight.values()) {
      inflight.activityRows.set(childSessionId, activity)
    }
    let changed = false
    for (const [parentSessionId, catalog] of this.catalogs) {
      if (!catalog.entries.some(entry =>
        entry.kind === 'child' && entry.id === childSessionId && entry.activity !== activity)) continue
      const entries = catalog.entries.map((entry) => {
        if (entry.kind !== 'child' || entry.id !== childSessionId) return entry
        return { ...entry, activity }
      })
      changed = true
      this.catalogs.set(parentSessionId, { ...catalog, entries })
    }
    if (changed) this.notifier.markDirty()
  }

  /** Preserve and project a positive expandability hint after one direct subagent publishes. */
  private markCatalogParentExpandable(parentSessionId: SessionId): void {
    this.applyCatalogParentExpandable(parentSessionId)
    for (const inflight of this.catalogInflight.values()) inflight.expandableRows.add(parentSessionId)
  }

  /** Apply one positive expandability hint to every loaded catalog containing that unique row id. */
  private applyCatalogParentExpandable(parentSessionId: SessionId): void {
    let changed = false
    for (const [catalogParentId, catalog] of this.catalogs) {
      if (!catalog.entries.some(entry =>
        entry.kind === 'child' && entry.id === parentSessionId && !entry.hasChildren)) continue
      const entries = catalog.entries.map((entry) => {
        if (entry.kind !== 'child' || entry.id !== parentSessionId || entry.hasChildren) return entry
        return { ...entry, hasChildren: true }
      })
      changed = true
      this.catalogs.set(catalogParentId, { ...catalog, entries })
    }
    if (changed) this.notifier.markDirty()
  }

  /** Fold request-local row mutations into one catalog result before publication. */
  private withCatalogMutations(
    entries: SubagentCatalog['entries'],
    expandableRows: ReadonlySet<SessionId>,
    activityRows: ReadonlyMap<SessionId, 'running' | 'inactive'>,
  ): SubagentCatalog['entries'] {
    return entries.map((entry) => {
      if (entry.kind !== 'child') return entry
      const activity = activityRows.get(entry.id)
      if (!expandableRows.has(entry.id) && activity === undefined) return entry
      return {
        ...entry,
        ...expandableRows.has(entry.id) ? { hasChildren: true } : {},
        ...activity === undefined ? {} : { activity },
      }
    })
  }

  /**
   * Reconcile completion reminders against the latest summaries, eagerly after
   * every mutation and pull (a snapshot-build-time pass would collapse
   * consecutive status frames into one observation). A running→idle edge of a
   * non-selected session arms its reminder; running disarms it; removal drops
   * it. First observation only records the running bit — sessions already
   * idle at load get no reminder.
   */
  private syncCompletedNotifications(): void {
    const seen = new Set<SessionId>()
    for (const s of this.summaries) {
      seen.add(s.sessionId)
      const prev = this.prevRunning.get(s.sessionId)
      if (prev === undefined) {
        this.prevRunning.set(s.sessionId, s.running)
        continue
      }
      if (prev && !s.running) {
        if (s.sessionId !== this.selected) this.completedNotifications.add(s.sessionId)
      } else if (s.running) {
        this.completedNotifications.delete(s.sessionId)
      }
      this.prevRunning.set(s.sessionId, s.running)
    }
    for (const id of this.prevRunning.keys()) {
      if (!seen.has(id)) this.prevRunning.delete(id)
    }
    for (const id of this.completedNotifications) {
      if (!seen.has(id)) this.completedNotifications.delete(id)
    }
  }

  private buildListSnapshot(): SessionListSnapshot {
    const merged: TitledSessionSummary[] = this.summaries.map((summary) => {
      // List rows read the generic 'title' projection key (host-computed unit
      // value; there is no dedicated title frame).
      const projectionStore = this.projectionStores.get(summary.sessionId)
      const title = projectionStore?.get('title')
      const projectionValues = projectionStore?.values()
      return {
        ...summary,
        ...(typeof title === 'string' && title !== '' ? { title } : {}),
        ...(projectionValues === undefined ? {} : { projectionValues }),
      }
    })
    const fresh = flattenLineage(merged, this.completedNotifications)
    const items = fresh.map((entry) => {
      const prev = this.entryCache.get(entry.sessionId)
      if (
        prev !== undefined && prev.updatedAt === entry.updatedAt && prev.running === entry.running
        && prev.blank === entry.blank
        && prev.parentSessionId === entry.parentSessionId && prev.cwd === entry.cwd
        && prev.origin === entry.origin && prev.title === entry.title && prev.depth === entry.depth
        && prev.projectionValues === entry.projectionValues
        && prev.completed === entry.completed
      ) return prev
      this.entryCache.set(entry.sessionId, entry)
      return entry
    })
    for (const id of this.entryCache.keys()) {
      if (!items.some(e => e.sessionId === id)) this.entryCache.delete(id)
    }
    const sameOrder = items.length === this.itemsCache.length && items.every((e, i) => e === this.itemsCache[i])
    if (!sameOrder) this.itemsCache = items
    const selected = this.selected
    const current = selected !== undefined
      && (items.some(item => item.sessionId === selected) || this.addresses.has(selected))
      ? selected
      : undefined
    return {
      items: this.itemsCache,
      current,
      state: this.listState,
      phase: this.listPhase,
      error: this.listError,
      subagentsByParent: Object.fromEntries(this.catalogs),
      jobsBySession: Object.fromEntries(this.jobsBySession),
      currentAddress: current === undefined ? undefined : this.addresses.get(current),
    }
  }
}

/** Apply one list mutation without deriving display order. */
function applyMutation(summaries: readonly SessionSummary[], mutation: SessionListMutation): SessionSummary[] {
  switch (mutation.kind) {
    case 'upsert': {
      const existing = summaries.find(summary => summary.sessionId === mutation.summary.sessionId)
      if (existing === undefined) return [mutation.summary, ...summaries]
      const filled: SessionSummary = {
        ...existing,
        // Blank only lowers: a stale true (session-added racing the local
        // first send) never re-hides an already-surfaced session.
        blank: existing.blank && mutation.summary.blank,
        ...(existing.cwd === undefined && mutation.summary.cwd !== undefined ? { cwd: mutation.summary.cwd } : {}),
        ...(existing.parentSessionId === undefined && mutation.summary.parentSessionId !== undefined
          ? { parentSessionId: mutation.summary.parentSessionId } : {}),
        ...(existing.origin === undefined && mutation.summary.origin !== undefined
          ? { origin: mutation.summary.origin } : {}),
      }
      if (filled.cwd === existing.cwd && filled.parentSessionId === existing.parentSessionId
        && filled.origin === existing.origin && filled.blank === existing.blank
      ) return [...summaries]
      return summaries.map(summary => summary.sessionId === mutation.summary.sessionId ? filled : summary)
    }
    case 'remove':
      return summaries.filter(summary => summary.sessionId !== mutation.sessionId)
    case 'status':
      // running:true doubles as the cross-client blank flip (a blank session
      // never runs, so the first running frame proves a message landed).
      return summaries.map(summary => summary.sessionId === mutation.sessionId
        && (summary.running !== mutation.running || (mutation.running && summary.blank))
        ? { ...summary, running: mutation.running, blank: summary.blank && !mutation.running }
        : summary)
    case 'activity':
      return summaries.map(summary => summary.sessionId === mutation.sessionId
        && mutation.updatedAt > summary.updatedAt
        ? { ...summary, updatedAt: mutation.updatedAt }
        : summary)
    case 'engaged':
      return summaries.map(summary => summary.sessionId === mutation.sessionId && summary.blank
        ? { ...summary, blank: false }
        : summary)
  }
}

/** Temporary source-plane bridge while the Host contract and client project build independently. */
function workspaceAttachSessionId(error: RemoteFailure): SessionId | undefined {
  return error.code === 'session/workspace-attach-failed' ? error.details.sessionId : undefined
}
