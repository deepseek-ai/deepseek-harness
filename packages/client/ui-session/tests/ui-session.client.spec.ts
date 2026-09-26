import { Context } from '@deepseek-ai/cordis'
import type {
  AgentContext,
  ISessions,
  SessionBinding,
  SessionListState,
  SessionReference,
  SessionRetainInfo,
  SessionSnapshot,
} from '@deepseek-ai/dsh-api-session-controller/client'
import { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable, RootStandardSourceContribution } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply,
  type SessionPendingInteractionBase,
  UiSession,
} from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

interface SessionsBench {
  readonly sessions: ISessions
  readonly list: ReturnType<typeof createSnapshotStore<SessionListState>>
  readonly resolveBinding: ReturnType<typeof vi.fn<(id: SessionId) => SessionBinding | undefined>>
  readonly createSession: ReturnType<typeof vi.fn<ISessions['create']>>
  readonly retainInfo: ReturnType<typeof vi.fn<ISessions['retainInfo']>>
  binding(id: SessionId): SessionBinding
  reference(binding: SessionBinding): SessionReference
  setMainView(id: SessionId, count: number): void
  setRetainInfo(id: SessionId, count: number): void
  emitStatus(id: SessionId, running: boolean): void
  release(id: SessionId): Promise<void>
}

const sessionId = (value: string): SessionId => value as SessionId

const roots: Context[] = []

function createSessionsBench(ctx: Context): SessionsBench {
  roots.push(ctx)
  let statusListener: ((id: SessionId, running: boolean) => void) | undefined
  ctx.provide('remote', {
    $on: (_event: string, listener: (id: SessionId, running: boolean) => void) => {
      statusListener = listener
      return () => {
        if (statusListener === listener) statusListener = undefined
      }
    },
  } as never)
  const list = createSnapshotStore<SessionListState>({
    ids: [],
    byId: {},
    phase: 'ready',
    projectionsBySession: {},
  })
  const bindings = new Map<SessionId, SessionBinding>()
  const scopes = new Map<SessionId, Context>()
  const retention = new Map<SessionId, ReturnType<typeof createSnapshotStore<SessionRetainInfo>>>()
  const retainSource = (id: SessionId): ReturnType<typeof createSnapshotStore<SessionRetainInfo>> => {
    let source = retention.get(id)
    if (source === undefined) {
      source = createSnapshotStore<SessionRetainInfo>({ referenceCount: 0, retainedBy: {} })
      retention.set(id, source)
    }
    return source
  }
  const resolveBinding = vi.fn((id: SessionId) => bindings.get(id))
  const createSession = vi.fn<ISessions['create']>(async options =>
    options?.sessionId ?? sessionId(`created-${String(options?.workspaceId ?? 'none')}`))
  const retainInfo = vi.fn<ISessions['retainInfo']>(id => retainSource(id))
  const sessions = {
    list,
    create: createSession,
    binding: resolveBinding,
    retainInfo,
  } as unknown as ISessions

  return {
    sessions,
    list,
    resolveBinding,
    createSession,
    retainInfo,
    binding(id) {
      const scopeCtx = new Context()
      ctx.effect(() => () => scopeCtx.fiber.dispose())
      const snapshot = createSnapshotStore<SessionSnapshot>({
        sessionId: id,
        pendingSubmissions: [],
        running: false,
        subagent: null,
        removed: false,
        openState: 'open',
        openError: null,
        hasMore: false,
        loadingOlder: false,
        promptError: null,
        blank: false,
        lastAgentError: null,
        promptAttempted: false,
        awaitingFirstTurn: false,
      })
      const projections = new Map<string, HostObservable<unknown>>()
      const session = {
        sessionId: id,
        projections: {
          faceOf(key: string) {
            let source = projections.get(key)
            if (source === undefined) {
              source = createSnapshotStore<unknown>(undefined)
              projections.set(key, source)
            }
            return source
          },
        },
        getSnapshot: () => snapshot.getSnapshot(),
        subscribe: (listener: () => void) => snapshot.subscribe(listener),
      } as unknown as SessionBinding['session']
      const binding: SessionBinding = {
        sessionId: id,
        session,
        eventSource: new MutableSessionEventSource(),
        ctx: scopeCtx as AgentContext,
      }
      bindings.set(id, binding)
      scopes.set(id, scopeCtx)
      list.update((draft) => {
        if (!draft.ids.includes(id)) draft.ids.push(id)
        draft.byId[id] = {
          id,
          displayTitle: id,
          running: false,
          retainedBy: {},
          blank: false,
          updatedAt: 1,
        }
      })
      return binding
    },
    reference(binding) {
      let released = false
      const release = vi.fn(() => { released = true })
      return {
        sessionId: binding.sessionId,
        ready: Promise.resolve(binding),
        get binding() {
          if (released || bindings.get(binding.sessionId) !== binding) throw new Error('Session reference is released')
          return binding
        },
        release,
        [Symbol.dispose]: release,
      }
    },
    setMainView(id, count) {
      this.setRetainInfo(id, count)
      list.update((draft) => {
        const row = draft.byId[id]
        if (row === undefined) throw new Error(`unknown test Session ${id}`)
        draft.byId[id] = {
          ...row,
          retainedBy: count === 0 ? {} : { mainView: count },
        }
      })
    },
    setRetainInfo(id, count) {
      retainSource(id).set({
        referenceCount: count,
        retainedBy: count === 0 ? {} : { mainView: count },
      })
    },
    emitStatus(id, running) {
      if (statusListener === undefined) throw new Error('api-session/status is not subscribed')
      statusListener(id, running)
    },
    async release(id) {
      bindings.delete(id)
      const scopeCtx = scopes.get(id)
      scopes.delete(id)
      await scopeCtx?.fiber.dispose()
    },
  }
}

