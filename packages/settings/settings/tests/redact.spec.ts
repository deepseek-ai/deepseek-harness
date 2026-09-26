import { describe, expect, it } from 'vitest'
import z from '@deepseek-ai/schemastery'
import { redactSecrets } from '../src/index.ts'

const Profile = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref'),
  baseURL: z.string(),
})

const Adapter: z<object> = z.object({
  apiKey: z.string().role('secret'),
  providers: z.dict(Profile),
  fallbacks: z.array(Profile),
  nested: z.object({
    token: z.string().role('secret'),
  }),
})

describe('redactSecrets', () => {
  it('strips secrets from object, dict, and array containers and records each position', () => {
    const { value, secrets } = redactSecrets(Adapter as z<never>, {
      apiKey: 'top-secret',
      providers: {
        openai: { apiKey: 'sk-live', apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://x' },
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      },
      fallbacks: [{ apiKey: 'fb', baseURL: 'https://y' }],
      nested: {},
    })
    expect(value).toEqual({
      providers: {
        openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://x' },
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      },
      fallbacks: [{ baseURL: 'https://y' }],
      nested: {},
    })
    expect(secrets).toEqual([
      { path: ['apiKey'], set: true },
      { path: ['providers', 'openai', 'apiKey'], set: true },
      { path: ['providers', 'anthropic', 'apiKey'], set: false },
      { path: ['fallbacks', '0', 'apiKey'], set: true },
      { path: ['nested', 'token'], set: false },
    ])
  })

  it('enumerates unset object-property slots without inventing containers', () => {
    const { value, secrets } = redactSecrets(Adapter as z<never>, undefined)
    expect(value).toBeUndefined()
    expect(secrets).toEqual([
      { path: ['apiKey'], set: false },
      { path: ['nested', 'token'], set: false },
    ])
  })

  it('never mutates the input and preserves keys outside the schema', () => {
    const input = Object.freeze({
      apiKey: 'frozen',
      extra: Object.freeze({ keep: true }),
    })
    const { value } = redactSecrets(Adapter as z<never>, input)
    expect(input.apiKey).toBe('frozen')
    expect(value).toEqual({ extra: { keep: true }, nested: undefined } as never)
    expect((value as { extra: unknown }).extra).toEqual({ keep: true })
  })

  it('passes malformed container values through untouched', () => {
    const { value, secrets } = redactSecrets(Adapter as z<never>, {
      providers: 'not-a-dict',
      fallbacks: 'not-an-array',
    })
    expect(value).toEqual({ providers: 'not-a-dict', fallbacks: 'not-an-array' })
    expect(secrets).toEqual([
      { path: ['apiKey'], set: false },
      { path: ['nested', 'token'], set: false },
    ])
  })

  it('treats a secret-role container as one opaque secret leaf', () => {
    const Weird = z.object({ blob: z.object({ inner: z.string() }).role('secret') })
    const { value, secrets } = redactSecrets(Weird as z<never>, { blob: { inner: 'x' } })
    expect(value).toEqual({})
    expect(secrets).toEqual([{ path: ['blob'], set: true }])
  })

  it('drops a dict entry whose entire value is the secret', () => {
    const Tokens = z.object({ tokens: z.dict(z.string().role('secret')) })
    const { value, secrets } = redactSecrets(Tokens as z<never>, { tokens: { a: 'x', b: 'y' } })
    expect(value).toEqual({ tokens: {} })
    expect(secrets).toEqual([
      { path: ['tokens', 'a'], set: true },
      { path: ['tokens', 'b'], set: true },
    ])
  })

  it('tolerates structural nodes missing their relation maps', () => {
    expect(redactSecrets({ type: 'dict' } as never, { k: 'v' })).toEqual({ value: { k: 'v' }, secrets: [] })
    expect(redactSecrets({ type: 'object' } as never, { k: 'v' })).toEqual({ value: { k: 'v' }, secrets: [] })
    expect(redactSecrets({ type: 'array' } as never, ['v'])).toEqual({ value: ['v'], secrets: [] })
  })
  it('removes secrets declared by any union branch, intersection, or transform', () => {
    const schema = z.object({
      union: z.union([z.object({ token: z.string().role('secret') }), z.object({ token: z.string() })]),
      intersection: z.intersect([z.object({ token: z.string().role('secret') }), z.object({ name: z.string() })]),
      transformed: z.transform(z.object({ token: z.string().role('secret') }), value => value),
    })
    const { value, secrets } = redactSecrets(schema as z<never>, {
      union: { token: 'union-secret' }, intersection: { token: 'intersection-secret', name: 'visible' },
      transformed: { token: 'transformed-secret' },
    })
    expect(value).toEqual({ union: {}, intersection: { name: 'visible' }, transformed: {} })
    expect(secrets).toEqual(['union', 'intersection', 'transformed'].map(key => ({ path: [key, 'token'], set: true })))
  })

})

it('preserves values when an unspecified union declares no secret alternatives', () => {
  expect(redactSecrets(new z({ type: 'union' }) as z<never>, 'visible')).toEqual({ value: 'visible', secrets: [] })
})
