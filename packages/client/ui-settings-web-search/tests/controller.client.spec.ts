import { describe, expect, it, vi } from 'vitest'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError, stubConfigForm, type StubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { WebSearchCardController, type WebSearchSettings } from '../src/client/web-search-card-controller.ts'

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

function credentialsApi(configured: boolean) {
  const describe = vi.fn(() => Promise.resolve({
    ok: true as const,
    value: { DEEPSEEK_API_KEY: { configured, writable: true } },
  }))
  const set = vi.fn(() => Promise.resolve({ ok: true as const, value: undefined }))
  return { ctx: ctxWith({ credentials: { describe, set } }), describe, set }
}

describe('WebSearchCardController', () => {
  it('reads the credential state for the reference the tab names', async () => {
    const host = stubConfigForm<WebSearchSettings>()
    const credentials = credentialsApi(true)
    const controller = new WebSearchCardController(host.scope, credentials.ctx)
    const state = () => controller.inject().hooks.webSearchCard.getSnapshot()
    await vi.waitFor(() => { expect(credentials.describe).toHaveBeenCalled() })

    host.publish({ status: 'ready', writable: true, value: { baseURL: 'https://search.test/v1' }, user: {} })
    await vi.waitFor(() => { expect(state().apiKeyConfigured).toBe(true) })

    expect(state()).toMatchObject({
      baseURL: { text: 'https://search.test/v1', overridden: false },
      apiKey: { text: '', overridden: false },
    })
  })

  it('writes the staged key through the credentials domain, never the settings section', async () => {
    const host = stubConfigForm<WebSearchSettings>()
    const credentials = credentialsApi(false)
    const controller = new WebSearchCardController(host.scope, credentials.ctx)
    host.publish({ status: 'ready', writable: true, value: {}, user: {} })
    const face = controller.inject()

    face.edit('apiKey', ' ds-secret ')
    expect(face.hooks.webSearchCard.getSnapshot().dirty).toBe(true)
    expect(credentials.set).not.toHaveBeenCalled()

    credentials.describe.mockImplementation(() => Promise.resolve({
      ok: true as const,
      value: { DEEPSEEK_API_KEY: { configured: true, writable: true } },
    }))
    face.save()
    await vi.waitFor(() => { expect(credentials.set).toHaveBeenCalled() })

    expect(credentials.set).toHaveBeenCalledWith('DEEPSEEK_API_KEY', 'ds-secret')
    expect(host.set).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(face.hooks.webSearchCard.getSnapshot()).toMatchObject({ dirty: false, apiKeyConfigured: true })
    })
  })

  it('keeps the stored key when the draft is left blank', () => {
    const host = stubConfigForm<WebSearchSettings>()
    const credentials = credentialsApi(true)
    const controller = new WebSearchCardController(host.scope, credentials.ctx)
    host.publish({ status: 'ready', writable: true, value: {}, user: {} })
    const face = controller.inject()

    face.edit('apiKey', '   ')

    expect(face.hooks.webSearchCard.getSnapshot().dirty).toBe(false)
    face.save()

    expect(credentials.set).not.toHaveBeenCalled()
  })

  it('re-reads when the Host reports the watched reference changed', async () => {
    const host = stubConfigForm<WebSearchSettings>()
    const credentials = credentialsApi(false)
    const controller = new WebSearchCardController(host.scope, credentials.ctx)
    host.publish({ status: 'ready', writable: true, value: {}, user: {} })
    await vi.waitFor(() => { expect(credentials.describe).toHaveBeenCalled() })
    credentials.describe.mockClear()

    // Another reference is not this card's business.
    controller.refreshCredential('OTHER_KEY')
    expect(credentials.describe).not.toHaveBeenCalled()

    // A key written on another surface reaches this card only through this signal.
    credentials.describe.mockImplementation(() => Promise.resolve({
      ok: true as const,
      value: { DEEPSEEK_API_KEY: { configured: true, writable: true } },
    }))
    controller.refreshCredential('DEEPSEEK_API_KEY')

    await vi.waitFor(() => {
      expect(controller.inject().hooks.webSearchCard.getSnapshot().apiKeyConfigured).toBe(true)
    })
  })

  it('addresses the reference the tab declares rather than the default', async () => {
    const host = stubConfigForm<WebSearchSettings>()
    const credentials = credentialsApi(false)
    const controller = new WebSearchCardController(host.scope, credentials.ctx)
    host.publish({ status: 'ready', writable: true, value: { apiKeyEnv: 'SEARCH_KEY' }, user: {} })
    const face = controller.inject()

    face.edit('apiKey', 'ds-secret')
    face.save()
    await vi.waitFor(() => { expect(credentials.set).toHaveBeenCalled() })

    expect(credentials.set).toHaveBeenCalledWith('SEARCH_KEY', 'ds-secret')
  })

  it('reports a key the Host did not store as a failed save', async () => {
    const host = stubConfigForm<WebSearchSettings>()
    const credentials = credentialsApi(false)
    const controller = new WebSearchCardController(host.scope, credentials.ctx)
    host.publish({ status: 'ready', writable: true, value: {}, user: {} })
    const face = controller.inject()

    face.edit('apiKey', 'ds-secret')
    face.save()

    await vi.waitFor(() => {
      expect(face.hooks.webSearchCard.getSnapshot()).toMatchObject({ failed: true, dirty: true })
    })
  })

  it('keeps the card usable when the credential read is refused', async () => {
    const host = stubConfigForm<WebSearchSettings>()
    const refusal = () => Promise.resolve({
      ok: false as const,
      error: new RemoteError('credential/rejected', 'offline', { ref: 'DEEPSEEK_API_KEY' }),
    })
    const describe = vi.fn(refusal)
    const set = vi.fn(refusal)
    const controller = new WebSearchCardController(host.scope, ctxWith({ credentials: { describe, set } }))
    const face = controller.inject()
    await vi.waitFor(() => { expect(describe).toHaveBeenCalled() })

    host.publish({ status: 'ready', writable: true, value: { baseURL: 'https://search.test/v1' }, user: {} })
    face.edit('apiKey', 'ds-secret')
    face.save()
    await vi.waitFor(() => { expect(set).toHaveBeenCalled() })

    expect(face.hooks.webSearchCard.getSnapshot()).toMatchObject({
      available: true,
      apiKeyConfigured: false,
      baseURL: { text: 'https://search.test/v1' },
    })
  })

  it('ignores a credential read the Host refused', async () => {
    const host = stubConfigForm<WebSearchSettings>()
    const describe = vi.fn(() => Promise.resolve({
      ok: false as const,
      error: new RemoteError('gateway/internal', 'no credential provider', {}),
    }))
    const controller = new WebSearchCardController(host.scope, ctxWith({
      credentials: { describe, set: vi.fn() },
    }))
    await vi.waitFor(() => { expect(describe).toHaveBeenCalled() })

    expect(controller.inject().hooks.webSearchCard.getSnapshot().apiKeyConfigured).toBe(false)
  })

  it('saves the endpoint and the search budget together', async () => {
    const host = stubConfigForm<WebSearchSettings>()
    acceptWrites(host)
    const credentials = credentialsApi(true)
    const controller = new WebSearchCardController(host.scope, credentials.ctx)
    host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: {} })
    const face = controller.inject()

    face.edit('baseURL', 'https://other.test')
    face.edit('maxUses', '3')
    face.save()
    await vi.waitFor(() => { expect(host.mutate).toHaveBeenCalledTimes(1) })

    expect(host.mutate.mock.calls.map(([ops]) => ops)).toEqual([[['baseURL', 'https://other.test'], ['maxUses', 3]].map(([field, value]) => ({ op: 'set', path: [field], value }))])
    expect(credentials.set).not.toHaveBeenCalled()
  })
})
