/** The adapter publishes a route credential only for providers that declare one, and refuses requests without a credential. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmError } from '@deepseek-ai/dsh-llm'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { DeepSeekAdapter, registerDeepSeekProvider, resolveAdapterOptions } from '../src/index.ts'
import type { DeepSeekAdapterOptions, DeepSeekRequestAuth, ResolvedDeepSeekOptions } from '../src/index.ts'
import { chunks, options as request, prepareExtensions } from './helpers.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllGlobals()
})

const BASE_URL = 'https://route.deepseek.test/anthropic'
const ALLOWED = 'https://route.deepseek.test/v1/tools/search'
const OTHER = 'https://route.deepseek.test/v1/tools/fetch'
const connection = () => resolveAdapterOptions({ baseURL: BASE_URL })

type Hooks = Partial<Pick<DeepSeekAdapterOptions, 'resolveAuth' | 'missingCredential' | 'credential'>>

/** Mount the runtime and one fixture route whose credential hooks are `hooks`. */
async function route(hooks: Hooks): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin({
    name: 'fixture-route',
    inject: ['llm'],
    apply: (child: Context) => {
      registerDeepSeekProvider(child, 'fixture-route', { options: connection, resolveAuth: () => Promise.resolve(undefined), ...hooks })
    },
  })
  return ctx
}

/** A direct adapter without a credential, failing requests through `missingCredential` when given. */
function adapterWithout(missingCredential?: DeepSeekAdapterOptions['missingCredential']): DeepSeekAdapter {
  return new DeepSeekAdapter({
    options: connection,
    resolveAuth: () => Promise.resolve(undefined),
    resolveUserId: () => 'fixture-user' as AnonymousUserId,
    prepareExtensions,
    ...missingCredential === undefined ? {} : { missingCredential },
  })
}

it('publishes no credential for a provider that declares none', async () => {
  const ctx = await route({})
  expect(ctx.llm.providerCredential('fixture-route')).toBeUndefined()
})

it('publishes the declared credential from one configuration generation and resolves it per endpoint', async () => {
  const reject = vi.fn(() => Promise.resolve())
  const revoked = new AbortController().signal
  const resolveAuth = vi.fn(async (_connection: ResolvedDeepSeekOptions, endpoint: string): Promise<DeepSeekRequestAuth | undefined> =>
    endpoint === ALLOWED ? { headers: { 'x-fixture': 'k' }, value: 'k', reject, revoked, onRequestError: error => Promise.resolve(error) } : undefined)
  const configured = vi.fn(async (_connection: ResolvedDeepSeekOptions, endpoint: string) => endpoint === ALLOWED)
  const ctx = await route({ resolveAuth, credential: { kind: 'api-key', reference: () => 'FIXTURE_KEY', configured } })
  const credential = ctx.llm.providerCredential('fixture-route')
  expect(credential).toMatchObject({ kind: 'api-key', baseURL: BASE_URL, reference: 'FIXTURE_KEY' })
  await expect(credential!.configured(ALLOWED)).resolves.toBe(true)
  await expect(credential!.configured(OTHER)).resolves.toBe(false)
  // The grant carries the seam's fields only; the adapter's failure classification stays behind it.
  const grant = await credential!.resolve(ALLOWED)
  expect(Object.keys(grant!)).toEqual(['headers', 'value', 'reject', 'revoked'])
  expect(grant).toMatchObject({ headers: { 'x-fixture': 'k' }, value: 'k' })
  expect(grant!.revoked).toBe(revoked)
  await grant!.reject!()
  expect(reject).toHaveBeenCalledTimes(1)
  await expect(credential!.resolve(OTHER)).resolves.toBeUndefined()
  await expect(credential!.resolve(ALLOWED, AbortSignal.abort(new Error('caller left')))).rejects.toThrow('caller left')
  expect(resolveAuth).toHaveBeenCalledTimes(2)
  expect(configured.mock.calls.map(([{ baseURL }]) => baseURL)).toEqual([BASE_URL, BASE_URL])
})

it('omits the reference of a credential kind without one and the rejection and withdrawal of a grant without them', async () => {
  const ctx = await route({
    resolveAuth: () => Promise.resolve({ headers: { 'x-fixture': 'k' }, value: 'k' }),
    credential: { kind: 'account', configured: () => Promise.resolve(false) },
  })
  const credential = ctx.llm.providerCredential('fixture-route')
  expect(credential).toMatchObject({ kind: 'account', baseURL: BASE_URL })
  expect(credential).not.toHaveProperty('reference')
  await expect(credential!.resolve(ALLOWED)).resolves.toEqual({ headers: { 'x-fixture': 'k' }, value: 'k' })
})

it('fails a request without a credential before any network I/O, with the default diagnostic', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  await expect(chunks(adapterWithout().stream(request({ provider: 'fixture-route' })))).rejects.toMatchObject({
    code: 'MISSING_CREDENTIAL', message: 'llm-deepseek: no credential for provider route "fixture-route"',
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

it('fails a request without a credential with the provider\'s own diagnostic', async () => {
  vi.stubGlobal('fetch', vi.fn())
  const missing = adapterWithout((_connection, provider) => new LlmError(`sign in for ${provider}`, 'ACCOUNT_SIGN_IN_REQUIRED'))
  await expect(chunks(missing.stream(request({ provider: 'fixture-route' })))).rejects.toMatchObject({
    code: 'ACCOUNT_SIGN_IN_REQUIRED', message: 'sign in for fixture-route',
  })
})
