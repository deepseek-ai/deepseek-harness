import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { createModels, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type { Api, Model, OpenAICompletionsCompat, Provider } from '@earendil-works/pi-ai'
import { resolveProfiles } from '../src/config.ts'
import { buildProvider, supportedProtocols } from '../src/provider.ts'
import { assemble } from './assemble.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const homes: string[] = []

// Routes name their credential by reference; the value lives in the
// environment, which is the layer the adapter falls back to without a
// mounted credentials seam.
const KEY_ENV = 'PI_TEST_KEY'

beforeEach(() => {
  vi.stubEnv(KEY_ENV, 'test-key')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
  await Promise.all(homes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A throwaway $DSH_HOME with an empty settings document. */
async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-catalog-'))
  homes.push(dir)
  await writeFile(join(dir, 'settings.yaml'), '')
  return dir
}

/** The dormant composition plus a real settings service, as the product mounts it. */
async function bootWithSettings(dir: string, config: LlmPiAi.Config): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  await ctx.plugin(LlmPiAi, config)
  return ctx
}

/** A complete hand-declared route: nothing about it exists in pi-ai's catalog. */
function gateway(baseURL: string, overrides: Record<string, unknown> = {}): LlmPiAi.Config {
  return {
    providers: {
      'acme-gateway': {
        apiKeyEnv: KEY_ENV,
        displayName: 'Acme Gateway',
        api: 'openai-completions',
        baseURL,
        models: [{ id: 'acme-large', name: 'Acme Large', contextWindow: 65_536, maxTokens: 4096 }],
        ...overrides,
      },
    },
  }
}

async function harness(config: LlmPiAi.Config): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, config)
  return ctx
}

