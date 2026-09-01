/** Test-owned Session Controller faces over declarative fixtures. */
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentIdType } from '@deepseek-ai/dsh-attachment'
import {
  createScope, MutableSessionEventSource, scopeOf, SESSION_SEARCH_RESULT_LIMIT,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  AgentContext, ISessions, ProjectionsFace, SessionBinding, SessionFace, SessionListState,
  SessionEventLikeEntry, SessionLiveEventEntry, SessionSearchResultItem,
  SessionSnapshot, SessionSummary, SubmissionHandle,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { sessionSnapshot } from './fixtures.ts'
import type {
  SessionFixture, SessionFixtureSnapshot, Stabilizer,
} from './fixtures.ts'

/**
 * The fixture-backed session face: lifecycle reads delegate to the fixture's
 * snapshot store; Session verbs are fail-loud stubs unless the
 * fixture supplies them (the runtime never fakes behavior a test did not
 * declare — an unstubbed call names itself instead of half-working). Extra
 * fixture methods are grafted verbatim for feature-side casts.
 */
export class FixtureSession implements SessionFace {
  /** Mutable event source consumed only by Conversation assembly. */
  readonly eventSource = new MutableSessionEventSource()

  /**
   * Identity-stable per-key faces over fixture-controlled projection values.
   */
  readonly projections: ProjectionsFace & { set(key: string, value: unknown): void }

  /**
   * @param sessionId - host identity (branded view of the fixture id).
   * @param store - Session Controller snapshot store.
   * @param overrides - fixture-declared behavior face, grafted over the stubs.
   */
  constructor(
    readonly sessionId: SessionId,
    private readonly store: SnapshotStore<SessionFixtureSnapshot>,
    overrides: Record<string, unknown>,
  ) {
    const values = new Map<string, unknown>()
    const listeners = new Map<string, Set<() => void>>()
    const faces = new Map<string, ObservableSnapshot<unknown>>()
    this.projections = {
      faceOf: (key: string) => {
        let face = faces.get(key)
        if (face === undefined) {
          face = {
            getSnapshot: () => values.get(key),
            subscribe: (fn: () => void) => {
              const set = listeners.get(key) ?? new Set()
              set.add(fn)
              listeners.set(key, set)
              return () => { set.delete(fn) }
            },
          }
          faces.set(key, face)
        }
        return face
      },
      set: (key: string, value: unknown) => {
        values.set(key, value)
        for (const fn of [...(listeners.get(key) ?? [])]) fn()
      },
    }
    Object.assign(this, overrides)
  }

  /** @returns the fixture Session Controller snapshot (useSession read side). */
  getSnapshot(): SessionSnapshot {
    return this.store.getSnapshot()
  }

  /**
   * Subscribe to fixture snapshot changes.
   * @param fn - change callback.
   * @returns unsubscribe.
   */
  subscribe(fn: () => void): () => void {
    return this.store.subscribe(fn)
  }

  /**
   * Fail-loud stub; supply `prompt` on the fixture's session face to exercise it.
   * @returns never — always throws.
   */
  prompt(): never {
    throw new Error(`test session "${this.sessionId}": prompt is not stubbed — supply it on the fixture's session face`)
  }

  /**
   * Minimal local-echo registration: mints an identity without touching the
   * fixture snapshot (submission echoes are client-only presentation state).
   * Supply `beginSubmission` on the fixture's session face to observe echoes.
   * @returns a handle whose abandon is a no-op.
   */
  beginSubmission(): SubmissionHandle {
    this.submissionSeq += 1
    return {
      requestId: `test-submission-${this.submissionSeq}` as SessionRequestId,
      abandon: () => {},
    }
  }

  private submissionSeq = 0

  /**
   * Fail-loud stub; supply `readAttachment` on the fixture's session face to exercise it.
   * @param _attachmentId - opaque durable attachment id.
   * @returns never — always throws.
   */
  readAttachment(_attachmentId: AttachmentIdType): never {
    throw new Error(`test session "${this.sessionId}": readAttachment is not stubbed — supply it on the fixture's session face`)
  }

  /**
   * Fail-loud stub; supply `updateQueue` on the fixture's session face to exercise it.
   * @returns never — always throws.
   */
  updateQueue(): never {
    throw new Error(`test session "${this.sessionId}": updateQueue is not stubbed — supply it on the fixture's session face`)
  }

  /**
   * Fail-loud stub; supply `cancel` on the fixture's session face to exercise it.
   * @returns never — always throws.
   */
  cancel(): never {
    throw new Error(`test session "${this.sessionId}": cancel is not stubbed — supply it on the fixture's session face`)
  }

  /**
   * Fail-loud stub; supply `command` on the fixture's session face to exercise it.
   * @returns never — always throws.
   */
  command(): never {
    throw new Error(`test session "${this.sessionId}": command is not stubbed — supply it on the fixture's session face`)
  }

  /**
   * Fail-loud stub; supply `loadOlder` on the fixture's session face to exercise it.
   * @returns never — always throws.
   */
  loadOlder(): never {
    throw new Error(`test session "${this.sessionId}": loadOlder is not stubbed — supply it on the fixture's session face`)
  }

  /**
   * Fail-loud stub; supply `loadThrough` on the fixture's session face to exercise it.
   * @returns never — always throws.
   */
  loadThrough(): never {
    throw new Error(`test session "${this.sessionId}": loadThrough is not stubbed — supply it on the fixture's session face`)
  }

  /**
   * Fail-loud stub; supply `rename` on the fixture's session face to exercise it.
   * @returns never — always throws.
   */
  rename(): never {
    throw new Error(`test session "${this.sessionId}": rename is not stubbed — supply it on the fixture's session face`)
  }
}

/** One live test session: fixture-derived stores plus its minted scope state. */
interface SessionRecord {
  summary: SessionSummary
  snapshot: SnapshotStore<SessionFixtureSnapshot>
  session: FixtureSession
  scope: AgentContext | undefined
  scopeFiber: { dispose(): Promise<void> } | undefined
  binding: SessionBinding | undefined
}

/**
 * Sessions test double behind the renderer host and feature injects: owns the
 * list/current observable, scope minting through the production `createScope`,
 * stable Controller bindings, and the session behavior face supplied per
 * fixture. `ui-session` owns standard-source materialization.
 *
 * Implements the same ISessions face features receive as `ctx.sessions`, so
 * a production face change breaks this double at compile time; the extra
 * members (add/updateSessionSnapshot/event-window drivers/setCurrent/remove/
 * behavior/calls/stubs) are bench-only surface.
 */
export class TestSessions implements ISessions {
  /** The useSessions standard feed (list rows + current selection). */
  readonly list: SnapshotStore<SessionListState>
  private readonly records = new Map<SessionId, SessionRecord>()

  /** Calls observed on the service-level face, newest last. */
  readonly calls: {
    method: 'create' | 'open' | 'openSubagent' | 'setSubagentCatalogOpen' | 'refreshSubagents'
      | 'clear' | 'refresh' | 'search' | 'fork'
    args: unknown[]
  }[] = []

  /** The wire schema's `session.search` result bound (production parity). */
  readonly searchResultLimit = SESSION_SEARCH_RESULT_LIMIT

  /** Replaceable search behavior (see {@link TestSessions.stubSearch}). */
  private searchStub: ((query: string, signal: AbortSignal) => { items: SessionSearchResultItem[]; hasMore: boolean }) | undefined
  private createStub: ((opts: Parameters<ISessions['create']>[0]) => Promise<SessionId>) | undefined

  /**
   * @param stabilize - the owning runtime's act wrapper.
   * @param rootCtx - the runtime's Cordis root; scope fibers mount under it.
   */
  constructor(private readonly stabilize: Stabilizer, private readonly rootCtx: Context) {
    this.list = createSnapshotStore<SessionListState>({
      ids: [], byId: {}, current: undefined, phase: 'ready',
      subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    })
  }

  /**
   * Add a session from a fixture and (by default) make it current.
   * @param fixture - identity + snapshot/summary overrides + behavior face.
   * @param opts - pass `current: false` to add without selecting.
   * @returns the stable session id (branded view of `fixture.id`).
   */
  async add(fixture: SessionFixture, opts?: { current?: boolean }): Promise<SessionId> {
    const id = fixture.id as SessionId
    if (this.records.has(id)) throw new Error(`test session "${id}" already added`)
    const summary: SessionSummary = {
      id,
      displayTitle: fixture.id,
      running: false,
      blank: false,
      updatedAt: this.records.size + 1,
      ...fixture.summary,
    }
    const snapshot = createSnapshotStore<SessionFixtureSnapshot>({
      ...sessionSnapshot(id),
      ...fixture.snapshot,
    })
    const session = new FixtureSession(id, snapshot, fixture.session ?? {})
    if (fixture.events !== undefined || fixture.hasMore === true) {
      session.eventSource.replace(fixture.events ?? [], fixture.hasMore ?? false)
    }
    this.records.set(id, {
      summary,
      snapshot,
      session,
      scope: undefined,
      scopeFiber: undefined,
      binding: undefined,
    })
    await this.stabilize(() => {
      this.list.update((draft) => {
        draft.ids.push(id)
        draft.byId[id] = summary
        if (opts?.current !== false) draft.current = id
      })
    })
    return id
  }

  /**
   * Update Session Controller lifecycle state through an immer draft.
   * @param id - session id.
   * @param mutate - draft mutator.
   */
  async updateSessionSnapshot(
    id: string,
    mutate: (draft: SessionFixtureSnapshot) => void,
  ): Promise<void> {
    const record = this.require(id)
    await this.stabilize(() => { record.snapshot.update(mutate) })
  }

  /**
   * Replace a Session's complete contiguous event window.
   * @param id - Session identity.
   * @param entries - complete event window.
   * @param hasMore - whether older history remains.
   */
  async replaceEvents(
    id: string,
    entries: readonly SessionEventLikeEntry[],
    hasMore = false,
  ): Promise<void> {
    await this.stabilize(() => { this.require(id).session.eventSource.replace(entries, hasMore) })
  }

  /**
   * Prepend one older contiguous event page.
   * @param id - Session identity.
   * @param entries - older entries.
   * @param hasMore - whether another older page remains.
   */
  async prependEvents(
    id: string,
    entries: readonly SessionEventLikeEntry[],
    hasMore = false,
  ): Promise<void> {
    await this.stabilize(() => { this.require(id).session.eventSource.prepend(entries, hasMore) })
  }

  /**
   * Append one live event to a Session's contiguous window.
   * @param id - Session identity.
   * @param entry - live event entry.
   */
  async appendEvent(id: string, entry: SessionLiveEventEntry): Promise<void> {
    await this.stabilize(() => { this.require(id).session.eventSource.append(entry) })
  }

  /**
   * Update a session's list row (the wire-echo stand-in: title settles,
   * running flips — components subscribed via useSessions re-render).
   * @param id - session id.
   * @param patch - summary fields to merge over the row.
   */
  async updateSummary(id: string, patch: Partial<Omit<SessionSummary, 'id'>>): Promise<void> {
    const record = this.require(id)
    record.summary = { ...record.summary, ...patch }
    await this.stabilize(() => {
      this.list.update((draft) => { draft.byId[id as SessionId] = record.summary })
    })
  }

  /**
   * Switch the current selection (undefined = the no-session empty state).
   * @param id - session id to select, or undefined to clear.
   */
  async setCurrent(id: string | undefined): Promise<void> {
    if (id !== undefined) this.require(id)
    await this.stabilize(() => {
      this.list.update((draft) => { draft.current = id as SessionId | undefined })
    })
  }

  /**
   * Remove a session: list row, scope fiber, and per-session store instances
   * (with persisted state) die together — the same single lifecycle axis the
   * production Client Sessions service drives on session death, minus staging.
   * @param id - session id.
   */
  async remove(id: string): Promise<void> {
    const record = this.require(id)
    this.records.delete(id as SessionId)
    await this.stabilize(async () => {
      this.list.update((draft) => {
        draft.ids = draft.ids.filter(existing => existing !== id)
        const { [id as SessionId]: _dead, ...rest } = draft.byId
        draft.byId = rest
        if (draft.current === id) draft.current = undefined
      })
      if (record.scopeFiber !== undefined) await record.scopeFiber.dispose()
    })
  }

  /**
   * Resolve (mint on first touch) the session-scoped Cordis context through
   * the production `createScope`, so real `scopeOf`/scope-addressed services
   * resolve it.
   * @param id - session id.
   * @returns the scoped context, or undefined for unknown sessions.
   */
  scope(id: string): AgentContext | undefined {
    const record = this.records.get(id as SessionId)
    if (record === undefined) return undefined
    if (record.scope === undefined) {
      const handle = createScope(this.rootCtx, id as SessionId)
      record.scope = handle.ctx
      record.scopeFiber = handle.fiber
    }
    return record.scope
  }

  /**
   * Session assembly binding (inject factories and provide resolvers receive it).
   * @param id - session id.
   * @returns sessionId + behavior face + scoped ctx, or undefined when unknown.
   */
  binding(id: string): SessionBinding | undefined {
    const record = this.records.get(id as SessionId)
    if (record === undefined) return undefined
    record.binding ??= this.bindingOf(id as SessionId, record)
    return record.binding
  }

  /**
   * Read the session scope tag off a context (service-method boundary mirror).
   * @param ctx - any client context.
   * @returns the session id, or undefined on root contexts.
   */
  scopeOf(ctx: Context): SessionId | undefined {
    return scopeOf(ctx)
  }

  /**
   * Resolve the scoped session face off a context (production `sessionOf`
   * mirror).
   * @param ctx - any client context.
   * @returns the fixture session face, or undefined off-scope.
   */
  sessionOf(ctx: Context): SessionFace | undefined {
    const id = scopeOf(ctx)
    if (id === undefined) return undefined
    return this.records.get(id)?.session
  }

  /**
   * Install Session creation behavior for navigation tests.
   * @param impl - implementation that must return an already-added fixture id.
   */
  stubCreate(impl: (opts: Parameters<ISessions['create']>[0]) => Promise<SessionId>): void {
    this.createStub = impl
  }

  /** Create through the installed test behavior and require an addressable binding. */
  async create(opts?: Parameters<ISessions['create']>[0]): Promise<SessionId> {
    this.calls.push({ method: 'create', args: [opts] })
    if (this.createStub === undefined) {
      throw new Error('test sessions: create is not stubbed — call stubCreate() first')
    }
    const id = await this.createStub(opts)
    this.require(id)
    return id
  }

  /**
   * Service-level selection call (recorded, then applied to the list store
   * synchronously — inject callbacks call this outside any act window; the
   * store notify is microtask-batched so the next stabilized step observes it).
   * @param id - session id.
   */
  open(id: SessionId): void {
    this.calls.push({ method: 'open', args: [id] })
    this.require(id)
    this.list.update((draft) => {
      draft.current = id
      draft.currentAddress = undefined
    })
  }

  /** Open an existing fixture through its catalog address. */
  openSubagent(address: SubagentAddress): void {
    this.calls.push({ method: 'openSubagent', args: [address] })
    this.require(address.childSessionId)
    this.list.update((draft) => {
      draft.current = address.childSessionId
      draft.currentAddress = address
    })
  }

  /** Resolve the current fixture's retained catalog address. */
  subagentAddress(id: SessionId): SubagentAddress | undefined {
    const address = this.list.getSnapshot().currentAddress
    return address?.childSessionId === id ? address : undefined
  }

  /** Record catalog consumption; fixture callers drive snapshots explicitly. */
  setSubagentCatalogOpen(parentSessionId: SessionId, open: boolean): void {
    this.calls.push({ method: 'setSubagentCatalogOpen', args: [parentSessionId, open] })
  }

  /** Record a catalog refresh; fixture callers drive snapshots explicitly. */
  refreshSubagents(parentSessionId: SessionId): Promise<void> {
    this.calls.push({ method: 'refreshSubagents', args: [parentSessionId] })
    return Promise.resolve()
  }

  /** Clear the current selection (recorded; the production no-session flow). */
  clear(): void {
    this.calls.push({ method: 'clear', args: [] })
    this.list.update((draft) => {
      draft.current = undefined
      draft.currentAddress = undefined
    })
  }

  /** Record a list refresh; fixture callers publish list state explicitly. */
  refresh(): Promise<void> {
    this.calls.push({ method: 'refresh', args: [] })
    return Promise.resolve()
  }

  /**
   * Replace the sidebar-search result page (the call is still recorded).
   * @param impl - hits for a query, as the Host would rank them.
   */
  stubSearch(impl: (query: string, signal: AbortSignal) => { items: SessionSearchResultItem[]; hasMore: boolean }): void {
    this.searchStub = impl
  }

  /**
   * Content search over the fixture corpus (recorded). The default answers an
   * empty page: content ranking is Host behavior, so a scenario that asserts
   * hits declares them through {@link TestSessions.stubSearch}.
   * @param query - non-blank literal phrase.
   * @param signal - cancellation for a superseded search (recorded and forwarded).
   * @returns the stubbed or empty result page.
   */
  search(query: string, signal: AbortSignal): ReturnType<ISessions['search']> {
    this.calls.push({ method: 'search', args: [query, signal] })
    return Promise.resolve({ ok: true, value: this.searchStub?.(query, signal) ?? { items: [], hasMore: false } })
  }

  /**
   * Recorded fork stub: no child materializes (benches asserting the full
   * fork flow drive the production service; this face only proves the call).
   * @param opts - source session id, optional cut anchor, and client title policy.
   * @returns the source id (no child record is created).
   */
  fork(opts: { sessionId: SessionId; atSeq?: number; increaseTitle?: boolean }): Promise<SessionId> {
    this.calls.push({ method: 'fork', args: [opts] })
    return Promise.resolve(opts.sessionId)
  }

  /**
   * The session face of a fixture (typed view for assertions; fixture
   * behavior methods are grafted onto it).
   * @param id - session id.
   * @returns the FixtureSession carried by the Controller binding.
   */
  behavior(id: string): FixtureSession {
    return this.require(id).session
  }

  /** Dispose minted scope fibers (runtime dispose path). */
  async disposeScopes(): Promise<void> {
    for (const record of this.records.values()) {
      if (record.scopeFiber !== undefined) {
        await record.scopeFiber.dispose()
        record.scope = undefined
        record.scopeFiber = undefined
        record.binding = undefined
      }
    }
  }

  private bindingOf(id: SessionId, record: SessionRecord): SessionBinding {
    const ctx = this.scope(id)
    /* v8 ignore next 2 -- bindingOf only runs for a live record, whose scope
     * always resolves; kept so a future caller cannot mint a ctx-less binding. */
    if (ctx === undefined) throw new Error(`test session "${id}" resolved no scope`)
    return {
      sessionId: id,
      session: record.session,
      eventSource: record.session.eventSource,
      ctx,
    }
  }

  private require(id: string): SessionRecord {
    const record = this.records.get(id as SessionId)
    if (record === undefined) throw new Error(`test session "${id}" is not added`)
    return record
  }

}
