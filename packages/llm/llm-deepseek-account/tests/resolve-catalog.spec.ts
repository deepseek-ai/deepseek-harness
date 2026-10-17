/** Catalog resolution: version gating, this build's model knowledge, and model overrides. */
import { describe, expect, it } from 'vitest'
import { DEFAULT_REQUEST_IMAGE_MAX_BYTES, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { ModelOverride } from '../src/config.ts'
import { parseModelListing } from '../src/listing.ts'
import { resolveAccountCatalog } from '../src/resolve-catalog.ts'

const FLASH = {
  id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', context_window: 1_048_576, max_output_tokens: 393_216,
  input_modalities: ['text', 'image'], output_modalities: ['text'],
  api_capabilities: { anthropic_messages: { system_prompt_update: 'in-history' } },
}
const PRO = {
  id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', context_window: 1_048_576, max_output_tokens: 393_216,
  input_modalities: ['text'], output_modalities: ['text'],
  api_capabilities: { anthropic_messages: { system_prompt_update: 'leading-only' } },
}
const requires = (version: unknown) => ({ client_requirements: { 'deepseek-harness': { min_version: version } } })
const resolve = (rows: object[] | undefined, overrides: Record<string, ModelOverride> = {}) => resolveAccountCatalog({
  listing: rows === undefined ? undefined : parseModelListing({ data: rows }).entries,
  supported: resolveAdapterOptions({}).models,
  overrides,
  routeMaxTokens: 256_000,
  clientVersion: '0.2.0-rc.1',
})

describe('without a listing', () => {
  it('offers the bundled catalog', () => {
    const catalog = resolve(undefined)
    expect(catalog.offered.map(model => [model.id, model.name, model.contextWindow])).toEqual([
      ['deepseek-flash', 'DeepSeek-V4.1-Flash', 1_000_000], ['deepseek-v4-pro', 'DeepSeek-V4-Pro', 1_000_000],
    ])
    expect(catalog.resolution).toEqual(catalog.offered)
    expect(catalog.refusals.size).toBe(0)
  })

  it('applies overrides and does not judge override ids it cannot see', () => {
    const catalog = resolve(undefined, { 'deepseek-flash': { contextWindow: 524_288 }, 'remote-only': { contextWindow: 1 } })
    expect(catalog.offered[0]?.contextWindow).toBe(524_288)
    expect(catalog.overrideErrors).toEqual([])
  })
})

describe('with a listing', () => {
  it('layers listed capabilities over this build\'s knowledge in listing order', () => {
    const catalog = resolve([PRO, FLASH])
    expect(catalog.offered.map(model => model.id)).toEqual(['deepseek-v4-pro', 'deepseek-flash'])
    expect(catalog.offered[1]).toEqual({
      id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1_048_576, maxTokens: 256_000,
      inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history', toolUpdate: 'addition-only',
      imageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
    })
    expect(catalog.offered[0]).not.toHaveProperty('systemPromptUpdate')
    expect(catalog.offered[0]?.description).toContain('agentic coding')
  })

  it('keeps this build\'s values for fields a listing omits', () => {
    const [pro] = resolve([{ id: 'deepseek-v4-pro', api_capabilities: { anthropic_messages: {} } }]).offered
    expect(pro).toMatchObject({ name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000, inputModalities: ['text'] })
    expect(pro).not.toHaveProperty('maxTokens')
  })

  it('serves a minimally declared vouched model with request defaults only', () => {
    expect(resolve([{ id: 'deepseek-v5', api_capabilities: { anthropic_messages: {} }, ...requires('0.1.0') }]).offered)
      .toEqual([{ id: 'deepseek-v5', inputModalities: ['text'] }])
  })

  it('bounds the request default by a smaller output capability', () => {
    expect(resolve([{ ...PRO, max_output_tokens: 100_000 }]).offered[0]?.maxTokens).toBe(100_000)
  })

  it('removes an inherited in-history declaration the listing does not make', () => {
    const [flash] = resolve([{ ...FLASH, api_capabilities: { anthropic_messages: { system_prompt_update: 'leading-only' } } }]).offered
    expect(flash).not.toHaveProperty('systemPromptUpdate')
  })

  it('drops inherited image limits from a model the listing makes text-only', () => {
    const [flash] = resolve([{ ...FLASH, input_modalities: ['text'] }]).offered
    expect(flash).toMatchObject({ inputModalities: ['text'] })
    expect(flash).not.toHaveProperty('imageMaxBytes')
  })

  it.each([
    ['known, undeclared', { ...FLASH }, 'offered'],
    ['known, satisfied prerelease floor', { ...FLASH, ...requires('0.2.0-alpha.1') }, 'offered'],
    ['known, unmet floor', { ...FLASH, ...requires('0.2.0') }, { kind: 'upgrade-required', requiredVersion: '0.2.0' }],
    ['unknown, undeclared', { ...FLASH, id: 'deepseek-v5' }, { kind: 'unsupported' }],
    ['unknown, satisfied floor', { ...FLASH, id: 'deepseek-v5', ...requires('0.1.0') }, 'offered'],
    ['unknown, unmet floor', { ...FLASH, id: 'deepseek-v5', ...requires('0.3.0-alpha.1') }, { kind: 'upgrade-required', requiredVersion: '0.3.0-alpha.1' }],
    ['unreadable floor', { ...FLASH, ...requires('soon') }, { kind: 'unsupported' }],
    ['malformed requirement', { ...FLASH, client_requirements: 'x' }, { kind: 'unsupported' }],
  ])('gates a %s model', (_case, row, expected) => {
    const catalog = resolve([row])
    if (expected === 'offered') {
      expect(catalog.offered.map(model => model.id)).toEqual([row.id])
      expect(catalog.refusals.size).toBe(0)
    } else {
      expect(catalog.offered).toEqual([])
      expect(catalog.refusals.get(row.id)).toEqual(expected)
    }
  })

  it('serves a vouched unknown model with listed metadata only', () => {
    const [model] = resolve([{ ...FLASH, id: 'deepseek-v5', ...requires('0.1.0') }]).offered
    expect(model).not.toHaveProperty('toolUpdate')
    expect(model).toMatchObject({ id: 'deepseek-v5', contextWindow: 1_048_576, imageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES })
  })

  it('reports unreadable requirements and unusable declarations, but not unknown models', () => {
    const catalog = resolve([{ ...FLASH, ...requires('soon') }, { id: 'deepseek-v4-pro' }, { ...FLASH, id: 'deepseek-v5' }])
    expect(catalog.problems).toEqual([
      'model "deepseek-flash" declares an unreadable client requirement',
      'model "deepseek-v4-pro" declares no api_capabilities.anthropic_messages',
    ])
    expect(catalog.refusals.get('deepseek-v4-pro')).toEqual({ kind: 'unsupported' })
  })

  it('keeps bundled knowledge, with overrides, for request resolution of models the listing does not offer', () => {
    const catalog = resolve([PRO], { 'deepseek-flash': { contextWindow: 7 } })
    expect(catalog.offered.map(model => model.id)).toEqual(['deepseek-v4-pro'])
    expect(catalog.resolution.map(model => [model.id, model.contextWindow])).toEqual([['deepseek-v4-pro', 1_048_576], ['deepseek-flash', 7]])
    expect(catalog.overrideErrors).toEqual([])
  })

  it('applies an override to a vouched model and drops image limits an override narrows away', () => {
    const catalog = resolve([FLASH, { ...PRO, id: 'deepseek-v5', ...requires('0.1.0') }], {
      'deepseek-flash': { inputModalities: ['text'] }, 'deepseek-v5': { contextWindow: 9 },
    })
    expect(catalog.offered[0]).not.toHaveProperty('imageMaxBytes')
    expect(catalog.offered[1]?.contextWindow).toBe(9)
    expect(catalog.overrideErrors).toEqual([])
  })

  it.each([{ imagePixelBudget: 'low' as const }, { imageMaxBytes: 1 }])('reports an override %j that does not apply and a stale override id', (limits) => {
    const catalog = resolve([PRO], { 'deepseek-v4-pro': limits, 'retired': { contextWindow: 1 } })
    expect(catalog.offered[0]).not.toHaveProperty('imageMaxBytes')
    expect(catalog.overrideErrors).toEqual([
      expect.stringMatching(/^modelOverrides\.deepseek-v4-pro does not apply \(.*cannot declare image request limits/),
      'modelOverrides names "retired", which neither the account listing nor the built-in catalog describes',
    ])
  })
})