describe('hand-declared providers', () => {
  it('serves a route pi-ai has never heard of from its own declaration', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(gateway(`${server.url}/v1`))

    const result = await assemble(ctx, {
      provider: 'acme-gateway',
      model: 'acme-large',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })

    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.paths).toEqual(['/v1/chat/completions'])
    // The reference resolved through the environment and reached the wire.
    expect(server.headers[0]?.authorization).toBe('Bearer test-key')
  })

  it('lists and resolves the declared models rather than a catalog', async () => {
    const server = await mockServer([])
    const ctx = await harness(gateway(`${server.url}/v1`))

    expect(await ctx.llm.listModels('acme-gateway')).toEqual([
      { provider: 'acme-gateway', id: 'acme-large', name: 'Acme Large', inputModalities: ['text'] },
    ])
    const info = await ctx.llm.resolveModelInfo('acme-gateway', 'acme-large')
    expect(info).toMatchObject({
      provider: 'acme-gateway',
      id: 'acme-large',
      name: 'Acme Large',
      context: { contextWindow: 65_536 },
      defaultMaxTokens: 4096,
    })
  })

  it('offers no reasoning control it could not honour', async () => {
    const server = await mockServer([])
    const ctx = await harness(gateway(`${server.url}/v1`))

    // pi-ai reports a model with no reasoning metadata as supporting the single
    // level `off`, but `off` is translated to *omitting* the reasoning option —
    // byte-for-byte the same request as naming no effort — so a provider whose
    // own default is to think would keep thinking with `off` selected. The
    // capability is reported unavailable instead of offering that control.
    expect((await ctx.llm.resolveModelInfo('acme-gateway', 'acme-large')).reasoning).toBeUndefined()

    // A catalog route is unaffected: its models carry the metadata that makes
    // `off` actually disable thinking.
    const withCatalog = await harness({ providers: { deepseek: { baseURL: server.url } } })
    const [catalogModel] = getBuiltinModels('deepseek')
    if (catalogModel === undefined) throw new Error('the installed catalog ships no deepseek model')
    expect((await withCatalog.llm.resolveModelInfo('deepseek', catalogModel.id)).reasoning?.efforts.map(e => e.id))
      .toContain('off')
  })

  it('joins the configurable-provider directory so a settings surface can reach it', async () => {
    const server = await mockServer([])
    const ctx = await harness(gateway(`${server.url}/v1`))
    const directory = ctx.llm.listConfigurableProviders()

    expect(directory).toContainEqual({
      provider: 'acme-gateway',
      displayName: 'Acme Gateway',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'acme-gateway'],
      // Nothing in the installed catalog answers for this route, which is what
      // configuration surfaces mark as a route this deployment declared.
      declared: true,
    })
    // Membership of the catalog, not of the settings document: a shipped
    // provider carries a stored profile the moment anyone corrects it.
    expect(directory.filter(entry => entry.declared).map(entry => entry.provider))
      .toEqual(['acme-gateway'])
    expect(directory.find(entry => entry.provider === 'deepseek')?.declared).toBe(false)
  })

  it('sizes a model the catalog cannot describe from the route\u2019s own fallbacks', () => {
    const resolved = resolveProfiles({
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        // A listing endpoint that discloses nothing but ids still yields a
        // serviceable route.
        models: [{ id: 'bare' }, { id: 'sized', contextWindow: 8192, maxTokens: 512 }],
      },
      'tuned-gateway': {
        api: 'openai-completions',
        baseURL: 'https://tuned.test',
        defaultContextWindow: 4096,
        defaultMaxTokens: 256,
        models: [{ id: 'bare' }],
      },
    })
    const modelsOf = (route: string): readonly { id: string; contextWindow: number; maxTokens: number }[] =>
      resolved.get(route)?.piProvider.getModels() ?? []

    expect(modelsOf('acme-gateway')).toMatchObject([
      { id: 'bare', contextWindow: 262_144, maxTokens: 32_768 },
      { id: 'sized', contextWindow: 8192, maxTokens: 512 },
    ])
    // The fallback is a guess, so a deployment whose gateway serves smaller
    // models corrects it once for the whole route.
    expect(modelsOf('tuned-gateway')).toMatchObject([{ id: 'bare', contextWindow: 4096, maxTokens: 256 }])
    // Only an explicitly configured cap is a request default; a fallback is
    // the model's capability and stops there.
    expect(resolved.get('acme-gateway')?.configuredMaxTokens.get('bare')).toBeUndefined()
    expect(resolved.get('acme-gateway')?.configuredMaxTokens.get('sized')).toBe(512)
  })

  it('takes a model’s declared modalities, then the catalog’s, then the route’s', () => {
    const vision = getBuiltinModels('anthropic').find(model => model.input.includes('image'))
    if (vision === undefined) throw new Error('the installed catalog ships no anthropic vision model')
    const resolved = resolveProfiles({
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        // One route, two modality sets: the entry field is what says so.
        models: [{ id: 'bare' }, { id: 'seeing', input: ['text', 'image'] }, { id: 'deaf', input: ['text'] }],
      },
      'seeing-gateway': {
        api: 'openai-completions',
        baseURL: 'https://seeing.test',
        // A gateway whose undescribed models all take images says so once
        // rather than on every entry; an entry still outranks it.
        defaultInput: ['text', 'image'],
        models: [{ id: 'bare' }, { id: 'deaf', input: ['text'] }],
      },
      // The route value is a fallback, never an override: a catalog model
      // keeps what the catalog records even under a narrower route default,
      // exactly as it keeps its own contextWindow.
      'anthropic': { defaultInput: ['text'] },
    })
    const inputOf = (route: string, id: string): readonly string[] | undefined =>
      resolved.get(route)?.piProvider.getModels().find(model => model.id === id)?.input

    expect(inputOf('acme-gateway', 'bare')).toEqual(['text'])
    expect(inputOf('acme-gateway', 'seeing')).toEqual(['text', 'image'])
    expect(inputOf('acme-gateway', 'deaf')).toEqual(['text'])
    expect(inputOf('seeing-gateway', 'bare')).toEqual(['text', 'image'])
    expect(inputOf('seeing-gateway', 'deaf')).toEqual(['text'])
    expect(inputOf('anthropic', vision.id)).toEqual(vision.input)
  })

  it('carries a written modality declaration all the way to the seam’s model metadata', async () => {
    // The resolver-level cases above cannot see a break between the settings
    // document and `LlmModelInfo`, so each rung is asserted once more through
    // a written section, the plugin's own registration, and `ctx.llm`.
    const dir = await home()
    const ctx = await bootWithSettings(dir, {})
    await ctx.settings.update('llm-pi-ai', {
      providers: {
        'acme-gateway': {
          api: 'openai-completions',
          baseURL: 'https://acme.test/v1',
          models: [{ id: 'bare' }, { id: 'seeing', input: ['text', 'image'] }],
        },
        'vision-gateway': {
          api: 'openai-completions',
          baseURL: 'https://vision.test/v1',
          defaultInput: ['text', 'image'],
          models: [{ id: 'bare' }, { id: 'deaf', input: ['text'] }],
        },
        'anthropic': { defaultInput: ['text'] },
      },
    })

    const listed = async (provider: string): Promise<Record<string, readonly string[] | undefined>> =>
      Object.fromEntries((await ctx.llm.listModels(provider)).map(model => [model.id, model.inputModalities]))

    expect(await listed('acme-gateway')).toEqual({ bare: ['text'], seeing: ['text', 'image'] })
    expect(await listed('vision-gateway')).toEqual({ bare: ['text', 'image'], deaf: ['text'] })
    expect((await ctx.llm.resolveModelInfo('acme-gateway', 'seeing')).inputModalities).toEqual(['text', 'image'])

    // A catalog vision model keeps what the catalog records even under a
    // narrower route default: the route value is a fallback, not an override.
    const vision = getBuiltinModels('anthropic').find(model => model.input.includes('image'))
    if (vision === undefined) throw new Error('the installed catalog ships no anthropic vision model')
    expect((await ctx.llm.resolveModelInfo('anthropic', vision.id)).inputModalities).toEqual(vision.input)
  })

  it('reads an entry’s empty modality list as no answer, and the route’s as unserviceable', () => {
    // Absent and empty are the same request on an entry, exactly as they are
    // for the route's `models` list — which matters because the config schema
    // materializes `[]` for an absent array, so an entry naming a catalog
    // model without declaring modalities must keep the catalog's rather than
    // describe a model that accepts nothing.
    const [catalogModel] = getBuiltinModels('deepseek')
    if (catalogModel === undefined) throw new Error('the installed catalog ships no deepseek model')
    const resolved = resolveProfiles({
      'deepseek': { baseURL: 'https://catalog.test', models: [{ id: catalogModel.id, input: [] }] },
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        models: [{ id: 'bare', input: [] }],
      },
    })
    expect(resolved.get('acme-gateway')?.piProvider.getModels()[0]?.input).toEqual(['text'])
    expect(resolved.get('deepseek')?.piProvider.getModels()[0]?.input).toEqual(catalogModel.input)

    // Nothing sits below the route value, so its empty list states no answer
    // anything could take, and is refused where it is written.
    expect(() => resolveProfiles({
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        defaultInput: [],
        models: [{ id: 'bare' }],
      },
    })).toThrow(/defaultInput must name at least one modality/)
  })

  it('rejects a model the route cannot identify', () => {
    const declare = (model: LlmPiAi.PiAiModelProfile): (() => unknown) =>
      () => resolveProfiles({ 'acme-gateway': { api: 'openai-completions', baseURL: 'https://acme.test', models: [model] } })

    expect(declare({ id: '' })).toThrow(/empty id/)
    expect(() => resolveProfiles({
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        models: [{ id: 'dup', contextWindow: 1, maxTokens: 1 }, { id: 'dup', contextWindow: 2, maxTokens: 2 }],
      },
    })).toThrow(/more than once/)
  })

  it('rejects a declaration that names no wire protocol or endpoint', () => {
    expect(() => resolveProfiles({
      'acme-gateway': { baseURL: 'https://acme.test', models: [{ id: 'm', contextWindow: 1, maxTokens: 1 }] },
    })).toThrow(/needs an api/)
    expect(() => resolveProfiles({
      'acme-gateway': { api: 'openai-completions', models: [{ id: 'm', contextWindow: 1, maxTokens: 1 }] },
    })).toThrow(/needs a baseURL/)
  })

  it.each(['bedrock-converse-stream', 'google-vertex', 'azure-openai-responses', 'openai-codex-responses'])(
    'refuses %s, whose authentication a profile cannot express',
    (api) => {
      // These need SigV4 credentials and a region, a project plus ADC, provider
      // environment and an api-version, or OAuth — none of which a key, an
      // endpoint, and headers can carry, so a route naming one would be built
      // unable to authenticate.
      expect(supportedProtocols()).not.toContain(api)
      expect(() => buildProvider({ provider: 'acme-gateway', displayName: 'Acme', api, models: [], namesCredential: true }))
        .toThrow(/cannot serve; supported protocols are/)
    },
  )

  it('rejects a protocol this build cannot serve, and a route that names none', () => {
    const spec = { provider: 'acme-gateway', displayName: 'Acme Gateway', models: [], namesCredential: true }
    expect(() => buildProvider({ ...spec, api: 'quantum-telepathy' }))
      .toThrow(/cannot serve; supported protocols are/)
    expect(() => buildProvider(spec)).toThrow(/cannot serve; supported protocols are/)
  })

  it('leaves an unauthenticated route to its protocol rather than inventing a credential', async () => {
    const server = await mockServer([{ events: textEvents }])
    // Naming no credential is the deliberately unauthenticated posture — a
    // named reference that resolved to nothing would have failed with
    // MISSING_CREDENTIAL long before this point. The route resolves as
    // configured and the protocol decides: pi-ai's OpenAI-compatible
    // implementation wants a key or an Authorization header of its own, and
    // says so instead of the harness guessing a placeholder.
    const ctx = await harness({
      providers: {
        'local-llm': {
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          models: [{ id: 'qwen3', contextWindow: 32_768, maxTokens: 2048 }],
        },
      },
    })

    const result = await assemble(ctx, { provider: 'local-llm', model: 'qwen3', messages: [] })
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { message: 'No API key for provider: local-llm' },
    })
    expect(server.requests).toHaveLength(0)
  })

  it('authenticates an unauthenticated route through a configured header', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness({
      providers: {
        'local-llm': {
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          headers: { Authorization: 'Bearer local' },
          models: [{ id: 'qwen3', contextWindow: 32_768, maxTokens: 2048 }],
        },
      },
    })

    const result = await assemble(ctx, { provider: 'local-llm', model: 'qwen3', messages: [] })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.headers[0]?.authorization).toBe('Bearer local')
  })

  it('rejects a capacity that is not a positive integer', () => {
    const declare = (model: LlmPiAi.PiAiModelProfile): (() => unknown) =>
      () => resolveProfiles({ 'acme-gateway': { api: 'openai-completions', baseURL: 'https://acme.test', models: [model] } })

    expect(declare({ id: 'm', contextWindow: 0, maxTokens: 1 })).toThrow(/contextWindow must be a positive integer/)
    expect(declare({ id: 'm', contextWindow: 1.5, maxTokens: 1 })).toThrow(/contextWindow must be a positive integer/)
    expect(declare({ id: 'm', contextWindow: 1, maxTokens: 0 })).toThrow(/maxTokens must be a positive integer/)
    expect(declare({ id: 'm', contextWindow: 1, maxTokens: 1.5 })).toThrow(/maxTokens must be a positive integer/)
  })

  it('names the route key when no displayName is configured', () => {
    const resolved = resolveProfiles({
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        models: [{ id: 'm', contextWindow: 1, maxTokens: 1 }],
      },
    })
    expect(resolved.get('acme-gateway')?.displayName).toBe('acme-gateway')
    expect(() => resolveProfiles({ 'acme-gateway': { displayName: '' } })).toThrow(/empty displayName/)
  })
})

