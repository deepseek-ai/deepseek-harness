/** Registration, credential order and readiness through `ctx.deepseekAuth`, failure classes, and disposal. */
import { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import DeepSeekAuth from '@deepseek-ai/dsh-deepseek-auth'
import type { DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import SpeechToText, { SpeechTranscriptionError } from '@deepseek-ai/dsh-experimental-speech-to-text'
import type { SpeechPreparationState, SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Provider from '../src/index.ts'
import { failed, recognized, serviceDouble, silent, wave } from './service-double.ts'

const id = 'deepseek-asr' as SpeechProviderId
const KEY = credentialRef('DEEPSEEK_API_KEY')

/** Account service stand-in whose sign-in the test switches. */
function account(signedIn: boolean) {
  let current = signedIn, revoked = new AbortController()
  const rejected: string[] = []
  const service = {
    resolveRequestCredential: async (url: string) => {
      if (!current) return undefined
      return { headers: { 'x-dsh-auth-token': 'account-token' }, revoked: revoked.signal,
        reject: async () => { rejected.push(url); current = false } }
    },
  }
  return {
    service: service as Partial<DeepSeekAccount> as DeepSeekAccount, rejected,
    signIn: () => { current = true },
    signOut: () => { current = false; revoked.abort(); revoked = new AbortController() },
  }
}

/** Await a classified recognition failure so its code and diagnostic can be checked separately. */
async function rejection(pending: Promise<unknown>): Promise<SpeechTranscriptionError> {
  try { await pending } catch (error) {
    if (error instanceof SpeechTranscriptionError) return error
    throw error
  }
  throw new Error('expected a classified recognition failure')
}

interface Setup {
  /** Deployment both kinds are connected to. */
  readonly baseURL: string
  readonly account?: DeepSeekAccount
  /** Stored API keys by reference. */
  readonly stored?: Record<string, string>
  /** Settings of the connected account route; a throw marks the kind unresolved. */
  readonly accountConnection?: () => { baseURL: string }
  /** Credential store failure on every read. */
  readonly storeFailure?: Error
}

async function host(setup: Setup) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SpeechToText, { defaultProvider: 'auto', autoOrder: [id], language: 'auto' })
  const stored = new Map(Object.entries(setup.stored ?? {}))
  const read = <T>(value: T): Promise<T> => setup.storeFailure === undefined ? Promise.resolve(value) : Promise.reject(setup.storeFailure)
  ctx.provide('credentials', {
    resolve: (ref: string) => read(stored.has(ref) ? { value: stored.get(ref) } : undefined),
    describe: (ref: string) => read({ configured: (stored.get(ref)?.length ?? 0) > 0 }),
  } as never)
  if (setup.account !== undefined) ctx.provide('deepseekAccount', setup.account)
  await ctx.plugin(DeepSeekAuth)
  ctx.deepseekAuth.connect('account', 'deepseek-account', setup.accountConnection ?? (() => ({ baseURL: setup.baseURL })))
  ctx.deepseekAuth.connect('api-key', 'deepseek-official', () => ({ baseURL: setup.baseURL, reference: KEY }))
  const fiber = ctx.plugin(Provider, {})
  await fiber
  const speech = ctx.get('speechToText')!
  const state = (): SpeechPreparationState | undefined => speech.snapshot().providers.find(row => row.id === id)?.preparation
  const dictate = (audio = wave(64)) => speech.transcribe(speech.resolve({ audio }), new AbortController().signal)
  return { ctx, speech, state, dictate, stored, fiber }
}

it('sends the WAV to /v1/tools/asr with the account sign-in first and reports the service duration', async () => {
  const { baseURL, requests } = await serviceDouble(recognized('你好', 2000))
  const { speech, state, dictate } = await host({ baseURL, account: account(true).service, stored: { [KEY]: 'sk-key' } })
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'ready' }) })
  expect(speech.snapshot().providers[0]).toMatchObject({ name: 'DeepSeek', location: 'cloud', languages: ['auto'] })
  expect(() => speech.resolve({ audio: wave(64), language: 'zh' })).toThrow('No registered speech provider supports language: zh')
  const recording = wave(64)
  expect(await dictate(recording)).toMatchObject({ text: '你好', audioSeconds: 2 })
  const [sent] = requests
  expect(sent!.path).toBe('/v1/tools/asr')
  expect(sent!.headers['x-dsh-auth-token']).toBe('account-token')
  expect(sent!.headers.authorization).toBeUndefined()
  expect([sent!.filename, sent!.fileType]).toEqual(['recording.wav', 'audio/wav'])
  expect(sent!.file).toEqual(recording)
})

