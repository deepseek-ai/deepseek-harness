/** Page-store join: directory × namespaces × credentials, with last-good rows on failure. */
import { describe, expect, it } from 'vitest'
import type { RpcResponse } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { settingsSchema } from './settings-schema.client.ts'
import { joinProviderDirectory, ModelsSettingsStore } from '../src/client/store.ts'

it.each([false, true])('retains configuration diagnostics when the route is active: %s', (active) => {
  expect(joinProviderDirectory(active ? [{ id: 'openai', name: 'openai' }] : [], [{
    provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'],
    error: 'catalog unavailable',
  }])).toEqual([{
    provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'],
    active, error: 'catalog unavailable',
  }])
})

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}
function fail<T>(message: string): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: false, error: { code: 'gateway/internal', message, details: {} } } }
}

/** Answers over the Remote carrier, which has no envelope. */
type RemoteAnswer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RemoteError }
function remoteOk<T>(value: T): RemoteAnswer<T> {
  return { ok: true, value }
}
function remoteFail<T>(message: string): RemoteAnswer<T> {
  return { ok: false, error: new RemoteError('gateway/internal', message, {}) }
}

const DIRECTORY = [
  { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
  { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: true },
  { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: false },
  { provider: 'ghost', displayName: 'Ghost', settingsNs: '', settingsPath: [], active: true },
]

const NAMESPACES = [
  {
    ns: 'llm-deepseek',
    schema: {},
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://base' },
    base: { baseURL: 'https://base' },
    applies: 'live' as const,
    secrets: [],
    revision: 0,
  },
  {
    ns: 'llm-pi-ai',
    schema: {},
    value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    user: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    applies: 'live' as const,
    secrets: [],
    revision: 0,
  },
]

function api(overrides: {
  providers?: () => Promise<RpcResponse<{ providers: typeof DIRECTORY }>>
  describeSettings?: () => Promise<RemoteAnswer<{ writable: boolean; hasDocument: boolean; namespaces: typeof NAMESPACES }>>
  describeCredentials?: (refs: readonly string[]) => Promise<RemoteAnswer<Record<string, unknown>>>
} = {}) {
  const seenRefs: string[][] = []
  const providers = overrides.providers ?? (() => Promise.resolve(ok({ providers: DIRECTORY })))
  let providerBatch: Promise<RpcResponse<{ providers: typeof DIRECTORY }>> | undefined
  let providerBatchReads = 0
  const readProviderBatch = (): Promise<RpcResponse<{ providers: typeof DIRECTORY }>> => {
    providerBatch ??= providers()
    const current = providerBatch
    providerBatchReads += 1
    if (providerBatchReads % 2 === 0) providerBatch = undefined
    return current
  }
  const mapProviderBatch = async <T>(
    project: (rows: typeof DIRECTORY) => T,
  ): Promise<RemoteAnswer<T>> => {
    const response = await readProviderBatch()
    return response.result.ok
      ? remoteOk(project(response.result.value.providers))
      : remoteFail(response.result.error.message)
  }
  const face = {
    llm: {
      listProviders: () => mapProviderBatch(rows => rows
        .filter(row => row.active)
        .map(row => ({ id: row.provider, name: row.displayName }))),
      listConfigurableProviders: () => mapProviderBatch(rows => rows
        .filter(row => row.settingsNs !== '')
        .map(({ active: _active, ...row }) => row)),
      discoverModels: () => Promise.resolve(remoteOk([])),
    },
    settings: {
      describe: overrides.describeSettings
        ?? (() => Promise.resolve(remoteOk({ writable: true, hasDocument: false, namespaces: NAMESPACES }))),
      mutate: () => Promise.resolve(remoteFail('the store spec issues no writes')),
    },
    credentials: {
      describe: (refs: readonly string[]) => {
        seenRefs.push([...refs])
        return (overrides.describeCredentials ?? (asked => Promise.resolve(remoteOk(
          Object.fromEntries(asked.map(ref => [ref, { configured: ref === 'OPENAI_API_KEY', writable: true }])),
        ))))(refs)
      },
      set: () => Promise.resolve(remoteOk(undefined)),
      unset: () => Promise.resolve(remoteOk(undefined)),
    },
  }
  // The page plugin's context, scripted down to the namespaces it reaches.
  const ctx = { remote: face } as never
  return { ctx, face, mirror: new SettingsDescribeMirror(ctx), seenRefs }
}

describe('ModelsSettingsStore', () => {
  it('joins rows with configured, removable, and credential state', async () => {
    const { ctx, mirror, seenRefs } = api()
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.writable).toBe(true)
    expect(state.credentialError).toBeNull()
    // Named references first (rows order), then the derived <ROUTE>_API_KEY
    // of every row whose profile names none — one batched describe.
    expect(seenRefs).toEqual([['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GHOST_API_KEY']])
    const byProvider = new Map(state.rows.map(row => [row.entry.provider, row]))
    expect(byProvider.get('deepseek-official')).toMatchObject({
      configured: true,
      removable: false,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      credential: { configured: false, writable: true },
    })
    expect(byProvider.get('openai')).toMatchObject({
      configured: true,
      removable: true,
      apiKeyEnv: 'OPENAI_API_KEY',
      credential: { configured: true },
    })
    expect(byProvider.get('anthropic')).toMatchObject({ configured: false, removable: false })
    expect(byProvider.get('anthropic')?.apiKeyEnv).toBeUndefined()
    expect(byProvider.get('ghost')).toMatchObject({ configured: false, removable: false })
    expect(state.namespaces.get('llm-pi-ai')?.ns).toBe('llm-pi-ai')
  })

  it('degrades the credential badge, not the page, when the credential domain fails', async () => {
    const { ctx, mirror } = api({ describeCredentials: () => Promise.resolve(remoteFail('no provider')) })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.credentialError).toBe('no provider')
    expect(state.rows.every(row => row.credential === undefined)).toBe(true)
  })

  it('surfaces a directory failure and keeps the last good rows', async () => {
    const { ctx, mirror } = api()
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    expect(store.store.getSnapshot().rows).toHaveLength(4)
    const broken = api({ providers: () => Promise.resolve(fail('directory down')) })
    const failing = new ModelsSettingsStore(broken.ctx, settingsSchema, broken.mirror)
    await failing.load()
    expect(failing.store.getSnapshot()).toMatchObject({ status: 'error', error: 'directory down' })
    // The first store's snapshot is untouched by the second's failure.
    expect(store.store.getSnapshot().status).toBe('ready')
  })

  it('surfaces a configurable-provider directory failure', async () => {
    const { ctx, face, mirror } = api()
    const llm = (face as unknown as {
      llm: { listConfigurableProviders: () => Promise<RemoteAnswer<never>> }
    }).llm
    llm.listConfigurableProviders = () => Promise.resolve(remoteFail<never>('configuration directory down'))
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)

    await store.load()

    expect(store.store.getSnapshot()).toMatchObject({
      status: 'error', error: 'configuration directory down',
    })
  })

  it('lets the newest load win over a stale slow response', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let call = 0
    const { ctx, mirror } = api({
      providers: async () => {
        call += 1
        if (call === 1) {
          await gate
          return fail('stale slow failure')
        }
        return ok({ providers: DIRECTORY })
      },
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    const first = store.load()
    const second = store.load()
    release?.()
    await Promise.all([first, second])
    expect(store.store.getSnapshot().status).toBe('ready')
  })
})