function createUiSession(ctx: Context, bench: SessionsBench): UiSession {
  ctx.provide('slots', { bindStoreScope: vi.fn() } as never)
  return new UiSession(ctx, bench.sessions)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
})

describe('UiSession bindings', () => {
  it('tracks the main-view source and moves its retention watcher between Sessions', () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const first = bench.reference(bench.binding(sessionId('s1')))
    const second = bench.reference(bench.binding(sessionId('s2')))
    const service = createUiSession(ctx, bench)
    const firstSource = service.bindingSource(first)
    const secondSource = service.bindingSource(second)
    const current = service.adapter.current
    const changed = vi.fn()
    current.subscribe(changed)

    expect(current.getSnapshot().key).toBeUndefined()
    bench.setMainView(first.sessionId, 1)
    expect(current.getSnapshot()).toBe(firstSource.getSnapshot())
    const missing = sessionId('missing')
    bench.list.update((draft) => { draft.byId[missing] = undefined as never })
    expect(current.getSnapshot()).toBe(firstSource.getSnapshot())
    bench.list.update((draft) => { Reflect.deleteProperty(draft.byId, missing) })

    bench.retainInfo.mockClear()
    bench.setRetainInfo(first.sessionId, 2)
    expect(bench.retainInfo).toHaveBeenCalledOnce()
    expect(current.getSnapshot()).toBe(firstSource.getSnapshot())

    bench.setRetainInfo(second.sessionId, 1)
    bench.list.update((draft) => {
      draft.byId[first.sessionId] = { ...draft.byId[first.sessionId]!, retainedBy: {} }
      draft.byId[second.sessionId] = {
        ...draft.byId[second.sessionId]!,
        retainedBy: { mainView: 1 },
      }
    })
    bench.setRetainInfo(first.sessionId, 0)
    expect(current.getSnapshot()).toBe(secondSource.getSnapshot())

    bench.retainInfo.mockClear()
    bench.setRetainInfo(first.sessionId, 1)
    expect(bench.retainInfo).not.toHaveBeenCalled()
    bench.list.update((draft) => {
      draft.byId[second.sessionId] = { ...draft.byId[second.sessionId]!, retainedBy: {} }
    })
    bench.setRetainInfo(second.sessionId, 0)
    expect(current.getSnapshot().key).toBeUndefined()

    bench.retainInfo.mockClear()
    bench.setRetainInfo(second.sessionId, 1)
    expect(bench.retainInfo).not.toHaveBeenCalled()
    expect(changed).toHaveBeenCalledTimes(3)
  })

  it('shares one stable source between references to the same generation', () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const bindStoreScope = vi.fn()
    ctx.provide('slots', { bindStoreScope } as never)
    const service = new UiSession(ctx, bench.sessions)
    const binding = bench.binding(sessionId('s1'))
    const firstRef = bench.reference(binding)
    const secondRef = bench.reference(binding)
    const source = service.bindingSource(firstRef)
    const value = source.getSnapshot()

    expect(service.bindingSource(secondRef)).toBe(source)
    expect(service.adapter.bindingSource(firstRef)).toBe(source)
    expect(source.getSnapshot()).toBe(value)
    expect(value.key).toBe(binding.sessionId)
    expect(value.hooks.session).toBe(binding.session)
    expect(value.props.sessionId).toBe(binding.sessionId)
    expect(value.keyedHooks.projection?.('status')).toBe(binding.session.projections.faceOf('status'))
    expect(bindStoreScope).toHaveBeenCalledOnce()
    expect(bindStoreScope).toHaveBeenCalledWith(value)
    firstRef.release()
    expect(service.bindingSource(secondRef)).toBe(source)
  })

  it('keeps explicit absence stable and independent from catalog changes', () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    const absent = service.bindingSource(undefined)
    const changed = vi.fn()
    absent.subscribe(changed)
    bench.binding(sessionId('s1'))

    expect(service.adapter.bindingSource(undefined)).toBe(absent)
    expect(absent.getSnapshot()).toEqual({
      key: undefined,
      hooks: { session: undefined },
      keyedHooks: { projection: undefined },
      props: { sessionId: undefined },
    })
    expect(changed).not.toHaveBeenCalled()
    expect(bench.resolveBinding).not.toHaveBeenCalled()
  })

  it('rejects foreign and released references before resolving UI sources', () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    const binding = bench.binding(sessionId('s1'))
    const reference = bench.reference(binding)
    const foreign = createSessionsBench(new Context())
    const foreignRef = foreign.reference(foreign.binding(binding.sessionId))

    expect(() => service.bindingSource(foreignRef)).toThrow('not active in this Controller')
    reference.release()
    expect(() => service.bindingSource(reference)).toThrow('released')
  })

  it('publishes disposal only to the ended generation and rejects its reference', async () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    const firstRef = bench.reference(bench.binding(sessionId('s1')))
    const secondRef = bench.reference(bench.binding(sessionId('s2')))
    const first = service.bindingSource(firstRef)
    const second = service.bindingSource(secondRef)
    const firstChanged = vi.fn()
    const secondChanged = vi.fn()
    first.subscribe(firstChanged)
    second.subscribe(secondChanged)
    const secondSnapshot = second.getSnapshot()

    await bench.release(firstRef.sessionId)

    expect(first.getSnapshot()).toBe(service.bindingSource(undefined).getSnapshot())
    expect(firstChanged).toHaveBeenCalledOnce()
    expect(second.getSnapshot()).toBe(secondSnapshot)
    expect(secondChanged).not.toHaveBeenCalled()
    expect(() => service.bindingSource(firstRef)).toThrow('released')
  })

  it('does not let old Context cleanup remove a same-id replacement source', async () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    const oldBinding = bench.binding(sessionId('same'))
    const oldSource = service.bindingSource(bench.reference(oldBinding))
    const replacement = bench.reference(bench.binding(oldBinding.sessionId))
    const nextSource = service.bindingSource(replacement)
    const nextSnapshot = nextSource.getSnapshot()
    const changed = vi.fn()
    nextSource.subscribe(changed)

    expect(nextSource).not.toBe(oldSource)
    expect(oldSource.getSnapshot().key).toBe(oldBinding.sessionId)
    await oldBinding.ctx.fiber.dispose()
    expect(oldSource.getSnapshot().key).toBeUndefined()
    expect(service.bindingSource(replacement)).toBe(nextSource)
    expect(nextSource.getSnapshot()).toBe(nextSnapshot)
    expect(changed).not.toHaveBeenCalled()
  })


  it('contains a failing binding subscriber and continues dispatch', () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    const source = service.bindingSource(bench.reference(bench.binding(sessionId('s1'))))
    const failure = new Error('subscriber failed')
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const off = source.subscribe(() => { throw failure })
    const after = vi.fn()
    source.subscribe(after)

    service.provide({ props: ['extra'], resolve: () => ({ props: { extra: true } }) })

    expect(after).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith('[ui-session] Session binding subscriber failed:', failure)
    off()
  })

  it('releases cached sources without rematerializing while the Controller binding stays live', async () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const binding = bench.binding(sessionId('s1'))
    const reference = bench.reference(binding)
    bench.setMainView(binding.sessionId, 1)
    const bindStoreScope = vi.fn()
    ctx.provide('slots', { bindStoreScope } as never)
    let service: UiSession | undefined
    const fiber = ctx.plugin({
      apply(scope: Context) { service = new UiSession(scope, bench.sessions) },
    })
    await fiber.await()
    if (service === undefined) throw new Error('UiSession did not start')
    const source = service.bindingSource(reference)
    expect(service.adapter.current.getSnapshot().key).toBe(binding.sessionId)
    expect(bindStoreScope).toHaveBeenCalledOnce()

    await fiber.dispose()

    expect(source.getSnapshot().key).toBeUndefined()
    expect(service.bindingSource(reference).getSnapshot().key).toBeUndefined()
    expect(bindStoreScope).toHaveBeenCalledOnce()
    expect(binding.ctx.fiber.uid).not.toBeNull()
  })

  it('assembles all descriptor snapshots before notifying independent Session sources', () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    const a = bench.reference(bench.binding(sessionId('a')))
    const b = bench.reference(bench.binding(sessionId('b')))
    const sourceA = service.bindingSource(a)
    const sourceB = service.bindingSource(b)
    const absent = service.bindingSource(undefined)
    expect(sourceA).not.toBe(sourceB)
    const values: unknown[] = []
    sourceA.subscribe(() => { values.push(sourceB.getSnapshot().props.feature) })
    const changedB = vi.fn()
    sourceB.subscribe(changedB)
    const custom = createSnapshotStore(1)
    const keyed = (key: string): HostObservable<unknown> => createSnapshotStore(key)
    const remove = service.provide({
      hooks: ['custom'], keyedHooks: ['customKeyed'], props: ['feature'],
      resolve: binding => ({
        hooks: { custom }, keyedHooks: { customKeyed: keyed }, props: { feature: binding.sessionId },
      }),
    })
    const removeNeighbor = service.provide({
      props: ['neighbor'], resolve: () => ({ props: { neighbor: 'kept' } }),
    })

    expect(service.bindingSource(a)).toBe(sourceA)
    expect(service.bindingSource(b)).toBe(sourceB)
    expect(sourceA.getSnapshot().props.feature).toBe(a.sessionId)
    expect(sourceB.getSnapshot().props.feature).toBe(b.sessionId)
    expect(sourceA.getSnapshot().hooks.custom).toBe(custom)
    expect(sourceA.getSnapshot().keyedHooks.customKeyed).toBe(keyed)
    expect(absent.getSnapshot().hooks).toHaveProperty('custom', undefined)
    expect(values).toEqual([b.sessionId, b.sessionId])
    remove()
    expect(values.at(-1)).toBeUndefined()
    expect(sourceA.getSnapshot().props).not.toHaveProperty('feature')
    expect(sourceB.getSnapshot().props).not.toHaveProperty('feature')
    expect(sourceA.getSnapshot().props.neighbor).toBe('kept')
    expect(absent.getSnapshot().hooks).not.toHaveProperty('custom')
    remove()
    expect(changedB).toHaveBeenCalledTimes(3)
    removeNeighbor()
    expect(sourceA.getSnapshot().props).not.toHaveProperty('neighbor')
  })

  it.each([
    ['hook', { resolve: () => ({ hooks: { surprise: createSnapshotStore(1) } }) }],
    ['keyed hook', { resolve: () => ({ keyedHooks: { surprise: () => createSnapshotStore(1) } }) }],
    ['prop', { resolve: () => ({ props: { surprise: 1 } }) }],
  ] as const)('rejects an undeclared %s returned by a contribution', (kind, descriptor) => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    service.bindingSource(bench.reference(bench.binding(sessionId('s1'))))
    expect(() => service.provide(descriptor as never)).toThrow(`uiSession.provide: undeclared ${kind} 'surprise'`)
  })

  it.each([
    ['hook', { hooks: ['missing'], resolve: () => ({}) }],
    ['keyed hook', { keyedHooks: ['missing'], resolve: () => ({}) }],
    ['prop', { props: ['missing'], resolve: () => ({}) }],
  ] as const)('rejects a missing declared %s', (kind, descriptor) => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    service.bindingSource(bench.reference(bench.binding(sessionId('s1'))))
    expect(() => service.provide(descriptor)).toThrow(`uiSession.provide: missing ${kind} 'missing'`)
  })

  it.each([
    ['hook', { hooks: ['session'], resolve: () => ({ hooks: { session: createSnapshotStore(1) } }) }],
    ['keyed hook', { keyedHooks: ['projection'], resolve: () => ({ keyedHooks: { projection: () => createSnapshotStore(1) } }) }],
    ['prop', { props: ['sessionId'], resolve: () => ({ props: { sessionId: 'other' } }) }],
  ] as const)('rejects a duplicate declared %s', (kind, descriptor) => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    expect(() => service.provide(descriptor)).toThrow(`uiSession.provide: duplicate ${kind}`)
  })

  it('rejects cross-compartment collisions at the final standard prop name', () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    const source = createSnapshotStore(1)
    service.provide({ hooks: ['feature'], resolve: () => ({ hooks: { feature: source } }) })
    const absent = service.bindingSource(undefined)
    const before = absent.getSnapshot()

    expect(() => service.provide({
      keyedHooks: ['feature'], resolve: () => ({ keyedHooks: { feature: () => source } }),
    })).toThrow("uiSession.provide: duplicate keyed hook 'feature' at prop 'useFeature'")
    expect(() => service.provide({
      props: ['useFeature'], resolve: () => ({ props: { useFeature: true } }),
    })).toThrow("uiSession.provide: duplicate prop 'useFeature' at prop 'useFeature'")
    expect(absent.getSnapshot()).toBe(before)
  })

  it('keeps every source unchanged when a later Session contribution fails', () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    const first = service.bindingSource(bench.reference(bench.binding(sessionId('s1'))))
    const second = service.bindingSource(bench.reference(bench.binding(sessionId('s2'))))
    const beforeFirst = first.getSnapshot()
    const beforeSecond = second.getSnapshot()
    const changed = vi.fn()
    first.subscribe(changed)
    second.subscribe(changed)
    let calls = 0

    expect(() => service.provide({
      props: ['partial'],
      resolve: () => {
        calls += 1
        if (calls === 2) throw new Error('second binding failed')
        return { props: { partial: true } }
      },
    })).toThrow('second binding failed')
    expect(calls).toBe(2)
    expect(first.getSnapshot()).toBe(beforeFirst)
    expect(second.getSnapshot()).toBe(beforeSecond)
    expect(changed).not.toHaveBeenCalled()
  })
})

