import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmConfigurableProvider, StreamChunk } from '@deepseek-ai/dsh-llm'

class NoopAdapter extends LlmAdapter {

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('not exercised')
  }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  return ctx
}

function entry(overrides: Partial<LlmConfigurableProvider> = {}): LlmConfigurableProvider {
  return {
    provider: 'openai',
    displayName: 'OpenAI',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'openai'],
    ...overrides,
  }
}

describe('llm/adapters-updated', () => {
  it('fires at both adapter registration commit points with the registry already readable', async () => {
    const ctx = await setup()
    const observed: string[][] = []
    ctx.on('llm/adapters-updated', () => {
      observed.push(ctx.llm.listProviders().map(provider => provider.id))
    })
    const dispose = ctx.llm.registerAdapter(['a', 'b'], new NoopAdapter())
    expect(observed).toEqual([['a', 'b']])
    dispose()
    expect(observed).toEqual([['a', 'b'], []])
  })

  it('contains a throwing listener without vetoing registration or starving later listeners', async () => {
    const ctx = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const later = vi.fn()
    ctx.on('llm/adapters-updated', () => {
      throw new Error('broken observer')
    })
    ctx.on('llm/adapters-updated', later)
    ctx.llm.registerAdapter(['a'], new NoopAdapter())
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['a'])
    expect(later).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('llm: an llm/adapters-updated listener failed')
  })

  it('contains an ASYNC listener rejection instead of leaving it unhandled', async () => {
    // An emit listener may be an async function; its rejection cannot reach
    // the synchronous catch, so an uncontained one escapes the process as an
    // unhandled rejection rather than a warned observer failure.
    const ctx = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      // Typed as returning unknown so the listener is not a Promise-returning
      // function type: the point is exactly that an async one may slip in.
      const rejecting = (): unknown => Promise.reject(new Error('async observer'))
      ctx.on('llm/adapters-updated', rejecting)
      ctx.llm.registerAdapter(['a'], new NoopAdapter())
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['a'])
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(unhandled).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith('llm: an llm/adapters-updated listener failed')
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('replaces a route set in one event, never publishing an empty registry between the two', async () => {
    // The retry-policy swap in llm-deepseek: disposing and re-registering
    // would let an observer see the provider disappear and come back.
    const ctx = await setup()
    const observed: string[][] = []
    const registration = ctx.llm.registerAdapter(['a'], new NoopAdapter())
    ctx.on('llm/adapters-updated', () => {
      observed.push(ctx.llm.listProviders().map(provider => provider.id))
    })
    registration.replace(['a'])
    expect(observed).toEqual([['a']])
  })

  it('rethrows the first INVARIANT-coded listener failure after notifying the rest', async () => {
    const ctx = await setup()
    const later = vi.fn()
    ctx.on('llm/adapters-updated', () => {
      throw Object.assign(new Error('registry incoherent'), { code: 'INVARIANT' })
    })
    ctx.on('llm/adapters-updated', later)
    expect(() => ctx.llm.registerAdapter(['a'], new NoopAdapter())).toThrow('registry incoherent')
    expect(later).toHaveBeenCalledTimes(1)
  })
})