describe('catalog routes with per-model configuration', () => {
  it('serves the installed catalog untouched when the profile lists no models', async () => {
    const server = await mockServer([])
    const ctx = await harness({ providers: { deepseek: { baseURL: server.url } } })

    const listed = await ctx.llm.listModels('deepseek')
    expect(listed.map(model => model.id).sort())
      .toEqual(getBuiltinModels('deepseek').map(model => model.id).sort())
  })

  it('overrides one catalog model field and defaults the rest from the catalog', async () => {
    const server = await mockServer([])
    const [catalogModel] = getBuiltinModels('deepseek')
    if (catalogModel === undefined) throw new Error('the installed catalog ships no deepseek model')
    const ctx = await harness({
      providers: {
        deepseek: {
          baseURL: server.url,
          models: [{ id: catalogModel.id, contextWindow: 4096 }],
        },
      },
    })

    const info = await ctx.llm.resolveModelInfo('deepseek', catalogModel.id)
    // The configured field wins and the name still comes from the catalog. The
    // catalog's own output cap is the model's capability, not a cap anyone
    // chose, so it must not arrive as the request default.
    expect(info.context).toEqual({ contextWindow: 4096 })
    expect(info.name).toBe(catalogModel.name)
    expect(info.defaultMaxTokens).toBeUndefined()
    // An explicit list replaces the catalog rather than adding to it.
    expect((await ctx.llm.listModels('deepseek')).map(model => model.id)).toEqual([catalogModel.id])
  })

  it('materializes a request default only from a configured output cap', async () => {
    const server = await mockServer([])
    const [catalogModel] = getBuiltinModels('deepseek')
    if (catalogModel === undefined) throw new Error('the installed catalog ships no deepseek model')
    const ctx = await harness({
      providers: {
        deepseek: {
          baseURL: server.url,
          models: [{ id: catalogModel.id, maxTokens: 4096 }],
        },
      },
    })

    // Configuring the cap is the deployment choosing one, so it becomes the
    // default the seam materializes into requests that name none.
    expect((await ctx.llm.resolveModelInfo('deepseek', catalogModel.id)).defaultMaxTokens).toBe(4096)
  })

  it('adds a model the installed catalog does not describe to a catalog route', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness({
      providers: {
        deepseek: {
          apiKeyEnv: KEY_ENV,
          baseURL: `${server.url}/v1`,
          models: [{ id: 'deepseek-preview', contextWindow: 200_000, maxTokens: 8192 }],
        },
      },
    })

    const result = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-preview', messages: [] })
    expect(result.finish).toEqual({ kind: 'stop' })
    // The catalog route keeps its catalog protocol, so the new model reaches
    // the same endpoint shape the shipped models use.
    expect(server.paths).toEqual(['/v1/chat/completions'])
  })

  it('fails an unconfigured model id before any provider request', async () => {
    const server = await mockServer([])
    const ctx = await harness({
      providers: {
        deepseek: { baseURL: server.url, models: [{ id: 'deepseek-preview', contextWindow: 1, maxTokens: 1 }] },
      },
    })

    const result = await assemble(ctx, { provider: 'deepseek', model: 'not-configured', messages: [] })

    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'UNKNOWN_MODEL' } })
    expect(server.requests).toHaveLength(0)
  })

  it('preserves catalog-only model metadata the profile cannot express', () => {
    // Some catalog models carry provider-required request headers; overriding a
    // capacity must not drop them, because configuration has no way to restate
    // them.
    const headered = (getBuiltinModels('nvidia') as { id: string; headers?: unknown }[])
      .find(model => model.headers !== undefined)
    if (headered === undefined) throw new Error('the installed catalog ships no nvidia model with headers')

    const resolved = resolveProfiles({
      nvidia: { models: [{ id: headered.id, contextWindow: 4096 }] },
    })
    const [model] = resolved.get('nvidia')?.piProvider.getModels() ?? []
    expect(model?.headers).toEqual(headered.headers)
    expect(model?.contextWindow).toBe(4096)
  })

  it('delegates both stream methods back to the reused catalog provider', async () => {
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const resolved = resolveProfiles({ deepseek: { baseURL: `${server.url}/v1` } })
    const built = resolved.get('deepseek')?.piProvider
    if (built === undefined) throw new Error('the deepseek route built no provider')
    const [model] = built.getModels()
    if (model === undefined) throw new Error('the deepseek route resolved no models')
    const context = { messages: [{ role: 'user' as const, content: 'hi', timestamp: 0 }] }

    // `stream` is interface-required and unused by the harness adapter, which
    // only calls `streamSimple`; both must still reach the catalog provider.
    for await (const _event of built.stream(model, context, { apiKey: 'k' })) { /* drain */ }
    for await (const _event of built.streamSimple(model, context, { apiKey: 'k' })) { /* drain */ }

    expect(server.paths).toEqual(['/v1/chat/completions', '/v1/chat/completions'])
  })

  it('keeps each model its own endpoint when the catalog route declares none', () => {
    // `opencode` ships no provider-level endpoint: the address lives on every
    // catalog model, so the route resolves without any configured baseURL.
    const resolved = resolveProfiles({ opencode: {} })
    const models = resolved.get('opencode')?.piProvider.getModels() ?? []
    expect(models.length).toBeGreaterThan(0)
    expect(models.every(model => model.baseUrl.length > 0)).toBe(true)
    expect(resolved.get('opencode')?.piProvider.baseUrl).toBeUndefined()
  })

  it('repoints a catalog route at another wire protocol without restating its endpoint', () => {
    const resolved = resolveProfiles({ openai: { api: 'openai-completions' } })
    const models = resolved.get('openai')?.piProvider.getModels() ?? []
    // The protocol changes for the whole route; each model keeps the catalog
    // endpoint it already had.
    expect(models.every(model => model.api === 'openai-completions')).toBe(true)
    expect(models.every(model => model.baseUrl === 'https://api.openai.com/v1')).toBe(true)
  })

  it('repoints a catalog route at another wire protocol', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness({
      providers: {
        // openai's catalog models speak the Responses API; naming the protocol
        // explicitly moves the whole route onto Chat Completions.
        openai: {
          apiKeyEnv: KEY_ENV,
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          models: [{ id: 'gpt-4.1', contextWindow: 100_000, maxTokens: 4096 }],
        },
      },
    })

    await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })
    expect(server.paths).toEqual(['/v1/chat/completions'])
  })

  it('keeps the catalog provider’s own auth when the route repoints its protocol', () => {
    // Which environment a provider reads is a property of the provider, not of
    // the wire format its models speak: naming an api must not cost a profile
    // its provider-native discovery.
    const resolved = resolveProfiles({ openai: { api: 'openai-completions' } })
    expect(resolved.get('openai')?.piProvider.auth.apiKey?.name).toBe('OpenAI API key')
  })

  it('lets an OAuth-only catalog route authenticate with the key its profile names', async () => {
    // pi-ai honours a request's `apiKey` override only when the provider
    // declares an api-key method. `openai-codex` ships OAuth alone, so without
    // the harness method beside it the route refuses its own configured key as
    // `Provider is not configured` before any request goes out.
    const resolved = resolveProfiles({ 'openai-codex': { apiKeyEnv: 'CODEX_TOKEN' } })
    const provider = resolved.get('openai-codex')?.piProvider
    expect(provider?.auth.oauth).toBeDefined()
    const models = createModels()
    models.setProvider(provider as Provider)
    const model = provider?.getModels()[0] as Model<Api>
    const auth = await models.getAuth(model, { apiKey: 'codex-token' })
    expect(auth?.auth.apiKey).toBe('codex-token')
  })

  it('leaves an OAuth-only catalog route unconfigured when its profile names no key', () => {
    // Nothing to add: this adapter resolves credentials through its own seam
    // and holds no OAuth store, so declaring the provider configured would
    // trade a truthful refusal for an endpoint's 401.
    const resolved = resolveProfiles({ 'openai-codex': {} })
    expect(resolved.get('openai-codex')?.piProvider.auth.apiKey).toBeUndefined()
  })
})