describe('UiSession status', () => {
  it('keeps synthetic-row status unknown until an event or Host baseline establishes it', () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const id = sessionId('catalog-only')
    bench.list.update((draft) => {
      draft.byId[id] = { id, displayTitle: id, running: false, retainedBy: {}, blank: false, updatedAt: 0 }
    })
    const service = createUiSession(ctx, bench)
    expect(service.sessionStatus.getSnapshot().get(id)?.running).toBeUndefined()
    expect(service.sessionStatus.getSnapshot().get(id)?.completionUnread).toBe(false)

    bench.emitStatus(id, true)
    bench.list.update((draft) => { draft.byId[id]!.displayTitle = 'Renamed child' })
    expect(service.sessionStatus.getSnapshot().get(id)?.running).toBe(true)
    expect(service.sessionStatus.getSnapshot().get(id)?.completionUnread).toBe(false)

    bench.list.update((draft) => { draft.ids.push(id) })
    expect(service.sessionStatus.getSnapshot().get(id)?.running).toBe(false)
    expect(service.sessionStatus.getSnapshot().get(id)?.completionUnread).toBe(true)
  })

  it('records non-main completions and lets main-view activity acknowledge them', () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const id = sessionId('s1')
    bench.binding(id)
    const service = createUiSession(ctx, bench)
    const changed = vi.fn()
    const off = service.sessionStatus.subscribe(changed)

    expect(service.sessionStatus.getSnapshot().get(id)).toEqual({
      running: false,
      pendingInteraction: undefined,
      completionUnread: false,
    })
    bench.list.update((draft) => { draft.byId[id]!.running = true })
    expect(service.sessionStatus.getSnapshot().get(id)?.running).toBe(true)
    bench.list.update((draft) => { draft.byId[id]!.running = false })
    expect(service.sessionStatus.getSnapshot().get(id)?.completionUnread).toBe(true)
    bench.setMainView(id, 1)
    expect(service.sessionStatus.getSnapshot().get(id)?.completionUnread).toBe(false)
    bench.setMainView(id, 0)

    bench.emitStatus(id, true)
    bench.emitStatus(id, false)
    expect(service.sessionStatus.getSnapshot().get(id)?.completionUnread).toBe(true)

    bench.setMainView(id, 1)
    expect(service.sessionStatus.getSnapshot().get(id)?.completionUnread).toBe(false)
    bench.emitStatus(id, true)
    bench.emitStatus(id, false)
    expect(service.sessionStatus.getSnapshot().get(id)?.completionUnread).toBe(false)

    bench.setMainView(id, 0)
    bench.emitStatus(id, false)
    expect(service.sessionStatus.getSnapshot().get(id)?.completionUnread).toBe(false)
    bench.emitStatus(id, true)
    bench.emitStatus(id, false)
    expect(service.sessionStatus.getSnapshot().get(id)?.completionUnread).toBe(true)
    bench.emitStatus(id, true)
    expect(service.sessionStatus.getSnapshot().get(id)?.completionUnread).toBe(false)
    expect(changed).toHaveBeenCalled()
    off()
  })

  it('records an idle event before the initial catalog baseline and retires absent status later', () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const id = sessionId('early')
    bench.list.update((draft) => { draft.phase = 'pending' })
    const service = createUiSession(ctx, bench)

    bench.emitStatus(id, false)
    expect(service.sessionStatus.getSnapshot().get(id)).toEqual({
      running: false,
      pendingInteraction: undefined,
      completionUnread: true,
    })
    bench.list.update((draft) => { draft.phase = 'ready' })
    expect(service.sessionStatus.getSnapshot().has(id)).toBe(false)
  })
})

