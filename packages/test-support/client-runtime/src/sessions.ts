/** Test-owned Session Controller faces over declarative fixtures. */
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentIdType } from '@deepseek-ai/dsh-attachment'
import {
  createScope, MutableSessionEventSource, scopeOf, SESSION_SEARCH_RESULT_LIMIT,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  AgentContext, ISessions, ProjectionsFace, SessionBinding, SessionFace, SessionListState,
  SessionEventLikeEntry, SessionLiveEventEntry, SessionSearchResultItem,
  SessionReference, SessionReferenceSource, SessionRetainInfo, SessionRetainOptions,
  SessionSnapshot, SessionSummary, SessionTarget, SubmissionHandle,
} from '@deepseek-ai/dsh-api-session-controller/client'
import { scopeIdentityOf } from '@deepseek-ai/dsh-api-session-controller/src/client/scope.ts'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { sessionSnapshot } from './fixtures.ts'
import type {
  SessionFixture, SessionFixtureSnapshot, Stabilizer,
} from './fixtures.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    testFixture: unknown
    testView: unknown
    testOperation: unknown
  }
}

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

/** Catalog fixture data remains available across live Client generations. */
interface SessionRecord {
  summary: SessionSummary
  snapshot: SnapshotStore<SessionFixtureSnapshot>
  session: FixtureSession
  overrides: Record<string, unknown>
  projections: Map<string, unknown>
  initialOpen: SessionFixture['initialOpen']
}

interface SessionGeneration {
  readonly binding: SessionBinding
  readonly snapshot: SnapshotStore<SessionFixtureSnapshot>
  readonly session: FixtureSession
  readonly fiber: { dispose(): Promise<void> }
  readonly lifetime: AbortController
  readonly opening: Promise<void>
  retention: SessionRetainInfo
  live: boolean
}

interface OpeningControl {
  readonly promise: Promise<void>
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
}

function freezeRetainedBy(
  counts: Partial<Record<SessionReferenceSource, number>>,
): SessionRetainInfo['retainedBy'] {
  Object.setPrototypeOf(counts, null)
  return Object.freeze(counts)
}

const EMPTY_RETAIN_INFO: SessionRetainInfo = Object.freeze({
  referenceCount: 0,
  retainedBy: freezeRetainedBy({}),
})

