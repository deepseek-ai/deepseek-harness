import { describe, expect, it, vi } from 'vitest'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError, stubConfigForm, type StubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import {
  WebSearchCardController,
  type WebApiSettings, type WebProviderSelection, type WebSearchSettings,
} from '../src/client/web-search-card-controller.ts'

/** Make the stub behave like a Host that accepts every write. */
function acceptWrites<T>(host: StubConfigForm<T>): void {
  const section = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().value as object })
  const layer = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().user as object })
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
}

/** The card plugin's context, scripted down to the namespaces a card reaches. */
function ctxWith(namespaces: object) {
  return { remote: namespaces } as never
}

function credentialsApi(configured: boolean) {
  const describe = vi.fn((refs: readonly string[]) => Promise.resolve({
    ok: true as const,
    value: Object.fromEntries(refs.map(ref => [ref, { configured, writable: true }])),
  }))
  const set = vi.fn(() => Promise.resolve({ ok: true as const, value: undefined }))
  return { ctx: ctxWith({ credentials: { describe, set } }), describe, set }
}

/** Shipped composition: Messages search with local HTTP fetch. */
const SHIPPED_SELECTION = { searchProvider: 'deepseek-official', fetchProvider: 'http' }

/**
 * Mount the controller over three stub scopes.
 * @param options - whether each Host accepts writes, the credential answer, and the selection's composed layer.
 * @returns the scopes, the controller, its face, and a state reader.
 */
function bench(options: { accept?: boolean; configured?: boolean; ctx?: never } = {}) {
  const web = stubConfigForm<WebProviderSelection>()
  const messages = stubConfigForm<WebSearchSettings>()
  const api = stubConfigForm<WebApiSettings>()
  if (options.accept === true) {
    acceptWrites(web)
    acceptWrites(messages)
    acceptWrites(api)
  }
  const credentials = credentialsApi(options.configured ?? true)
  const controller = new WebSearchCardController(
    { web: web.scope, messages: messages.scope, api: api.scope }, options.ctx ?? credentials.ctx,
  )
  const face = controller.inject()
  return { web, messages, api, credentials, controller, face, state: () => face.hooks.webSearchCard.getSnapshot() }
}

/** Serve all three sections, with the shipped selection unless one is given. */
/** Selection layers a scenario overrides. */
type SelectionLayers = { value?: WebProviderSelection; base?: WebProviderSelection; user?: WebProviderSelection }

function serve(b: ReturnType<typeof bench>, selection: SelectionLayers = {}): void {
  b.web.publish({ status: 'ready', writable: true, value: SHIPPED_SELECTION, base: SHIPPED_SELECTION, user: {}, ...selection })
  b.messages.publish({ status: 'ready', writable: true, value: { maxUses: 5 }, base: {}, user: {} })
  b.api.publish({ status: 'ready', writable: true, value: { count: 10 }, base: { count: 10 }, user: {} })
}

