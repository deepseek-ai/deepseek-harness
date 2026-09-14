/**
 * ui-model-selection browser half on a real cordis Context with fake command/slots/
 * connection faces and real session scopes: the plugin mounts ModelDirectoryResolver
 * as `models`, the /model contribution and the conversation.input.model
 * seat both register, and BOTH entries resolve the SAME per-session
 * directory through the service — a selection submitted through the seat's
 * inject face is the current the popup's next options pass marks active
 * (and the reverse), the one-shared-state contract of the dual entry.
 * Scope disposal drops the directory (HMR safety).
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { createScope } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { ModelSelection, ModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { CommandContribution, PopupSelectSpec, SelectOption } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { ModelSelectInjected } from '../src/client/slots.ts'
import { apply, inject } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'

const sid = (k: string): SessionId => k as SessionId

const GROUPS = [{
  id: 'deepseek-official',
  name: 'DeepSeek',
  models: [
    {
      id: 'deepseek-v4-flash',
      name: 'DeepSeek-V4-Flash',
      description: 'Fast, efficient, and economical; suited to focused, routine, or parallel tasks.',
      reasoning: {
        efforts: [
          { id: 'off', name: 'Off' },
          { id: 'high', name: 'High' },
          { id: 'max', name: 'Max' },
        ],
        defaultEffort: 'high',
      },
    },
    {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek-V4-Pro',
      description: 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
      reasoning: {
        efforts: [
          { id: 'off', name: 'Off' },
          { id: 'high', name: 'High' },
          { id: 'max', name: 'Max' },
        ],
        defaultEffort: 'high',
      },
    },
  ],
}, {
  id: 'external',
  name: 'External Provider',
  models: [{
    id: 'deepseek-v4-flash',
    name: 'External Flash',
    description: 'Provider-authored description.',
  }],
}]

/** Boot the plugin over fake faces + a stateful fake host (current moves on selectModel). */
async function bench(locale: 'zh' | 'en' = 'zh') {
  const ctx = new Context()
  let defaultSelection: ModelSelection = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  let selected = defaultSelection
  const calls = { models: 0, select: 0 }
  const projections = new Map<SessionId, SnapshotStore<ModelSelectionProjection | undefined>>()
  // Whether the Host reports an adapter for the current route; the composer
  // block follows this, never catalog membership.
  let routable = true
  const sessionRemote = {
    modelCatalog: () => {
      calls.models += 1
      return Promise.resolve({
        ok: true as const,
        value: {
          default: defaultSelection,
          routableProviders: routable ? ['deepseek-official'] : [],
          groups: GROUPS,
          failures: [],
        },
      })
    },
    selectModel: (payload: { sessionId: SessionId; provider: string; model: string; reasoningEffort?: string }) => {
      calls.select += 1
      selected = {
        provider: payload.provider,
        model: payload.model,
        ...payload.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: payload.reasoningEffort },
      }
      projections.get(payload.sessionId)?.set({ lastUsed: null, next: selected })
      return Promise.resolve({ ok: true as const, value: { selected } })
    },
  }
  const remote = Object.assign(new TestRemote(ctx), { session: sessionRemote })
  ctx.reflect.provide('remote.session', sessionRemote)
  const blocks = new Map<SessionId, { reason: string } | undefined>()
  ctx.provide('conversation', {
    blocks: {
      set: (id: SessionId, block: { reason: string } | undefined) => { blocks.set(id, block) },
    },
  })
  let contribution: CommandContribution | undefined
  ctx.provide('commandUi', {
    register(c: CommandContribution) {
      contribution = c
      return () => { contribution = undefined }
    },
  })
  const seats = new Map<string, {
    inject: ((sessionId: SessionId) => ModelSelectInjected) | undefined
    locale: string | undefined
  }>()
  ctx.provide('slots', {
    inject(_name: string, callback: () => () => void) { return callback() },
    register(options: { name: string; locale?: string; inject?: (sessionId: SessionId) => ModelSelectInjected }) {
      seats.set(options.name, { inject: options.inject, locale: options.locale })
      return () => { seats.delete(options.name) }
    },
  })
  const localeRuntime = new LocaleRuntime(ctx)
  // There is no jsdom `window` in this lane, so browser-language detection
  // never runs. Each bench states the locale its assertions require.
  localeRuntime.setLocale(locale)
  ctx.provide('locale', localeRuntime)
  const scopes = new Map<SessionId, Context>()
  const addressed = new Set<SessionId>()
  ctx.provide('sessions', {
    scope: (id: SessionId) => scopes.get(id),
    binding: (id: SessionId) => {
      const scope = scopes.get(id)
      const projection = projections.get(id)
      return scope === undefined || projection === undefined
        ? undefined
        : {
          sessionId: id,
          session: { projections: { faceOf: () => projection } },
          ctx: scope,
        }
    },
    subagentAddress: (id: SessionId) => addressed.has(id)
      ? { parentSessionId: sid('parent'), childSessionId: id, mode: 'continuable' as const }
      : undefined,
  })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  await ctx.plugin(function probe() {}).await()
  const mint = (key: string) => {
    const id = sid(key)
    const handle = createScope(ctx, id)
    scopes.set(id, handle.ctx)
    projections.set(id, createSnapshotStore<ModelSelectionProjection | undefined>({
      lastUsed: null,
      next: null,
    }))
    return handle
  }
  return {
    ctx, fiber, mint, calls, remote,
    contribution: () => contribution!,
    popup: (): PopupSelectSpec => {
      const ui = contribution!.ui
      if (ui.kind !== 'popupSelect') throw new Error('expected the popupSelect kind')
      return ui
    },
    seat: () => seats.get('conversation.input.model')!,
    hostCurrent: () => selected,
    setHostCurrent: (selection: ModelSelection) => { defaultSelection = selection },
    setProjected: (id: SessionId, value: ModelSelectionProjection) => { projections.get(id)?.set(value) },
    address: (id: SessionId) => { addressed.add(id) },
    setRoutable: (next: boolean) => { routable = next },
    blockOf: (key: string) => blocks.get(sid(key)),
  }
}