describe('per-model reasoning efforts', () => {
  /** One hand-declared route holding exactly the given models. */
  function declared(models: LlmPiAi.PiAiModelProfile[]): Record<string, LlmPiAi.PiAiProviderProfile> {
    return { 'acme-gateway': { api: 'openai-completions', baseURL: 'https://acme.test', models } }
  }

  /** The first materialized model of one route, or throw. */
  function modelOf(providers: Record<string, LlmPiAi.PiAiProviderProfile>, route = 'acme-gateway'): Model<Api> {
    const [model] = resolveProfiles(providers).get(route)?.piProvider.getModels() ?? []
    if (model === undefined) throw new Error(`route "${route}" resolved no models`)
    return model
  }

  it('declares selectable levels with their wire spellings on a hand-declared model', () => {
    const model = modelOf(declared([{
      id: 'acme-think',
      reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'ultra' },
    }]))

    expect(model.reasoning).toBe(true)
    // Undeclared levels are pinned null rather than left to pi-ai's own
    // defaulting, which is asymmetric: an absent key means "supported" for the
    // five base levels but "unsupported" for xhigh/max. A profile author
    // should not need to know that. Declared `off` with no value stays absent
    // from the map — supported, send nothing.
    expect(model.thinkingLevelMap).toEqual({
      minimal: null,
      medium: null,
      xhigh: null,
      low: 'low',
      high: 'high',
      max: 'ultra',
    })
    expect(getSupportedThinkingLevels(model)).toEqual(['off', 'low', 'high', 'max'])
  })

  it('keeps a declared off value in the map for dispatch to send', () => {
    const model = modelOf(declared([{ id: 'm', reasoningEfforts: { off: 'none', high: 'high' } }]))
    expect(model.thinkingLevelMap?.off).toBe('none')
    expect(getSupportedThinkingLevels(model)).toEqual(['off', 'high'])
  })

  it('offers exactly the declared keys: leaving off out makes thinking mandatory', () => {
    const model = modelOf(declared([{ id: 'm', reasoningEfforts: { high: 'high' } }]))
    expect(getSupportedThinkingLevels(model)).toEqual(['high'])
  })

  it('narrows a catalog model’s levels in place', () => {
    const [catalogModel] = getBuiltinModels('deepseek')
    if (catalogModel === undefined) throw new Error('the installed catalog ships no deepseek model')
    expect(getSupportedThinkingLevels(catalogModel as Model<Api>)).toEqual(['off', 'low', 'high', 'max'])

    const model = modelOf({
      deepseek: { models: [{ id: catalogModel.id, reasoningEfforts: { off: null, high: 'high' } }] },
    }, 'deepseek')

    expect(getSupportedThinkingLevels(model)).toEqual(['off', 'high'])
    // Only the reasoning fields change; identity and capacities stay catalog.
    expect(model.name).toBe(catalogModel.name)
    expect(model.contextWindow).toBe(catalogModel.contextWindow)
  })

  it('strips reasoning from a catalog model with false', () => {
    const [catalogModel] = getBuiltinModels('deepseek')
    if (catalogModel === undefined) throw new Error('the installed catalog ships no deepseek model')
    expect(catalogModel.reasoning).toBe(true)

    const model = modelOf({ deepseek: { models: [{ id: catalogModel.id, reasoningEfforts: false }] } }, 'deepseek')

    expect(model.reasoning).toBe(false)
    expect(getSupportedThinkingLevels(model)).toEqual(['off'])
  })

  it('inherits the catalog capability when the field is absent', () => {
    const [catalogModel] = getBuiltinModels('deepseek')
    if (catalogModel === undefined) throw new Error('the installed catalog ships no deepseek model')

    const model = modelOf({ deepseek: { models: [{ id: catalogModel.id }] } }, 'deepseek')

    expect(model.reasoning).toBe(catalogModel.reasoning)
    expect(model.thinkingLevelMap).toEqual(catalogModel.thinkingLevelMap)
  })

  it('rejects a declaration that offers nothing or spells a level it cannot send', () => {
    const declare = (efforts: NonNullable<LlmPiAi.PiAiModelProfile['reasoningEfforts']>): (() => unknown) =>
      () => resolveProfiles(declared([{ id: 'm', reasoningEfforts: efforts }]))

    expect(declare({})).toThrow(/empty reasoningEfforts/)
    // A YAML `reasoningEfforts:` left valueless arrives as null through the
    // schema union; it declares nothing and is not a spelling of "inherit".
    expect(declare(null as never)).toThrow(/empty reasoningEfforts/)
    expect(declare({ off: null })).toThrow(/offers no level beyond "off"/)
    expect(declare({ off: 'none' })).toThrow(/offers no level beyond "off"/)
    expect(declare({ high: null })).toThrow(/only "off" may leave it empty/)
    expect(declare({ high: '' })).toThrow(/must not be an empty string/)
  })
})