describe('WebSearchCardController credential', () => {
  it('reads once per settings publication wave after the eager read', async () => {
    const b = bench()
    try {
      expect(b.credentials.describe).toHaveBeenCalledTimes(1)
      serve(b)
      await Promise.resolve()
      expect(b.credentials.describe).toHaveBeenCalledTimes(2)
      serve(b)
      await Promise.resolve()
      expect(b.credentials.describe).toHaveBeenCalledTimes(3)
      for (const args of b.credentials.describe.mock.calls) expect(args).toEqual([['DEEPSEEK_API_KEY']])
    } finally { b.controller.dispose() }
  })

  it('reads once when a settings publication wave renames the credential reference', async () => {
    const b = bench()
    try {
      serve(b)
      await vi.waitFor(() => { expect(b.state().apiKeyConfigured).toBe(true) })
      const count = b.credentials.describe.mock.calls.length
      b.messages.publish({ value: { apiKeyEnv: 'RENAMED_KEY' } })
      expect(b.state().apiKeyConfigured).toBe(false)
      await Promise.resolve()
      expect(b.credentials.describe).toHaveBeenCalledTimes(count + 1)
      expect(b.credentials.describe).toHaveBeenLastCalledWith(['RENAMED_KEY'])
    } finally { b.controller.dispose() }
  })

  it.each(['before', 'after'])('keeps the credential update when the pending settings read finishes %s it', async (order) => {
    const b = bench({ configured: false })
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof b.credentials.describe>>>()
    const updated = Promise.withResolvers<Awaited<ReturnType<typeof b.credentials.describe>>>()
    try {
      await Promise.resolve()
      b.credentials.describe.mockImplementationOnce(() => pending.promise)
      serve(b)
      await Promise.resolve()
      const count = b.credentials.describe.mock.calls.length
      b.credentials.describe.mockImplementationOnce(() => updated.promise)
      b.controller.refreshCredential('DEEPSEEK_API_KEY')
      expect(b.credentials.describe).toHaveBeenCalledTimes(count + 1)
      if (order === 'before') {
        pending.resolve({ ok: true, value: { DEEPSEEK_API_KEY: { configured: false, writable: true } } })
        await Promise.resolve()
      }
      updated.resolve({ ok: true, value: { DEEPSEEK_API_KEY: { configured: true, writable: true } } })
      await vi.waitFor(() => { expect(b.state().apiKeyConfigured).toBe(true) })
      pending.resolve({ ok: true, value: { DEEPSEEK_API_KEY: { configured: false, writable: true } } })
      await Promise.resolve()
      expect(b.state().apiKeyConfigured).toBe(true)
    } finally {
      b.controller.dispose()
      pending.resolve({ ok: true, value: {} })
      updated.resolve({ ok: true, value: {} })
      await Promise.all([pending.promise, updated.promise])
    }
  })

  it('discards queued reads and late credential answers after disposal', async () => {
    const b = bench({ configured: false })
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof b.credentials.describe>>>()
    const publish = vi.fn()
    const off = b.face.hooks.webSearchCard.subscribe(publish)
    try {
      await Promise.resolve()
      b.credentials.describe.mockImplementationOnce(() => pending.promise)
      b.controller.refreshCredential('DEEPSEEK_API_KEY')
      serve(b)
      b.controller.dispose()
      const count = b.credentials.describe.mock.calls.length
      publish.mockClear()
      pending.resolve({ ok: true, value: { DEEPSEEK_API_KEY: { configured: true, writable: true } } })
      await Promise.resolve()
      expect(b.credentials.describe).toHaveBeenCalledTimes(count)
      expect(publish).not.toHaveBeenCalled()
      expect(b.state().apiKeyConfigured).toBe(false)
      b.controller.refreshCredential('DEEPSEEK_API_KEY')
      serve(b)
      await Promise.resolve()
      expect(b.credentials.describe).toHaveBeenCalledTimes(count)
    } finally {
      off()
      b.controller.dispose()
      pending.resolve({ ok: true, value: {} })
      await pending.promise
    }
  })

  it('reads the credential state for the reference the selected section names', async () => {
    const b = bench()
    await vi.waitFor(() => { expect(b.credentials.describe).toHaveBeenCalled() })
    serve(b)
    await vi.waitFor(() => { expect(b.state().apiKeyConfigured).toBe(true) })
    expect(b.state()).toMatchObject({ baseURL: { text: '', overridden: false }, apiKey: { text: '', overridden: false } })
    b.controller.dispose()
  })

  it('keeps an unknown credential reference writable and unconfigured', async () => {
    const b = bench()
    try {
      await vi.waitFor(() => { expect(b.state().apiKeyConfigured).toBe(true) })
      b.credentials.describe.mockResolvedValue({ ok: true, value: {} })
      b.controller.refreshCredential('DEEPSEEK_API_KEY')
      await vi.waitFor(() => { expect(b.state()).toMatchObject({ apiKeyConfigured: false, apiKeyWritable: true }) })
    } finally { b.controller.dispose() }
  })

  it('writes the staged key through the credentials domain, never a settings section', async () => {
    const b = bench({ configured: false })
    serve(b)
    b.face.edit('apiKey', ' ds-secret ')
    expect(b.state().dirty).toBe(true)
    expect(b.credentials.set).not.toHaveBeenCalled()
    b.credentials.describe.mockImplementation((refs: readonly string[]) => Promise.resolve({
      ok: true as const, value: Object.fromEntries(refs.map(ref => [ref, { configured: true, writable: true }])),
    }))
    b.face.save()
    await vi.waitFor(() => { expect(b.credentials.set).toHaveBeenCalledWith('DEEPSEEK_API_KEY', 'ds-secret') })
    for (const host of [b.web, b.messages, b.api]) expect(host.mutate).not.toHaveBeenCalled()
    await vi.waitFor(() => { expect(b.state()).toMatchObject({ dirty: false, apiKeyConfigured: true }) })
    b.controller.dispose()
  })

  it('accepts its successful key readback while a newer credential read is pending', async () => {
    const b = bench({ configured: false })
    const readback = Promise.withResolvers<Awaited<ReturnType<typeof b.credentials.describe>>>()
    const newer = Promise.withResolvers<Awaited<ReturnType<typeof b.credentials.describe>>>()
    try {
      serve(b)
      await vi.waitFor(() => { expect(b.credentials.describe).toHaveBeenCalledTimes(2) })
      b.credentials.describe.mockImplementationOnce(() => readback.promise)
      b.face.edit('apiKey', 'ds-secret')
      b.face.save()
      await vi.waitFor(() => { expect(b.credentials.describe).toHaveBeenCalledTimes(3) })
      b.credentials.describe.mockImplementationOnce(() => newer.promise)
      b.controller.refreshCredential('DEEPSEEK_API_KEY')
      expect(b.credentials.describe).toHaveBeenCalledTimes(4)
      readback.resolve({ ok: true, value: { DEEPSEEK_API_KEY: { configured: true, writable: true } } })
      await vi.waitFor(() => { expect(b.state()).toMatchObject({ dirty: false, saving: false, failed: false }) })
      newer.resolve({ ok: true, value: { DEEPSEEK_API_KEY: { configured: true, writable: true } } })
      await vi.waitFor(() => { expect(b.state().apiKeyConfigured).toBe(true) })
    } finally {
      b.controller.dispose()
      readback.resolve({ ok: true, value: {} })
      newer.resolve({ ok: true, value: {} })
      await Promise.all([readback.promise, newer.promise])
    }
  })

  it('keeps the stored key when the draft is left blank', () => {
    const b = bench()
    serve(b)
    b.face.edit('apiKey', '   ')
    expect(b.state().dirty).toBe(false)
    b.face.save()
    expect(b.credentials.set).not.toHaveBeenCalled()
    b.controller.dispose()
  })

  it('re-reads only when the Host reports the watched reference changed', async () => {
    const b = bench({ configured: false })
    serve(b)
    await vi.waitFor(() => { expect(b.credentials.describe).toHaveBeenCalled() })
    b.credentials.describe.mockClear()
    b.controller.refreshCredential('OTHER_KEY')
    expect(b.credentials.describe).not.toHaveBeenCalled()
    b.credentials.describe.mockImplementation((refs: readonly string[]) => Promise.resolve({
      ok: true as const, value: Object.fromEntries(refs.map(ref => [ref, { configured: true, writable: true }])),
    }))
    b.controller.refreshCredential('DEEPSEEK_API_KEY')
    await vi.waitFor(() => { expect(b.state().apiKeyConfigured).toBe(true) })
    b.controller.dispose()
  })

  it('addresses the reference the selected API section declares', async () => {
    const b = bench({ accept: true })
    serve(b)
    b.messages.publish({ value: { apiKeyEnv: 'MESSAGES_KEY' } })
    b.api.publish({ value: { apiKeyEnv: 'API_KEY', count: 10 } })
    await vi.waitFor(() => { expect(b.credentials.describe).toHaveBeenLastCalledWith(['MESSAGES_KEY']) })
    b.face.setSearchApi(true)
    await vi.waitFor(() => { expect(b.credentials.describe).toHaveBeenLastCalledWith(['API_KEY']) })
    b.face.edit('apiKey', 'ds-secret')
    b.face.save()
    await vi.waitFor(() => { expect(b.credentials.set).toHaveBeenCalledWith('API_KEY', 'ds-secret') })
    b.controller.dispose()
  })

  it('reports a key the Host did not store as a failed save', async () => {
    const b = bench({ configured: false })
    serve(b)
    b.face.edit('apiKey', 'ds-secret')
    b.face.save()
    await vi.waitFor(() => { expect(b.state()).toMatchObject({ failed: true, dirty: true, apiSwitchBlocked: true }) })
    b.controller.dispose()
  })

  it('keeps the card usable when the credential read and write are refused', async () => {
    const refusal = () => Promise.resolve({
      ok: false as const,
      error: new RemoteError('credential/rejected', 'offline', { ref: 'DEEPSEEK_API_KEY' }),
    })
    const describe = vi.fn(refusal)
    const set = vi.fn(refusal)
    const b = bench({ ctx: ctxWith({ credentials: { describe, set } }) })
    await vi.waitFor(() => { expect(describe).toHaveBeenCalled() })
    serve(b)
    b.face.edit('apiKey', 'ds-secret')
    b.face.save()
    await vi.waitFor(() => { expect(set).toHaveBeenCalled() })
    expect(b.state()).toMatchObject({ available: true, apiKeyConfigured: false, baseURL: { text: '' } })
    b.controller.dispose()
  })

  it('clears a changed reference immediately and drops its previous pending answer', async () => {
    const b = bench()
    const previous = Promise.withResolvers<Awaited<ReturnType<typeof b.credentials.describe>>>()
    const renamed = Promise.withResolvers<Awaited<ReturnType<typeof b.credentials.describe>>>()
    try {
      serve(b)
      await vi.waitFor(() => { expect(b.state().apiKeyConfigured).toBe(true) })
      b.credentials.describe.mockImplementationOnce(() => previous.promise)
      b.controller.refreshCredential('DEEPSEEK_API_KEY')
      b.credentials.describe.mockImplementation(() => renamed.promise)
      b.messages.publish({ value: { apiKeyEnv: 'RENAMED_KEY' } })
      expect(b.state().apiKeyConfigured).toBe(false)
      previous.resolve({ ok: true, value: { DEEPSEEK_API_KEY: { configured: true, writable: true } } })
      await Promise.resolve()
      expect(b.state().apiKeyConfigured).toBe(false)
      renamed.resolve({ ok: true, value: { RENAMED_KEY: { configured: true, writable: false } } })
      await vi.waitFor(() => { expect(b.state()).toMatchObject({ apiKeyConfigured: true, apiKeyWritable: false }) })
    } finally {
      b.controller.dispose()
      previous.resolve({ ok: true, value: {} })
      renamed.resolve({ ok: true, value: {} })
      await Promise.all([previous.promise, renamed.promise])
    }
  })
})

