/** Registration, credential order and availability through `ctx.deepseekAuth`, failure classes, and disposal. */
import { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import DeepSeekAuth from '@deepseek-ai/dsh-deepseek-auth'
import type { DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import TextToSpeech, { SpeechSynthesisError } from '@deepseek-ai/dsh-text-to-speech'
import type { SynthesisAvailability, SynthesisProviderId } from '@deepseek-ai/dsh-text-to-speech/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Provider from '../src/index.ts'
import { audio, cut, failed, serviceDouble, silent, stalled } from './service-double.ts'

const id = 'deepseek-tts' as SynthesisProviderId
const KEY = credentialRef('DEEPSEEK_API_KEY')
const pcm = (...values: number[]): Uint8Array => new Uint8Array(values)

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

/** Await a classified synthesis failure so its code and diagnostic can be checked separately. */
async function rejection(pending: Promise<unknown>): Promise<SpeechSynthesisError> {
  try { await pending } catch (error) {
    if (error instanceof SpeechSynthesisError) return error
    throw error
  }
  throw new Error('expected a classified synthesis failure')
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
  readonly config?: Partial<Provider.Config>
}

async function host(setup: Setup) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(TextToSpeech, { defaultProvider: id })
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
  const fiber = ctx.plugin(Provider, setup.config ?? {})
  await fiber
  const tts = ctx.get('textToSpeech')!
  const state = (): SynthesisAvailability | undefined => tts.snapshot().providers.find(row => row.id === id)?.availability
  const audioOf = (text = '你好', signal = new AbortController().signal, voice?: string) =>
    tts.synthesize(tts.resolve(voice === undefined ? { text } : { text, voice }), signal)
  const speak = (text?: string, signal?: AbortSignal) => audioOf(text, signal)[Symbol.asyncIterator]()
  const spoken = async (text?: string, signal?: AbortSignal, voice?: string): Promise<Uint8Array> => {
    const chunks: Uint8Array[] = []
    for await (const chunk of audioOf(text, signal, voice)) chunks.push(chunk)
    return new Uint8Array(Buffer.concat(chunks))
  }
  return { ctx, tts, state, audioOf, speak, spoken, stored, fiber }
}

function quietErrors() {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => { errors.mockRestore() })
  return errors
}

it('sends the text and the named voice to /v1/tools/tts with the account sign-in first and streams the audio back', async () => {
  const { baseURL, requests } = await serviceDouble(audio(pcm(1, 2), pcm(3, 4)))
  const setup = { baseURL, account: account(true).service, stored: { [KEY]: 'sk-key' } }
  const { tts, state, spoken } = await host(setup)
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'ready' }) })
  expect(tts.snapshot().providers[0]).toMatchObject({
    name: 'DeepSeek', location: 'cloud', audio: { encoding: 'pcm-s16le', sampleRate: 24_000 }, maxCharacters: 5000,
    voices: ['stella', 'tide'], voice: 'stella',
  })
  expect(await spoken('朗读这一段', undefined, 'tide')).toEqual(pcm(1, 2, 3, 4))
  const [sent] = requests
  expect(sent!.path).toBe('/v1/tools/tts')
  expect(sent!.headers['x-dsh-auth-token']).toBe('account-token')
  expect(sent!.headers.authorization).toBeUndefined()
  expect(sent!.body).toEqual({ text: '朗读这一段', voice_id: 'tide', format: 'pcm', filter_markdown: false })
})

it('falls back to the API key without a signed-in account and speaks in its first voice when none is saved', async () => {
  const { baseURL, requests } = await serviceDouble(audio(pcm(9, 9)))
  const { state, spoken } = await host({ baseURL, account: account(false).service, stored: { [KEY]: 'sk-key' } })
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'ready' }) })
  expect(await spoken()).toEqual(pcm(9, 9))
  expect(requests[0]!.headers.authorization).toBe('Bearer sk-key')
  expect(requests[0]!.headers['x-dsh-auth-token']).toBeUndefined()
  expect(requests[0]!.body).toMatchObject({ voice_id: 'stella' })
})