describe('modelOverrides', () => {
  const deepseekModel = (): Model<Api> => {
    const [model] = getBuiltinModels('deepseek')
    if (model === undefined) throw new Error('the installed catalog ships no deepseek model')
    return model
  }

  it('reshapes one catalog model while the rest of the catalog keeps serving', () => {
    const catalogSize = getBuiltinModels('deepseek').length
    const target = deepseekModel()
    const resolved = resolveProfiles({
      deepseek: {
        modelOverrides: {
          [target.id]: {
            name: 'DeepSeek (proxied)',
            maxTokens: 4096,
            reasoningEfforts: { off: null, high: 'high' },
          },
        },
      },
    })
    const models = resolved.get('deepseek')?.piProvider.getModels() ?? []
    const reshaped = models.find(model => model.id === target.id)
    if (reshaped === undefined) throw new Error('the overridden model vanished from the route')

    // The whole catalog still serves — that is the difference from `models`,
    // which replaces it.
    expect(models).toHaveLength(catalogSize)
    expect(reshaped.name).toBe('DeepSeek (proxied)')
    expect(getSupportedThinkingLevels(reshaped)).toEqual(['off', 'high'])
    // An override's cap is explicit configuration, so it becomes the request
    // default exactly as a models entry's would.
    expect(resolved.get('deepseek')?.configuredMaxTokens.get(target.id)).toBe(4096)
    // A sibling the overrides do not name is byte-identical to the catalog.
    const sibling = models.find(model => model.id !== target.id)
    expect(sibling?.maxTokens).toBe(getBuiltinModels('deepseek').find(model => model.id === sibling?.id)?.maxTokens)
  })

  it('refuses every override that lands nowhere instead of skipping it', () => {
    expect(() => resolveProfiles({
      deepseek: { modelOverrides: { 'no-such-model': { name: 'ghost' } } },
    })).toThrow(/which the installed catalog does not describe/)
    expect(() => resolveProfiles({
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        models: [{ id: 'm' }],
        modelOverrides: { m: { name: 'renamed' } },
      },
    })).toThrow(/a declared route spells every model out/)
    const declaredOnly = deepseekModel()
    expect(() => resolveProfiles({
      deepseek: {
        models: [{ id: declaredOnly.id }],
        modelOverrides: { [declaredOnly.id]: { name: 'renamed' } },
      },
    })).toThrow(/models already replaces the served catalog/)
    expect(() => resolveProfiles({
      deepseek: { modelOverrides: { '': { name: 'nameless' } } },
    })).toThrow(/empty model id/)
    // The dict key is the id; a value smuggling its own would quietly rename
    // the model it meant to customize. The schema passes unknown keys
    // through, so resolution is the boundary that refuses it — the variable
    // indirection mirrors that boundary by sidestepping the literal check.
    const smuggled = { name: 'x', id: 'other' }
    expect(() => resolveProfiles({
      deepseek: { modelOverrides: { [deepseekModel().id]: smuggled } },
    })).toThrow(/sets "id", which is the dict key/)
  })
})

