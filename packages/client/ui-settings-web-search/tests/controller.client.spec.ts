import { describe, expect, it, vi } from 'vitest'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError, stubConfigForm, type StubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import {
  WebSearchCardController,
  type WebApiSettings, type WebLegacySettings, type WebProviderSelection,
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

/** Providers the shipped composition registers, in registration order. */
const SHIPPED_PROVIDERS = {
  search: [{ id: 'deepseek-search-api' }, { id: 'deepseek-official' }],
  fetch: [{ id: 'http' }, { id: 'deepseek-fetch-api' }],
}

type ProviderEntry = { id: string; title?: string; description?: { en: string; [locale: string]: string } }
type ProviderList = { search: ProviderEntry[]; fetch: ProviderEntry[] }
type ProviderResponse = { ok: true; value: ProviderList } | { ok: false; error: RemoteError }

/** The legacy key's default reference. */
const LEGACY_KEY = 'DEEPSEEK_API_KEY'

function remoteApi(configured: boolean | Record<string, boolean>) {
  const answer = (ref: string) => typeof configured === 'boolean' ? configured : configured[ref] ?? false
  const describe = vi.fn((refs: readonly string[]) => Promise.resolve({
    ok: true as const,
    value: Object.fromEntries(refs.map(ref => [ref, { configured: answer(ref), writable: true }])),
  }))
  const set = vi.fn(() => Promise.resolve({ ok: true as const, value: undefined }))
  const listProviders = vi.fn((): Promise<ProviderResponse> => Promise.resolve({ ok: true, value: SHIPPED_PROVIDERS }))
  return { ctx: ctxWith({ credentials: { describe, set }, web: { listProviders } }), describe, set, listProviders }
}

/** The shipped composition's selection: the DeepSeek Search API and local HTTP fetch. */
const SHIPPED_SELECTION = { searchProvider: 'deepseek-search-api', fetchProvider: 'http' }

/** Legacy Messages search with local HTTP fetch, the selection that shows the key control. */
const LEGACY_SELECTION = { searchProvider: 'deepseek-official', fetchProvider: 'http' }

/**
 * Mount the controller over three stub scopes.
 * @param options - whether each Host accepts writes, the credential answer, and a replacement context.
 * @returns the scopes, the controller, its face, and a state reader.
 */
function bench(options: { accept?: boolean; configured?: boolean | Record<string, boolean>; ctx?: never } = {}) {
  const web = stubConfigForm<WebProviderSelection>()
  const api = stubConfigForm<WebApiSettings>()
  const legacy = stubConfigForm<WebLegacySettings>()
  if (options.accept === true) {
    acceptWrites(web)
    acceptWrites(api)
    acceptWrites(legacy)
  }
  const remote = remoteApi(options.configured ?? true)
  const controller = new WebSearchCardController({ web: web.scope, api: api.scope, legacy: legacy.scope }, options.ctx ?? remote.ctx)
  const face = controller.inject()
  return {
    web, api, legacy, credentials: remote, controller, face, state: () => face.hooks.webSearchCard.getSnapshot(),
  }
}

/** Selection layers a scenario overrides. */
type SelectionLayers = { value?: WebProviderSelection; base?: WebProviderSelection; user?: WebProviderSelection }

/** The API section the shipped composition resolves: the schema defaults. */
const API_DEFAULTS: WebApiSettings = { count: 10 }

/**
 * Serve all three sections, with the shipped selection unless one is given,
 * the API section composed as `composed`, and the legacy section as `legacy`,
 * each with no user layer.
 */
function serve(
  b: ReturnType<typeof bench>, selection: SelectionLayers = {}, composed: WebApiSettings = API_DEFAULTS,
  legacy: WebLegacySettings = { maxUses: 5 },
): void {
  b.web.publish({ status: 'ready', writable: true, value: SHIPPED_SELECTION, base: SHIPPED_SELECTION, user: {}, ...selection })
  b.api.publish({ status: 'ready', writable: true, value: composed, base: composed, user: {} })
  b.legacy.publish({ status: 'ready', writable: true, value: legacy, base: legacy, user: {} })
}

/** Both DeepSeek API providers selected. */
const API_SELECTION = { searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' }

/** The shipped providers plus the plugin providers `exa` (Search) and `jina` (Fetch). */
const WITH_PLUGINS = {
  search: [...SHIPPED_PROVIDERS.search, { id: 'exa' }],
  fetch: [...SHIPPED_PROVIDERS.fetch, { id: 'jina' }],
}

/** Mount a Host that accepts writes, with legacy search selected and the legacy section carrying `legacy`. */
async function keyBench(legacy: WebLegacySettings = {}) {
  const b = bench({ accept: true })
  serve(b, { value: LEGACY_SELECTION }, API_DEFAULTS, legacy)
  await vi.waitFor(() => { expect(b.state().search.options).toHaveLength(2) })
  await Promise.resolve()
  return b
}

describe('WebSearchCardController legacy key', () => {
  it('reads the key reference once per settings publication wave after the eager read', async () => {
    const b = bench()
    try {
      expect(b.credentials.describe).toHaveBeenCalledTimes(1)
      serve(b)
      await Promise.resolve()
      expect(b.credentials.describe).toHaveBeenCalledTimes(2)
      serve(b)
      await Promise.resolve()
      expect(b.credentials.describe).toHaveBeenCalledTimes(3)
      for (const args of b.credentials.describe.mock.calls) expect(args).toEqual([[LEGACY_KEY]])
    } finally { b.controller.dispose() }
  })

  it('reads once when a settings publication wave renames the reference', async () => {
    const b = await keyBench()
    try {
      await vi.waitFor(() => { expect(b.state().legacyKey?.configured).toBe(true) })
      const count = b.credentials.describe.mock.calls.length
      b.legacy.publish({ value: { apiKeyEnv: 'RENAMED_KEY' } })
      expect(b.state().legacyKey?.configured).toBe(false)
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
      serve(b, { value: LEGACY_SELECTION })
      await Promise.resolve()
      const count = b.credentials.describe.mock.calls.length
      b.credentials.describe.mockImplementationOnce(() => updated.promise)
      b.controller.refreshCredential(LEGACY_KEY)
      expect(b.credentials.describe).toHaveBeenCalledTimes(count + 1)
      if (order === 'before') {
        pending.resolve({ ok: true, value: { [LEGACY_KEY]: { configured: false, writable: true } } })
        await Promise.resolve()
      }
      updated.resolve({ ok: true, value: { [LEGACY_KEY]: { configured: true, writable: true } } })
      await vi.waitFor(() => { expect(b.state().legacyKey?.configured).toBe(true) })
      pending.resolve({ ok: true, value: { [LEGACY_KEY]: { configured: false, writable: true } } })
      await Promise.resolve()
      expect(b.state().legacyKey?.configured).toBe(true)
    } finally {
      b.controller.dispose()
      pending.resolve({ ok: true, value: {} })
      updated.resolve({ ok: true, value: {} })
      await Promise.all([pending.promise, updated.promise])
    }
  })

  it('discards queued reads and late answers after disposal', async () => {
    const b = bench({ configured: false })
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof b.credentials.describe>>>()
    const providers = Promise.withResolvers<ProviderResponse>()
    const publish = vi.fn()
    const off = b.face.hooks.webSearchCard.subscribe(publish)
    try {
      await Promise.resolve()
      serve(b, { value: LEGACY_SELECTION })
      await Promise.resolve()
      b.credentials.describe.mockImplementationOnce(() => pending.promise)
      b.controller.refreshCredential(LEGACY_KEY)
      b.credentials.listProviders.mockImplementationOnce(() => providers.promise)
      b.controller.refreshProviders()
      serve(b, { value: LEGACY_SELECTION })
      b.controller.dispose()
      const count = b.credentials.describe.mock.calls.length
      const listed = b.credentials.listProviders.mock.calls.length
      publish.mockClear()
      pending.resolve({ ok: true, value: { [LEGACY_KEY]: { configured: true, writable: true } } })
      providers.resolve({ ok: true, value: { search: [], fetch: [] } })
      await Promise.resolve()
      await Promise.resolve()
      expect(b.credentials.describe).toHaveBeenCalledTimes(count)
      expect(publish).not.toHaveBeenCalled()
      expect(b.state().legacyKey?.configured).toBe(false)
      b.controller.refreshCredential(LEGACY_KEY)
      b.controller.refreshProviders()
      serve(b)
      await Promise.resolve()
      expect(b.credentials.describe).toHaveBeenCalledTimes(count)
      expect(b.credentials.listProviders).toHaveBeenCalledTimes(listed)
    } finally {
      off()
      b.controller.dispose()
      pending.resolve({ ok: true, value: {} })
      providers.resolve({ ok: true, value: { search: [], fetch: [] } })
      await Promise.all([pending.promise, providers.promise])
    }
  })

  it('shows the key control only while legacy search is selected', async () => {
    const b = bench()
    try {
      serve(b, { value: API_SELECTION })
      await vi.waitFor(() => { expect(b.credentials.describe).toHaveBeenCalledTimes(2) })
      expect(b.state().legacyKey).toBeUndefined()
      b.face.selectProvider('searchProvider', 'deepseek-official')
      await vi.waitFor(() => { expect(b.state().legacyKey).toMatchObject({ text: '', overridden: false, ref: LEGACY_KEY, configured: true }) })
    } finally { b.controller.dispose() }
  })

  it('keeps an unknown credential reference writable and unconfigured', async () => {
    const b = await keyBench()
    try {
      await vi.waitFor(() => { expect(b.state().legacyKey?.configured).toBe(true) })
      b.credentials.describe.mockResolvedValue({ ok: true, value: {} })
      b.controller.refreshCredential(LEGACY_KEY)
      await vi.waitFor(() => { expect(b.state().legacyKey).toMatchObject({ configured: false, writable: true }) })
    } finally { b.controller.dispose() }
  })

  it('writes the staged key through the credentials domain, never a settings section', async () => {
    const b = bench()
    serve(b, { value: LEGACY_SELECTION })
    await vi.waitFor(() => { expect(b.state().legacyKey).toBeDefined() })
    b.face.edit('legacyApiKey', ' ds-secret ')
    expect(b.state().dirty).toBe(true)
    expect(b.credentials.set).not.toHaveBeenCalled()
    b.face.save()
    await vi.waitFor(() => { expect(b.credentials.set).toHaveBeenCalledWith(LEGACY_KEY, 'ds-secret') })
    for (const host of [b.web, b.api, b.legacy]) expect(host.mutate).not.toHaveBeenCalled()
    await vi.waitFor(() => { expect(b.state()).toMatchObject({ dirty: false, legacyKey: { configured: true } }) })
    b.controller.dispose()
  })

  it('accepts its successful key readback while a newer credential read is pending', async () => {
    const b = bench()
    const readback = Promise.withResolvers<Awaited<ReturnType<typeof b.credentials.describe>>>()
    const newer = Promise.withResolvers<Awaited<ReturnType<typeof b.credentials.describe>>>()
    try {
      serve(b, { value: LEGACY_SELECTION })
      await vi.waitFor(() => { expect(b.state().legacyKey).toBeDefined() })
      const count = b.credentials.describe.mock.calls.length
      b.credentials.describe.mockImplementationOnce(() => readback.promise)
      b.face.edit('legacyApiKey', 'ds-secret')
      b.face.save()
      await vi.waitFor(() => { expect(b.credentials.describe).toHaveBeenCalledTimes(count + 1) })
      b.credentials.describe.mockImplementationOnce(() => newer.promise)
      b.controller.refreshCredential(LEGACY_KEY)
      expect(b.credentials.describe).toHaveBeenCalledTimes(count + 2)
      readback.resolve({ ok: true, value: { [LEGACY_KEY]: { configured: true, writable: true } } })
      await vi.waitFor(() => { expect(b.state()).toMatchObject({ dirty: false, saving: false, failed: false }) })
      newer.resolve({ ok: true, value: { [LEGACY_KEY]: { configured: true, writable: true } } })
      await vi.waitFor(() => { expect(b.state().legacyKey?.configured).toBe(true) })
    } finally {
      b.controller.dispose()
      readback.resolve({ ok: true, value: {} })
      newer.resolve({ ok: true, value: {} })
      await Promise.all([readback.promise, newer.promise])
    }
  })

  it('keeps the stored key when the draft is left blank', async () => {
    const b = await keyBench()
    b.face.edit('legacyApiKey', '   ')
    expect(b.state().dirty).toBe(false)
    b.face.save()
    expect(b.credentials.set).not.toHaveBeenCalled()
    b.controller.dispose()
  })

  it('re-reads only when the Host reports the watched reference changed', async () => {
    const b = bench({ configured: false })
    serve(b, { value: LEGACY_SELECTION })
    await vi.waitFor(() => { expect(b.credentials.describe).toHaveBeenCalled() })
    b.credentials.describe.mockClear()
    b.controller.refreshCredential('OTHER_KEY')
    expect(b.credentials.describe).not.toHaveBeenCalled()
    b.credentials.describe.mockImplementation((refs: readonly string[]) => Promise.resolve({
      ok: true as const, value: Object.fromEntries(refs.map(ref => [ref, { configured: true, writable: true }])),
    }))
    b.controller.refreshCredential(LEGACY_KEY)
    await vi.waitFor(() => { expect(b.state().legacyKey?.configured).toBe(true) })
    b.controller.dispose()
  })

  it('addresses the reference the legacy section declares', async () => {
    const b = await keyBench({ apiKeyEnv: 'TEAM_KEY' })
    await vi.waitFor(() => { expect(b.credentials.describe).toHaveBeenLastCalledWith(['TEAM_KEY']) })
    b.face.edit('legacyApiKey', 'ds-secret')
    b.face.save()
    await vi.waitFor(() => { expect(b.credentials.set).toHaveBeenCalledWith('TEAM_KEY', 'ds-secret') })
    b.controller.dispose()
  })

  it('reports a key the Host did not store as a failed save', async () => {
    const b = bench({ configured: false })
    serve(b, { value: LEGACY_SELECTION })
    b.face.edit('legacyApiKey', 'ds-secret')
    b.face.save()
    await vi.waitFor(() => { expect(b.state()).toMatchObject({ failed: true, dirty: true, selectionBlocked: true }) })
    b.controller.dispose()
  })

  it('keeps the card usable when the credential read and write are refused', async () => {
    const refusal = () => Promise.resolve({
      ok: false as const,
      error: new RemoteError('credential/rejected', 'offline', { ref: LEGACY_KEY }),
    })
    const describe = vi.fn(refusal)
    const set = vi.fn(refusal)
    const listProviders = vi.fn(refusal)
    const b = bench({ ctx: ctxWith({ credentials: { describe, set }, web: { listProviders } }) })
    await vi.waitFor(() => { expect(describe).toHaveBeenCalled() })
    serve(b, { value: LEGACY_SELECTION })
    b.face.edit('legacyApiKey', 'ds-secret')
    b.face.save()
    await vi.waitFor(() => { expect(set).toHaveBeenCalled() })
    expect(b.state()).toMatchObject({ available: true, search: { kind: 'legacy' }, legacyKey: { configured: false } })
    b.controller.dispose()
  })

  it('clears a changed reference immediately and drops its previous pending answer', async () => {
    const b = await keyBench()
    const previous = Promise.withResolvers<Awaited<ReturnType<typeof b.credentials.describe>>>()
    const renamed = Promise.withResolvers<Awaited<ReturnType<typeof b.credentials.describe>>>()
    try {
      await vi.waitFor(() => { expect(b.state().legacyKey?.configured).toBe(true) })
      b.credentials.describe.mockImplementationOnce(() => previous.promise)
      b.controller.refreshCredential(LEGACY_KEY)
      b.credentials.describe.mockImplementation(() => renamed.promise)
      b.legacy.publish({ value: { apiKeyEnv: 'RENAMED_KEY' } })
      expect(b.state().legacyKey?.configured).toBe(false)
      previous.resolve({ ok: true, value: { [LEGACY_KEY]: { configured: true, writable: true } } })
      await Promise.resolve()
      expect(b.state().legacyKey?.configured).toBe(false)
      renamed.resolve({ ok: true, value: { RENAMED_KEY: { configured: true, writable: false } } })
      await vi.waitFor(() => { expect(b.state().legacyKey).toMatchObject({ configured: true, writable: false }) })
    } finally {
      b.controller.dispose()
      previous.resolve({ ok: true, value: {} })
      renamed.resolve({ ok: true, value: {} })
      await Promise.all([previous.promise, renamed.promise])
    }
  })

  it('drops the answer for a reference renamed while the read was in flight', async () => {
    const b = await keyBench()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof b.credentials.describe>>>()
    try {
      b.credentials.describe.mockImplementationOnce(() => pending.promise)
      b.controller.refreshCredential(LEGACY_KEY)
      // Renames the reference without a publication, as a scope that changes outside its subscription would.
      const snapshot = b.legacy.scope.getSnapshot()
      vi.spyOn(b.legacy.scope, 'getSnapshot').mockReturnValue({ ...snapshot, value: { ...snapshot.value, apiKeyEnv: 'RENAMED_KEY' } })
      b.credentials.describe.mockImplementation((refs: readonly string[]) => Promise.resolve({
        ok: true as const, value: Object.fromEntries(refs.map(ref => [ref, { configured: false, writable: true }])),
      }))
      pending.resolve({ ok: true, value: { [LEGACY_KEY]: { configured: true, writable: false } } })
      await vi.waitFor(() => { expect(b.credentials.describe).toHaveBeenLastCalledWith(['RENAMED_KEY']) })
      await vi.waitFor(() => { expect(b.state().legacyKey).toMatchObject({ ref: 'RENAMED_KEY', configured: false, writable: true }) })
    } finally {
      b.controller.dispose()
      pending.resolve({ ok: true, value: {} })
    }
  })

  it('clears a reference renamed outside a publication when the next read starts', async () => {
    const b = await keyBench()
    try {
      await vi.waitFor(() => { expect(b.state().legacyKey?.configured).toBe(true) })
      const snapshot = b.legacy.scope.getSnapshot()
      vi.spyOn(b.legacy.scope, 'getSnapshot').mockReturnValue({ ...snapshot, value: { ...snapshot.value, apiKeyEnv: 'RENAMED_KEY' } })
      b.credentials.describe.mockImplementation(() => new Promise(() => {}))
      b.controller.refreshCredential(LEGACY_KEY)
      expect(b.credentials.describe).toHaveBeenLastCalledWith(['RENAMED_KEY'])
      expect(b.state().legacyKey?.configured).toBe(false)
    } finally { b.controller.dispose() }
  })

  it('reads the reference an already-served legacy section names on its first read', async () => {
    const web = stubConfigForm<WebProviderSelection>()
    const api = stubConfigForm<WebApiSettings>()
    const legacy = stubConfigForm<WebLegacySettings>()
    web.publish({ status: 'ready', writable: true, value: LEGACY_SELECTION, base: LEGACY_SELECTION, user: {} })
    legacy.publish({ status: 'ready', writable: true, value: { apiKeyEnv: 'SERVED_KEY' }, base: {}, user: {} })
    const remote = remoteApi({ SERVED_KEY: true })
    const controller = new WebSearchCardController({ web: web.scope, api: api.scope, legacy: legacy.scope }, remote.ctx)
    try {
      expect(remote.describe).toHaveBeenCalledExactlyOnceWith(['SERVED_KEY'])
      await vi.waitFor(() => { expect(controller.inject().hooks.webSearchCard.getSnapshot().legacyKey?.configured).toBe(true) })
    } finally { controller.dispose() }
  })
})

describe('WebSearchCardController legacy key drafts', () => {
  it('drops the draft once legacy search is deselected', async () => {
    const b = await keyBench()
    try {
      b.face.edit('legacyApiKey', 'draft')
      b.face.selectProvider('searchProvider', 'deepseek-search-api')
      expect(b.state()).toMatchObject({ dirty: false, legacyKey: undefined })
      b.face.selectProvider('searchProvider', 'deepseek-official')
      expect(b.state()).toMatchObject({ dirty: false, legacyKey: { text: '' } })
      b.face.save()
      await Promise.resolve()
      expect(b.credentials.set).not.toHaveBeenCalled()
    } finally { b.controller.dispose() }
  })

  it('drops the draft when the Host stops registering legacy search', async () => {
    const b = await keyBench()
    try {
      b.face.edit('legacyApiKey', 'draft')
      b.credentials.listProviders.mockResolvedValue({ ok: true, value: { search: [{ id: 'exa' }], fetch: [{ id: 'http' }] } })
      b.controller.refreshProviders()
      await vi.waitFor(() => { expect(b.state()).toMatchObject({ search: { kind: 'none' }, legacyKey: undefined }) })
      expect(b.state().dirty).toBe(false)
      b.credentials.listProviders.mockResolvedValue({ ok: true, value: WITH_PLUGINS })
      b.controller.refreshProviders()
      await vi.waitFor(() => { expect(b.state().legacyKey).toMatchObject({ text: '' }) })
    } finally { b.controller.dispose() }
  })

  it('drops the draft when the legacy section renames its reference', async () => {
    const b = await keyBench({ apiKeyEnv: 'TEAM_KEY' })
    try {
      b.face.edit('legacyApiKey', 'draft')
      b.legacy.publish({ value: { apiKeyEnv: 'RENAMED_KEY' } })
      expect(b.state()).toMatchObject({ dirty: false, legacyKey: { text: '', ref: 'RENAMED_KEY' } })
      b.face.save()
      await Promise.resolve()
      expect(b.credentials.set).not.toHaveBeenCalled()
    } finally { b.controller.dispose() }
  })

  it('ignores a draft for a key control the page does not show', async () => {
    const b = bench({ accept: true })
    try {
      serve(b, { value: API_SELECTION })
      b.face.edit('legacyApiKey', 'hidden-draft')
      expect(b.state()).toMatchObject({ dirty: false, legacyKey: undefined })
      b.face.selectProvider('searchProvider', 'deepseek-official')
      expect(b.state().legacyKey).toMatchObject({ text: '' })
    } finally { b.controller.dispose() }
  })

  it('completes a planned key write under its reference when its provider disappears during the save', async () => {
    const b = await keyBench({ apiKeyEnv: 'TEAM_KEY' })
    const first = Promise.withResolvers<{ ok: true; value: undefined }>()
    try {
      b.face.edit('legacyApiKey', 'draft')
      b.credentials.set.mockImplementationOnce(() => first.promise)
      b.face.save()
      await vi.waitFor(() => { expect(b.credentials.set).toHaveBeenCalledTimes(1) })
      b.credentials.listProviders.mockResolvedValue({ ok: true, value: { search: [{ id: 'exa' }], fetch: [{ id: 'http' }] } })
      b.controller.refreshProviders()
      await vi.waitFor(() => { expect(b.state()).toMatchObject({ search: { kind: 'none' }, legacyKey: undefined }) })
      first.resolve({ ok: true, value: undefined })
      await vi.waitFor(() => { expect(b.state().saving).toBe(false) })
      expect(b.credentials.set.mock.calls).toEqual([['TEAM_KEY', 'draft']])
      expect(b.credentials.describe).toHaveBeenLastCalledWith(['TEAM_KEY'])
      expect(b.state()).toMatchObject({ failed: false, dirty: false })
    } finally {
      first.resolve({ ok: true, value: undefined })
      b.controller.dispose()
    }
  })
})

describe('WebSearchCardController deployment defaults', () => {
  it('saves a typed value equal to the deployment default as an override', async () => {
    const b = bench({ accept: true })
    try {
      const composed = { baseURL: 'https://messages.test/v1', maxUses: 5 }
      serve(b, { value: LEGACY_SELECTION }, API_DEFAULTS, composed)
      b.api.publish({ value: { count: 20 }, user: { count: 20 } })
      const stored = { baseURL: 'https://custom.test/v1' }
      b.legacy.publish({ value: { ...composed, ...stored }, user: stored })
      b.face.edit('messagesBaseURL', ' https://messages.test/v1 ')
      b.face.edit('count', '10')
      expect(b.state()).toMatchObject({
        dirty: true, count: { text: '10', overridden: true }, messagesBaseURL: { text: ' https://messages.test/v1 ', overridden: true },
      })
      b.face.save()
      await vi.waitFor(() => { expect(b.state().dirty).toBe(false) })
      expect(b.api.mutate).toHaveBeenCalledExactlyOnceWith([{ op: 'set', path: ['count'], value: 10 }], undefined)
      expect(b.legacy.mutate).toHaveBeenCalledExactlyOnceWith([{ op: 'set', path: ['baseURL'], value: 'https://messages.test/v1' }], undefined)
      expect(b.legacy.scope.getSnapshot().user).toEqual({ baseURL: 'https://messages.test/v1' })
      expect(b.state()).toMatchObject({ count: { overridden: true }, messagesBaseURL: { overridden: true } })
    } finally { b.controller.dispose() }
  })

  it('writes nothing for a typed value equal to the composed one the user layer does not override', async () => {
    const b = bench({ accept: true })
    try {
      serve(b)
      b.face.edit('count', '11')
      expect(b.state().dirty).toBe(true)
      b.face.edit('count', '10')
      expect(b.state().dirty).toBe(false)
      b.face.save()
      await Promise.resolve()
      expect(b.api.mutate).not.toHaveBeenCalled()
    } finally { b.controller.dispose() }
  })

  it('marks a stored override as overridden even when it equals the deployment default', () => {
    const b = bench()
    try {
      serve(b, { value: LEGACY_SELECTION })
      const stored = { baseURL: 'https://messages.test/v1' }
      b.legacy.publish({ value: { maxUses: 5, ...stored }, base: { maxUses: 5, ...stored }, user: stored })
      expect(b.state()).toMatchObject({ dirty: false, messagesBaseURL: { text: stored.baseURL, overridden: true } })
      b.face.resetField('messagesBaseURL')
      expect(b.state()).toMatchObject({ dirty: true, messagesBaseURL: { overridden: false } })
    } finally { b.controller.dispose() }
  })
})

describe('WebSearchCardController sections', () => {
  it('stages and resets the legacy endpoint and search limit apart from the result count, clearing a blank limit', async () => {
    const b = bench({ accept: true })
    try {
      serve(b, { value: LEGACY_SELECTION })
      b.api.publish({ value: { count: 20 }, user: { count: 20 } })
      b.face.resetField('count')
      expect(b.state().count).toMatchObject({ text: '10', overridden: false })
      const stored = { baseURL: 'https://messages.test/v1', maxUses: 8 }
      b.legacy.publish({ value: stored, user: stored })
      b.face.resetField('maxUses')
      expect(b.state().maxUses).toMatchObject({ text: '5', overridden: false })
      b.face.edit('maxUses', '   ')
      b.face.resetField('messagesBaseURL')
      b.face.save()
      await vi.waitFor(() => { expect(b.state().dirty).toBe(false) })
      expect(b.legacy.mutate).toHaveBeenCalledExactlyOnceWith([
        { op: 'unset', path: ['maxUses'] }, { op: 'unset', path: ['baseURL'] },
      ], undefined)
      expect(b.api.mutate).toHaveBeenCalledExactlyOnceWith([{ op: 'unset', path: ['count'] }], undefined)
    } finally { b.controller.dispose() }
  })

  it.each(['0', '51', '1.5', 'many', 'Infinity'])('rejects an unsupported Search API result count: %s', (text) => {
    const b = bench()
    serve(b, { value: { searchProvider: 'deepseek-search-api' } })
    b.face.edit('count', text)
    expect(b.state()).toMatchObject({ invalid: true, selectionBlocked: true, count: { text, invalid: true } })
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

describe('WebSearchCardController billing', () => {
  it('shows each billing only while its DeepSeek API is selected, reading an unset billing as automatic', async () => {
    const b = bench()
    try {
      serve(b)
      await vi.waitFor(() => { expect(b.state().search.kind).toBe('deepseek') })
      expect(b.state()).toMatchObject({ searchBilling: { value: 'auto', overridden: false }, fetchBilling: undefined })
      b.face.selectProvider('fetchProvider', 'deepseek-fetch-api')
      b.face.selectProvider('searchProvider', 'deepseek-official')
      expect(b.state()).toMatchObject({ searchBilling: undefined, fetchBilling: { value: 'auto', overridden: false } })
    } finally { b.controller.dispose() }
  })

  it('reads a stored billing and its override, and an unknown stored value as automatic', async () => {
    const b = bench()
    try {
      serve(b, { value: API_SELECTION, base: API_SELECTION })
      b.api.publish({ value: { count: 10, searchBilling: 'account', fetchBilling: 'session' as never }, user: { searchBilling: 'account' } })
      await vi.waitFor(() => { expect(b.state().fetch.kind).toBe('deepseek') })
      expect(b.state()).toMatchObject({
        searchBilling: { value: 'account', overridden: true }, fetchBilling: { value: 'auto' },
      })
    } finally { b.controller.dispose() }
  })

  it('saves a selected billing and clears it when the composed billing is selected again', async () => {
    const b = bench({ accept: true })
    try {
      serve(b, { value: API_SELECTION, base: API_SELECTION })
      await vi.waitFor(() => { expect(b.state().fetch.kind).toBe('deepseek') })
      b.face.selectBilling('search', 'api-key')
      expect(b.state()).toMatchObject({ dirty: true, searchBilling: { value: 'api-key', overridden: true } })
      b.face.save()
      await vi.waitFor(() => { expect(b.api.mutate).toHaveBeenCalledTimes(1) })
      expect(b.api.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['searchBilling'], value: 'api-key' }], undefined)
      await vi.waitFor(() => { expect(b.state().saving).toBe(false) })
      b.face.selectBilling('search', 'auto')
      expect(b.state().searchBilling).toEqual({ value: 'auto', overridden: false, advancedOverride: [] })
      b.face.save()
      await vi.waitFor(() => { expect(b.api.mutate).toHaveBeenCalledTimes(2) })
      expect(b.api.mutate).toHaveBeenLastCalledWith([{ op: 'unset', path: ['searchBilling'] }], undefined)
    } finally { b.controller.dispose() }
  })

  it('stores automatic billing as an override where the deployment composes another billing', async () => {
    const b = bench({ accept: true })
    try {
      serve(b, { value: API_SELECTION, base: API_SELECTION }, { count: 10, fetchBilling: 'account' })
      await vi.waitFor(() => { expect(b.state().fetchBilling).toMatchObject({ value: 'account' }) })
      b.face.selectBilling('fetch', 'account')
      expect(b.state().dirty).toBe(false)
      b.face.selectBilling('fetch', 'auto')
      b.face.save()
      await vi.waitFor(() => { expect(b.api.mutate).toHaveBeenCalledTimes(1) })
      expect(b.api.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['fetchBilling'], value: 'auto' }], undefined)
    } finally { b.controller.dispose() }
  })
})

describe('WebSearchCardController advanced override', () => {
  it('names each capability’s non-empty own endpoint fields, base URL first, and none while they are unset or empty', async () => {
    const b = bench()
    try {
      serve(b, { value: API_SELECTION, base: API_SELECTION })
      await vi.waitFor(() => { expect(b.state().fetch.kind).toBe('deepseek') })
      expect(b.state()).toMatchObject({ searchBilling: { advancedOverride: [] }, fetchBilling: { advancedOverride: [] } })
      b.api.publish({ value: { count: 10, searchApiKeyEnv: 'OWN_KEY', searchBaseURL: 'https://own.test/v1/tools', fetchBaseURL: '' } })
      expect(b.state().searchBilling?.advancedOverride).toEqual(['searchBaseURL', 'searchApiKeyEnv'])
      expect(b.state().fetchBilling?.advancedOverride).toEqual([])
      b.api.publish({ value: { count: 10, fetchApiKeyEnv: 'OWN_KEY' } })
      expect(b.state().searchBilling?.advancedOverride).toEqual([])
      expect(b.state().fetchBilling?.advancedOverride).toEqual(['fetchApiKeyEnv'])
    } finally { b.controller.dispose() }
  })

  it('saves a billing without writing or clearing the own endpoint fields', async () => {
    const b = bench({ accept: true })
    try {
      const composed = { count: 10, searchBaseURL: 'https://own.test/v1/tools', fetchApiKeyEnv: 'OWN_KEY' }
      serve(b, { value: API_SELECTION, base: API_SELECTION }, composed)
      await vi.waitFor(() => { expect(b.state().fetch.kind).toBe('deepseek') })
      b.face.selectBilling('fetch', 'api-key')
      b.face.edit('count', '20')
      b.face.save()
      await vi.waitFor(() => { expect(b.api.mutate).toHaveBeenCalledTimes(1) })
      const ops = b.api.mutate.mock.calls[0]![0]
      expect(ops.map(op => op.path[0]).sort()).toEqual(['count', 'fetchBilling'])
      await vi.waitFor(() => { expect(b.state().saving).toBe(false) })
      expect(b.state()).toMatchObject({
        searchBilling: { advancedOverride: ['searchBaseURL'] }, fetchBilling: { value: 'api-key', advancedOverride: ['fetchApiKeyEnv'] },
      })
    } finally { b.controller.dispose() }
  })
})

describe('WebSearchCardController providers', () => {
  it('lists the official providers first in a fixed order and plugin providers after them in Host order', async () => {
    const b = bench()
    try {
      b.credentials.listProviders.mockResolvedValue({
        ok: true,
        value: {
          search: [{ id: 'exa' }, { id: 'brave' }, { id: 'deepseek-search-api' }],
          fetch: [{ id: 'jina' }, { id: 'deepseek-fetch-api' }, { id: 'http' }],
        },
      })
      b.controller.refreshProviders()
      serve(b, { value: { searchProvider: 'perplexity', fetchProvider: 'http' } })
      await vi.waitFor(() => { expect(b.state().search.options).toHaveLength(4) })
      expect(b.state().search.options).toEqual([
        { id: 'deepseek-search-api', missing: false },
        { id: 'exa', missing: false }, { id: 'brave', missing: false }, { id: 'perplexity', missing: true },
      ])
      expect(b.state().fetch.options.map(option => option.id)).toEqual(['http', 'deepseek-fetch-api', 'jina'])
    } finally { b.controller.dispose() }
  })

  it('omits an official provider the Host does not register from the fixed order', async () => {
    const b = bench()
    try {
      b.credentials.listProviders.mockResolvedValue({ ok: true, value: { search: [{ id: 'exa' }], fetch: [{ id: 'http' }] } })
      b.controller.refreshProviders()
      serve(b, { value: { searchProvider: 'exa', fetchProvider: 'http' } })
      await vi.waitFor(() => { expect(b.state().search.options.map(option => option.id)).toEqual(['exa']) })
      expect(b.state().fetch.options.map(option => option.id)).toEqual(['http'])
    } finally { b.controller.dispose() }
  })

  it('resolves a provider description through the locale service', () => {
    const { describe, set, listProviders } = remoteApi(false)
    const resolveText = vi.fn(() => 'resolved')
    const b = bench({ ctx: { remote: { credentials: { describe, set }, web: { listProviders } }, locale: { resolveText } } as never })
    try {
      const description = { en: 'English.', zh: '中文' }
      expect(b.face.resolveText(description)).toBe('resolved')
      expect(resolveText).toHaveBeenCalledExactlyOnceWith(description)
    } finally { b.controller.dispose() }
  })

  it('offers plugin providers and shows a plugin selection with no settings of its own', async () => {
    const b = bench()
    try {
      b.credentials.listProviders.mockResolvedValue({
        ok: true, value: { search: [...SHIPPED_PROVIDERS.search, { id: 'exa', title: 'Exa', description: { en: 'Exa search.', zh: 'Exa 搜索' } }], fetch: SHIPPED_PROVIDERS.fetch },
      })
      b.controller.refreshProviders()
      serve(b, { value: { searchProvider: 'exa', fetchProvider: 'http' } })
      await vi.waitFor(() => { expect(b.state().search.options).toHaveLength(3) })
      expect(b.state().search).toMatchObject({
        selected: 'exa', kind: 'plugin',
        options: [
          { id: 'deepseek-search-api', missing: false },
          { id: 'deepseek-official', missing: false },
          { id: 'exa', title: 'Exa', description: { en: 'Exa search.', zh: 'Exa 搜索' }, missing: false },
        ],
      })
      expect(b.state().fetch).toMatchObject({ selected: 'http', kind: 'local' })
      b.credentials.listProviders.mockResolvedValue({
        ok: true, value: { search: SHIPPED_PROVIDERS.search, fetch: [...SHIPPED_PROVIDERS.fetch, { id: 'jina' }] },
      })
      b.controller.refreshProviders()
      b.face.selectProvider('fetchProvider', 'jina')
      await vi.waitFor(() => { expect(b.state().fetch).toMatchObject({ selected: 'jina', kind: 'plugin' }) })
    } finally { b.controller.dispose() }
  })

  it('adds a selected provider the Host does not register without changing the selection', async () => {
    const b = bench()
    try {
      serve(b, { value: { searchProvider: 'perplexity', fetchProvider: 'jina' } })
      await vi.waitFor(() => { expect(b.credentials.listProviders).toHaveBeenCalled() })
      await vi.waitFor(() => { expect(b.state().search.options).toHaveLength(3) })
      expect(b.state().search).toMatchObject({ selected: 'perplexity', kind: 'none', options: [{}, {}, { id: 'perplexity', missing: true }] })
      expect(b.state().fetch).toMatchObject({ selected: 'jina', kind: 'none', options: [{}, {}, { id: 'jina', missing: true }] })
      expect(b.state().dirty).toBe(false)
    } finally { b.controller.dispose() }
  })

  it('treats an official provider the Host does not register as not loaded', async () => {
    const b = bench()
    try {
      b.credentials.listProviders.mockResolvedValue({ ok: true, value: { search: [{ id: 'exa' }], fetch: [] } })
      b.controller.refreshProviders()
      serve(b, { value: API_SELECTION })
      await vi.waitFor(() => { expect(b.state().fetch.options).toEqual([{ id: 'deepseek-fetch-api', missing: true }]) })
      expect(b.state()).toMatchObject({ search: { kind: 'none' }, fetch: { kind: 'none' } })
    } finally { b.controller.dispose() }
  })

  it('keeps the last list when a provider read fails', async () => {
    const b = bench()
    try {
      b.credentials.listProviders.mockResolvedValue({ ok: true, value: WITH_PLUGINS })
      serve(b, { value: { searchProvider: 'exa' } })
      await vi.waitFor(() => { expect(b.state().search.options).toHaveLength(3) })
      b.credentials.listProviders.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'down', {}) })
      b.controller.refreshProviders()
      await vi.waitFor(() => { expect(b.credentials.listProviders).toHaveBeenCalledTimes(3) })
      await vi.waitFor(() => { expect(b.state().providersFailed).toBe(true) })
      expect(b.state().search.options.map(option => option.id)).toEqual(['deepseek-search-api', 'deepseek-official', 'exa'])
      b.face.retryProviders()
      await vi.waitFor(() => { expect(b.state().providersFailed).toBe(false) })
      expect(b.credentials.listProviders).toHaveBeenCalledTimes(4)
    } finally { b.controller.dispose() }
  })

  it('reports a failed first read without claiming the menu is complete, and recovers on retry', async () => {
    const b = bench()
    try {
      b.credentials.listProviders.mockResolvedValue({ ok: false, error: new RemoteError('gateway/internal', 'down', {}) })
      b.controller.refreshProviders()
      serve(b, { value: { searchProvider: 'exa', fetchProvider: 'http' } })
      await vi.waitFor(() => { expect(b.state().providersFailed).toBe(true) })
      expect(b.state().search).toMatchObject({ options: [{ id: 'exa', missing: false }], kind: 'none' })
      expect(b.state().fetch).toMatchObject({ options: [{ id: 'http', missing: false }], kind: 'local' })
      b.credentials.listProviders.mockResolvedValue({ ok: true, value: WITH_PLUGINS })
      b.face.retryProviders()
      await vi.waitFor(() => { expect(b.state()).toMatchObject({ providersFailed: false, search: { kind: 'plugin' } }) })
      expect(b.state().search.options).toHaveLength(3)
    } finally { b.controller.dispose() }
  })

  it('ignores a failure answered for a superseded read', async () => {
    const stale = Promise.withResolvers<ProviderResponse>()
    const b = bench()
    try {
      serve(b)
      b.credentials.listProviders.mockImplementationOnce(() => stale.promise)
      b.controller.refreshProviders()
      b.face.retryProviders()
      await vi.waitFor(() => { expect(b.state().fetch.options).toHaveLength(2) })
      stale.resolve({ ok: false, error: new RemoteError('gateway/internal', 'down', {}) })
      await Promise.resolve()
      expect(b.state().providersFailed).toBe(false)
    } finally { b.controller.dispose() }
  })

  it('renders an unread list as the selected id alone', () => {
    const listProviders = vi.fn(() => new Promise<ProviderResponse>(() => {}))
    const describe = vi.fn(() => new Promise(() => {}))
    const b = bench({ ctx: ctxWith({ credentials: { describe, set: vi.fn() }, web: { listProviders } }) })
    try {
      serve(b, { value: { searchProvider: 'exa', fetchProvider: 'http' } })
      expect(b.state().search).toMatchObject({ options: [{ id: 'exa', missing: false }], kind: 'none' })
      expect(b.state().fetch).toMatchObject({ options: [{ id: 'http', missing: false }], kind: 'local' })
      b.web.publish({ value: { fetchProvider: 'jina' } })
      expect(b.state().search).toMatchObject({ selected: '', options: [], kind: 'none' })
      expect(b.state().fetch).toMatchObject({ options: [{ id: 'jina', missing: false }], kind: 'none' })
    } finally { b.controller.dispose() }
  })

  it('publishes only the latest provider read', async () => {
    const stale = Promise.withResolvers<ProviderResponse>()
    const b = bench()
    try {
      serve(b)
      b.credentials.listProviders.mockImplementationOnce(() => stale.promise)
      b.controller.refreshProviders()
      b.credentials.listProviders.mockResolvedValueOnce({ ok: true, value: { search: [{ id: 'exa' }], fetch: [] } })
      b.controller.refreshProviders()
      await vi.waitFor(() => { expect(b.state().search.options.map(option => option.id)).toEqual(['exa', 'deepseek-search-api']) })
      stale.resolve({ ok: true, value: SHIPPED_PROVIDERS })
      await Promise.resolve()
      expect(b.state().search.options.map(option => option.id)).toEqual(['exa', 'deepseek-search-api'])
    } finally { b.controller.dispose() }
  })

  it('re-reads the providers when the Host starts serving the selection', async () => {
    const b = bench()
    try {
      await Promise.resolve()
      expect(b.credentials.listProviders).toHaveBeenCalledTimes(1)
      serve(b)
      expect(b.credentials.listProviders).toHaveBeenCalledTimes(2)
      serve(b)
      expect(b.credentials.listProviders).toHaveBeenCalledTimes(2)
      b.web.publish({ status: 'unavailable' })
      b.web.publish({ status: 'ready' })
      expect(b.credentials.listProviders).toHaveBeenCalledTimes(3)
    } finally { b.controller.dispose() }
  })
})

