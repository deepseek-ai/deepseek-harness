// @vitest-environment jsdom
/**
 * SlotTestRuntime behavior: root declaration + rendering, session
 * add/update/switch/remove through the real renderer, shared store identity
 * and scope pruning, feature mount/dispose cascade, and runtime disposal
 * idempotence. All through the production SlotRegistry + createSlotRenderer
 * stack — this suite is the fixture the migrated feature specs rely on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { stubConfigForm } from '../src/config-form.ts'
import { act, cleanup } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { createSnapshotStore, defineStore } from '@deepseek-ai/dsh-client-store'
import { createScope, type SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  PropsRenderSlots, SessionStandardProps, SlotRendererHost,
} from '@deepseek-ai/dsh-client-ui-slots'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'trt.panel': { kind: 'single'; scope: 'root'; owner: { label?: string } }
    'trt.chat': { kind: 'single'; scope: 'session' }
    'trt.other-chat': { kind: 'single'; scope: 'session' }
    'trt.maybe': { kind: 'single'; scope: 'session-maybe' }
    'trt.rows': { kind: 'list'; scope: 'root' }
    'trt.rows.hole': { kind: 'single'; scope: 'root' }
  }
}

afterEach(cleanup)

type FrameProps = PropsRenderSlots<'trt.panel' | 'trt.chat' | 'trt.rows'> & { reference: SessionReference | undefined }

/** Root frame declaring all three suite slots (render sites for each kind). */
function Frame({ renderSlot, SessionProvider, reference }: FrameProps) {
  return (
    <>
      {renderSlot('trt.panel', { label: 'from-owner' }, { fallback: <i>no panel</i> })}
      <SessionProvider session={reference} empty={() => <i>no session</i>}>
        {renderSlot('trt.chat', {})}
      </SessionProvider>
      {renderSlot('trt.rows', {})}
    </>
  )
}

const CHILDREN = {
  'trt.panel': { kind: 'single', scope: 'root' },
  'trt.chat': { kind: 'single', scope: 'session' },
  'trt.rows': { kind: 'list', scope: 'root' },
} as const

async function runtimeWithFrame(reference = createSnapshotStore<SessionReference | undefined>(undefined)) {
  const runtime = await SlotTestRuntime.create()
  const subscribe = reference.subscribe.bind(reference)
  const getSnapshot = reference.getSnapshot.bind(reference)
  await runtime.root.declare(CHILDREN, (props) => {
    const bound = useSyncExternalStore(subscribe, getSnapshot)
    return <Frame {...props} reference={bound} />
  })
  return runtime
}

describe('root declaration and rendering', () => {
  it('renders declared slots through the real renderer: fallback, then a live registration, then unload', async () => {
    const runtime = await runtimeWithFrame()
    const view = runtime.renderRoot()
    expect(view.container.textContent).toContain('no panel')

    let dispose = (): void => {}
    await runtime.flush() // no-op guard: flush outside mutations is safe
    await (async () => {
      dispose = runtime.slots.register(
        { name: 'trt.panel' },
        ({ label }: { label?: string }) => <b>panel:{label}</b>)
      await runtime.flush()
    })()
    expect(view.container.textContent).toContain('panel:from-owner')
    dispose()
    await runtime.flush()
    expect(view.container.textContent).toContain('no panel')
    await runtime.dispose()
  })

  it('fails loud when rendering with no root declaration (production boot-order check)', async () => {
    const runtime = await SlotTestRuntime.create()
    expect(() => runtime.renderRoot()).toThrow(/'root' has no registration/)
    await runtime.dispose()
  })
})