const projection = (id: string) => ({ sessionId: sid(id) })

describe('ui-model-selection dual entry', () => {
  it('registers the /model contribution and the composer model seat', async () => {
    const b = await bench()
    expect(b.contribution().name).toBe('model')
    expect(b.contribution().ui.kind).toBe('popupSelect')
    expect(b.seat().inject).toBeTypeOf('function')
    // Copy rides the standard locale seat.
    expect(b.seat().locale).toBe('model')
  })

  it('localizes built-in descriptions and preserves external provider descriptions', async () => {
    const b = await bench()
    b.mint('s1')
    const options = await b.popup().options(projection('s1'), new AbortController().signal)
    expect(options.map((o: SelectOption) => o.label)).toEqual([
      'DeepSeek-V4-Flash', 'DeepSeek-V4-Pro', 'External Flash',
    ])
    expect(options[0]).toMatchObject({
      active: true,
      detail: 'DeepSeek · 快速、高效且经济；适合目标明确、常规或并行任务。',
    })
    expect(options[1]?.detail)
      .toBe('DeepSeek · 更强的自主编码、知识与复杂推理能力；适合复杂或质量优先的任务，但成本更高。')
    expect(options[2]?.detail).toBe('External Provider · Provider-authored description.')
    expect(options[1]?.active).toBeUndefined()
  })

  it('keeps built-in descriptions unchanged in English', async () => {
    const b = await bench('en')
    b.mint('s1')
    const options = await b.popup().options(projection('s1'), new AbortController().signal)
    expect(options[0]?.detail)
      .toBe('DeepSeek · Fast, efficient, and economical; suited to focused, routine, or parallel tasks.')
    expect(options[1]?.detail)
      .toBe('DeepSeek · Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.')
  })

  it('a seat selection is the current the popup marks active next — one shared state', async () => {
    const b = await bench()
    b.mint('s1')
    const seatFace = b.seat().inject!(sid('s1'))
    // Switch through the SEAT entry.
    expect(await seatFace.select({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    })).toBe(true)
    expect(b.hostCurrent()).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    })
    expect(seatFace.directory.getSnapshot().current).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    })
    // The POPUP's next options pass reflects it without a seat-side reload.
    const options = await b.popup().options(projection('s1'), new AbortController().signal)
    expect(options.find((o: SelectOption) => o.label === 'DeepSeek-V4-Pro')).toMatchObject({ active: true })
  })

  it('a popup selection lands on the seat store — the reverse direction of the same state', async () => {
    const b = await bench()
    b.mint('s1')
    const seatFace = b.seat().inject!(sid('s1'))
    const options = await b.popup().options(projection('s1'), new AbortController().signal)
    const pro = options.find((o: SelectOption) => o.label === 'DeepSeek-V4-Pro')!
    await b.popup().onSelect(pro, projection('s1'))
    expect(seatFace.directory.getSnapshot().current).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    })
  })

  it('both entries share one directory instance per session, isolated across sessions', async () => {
    const b = await bench()
    b.mint('a')
    b.mint('b')
    const faceA = b.seat().inject!(sid('a'))
    const faceA2 = b.seat().inject!(sid('a'))
    const faceB = b.seat().inject!(sid('b'))
    expect(faceA.directory).toBe(faceA2.directory)
    expect(faceA.directory).not.toBe(faceB.directory)
    // The service face resolves the same instance the seat inject handed out.
    expect(b.ctx.modelDirectories.directoryFor(sid('a')).store).toBe(faceA.directory)
    await Promise.all([
      b.popup().options(projection('a'), new AbortController().signal),
      b.popup().options(projection('b'), new AbortController().signal),
    ])
    expect(b.calls.models).toBe(1)
  })

  it('keeps the durable projected selection while the eager catalog reconnects', async () => {
    const b = await bench()
    b.mint('s1')
    const face = b.seat().inject!(sid('s1'))
    await face.select({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    b.setHostCurrent({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })

    b.ctx.emit('connection/reset')
    expect(face.directory.getSnapshot()).toMatchObject({
      current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      status: 'ready',
    })
    face.load()
    expect(face.directory.getSnapshot()).toMatchObject({
      current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      status: 'ready',
    })
  })

  it('keeps the last complete view while a refreshed catalog catches up with projection', async () => {
    const b = await bench()
    b.mint('s1')
    const face = b.seat().inject!(sid('s1'))
    face.load()
    expect(face.directory.getSnapshot().current?.model).toBe('deepseek-v4-flash')

    b.remote.emit('settings/document-updated', ['llm-deepseek', 1])
    b.setProjected(sid('s1'), {
      lastUsed: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      next: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    })
    expect(face.directory.getSnapshot()).toMatchObject({
      current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      status: 'ready',
    })

    await vi.waitFor(() => {
      expect(face.directory.getSnapshot()).toMatchObject({
        current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
        status: 'ready',
      })
    })
  })

  it('scope disposal drops the directory; a reborn scope gets a fresh one', async () => {
    const b = await bench()
    const first = b.mint('s1')
    const face1 = b.seat().inject!(sid('s1'))
    await first.fiber.dispose()
    b.mint('s1')
    const face2 = b.seat().inject!(sid('s1'))
    expect(face2.directory).not.toBe(face1.directory)
  })

  it('blocks the composer only once the Host reports the route unservable', async () => {
    const b = await bench()
    b.mint('s1')
    const face = b.seat().inject!(sid('s1'))

    // Before the first load nothing is known. `null` is not `false`: a slow
    // or unreachable Host must never lock a working composer.
    expect(b.blockOf('s1')).toBeUndefined()
    face.load()
    await Promise.resolve()
    await Promise.resolve()
    expect(b.blockOf('s1')).toBeUndefined()
    expect(b.calls.models).toBe(1)

    b.setRoutable(false)
    b.remote.emit('settings/document-updated', ['llm-deepseek', 1])
    await Promise.resolve()
    await Promise.resolve()
    expect(b.blockOf('s1')?.reason).toBe(zh['blocked.composer'])
    expect(b.calls.models).toBe(2)

    // Recovering clears it without a reload of the surface.
    b.setRoutable(true)
    b.remote.emit('llm/adapters-updated', [])
    await Promise.resolve()
    await Promise.resolve()
    expect(b.blockOf('s1')).toBeUndefined()
    expect(b.calls.models).toBe(3)
  })

  it('never blocks on catalog membership alone', async () => {
    const b = await bench()
    b.mint('s1')
    const face = b.seat().inject!(sid('s1'))
    // A model the route serves but no longer advertises: the seat prompts for
    // a selection, the composer stays usable. Blocking here would break a
    // supported configuration (a narrowed `models` list over a live route).
    b.setHostCurrent({ provider: 'deepseek-official', model: 'unlisted' })
    face.load()
    await Promise.resolve()
    await Promise.resolve()
    const snapshot = face.directory.getSnapshot()
    expect(snapshot.groups.flatMap(group => group.models.map(model => model.id))).not.toContain('unlisted')
    expect(b.blockOf('s1')).toBeUndefined()
  })

  it('clears its block when the session scope goes', async () => {
    const b = await bench()
    const scope = b.mint('s1')
    b.setRoutable(false)
    const face = b.seat().inject!(sid('s1'))
    face.load()
    b.remote.emit('llm/adapters-updated', [])
    await vi.waitFor(() => { expect(b.blockOf('s1')).toBeDefined() })

    await scope.fiber.dispose()
    expect(b.blockOf('s1')).toBeUndefined()
  })

  it('an unknown session fails loud at the seat inject', async () => {
    const b = await bench()
    expect(() => b.seat().inject!(sid('ghost'))).toThrow(/resolved no scope/)
  })

  it('withholds both model entries from addressed subagent sessions without Agent-bound RPCs', async () => {
    const b = await bench()
    b.mint('child')
    b.address(sid('child'))

    expect(b.contribution().available(projection('child'))).toBe(false)
    await expect(b.popup().options(
      projection('child'),
      new AbortController().signal,
    )).rejects.toThrow(/unavailable for addressed subagent/)

    const face = b.seat().inject!(sid('child'))
    expect(face.available).toBe(false)
    face.load()
    await expect(face.select({ provider: 'deepseek', model: 'deepseek-v4-pro' })).resolves.toBe(false)
    await expect(b.ctx.modelDirectories.directoryFor(sid('child')).load())
      .rejects.toThrow(/unavailable for addressed subagent/)
    await expect(b.ctx.modelDirectories.directoryFor(sid('child')).select({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    })).rejects.toThrow(/unavailable for addressed subagent/)
    b.ctx.emit('connection/reset')
    await Promise.resolve()
    expect(b.calls).toEqual({ models: 2, select: 0 })
  })
})