it('waits for a credential without contacting the service and follows credential and account-service changes', async () => {
  const { baseURL, requests } = await serviceDouble(audio(pcm(1, 1)))
  const user = account(false)
  const { ctx, state, spoken, stored } = await host({ baseURL })
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'unavailable', reason: 'sign-in-required' }) })
  expect((await rejection(spoken())).code).toBe('sign-in-required')
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
  const { baseURL, requests } = await serviceDouble(audio(pcm(1, 1)))
  let failure: unknown = new Error('bad account settings')
  const { ctx, state, spoken } = await host({ baseURL, account: account(true).service, stored: { [KEY]: 'sk-key' },
    accountConnection: () => { throw failure } })
  await vi.waitFor(() => {
    expect(state()).toEqual({ phase: 'failed', message: 'The DeepSeek account connection does not resolve: bad account settings' })
  })
  const unresolved = await rejection(spoken())
  expect([unresolved.code, unresolved.message])
    .toEqual(['service-error', 'The DeepSeek account connection does not resolve: bad account settings'])
  failure = 'settings offline'
  ctx.emit('credentials/reference-updated', KEY)
  const offline = 'The DeepSeek account connection does not resolve: settings offline'
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'failed', message: offline }) })
  expect(requests).toHaveLength(0)
})

it('reports an unusable API key and a credential store failure', async () => {
  const { baseURL, requests } = await serviceDouble(audio(pcm(1, 1)))
  const blank = await host({ baseURL, stored: { [KEY]: '   ' } })
  await vi.waitFor(() => { expect(blank.state()).toEqual({ phase: 'ready' }) })
  const unusable = await rejection(blank.spoken())
  expect(unusable.code).toBe('api-key-invalid')
  expect(unusable.message).toContain('DEEPSEEK_API_KEY is blank')
  const locked = await host({ baseURL, storeFailure: new Error('keychain locked') })
  await vi.waitFor(() => { expect(locked.state()).toEqual({ phase: 'failed', message: 'keychain locked' }) })
  expect(await rejection(locked.spoken()))
    .toMatchObject({ code: 'service-unavailable', message: 'Cloud synthesis request failed: keychain locked' })
  expect(requests).toHaveLength(0)
})

it('invalidates a rejected account sign-in and reports a rejected API key', async () => {
  const errors = quietErrors()
  const { baseURL, endpoint } = await serviceDouble(failed(401, 'Authentication Fails (invalid dsh token)'))
  const user = account(true)
  const signedIn = await host({ baseURL, account: user.service })
  await vi.waitFor(() => { expect(signedIn.state()).toEqual({ phase: 'ready' }) })
  const expired = await rejection(signedIn.spoken())
  expect([expired.code, expired.message]).toEqual(['sign-in-required', 'The DeepSeek account sign-in was rejected (HTTP 401)'])
  expect(user.rejected).toEqual([endpoint])
  expect(errors).toHaveBeenCalledWith('[text-to-speech-deepseek]', '/v1/tools/tts rejected the account credential: HTTP 401')
  const keyed = await host({ baseURL, stored: { [KEY]: 'sk-wrong' } })
  await vi.waitFor(() => { expect(keyed.state()).toEqual({ phase: 'ready' }) })
  const wrongKey = await rejection(keyed.spoken())
  expect([wrongKey.code, wrongKey.message]).toEqual(['api-key-invalid', 'The DeepSeek API key was rejected (HTTP 401)'])
  expect(errors).toHaveBeenCalledWith('[text-to-speech-deepseek]', '/v1/tools/tts rejected the api-key credential: HTTP 401')
})

it('classifies a service failure, an empty reply, and an unreachable service without retrying', async () => {
  const errors = quietErrors()
  const busy = await serviceDouble(failed(503, 'busy'))
  const keyed = await host({ baseURL: busy.baseURL, stored: { [KEY]: 'sk-key' } })
  await vi.waitFor(() => { expect(keyed.state()).toEqual({ phase: 'ready' }) })
  expect(await rejection(keyed.spoken())).toMatchObject({ code: 'rate-limited', message: 'Cloud synthesis failed: HTTP 503: busy' })
  expect(busy.requests).toHaveLength(1)
  expect(errors).toHaveBeenCalledWith('[text-to-speech-deepseek]', '/v1/tools/tts failed (rate-limited): HTTP 503: busy')
  const empty = await serviceDouble(audio())
  const mute = await host({ baseURL: empty.baseURL, stored: { [KEY]: 'sk-key' } })
  expect(await rejection(mute.spoken())).toMatchObject({ code: 'service-error', message: 'Cloud synthesis returned no audio' })
  const refusing = await serviceDouble((_request, response) => { response.socket?.destroy() })
  const offline = await host({ baseURL: refusing.baseURL, stored: { [KEY]: 'sk-key' } })
  const unreachable = await rejection(offline.spoken())
  expect(unreachable.code).toBe('service-unavailable')
  expect(unreachable.message).toMatch(/^Cloud synthesis request failed: fetch failed \(.+\)$/)
})