describe('sessions', () => {
  it('drives SessionProvider with explicit references and live snapshot updates', async () => {
    const reference = createSnapshotStore<SessionReference | undefined>(undefined)
    const runtime = await runtimeWithFrame(reference)
    runtime.slots.register({ name: 'trt.chat' }, (props: SessionStandardProps) => {
      const running = props.useSession(s => s.running)
      return <span>chat:{props.sessionId}:{String(running)}</span>
    })
    const view = runtime.renderRoot()
    expect(view.container.textContent).toContain('no session')

    await runtime.sessions.add({ id: 's1' })
    using first = runtime.sessions.retain('s1' as SessionId)
    await first.ready
    act(() => { reference.set(first) })
    expect(view.container.textContent).toContain('chat:s1:false')

    await runtime.sessions.updateSessionSnapshot('s1', (draft) => { draft.running = true })
    expect(view.container.textContent).toContain('chat:s1:true')

    await runtime.sessions.add({ id: 's2' })
    using second = runtime.sessions.retain('s2' as SessionId)
    await second.ready
    act(() => { reference.set(second) })
    expect(view.container.textContent).toContain('chat:s2:false')

    act(() => { reference.set(undefined) })
    expect(view.container.textContent).toContain('no session')
    act(() => { reference.set(first) })
    expect(view.container.textContent).toContain('chat:s1:true')
    await runtime.dispose()
  })

  it('adds catalog entries without retaining them and rejects unknown mutation targets', async () => {
    const runtime = await runtimeWithFrame()
    await runtime.sessions.add({ id: 's1' })
    await runtime.sessions.add({ id: 's2' })
    expect(runtime.sessions.binding('s1')).toBeUndefined()
    expect(runtime.sessions.binding('s2')).toBeUndefined()
    expect(runtime.sessions.list.getSnapshot().ids).toEqual(['s1', 's2'])
    await expect(runtime.sessions.add({ id: 's1' })).rejects.toThrow(/already added/)
    expect(() => runtime.sessions.retain('ghost' as SessionId)).toThrow(/not added/)
    await expect(runtime.sessions.updateSessionSnapshot('ghost', () => {})).rejects.toThrow(/not added/)
    await expect(runtime.sessions.remove('ghost')).rejects.toThrow(/not added/)
    expect(() => runtime.sessions.behavior('ghost')).toThrow(/not added/)
    await runtime.dispose()
  })

  it('mints REAL-tag scopes lazily and resolves them through the production scopeOf; bindings expose the behavior face', async () => {
    const runtime = await runtimeWithFrame()
    const prompt = vi.fn()
    await runtime.sessions.add({ id: 's1', session: { prompt } })
    using reference = runtime.sessions.retain('s1' as SessionId)
    await reference.ready
    expect(reference.binding.sessionId).toBe('s1')

    expect(runtime.sessions.scope('ghost')).toBeUndefined()
    expect(runtime.sessions.binding('ghost')).toBeUndefined()

    const scope = runtime.sessions.scope('s1')!
    expect(runtime.sessions.scope('s1')).toBe(scope) // stable per session
    expect(runtime.sessions.scopeOf(scope)).toBe('s1')
    expect(runtime.sessions.scopeOf(runtime.ctx)).toBeUndefined()
    // sessionOf resolves the behavior face off the scope tag.
    expect(runtime.sessions.sessionOf(scope)).toBe(runtime.sessions.behavior('s1'))
    expect(runtime.sessions.sessionOf(runtime.ctx)).toBeUndefined()
    const foreign = createScope(runtime.ctx, 's1' as SessionId)
    expect(runtime.sessions.sessionOf(foreign.ctx)).toBeUndefined()
    await foreign.fiber.dispose()

    const binding = runtime.sessions.binding('s1')!
    expect(binding.sessionId).toBe('s1')
    expect(binding.ctx).toBe(scope)
    await binding.session.prompt([], 'queue')
    expect(prompt).toHaveBeenCalledOnce()
    expect(runtime.sessions.behavior('s1')).toBe(binding.session)
    expect(binding.session.getSnapshot().sessionId).toBe('s1')

    // A scoped service resolves through the scope ctx (scope-addressed pattern).
    runtime.ctx.provide('probe', { hello: 'world' })
    expect(scope.get('probe')).toEqual({ hello: 'world' })
    await runtime.dispose()
  })

  it('resolves loaded parent projection addresses without retaining a session', async () => {
    const runtime = await runtimeWithFrame()
    try {
      const parent = 'parent' as SessionId
      const child = 'child' as SessionId
      runtime.sessions.list.update((draft) => {
        draft.projectionsBySession = {
          [parent]: { state: 'ready', error: null, values: { subagentCatalog: [{ createdAt: 1, id: child, mode: 'continuable', label: 'worker' }] } },
        }
      })
      expect(runtime.sessions.subagentAddress(child)).toEqual({
        parentSessionId: parent, childSessionId: child, mode: 'continuable',
      })
      expect(runtime.sessions.subagentAddress(parent)).toBeUndefined()
      expect(runtime.sessions.binding(child)).toBeUndefined()
      expect(runtime.sessions.binding(parent)).toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  })

  it('accepts explicit addresses without a catalog and keeps them independent of references', async () => {
    const runtime = await runtimeWithFrame()
    await runtime.sessions.add({ id: 's1' })
    await runtime.sessions.add({ id: 's2' })
    const address = {
      parentSessionId: 's2' as SessionId, childSessionId: 's1' as SessionId, mode: 'continuable' as const,
    }
    using reference = runtime.sessions.retain(address)
    await reference.ready
    expect(reference.sessionId).toBe('s1')
    expect(runtime.sessions.subagentAddress('s1' as SessionId)).toEqual(address)
    expect(runtime.sessions.subagentAddress('s2' as SessionId)).toBeUndefined()
    await runtime.sessions.updateSummary('s1', { displayTitle: 'renamed', running: true })
    expect(runtime.sessions.list.getSnapshot().byId['s1' as SessionId])
      .toMatchObject({ displayTitle: 'renamed', running: true })
    await runtime.sessions.refreshProjections('s2' as SessionId)
    reference.release()
    expect(runtime.sessions.binding('s1')).toBeUndefined()
    expect(runtime.sessions.subagentAddress('s1' as SessionId)).toEqual(address)
    await expect(runtime.sessions.fork({
      sessionId: 's1' as SessionId, atSeq: 7, increaseTitle: true,
    })).resolves.toBe('s1')
    expect(runtime.sessions.calls).toEqual([
      { method: 'refreshProjections', args: ['s2'] },
      { method: 'fork', args: [{ sessionId: 's1', atSeq: 7, increaseTitle: true }] },
    ])
    await runtime.dispose()
  })

  it('resolves catalog addresses without retaining their parent', async () => {
    const runtime = await runtimeWithFrame()
    const parentId = 'parent' as SessionId
    await runtime.sessions.add({ id: 'child' })
    runtime.sessions.list.update((draft) => {
      draft.projectionsBySession = {
        [parentId]: {
          state: 'ready', error: null,
          values: { subagentCatalog: [
            { createdAt: 1, id: 'other' as SessionId, mode: 'one-shot' },
            { createdAt: 2, id: 'child' as SessionId, mode: 'continuable', label: 'Child' },
          ] },
        },
      }
    })

    expect(runtime.sessions.subagentAddress('child' as SessionId)).toEqual({
      parentSessionId: parentId, childSessionId: 'child', mode: 'continuable',
    })
    expect(runtime.sessions.subagentAddress('missing' as SessionId)).toBeUndefined()
    expect(runtime.sessions.binding(parentId)).toBeUndefined()
    expect(runtime.sessions.binding('child')).toBeUndefined()
    await runtime.dispose()
  })

  it('tracks repeated references and releases callback and Context-owned references', async () => {
    const runtime = await runtimeWithFrame()
    const id = await runtime.sessions.add({ id: 'owned' })
    const info = runtime.sessions.retainInfo(id)
    expect(runtime.sessions.retainInfo(id)).toBe(info)
    const first = runtime.sessions.retain(id, { source: 'testOperation' })
    const second = runtime.sessions.retain(id, { source: 'testOperation' })
    const scope = first.binding.ctx
    await Promise.all([first.ready, second.ready])
    expect(info.getSnapshot()).toEqual({ referenceCount: 2, retainedBy: { testOperation: 2 } })
    expect(runtime.sessions.list.getSnapshot().byId[id]?.retainedBy).toEqual({ testOperation: 2 })
    first.release()
    expect(info.getSnapshot()).toEqual({ referenceCount: 1, retainedBy: { testOperation: 1 } })
    second.release()
    await scope.fiber.dispose()
    expect(info.getSnapshot()).toEqual({ referenceCount: 0, retainedBy: {} })

    await expect(runtime.sessions.using(id, { source: 'testOperation' }, reference => reference.sessionId))
      .resolves.toBe(id)
    const failure = new Error('operation failed')
    await expect(runtime.sessions.using(id, { source: 'testOperation' }, () => { throw failure }))
      .rejects.toBe(failure)

    const owner = new Context()
    const owned = runtime.sessions.retainFor(owner, id)
    await owned.ready
    const ownedScope = owned.binding.ctx
    await owner.fiber.dispose()
    await ownedScope.fiber.dispose()
    expect(info.getSnapshot()).toEqual({ referenceCount: 0, retainedBy: {} })
    await runtime.dispose()
  })

  it('releases a retained fixture when its Context owner rejects registration', async () => {
    const runtime = await runtimeWithFrame()
    const id = await runtime.sessions.add({ id: 'owner-failure' })
    const owner = new Context()
    const failure = new Error('owner rejected effect')
    vi.spyOn(owner, 'effect').mockImplementation(() => { throw failure })

    expect(() => runtime.sessions.retainFor(owner, id)).toThrow(failure)
    expect(runtime.sessions.retainInfo(id).getSnapshot()).toEqual({ referenceCount: 0, retainedBy: {} })
    await runtime.dispose()
  })

  it('releases a reference when readiness signal composition rejects it', async () => {
    const runtime = await runtimeWithFrame()
    const id = await runtime.sessions.add({ id: 'bad-signal' })
    const malformed = { throwIfAborted: () => {} } as AbortSignal

    expect(() => runtime.sessions.retain(id, {
      source: 'testOperation', signal: malformed,
    })).toThrow(TypeError)
    expect(runtime.sessions.retainInfo(id).getSnapshot()).toEqual({
      referenceCount: 0, retainedBy: {},
    })
    await runtime.dispose()
  })

  it('mirrors acquisition cancellation and generation disposal races', async () => {
    const runtime = await runtimeWithFrame()
    const blocked = Promise.withResolvers<undefined>()
    const cancelledId = await runtime.sessions.add({
      id: 'cancelled', initialOpen: () => blocked.promise,
    })
    const reason = new Error('cancelled while retaining')
    const controller = new AbortController()
    const info = runtime.sessions.retainInfo(cancelledId)
    const off = info.subscribe(() => {
      if (info.getSnapshot().referenceCount > 0) controller.abort(reason)
    })
    const cancelled = runtime.sessions.retain(cancelledId, {
      source: 'testOperation', signal: controller.signal,
    })
    await expect(cancelled.ready).rejects.toBe(reason)
    cancelled.release()
    blocked.resolve(undefined)
    off()

    const opening = Promise.withResolvers<undefined>()
    const disposedId = await runtime.sessions.add({ id: 'disposed', initialOpen: () => opening.promise })
    const disposed = runtime.sessions.retain(disposedId)
    const binding = disposed.binding
    const scopeDisposal = binding.ctx.fiber.dispose()
    opening.resolve(undefined)
    await scopeDisposal
    await expect(disposed.ready).rejects.toThrow('is released')
    disposed.release()
    await runtime.dispose()
  })

  it('propagates synchronous opening failures and reports scope-disposal failures', async () => {
    const runtime = await runtimeWithFrame()
    const openingFailure = new Error('opening failed')
    const failedId = await runtime.sessions.add({
      id: 'failed-open', initialOpen: () => { throw openingFailure },
    })
    const failed = runtime.sessions.retain(failedId)
    const failedScope = failed.binding.ctx
    await expect(failed.ready).rejects.toBe(openingFailure)
    failed.release()
    await failedScope.fiber.dispose()

    const disposalId = await runtime.sessions.add({ id: 'failed-disposal' })
    const reference = runtime.sessions.retain(disposalId)
    await reference.ready
    const scope = reference.binding.ctx
    const dispose = scope.fiber.dispose.bind(scope.fiber)
    const disposalFailure = new Error('scope disposal failed')
    vi.spyOn(scope.fiber, 'dispose').mockRejectedValueOnce(disposalFailure)
    const warning = vi.spyOn(runtime.ctx.logger, 'warn').mockImplementation(() => undefined)
    reference.release()
    await vi.waitFor(() => {
      expect(warning).toHaveBeenCalledWith('test Session scope disposal failed:', disposalFailure)
    })
    await dispose()
    await runtime.dispose()
  })

  it('invalidates live generations when the runtime Context ends', async () => {
    const runtime = await runtimeWithFrame()
    const id = await runtime.sessions.add({ id: 'live-at-root-disposal' })
    const reference = runtime.sessions.retain(id)
    await reference.ready
    const info = runtime.sessions.retainInfo(id)

    await runtime.ctx.fiber.dispose()

    expect(info.getSnapshot()).toEqual({ referenceCount: 0, retainedBy: {} })
    expect(() => reference.binding).toThrow('is released')
    expect(() => runtime.sessions.retain(id)).toThrow('disposed')
  })

  it('keeps a same-id replacement when stale generation cleanup arrives', async () => {
    const runtime = await runtimeWithFrame()
    const id = await runtime.sessions.add({ id: 'replacement' })
    const old = runtime.sessions.retain(id)
    await old.ready
    const oldBinding = old.binding
    const generations = (runtime.sessions as unknown as {
      generations: Map<SessionId, unknown>
    }).generations
    generations.delete(id)
    const replacement = runtime.sessions.retain(id)
    await replacement.ready

    await oldBinding.ctx.fiber.dispose()

    expect(runtime.sessions.binding(id)).toBe(replacement.binding)
    old.release()
    replacement.release()
    await runtime.dispose()
  })

  it('answers search with an empty page until a scenario declares hits, recording every call', async () => {
    const runtime = await runtimeWithFrame()
    await runtime.sessions.add({ id: 's1' })
    const signal = new AbortController().signal
    expect(runtime.sessions.searchResultLimit).toBeGreaterThan(0)
    await expect(runtime.sessions.search('marker', signal))
      .resolves.toEqual({ ok: true, value: { items: [], hasMore: false } })
    runtime.sessions.stubSearch(query => ({
      items: [{ sessionId: 's1' as SessionId, snippet: `hit: ${query}` }],
      hasMore: true,
    }))
    await expect(runtime.sessions.search('marker', signal)).resolves.toEqual({
      ok: true,
      value: { items: [{ sessionId: 's1', snippet: 'hit: marker' }], hasMore: true },
    })
    expect(runtime.sessions.calls).toEqual([
      { method: 'search', args: ['marker', signal] },
      { method: 'search', args: ['marker', signal] },
    ])
    await runtime.dispose()
  })
})

describe('stores', () => {
  const createSuiteStore = () => defineStore({
    init: () => ({ note: '' }),
    persist: 'trt.store',
    actions: { setNote: (d, note: string) => { d.note = note } },
  })

  it('resolves per-session instances via the host face: shared identity, isolation, action-driven re-render', async () => {
    const reference = createSnapshotStore<SessionReference | undefined>(undefined)
    const runtime = await runtimeWithFrame(reference)
    const handle = createSuiteStore()
    runtime.slots.register(
      { name: 'trt.chat', store: handle },
      (props: SessionStandardProps & { useStore: <S>(sel: (s: { note: string }) => S) => S }) =>
        <span>note:{props.useStore(s => s.note)}</span>)
    const view = runtime.renderRoot()
    await runtime.sessions.add({ id: 's1' })
    using first = runtime.sessions.retain('s1' as SessionId)
    await first.ready
    act(() => { reference.set(first) })

    expect(() => runtime.storeOf('trt.panel')).toThrow(/no registration/)
    const store = runtime.storeOf('trt.chat', first)
    await runtime.flush()
    ;(store.actions['setNote'] as (note: string) => void)('hello')
    await runtime.flush()
    expect(view.container.textContent).toContain('note:hello')
    expect(runtime.storeOf('trt.chat', first)).toBe(store) // cached per scope key

    await runtime.sessions.add({ id: 's2' })
    using second = runtime.sessions.retain('s2' as SessionId)
    await second.ready
    act(() => { reference.set(second) })
    const other = runtime.storeOf('trt.chat', second)
    expect(other).not.toBe(store)
    expect(other.getSnapshot()).toEqual({ note: '' })
    await runtime.dispose()
  })

  it('storeOf guards: before renderRoot, and for storeless entries', async () => {
    const runtime = await runtimeWithFrame()
    runtime.slots.register({ name: 'trt.panel' }, () => null)
    runtime.slots.register({ name: 'trt.chat', store: createSuiteStore() }, () => null)
    expect(() => runtime.storeOf('trt.panel')).toThrow(/before renderRoot/)
    runtime.renderRoot()
    expect(() => runtime.storeOf('trt.panel')).toThrow(/declares no store/)
    const host = (runtime as unknown as { host: SlotRendererHost }).host
    const adapter = host.scope('session')!
    const bindingSource = vi.spyOn(adapter, 'bindingSource').mockReturnValue(createSnapshotStore({
      key: undefined, hooks: {}, keyedHooks: {}, props: {},
    }))
    expect(() => runtime.storeOf('trt.chat', { sessionId: 'missing' as SessionId } as SessionReference))
      .toThrow(/no live Session binding/)
    bindingSource.mockRestore()
    await runtime.sessions.add({ id: 'released' })
    const released = runtime.sessions.retain('released' as SessionId)
    released.release()
    expect(() => runtime.storeOf('trt.chat', released)).toThrow(/is released/)
    await runtime.dispose()
  })

  it('removal and reference release preserve the Session Store persistence', async () => {
    const reference = createSnapshotStore<SessionReference | undefined>(undefined)
    const runtime = await runtimeWithFrame(reference)
    const handle = createSuiteStore()
    runtime.slots.register({ name: 'trt.chat', store: handle }, () => null)
    runtime.renderRoot()
    await runtime.sessions.add({ id: 's1' })
    using first = runtime.sessions.retain('s1' as SessionId)
    await first.ready
    act(() => { reference.set(first) })

    const doomed = runtime.storeOf('trt.chat', first)
    ;(doomed.actions['setNote'] as (note: string) => void)('buried')
    expect(localStorage.getItem('trt.store.s1')).not.toBeNull()

    await runtime.sessions.remove('s1')
    expect(localStorage.getItem('trt.store.s1')).not.toBeNull()
    expect(runtime.sessions.list.getSnapshot().ids).toEqual([])
    expect(runtime.sessions.binding('s1')?.session.getSnapshot().removed).toBe(true)
    expect(runtime.storeOf('trt.chat', first)).toBe(doomed)
    await act(async () => { reference.set(undefined); first.release(); await runtime.flush() })
    expect(localStorage.getItem('trt.store.s1')).not.toBeNull()
    expect(runtime.sessions.binding('s1')).toBeUndefined()

    await runtime.sessions.add({ id: 's1' })
    using replacement = runtime.sessions.retain('s1' as SessionId)
    await replacement.ready
    act(() => { reference.set(replacement) })
    const reborn = runtime.storeOf('trt.chat', replacement)
    expect(reborn).not.toBe(doomed)
    expect(reborn.getSnapshot()).toEqual({ note: 'buried' })
    await runtime.dispose()
  })

  it('removing catalog rows preserves an explicitly retained scope until release', async () => {
    const runtime = await runtimeWithFrame()
    await runtime.sessions.add({ id: 's1' })
    await runtime.sessions.add({ id: 's2' })
    using reference = runtime.sessions.retain('s1' as SessionId)
    await reference.ready
    const scope = runtime.sessions.scope('s1')!
    await runtime.sessions.remove('s2')
    expect(runtime.sessions.binding('s1')).toBe(reference.binding)
    await runtime.sessions.remove('s1')
    expect(scope.fiber.uid).not.toBeNull()
    expect(runtime.sessions.binding('s1')).toBe(reference.binding)
    await act(async () => { reference.release(); await runtime.flush() })
    expect(scope.fiber.uid).toBeNull()
    expect(runtime.sessions.binding('s1')).toBeUndefined()
    await runtime.dispose()
  })
})

describe('workspaces', () => {
  it('feeds the renderer root source from the Workspace Controller snapshot', async () => {
    const runtime = await runtimeWithFrame()
    runtime.slots.register(
      { name: 'trt.panel' },
      (props: { useWorkspaces: <S>(sel: (s: { phase: string }) => S) => S }) =>
        <span>ws:{props.useWorkspaces(s => s.phase)}</span>)
    const view = runtime.renderRoot()
    expect(view.container.textContent).toContain('ws:ready')

    await runtime.workspaces.update((draft) => { draft.phase = 'pending' })
    expect(view.container.textContent).toContain('ws:pending')
    await runtime.dispose()
  })
  it('skips default initialization without a fixture and forwards the caller lifetime', async () => {
    const runtime = await SlotTestRuntime.create()
    try {
      const signal = new AbortController().signal
      await expect(runtime.workspaces.initializeDefault(signal)).resolves.toBeUndefined()
      const workspace = {
        workspaceId: 'default' as WorkspaceId, title: 'default-workspace', path: '/default', sessionIds: [],
        createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z',
      }
      const initialize = vi.fn(async () => workspace)
      runtime.workspaces.stub('initializeDefault', initialize)
      await expect(runtime.workspaces.initializeDefault(signal)).resolves.toBe(workspace)
      expect(initialize).toHaveBeenCalledWith(signal)
      expect(runtime.workspaces.calls).toEqual([
        { method: 'initializeDefault', args: [signal] },
        { method: 'initializeDefault', args: [signal] },
      ])
    } finally {
      await runtime.dispose()
    }
  })
})

describe('feature mount and disposal', () => {
  it('mounts a plugin on a real fiber; dispose() cascades entries, declared children, and services', async () => {
    const runtime = await runtimeWithFrame()
    runtime.ctx.provide('layout', { openDetails: vi.fn() })
    const feature = await runtime.mount({
      inject: ['slots', 'layout'],
      apply: (ctx: typeof runtime.ctx) => {
        ctx.provide('feature-service', { ok: true })
        ctx.slots.register({
          name: 'trt.rows',
          id: 'row-1',
          children: { 'trt.rows.hole': { kind: 'single', scope: 'root' } },
        } as never, ((props: { renderSlot: (key: string, owner: object) => unknown }) =>
          <div data-testid="row">{props.renderSlot('trt.rows.hole', {}) as React.ReactNode}</div>) as never)
      },
    })
    const view = runtime.renderRoot()
    expect(view.getByTestId('row')).toBeTruthy()
    expect(runtime.ctx.get('feature-service')).toEqual({ ok: true })
    expect(runtime.slots.entries('trt.rows')).toHaveLength(1)

    await feature.dispose()
    await feature.dispose() // idempotent
    expect(runtime.slots.entries('trt.rows')).toHaveLength(0)
    expect(runtime.slots.spec('trt.rows.hole')).toBeUndefined()
    expect(runtime.ctx.get('feature-service')).toBeUndefined()
    expect(view.queryByTestId('row')).toBeNull()
    await runtime.dispose()
  })

  it('mount fails loud on missing services instead of suspending forever', async () => {
    const runtime = await runtimeWithFrame()
    await expect(runtime.mount({ inject: ['slots', 'absent-service'], apply: () => {} }))
      .rejects.toThrow(/missing service\(s\) absent-service/)
    await runtime.dispose()
  })

  it('runtime dispose is idempotent, unmounts views, disposes mounted features, and clears persisted state', async () => {
    const runtime = await runtimeWithFrame()
    const feature = await runtime.mount({
      inject: ['slots'],
      apply: (ctx: typeof runtime.ctx) => { ctx.slots.register({ name: 'trt.panel' }, () => <b>p</b>) },
    })
    const view = runtime.renderRoot()
    expect(view.container.textContent).toContain('p')
    localStorage.setItem('trt.leftover', 'x')

    await runtime.dispose()
    expect(view.container.innerHTML).toBe('')
    expect(feature.fiber.uid).toBeNull()
    expect(localStorage.getItem('trt.leftover')).toBeNull()
    await runtime.dispose() // idempotent
    await expect(runtime.dispose()).resolves.toBeUndefined()
  })
})

describe('single-slot mounting (declare + renderSlot)', () => {
  it('renders an absent session-maybe slot through its empty projection', async () => {
    const runtime = await SlotTestRuntime.create()
    await runtime.declare({ 'trt.maybe': { kind: 'single', scope: 'session-maybe' } })
    runtime.slots.register(
      { name: 'trt.maybe' },
      ({ sessionId }: { sessionId: SessionId | undefined }) => <b>{sessionId ?? 'no session'}</b>,
    )

    const slot = runtime.renderSlot('trt.maybe', {})

    expect(slot.container.textContent).toBe('no session')
    await runtime.dispose()
  })

  it('borrows separate explicit references for sibling views and updates only the supplied view', async () => {
    const runtime = await SlotTestRuntime.create()
    const firstId = await runtime.sessions.add({ id: 'view-first' })
    const secondId = await runtime.sessions.add({ id: 'view-second' })
    using first = runtime.sessions.retain(firstId)
    await first.ready
    using second = runtime.sessions.retain(secondId)
    await second.ready
    await runtime.declare({
      'trt.chat': { kind: 'single', scope: 'session' },
      'trt.other-chat': { kind: 'single', scope: 'session' },
    })
    runtime.slots.register({ name: 'trt.chat' }, ({ sessionId }: SessionStandardProps) => <b>{sessionId}</b>)
    runtime.slots.register({ name: 'trt.other-chat' }, ({ sessionId }: SessionStandardProps) => <b>{sessionId}</b>)
    const retain = vi.spyOn(runtime.sessions, 'retain')
    const left = runtime.renderSlot('trt.chat', {}, { session: first })
    const right = runtime.renderSlot('trt.other-chat', {}, { session: second })
    expect(left.container.textContent).toBe('view-first')
    expect(right.container.textContent).toBe('view-second')
    left.update({}, { session: second })
    expect(left.container.textContent).toBe('view-second')
    expect(right.container.textContent).toBe('view-second')
    expect(retain).not.toHaveBeenCalled()
    expect(runtime.sessions.binding(firstId)).toBe(first.binding)
    await runtime.dispose()
  })

  it('renders one slot inside its data-slot wrapper and updates owner props in place', async () => {
    const runtime = await SlotTestRuntime.create()
    await runtime.declare({ 'trt.panel': { kind: 'single', scope: 'root' } })
    runtime.slots.register(
      { name: 'trt.panel' },
      ({ label }: { label?: string }) => <b data-testid="panel">{label ?? 'none'}</b>)
    const slot = runtime.renderSlot('trt.panel', { label: 'first' })
    expect(slot.container.getAttribute('data-slot')).toBe('trt.panel')
    expect(slot.view.getByTestId('panel').textContent).toBe('first')

    const panel = slot.view.getByTestId('panel')
    slot.update({ label: 'second' })
    expect(slot.view.getByTestId('panel').textContent).toBe('second')
    // In-place re-render: the element identity survived the owner flip.
    expect(slot.view.getByTestId('panel')).toBe(panel)
    await runtime.dispose()
  })

  it('views sibling slots of one tree separately and rejects undeclared keys', async () => {
    const runtime = await SlotTestRuntime.create()
    await runtime.declare({
      'trt.panel': { kind: 'single', scope: 'root' },
      'trt.rows': { kind: 'list', scope: 'root' },
    })
    runtime.slots.register({ name: 'trt.panel' }, () => <b>panel</b>)
    runtime.slots.register({ name: 'trt.rows', id: 'r1' }, () => <i>row</i>)
    const panel = runtime.renderSlot('trt.panel', {})
    const rows = runtime.renderSlot('trt.rows', {})
    expect(panel.container.textContent).toBe('panel')
    expect(rows.container.textContent).toBe('row')
    expect(() => runtime.renderSlot('trt.chat', {})).toThrow(/without declare\(\)/)
    await runtime.dispose()
  })

  it('folds class hashes and collapses svg internals in snapshots, leaving the live DOM alone', async () => {
    const runtime = await SlotTestRuntime.create()
    await runtime.declare({ 'trt.panel': { kind: 'single', scope: 'root' } })
    runtime.slots.register({ name: 'trt.panel' }, () => (
      <div className="_frame_a1b2c3 plain">
        <span className="_label_ff00aa">styled</span>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M0 0L16 16" fill="currentColor" />
        </svg>
      </div>
    ))
    const slot = runtime.renderSlot('trt.panel', {})
    expect(slot.container).toMatchSnapshot()
    // The serializer works on a clone: the live DOM keeps hashes and paths.
    expect(slot.container.querySelector('div')!.className).toBe('_frame_a1b2c3 plain')
    expect(slot.container.querySelector('svg path')).not.toBeNull()
    await runtime.dispose()
  })
})

describe('fixture session face', () => {
  it('fail-loud stubs name the missing verb; supplied overrides run instead', async () => {
    const runtime = await SlotTestRuntime.create()
    await runtime.sessions.add({ id: 's1' })
    const bare = runtime.sessions.behavior('s1')
    expect(() => bare.prompt()).toThrow(/prompt is not stubbed/)
    expect(() => bare.readAttachment('att-1' as Parameters<typeof bare.readAttachment>[0])).toThrow(/readAttachment is not stubbed/)
    expect(() => bare.updateQueue()).toThrow(/updateQueue is not stubbed/)
    expect(() => bare.cancel()).toThrow(/cancel is not stubbed/)
    expect(() => bare.command()).toThrow(/command is not stubbed/)
    expect(() => bare.loadOlder()).toThrow(/loadOlder is not stubbed/)
    expect(() => bare.loadThrough()).toThrow(/loadThrough is not stubbed/)
    expect(() => bare.rename()).toThrow(/rename is not stubbed/)
    const submission = bare.beginSubmission()
    expect(submission.requestId).toBe('test-submission-1')
    expect(() => { submission.abandon() }).not.toThrow()
    await runtime.dispose()
  })

  it('projects controller values through the real ui-session and renderer path', async () => {
    const reference = createSnapshotStore<SessionReference | undefined>(undefined)
    const runtime = await runtimeWithFrame(reference)
    runtime.slots.register({ name: 'trt.chat' }, (props: SessionStandardProps) => (
      <span>todos:{props.useProjection('todos', value => value?.length ?? 0)}</span>
    ))
    const view = runtime.renderRoot()
    await runtime.sessions.add({ id: 's1' })
    using bound = runtime.sessions.retain('s1' as SessionId)
    await bound.ready
    act(() => { reference.set(bound) })
    expect(view.container.textContent).toContain('todos:0')

    const session = runtime.sessions.behavior('s1')
    const face = session.projections.faceOf('todos')
    expect(session.projections.faceOf('todos')).toBe(face)
    expect(face.getSnapshot()).toBeUndefined()
    const seen: unknown[] = []
    const off = face.subscribe(() => { seen.push(face.getSnapshot()) })
    session.projections.set('todos', [1, 2])
    await runtime.flush()
    expect(seen).toEqual([[1, 2]])
    expect(view.container.textContent).toContain('todos:2')
    off()
    session.projections.set('todos', [3])
    await runtime.flush()
    expect(seen).toEqual([[1, 2]]) // unsubscribed
    expect(view.container.textContent).toContain('todos:1')
    // A never-subscribed key sets without listeners (the empty-notify arm).
    session.projections.set('untouched', 1)
    await runtime.dispose()
  })

  it('copies projections into a later Session generation', async () => {
    const runtime = await runtimeWithFrame()
    const id = await runtime.sessions.add({ id: 'seeded-projection' })
    await runtime.sessions.setProjection(id, 'todos', [1, 2])

    using reference = runtime.sessions.retain(id)
    await reference.ready

    expect(reference.binding.session.projections.faceOf('todos').getSnapshot()).toEqual([1, 2])
    await runtime.dispose()
  })
})

describe('workspaces action face', () => {
  it('records pin and unpin actions, updates the ordered set, and honors stubs', async () => {
    const runtime = await SlotTestRuntime.create()
    try {
      const ws = runtime.workspaces
      const first = 'first' as SessionId
      const second = 'second' as SessionId
      await ws.pinSession(first)
      await ws.pinSession(second)
      await ws.pinSession(first)
      expect(ws.list.getSnapshot().pinnedSessionIds).toEqual([first, second])
      await ws.unpinSession(first)
      expect(ws.list.getSnapshot().pinnedSessionIds).toEqual([second])

      const pin = vi.fn(async () => {})
      const unpin = vi.fn(async () => {})
      ws.stub('pinSession', pin)
      ws.stub('unpinSession', unpin)
      await ws.pinSession(first)
      await ws.unpinSession(second)
      expect(pin).toHaveBeenCalledWith(first)
      expect(unpin).toHaveBeenCalledWith(second)
      expect(ws.list.getSnapshot().pinnedSessionIds).toEqual([second])
      expect(ws.calls).toEqual([
        { method: 'pinSession', args: [first] },
        { method: 'pinSession', args: [second] },
        { method: 'pinSession', args: [first] },
        { method: 'unpinSession', args: [first] },
        { method: 'pinSession', args: [first] },
        { method: 'unpinSession', args: [second] },
      ])
    } finally {
      await runtime.dispose()
    }
  })

  it('records every IWorkspaces verb with inert defaults and honors stubs', async () => {
    const runtime = await SlotTestRuntime.create()
    const ws = runtime.workspaces
    const created = await ws.create({ path: '/tmp/alpha' })
    expect(created.title).toBe('/tmp/alpha')
    const registered = await ws.create({ path: '/tmp/beta' })
    expect(registered.path).toBe('/tmp/beta')
    const renamed = await ws.rename('w1' as WorkspaceId, 'Renamed')
    expect(renamed.title).toBe('Renamed')
    await ws.delete('w1' as WorkspaceId)
    await ws.insertBefore('w1' as WorkspaceId, 'w2' as WorkspaceId)
    const moved = await ws.insertSessionBefore('w1' as WorkspaceId, 's1' as SessionId, 's2' as SessionId)
    expect(moved.sessionIds).toEqual(['s1'])
    // Default archive mirrors the production effect: the id joins the list
    // state's archive set (features render against the same snapshot).
    await ws.archiveSession('s1' as SessionId)
    expect(ws.list.getSnapshot().archivedSessionIds).toEqual(['s1'])
    await ws.archiveSession('s0' as SessionId)
    // Default unarchive mirrors it: the id leaves the same set.
    await ws.unarchiveSession('s0' as SessionId)
    expect(ws.list.getSnapshot().archivedSessionIds).toEqual(['s1'])
    expect(ws.calls.map(c => c.method)).toEqual(
      ['create', 'create', 'rename', 'delete', 'insertBefore', 'insertSessionBefore',
        'archiveSession', 'archiveSession', 'unarchiveSession'])

    ws.stub('create', () => Promise.resolve({ workspaceId: 'ws-x', title: 'X', path: '/x', sessionIds: [] } as never))
    ws.stub('rename', () => Promise.resolve({ workspaceId: 'w1', title: 'S', path: '/s', sessionIds: [] } as never))
    ws.stub('delete', () => Promise.resolve())
    const insertBefore = vi.fn(() => Promise.resolve())
    ws.stub('insertBefore', insertBefore)
    ws.stub('insertSessionBefore', () => Promise.resolve({ workspaceId: 'w1', title: '', path: '', sessionIds: [] } as never))
    ws.stub('archiveSession', () => Promise.resolve())
    ws.stub('unarchiveSession', () => Promise.resolve())
    expect((await ws.create({ path: '/y' })).title).toBe('X')
    expect((await ws.rename('w1' as WorkspaceId, 'z')).title).toBe('S')
    await ws.delete('w1' as WorkspaceId)
    await ws.insertBefore('w2' as WorkspaceId)
    expect(insertBefore).toHaveBeenCalledWith('w2', undefined)
    expect((await ws.insertSessionBefore('w1' as WorkspaceId, 's1' as SessionId)).sessionIds).toEqual([])
    // The stub replaces the default set mutation: the set stays as-is.
    await ws.archiveSession('s2' as SessionId)
    expect(ws.list.getSnapshot().archivedSessionIds).toEqual(['s1'])
    await ws.unarchiveSession('s1' as SessionId)
    expect(ws.list.getSnapshot().archivedSessionIds).toEqual(['s1'])
    await runtime.dispose()
  })
})

describe('single-slot mounting edge arms', () => {
  it('renderSlot fails loud after dispose and after an external unmount', async () => {
    const runtime = await SlotTestRuntime.create()
    await runtime.declare({ 'trt.panel': { kind: 'single', scope: 'root' } })
    runtime.slots.register({ name: 'trt.panel' }, () => <b>p</b>)
    runtime.renderSlot('trt.panel', {})
    // RTL cleanup empties the mounted tree behind the runtime's back: the
    // wrapper lookup names the state instead of returning a dead container.
    cleanup()
    expect(() => runtime.renderSlot('trt.panel', {})).toThrow(/rendered no wrapper/)
    await runtime.dispose()
    expect(() => runtime.renderSlot('trt.panel', {})).toThrow(/slot renderer not installed/)
  })

  it('serializes childless svg untouched next to scoped classes', async () => {
    const runtime = await SlotTestRuntime.create()
    await runtime.declare({ 'trt.panel': { kind: 'single', scope: 'root' } })
    runtime.slots.register({ name: 'trt.panel' }, () => (
      <div className="_frame_a1b2c3">
        <svg viewBox="0 0 1 1" aria-hidden="true" />
      </div>
    ))
    const slot = runtime.renderSlot('trt.panel', {})
    expect(slot.container).toMatchSnapshot()
    await runtime.dispose()
  })
})

describe('stubbed settings scope', () => {
  it('records both write kinds and publishes a Host acceptance to its listeners', async () => {
    const host = stubConfigForm<{ preference: string }>()
    let notified = 0
    const stop = host.scope.subscribe(() => { notified += 1 })
    expect(host.listenerCount()).toBe(1)
    expect(host.scope.getSnapshot()).toMatchObject({
      status: 'loading', base: undefined, user: undefined,
    })

    await host.scope.set('preference', 'dark')
    await expect(host.scope.unset('preference')).resolves.toBe(true)
    await expect(host.scope.mutate([{ op: 'set', path: ['preference'], value: 'dark' }])).resolves.toBe(true)
    host.publish({
      status: 'ready',
      value: { preference: 'system' },
      base: { preference: 'system' },
      revision: 2,
      writable: true,
    })

    expect(host.set).toHaveBeenCalledWith('preference', 'dark')
    expect(host.unset).toHaveBeenCalledWith('preference')
    expect(notified).toBe(1)
    expect(host.scope.getSnapshot()).toMatchObject({ status: 'ready', revision: 2, writable: true })
    stop()
    expect(host.listenerCount()).toBe(0)
  })
})
