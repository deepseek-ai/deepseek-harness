import { describe, expect, it, vi } from 'vitest'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError, stubConfigForm, type StubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { SubagentLimitsCardController, type SubagentLimitsSettings } from '../src/client/subagent-limits-card-controller.ts'
import { subagentCardFace, subagentCardShell } from '../src/client/subagent-card-controller.ts'
import {
  SubagentModelSelectionCardController,
  subagentModelCandidates,
  type SubagentModelSelectionSettings,
} from '../src/client/subagent-model-selection-card-controller.ts'

/** Make the stub behave like a Host that accepts every write. */
function acceptWrites<T>(host: StubConfigForm<T>): void {
  const section = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().value as object })
  const layer = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().user as object })
  host.set.mockImplementation((field: string, value: unknown) => {
    host.publish({ value: { ...section(), [field]: value } as T, user: { ...layer(), [field]: value } })
  })
  host.mutate.mockImplementation((ops: readonly SettingsPathOpView[]) => {
    const value = { ...section() }
    const user = { ...layer() }
    for (const op of ops) {
      const field = op.path[0]!
      if (op.op === 'set') {
        value[field] = op.value
        user[field] = op.value
      } else {
        Reflect.deleteProperty(user, field)
        value[field] = (host.scope.getSnapshot().base as Record<string, unknown> | undefined)?.[field]
      }
    }
    host.publish({ value: value as T, user })
    return Promise.resolve(true)
  })
  host.unset.mockImplementation((field: string) => {
    const user = Object.fromEntries(Object.entries(layer()).filter(([key]) => key !== field))
    const base = host.scope.getSnapshot().base as Record<string, unknown> | undefined
    host.publish({ value: { ...section(), [field]: base?.[field] } as T, user })
  })
}

/** The card plugin's context, scripted down to the namespaces a card reaches. */
function ctxWith(namespaces: object) {
  return { remote: namespaces } as never
}