describe('UiSession pending interactions', () => {
  it('publishes the highest-precedence exact object and removes each source independently', async () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    const id = sessionId('s1')
    const listener = vi.fn()
    const off = service.sessionStatus.subscribe(listener)
    const registerApproval = service.registerPendingInteraction<SessionPendingInteractionBase>(
      () => 0,
    )
    const registerQuestion = service.registerPendingInteraction<SessionPendingInteractionBase>(
      interaction => interaction.kind === 'plan-review' ? 2 : 1,
    )
    const registerBackground = service.registerPendingInteraction<SessionPendingInteractionBase>(
      () => -1,
    )
    listener.mockClear()

    const approval = { key: 'approval:1', kind: 'approval', sessionId: id }
    const duplicate = { key: 'approval:2', kind: 'approval', sessionId: id }
    const question = { key: 'question:1', kind: 'question', sessionId: id }
    const plan = { key: 'question:2', kind: 'plan-review', sessionId: id }
    const background = { key: 'background:1', kind: 'background', sessionId: id }
    const delegate = (): Promise<void> => Promise.resolve()
    const removeApproval = registerApproval(approval, delegate)
    expect(service.sessionStatus.getSnapshot().get(id)?.pendingInteraction).toBe(approval)
    const removeDuplicate = registerApproval(duplicate, delegate)
    expect(service.sessionStatus.getSnapshot().get(id)?.pendingInteraction).toBe(duplicate)
    const removeQuestion = registerQuestion(question, delegate)
    expect(service.sessionStatus.getSnapshot().get(id)?.pendingInteraction).toBe(question)
    const removePlan = registerQuestion(plan, delegate)
    expect(service.sessionStatus.getSnapshot().get(id)?.pendingInteraction).toBe(plan)
    const removeBackground = registerBackground(background, delegate)
    expect(service.sessionStatus.getSnapshot().get(id)?.pendingInteraction).toBe(plan)

    removeBackground()
    removeQuestion()
    expect(service.sessionStatus.getSnapshot().get(id)?.pendingInteraction).toBe(plan)
    removePlan()
    expect(service.sessionStatus.getSnapshot().get(id)?.pendingInteraction).toBe(duplicate)
    removeDuplicate()
    expect(service.sessionStatus.getSnapshot().get(id)?.pendingInteraction).toBe(approval)
    removeApproval()
    removeApproval()
    expect(service.sessionStatus.getSnapshot().has(id)).toBe(false)
    off()
    await ctx.fiber.dispose()
  })

  it('rejects duplicate keys and contains a failing aggregate subscriber', () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    const registerPendingInteraction = service.registerPendingInteraction<SessionPendingInteractionBase>(
      () => 1,
    )
    const interaction = { key: 'question:1', kind: 'question', sessionId: sessionId('s1') }
    const delegate = () => Promise.resolve()
    const remove = registerPendingInteraction(interaction, delegate)
    expect(() => { registerPendingInteraction(interaction, delegate) })
      .toThrow("ui-session: duplicate pending interaction key 'question:1'")

    const failure = new Error('pending subscriber failed')
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    service.sessionStatus.subscribe(() => { throw failure })
    const after = vi.fn()
    service.sessionStatus.subscribe(after)

    remove()

    expect(after).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith(
      '[ui-session] Session status subscriber failed:',
      failure,
    )
  })

  it('removes active values before awaiting their teardown delegation', async () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    const gate = Promise.withResolvers<undefined>()
    const delegate = vi.fn(() => gate.promise)
    const publish = service.registerPendingInteraction<SessionPendingInteractionBase>(() => 1)
    const remove = publish(
      { key: 'question:1', kind: 'question', sessionId: sessionId('s1') },
      delegate,
    )

    let disposed = false
    const disposal = ctx.fiber.dispose().then(() => { disposed = true })
    await vi.waitFor(() => { expect(delegate).toHaveBeenCalledOnce() })
    expect(service.sessionStatus.getSnapshot()).toEqual(new Map())
    expect(disposed).toBe(false)
    remove()
    remove()

    gate.resolve(undefined)
    await disposal
    expect(disposed).toBe(true)
  })
})

describe('ui-session apply', () => {
  it('provides the root sources and installs the Session scope adapter', () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const slots = {
      provideRoot: vi.fn(),
      installScope: vi.fn(),
    }
    ctx.provide('sessions', bench.sessions)
    ctx.provide('slots', slots as never)

    apply(ctx)

    expect(ctx.uiSession).toBeInstanceOf(UiSession)
    const retainInfoMatcher: unknown = expect.any(Function)
    expect(slots.provideRoot).toHaveBeenCalledWith({
      hooks: {
        sessions: bench.sessions.list,
        sessionStatus: ctx.uiSession.sessionStatus,
      },
      keyedHooks: { sessionRetainInfo: retainInfoMatcher },
    })
    expect(slots.installScope).toHaveBeenCalledWith('session', ctx.uiSession.adapter)
    const root = slots.provideRoot.mock.calls[0]![0] as RootStandardSourceContribution
    expect(root.keyedHooks?.sessionRetainInfo?.(sessionId('s1')))
      .toBe(bench.retainInfo(sessionId('s1')))
  })

  it('keeps the Host loader half inert', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
