/** Remote translation enforces accepted routing and sanitizes provider failures. */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, expect, it, vi } from 'vitest'
import { TranslationError } from '@deepseek-ai/dsh-experimental-translator'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { TranslationProvider, TranslationRequest } from '@deepseek-ai/dsh-experimental-translator/types'
import type { CotTranslationPreferences } from '../src/preferences.ts'
import CotTranslationController from '../src/index.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

function fixture(preferences: Partial<CotTranslationPreferences> = {}) {
  const ctx = new Context(); roots.push(ctx)
  const resolve = vi.fn((request: TranslationRequest) => ({ sourceLanguage: 'auto', ...request }))
  const translate = vi.fn(async () => 'translated')
  const availableProviders = vi.fn(async (): Promise<readonly TranslationProvider[]> => ['bing', 'google'])
  ctx.provide('translator', { maxTextChars: 32, resolve, translate, availableProviders } as never)
  const configure = vi.fn(() => () => {})
  ctx.provide('settings', { configure } as never)
  const resolveAgent = vi.fn<Context['sessionController']['resolveAgent']>(async () => ({ agent: {} as never }))
  ctx.provide('sessionController', { resolveAgent } as never)
  const config = CotTranslationController.Config(preferences)
  const controller = new CotTranslationController(ctx, config)
  return { ctx, controller, resolve, translate, configure, availableProviders, resolveAgent, config }
}

it('exposes configured limits without translating and uses explicit provider and target', async () => {
  const b = fixture({ provider: 'google' }), request = {
    text: 'original', targetLanguage: 'zh', provider: 'google' as const, sessionId: SessionId('source'),
  }
  expect(await b.controller.limits(new AbortController().signal)).toEqual({ maxTextChars: 32,
    preferences: { provider: 'google', targetLanguage: 'auto' }, availableProviders: ['bing', 'google'] })
  expect(b.translate).not.toHaveBeenCalled()
  const signal = new AbortController().signal
  expect(await b.controller.translate(request, signal)).toBe('translated')
  expect(b.resolve).toHaveBeenCalledWith(request)
  expect(b.translate).toHaveBeenCalledWith({ sourceLanguage: 'auto', ...request }, signal)
  expect(b.resolveAgent).not.toHaveBeenCalled()
  await vi.waitFor(() => { expect(b.configure).toHaveBeenCalledWith({ auto: false }, expect.anything()) })
})

const scoped = { text: 'original', targetLanguage: 'zh', sessionId: SessionId('source') }
const inactive = () => new TranslationError('TRANSLATION_SESSION_INACTIVE', 'Session is inactive')

it('joins ordinary Session activation only for an uncached inactive Session and retries once', async () => {
  const b = fixture(), signal = new AbortController().signal
  b.translate.mockRejectedValueOnce(inactive())
  await expect(b.controller.translate(scoped, signal)).resolves.toBe('translated')
  expect(b.resolveAgent).toHaveBeenCalledExactlyOnceWith(scoped.sessionId)
  expect(b.translate).toHaveBeenCalledTimes(2)
  expect(b.translate.mock.calls[0]).toEqual(b.translate.mock.calls[1])

  b.translate.mockRejectedValue(inactive())
  await expect(b.controller.translate(scoped, signal)).rejects.toMatchObject({ code: 'cotTranslation/failed' })
  expect(b.resolveAgent).toHaveBeenCalledTimes(2)
  expect(b.translate).toHaveBeenCalledTimes(4)
})

it.each([
  { error: new TranslationError('TRANSLATION_STORAGE_ERROR', 'unavailable'), request: scoped },
  { error: Object.assign(new Error('untyped failure'), { code: 'TRANSLATION_SESSION_INACTIVE' }), request: scoped },
  { error: inactive(), request: { text: 'original', targetLanguage: 'zh' } },
])('does not activate for an unrelated failure or a stateless request: $error', async ({ error, request }) => {
  const b = fixture()
  b.translate.mockRejectedValue(error)
  await expect(b.controller.translate(request, new AbortController().signal)).rejects.toMatchObject({ code: 'cotTranslation/failed' })
  expect(b.resolveAgent).not.toHaveBeenCalled()
  expect(b.translate).toHaveBeenCalledOnce()
})