describe('compat switches', () => {
  /** The materialized models of one route, keyed by id. */
  function modelsOf(providers: Record<string, LlmPiAi.PiAiProviderProfile>, route: string): Map<string, Model<Api>> {
    const models = resolveProfiles(providers).get(route)?.piProvider.getModels() ?? []
    return new Map(models.map(model => [model.id, model]))
  }

  it('applies route switches to every openai-completions model, entries winning per field', () => {
    const models = modelsOf({
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        compat: { thinkingFormat: 'deepseek' },
        models: [
          { id: 'dialect-default', reasoningEfforts: { off: null, high: 'high' } },
          { id: 'dialect-odd', compat: { thinkingFormat: 'openai', supportsReasoningEffort: false } },
        ],
      },
    }, 'acme-gateway')

    expect(models.get('dialect-default')?.compat).toEqual({ thinkingFormat: 'deepseek' })
    expect(models.get('dialect-odd')?.compat).toEqual({ thinkingFormat: 'openai', supportsReasoningEffort: false })
  })

  it('merges the switches over the catalog entry’s own compat instead of replacing it', () => {
    const [catalogModel] = getBuiltinModels('deepseek')
    if (catalogModel === undefined) throw new Error('the installed catalog ships no deepseek model')
    const inherited = catalogModel.compat as OpenAICompletionsCompat
    expect(inherited.requiresReasoningContentOnAssistantMessages).toBe(true)

    const models = modelsOf({
      deepseek: { models: [{ id: catalogModel.id, compat: { thinkingFormat: 'openai' } }] },
    }, 'deepseek')

    // The one switched field changes; the catalog's other quirks survive,
    // because configuration has no way to restate them.
    expect(models.get(catalogModel.id)?.compat).toEqual({ ...inherited, thinkingFormat: 'openai' })
  })

  it('skips models of other protocols on a mixed route instead of failing them', () => {
    const catalog = getBuiltinModels('opencode') as readonly Model<Api>[]
    const completions = catalog.find(model => model.api === 'openai-completions')
    const responses = catalog.find(model => model.api === 'openai-responses')
    if (completions === undefined || responses === undefined) throw new Error('opencode ships no mixed catalog')

    const models = modelsOf({
      opencode: {
        compat: { supportsReasoningEffort: false },
        models: [{ id: completions.id }, { id: responses.id }],
      },
    }, 'opencode')

    expect((models.get(completions.id)?.compat as OpenAICompletionsCompat).supportsReasoningEffort).toBe(false)
    expect(models.get(responses.id)?.compat).toEqual(responses.compat)
  })

  it('rejects a model-level switch on a protocol that has no such field, naming what it offers', () => {
    expect(() => resolveProfiles({
      anthropic: {
        models: [{ id: 'claude-sonnet-4-5', compat: { thinkingFormat: 'openai' } }],
      },
    })).toThrow(/its api is "anthropic-messages", which does not take it.*exists on openai-completions/s)
  })

  it('rejects route switches no model on the route can take', () => {
    expect(() => resolveProfiles({
      anthropic: { compat: { thinkingFormat: 'openai' } },
    })).toThrow(/no model on the route speaks a protocol that takes it/)
  })

  it('carries the developer-role switch onto a hand-declared reasoning model', () => {
    // pi-ai reads this switch only for a reasoning model, and detects it from
    // the endpoint URL — which for a private gateway answers as though it were
    // OpenAI itself, so the route must be able to say otherwise.
    const models = modelsOf({
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
        models: [{ id: 'acme-think', reasoningEfforts: { off: null, high: 'high' } }],
      },
    }, 'acme-gateway')

    expect(models.get('acme-think')?.compat).toEqual({
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
    })
  })

  it('carries a switch both OpenAI protocols declare onto an openai-responses route', () => {
    const models = modelsOf({
      'acme-responses': {
        api: 'openai-responses',
        baseURL: 'https://acme.test',
        compat: { supportsDeveloperRole: false },
        models: [{ id: 'acme-r', reasoningEfforts: { off: null, high: 'high' } }],
      },
    }, 'acme-responses')

    expect(models.get('acme-r')?.compat).toEqual({ supportsDeveloperRole: false })
  })

  it('carries an anthropic-only switch onto an anthropic-messages route', () => {
    const models = modelsOf({
      'acme-claude': {
        api: 'anthropic-messages',
        baseURL: 'https://acme.test',
        compat: { supportsTemperature: false, supportsCacheControlOnTools: false },
        models: [{ id: 'acme-opus' }],
      },
    }, 'acme-claude')

    expect(models.get('acme-opus')?.compat).toEqual({
      supportsTemperature: false,
      supportsCacheControlOnTools: false,
    })
  })

  it('lands each route switch only on the models whose protocol declares it', () => {
    const catalog = getBuiltinModels('opencode') as readonly Model<Api>[]
    const completions = catalog.find(model => model.api === 'openai-completions')
    const responses = catalog.find(model => model.api === 'openai-responses')
    if (completions === undefined || responses === undefined) throw new Error('opencode ships no mixed catalog')

    const models = modelsOf({
      opencode: {
        // Both protocols take the first switch; only completions takes the second.
        compat: { supportsDeveloperRole: false, thinkingFormat: 'openai' },
        models: [{ id: completions.id }, { id: responses.id }],
      },
    }, 'opencode')

    const onCompletions = models.get(completions.id)?.compat as OpenAICompletionsCompat
    expect(onCompletions.supportsDeveloperRole).toBe(false)
    expect(onCompletions.thinkingFormat).toBe('openai')
    const onResponses = models.get(responses.id)?.compat as { supportsDeveloperRole?: boolean; thinkingFormat?: string }
    expect(onResponses.supportsDeveloperRole).toBe(false)
    expect(onResponses.thinkingFormat).toBeUndefined()
  })

  it('carries chat-template kwargs beside the thinking format that dispatches through them', () => {
    const models = modelsOf({
      'acme-qwen': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        models: [{
          id: 'qwen-local',
          reasoningEfforts: { off: null, medium: 'medium' },
          compat: {
            thinkingFormat: 'qwen-chat-template',
            chatTemplateKwargs: { enable_thinking: { $var: 'thinking.enabled' } },
          },
        }],
      },
    }, 'acme-qwen')

    expect(models.get('qwen-local')?.compat).toEqual({
      thinkingFormat: 'qwen-chat-template',
      chatTemplateKwargs: { enable_thinking: { $var: 'thinking.enabled' } },
    })
  })

  it('carries private-endpoint stream and reasoning controls', () => {
    const models = modelsOf({
      'acme-baseten': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        models: [{
          id: 'reasoning-local',
          compat: {
            supportsFinishReason: false,
            thinkingFormat: 'baseten',
            chatTemplateArgs: { enable_thinking: { $var: 'thinking.enabled' } },
            supportsThinkingTokenBudget: true,
          },
        }],
      },
    }, 'acme-baseten')

    expect(models.get('reasoning-local')?.compat).toEqual({
      supportsFinishReason: false,
      thinkingFormat: 'baseten',
      chatTemplateArgs: { enable_thinking: { $var: 'thinking.enabled' } },
      supportsThinkingTokenBudget: true,
    })
  })

  it('rejects a model switch on an unrecognized protocol as having no configurable compat', () => {
    expect(() => resolveProfiles({
      'acme-gateway': {
        api: 'acme-chat',
        baseURL: 'https://acme.test',
        models: [{ id: 'acme-a', compat: { supportsStore: false } }],
      },
    })).toThrow(/its api is "acme-chat", which does not take it.*"acme-chat" offers no configurable compat/s)
  })

  it('refuses a valueless compat key written through the composed settings path', async () => {
    // The write path an operator reaches: a section resolved by schemastery,
    // judged by this adapter's section validator before it is stored.
    // schemastery keeps the null, so nothing but that check stands between it
    // and `Model.compat`.
    const dir = await home()
    const ctx = await bootWithSettings(dir, {})
    await expect(ctx.settings.update('llm-pi-ai', {
      providers: {
        'acme-gateway': {
          api: 'openai-completions',
          baseURL: 'https://acme.test/v1',
          compat: { supportsDeveloperRole: null },
          models: [{ id: 'acme-a' }],
        },
      },
    })).rejects.toThrow(/compat "supportsDeveloperRole" with no value/)
  })

  it('carries a compat switch from a written settings section onto the wire', async () => {
    // End to end for the reported gap: the switch enters as configuration and
    // changes the request the provider receives, not merely the resolved model.
    vi.stubEnv(KEY_ENV, 'test-key')
    const server = await mockServer([{ events: textEvents }])
    const dir = await home()
    const ctx = await bootWithSettings(dir, {})
    await ctx.settings.update('llm-pi-ai', {
      providers: {
        'acme-gateway': {
          apiKeyEnv: KEY_ENV,
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          compat: { supportsDeveloperRole: false },
          models: [{ id: 'acme-think', reasoningEfforts: { off: null, high: 'high' } }],
        },
      },
    })

    await assemble(ctx, {
      provider: 'acme-gateway',
      model: 'acme-think',
      reasoningEffort: ReasoningEffortId('high'),
      system: 'you are a harness',
      messages: [],
    })

    const request = server.requests[0] as { messages: { role: string }[] }
    expect(request.messages.map(message => message.role)).toEqual(['system'])
  })

  it('refuses a valueless compat key rather than writing null over the catalog', () => {
    // schemastery passes a YAML bare key through as null. Carried forward it
    // would replace the installed entry's value, and pi-ai's `??` would then
    // reach for its baseURL detection — the "written but not applied" outcome.
    expect(() => resolveProfiles({
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        compat: { supportsDeveloperRole: null } as never,
        models: [{ id: 'acme-a' }],
      },
    })).toThrow(/compat "supportsDeveloperRole" with no value/)
  })

  it('refuses a compat key whose value is undefined, as a cordis.yml entry can write', () => {
    // `!!js undefined` reaches the same state as a YAML bare key, and
    // schemastery keeps the key either way, so both are refused together.
    expect(() => resolveProfiles({
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        compat: { supportsDeveloperRole: undefined } as never,
        models: [{ id: 'acme-a' }],
      },
    })).toThrow(/compat "supportsDeveloperRole" with no value/)
  })

  it('refuses a valueless compat key on a model entry too', () => {
    expect(() => resolveProfiles({
      deepseek: {
        modelOverrides: { 'deepseek-v4-flash': { compat: { requiresReasoningContentOnAssistantMessages: null } } as never },
      },
    })).toThrow(/model "deepseek-v4-flash" sets compat "requiresReasoningContentOnAssistantMessages" with no value/)
  })

  it('serves the Responses compat type on every protocol pi-ai gives it to', () => {
    // pi-ai types azure-openai-responses and openai-codex-responses with the
    // same OpenAIResponsesCompat, so a switch settable on one is settable on all.
    for (const route of ['azure-openai-responses', 'openai-codex']) {
      const models = modelsOf({ [route]: { compat: { supportsDeveloperRole: false } } }, route)
      const [first] = [...models.values()]
      expect((first?.compat as { supportsDeveloperRole?: boolean }).supportsDeveloperRole).toBe(false)
    }
  })

  it('serves the Bedrock compat type on its own protocol', () => {
    const models = modelsOf({ 'amazon-bedrock': { compat: { supportsStrictMode: false } } }, 'amazon-bedrock')
    const [first] = [...models.values()]
    expect((first?.compat as { supportsStrictMode?: boolean }).supportsStrictMode).toBe(false)
  })

  it('refuses a compat key no wire protocol declares instead of dropping it', () => {
    // Schemastery passes unknown keys through, so silently dropping one would
    // make an unreadable switch look applied; the resolver must refuse it.
    expect(() => resolveProfiles({
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        compat: { supportsDevelperRole: false } as never,
        models: [{ id: 'acme-a' }],
      },
    })).toThrow(/compat "supportsDevelperRole", which no wire protocol declares; the configurable switches are .*\bsupportsDeveloperRole\b/)
  })

  it('refuses compat keys pi-ai’s catalog owns, pointing at the catalog route', () => {
    for (const compat of [{ openRouterRouting: {} }, { supportsAdditionalTools: true }]) {
      expect(() => resolveProfiles({
        'acme-gateway': {
          api: 'openai-completions',
          baseURL: 'https://acme.test',
          models: [{ id: 'acme-a', compat: compat as never }],
        },
      })).toThrow(/which is not configurable here/)
    }
  })
})