// TestSessions implements SessionReference against its fixture-owned
// SessionGeneration without importing the production service's private record.
/* jscpd:ignore-start -- The fixture intentionally mirrors production SessionReference settlement and release semantics. */
async function waitForOpen(opening: Promise<void>, signal?: AbortSignal): Promise<void> {
  /* v8 ignore next -- TestSessionReference always supplies its release-composed signal. */
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

class TestSessionReference implements SessionReference {
  private readonly released = new AbortController()
  private readonly readiness = Promise.withResolvers<SessionBinding>()
  readonly ready = this.readiness.promise

  constructor(
    readonly sessionId: SessionId,
    private generation: SessionGeneration | undefined,
    private releaseReference: (() => void) | undefined,
  ) {
    void this.ready.catch(() => {})
  }

  get binding(): SessionBinding {
    if (this.generation === undefined || !this.generation.live) {
      throw new Error(`Session reference "${this.sessionId}" is released`)
    }
    return this.generation.binding
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
    this.generation = undefined
    this.releaseReference = undefined
    release?.()
  }

  [Symbol.dispose](): void {
    this.release()
  }
}
/* jscpd:ignore-end */

/**
 * Sessions test double behind the renderer host and feature injects: owns the
 * catalog observable, scope minting through the production `createScope`,
 * stable Controller bindings, and the session behavior face supplied per
 * fixture. `ui-session` owns standard-source materialization.
 *
 * Implements the same ISessions face features receive as `ctx.sessions`, so
 * a production face change breaks this double at compile time; the extra
 * members (add/updateSessionSnapshot/event-window drivers/remove/
 * behavior/calls/stubs) are bench-only surface.
 */
export class TestSessions implements ISessions {
  /** The useSessions catalog feed, independent of view ownership. */
  readonly list: SnapshotStore<SessionListState>
  private readonly records = new Map<SessionId, SessionRecord>()
  private readonly generations = new Map<SessionId, SessionGeneration>()
  private readonly addresses = new Map<SessionId, SubagentAddress>()
  private readonly retentionStores = new Map<SessionId, SnapshotStore<SessionRetainInfo>>()
  private readonly pendingDrops = new Set<Promise<void>>()
  private closed = false

  /** Calls observed on the service-level face, newest last. */
  readonly calls: {
    method: 'create' | 'refreshProjections' | 'refresh' | 'search' | 'fork'
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
      ids: [], byId: {}, phase: 'ready', projectionsBySession: {},
    })
    rootCtx.effect(() => async () => {
      this.closed = true
      for (const [id, generation] of this.generations) {
        generation.live = false
        generation.retention = EMPTY_RETAIN_INFO
        generation.lifetime.abort(new Error('test Session Controller is disposed'))
        this.publishRetention(id)
      }
      this.generations.clear()
      await this.drainDrops()
    }, 'test sessions: Client generations')
  }

  /**
   * Add a Session fixture to the catalog without retaining a generation.
   * @param fixture - identity + snapshot/summary overrides + behavior face.
   * @returns the stable session id (branded view of `fixture.id`).
   */
  async add(fixture: SessionFixture): Promise<SessionId> {
    const id = fixture.id as SessionId
    if (this.records.has(id)) throw new Error(`test session "${id}" already added`)
    const summary: SessionSummary = {
      id,
      displayTitle: fixture.id,
      running: false,
      blank: false,
      updatedAt: this.records.size + 1,
      ...fixture.summary,
      retainedBy: this.retentionSnapshot(id).retainedBy,
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
      overrides: fixture.session ?? {},
      projections: new Map(),
      initialOpen: fixture.initialOpen,
    })
    await this.stabilize(() => {
      this.list.update((draft) => {
        draft.ids.push(id)
        draft.byId[id] = summary
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
    await this.stabilize(() => {
      record.snapshot.update(mutate)
      this.generations.get(id as SessionId)?.snapshot.set(record.snapshot.getSnapshot())
    })
  }

  /**
   * Publish one complete projection value through the fixture Session face.
   * @param id - session id.
   * @param key - registered projection key.
   * @param value - complete value for that key.
   */
  async setProjection(id: string, key: string, value: unknown): Promise<void> {
    const record = this.require(id)
    record.projections.set(key, value)
    await this.stabilize(() => {
      record.session.projections.set(key, value)
      this.generations.get(id as SessionId)?.session.projections.set(key, value)
    })
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
    await this.stabilize(() => {
      this.require(id).session.eventSource.replace(entries, hasMore)
      this.generations.get(id as SessionId)?.session.eventSource.replace(entries, hasMore)
    })
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
    await this.stabilize(() => {
      this.require(id).session.eventSource.prepend(entries, hasMore)
      this.generations.get(id as SessionId)?.session.eventSource.prepend(entries, hasMore)
    })
  }

  /**
   * Append one live event to a Session's contiguous window.
   * @param id - Session identity.
   * @param entry - live event entry.
   */
  async appendEvent(id: string, entry: SessionLiveEventEntry): Promise<void> {
    await this.stabilize(() => {
      this.require(id).session.eventSource.append(entry)
      this.generations.get(id as SessionId)?.session.eventSource.append(entry)
    })
  }

  /**
   * Update a session's list row (the wire-echo stand-in: title settles,
   * running flips — components subscribed via useSessions re-render).
   * @param id - session id.
   * @param patch - summary fields to merge over the row.
   */
  async updateSummary(id: string, patch: Partial<Omit<SessionSummary, 'id'>>): Promise<void> {
    const record = this.require(id)
    record.summary = {
      ...record.summary,
      ...patch,
      retainedBy: this.retentionSnapshot(id as SessionId).retainedBy,
    }
    await this.stabilize(() => {
      this.list.update((draft) => { draft.byId[id as SessionId] = record.summary })
    })
  }

  /**
   * Remove a catalog row and mark its retained Session removed without releasing owners.
   * @param id - session id.
   */
  async remove(id: string): Promise<void> {
    this.require(id)
    this.records.delete(id as SessionId)
    await this.stabilize(() => {
      this.list.update((draft) => {
        draft.ids = draft.ids.filter(existing => existing !== id)
        const { [id as SessionId]: _dead, ...rest } = draft.byId
        draft.byId = rest
      })
      this.generations.get(id as SessionId)?.snapshot.update((draft) => { draft.removed = true })
    })
  }

  /**
   * Borrow the already-retained session-scoped Cordis context.
   * @param id - session id.
   * @returns the scoped context, or undefined without a live reference.
   */
  scope(id: string): AgentContext | undefined {
    return this.generations.get(id as SessionId)?.binding.ctx
  }

  /**
   * Session assembly binding (inject factories and provide resolvers receive it).
   * @param id - session id.
   * @returns the live generation's binding, or undefined without a reference.
   */
  binding(id: string): SessionBinding | undefined {
    return this.generations.get(id as SessionId)?.binding
  }

  /* jscpd:ignore-start -- The fixture intentionally mirrors production SessionReference acquisition and release semantics. */
  retain(
    target: SessionTarget,
    options: SessionRetainOptions = { source: 'testFixture' },
  ): SessionReference {
    const { source, signal } = options
    signal?.throwIfAborted()
    if (this.closed) throw new Error('test Session Controller is disposed')
    const id = this.resolveTarget(target)
    const generation = this.generations.get(id) ?? this.materialize(id, this.require(id))
    const reference = this.retainGeneration(id, generation, source)
    try {
      reference.attachOpening(generation.opening, signal)
      return reference
    } catch (error: unknown) {
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
  /* jscpd:ignore-end */

  retainInfo(id: SessionId): ObservableSnapshot<SessionRetainInfo> {
    let store = this.retentionStores.get(id)
    if (store === undefined) {
      store = createSnapshotStore(this.retentionSnapshot(id))
      this.retentionStores.set(id, store)
    }
    return store
  }

  /**
   * Retain one fixture Session until the supplied Cordis owner stops.
   * @param ownerCtx - context whose disposal releases the reference.
   * @param target - fixture Session identity or subagent address.
   * @param options - reference source and optional readiness cancellation.
   * @returns the owned reference immediately.
   */
  retainFor(
    ownerCtx: Context,
    target: SessionTarget,
    options: SessionRetainOptions = { source: 'testFixture' },
  ): SessionReference {
    const reference = this.retain(target, options)
    try {
      ownerCtx.effect(() => () => { reference.release() }, 'test sessions: owned reference')
      return reference
    } catch (error: unknown) {
      reference.release()
      throw error
    }
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
    const generation = this.generations.get(id)
    return generation !== undefined
      && scopeIdentityOf(generation.binding.ctx) === scopeIdentityOf(ctx)
      ? generation.session
      : undefined
  }

  /**
   * Install Session creation behavior for navigation tests.
   * @param impl - implementation that must return an already-added fixture id.
   */
  stubCreate(impl: (opts: Parameters<ISessions['create']>[0]) => Promise<SessionId>): void {
    this.createStub = impl
  }

  /** Create through the installed test behavior and require a catalogued fixture. */
  async create(opts?: Parameters<ISessions['create']>[0]): Promise<SessionId> {
    this.calls.push({ method: 'create', args: [opts] })
    if (this.createStub === undefined) {
      throw new Error('test sessions: create is not stubbed — call stubCreate() first')
    }
    const id = await this.createStub(opts)
    this.require(id)
    return id
  }

  /** Resolve a retained or catalog-derived address independently of a view. */
  subagentAddress(id: SessionId): SubagentAddress | undefined {
    const retained = this.addresses.get(id)
    if (retained !== undefined) return retained
    for (const [parentSessionId, projections] of Object.entries(this.list.getSnapshot().projectionsBySession)) {
      const child = projections.values.subagentCatalog?.find(entry => entry.id === id)
      if (child !== undefined) {
        return { parentSessionId: parentSessionId as SessionId, childSessionId: id, mode: child.mode }
      }
    }
    return undefined
  }

  /** Record a projection refresh; fixture callers drive snapshots explicitly. */
  refreshProjections(sessionId: SessionId): Promise<void> {
    this.calls.push({ method: 'refreshProjections', args: [sessionId] })
    return Promise.resolve()
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
    return this.generations.get(id as SessionId)?.session ?? this.require(id).session
  }

  /** Dispose minted scope fibers (runtime dispose path). */
  async disposeScopes(): Promise<void> {
    this.closed = true
    for (const [id, generation] of this.generations) this.drop(id, generation)
    await this.drainDrops()
  }

  private resolveTarget(target: SessionTarget): SessionId {
    const id = typeof target === 'string' ? target : target.childSessionId
    if (typeof target !== 'string') {
      this.addresses.set(id, target)
    }
    this.require(id)
    return id
  }

  private retainGeneration(
    id: SessionId,
    generation: SessionGeneration,
    source: SessionReferenceSource,
  ): TestSessionReference {
    const previous = generation.retention
    generation.retention = Object.freeze({
      referenceCount: previous.referenceCount + 1,
      retainedBy: freezeRetainedBy({
        ...previous.retainedBy,
        [source]: (previous.retainedBy[source] ?? 0) + 1,
      }),
    })
    const reference = new TestSessionReference(id, generation, () => {
      if (!generation.live) return
      const count = generation.retention.referenceCount - 1
      const { [source]: sourceCount = 0, ...otherSources } = generation.retention.retainedBy
      const retainedBy = sourceCount > 1
        ? { ...otherSources, [source]: sourceCount - 1 }
        : otherSources
      generation.retention = count === 0
        ? EMPTY_RETAIN_INFO
        : Object.freeze({ referenceCount: count, retainedBy: freezeRetainedBy(retainedBy) })
      if (count === 0) this.drop(id, generation)
      else this.publishRetention(id)
    })
    this.publishRetention(id)
    return reference
  }

  private retentionSnapshot(id: SessionId): SessionRetainInfo {
    return this.generations.get(id)?.retention ?? EMPTY_RETAIN_INFO
  }

  private publishRetention(id: SessionId): void {
    const retention = this.retentionSnapshot(id)
    const store = this.retentionStores.get(id)
    if (store !== undefined && store.getSnapshot() !== retention) store.set(retention)
    const state = this.list.getSnapshot()
    const row = state.byId[id]
    if (row === undefined || row.retainedBy === retention.retainedBy) return
    const summary = { ...row, retainedBy: retention.retainedBy }
    const record = this.records.get(id)
    /* v8 ignore next -- a catalog row and its fixture record are inserted and removed together. */
    if (record !== undefined) record.summary = summary
    this.list.set({ ...state, byId: { ...state.byId, [id]: summary } })
  }

  private materialize(id: SessionId, fixture: SessionRecord): SessionGeneration {
    const { ctx, fiber } = createScope(this.rootCtx, id)
    const snapshot = createSnapshotStore(fixture.snapshot.getSnapshot())
    const session = new FixtureSession(id, snapshot, fixture.overrides)
    const window = fixture.session.eventSource.getSnapshot()
    session.eventSource.replace(window.entries, window.hasMore)
    for (const [key, value] of fixture.projections) session.projections.set(key, value)
    const opening = Promise.withResolvers<void>()
    void opening.promise.catch(() => {})
    const lifetime = new AbortController()
    const generation: SessionGeneration = {
      binding: { sessionId: id, session, eventSource: session.eventSource, ctx },
      snapshot,
      session,
      fiber,
      lifetime,
      opening: opening.promise,
      retention: EMPTY_RETAIN_INFO,
      live: true,
    }
    this.generations.set(id, generation)
    ctx.effect(() => async () => {
      if (generation.live) {
        generation.live = false
        generation.retention = EMPTY_RETAIN_INFO
        if (this.generations.get(id) === generation) this.generations.delete(id)
        this.publishRetention(id)
      }
      lifetime.abort(new Error(`test Session generation "${id}" is disposed`))
      await Promise.allSettled([generation.opening])
    }, 'test sessions: exact generation')
    this.startOpening(fixture.initialOpen, lifetime.signal, opening)
    return generation
  }

  private startOpening(
    initialOpen: SessionFixture['initialOpen'],
    signal: AbortSignal,
    opening: OpeningControl,
  ): void {
    try {
      Promise.resolve(initialOpen?.(signal)).then(opening.resolve, opening.reject)
    } catch (error: unknown) {
      opening.reject(error)
    }
  }

  private drop(id: SessionId, generation: SessionGeneration): void {
    /* v8 ignore next -- only the live generation's retained callback can enter drop. */
    if (!generation.live) return
    generation.live = false
    generation.retention = EMPTY_RETAIN_INFO
    /* v8 ignore next -- this synchronous path drops only the generation currently stored for id. */
    if (this.generations.get(id) === generation) this.generations.delete(id)
    generation.lifetime.abort(new Error(`test Session generation "${id}" is released`))
    this.publishRetention(id)
    const disposal = generation.fiber.dispose()
    this.pendingDrops.add(disposal)
    void disposal.then(
      () => { this.pendingDrops.delete(disposal) },
      (error: unknown) => {
        this.pendingDrops.delete(disposal)
        this.rootCtx.logger.warn('test Session scope disposal failed:', error)
      },
    )
  }

  private async drainDrops(): Promise<void> {
    while (this.pendingDrops.size !== 0) await Promise.all([...this.pendingDrops])
  }

  private require(id: string): SessionRecord {
    const record = this.records.get(id as SessionId)
    if (record === undefined) throw new Error(`test session "${id}" is not added`)
    return record
  }

}
