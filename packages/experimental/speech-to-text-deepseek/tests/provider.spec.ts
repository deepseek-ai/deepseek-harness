/** Registration, account-driven readiness and authentication, retries, and disposal of the cloud recognizer. */
import { Context } from '@deepseek-ai/cordis'
import type { DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import type { AccountView } from '@deepseek-ai/dsh-deepseek-account/types'
import SpeechToText, { SpeechTranscriptionError } from '@deepseek-ai/dsh-experimental-speech-to-text'
import type { SpeechPreparationState, SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Provider from '../src/index.ts'
import { json, recognized, refused, serviceDouble, wave, type Reply } from './service-double.ts'

const id = 'deepseek-asr' as SpeechProviderId

/** Account service double whose stored-account state the test switches. */
function account(initial: AccountView['status'], token: string | null = 'fixture-account-token') {
  let status = initial
  const wake = new Set<() => void>()
  const rejected: string[] = []
  const service = {
    async *watch(signal: AbortSignal): AsyncIterable<AccountView> {
      while (!signal.aborted) {
        yield { status, links: { usageUrl: '', topUpUrl: '' }, attempt: null }
        await new Promise<void>((resolve) => { wake.add(resolve); signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      }
    },
    resolveToken: vi.fn(async () => status === 'credential-stored' ? token ?? undefined : undefined),
    rejectToken: vi.fn(async (value: string) => { rejected.push(value); set('signed-out') }),
  }
  function set(next: AccountView['status']): void {
    status = next
    for (const resolve of wake) resolve()
    wake.clear()
  }
  return { service: service as Partial<DeepSeekAccount> as DeepSeekAccount, rejectToken: service.rejectToken, rejected, set }
}

/** Await a classified recognition failure so its code and diagnostic can be checked separately. */
async function rejection(pending: Promise<unknown>): Promise<SpeechTranscriptionError> {
  try { await pending } catch (error) {
    if (error instanceof SpeechTranscriptionError) return error
    throw error
  }
  throw new Error('expected a classified recognition failure')
}

async function host(setup: { account?: DeepSeekAccount } = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SpeechToText, { defaultProvider: 'auto', autoOrder: [id], language: 'zh' })
  const removeAccount = setup.account === undefined ? undefined : ctx.provide('deepseekAccount', setup.account)
  const speech = ctx.get('speechToText')!
  const state = (): SpeechPreparationState | undefined => speech.snapshot().providers.find(row => row.id === id)?.preparation
  return { ctx, speech, state, removeAccount }
}

async function mount(ctx: Context, endpoint: string, config: object = {}) {
  const fiber = ctx.plugin(Provider, { endpoint, allowLoopbackHttp: true, ...config })
  await fiber
  return fiber
}

async function dictate(speech: SpeechToText, pcmBytes = 100) {
  return await speech.transcribe(speech.resolve({ audio: wave(pcmBytes) }), new AbortController().signal)
}

it('sends aligned PCM with the account token once a DeepSeek account is stored', async () => {
  const { endpoint, requests } = await serviceDouble(recognized('你好'))
  const { ctx, speech, state } = await host({ account: account('credential-stored').service })
  await mount(ctx, endpoint)
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'ready' }) })
  expect(speech.snapshot().providers[0]).toMatchObject({ name: 'DeepSeek', location: 'cloud',
    languages: ['auto', 'zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt', 'yue', 'ko'] })
  expect(await dictate(speech)).toMatchObject({ text: '你好', audioSeconds: 100 / 32_000 })
  const [sent] = requests
  expect(sent!.headers['x-dsh-auth-token']).toBe('fixture-account-token')
  expect(sent!.headers.cookie).toBeUndefined()
  expect(sent!.headers['x-client-locale']).toBeUndefined()
  expect(sent!.fields.get('format')).toBe('pcm')
  expect(sent!.fields.get('audio_id')).toMatch(/^[0-9a-f-]{36}$/)
  expect(sent!.fields.get('preferred_language')).toBe('zh')
  expect(sent!.file.byteLength).toBe(128)
})

