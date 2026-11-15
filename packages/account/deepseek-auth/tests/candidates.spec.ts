/** Which kinds a request can authenticate with, in which order, and where each one is sent. */
import { afterEach, describe, expect, it } from 'vitest'
import { DeepSeekAuthError } from '@deepseek-ai/dsh-deepseek-auth'
import { disposeMounted, mount, request, summary } from './harness.ts'

const OFFICIAL = 'https://api.deepseek.com/v1/tools/search'
const ROUTE = 'https://route.deepseek.test/anthropic'
const ACCOUNT = 'https://account.deepseek.test/anthropic'

afterEach(disposeMounted)

describe('billing order', () => {
  it.each([
    ['api-key', undefined, ['api-key']],
    ['api-key', 'deepseek-account', ['api-key']],
    ['account', 'deepseek-official', ['account']],
    ['auto', 'deepseek-official', ['api-key']],
    ['auto', 'moonshotai', ['api-key', 'account']],
    ['auto', undefined, ['api-key', 'account']],
    [undefined, undefined, ['api-key', 'account']],
  ] as const)('tries %j billing on route %j as %j', async (billing, route, kinds) => {
    const ctx = await mount()
    const entries = ctx.deepseekAuth.candidates(request({ ...billing === undefined ? {} : { billing }, route }))
    expect(entries.map(entry => entry.kind)).toEqual(kinds)
  })

  it('tries the sign-in first in a conversation on the connected account route, then the API key', async () => {
    const ctx = await mount()
    ctx.effect(() => ctx.deepseekAuth.connect('account', () => ({ baseURL: ACCOUNT })))
    expect(summary(ctx.deepseekAuth.candidates(request({ route: 'deepseek-account' })))).toEqual([
      'account https://account.deepseek.test/v1/tools/search', `api-key ${OFFICIAL}`,
    ])
  })

  it('tries only the API key in a conversation on the account route while that route is not connected', async () => {
    const ctx = await mount()
    expect(summary(ctx.deepseekAuth.candidates(request({ route: 'deepseek-account' })))).toEqual([`api-key ${OFFICIAL}`])
  })

  it('never offers a kind the destination does not accept', async () => {
    const ctx = await mount()
    expect(summary(ctx.deepseekAuth.candidates(request({ accepts: ['api-key'], destination: { path: '/v1/tools/asr' } }))))
      .toEqual(['api-key https://api.deepseek.com/v1/tools/asr'])
    expect(ctx.deepseekAuth.candidates(request({ accepts: ['api-key'], billing: 'account' }))).toEqual([])
  })

  it('names the kind that bills each DeepSeek model route', async () => {
    const { deepseekAuth } = await mount()
    expect([deepseekAuth.routeKind('deepseek-account'), deepseekAuth.routeKind('deepseek-official')]).toEqual(['account', 'api-key'])
    expect([deepseekAuth.routeKind('moonshotai'), deepseekAuth.routeKind(undefined)]).toEqual([undefined, undefined])
    // A provider id is user configuration and may equal a name every object inherits.
    expect(deepseekAuth.routeKind('constructor')).toBeUndefined()
  })
})

describe('connections', () => {
  it('sends each kind to the origin of the deployment its model route plugin connected', async () => {
    const ctx = await mount()
    ctx.effect(() => ctx.deepseekAuth.connect('api-key', () => ({ baseURL: ROUTE })))
    ctx.effect(() => ctx.deepseekAuth.connect('account', () => ({ baseURL: ACCOUNT })))
    expect(summary(ctx.deepseekAuth.candidates(request()))).toEqual([
      'api-key https://route.deepseek.test/v1/tools/search', 'account https://account.deepseek.test/v1/tools/search',
    ])
  })

  it('reads the connected settings for each request', async () => {
    const ctx = await mount()
    let baseURL = ROUTE
    ctx.effect(() => ctx.deepseekAuth.connect('api-key', () => ({ baseURL })))
    baseURL = 'https://next.deepseek.test/anthropic'
    expect(summary(ctx.deepseekAuth.candidates(request({ billing: 'api-key' })))).toEqual(['api-key https://next.deepseek.test/v1/tools/search'])
  })

  it('removes a connection with the plugin that made it', async () => {
    const ctx = await mount()
    const plugin = await ctx.plugin({ name: 'route', inject: ['deepseekAuth'], apply: (scope: typeof ctx) => {
      scope.effect(() => scope.deepseekAuth.connect('api-key', () => ({ baseURL: ROUTE })))
    } })
    expect(summary(ctx.deepseekAuth.candidates(request({ billing: 'api-key' })))).toEqual(['api-key https://route.deepseek.test/v1/tools/search'])
    await plugin.dispose()
    expect(summary(ctx.deepseekAuth.candidates(request({ billing: 'api-key' })))).toEqual([`api-key ${OFFICIAL}`])
  })

  it('refuses a second connection of one kind', async () => {
    const ctx = await mount()
    ctx.effect(() => ctx.deepseekAuth.connect('account', () => ({ baseURL: ACCOUNT })))
    expect(() => ctx.deepseekAuth.connect('account', () => ({ baseURL: ROUTE })))
      .toThrow(expect.objectContaining({ constructor: DeepSeekAuthError, code: 'DUPLICATE_CONNECTION' }))
  })

  it('prefers the connection a request carries over the connected one', async () => {
    const ctx = await mount()
    ctx.effect(() => ctx.deepseekAuth.connect('api-key', () => ({ baseURL: ROUTE })))
    const own = { 'api-key': { baseURL: 'https://own.deepseek.test/api/v1/tools' } }
    expect(summary(ctx.deepseekAuth.candidates(request({ billing: 'api-key', connections: own })))).toEqual(['api-key https://own.deepseek.test/v1/tools/search'])
  })

  it('marks a kind unresolved when its connected settings do not resolve or name no URL', async () => {
    const ctx = await mount()
    const failure = new Error('settings do not resolve')
    ctx.effect(() => ctx.deepseekAuth.connect('api-key', () => { throw failure }))
    ctx.effect(() => ctx.deepseekAuth.connect('account', () => ({ baseURL: 'not a url' })))
    const [key, account] = ctx.deepseekAuth.candidates(request())
    expect(key).toEqual({ kind: 'api-key', unresolved: 'connection', error: failure })
    expect(account).toMatchObject({ kind: 'account', unresolved: 'connection' })
  })
})