it.each(['return', 'throw'] as const)('redacts an activation failure without retrying: %s', async (outcome) => {
  const b = fixture(), error = new RemoteError('gateway/internal', 'private startup output', {})
  b.translate.mockRejectedValueOnce(inactive())
  if (outcome === 'return') b.resolveAgent.mockResolvedValueOnce({ error })
  else b.resolveAgent.mockRejectedValueOnce(error)
  await expect(b.controller.translate(scoped, new AbortController().signal)).rejects.toMatchObject({
    code: 'cotTranslation/failed', message: 'Translation failed', details: {},
  })
  expect(b.translate).toHaveBeenCalledOnce()
})

it.each(['provider', 'targetLanguage'] as const)('rechecks accepted %s after activation before sending text', async (preference) => {
  const b = fixture(), activation = Promise.withResolvers<Awaited<ReturnType<typeof b.resolveAgent>>>()
  b.translate.mockRejectedValueOnce(inactive())
  b.resolveAgent.mockReturnValueOnce(activation.promise)
  const task = b.controller.translate(scoped, new AbortController().signal)
  await vi.waitFor(() => { expect(b.resolveAgent).toHaveBeenCalledOnce() })
  Object.assign(b.config, CotTranslationController.Config(preference === 'provider' ? { provider: 'google' } : { targetLanguage: 'ja' }))
  activation.resolve({ agent: {} as never })
  await expect(task).rejects.toMatchObject({ code: 'cotTranslation/failed' })
  expect(b.translate).toHaveBeenCalledOnce()
})

it.each(['success', 'failure'] as const)('cancels the caller promptly while shared activation later settles: %s', async (outcome) => {
  const b = fixture(), activation = Promise.withResolvers<Awaited<ReturnType<typeof b.resolveAgent>>>()
  const warning = vi.spyOn(b.ctx.logger, 'warn').mockImplementation(() => {})
  const lifetime = new AbortController(), reason = new Error('reader closed')
  b.translate.mockRejectedValueOnce(inactive())
  b.resolveAgent.mockReturnValueOnce(activation.promise)
  const task = b.controller.translate(scoped, lifetime.signal)
  await vi.waitFor(() => { expect(b.resolveAgent).toHaveBeenCalledOnce() })
  lifetime.abort(reason)
  await expect(task).rejects.toBe(reason)
  expect(b.translate).toHaveBeenCalledOnce()
  if (outcome === 'success') activation.resolve({ agent: {} as never })
  else activation.reject(new Error('private startup output'))
  await activation.promise.catch(() => {})
  if (outcome === 'failure') {
    await vi.waitFor(() => { expect(warning).toHaveBeenCalledExactlyOnceWith('Reasoning translation Session activation failed after cancellation') })
  } else expect(warning).not.toHaveBeenCalled()
  expect(b.translate).toHaveBeenCalledOnce()
})

it('preserves cancellation that arrives with the inactive result before starting activation', async () => {
  const b = fixture(), lifetime = new AbortController(), reason = new Error('reader closed')
  b.translate.mockImplementationOnce(async () => { lifetime.abort(reason); throw inactive() })
  await expect(b.controller.translate(scoped, lifetime.signal)).rejects.toBe(reason)
  expect(b.resolveAgent).not.toHaveBeenCalled()
})

it('does not dispatch after activation resolves at the same time as cancellation', async () => {
  const b = fixture(), lifetime = new AbortController(), reason = new Error('reader closed')
  b.translate.mockRejectedValueOnce(inactive())
  b.resolveAgent.mockImplementationOnce(async () => { lifetime.abort(reason); return { agent: {} as never } })
  await expect(b.controller.translate(scoped, lifetime.signal)).rejects.toBe(reason)
  expect(b.translate).toHaveBeenCalledOnce()
})