function modelsApi(options: {
  groups?: readonly {
    id: string
    name: string
    models: readonly { id: string; name: string }[]
  }[]
  failures?: readonly { id: string; name: string; message: string }[]
  error?: string
} = {}) {
  const models = vi.fn(() => Promise.resolve({
    ...(options.error === undefined
      ? { ok: true as const, value: { groups: options.groups ?? [], failures: options.failures ?? [] } }
      : { ok: false as const, error: new RemoteError('gateway/internal', options.error, {}) }),
  }))
  return { ctx: ctxWith({ session: { modelCatalog: models } }), models }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('SubagentModelSelectionCardController', () => {
  it('joins stored routes with the live catalog without dropping unavailable choices', () => {
    const candidates = subagentModelCandidates(
      [{ id: 'alpha', name: 'Alpha API', models: [{ id: 'fast', name: 'Fast' }] }],
      [{ provider: 'legacy', model: 'old' }],
      new Set(['legacy\0old']),
    )

    expect(candidates).toEqual([
      {
        key: 'alpha\0fast', provider: 'alpha', model: 'fast', providerName: 'Alpha API',
        modelName: 'Fast', available: true, selected: false,
      },
      {
        key: 'legacy\0old', provider: 'legacy', model: 'old', providerName: 'legacy',
        modelName: 'old', available: false, selected: true,
      },
    ])
  })

  it('loads adapter models and saves the switch and routes atomically', async () => {
    const host = stubConfigForm<SubagentModelSelectionSettings>()
    acceptWrites(host)
    const models = modelsApi({
      groups: [{ id: 'alpha', name: 'Alpha API', models: [{ id: 'fast', name: 'Fast' }] }],
    })
    const controller = new SubagentModelSelectionCardController(host.scope, models.ctx)
    host.publish({
      status: 'ready', writable: true, revision: 3,
      value: { enabled: false, allowedModels: [] }, user: {},
    })
    const face = controller.inject()

    expect(face.hooks.subagentModelSelectionCard.getSnapshot().enabled).toBe(false)
    face.toggleEnabled()
    await vi.waitFor(() => {
      expect(face.hooks.subagentModelSelectionCard.getSnapshot().candidates).toHaveLength(1)
    })
    face.toggleModel('alpha\0fast')
    face.save()
    await vi.waitFor(() => {
      expect(host.mutate).toHaveBeenCalledWith([
        { op: 'set', path: ['enabled'], value: true },
        { op: 'set', path: ['allowedModels'], value: [{ provider: 'alpha', model: 'fast' }] },
      ], 3)
    })

    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({
      enabled: true,
      dirty: false,
      saving: false,
      failed: false,
    })
  })

  it('starts an empty draft when a ready test scope has no decoded value', () => {
    const host = stubConfigForm<SubagentModelSelectionSettings>()
    const controller = new SubagentModelSelectionCardController(host.scope, modelsApi().ctx)
    host.publish({ status: 'ready', writable: true, revision: 0, value: undefined })
    const face = controller.inject()

    face.toggleEnabled()

    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({
      enabled: true, dirty: true, invalid: true,
    })
  })

  it('keeps the Host value and reports a rejected write', async () => {
    const host = stubConfigForm<SubagentModelSelectionSettings>()
    const models = modelsApi({
      groups: [{ id: 'alpha', name: 'Alpha API', models: [{ id: 'fast', name: 'Fast' }] }],
    })
    const controller = new SubagentModelSelectionCardController(host.scope, models.ctx)
    host.publish({ status: 'ready', writable: true, value: { enabled: false, allowedModels: [] }, user: {} })
    const face = controller.inject()

    face.toggleEnabled()
    await vi.waitFor(() => {
      expect(face.hooks.subagentModelSelectionCard.getSnapshot().candidates).toHaveLength(1)
    })
    face.toggleModel('alpha\0fast')
    face.save()
    await vi.waitFor(() => {
      expect(face.hooks.subagentModelSelectionCard.getSnapshot().failed).toBe(true)
    })

    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({
      enabled: true,
      dirty: true,
      saving: false,
    })
  })

  it('loads stored routes, stages removal and disablement, and discards both', async () => {
    const host = stubConfigForm<SubagentModelSelectionSettings>()
    const models = modelsApi({
      groups: [{ id: 'alpha', name: 'Alpha API', models: [{ id: 'fast', name: 'Fast' }] }],
      failures: [{ id: 'beta', name: 'Beta', message: 'offline' }],
    })
    const controller = new SubagentModelSelectionCardController(host.scope, models.ctx)
    host.publish({
      status: 'ready', writable: true, revision: 5,
      value: { enabled: true, allowedModels: [{ provider: 'alpha', model: 'fast' }] }, user: {},
    })
    const face = controller.inject()
    const state = () => face.hooks.subagentModelSelectionCard.getSnapshot()
    await vi.waitFor(() => { expect(state().catalogStatus).toBe('ready') })
    expect(state().catalogPartial).toBe(true)

    face.toggleModel('missing')
    expect(state().dirty).toBe(false)
    face.toggleModel('alpha\0fast')
    expect(state()).toMatchObject({ dirty: true, invalid: true })
    face.discard()
    expect(state()).toMatchObject({ dirty: false, invalid: false, enabled: true })

    face.toggleEnabled()
    expect(state()).toMatchObject({ dirty: true, enabled: false })
    face.toggleEnabled()
    expect(state()).toMatchObject({ dirty: false, enabled: true })
  })

  it('retains selected routes when disabling and loads an already-ready enabled card', async () => {
    const host = stubConfigForm<SubagentModelSelectionSettings>()
    acceptWrites(host)
    host.publish({
      status: 'ready', writable: true, revision: 5,
      value: { enabled: true, allowedModels: [{ provider: 'alpha', model: 'fast' }] }, user: {},
    })
    const models = modelsApi({
      groups: [{ id: 'alpha', name: 'Alpha API', models: [{ id: 'fast', name: 'Fast' }] }],
    })
    const controller = new SubagentModelSelectionCardController(host.scope, models.ctx)
    const face = controller.inject()
    await vi.waitFor(() => { expect(models.models).toHaveBeenCalledOnce() })

    face.toggleEnabled()
    face.save()
    await vi.waitFor(() => {
      expect(host.mutate).toHaveBeenCalledWith([
        { op: 'set', path: ['enabled'], value: false },
        { op: 'set', path: ['allowedModels'], value: [{ provider: 'alpha', model: 'fast' }] },
      ], 5)
    })
    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({
      enabled: false, dirty: false,
    })
  })

  it('reports a directory error and retries it', async () => {
    const host = stubConfigForm<SubagentModelSelectionSettings>()
    const models = modelsApi({ error: 'offline' })
    const controller = new SubagentModelSelectionCardController(host.scope, models.ctx)
    host.publish({ status: 'ready', writable: true, value: { enabled: false, allowedModels: [] }, user: {} })
    const face = controller.inject()
    const state = () => face.hooks.subagentModelSelectionCard.getSnapshot()

    face.toggleEnabled()
    await vi.waitFor(() => { expect(state().catalogStatus).toBe('error') })
    face.retryCatalog()
    await vi.waitFor(() => { expect(models.models).toHaveBeenCalledTimes(2) })
  })

  it('rejects a draft after the Host revision changes', async () => {
    const host = stubConfigForm<SubagentModelSelectionSettings>()
    const models = modelsApi({
      groups: [{ id: 'alpha', name: 'Alpha API', models: [{ id: 'fast', name: 'Fast' }] }],
    })
    const controller = new SubagentModelSelectionCardController(host.scope, models.ctx)
    host.publish({
      status: 'ready', writable: true, revision: 4,
      value: { enabled: false, allowedModels: [] }, user: {},
    })
    const face = controller.inject()
    face.toggleEnabled()
    await vi.waitFor(() => {
      expect(face.hooks.subagentModelSelectionCard.getSnapshot().candidates).toHaveLength(1)
    })
    face.toggleModel('alpha\0fast')

    host.publish({
      revision: 5,
      value: { enabled: true, allowedModels: [{ provider: 'other', model: 'new' }] },
    })
    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({
      conflicted: true, failed: false, dirty: true,
    })
    face.save()
    await Promise.resolve()

    expect(host.mutate).not.toHaveBeenCalled()
    face.discard()
    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({
      conflicted: false, failed: false, dirty: false, enabled: true,
    })
  })

  it('settles a draft when a newer Host revision already contains it', async () => {
    const host = stubConfigForm<SubagentModelSelectionSettings>()
    const models = modelsApi({
      groups: [{ id: 'alpha', name: 'Alpha', models: [{ id: 'fast', name: 'Fast' }] }],
    })
    const controller = new SubagentModelSelectionCardController(host.scope, models.ctx)
    host.publish({
      status: 'ready', writable: true, revision: 4,
      value: { enabled: false, allowedModels: [] }, user: {},
    })
    const face = controller.inject()
    face.toggleEnabled()
    await vi.waitFor(() => { expect(face.hooks.subagentModelSelectionCard.getSnapshot().candidates).toHaveLength(1) })
    face.toggleModel('alpha\0fast')

    host.publish({
      revision: 5,
      value: { enabled: true, allowedModels: [{ provider: 'alpha', model: 'fast' }] },
    })

    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({
      conflicted: false, dirty: false, enabled: true,
    })
  })

  it('retains unsaved routes across a catalog refresh', async () => {
    const host = stubConfigForm<SubagentModelSelectionSettings>()
    acceptWrites(host)
    host.publish({
      status: 'ready', writable: true, revision: 2,
      value: { enabled: false, allowedModels: [] }, user: {},
    })
    const refreshed = deferred<never>()
    const models = vi.fn()
      .mockResolvedValueOnce({
        ok: true, value: {
          groups: [{ id: 'alpha', name: 'Alpha', models: [{ id: 'fast', name: 'Fast' }] }],
          failures: [],
        },
      })
      .mockImplementationOnce(() => refreshed.promise)
    const controller = new SubagentModelSelectionCardController(
      host.scope, ctxWith({ session: { modelCatalog: models } }),
    )
    const face = controller.inject()
    const state = () => face.hooks.subagentModelSelectionCard.getSnapshot()
    face.toggleEnabled()
    await vi.waitFor(() => { expect(state().candidates).toHaveLength(1) })
    face.toggleModel('alpha\0fast')

    controller.refreshCatalog()
    expect(state()).toMatchObject({
      catalogStatus: 'loading',
      candidates: [expect.objectContaining({ key: 'alpha\0fast', selected: true })],
    })
    refreshed.resolve({
      ok: true, value: { groups: [], failures: [] },
    } as never)
    await vi.waitFor(() => { expect(state().catalogStatus).toBe('ready') })
    expect(state().candidates).toEqual([
      expect.objectContaining({ key: 'alpha\0fast', available: false, selected: true }),
    ])

    face.save()
    await vi.waitFor(() => {
      expect(host.mutate).toHaveBeenCalledWith([
        { op: 'set', path: ['enabled'], value: true },
        { op: 'set', path: ['allowedModels'], value: [{ provider: 'alpha', model: 'fast' }] },
      ], 2)
    })
  })

  it('drops a draft when the connection generation changes', async () => {
    const host = stubConfigForm<SubagentModelSelectionSettings>()
    const models = modelsApi({
      groups: [{ id: 'alpha', name: 'Alpha', models: [{ id: 'fast', name: 'Fast' }] }],
    })
    host.publish({
      status: 'ready', writable: true, revision: 4,
      value: { enabled: false, allowedModels: [] }, user: {},
    })
    const controller = new SubagentModelSelectionCardController(host.scope, models.ctx)
    const face = controller.inject()
    face.toggleEnabled()
    await vi.waitFor(() => { expect(face.hooks.subagentModelSelectionCard.getSnapshot().candidates).toHaveLength(1) })
    face.toggleModel('alpha\0fast')

    controller.resetConnection()
    host.publish({
      revision: 4,
      value: { enabled: true, allowedModels: [{ provider: 'other', model: 'new' }] },
    })

    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({
      conflicted: false, dirty: false, enabled: true,
    })
    face.save()
    await Promise.resolve()
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('reloads the model catalog after invalidation', async () => {
    const host = stubConfigForm<SubagentModelSelectionSettings>()
    host.publish({
      status: 'ready', writable: true, revision: 1,
      value: { enabled: true, allowedModels: [] }, user: {},
    })
    const models = vi.fn()
      .mockResolvedValueOnce({
        ok: true, value: {
          groups: [{ id: 'alpha', name: 'Alpha', models: [{ id: 'fast', name: 'Fast' }] }],
          failures: [],
        },
      })
      .mockResolvedValueOnce({
        ok: true, value: {
          groups: [{ id: 'beta', name: 'Beta', models: [{ id: 'new', name: 'New' }] }],
          failures: [],
        },
      })
    const controller = new SubagentModelSelectionCardController(
      host.scope, ctxWith({ session: { modelCatalog: models } }),
    )
    const state = () => controller.inject().hooks.subagentModelSelectionCard.getSnapshot()
    await vi.waitFor(() => { expect(state().candidates[0]?.provider).toBe('alpha') })

    controller.refreshCatalog()

    await vi.waitFor(() => { expect(state().candidates[0]?.provider).toBe('beta') })
    expect(models).toHaveBeenCalledTimes(2)
  })

  it('suppresses duplicate actions and late save settlements', async () => {
    const host = stubConfigForm<SubagentModelSelectionSettings>()
    const catalog = modelsApi({
      groups: [{ id: 'alpha', name: 'Alpha API', models: [{ id: 'fast', name: 'Fast' }] }],
    })
    const write = deferred<undefined>()
    const mutate = vi.fn(async (ops: readonly SettingsPathOpView[]) => {
      await write.promise
      const enabled = ops.find(op => op.path[0] === 'enabled')
      const allowedModels = ops.find(op => op.path[0] === 'allowedModels')
      host.publish({ value: {
        enabled: enabled?.op === 'set' ? enabled.value as boolean : false,
        allowedModels: allowedModels?.op === 'set' ? allowedModels.value as never[] : [],
      } })
      return true
    })
    const controller = new SubagentModelSelectionCardController({ ...host.scope, mutate }, catalog.ctx)
    const face = controller.inject()

    face.save()
    face.toggleModel('alpha\0fast')
    host.publish({ status: 'ready', writable: true, value: { enabled: false, allowedModels: [] }, user: {} })
    face.save()
    face.toggleEnabled()
    await vi.waitFor(() => { expect(face.hooks.subagentModelSelectionCard.getSnapshot().catalogStatus).toBe('ready') })
    face.save()
    face.toggleModel('alpha\0fast')
    face.save()
    expect(face.hooks.subagentModelSelectionCard.getSnapshot().saving).toBe(true)
    face.toggleEnabled()
    face.toggleModel('alpha\0fast')
    face.save()
    face.discard()
    controller.dispose()
    write.resolve(undefined)
    await write.promise
    expect(mutate).toHaveBeenCalledOnce()
  })

  it('suppresses duplicate directory loads and late settlements', async () => {
    const host = stubConfigForm<SubagentModelSelectionSettings>()
    host.publish({ status: 'ready', writable: true, value: { enabled: false, allowedModels: [] }, user: {} })

    const pending = deferred<never>()
    const models = vi.fn(() => pending.promise)
    const controller = new SubagentModelSelectionCardController(host.scope, ctxWith({ session: { modelCatalog: models } }))
    const face = controller.inject()
    face.toggleEnabled()
    face.retryCatalog()
    expect(models).toHaveBeenCalledOnce()
    controller.dispose()
    pending.resolve({ ok: false, error: new RemoteError('gateway/internal', 'late failure', {}) } as never)
    await pending.promise

    const pendingResolve = deferred<never>()
    const resolving = new SubagentModelSelectionCardController(
      host.scope,
      ctxWith({ session: { modelCatalog: () => pendingResolve.promise } }),
    )
    const resolvingFace = resolving.inject()
    resolvingFace.toggleEnabled()
    resolving.dispose()
    pendingResolve.resolve({
      ok: true, value: { groups: [], failures: [] },
    } as never)
    await pendingResolve.promise
  })

  it('ignores writes while read-only and scope notifications after disposal', () => {
    const host = stubConfigForm<SubagentModelSelectionSettings>()
    const controller = new SubagentModelSelectionCardController(host.scope, modelsApi().ctx)
    host.publish({ status: 'ready', writable: false, value: { enabled: false, allowedModels: [] }, user: {} })
    const face = controller.inject()

    face.toggleEnabled()
    face.toggleModel('alpha\0fast')
    face.save()
    expect(host.mutate).not.toHaveBeenCalled()

    controller.dispose()
    controller.refreshCatalog()
    controller.resetConnection()
    face.toggleEnabled()
    face.retryCatalog()
    face.save()
    host.publish({ value: { enabled: true, allowedModels: [{ provider: 'alpha', model: 'fast' }] } })
    expect(host.mutate).not.toHaveBeenCalled()
    expect(face.hooks.subagentModelSelectionCard.getSnapshot().enabled).toBe(false)
  })
})

describe('SubagentLimitsCardController', () => {
  it('validates staged limits, saves them, and restores composed defaults', async () => {
    const host = stubConfigForm<SubagentLimitsSettings>()
    const face = new SubagentLimitsCardController(host.scope).inject()
    const state = () => face.hooks.subagentLimitsCard.getSnapshot()
    host.publish({ status: 'ready', writable: true, value: { maxDepth: 3, maxActiveSubagents: 8 }, base: { maxDepth: 3, maxActiveSubagents: 8 }, user: {} })
    acceptWrites(host)
    expect(state().maxActiveSubagents.text).toBe('8')
    for (const draft of ['-1', '1.5', '9007199254740992', 'wat', '-0']) {
      face.edit('maxDepth', draft)
      expect(state().invalid).toBe(true)
    }
    face.edit('maxDepth', '0')
    face.edit('maxActiveSubagents', '0')
    expect(state().invalid).toBe(true)
    face.edit('maxActiveSubagents', '12')
    expect(host.set).not.toHaveBeenCalled()
    face.save()
    await vi.waitFor(() => { expect(state().saving).toBe(false) })
    expect(host.scope.getSnapshot().value).toEqual({ maxDepth: 0, maxActiveSubagents: 12 })
    face.resetField('maxDepth')
    face.edit('maxActiveSubagents', '')
    expect(state().invalid).toBe(false)
    face.save()
    await vi.waitFor(() => { expect(state().saving).toBe(false) })
    expect(host.scope.getSnapshot().value).toEqual({ maxDepth: 3, maxActiveSubagents: 8 })
  })
})

describe('shared Subagent card actions', () => {
  function card() {
    const limits = stubConfigForm<SubagentLimitsSettings>()
    const models = stubConfigForm<SubagentModelSelectionSettings>()
    const limitFace = new SubagentLimitsCardController(limits.scope).inject()
    const modelFace = new SubagentModelSelectionCardController(models.scope, modelsApi().ctx).inject()
    limits.publish({
      status: 'ready', writable: true, revision: 2,
      value: { maxDepth: 3, maxActiveSubagents: 8 },
      base: { maxDepth: 3, maxActiveSubagents: 8 }, user: {},
    })
    models.publish({
      status: 'ready', writable: true, revision: 5,
      value: { enabled: false, allowedModels: [{ provider: 'alpha', model: 'fast' }] }, user: {},
    })
    acceptWrites(limits)
    acceptWrites(models)
    const face = subagentCardFace(limitFace, modelFace)
    const state = () => subagentCardShell(
      face.hooks.subagentLimitsCard.getSnapshot(),
      face.hooks.subagentModelSelectionCard.getSnapshot(),
    )
    return { limits, models, face, state }
  }

  it('saves both drafts through their existing namespaces from one action', async () => {
    const { limits, models, face, state } = card()
    face.editLimit('maxDepth', '2')
    face.toggleEnabled()
    face.save()
    await vi.waitFor(() => { expect(state()).toMatchObject({ saving: false, dirty: false, failed: false }) })
    expect(limits.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['maxDepth'], value: 2 }], 2)
    expect(models.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['enabled'], value: true },
      { op: 'set', path: ['allowedModels'], value: [{ provider: 'alpha', model: 'fast' }] },
    ], 5)
  })

  it('saves a limit-only draft without rewriting model authorization', async () => {
    const { limits, models, face, state } = card()
    face.editLimit('maxDepth', '2')
    face.save()
    await vi.waitFor(() => { expect(state()).toMatchObject({ saving: false, dirty: false, failed: false }) })
    expect(limits.scope.getSnapshot().value?.maxDepth).toBe(2)
    expect(models.mutate).not.toHaveBeenCalled()
    expect(models.scope.getSnapshot().value?.enabled).toBe(false)
  })

  it('retains the pending draft when discard is requested before both writes finish', async () => {
    const { limits, face, state } = card()
    const pending = deferred<undefined>()
    const set = vi.spyOn(limits.scope, 'mutate').mockImplementationOnce(async () => {
      await pending.promise
      limits.publish({ value: { maxDepth: 2, maxActiveSubagents: 8 }, user: { maxDepth: 2 } })
      return true
    })
    face.editLimit('maxDepth', '2')
    face.toggleEnabled()
    face.save()
    try {
      await vi.waitFor(() => {
        expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({ saving: false, dirty: false })
      })
      expect(state().saving).toBe(true)
      expect(set).toHaveBeenCalledWith([{ op: 'set', path: ['maxDepth'], value: 2 }], 2)
      face.discard()
      expect(face.hooks.subagentLimitsCard.getSnapshot()).toMatchObject({ dirty: true, maxDepth: { text: '2' } })
    } finally {
      pending.resolve(undefined)
      await vi.waitFor(() => { expect(state().saving).toBe(false) })
    }
    expect(state()).toMatchObject({ dirty: false, failed: false })
    expect(limits.scope.getSnapshot().value?.maxDepth).toBe(2)
  })

  it('writes neither namespace when either draft is invalid and discards both', () => {
    const { limits, models, face, state } = card()
    face.editLimit('maxDepth', '1.5')
    face.toggleEnabled()
    face.save()
    expect(limits.set).not.toHaveBeenCalled()
    expect(models.mutate).not.toHaveBeenCalled()
    face.discard()
    expect(state()).toMatchObject({ dirty: false, invalid: false })
    expect(face.hooks.subagentLimitsCard.getSnapshot().maxDepth.text).toBe('3')
    expect(face.hooks.subagentModelSelectionCard.getSnapshot().enabled).toBe(false)
  })

  it('retains a rejected model draft after limits save, and retries only that draft', async () => {
    const { limits, models, face, state } = card()
    models.mutate.mockResolvedValueOnce(false)
    face.editLimit('maxDepth', '2')
    face.toggleEnabled()
    face.save()
    await vi.waitFor(() => { expect(state()).toMatchObject({ saving: false, dirty: true, failed: true }) })
    expect(face.hooks.subagentLimitsCard.getSnapshot().dirty).toBe(false)
    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({ enabled: true, dirty: true })
    face.save()
    await vi.waitFor(() => { expect(state()).toMatchObject({ saving: false, dirty: false, failed: false }) })
    expect(limits.mutate).toHaveBeenCalledOnce()
    expect(models.mutate).toHaveBeenCalledTimes(2)
  })
})