it('keeps the audio already delivered when the reply breaks midway and reports the break', async () => {
  const errors = quietErrors()
  const { baseURL } = await serviceDouble(cut(pcm(5, 6)))
  const { speak } = await host({ baseURL, stored: { [KEY]: 'sk-key' } })
  const stream = speak()
  expect((await stream.next()).value).toEqual(pcm(5, 6))
  expect(await rejection(stream.next()))
    .toMatchObject({ code: 'service-error', message: 'Cloud synthesis audio ended early after 2 bytes' })
  expect(errors).toHaveBeenCalledWith(
    '[text-to-speech-deepseek]', expect.stringMatching(/^\/v1\/tools\/tts audio ended early after 2 bytes: /),
  )
})

it('gives up after the idle interval, before the first bytes and between chunks', async () => {
  const mute = await serviceDouble(silent)
  const waiting = await host({ baseURL: mute.baseURL, stored: { [KEY]: 'sk-key' }, config: { idleTimeoutMs: 40 } })
  expect(await rejection(waiting.spoken())).toMatchObject({ code: 'timeout', message: 'No audio arrived within 40 ms' })
  await vi.waitFor(() => { expect(mute.requests[0]!.closed).toBe(true) })
  const slow = await serviceDouble(stalled(pcm(7, 8)))
  const stuck = await host({ baseURL: slow.baseURL, stored: { [KEY]: 'sk-key' }, config: { idleTimeoutMs: 40 } })
  const stream = stuck.speak()
  expect((await stream.next()).value).toEqual(pcm(7, 8))
  expect(await rejection(stream.next())).toMatchObject({ code: 'timeout' })
})

it('ends the request when the caller cancels, when the consumer stops early, and when the account signs out', async () => {
  const hanging = await serviceDouble(stalled(pcm(1, 2)))
  const user = account(true)
  const { speak, state, audioOf } = await host({ baseURL: hanging.baseURL, account: user.service })
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'ready' }) })
  const caller = new AbortController()
  const cancelled = speak('a', caller.signal)
  await cancelled.next()
  const pending = cancelled.next()
  caller.abort(new Error('listener left'))
  await expect(pending).rejects.toThrow('listener left')
  await vi.waitFor(() => { expect(hanging.requests[0]!.closed).toBe(true) })
  for await (const chunk of audioOf('b')) {
    expect(chunk).toEqual(pcm(1, 2))
    break
  }
  await vi.waitFor(() => { expect(hanging.requests[1]!.closed).toBe(true) })
  const signedOut = speak('c')
  await signedOut.next()
  const interrupted = rejection(signedOut.next())
  user.signOut()
  expect(await interrupted).toMatchObject({ code: 'sign-in-required', message: 'The DeepSeek account signed out during synthesis' })
  user.signIn()
  const mute = await serviceDouble(silent)
  const before = await host({ baseURL: mute.baseURL, account: user.service })
  const unanswered = rejection(before.spoken())
  await vi.waitFor(() => { expect(mute.requests).toHaveLength(1) })
  user.signOut()
  expect(await unanswered).toMatchObject({ code: 'sign-in-required' })
})

it('withdraws the registration and stops publishing when the plugin unloads', async () => {
  const { baseURL } = await serviceDouble(audio(pcm(1, 1)))
  const { tts, fiber, ctx, state } = await host({ baseURL, account: account(true).service })
  await vi.waitFor(() => { expect(state()).toEqual({ phase: 'ready' }) })
  await fiber.dispose()
  expect(tts.snapshot().providers).toEqual([])
  ctx.emit('credentials/reference-updated', KEY)
  expect(() => tts.resolve({ text: 'x' })).toThrow('unavailable')
})