it('falls back to the API key without a signed-in account', async () => {
  const { baseURL, requests } = await serviceDouble(recognized('key'))
  const { state, dictate } = await host({ baseURL, account: account(false).service, stored: { [KEY]: 'sk-key' } })
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'ready' }) })
  expect(await dictate(wave(3200))).toMatchObject({ text: 'key', audioSeconds: 0.1 })
  expect(requests[0]!.headers.authorization).toBe('Bearer sk-key')
  expect(requests[0]!.headers['x-dsh-auth-token']).toBeUndefined()
})

it('waits for a credential without contacting the service and follows credential and account-service changes', async () => {
  const { baseURL, requests } = await serviceDouble(recognized('ok'))
  const user = account(false)
  const { ctx, state, dictate, stored } = await host({ baseURL })
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'unavailable', reason: 'sign-in-required' }) })
  expect((await rejection(dictate())).code).toBe('sign-in-required')
  stored.set(KEY, 'sk-key')
  ctx.emit('credentials/reference-updated', KEY)
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'ready' }) })
  stored.delete(KEY)
  ctx.provide('unrelated', {})
  ctx.provide('deepseekAccount', user.service)
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'unavailable', reason: 'sign-in-required' }) })
  user.signIn()
  ctx.emit('credentials/record-updated', credentialKey('deepseek-account-platform', 'default'))
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'ready' }) })
  expect(requests).toHaveLength(0)
})

it('stops at an account deployment whose settings do not resolve', async () => {
  const { baseURL, requests } = await serviceDouble(recognized('ok'))
  let failure: unknown = new Error('bad account settings')
  const { speech, state, dictate } = await host({ baseURL, account: account(true).service, stored: { [KEY]: 'sk-key' },
    accountConnection: () => { throw failure } })
  await vi.waitFor(() => {
    expect(state()).toEqual({ phase: 'failed', message: 'The DeepSeek account connection does not resolve: bad account settings' })
  })
  const unresolved = await rejection(dictate())
  expect([unresolved.code, unresolved.message]).toEqual(['service-error', 'The DeepSeek account connection does not resolve: bad account settings'])
  failure = 'settings offline'
  speech.prepare(id)
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'failed', message: 'The DeepSeek account connection does not resolve: settings offline' }) })
  expect(requests).toHaveLength(0)
})

it('reports an unusable API key and propagates credential store failures', async () => {
  const { baseURL, requests } = await serviceDouble(recognized('ok'))
  const blank = await host({ baseURL, stored: { [KEY]: '   ' } })
  await vi.waitFor(() => { expect(blank.state()).toEqual({ phase: 'ready' }) })
  const unusable = await rejection(blank.dictate())
  expect(unusable.code).toBe('api-key-invalid')
  expect(unusable.message).toContain('DEEPSEEK_API_KEY is blank')
  const locked = await host({ baseURL, storeFailure: new Error('keychain locked') })
  await vi.waitFor(() => { expect(locked.state()).toEqual({ phase: 'failed', message: 'keychain locked' }) })
  await expect(locked.dictate()).rejects.toThrow('keychain locked')
  expect(requests).toHaveLength(0)
})