describe('WebSearchCardController sections', () => {
  it('saves the Messages endpoint and search budget together', async () => {
    const b = bench({ accept: true })
    serve(b)
    b.face.edit('baseURL', 'https://other.test')
    b.face.edit('maxUses', '3')
    b.face.save()
    await vi.waitFor(() => { expect(b.messages.mutate).toHaveBeenCalledTimes(1) })
    expect(b.messages.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['baseURL'], value: 'https://other.test' },
      { op: 'set', path: ['maxUses'], value: 3 },
    ], undefined)
    expect(b.web.mutate).not.toHaveBeenCalled()
    expect(b.api.mutate).not.toHaveBeenCalled()
    b.controller.dispose()
  })

  /**
   * Edit the selected section's endpoint, save, reset, and save again.
   * @param b - the mounted controller.
   * @param host - the selected section's scope.
   * @param composed - the composed endpoint the field shows without an override.
   */
  async function endpointRoundTrip<T extends { baseURL?: string }>(
    b: ReturnType<typeof bench>, host: StubConfigForm<T>, composed: string,
  ): Promise<void> {
    expect(b.state().baseURL).toEqual({ text: composed, overridden: false, invalid: false })
    b.face.edit('baseURL', 'https://custom.test/tools')
    b.face.save()
    await vi.waitFor(() => { expect(b.state().dirty).toBe(false) })
    expect(host.mutate).toHaveBeenLastCalledWith([{ op: 'set', path: ['baseURL'], value: 'https://custom.test/tools' }], undefined)
    expect(b.state().baseURL).toMatchObject({ text: 'https://custom.test/tools', overridden: true })
    b.face.resetField('baseURL')
    expect(b.state().baseURL).toMatchObject({ text: composed, overridden: false })
    b.face.save()
    await vi.waitFor(() => { expect(b.state().dirty).toBe(false) })
    expect(host.mutate).toHaveBeenLastCalledWith([{ op: 'unset', path: ['baseURL'] }], undefined)
    expect(b.state().baseURL).toMatchObject({ text: composed, overridden: false })
  }

  it('edits the Messages endpoint while the switch is off', async () => {
    const b = bench({ accept: true })
    serve(b)
    try { await endpointRoundTrip(b, b.messages, '') } finally { b.controller.dispose() }
    expect(b.api.mutate).not.toHaveBeenCalled()
  })

  it('edits the Search / Fetch API endpoint while the switch is on', async () => {
    const b = bench({ accept: true })
    serve(b, { value: { searchProvider: 'deepseek-search-api' } })
    const composed = { count: 10, baseURL: 'https://api.deepseek.com/v1/tools' }
    b.api.publish({ value: composed, base: composed })
    try { await endpointRoundTrip(b, b.api, composed.baseURL) } finally { b.controller.dispose() }
    expect(b.messages.mutate).not.toHaveBeenCalled()
  })

  it.each(['0', '51', '1.5', 'many', 'Infinity'])('rejects an unsupported Search API result count: %s', (text) => {
    const b = bench()
    serve(b, { value: { searchProvider: 'deepseek-search-api' } })
    b.face.edit('count', text)
    expect(b.state()).toMatchObject({ invalid: true, apiSwitchBlocked: true, count: { text, invalid: true } })
    b.face.save()
    expect(b.api.mutate).not.toHaveBeenCalled()
    b.controller.dispose()
  })

  it.each(['1', '50', '   '])('saves a supported Search API result count or restores its default: %j', async (text) => {
    const b = bench({ accept: true })
    serve(b, { value: { searchProvider: 'deepseek-search-api' } })
    b.api.publish({ value: { count: 20 }, base: { count: 10 }, user: { count: 20 } })
    b.face.edit('count', text)
    expect(b.state().invalid).toBe(false)
    b.face.save()
    await vi.waitFor(() => { expect(b.state().dirty).toBe(false) })
    expect(b.api.mutate).toHaveBeenCalledWith([
      text.trim() === '' ? { op: 'unset', path: ['count'] } : { op: 'set', path: ['count'], value: Number(text) },
    ], undefined)
    expect(b.state().count.text).toBe(text.trim() === '' ? '10' : text)
    b.controller.dispose()
  })
})