it('sends the preferred language and the client locale in the service spelling', async () => {
  const { endpoint, requests } = await serviceDouble(recognized('ok'))
  const { ctx, speech, state } = await host({ account: account('credential-stored').service })
  await mount(ctx, endpoint, { languages: ['auto', 'es', 'es'] })
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'ready' }) })
  expect(speech.snapshot().providers[0]!.languages).toEqual(['auto', 'es'])
  for (const [language, locale] of [['es', 'zh'], ['auto', 'pt-BR'], ['es', 'zh-Hant'], ['es', 'en'], ['es', 'pt'], ['es', 'ja']] as const) {
    await speech.transcribe(speech.resolve({ audio: wave(64), language, locale }), new AbortController().signal)
  }
  expect(requests.map(request => [request.fields.get('preferred_language') ?? null, request.headers['x-client-locale']])).toEqual([
    ['es', 'zh_CN'], [null, 'pt_BR'], ['es', 'zh_Hant'], ['es', 'en_US'], ['es', 'pt_BR'], ['es', 'ja'],
  ])
  expect(() => speech.resolve({ audio: wave(64), language: 'zh' })).toThrow('No registered speech provider supports language: zh')
})

it('follows sign-in without contacting the service and offers nothing to prepare', async () => {
  const { endpoint, requests } = await serviceDouble(recognized('ok'))
  const user = account('signed-out')
  const { ctx, speech, state } = await host({ account: user.service })
  await mount(ctx, endpoint)
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'unavailable', reason: 'sign-in-required' }) })
  await expect(dictate(speech)).rejects.toMatchObject({ code: 'sign-in-required' })
  user.set('credential-stored')
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'ready' }) })
  speech.prepare(id)
  await speech.cancelPreparation(id)
  expect(state()).toEqual({ phase: 'ready' })
  expect(requests).toHaveLength(0)
})

it('resubmits the same audio_id once after a service failure and classifies the final outcome', async () => {
  const unavailable: Reply = json(503, {})
  const { endpoint, requests } = await serviceDouble(unavailable, recognized('retried'))
  const { ctx, speech, state } = await host({ account: account('credential-stored').service })
  await mount(ctx, endpoint)
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'ready' }) })
  expect((await dictate(speech)).text).toBe('retried')
  expect(requests.map(request => request.fields.get('audio_id'))).toEqual([requests[0]!.fields.get('audio_id'), requests[0]!.fields.get('audio_id')])
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  const again = await serviceDouble(unavailable)
  const second = await host({ account: account('credential-stored').service })
  await mount(second.ctx, again.endpoint)
  await vi.waitFor(() => { expect(second.state()).toEqual({ phase: 'ready' }) })
  await expect(dictate(second.speech)).rejects.toMatchObject({ code: 'service-error', message: 'Cloud recognition failed: HTTP 503' })
  expect(again.requests).toHaveLength(2)
  expect(errors).toHaveBeenCalledWith('[speech-to-text-deepseek]', '/api/v0/asr/transcribe failed (service-error): HTTP 503')
  errors.mockRestore()
})

it('does not retry classified failures and rejects oversized requests before sending', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => { errors.mockRestore() })
  const { endpoint, requests } = await serviceDouble(refused(2))
  const { ctx, speech, state } = await host({ account: account('credential-stored').service })
  await mount(ctx, endpoint, { maxRequestBytes: 1000 })
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'ready' }) })
  await expect(dictate(speech)).rejects.toMatchObject({ code: 'rate-limited' })
  expect(requests).toHaveLength(1)
  const oversized = await rejection(dictate(speech, 2000))
  expect(oversized.code).toBe('invalid-audio')
  expect(oversized.message).toContain('the service accepts 1000')
  await expect(speech.transcribe(speech.resolve({ audio: new Uint8Array(8) }), new AbortController().signal))
    .rejects.toMatchObject({ code: 'invalid-audio' })
  expect(requests).toHaveLength(1)
})