describe('edge joins', () => {
  it('treats a non-object profile as having no credential reference', async () => {
    const { ctx, mirror } = api({
      describeSettings: () => Promise.resolve(remoteOk({
        writable: true,
        hasDocument: false,
        namespaces: [{
          ns: 'llm-pi-ai',
          schema: {},
          value: { providers: { weird: 'oops' } },
          applies: 'live' as const,
          secrets: [],
          revision: 0,
        }] as never,
      })),
      providers: () => Promise.resolve(ok({
        providers: [
          { provider: 'weird', displayName: 'weird', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'weird'], active: false },
        ] as never,
      })),
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.rows[0]).toMatchObject({ configured: true, removable: false })
    expect(state.rows[0]?.apiKeyEnv).toBeUndefined()
  })

  it('describes the derived reference for a row whose profile names none', async () => {
    const { ctx, mirror, seenRefs } = api({
      describeSettings: () => Promise.resolve(remoteOk({
        writable: true,
        hasDocument: false,
        namespaces: [{ ns: 'llm-pi-ai', schema: {}, value: { providers: {} }, applies: 'live' as const, secrets: [], revision: 0 }] as never,
      })),
      providers: () => Promise.resolve(ok({
        providers: [
          { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: false },
        ] as never,
      })),
      describeCredentials: refs => Promise.resolve(remoteOk(
        Object.fromEntries(refs.map(ref => [ref, { configured: true, writable: true }])),
      )),
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    // The dormant row names no reference, so the join asks about the page's
    // own derived <ROUTE>_API_KEY — what the editor would display for it.
    expect(seenRefs).toEqual([['ANTHROPIC_API_KEY']])
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.rows[0]?.credential).toBeUndefined()
    expect(state.rows[0]?.derivedCredential).toMatchObject({ configured: true })
  })

  it('surfaces a settings describe failure', async () => {
    const { ctx, mirror } = api({ describeSettings: () => Promise.resolve(remoteFail('settings down')) })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'error', error: 'settings down' })
  })

  it('reports a terminally unavailable settings mirror precisely', async () => {
    const { ctx } = api()
    const store = new ModelsSettingsStore(
      ctx,
      settingsSchema,
      new SettingsDescribeMirror(ctx, 'memory'),
    )
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'error',
      error: 'settings are unavailable in this browser',
    })
  })

  it('reuses a held settings view after its refresh fails', async () => {
    let settingsCall = 0
    const { ctx, mirror } = api({
      describeSettings: () => {
        settingsCall += 1
        return Promise.resolve(settingsCall === 1
          ? remoteOk({ writable: true, hasDocument: false, namespaces: NAMESPACES })
          : remoteFail('settings refresh down'))
      },
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    await mirror.load()
    expect(mirror.getSnapshot().error).toBe('settings refresh down')
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'ready', error: null })
    expect(store.store.getSnapshot().rows).toHaveLength(4)
  })

  it('drops a stale successful response after a newer load finished', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let call = 0
    const { ctx, mirror } = api({
      providers: async () => {
        call += 1
        if (call === 1) {
          await gate
          return ok({ providers: [] as never })
        }
        return ok({ providers: DIRECTORY })
      },
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    const first = store.load()
    const second = store.load()
    await second
    release?.()
    await first
    // The stale empty directory never overwrote the newer join.
    expect(store.store.getSnapshot().rows).toHaveLength(4)
  })
})