it.each([
  { accepted: 'bing' as const, requested: 'google' as const },
  { accepted: 'google' as const, requested: 'bing' as const },
  { accepted: 'bing' as const, requested: 'deepseek-account' as const },
  { accepted: 'bing' as const, requested: 'deepseek-official' as const },
  { accepted: 'deepseek-account' as const, requested: 'deepseek-official' as const },
  { accepted: 'deepseek-official' as const, requested: 'bing' as const },
])('rejects $requested when the accepted provider is $accepted before lookup or dispatch', async ({ accepted, requested }) => {
  const b = fixture({ provider: accepted })
  await expect(b.controller.translate({ text: 'private original', targetLanguage: 'ja', provider: requested }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'cotTranslation/failed', message: 'Translation failed', details: {} })
  expect(b.resolve).not.toHaveBeenCalled()
  expect(b.translate).not.toHaveBeenCalled()
})

it('redacts provider error text and preserves cancellation before and during translation', async () => {
  const b = fixture(), request = { text: 'private original', targetLanguage: 'ja' }
  b.translate.mockRejectedValueOnce(new Error('private provider response'))
  await expect(b.controller.translate(request, new AbortController().signal)).rejects.toMatchObject({
    code: 'cotTranslation/failed', message: 'Translation failed', details: {},
  })
  const abort = new Error('cancelled')
  await expect(b.controller.translate(request, AbortSignal.abort(abort))).rejects.toBe(abort)
  const pending = Promise.withResolvers<string>(), lifetime = new AbortController()
  b.translate.mockImplementationOnce(() => pending.promise)
  const task = b.controller.translate(request, lifetime.signal)
  lifetime.abort(abort); pending.reject(new Error('provider aborted'))
  await expect(task).rejects.toBe(abort)
})

it('rejects a different explicit target before saved-result lookup or provider dispatch', async () => {
  const b = fixture({ targetLanguage: 'ja' })
  await expect(b.controller.translate({ text: 'private original', targetLanguage: 'zh' }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'cotTranslation/failed', message: 'Translation failed', details: {} })
  expect(b.resolve).not.toHaveBeenCalled()
  expect(b.translate).not.toHaveBeenCalled()
})

it('validates preference codes while providing volatile Bing and automatic language defaults', () => {
  const defaults = CotTranslationController.Config({})
  expect(defaults.provider.get()).toBe('bing')
  expect(defaults.targetLanguage.get()).toBe('auto')
  expect(() => CotTranslationController.Config({ targetLanguage: 'invalid language' })).toThrow()
})

it('reports accepted Host preferences and uses them when a request omits its provider', async () => {
  const b = fixture({ provider: 'google', targetLanguage: 'ja' }), signal = new AbortController().signal
  expect(await b.controller.limits(signal)).toEqual({ maxTextChars: 32,
    preferences: { provider: 'google', targetLanguage: 'ja' }, availableProviders: ['bing', 'google'] })
  expect(await b.controller.translate({ text: 'original', targetLanguage: 'ja' }, signal)).toBe('translated')
  expect(b.resolve).toHaveBeenCalledWith({ text: 'original', provider: 'google', targetLanguage: 'ja' })
  await expect(b.controller.limits(AbortSignal.abort(new Error('cancelled query')))).rejects.toThrow('cancelled query')
})

it.each(['deepseek-account', 'deepseek-official'] as const)('keeps accepted %s cache lookup available when new requests are ineligible', async (provider) => {
  const b = fixture({ provider }), signal = new AbortController().signal
  expect(await b.controller.limits(signal)).toEqual({ maxTextChars: 32,
    preferences: { provider, targetLanguage: 'auto' }, availableProviders: ['bing', 'google'] })
  const request = { text: 'original', provider, targetLanguage: 'zh', sessionId: SessionId('existing-source') }
  expect(await b.controller.translate(request, signal)).toBe('translated')
  expect(b.resolve).toHaveBeenCalledWith(request)
  expect(b.translate).toHaveBeenCalledWith({ sourceLanguage: 'auto', ...request }, signal)
  expect(b.availableProviders).toHaveBeenCalledOnce()
})

it('preserves cancellation after a held native route catalog settles', async () => {
  const b = fixture(), pending = Promise.withResolvers<readonly TranslationProvider[]>(), caller = new AbortController()
  b.availableProviders.mockImplementationOnce(() => pending.promise)
  const task = b.controller.limits(caller.signal), reason = new Error('catalog cancelled')
  caller.abort(reason)
  pending.resolve(['bing', 'google'])
  await expect(task).rejects.toBe(reason)
})