describe('configurable-provider directory', () => {
  it('registers entries, lists detached copies in order, and fires the topology event', async () => {
    const ctx = await setup()
    const events = vi.fn()
    ctx.on('llm/adapters-updated', events)
    ctx.llm.registerConfigurableProviders([
      entry({ provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] }),
      entry(),
    ])
    expect(events).toHaveBeenCalledTimes(1)
    const listed = ctx.llm.listConfigurableProviders()
    expect(listed).toEqual([
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
      { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
    ])
    listed[0]!.displayName = 'mutated'
    ;(listed[1]!.settingsPath as string[]).push('mutated')
    expect(ctx.llm.listConfigurableProviders()[0]!.displayName).toBe('DeepSeek')
    expect(ctx.llm.listConfigurableProviders()[1]!.settingsPath).toEqual(['providers', 'openai'])
  })

  it('detaches stored entries from caller-owned objects', async () => {
    const ctx = await setup()
    const source = entry()
    ctx.llm.registerConfigurableProviders([source])
    source.displayName = 'mutated'
    expect(ctx.llm.listConfigurableProviders()[0]!.displayName).toBe('OpenAI')
  })

  it('withdraws every entry when the registration disposes', async () => {
    const ctx = await setup()
    const dispose = ctx.llm.registerConfigurableProviders([entry()])
    const events = vi.fn()
    ctx.on('llm/adapters-updated', events)
    dispose()
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
    expect(events).toHaveBeenCalledTimes(1)
  })

  it('withdraws entries when the contributing fiber disposes', async () => {
    const ctx = await setup()
    const fiber = await ctx.plugin({
      inject: ['llm'],
      apply: (child: Context) => {
        child.llm.registerConfigurableProviders([entry()])
      },
    })
    expect(ctx.llm.listConfigurableProviders()).toHaveLength(1)
    await fiber.dispose()
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })

  it('rejects an empty registration', async () => {
    const ctx = await setup()
    expect(() => ctx.llm.registerConfigurableProviders([])).toThrow(LlmError)
    expect(() => ctx.llm.registerConfigurableProviders([])).toThrow(/at least one provider/)
  })

  it.each([
    [entry({ provider: '' }), /non-empty provider/],
    [entry({ displayName: '' }), /non-empty provider/],
    [entry({ settingsNs: '' }), /non-empty provider/],
    [entry({ settingsPath: ['providers', ''] }), /empty settingsPath segment/],
  ])('rejects invalid entries all-or-nothing', async (invalid, message) => {
    const ctx = await setup()
    expect(() => ctx.llm.registerConfigurableProviders([entry({ provider: 'valid-first' }), invalid])).toThrow(message)
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })

  it('replaces its entries atomically, keeping the old set when a candidate collides', async () => {
    const ctx = await setup()
    const handle = ctx.llm.registerConfigurableProviders([entry(), entry({ provider: 'second' })])
    ctx.llm.registerConfigurableProviders([entry({ provider: 'owned-elsewhere' })])

    // A candidate another registration already declares refuses the whole swap.
    expect(() =>{  handle.replace([entry({ provider: 'owned-elsewhere' })]) }).toThrow(/already declared/)
    expect(ctx.llm.listConfigurableProviders().map(view => view.provider).sort())
      .toEqual(['owned-elsewhere', 'second', entry().provider].sort())

    // Its own entries are not "already declared" against itself, so a swap that
    // keeps one and drops another lands whole.
    handle.replace([entry({ displayName: 'Renamed' })])
    expect(ctx.llm.listConfigurableProviders().map(view => view.provider).sort())
      .toEqual(['owned-elsewhere', entry().provider].sort())
    expect(ctx.llm.listConfigurableProviders().find(view => view.provider === entry().provider)?.displayName)
      .toBe('Renamed')

    // An empty replace is legal, unlike an empty initial registration.
    handle.replace([])
    expect(ctx.llm.listConfigurableProviders().map(view => view.provider)).toEqual(['owned-elsewhere'])

    handle()
    expect(() =>{  handle.replace([entry()]) }).toThrow(/was disposed/)
  })

  it('rejects duplicates within one registration and across registrations', async () => {
    const ctx = await setup()
    expect(() => ctx.llm.registerConfigurableProviders([entry(), entry()])).toThrow(/already declared/)
    ctx.llm.registerConfigurableProviders([entry()])
    expect(() => ctx.llm.registerConfigurableProviders([entry({ displayName: 'Other' }), entry({ provider: 'unseen' })]))
      .toThrow(/already declared/)
    expect(ctx.llm.listConfigurableProviders()).toHaveLength(1)
  })
})

