/** Where a credential may be sent: absolute destinations, and the deployment of a kind no model route connected. */
import { afterEach, describe, expect, it } from 'vitest'
import { disposeMounted, mount, request, summary } from './harness.ts'

afterEach(disposeMounted)

describe('absolute destinations', () => {
  const ROUTE = 'https://route.deepseek.test/anthropic'

  it('offers a kind for a URL under the origin of its deployment', async () => {
    const ctx = await mount()
    ctx.effect(() => ctx.deepseekAuth.connect('api-key', 'deepseek-official', () => ({ baseURL: ROUTE })))
    const url = 'https://route.deepseek.test/anthropic/v1/models'
    expect(summary(ctx.deepseekAuth.candidates(request({ billing: 'api-key', destination: { url } })))).toEqual([`api-key ${url}`])
  })

  it.each([
    'https://other.deepseek.test/anthropic/v1/models',
    'http://route.deepseek.test/anthropic/v1/models',
    'https://user:secret@route.deepseek.test/anthropic/v1/models',
  ])('offers no kind for %s, which is outside the deployment or embeds credentials', async (url) => {
    const ctx = await mount()
    ctx.effect(() => ctx.deepseekAuth.connect('api-key', 'deepseek-official', () => ({ baseURL: ROUTE })))
    expect(ctx.deepseekAuth.candidates(request({ billing: 'api-key', destination: { url } }))).toEqual([])
  })

  it('marks a kind unresolved for a destination that is no URL', async () => {
    const ctx = await mount()
    expect(ctx.deepseekAuth.candidates(request({ billing: 'api-key', destination: { url: 'not a url' } })))
      .toMatchObject([{ kind: 'api-key', unresolved: 'connection' }])
  })
})

describe('the account deployment without a connected account route', () => {
  it.each([[{}], [{ DEEPSEEK_BASE_URL: '' }]])('is the official API for environment %j', async (environment) => {
    const ctx = await mount({ environment })
    expect(summary(ctx.deepseekAuth.candidates(request({ billing: 'account' })))).toEqual(['account https://api.deepseek.com/v1/tools/search'])
  })

  it('is the origin DEEPSEEK_BASE_URL names', async () => {
    const ctx = await mount({ environment: { DEEPSEEK_BASE_URL: 'https://gateway.deepseek.test/anthropic' } })
    expect(summary(ctx.deepseekAuth.candidates(request({ billing: 'account' })))).toEqual(['account https://gateway.deepseek.test/v1/tools/search'])
  })

  it.each(['not a url', 'ftp://gateway.deepseek.test', 'https://user:secret@gateway.deepseek.test'])(
    'is unresolved for DEEPSEEK_BASE_URL=%s, naming the deployment', async (value) => {
      const ctx = await mount({ environment: { DEEPSEEK_BASE_URL: value } })
      const [entry] = ctx.deepseekAuth.candidates(request({ billing: 'account' }))
      expect(entry).toMatchObject({ kind: 'account', unresolved: 'deployment' })
      expect(entry).toHaveProperty('error', expect.any(Error))
    })

  it('does not move the API key, which stays at the official API', async () => {
    const ctx = await mount({ environment: { DEEPSEEK_BASE_URL: 'https://gateway.deepseek.test/anthropic' } })
    expect(summary(ctx.deepseekAuth.candidates(request({ billing: 'api-key' })))).toEqual(['api-key https://api.deepseek.com/v1/tools/search'])
  })
})