describe('WebSearchCardController provider selection', () => {
  it('keeps legacy settings and key writes separate from Search API settings and clears back to the API default', async () => {
    const b = bench({ accept: true })
    try {
      serve(b)
      await vi.waitFor(() => { expect(b.state().search.options.map(option => option.id)).toEqual(['deepseek-search-api', 'deepseek-official']) })
      b.face.selectProvider('searchProvider', 'deepseek-official')
      expect(b.state().search).toMatchObject({ kind: 'legacy' })
      b.face.edit('messagesBaseURL', 'https://messages.test/anthropic/v1')
      b.face.edit('maxUses', '8')
      b.face.edit('legacyApiKey', 'legacy-secret')
      b.face.save()
      await vi.waitFor(() => { expect(b.state().dirty).toBe(false) })
      expect(b.legacy.mutate).toHaveBeenCalledWith([
        { op: 'set', path: ['baseURL'], value: 'https://messages.test/anthropic/v1' },
        { op: 'set', path: ['maxUses'], value: 8 },
      ], undefined)
      expect(b.credentials.set).toHaveBeenCalledExactlyOnceWith(LEGACY_KEY, 'legacy-secret')
      expect(b.api.mutate).not.toHaveBeenCalled()
      b.face.selectProvider('searchProvider', 'deepseek-search-api')
      b.face.save()
      await vi.waitFor(() => { expect(b.state().dirty).toBe(false) })
      expect(b.web.mutate).toHaveBeenLastCalledWith([{ op: 'unset', path: ['searchProvider'] }], undefined)
      expect(b.state().legacyKey).toBeUndefined()
      b.face.selectProvider('searchProvider', 'deepseek-official')
      expect(b.state().messagesBaseURL.text).toBe('https://messages.test/anthropic/v1')
      b.face.edit('legacyApiKey', 'must-not-save')
      b.face.selectProvider('searchProvider', 'deepseek-search-api')
      b.face.selectProvider('searchProvider', 'deepseek-official')
      expect(b.state().legacyKey?.text).toBe('')
      b.face.edit('maxUses', '1.5')
      expect(b.state().selectionBlocked).toBe(true)
    } finally { b.controller.dispose() }
  })

  it('selects Search and Fetch independently and clears a selection back to the composed default', async () => {
    const b = bench({ accept: true })
    try {
      b.credentials.listProviders.mockResolvedValue({ ok: true, value: WITH_PLUGINS })
      serve(b)
      await vi.waitFor(() => { expect(b.state().search.options).toHaveLength(3) })
      expect(b.state()).toMatchObject({ search: { selected: 'deepseek-search-api', kind: 'deepseek' }, fetch: { selected: 'http', kind: 'local' } })
      b.face.selectProvider('searchProvider', 'exa')
      expect(b.state()).toMatchObject({ dirty: true, search: { selected: 'exa', kind: 'plugin' }, fetch: { selected: 'http' } })
      expect(b.web.mutate).not.toHaveBeenCalled()
      b.face.discard()
      expect(b.state().search.selected).toBe('deepseek-search-api')
      b.face.selectProvider('searchProvider', 'exa')
      b.face.save()
      await vi.waitFor(() => { expect(b.state().dirty).toBe(false) })
      expect(b.web.mutate).toHaveBeenLastCalledWith([{ op: 'set', path: ['searchProvider'], value: 'exa' }], undefined)
      b.face.selectProvider('fetchProvider', 'deepseek-fetch-api')
      b.face.save()
      await vi.waitFor(() => { expect(b.state().dirty).toBe(false) })
      expect(b.web.mutate).toHaveBeenLastCalledWith([{ op: 'set', path: ['fetchProvider'], value: 'deepseek-fetch-api' }], undefined)
      b.face.selectProvider('searchProvider', 'deepseek-search-api')
      b.face.selectProvider('fetchProvider', 'http')
      b.face.save()
      await vi.waitFor(() => { expect(b.state().dirty).toBe(false) })
      expect(b.web.mutate).toHaveBeenLastCalledWith([
        { op: 'unset', path: ['searchProvider'] },
        { op: 'unset', path: ['fetchProvider'] },
      ], undefined)
      expect(b.api.mutate).not.toHaveBeenCalled()
    } finally { b.controller.dispose() }
  })

  it('writes explicit selections when the deployment composes the APIs', async () => {
    const b = bench({ accept: true })
    serve(b, { value: API_SELECTION, base: API_SELECTION })
    expect(b.state()).toMatchObject({ search: { kind: 'deepseek' }, fetch: { kind: 'deepseek' } })
    b.face.selectProvider('fetchProvider', 'http')
    b.face.save()
    await vi.waitFor(() => { expect(b.state().dirty).toBe(false) })
    expect(b.web.mutate).toHaveBeenLastCalledWith([{ op: 'set', path: ['fetchProvider'], value: 'http' }], undefined)
    b.controller.dispose()
  })

  it('saves the API section before the selection that starts using it', async () => {
    const b = bench({ accept: true })
    serve(b)
    const order: string[] = []
    for (const [name, host] of [['web', b.web], ['api', b.api]] as const) {
      const accept = host.mutate.getMockImplementation()!
      host.mutate.mockImplementation((ops, revision) => { order.push(name); return accept(ops, revision) })
    }
    b.face.selectProvider('fetchProvider', 'deepseek-fetch-api')
    b.face.edit('count', '20')
    b.face.save()
    await vi.waitFor(() => { expect(b.state().dirty).toBe(false) })
    expect(order).toEqual(['api', 'web'])
    b.controller.dispose()
  })

  it('keeps the selection staged when the API section refuses its save', async () => {
    const b = bench({ accept: true })
    serve(b)
    b.api.mutate.mockImplementation(() => Promise.resolve(false))
    b.face.selectProvider('fetchProvider', 'deepseek-fetch-api')
    b.face.edit('count', '20')
    b.face.save()
    await vi.waitFor(() => { expect(b.state().failed).toBe(true) })
    expect(b.web.mutate).not.toHaveBeenCalled()
    expect(b.state()).toMatchObject({ fetch: { selected: 'deepseek-fetch-api' }, dirty: true, selectionBlocked: true })
    b.controller.dispose()
  })

  it('blocks provider changes while an invalid edit is staged', () => {
    const b = bench()
    serve(b)
    expect(b.state().selectionBlocked).toBe(false)
    b.face.edit('count', 'many')
    expect(b.state()).toMatchObject({ invalid: true, selectionBlocked: true })
    b.face.save()
    expect(b.api.mutate).not.toHaveBeenCalled()
    b.face.discard()
    expect(b.state().selectionBlocked).toBe(false)
    b.controller.dispose()
  })

  it('hides provider controls while the API section is not served', () => {
    const b = bench()
    serve(b, { value: API_SELECTION })
    b.api.publish({ status: 'unavailable' })
    expect(b.state()).toMatchObject({ available: true, search: { kind: 'none' }, fetch: { kind: 'none' } })
    b.controller.dispose()
  })

  it('saves nothing before the selection is served or while a save runs', async () => {
    const b = bench({ accept: true })
    b.face.save()
    expect(b.state().available).toBe(false)
    serve(b)
    let release: (accepted: boolean) => void = () => {}
    b.api.mutate.mockImplementation(() => new Promise<boolean>((resolve) => { release = resolve }))
    b.face.edit('count', '3')
    b.face.save()
    await vi.waitFor(() => { expect(b.state().saving).toBe(true) })
    b.face.save()
    release(true)
    await vi.waitFor(() => { expect(b.state().saving).toBe(false) })
    expect(b.api.mutate).toHaveBeenCalledTimes(1)
    b.controller.dispose()
  })

  it('skips the API section while the Host does not serve it', async () => {
    const b = bench({ accept: true })
    serve(b)
    b.face.edit('count', '3')
    b.api.publish({ status: 'unavailable' })
    b.face.selectProvider('fetchProvider', 'deepseek-fetch-api')
    b.face.save()
    await vi.waitFor(() => { expect(b.web.mutate).toHaveBeenCalled() })
    expect(b.api.mutate).not.toHaveBeenCalled()
    b.controller.dispose()
  })

  it('releases every subscription on dispose', () => {
    const b = bench()
    serve(b)
    b.controller.dispose()
    for (const host of [b.web, b.api]) expect(host.listenerCount()).toBe(0)
  })
})