describe('resolution snapshots', () => {
  it('finishes an in-flight request under the configuration it started with', async () => {
    const server = await mockServer([{ events: textEvents }])
    let current = resolveProfiles({ deepseek: { baseURL: `${server.url}/v1` } })
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const adapter = new PiAiAdapter({
      profiles: () => current,
      // Credential resolution is the real await inside a stream call, and the
      // window a configuration change has to land in.
      resolveApiKey: async () => { await held; return 'k' },
      auth: memoryAuth(),
    })

    const chunks: StreamChunk[] = []
    const inFlight = (async () => {
      for await (const chunk of adapter.stream({
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        messages: [],
      })) chunks.push(chunk)
    })()

    // The route set changes while the request waits, and something else reads
    // the adapter meanwhile, which is what would rebuild a shared collection.
    current = resolveProfiles({ openai: { baseURL: `${server.url}/v1` } })
    await expect(adapter.listModels('openai')).resolves.not.toHaveLength(0)
    release()
    await inFlight

    // The in-flight request keeps its own snapshot: it reaches the endpoint it
    // resolved against instead of failing on a provider that no longer exists.
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(server.paths).toEqual(['/v1/chat/completions'])
  })

  it('serves the next request from the new configuration', async () => {
    const first = await mockServer([{ events: textEvents }])
    const second = await mockServer([{ events: textEvents }])
    let current = resolveProfiles({ deepseek: { baseURL: `${first.url}/v1` } })
    const adapter = new PiAiAdapter({
      profiles: () => current,
      resolveApiKey: () => Promise.resolve('k'),
      auth: memoryAuth(),
    })
    const drain = async (): Promise<void> => {
      for await (const _chunk of adapter.stream({
        provider: 'deepseek', model: 'deepseek-v4-flash', messages: [],
      })) { /* drain */ }
    }

    await drain()
    current = resolveProfiles({ deepseek: { baseURL: `${second.url}/v1` } })
    await drain()

    expect(first.paths).toHaveLength(1)
    expect(second.paths).toHaveLength(1)
  })
})