it('authenticates with the account token and invalidates exactly that token when the service rejects it', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => { errors.mockRestore() })
  const { endpoint } = await serviceDouble(recognized('账号'), json(200, { code: 40003, msg: 'INVALID_TOKEN', data: null }))
  const user = account('credential-stored')
  const { ctx, speech, state } = await host({ account: user.service })
  await mount(ctx, endpoint)
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'ready' }) })
  expect((await dictate(speech)).text).toBe('账号')
  const expired = await rejection(dictate(speech))
  expect(expired.code).toBe('sign-in-required')
  expect(expired.message).toContain('code 40003')
  expect(user.rejected).toEqual(['fixture-account-token'])
  expect(errors).toHaveBeenCalledWith('[speech-to-text-deepseek]', '/api/v0/asr/transcribe rejected the account token: code 40003')
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'unavailable', reason: 'sign-in-required' }) })
  await expect(dictate(speech)).rejects.toMatchObject({ code: 'sign-in-required' })
})

it('keeps the service rejection when invalidating the account token fails', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => { errors.mockRestore() })
  const { endpoint } = await serviceDouble(json(401, {}))
  const user = account('credential-stored')
  user.rejectToken.mockRejectedValueOnce(new Error('keychain locked'))
  const { ctx, speech, state } = await host({ account: user.service })
  await mount(ctx, endpoint)
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'ready' }) })
  await expect(dictate(speech)).rejects.toMatchObject({ code: 'sign-in-required' })
})

it('fails readiness and refuses recordings when a stored account does not authorize the endpoint origin', async () => {
  const { endpoint, requests } = await serviceDouble(recognized('ok'))
  const { ctx, speech, state } = await host({ account: account('credential-stored', null).service })
  await mount(ctx, endpoint)
  await vi.waitFor(() => {
    expect(state()).toEqual({ phase: 'failed', message: `The DeepSeek account does not release a token for ${new URL(endpoint).origin}` })
  })
  await expect(speech.transcribe(speech.resolve({ audio: wave(64), providerId: id }), new AbortController().signal))
    .rejects.toMatchObject({ code: 'sign-in-required' })
  expect(requests).toHaveLength(0)
})

it('requires sign-in without an account service and recovers when one appears or fails', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => { errors.mockRestore() })
  const { endpoint } = await serviceDouble(recognized('ok'))
  const { ctx, state } = await host()
  await mount(ctx, endpoint)
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'unavailable', reason: 'sign-in-required' }) })
  const removeAccount = ctx.provide('deepseekAccount', account('credential-stored').service)
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'ready' }) })
  removeAccount()
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'unavailable', reason: 'sign-in-required' }) })
  let watched = 0
  const failing = (failure: unknown) => ({ watch: (signal: AbortSignal) => (watched++, { [Symbol.asyncIterator]: () => ({
    next: () => failure === undefined
      ? new Promise<IteratorResult<AccountView>>((_resolve, reject) => { signal.addEventListener('abort', () => { reject(new Error('aborted')) }) })
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- covers an account stream rejecting with a non-Error reason
      : Promise.reject(failure),
  }) }) }) as Partial<DeepSeekAccount> as DeepSeekAccount
  const removeHanging = ctx.provide('deepseekAccount', failing(undefined))
  await vi.waitFor(() => { expect(watched).toBe(1) })
  removeHanging()
  for (const [failure, message] of [[new Error('stream closed'), 'stream closed'], ['socket reset', 'socket reset']] as const) {
    const remove = ctx.provide('deepseekAccount', failing(failure))
    await vi.waitFor(() => { expect(errors).toHaveBeenCalledWith('[speech-to-text-deepseek]', 'account observation failed:', message) })
    expect(state()).toEqual({ phase: 'unavailable', reason: 'sign-in-required' })
    remove()
  }
  expect(errors).toHaveBeenCalledTimes(2)
})

it('withdraws the registration and stops publishing when the plugin unloads', async () => {
  const { endpoint } = await serviceDouble(recognized('ok'))
  const { ctx, speech } = await host({ account: account('credential-stored').service })
  const fiber = await mount(ctx, endpoint)
  expect(speech.listProviders().map(row => row.id)).toEqual([id])
  await fiber.dispose()
  expect(speech.listProviders()).toEqual([])
  expect(() => speech.resolve({ audio: wave(100) })).toThrow('unavailable')
})