describe('model discovery registry', () => {
  it('offers one interrogation per settings namespace and disposes with its fiber', async () => {
    const ctx = await setup()
    const discover = vi.fn(() => Promise.resolve([{ id: 'from-endpoint' }]))

    const dispose = ctx.llm.registerModelDiscovery('llm-example', discover)
    await expect(ctx.llm.discoverModels('llm-example', { baseURL: 'https://gateway.example/v1' }))
      .resolves.toEqual([{ id: 'from-endpoint' }])
    expect(discover).toHaveBeenCalledWith({ baseURL: 'https://gateway.example/v1' })

    // Disposal is observed through the offer itself, which is the only thing
    // the registration ever produced.
    dispose()
    await expect(ctx.llm.discoverModels('llm-example', { baseURL: 'https://gateway.example/v1' }))
      .rejects.toThrow(/no model discovery is registered/)
  })

  it('rejects an unnamed namespace and a second registration of the same one', async () => {
    const ctx = await setup()
    const discover = (): Promise<never[]> => Promise.resolve([])

    expect(() => ctx.llm.registerModelDiscovery('', discover)).toThrow(/non-empty settings namespace/)
    ctx.llm.registerModelDiscovery('llm-example', discover)
    expect(() => ctx.llm.registerModelDiscovery('llm-example', discover)).toThrow(/already registered/)
    // The refused second registration left the first one serving.
    await expect(ctx.llm.discoverModels('llm-example', { baseURL: 'https://gateway.example/v1' }))
      .resolves.toEqual([])
  })

  it('preserves discovered input types without inventing missing metadata', async () => {
    const ctx = await setup()
    ctx.llm.registerModelDiscovery('llm-example', () => Promise.resolve([
      { id: 'keep', name: 'Keep', contextWindow: 1024, maxTokens: 256, inputModalities: ['text', 'image'] },
      { id: '' },
      { id: 'keep' },
      { id: 'bare' },
    ] as never))

    expect(await ctx.llm.discoverModels('llm-example', { baseURL: 'https://gateway.example/v1' })).toEqual([
      { id: 'keep', name: 'Keep', contextWindow: 1024, maxTokens: 256, inputModalities: ['text', 'image'] },
      { id: 'bare' },
    ])
  })

  it('carries cancellation into Remote discovery and maps provider failures', async () => {
    const ctx = await setup()
    const discover = vi.fn()
      .mockResolvedValueOnce([
        { id: 'keep', name: 'Keep', contextWindow: 1024, maxTokens: 256 },
        { id: '' },
        { id: 'keep' },
        { id: 'bare' },
      ])
      .mockRejectedValueOnce(new Error('endpoint offline'))
      .mockRejectedValueOnce('provider refused')
    ctx.llm.registerModelDiscovery('llm-example', discover)
    const signal = new AbortController().signal

    await expect(ctx.llm.remoteDiscoverModels(
      'llm-example',
      { baseURL: 'https://gateway.example/v1' },
      signal,
    )).resolves.toEqual([
      { id: 'keep', name: 'Keep', contextWindow: 1024, maxTokens: 256 },
      { id: 'bare' },
    ])
    expect(discover).toHaveBeenNthCalledWith(
      1,
      { baseURL: 'https://gateway.example/v1' },
      signal,
    )

    await expect(ctx.llm.remoteDiscoverModels(
      'llm-example',
      { baseURL: 'https://gateway.example/v1' },
      signal,
    )).rejects.toMatchObject({
      code: 'llm/model-discovery-rejected',
      message: 'endpoint offline',
      details: { settingsNs: 'llm-example', baseURL: 'https://gateway.example/v1' },
    })
    await expect(ctx.llm.remoteDiscoverModels(
      'llm-example',
      { provider: 'known-route' },
      signal,
    )).rejects.toMatchObject({
      code: 'llm/model-discovery-rejected',
      message: 'provider refused',
      details: { settingsNs: 'llm-example' },
    })
  })

  it('refuses a namespace nothing serves and a draft with no endpoint', async () => {
    const ctx = await setup()
    ctx.llm.registerModelDiscovery('llm-example', () => Promise.resolve([]))

    await expect(ctx.llm.discoverModels('llm-absent', { baseURL: 'https://gateway.example/v1' }))
      .rejects.toMatchObject({ code: 'NO_DISCOVERY' })
    await expect(ctx.llm.discoverModels('llm-example', { baseURL: '' }))
      .rejects.toMatchObject({ code: 'INVALID_DISCOVERY' })
    await expect(ctx.llm.discoverModels('llm-example', { provider: '', baseURL: '' }))
      .rejects.toMatchObject({ code: 'INVALID_DISCOVERY' })
    await expect(ctx.llm.discoverModels('llm-example', {}))
      .rejects.toMatchObject({ code: 'INVALID_DISCOVERY' })
    // Naming a route alone is enough: the adapter may know it without an endpoint.
    await expect(ctx.llm.discoverModels('llm-example', { provider: 'known-route' })).resolves.toEqual([])
  })
})

describe('imageRequestPricing resolution', () => {
  it('resolves the owning adapter declaration and degrades everywhere else to undefined', async () => {
    const ctx = await setup()
    const pricing = { priceImages: () => [] }
    class PricingAdapter extends NoopAdapter {
      override imageRequestPricing(provider: string, model: string): typeof pricing | undefined {
        return provider === 'a' && model === 'vision' ? pricing : undefined
      }
    }
    const dispose = ctx.llm.registerAdapter(['a'], new PricingAdapter())
    ctx.llm.registerAdapter(['plain'], new NoopAdapter())

    expect(ctx.llm.imageRequestPricing('a', 'vision')).toBe(pricing)
    expect(ctx.llm.imageRequestPricing('a', 'other')).toBeUndefined()
    // The base adapter declares none.
    expect(ctx.llm.imageRequestPricing('plain', 'vision')).toBeUndefined()
    // Unregistered providers degrade instead of throwing: callers price
    // durable history whose route may no longer be mounted.
    expect(ctx.llm.imageRequestPricing('missing', 'vision')).toBeUndefined()
    dispose()
    expect(ctx.llm.imageRequestPricing('a', 'vision')).toBeUndefined()
  })
})