describe('WebSearchCardController API switch', () => {
  it('stages both provider selections, discards them, and clears them back to the shipped defaults', async () => {
    const b = bench({ accept: true })
    serve(b)
    b.messages.publish({ value: { baseURL: 'https://messages.test/v1', maxUses: 5 }, user: { baseURL: 'https://messages.test/v1' } })
    const state = b.state
    expect(state()).toMatchObject({ apiSwitchAvailable: true, useSearchApi: false })
    b.face.setSearchApi(true)
    expect(state()).toMatchObject({ useSearchApi: true, dirty: true, baseURL: { text: '' } })
    expect(b.web.mutate).not.toHaveBeenCalled()
    b.face.discard()
    expect(state().useSearchApi).toBe(false)
    b.face.setSearchApi(true)
    b.face.save()
    await vi.waitFor(() => { expect(state().dirty).toBe(false) })
    expect(b.web.mutate).toHaveBeenLastCalledWith([
      { op: 'set', path: ['searchProvider'], value: 'deepseek-search-api' },
      { op: 'set', path: ['fetchProvider'], value: 'deepseek-fetch-api' },
    ], undefined)
    expect(state().useSearchApi).toBe(true)
    b.face.setSearchApi(false)
    b.face.save()
    await vi.waitFor(() => { expect(state().dirty).toBe(false) })
    expect(b.web.mutate).toHaveBeenLastCalledWith([
      { op: 'unset', path: ['searchProvider'] },
      { op: 'unset', path: ['fetchProvider'] },
    ], undefined)
    expect(state()).toMatchObject({ useSearchApi: false, baseURL: { text: 'https://messages.test/v1' } })
    expect(b.messages.mutate).not.toHaveBeenCalled()
    b.controller.dispose()
  })

  it('writes explicit Messages selections when the deployment composes the APIs', async () => {
    const api = { searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' }
    const b = bench({ accept: true })
    serve(b, { value: api, base: api })
    expect(b.state().useSearchApi).toBe(true)
    b.face.setSearchApi(false)
    b.face.save()
    await vi.waitFor(() => { expect(b.state().dirty).toBe(false) })
    expect(b.web.mutate).toHaveBeenLastCalledWith([
      { op: 'set', path: ['searchProvider'], value: 'deepseek-official' },
      { op: 'set', path: ['fetchProvider'], value: 'http' },
    ], undefined)
    b.face.setSearchApi(true)
    b.face.save()
    await vi.waitFor(() => { expect(b.state().dirty).toBe(false) })
    expect(b.web.mutate).toHaveBeenLastCalledWith([
      { op: 'unset', path: ['searchProvider'] },
      { op: 'unset', path: ['fetchProvider'] },
    ], undefined)
    b.controller.dispose()
  })

  it('saves the selected API section before the selection that starts using it', async () => {
    const b = bench({ accept: true })
    serve(b)
    const order: string[] = []
    for (const [name, host] of [['web', b.web], ['api', b.api]] as const) {
      const accept = host.mutate.getMockImplementation()!
      host.mutate.mockImplementation((ops, revision) => { order.push(name); return accept(ops, revision) })
    }
    b.face.setSearchApi(true)
    b.face.edit('baseURL', 'https://search-api.test/v1/tools')
    b.face.save()
    await vi.waitFor(() => { expect(b.state().dirty).toBe(false) })
    expect(order).toEqual(['api', 'web'])
    b.controller.dispose()
  })

  it('keeps the selection staged when a provider section refuses its save', async () => {
    const b = bench({ accept: true })
    serve(b)
    b.api.mutate.mockImplementation(() => Promise.resolve(false))
    b.face.setSearchApi(true)
    b.face.edit('count', '20')
    b.face.save()
    await vi.waitFor(() => { expect(b.state().failed).toBe(true) })
    expect(b.web.mutate).not.toHaveBeenCalled()
    expect(b.state()).toMatchObject({ useSearchApi: true, dirty: true, apiSwitchBlocked: true })
    b.controller.dispose()
  })

  it('locks the API switch while an invalid edit is staged', () => {
    const b = bench()
    serve(b)
    expect(b.state().apiSwitchBlocked).toBe(false)
    b.face.edit('maxUses', 'many')
    expect(b.state()).toMatchObject({ invalid: true, apiSwitchBlocked: true })
    b.face.save()
    expect(b.messages.mutate).not.toHaveBeenCalled()
    b.face.discard()
    expect(b.state().apiSwitchBlocked).toBe(false)
    b.controller.dispose()
  })

  it.each(['web', 'api'] as const)('hides the switch and shows Messages settings while %s is not served', (missing) => {
    const b = bench()
    serve(b, { value: { searchProvider: 'deepseek-search-api' } })
    b[missing].publish({ status: 'unavailable' })
    expect(b.state()).toMatchObject({ available: true, apiSwitchAvailable: false, useSearchApi: false })
    b.controller.dispose()
  })

  it('saves nothing before the Messages section is served or while a save runs', async () => {
    const b = bench({ accept: true })
    b.face.save()
    expect(b.state().available).toBe(false)
    serve(b)
    let release: (accepted: boolean) => void = () => {}
    b.messages.mutate.mockImplementation(() => new Promise<boolean>((resolve) => { release = resolve }))
    b.face.edit('maxUses', '3')
    b.face.save()
    await vi.waitFor(() => { expect(b.state().saving).toBe(true) })
    b.face.save()
    release(true)
    await vi.waitFor(() => { expect(b.state().saving).toBe(false) })
    expect(b.messages.mutate).toHaveBeenCalledTimes(1)
    b.controller.dispose()
  })

  it('releases every subscription on dispose', () => {
    const b = bench()
    serve(b)
    b.controller.dispose()
    for (const host of [b.web, b.messages, b.api]) expect(host.listenerCount()).toBe(0)
  })
})