it('invalidates a rejected account sign-in and reports a rejected API key', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => { errors.mockRestore() })
  const { baseURL, endpoint } = await serviceDouble(failed(401, 'Authentication Fails (invalid dsh token)'))
  const user = account(true)
  const signedIn = await host({ baseURL, account: user.service })
  await vi.waitFor(() => { expect(signedIn.state()).toEqual({ phase: 'ready' }) })
  const expired = await rejection(signedIn.dictate())
  expect([expired.code, expired.message]).toEqual(['sign-in-required', 'The DeepSeek account sign-in was rejected (HTTP 401)'])
  expect(user.rejected).toEqual([endpoint])
  expect(errors).toHaveBeenCalledWith('[speech-to-text-deepseek]', '/v1/tools/asr rejected the account credential: HTTP 401')
  const keyed = await host({ baseURL, stored: { [KEY]: 'sk-wrong' } })
  await vi.waitFor(() => { expect(keyed.state()).toEqual({ phase: 'ready' }) })
  const wrongKey = await rejection(keyed.dictate())
  expect([wrongKey.code, wrongKey.message]).toEqual(['api-key-invalid', 'The DeepSeek API key was rejected (HTTP 401)'])
  expect(errors).toHaveBeenCalledWith('[speech-to-text-deepseek]', '/v1/tools/asr rejected the api-key credential: HTTP 401')
})

it('ends a recognition when the account signs out and classifies service failures without retrying', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => { errors.mockRestore() })
  const hanging = await serviceDouble(silent)
  const user = account(true)
  const signedIn = await host({ baseURL: hanging.baseURL, account: user.service })
  await vi.waitFor(() => { expect(signedIn.state()).toEqual({ phase: 'ready' }) })
  const pending = rejection(signedIn.dictate())
  await vi.waitFor(() => { expect(hanging.requests).toHaveLength(1) })
  user.signOut()
  expect(await pending).toMatchObject({ code: 'sign-in-required', message: 'The DeepSeek account signed out during recognition' })
  const busy = await serviceDouble(failed(503, 'busy'))
  const keyed = await host({ baseURL: busy.baseURL, stored: { [KEY]: 'sk-key' } })
  await vi.waitFor(() => { expect(keyed.state()).toEqual({ phase: 'ready' }) })
  expect(await rejection(keyed.dictate())).toMatchObject({ code: 'rate-limited', message: 'Cloud recognition failed: HTTP 503: busy' })
  expect(busy.requests).toHaveLength(1)
  expect(errors).toHaveBeenCalledWith('[speech-to-text-deepseek]', '/v1/tools/asr failed (rate-limited): HTTP 503: busy')
})

it('rejects malformed and oversized recordings before reading a credential', async () => {
  const { baseURL, requests } = await serviceDouble(recognized('ok'))
  const { ctx, speech, state } = await host({ baseURL, account: account(true).service })
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'ready' }) })
  await expect(speech.transcribe(speech.resolve({ audio: new Uint8Array(8) }), new AbortController().signal))
    .rejects.toMatchObject({ code: 'invalid-audio' })
  const small = ctx.plugin(Provider, { providerId: 'deepseek-small', maxRequestBytes: 100 })
  await small
  await expect(speech.transcribe(speech.resolve({ audio: wave(64), providerId: 'deepseek-small' as SpeechProviderId }),
    new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-audio', message: 'Recording is 108 bytes; the service accepts 100' })
  expect(requests).toHaveLength(0)
})

it('withdraws the registration and stops publishing when the plugin unloads', async () => {
  const { baseURL } = await serviceDouble(recognized('ok'))
  const { speech, fiber, dictate } = await host({ baseURL, account: account(true).service })
  expect(speech.listProviders().map(row => row.id)).toEqual([id])
  await fiber.dispose()
  expect(speech.listProviders()).toEqual([])
  expect(() => dictate()).toThrow('unavailable')
})