describe('configurable-provider directory', () => {
  it('keeps the previous directory when a route collides with another adapter family', async () => {
    const dir = await home()
    const ctx = await bootWithSettings(dir, {})
    ctx.llm.registerConfigurableProviders([
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
    ])
    const before = ctx.llm.listConfigurableProviders().length
    expect(before).toBeGreaterThan(30)

    await ctx.settings.update('llm-pi-ai', {
      providers: {
        'deepseek-official': {
          api: 'openai-completions',
          baseURL: 'https://acme.test/v1',
          models: [{ id: 'm', contextWindow: 1, maxTokens: 1 }],
        },
      },
    })

    // The refused swap costs a diagnostic, not the directory: every entry the
    // page needs is still declared.
    expect(ctx.llm.listConfigurableProviders()).toHaveLength(before)
    expect(ctx.llm.listConfigurableProviders().find(entry => entry.provider === 'deepseek-official')?.settingsNs)
      .toBe('llm-deepseek')
  })

  it('replaces its entries atomically as declared routes come and go', async () => {
    const dir = await home()
    const ctx = await bootWithSettings(dir, {})
    const catalogOnly = ctx.llm.listConfigurableProviders().length

    await ctx.settings.update('llm-pi-ai', {
      providers: {
        'acme-gateway': {
          displayName: 'Acme Gateway',
          api: 'openai-completions',
          baseURL: 'https://acme.test/v1',
          models: [{ id: 'm', contextWindow: 1, maxTokens: 1 }],
        },
      },
    })
    expect(ctx.llm.listConfigurableProviders()).toHaveLength(catalogOnly + 1)
    expect(ctx.llm.listConfigurableProviders().find(entry => entry.provider === 'acme-gateway')?.displayName)
      .toBe('Acme Gateway')

    await ctx.settings.replace('llm-pi-ai', {})
    expect(ctx.llm.listConfigurableProviders()).toHaveLength(catalogOnly)
  })

  it('offers every installed catalog route, including one that only signs in', async () => {
    const ctx = await harness({})
    const offered = ctx.llm.listConfigurableProviders().map(entry => entry.provider)

    // `openai-codex` is the one installed provider that authenticates through
    // OAuth alone. It is offered like any other because the collection now
    // carries a durable credential store and a login flow writes into it, so
    // the route has a posture that works rather than only one that fails.
    expect(offered).toContain('openai-codex')
    expect(offered).toContain('anthropic')
    expect(offered).toContain('openai')
  })

  it('lists a route a stored profile names as a catalog route, not a declared one', async () => {
    // `declared` answers catalog membership, so a profile stored against a
    // route pi-ai ships is not mislabelled as one this deployment invented.
    const ctx = await harness({ providers: { 'openai-codex': { apiKeyEnv: KEY_ENV } } })

    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'openai-codex',
      displayName: 'openai-codex',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai-codex'],
      declared: false,
    })
  })
})