describe('WebSearchCardController automatic selection', () => {
  it('offers automatic selection only where the deployment composes no provider, and returns to it', async () => {
    const b = bench({ accept: true })
    try {
      serve(b, { value: { fetchProvider: 'http' }, base: { fetchProvider: 'http' } })
      expect(b.state()).toMatchObject({ search: { selected: '', auto: true }, fetch: { selected: 'http', auto: false } })
      b.face.selectProvider('searchProvider', 'deepseek-search-api')
      b.face.selectProvider('searchProvider', '')
      expect(b.state()).toMatchObject({ dirty: false, search: { selected: '' } })
      b.face.selectProvider('searchProvider', 'deepseek-search-api')
      b.face.save()
      await vi.waitFor(() => { expect(b.state().dirty).toBe(false) })
      expect(b.web.mutate).toHaveBeenLastCalledWith([{ op: 'set', path: ['searchProvider'], value: 'deepseek-search-api' }], undefined)
      expect(b.state().search).toMatchObject({ selected: 'deepseek-search-api', auto: true })
      b.face.selectProvider('searchProvider', '')
      expect(b.state()).toMatchObject({ dirty: true, search: { selected: '', kind: 'none' } })
      b.face.save()
      await vi.waitFor(() => { expect(b.state().dirty).toBe(false) })
      expect(b.web.mutate).toHaveBeenLastCalledWith([{ op: 'unset', path: ['searchProvider'] }], undefined)
      expect(b.state().search).toMatchObject({ selected: '', auto: true })
    } finally { b.controller.dispose() }
  })
})
