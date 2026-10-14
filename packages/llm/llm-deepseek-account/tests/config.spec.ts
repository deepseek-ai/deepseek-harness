/** Account configuration resolves the listing endpoint, cache timing, and model overrides in one step. */
import { expect, it } from 'vitest'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { Config, plainAccountOptions, resolveAccountOptions } from '../src/config.ts'

it('derives the listing endpoint from the Messages origin and applies the cache defaults', () => {
  expect(resolveAccountOptions({}).catalog).toEqual({ url: 'https://api.deepseek.com/models', timeoutMs: 5_000, maxAgeMs: 600_000 })
  expect(resolveAccountOptions({ baseURL: 'http://127.0.0.1:9/anthropic' }).catalog.url).toBe('http://127.0.0.1:9/models')
})

it.each([
  [{ modelsTimeoutMs: 0 }, /modelsTimeoutMs must be a positive finite number/],
  [{ modelsTimeoutMs: MAX_TIMER_DELAY_MS + 1 }, /modelsTimeoutMs must be a positive finite number/],
  [{ modelsMaxAgeMs: -1 }, /modelsMaxAgeMs must be a non-negative safe integer/],
  [{ modelsMaxAgeMs: 1.5 }, /modelsMaxAgeMs must be a non-negative safe integer/],
  [{ models: [] }, /models is no longer configurable/],
  [{ modelOverrides: { '': {} } }, /modelOverrides keys must be non-empty model ids/],
  [{ modelOverrides: { 'deepseek-flash': { id: 'other' } } }, /modelOverrides\.deepseek-flash sets "id"/],
  [{ modelOverrides: { 'deepseek-flash': { contextWindow: 0 } } }, /modelOverrides\.deepseek-flash is invalid: .*contextWindow must be a positive integer/],
  [{ modelOverrides: { 'deepseek-flash': { inputModalities: ['text'], imageMaxBytes: 1 } } }, /modelOverrides\.deepseek-flash is invalid: .*cannot declare image request limits/],
])('rejects %j', (options, message) => {
  expect(() => { Reflect.apply(resolveAccountOptions, undefined, [options]) }).toThrow(message)
})

it('keeps the fields an override declares and drops inherited empty lists', () => {
  expect(resolveAccountOptions({ modelOverrides: {
    'deepseek-flash': { contextWindow: 524_288, imagePixelBudget: 'low', inputModalities: [] },
  } }).modelOverrides).toEqual({ 'deepseek-flash': { contextWindow: 524_288, imagePixelBudget: 'low' } })
})

it('reads the current value behind every Config reference', () => {
  const options = plainAccountOptions(Config({ modelsTimeoutMs: 7, modelOverrides: { 'deepseek-flash': { contextWindow: 9 } } }))
  expect(options).toMatchObject({ modelsTimeoutMs: 7, modelsMaxAgeMs: 600_000, modelOverrides: { 'deepseek-flash': { contextWindow: 9 } } })
  expect(options).not.toHaveProperty('models')
  expect(options).not.toHaveProperty('apiKeyEnv')
})

it('passes a retired models setting through to the resolver, which rejects it', () => {
  const options = plainAccountOptions(Config({ models: [] }))
  expect(options).toHaveProperty('models', [])
  expect(() => resolveAccountOptions(options)).toThrow(/models is no longer configurable/)
})
