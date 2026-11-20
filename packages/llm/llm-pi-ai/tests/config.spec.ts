import { describe, expect, it } from 'vitest'
import { assertServiceable, Config, resolveProfiles, type Options } from '../src/config.ts'

/** Validate one hand-declared route, with the caller's fields layered onto it. */
const routeWith = (profile: Record<string, unknown>): (() => unknown) =>
  () => ({ providers: Config({
    providers: {
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        models: [{ id: 'm' }],
        ...profile,
      },
    },
  }).providers.get() })

/** Validate that route with the caller's fields on its single model entry. */
const configWith = (model: Record<string, unknown>): (() => unknown) =>
  routeWith({ models: [{ id: 'm', ...model }] })

describe('reasoning schema boundary', () => {
  it('accepts an empty provider section and propagates unexpected catalog failures', () => {
    expect(() => { assertServiceable({}) }).not.toThrow()
    const failure = new TypeError('model metadata lookup failed')
    expect(() => resolveProfiles({ openrouter: { models: [{
      id: '111',
      get name(): string { throw failure },
    }], api: 'openai-completions' } }, 'deferred')).toThrow(failure)
  })

  it('rejects a level pi-ai does not know at the write that produced it', () => {
    expect(configWith({ reasoningEfforts: { ultra: 'x' } })).toThrow(/"off"/)
    expect(configWith({ reasoningEfforts: { high: 42 } })).toThrow()
  })

  it('keeps false distinguishable from an absent declaration', () => {
    type Materialized = { providers: Record<string, { models?: { reasoningEfforts?: unknown }[] }> }
    const withFalse = configWith({ reasoningEfforts: false })() as Materialized
    expect(withFalse.providers['acme-gateway']?.models?.[0]?.reasoningEfforts).toBe(false)
    const absent = configWith({})() as Materialized
    expect(absent.providers['acme-gateway']?.models?.[0]?.reasoningEfforts).toBeUndefined()
  })

  it('rejects a thinking format outside the offered set', () => {
    expect(configWith({ compat: { thinkingFormat: 'quantum' } })).toThrow(/expected/)
  })

  it('accepts Baseten template arguments and completion controls', () => {
    expect(configWith({
      compat: {
        supportsFinishReason: false,
        thinkingFormat: 'baseten',
        chatTemplateArgs: { enable_thinking: { $var: 'thinking.enabled' } },
        supportsThinkingTokenBudget: true,
      },
    })).not.toThrow()
  })
})

describe('modality schema boundary', () => {
  it('rejects a modality pi-ai does not know, at either level', () => {
    expect(configWith({ input: ['audio'] })).toThrow(/expected/)
    expect(routeWith({ defaultInput: ['text', 'audio'] })).toThrow(/expected/)
  })

  it('refuses a route whose models could accept nothing', () => {
    // The pair the settings seam runs: the schema accepts the empty list as
    // well-typed, and the namespace validator is what refuses it. Asserting
    // only the schema would report this route as writable.
    expect(routeWith({ defaultInput: [] })).not.toThrow()
    expect(() => { assertServiceable(routeWith({ defaultInput: [] })() as Options) })
      .toThrow(/defaultInput must name at least one modality/)
  })

  type Materialized = {
    providers: Record<string, { defaultInput?: unknown; models?: { input?: unknown }[] }>
  }

  it('materializes an absent entry list as empty and an absent route list as text', () => {
    // The empty-list inheritance rule exists because of exactly this: an entry
    // that declares nothing reaches resolution as `[]`, not as `undefined`.
    const absent = configWith({})() as Materialized
    expect(absent.providers['acme-gateway']?.models?.[0]?.input).toEqual([])
    expect(absent.providers['acme-gateway']?.defaultInput).toEqual(['text'])
  })
})

describe('request image policy bounds', () => {
  it('preserves omitted catalog defaults and explicit route overrides through the schema', () => {
    const omitted = routeWith({})() as Options
    const profile = resolveProfiles(omitted.providers).get('acme-gateway')!
    expect(profile.requestImageMaxDimension).toBeUndefined()
    expect(profile.maxImageBytes).toBeUndefined()
    expect(profile.requestImageBudgetCount).toBe(20)
    const explicit = routeWith({ requestImageMaxDimension: 3000, requestImageMaxBytes: 2000000 })() as Options
    expect(resolveProfiles(explicit.providers).get('acme-gateway')).toMatchObject({
      requestImageMaxDimension: 3000, maxImageBytes: 2000000,
    })
  })

  it.each(['requestImageMaxDimension', 'requestImageMaxBytes', 'requestImageBudgetCount'])(
    'rejects invalid %s at the configuration parser', (field) => {
      for (const value of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expect(routeWith({ [field]: value })).toThrow()
      }
    },
  )

  it.each([
    ['requestImageBudgetCount', 0, /requestImageBudgetCount must be a positive safe integer/],
    ['requestImageBudgetCount', 1.5, /requestImageBudgetCount must be a positive safe integer/],
    ['requestImagePixelBudget', 0, /requestImagePixelBudget must be a positive safe integer/],
    ['requestImagePixelBudget', Number.MAX_SAFE_INTEGER + 1, /requestImagePixelBudget must be a positive safe integer/],
    ['requestImageMaxDimension', 0, /requestImageMaxDimension must be a positive safe integer/],
    ['requestImageMaxDimension', 1.5, /requestImageMaxDimension must be a positive safe integer/],
    ['requestImageMaxDimension', Number.MAX_SAFE_INTEGER + 1, /requestImageMaxDimension must be a positive safe integer/],
    ['requestImageMaxBytes', 0, /requestImageMaxBytes must be a positive safe integer/],
    ['requestImageMaxBytes', 1.5, /requestImageMaxBytes must be a positive safe integer/],
  ] as const)('rejects %s=%s at service resolution', (field, value, message) => {
    const programmatic = {
      providers: {
        'acme-gateway': {
          api: 'openai-completions',
          baseURL: 'https://acme.test',
          models: [{ id: 'm' }],
          [field]: value,
        },
      },
    } as Options
    expect(() => {
      assertServiceable(programmatic)
    }).toThrow(message)
  })
})


it('rejects an aggregate budget without room for one base64 group per allocated image', () => {
  expect(() => resolveProfiles({ anthropic: { maxRequestImageBytes: 79, requestImageBudgetCount: 20 } }))
    .toThrow(/four base64 bytes/)
  expect(resolveProfiles({ anthropic: { maxRequestImageBytes: 80, requestImageBudgetCount: 20 } }).get('anthropic'))
    .toMatchObject({ maxRequestImageBytes: 80, requestImageBudgetCount: 20 })
  expect(() => resolveProfiles({ anthropic: { maxRequestImageBytes: Number.MAX_SAFE_INTEGER + 1 } }))
    .toThrow(/maxRequestImageBytes/)
})

it.each([{ maxImageBytes: 1024 }, { requestImageMaxBytes: 1024, maxImageBytes: 1024 }])(
  'rejects the internal byte-cap name in a provider profile: %j', (fields) => {
    expect(() => { assertServiceable(routeWith(fields)() as Options) })
      .toThrow(/provider "acme-gateway" must use requestImageMaxBytes.*maxImageBytes is internal/)
  },
)


it('refuses a separate pi soft target at the configuration boundary', () => {
  expect(() => { assertServiceable(routeWith({ imageTargetBytes: 1024 })() as Options) })
    .toThrow(/imageTargetBytes is not configurable/)
})
