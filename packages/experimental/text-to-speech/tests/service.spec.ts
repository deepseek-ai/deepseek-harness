/** Registration lifetime, availability observation, explicit routing, the voice preference, and stream ownership of the registry. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import TextToSpeech, { SpeechSynthesisError } from '../src/index.ts'
import type { SynthesisAvailability, SynthesisProvider, SynthesisProviderId, SynthesisSnapshot } from '../src/types.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

const id = 'tone' as SynthesisProviderId
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
const never = new AbortController().signal

function provider(overrides: Partial<SynthesisProvider> = {}): SynthesisProvider {
  return {
    info: {
      id, name: 'Tone', location: 'host-local', audio: { encoding: 'pcm-s16le', sampleRate: 8000 }, maxCharacters: 10,
      voices: ['low', 'high'],
    },
    async* synthesize(input) { yield bytes(input.text) },
    ...overrides,
  }
}

async function registry(defaultProvider: string = id) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const fiber = ctx.plugin(TextToSpeech, { defaultProvider })
  await fiber
  return { ctx, fiber, tts: ctx.get('textToSpeech')! }
}

/** Mount the service behind Loader with a settings stub that writes patches back into its live entry config. */
async function mounted(config: object) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const live = await liveConfig(ctx, TextToSpeech, config)
  const writes: object[] = []
  ctx.provide('settings', { update: async (_entry: string, patch: Record<string, unknown>) => { writes.push(patch); await live.update(patch) } } as never)
  return { tts: ctx.get('textToSpeech')!, writes }
}

async function collect(audio: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of audio) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

it('registers a provider once, reports it ready by default, and withdraws it idempotently', async () => {
  const { tts } = await registry()
  expect(tts.snapshot()).toEqual({ providers: [], selected: id })
  const dispose = tts.register(provider())
  expect(tts.snapshot().providers).toEqual([{ ...provider().info, availability: { phase: 'ready' }, voice: 'low' }])
  expect(() => tts.register(provider())).toThrow('Speech synthesis provider already registered: tone')
  const voiceless = provider({ info: { ...provider().info, id: 'mute' as SynthesisProviderId, voices: [] } })
  expect(() => tts.register(voiceless)).toThrow('Speech synthesis provider lists no voice: mute')
  await dispose()
  await dispose()
  expect(tts.snapshot().providers).toEqual([])
})

it('publishes provider-owned availability to followers and delivers only the latest snapshot to a slow one', async () => {
  const { tts } = await registry()
  let state: SynthesisAvailability = { phase: 'unavailable', reason: 'sign-in-required' }
  const listeners = new Set<() => void>()
  const change = (next: SynthesisAvailability): void => { state = next; for (const listener of listeners) listener() }
  const stop = new AbortController()
  const seen: SynthesisSnapshot[] = []
  const following = (async () => { for await (const snapshot of tts.follow(stop.signal)) seen.push(snapshot) })()
  await expect.poll(() => seen.length).toBe(1)
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  const dispose = tts.register(provider({ availability: { snapshot: () => state, subscribe } }))
  await expect.poll(() => seen.at(-1)?.providers[0]?.availability).toEqual({ phase: 'unavailable', reason: 'sign-in-required' })
  const before = seen.length
  change({ phase: 'failed', message: 'offline' })
  change({ phase: 'ready' })
  await expect.poll(() => seen.at(-1)?.providers[0]?.availability).toEqual({ phase: 'ready' })
  expect(seen.length).toBe(before + 1)
  await dispose()
  expect(listeners.size).toBe(0)
  await expect.poll(() => seen.at(-1)?.providers).toEqual([])
  stop.abort()
  await following
  // An aborted observer never starts.
  await expect(tts.follow(stop.signal)[Symbol.asyncIterator]().next()).rejects.toThrow()
})

it('resolves the configured provider and refuses a missing provider or a text over its limit', async () => {
  const { tts } = await registry()
  const missing = (() => { try { tts.resolve({ text: 'hi' }); return undefined } catch (error) { return error } })()
  expect(missing).toBeInstanceOf(SpeechSynthesisError)
  expect(missing).toMatchObject({ name: 'SpeechSynthesisError', code: 'service-unavailable', message: 'Speech synthesis provider is unavailable: tone' })
  const registered = provider()
  tts.register(registered)
  expect(tts.resolve({ text: 'hi' })).toEqual({ provider: registered, text: 'hi', voice: 'low' })
  expect(() => tts.resolve({ text: 'x'.repeat(11) })).toThrow('Speech synthesis provider tone accepts at most 10 characters, got 11')
})

it('streams through exactly the resolved provider and rejects a spec whose registration is gone', async () => {
  const { tts } = await registry()
  const dispose = tts.register(provider())
  const spec = tts.resolve({ text: 'hello' })
  expect(await collect(tts.synthesize(spec, never))).toBe('hello')
  const aborted = new AbortController()
  aborted.abort(new Error('caller left'))
  expect(() => tts.synthesize(spec, aborted.signal)).toThrow('caller left')
  await dispose()
  expect(() => tts.synthesize(spec, never)).toThrow('Resolved speech synthesis provider is no longer registered')
  tts.register(provider())
  expect(() => tts.synthesize(spec, never)).toThrow('Resolved speech synthesis provider is no longer registered')
})

it('joins a provider call in flight on withdrawal and rejects later pulls without waiting for an idle stream', async () => {
  const { tts } = await registry()
  const release = Promise.withResolvers<undefined>()
  let aborted = false
  const dispose = tts.register(provider({
    async* synthesize(_input, signal) {
      yield bytes('a')
      signal.addEventListener('abort', () => { aborted = true })
      await release.promise
      signal.throwIfAborted()
    },
  }))
  const idle = tts.synthesize(tts.resolve({ text: 'idle' }), never)[Symbol.asyncIterator]()
  const stream = tts.synthesize(tts.resolve({ text: 'busy' }), never)[Symbol.asyncIterator]()
  expect((await stream.next()).value).toEqual(bytes('a'))
  const pull = stream.next()
  let withdrawn = false
  const withdrawing = dispose().then(() => { withdrawn = true })
  await expect.poll(() => aborted).toBe(true)
  expect(withdrawn).toBe(false)
  release.resolve(undefined)
  await expect(pull).rejects.toThrow('Speech synthesis provider unloaded')
  await withdrawing
  await expect(stream.next()).rejects.toThrow('Speech synthesis provider unloaded')
  await expect(idle.next()).rejects.toThrow('Speech synthesis provider unloaded')
})

it('returns the provider stream when the consumer stops early, also for a provider iterator without return', async () => {
  const { tts } = await registry()
  let returned = false
  const dispose = tts.register(provider({
    async* synthesize() {
      try { yield bytes('a'); yield bytes('b') } finally { returned = true }
    },
  }))
  for await (const chunk of tts.synthesize(tts.resolve({ text: 'x' }), never)) { expect(chunk).toEqual(bytes('a')); break }
  expect(returned).toBe(true)
  await dispose()
  tts.register(provider({
    synthesize: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false as const, value: bytes('z') }) }) }),
  }))
  const endless = tts.synthesize(tts.resolve({ text: 'x' }), never)[Symbol.asyncIterator]()
  expect((await endless.next()).value).toEqual(bytes('z'))
  expect(await endless.return!()).toEqual({ done: true, value: undefined })
})

it('ends followers, withdraws providers, and refuses registration once the service is disposed', async () => {
  const { tts, fiber } = await registry()
  const seen: SynthesisSnapshot[] = []
  const following = (async () => {
    for await (const snapshot of tts.follow(never)) {
      seen.push(snapshot)
      // A change that lands while the follower handles a snapshot is delivered next, without a wait.
      if (seen.length === 1) tts.register(provider())
    }
  })()
  await expect.poll(() => seen.map(snapshot => snapshot.providers.length)).toEqual([0, 1])
  await fiber.dispose()
  await following
  expect(tts.snapshot().providers).toEqual([])
  expect(() => tts.register(provider())).toThrow('Speech synthesis service disposed')
})

it('speaks in the saved voice while the provider offers it, in its default otherwise, and in a named voice it offers', async () => {
  const { tts } = await mounted({ defaultProvider: id, voice: 'high' })
  const voiced = provider({ async* synthesize(input) { yield bytes(`${input.voice}:${input.text}`) } })
  tts.register(voiced)
  expect(tts.snapshot().providers[0]?.voice).toBe('high')
  expect(await collect(tts.synthesize(tts.resolve({ text: 'a' }), never))).toBe('high:a')
  expect(await collect(tts.synthesize(tts.resolve({ text: 'b', voice: 'low' }), never))).toBe('low:b')
  expect(() => tts.resolve({ text: 'c', voice: 'nasal' })).toThrow('Speech synthesis provider tone offers no voice nasal')
  // A saved voice that the provider does not offer, as after the provider was replaced, selects the provider's default.
  const other = await mounted({ defaultProvider: id, voice: 'nasal' })
  other.tts.register(voiced)
  expect(other.tts.snapshot().providers[0]?.voice).toBe('low')
  expect(other.tts.resolve({ text: 'd' }).voice).toBe('low')
})

it('saves an offered voice into the profile entry and reports it to followers', async () => {
  const { tts, writes } = await mounted({ defaultProvider: id })
  await expect(tts.configure({ voice: 'high' })).rejects.toMatchObject({ code: 'service-unavailable' })
  tts.register(provider())
  const stop = new AbortController()
  const seen: (string | undefined)[] = []
  const following = (async () => { for await (const snapshot of tts.follow(stop.signal)) seen.push(snapshot.providers[0]?.voice) })()
  await expect.poll(() => seen).toEqual(['low'])
  await expect(tts.configure({ voice: 'nasal' })).rejects.toThrow('Speech synthesis provider tone offers no voice nasal')
  expect(writes).toEqual([])
  await tts.configure({ voice: 'high' })
  expect(writes).toEqual([{ voice: 'high' }])
  expect(tts.resolve({ text: 'hi' }).voice).toBe('high')
  await expect.poll(() => seen.at(-1)).toBe('high')
  stop.abort()
  await following
})

it('refuses to save a voice without the settings service or a profile entry', async () => {
  const { ctx, tts } = await registry()
  tts.register(provider())
  await expect(tts.configure({ voice: 'high' })).rejects.toThrow('settings service and a profile entry')
  const update = vi.fn()
  ctx.provide('settings', { update } as never)
  await expect(tts.configure({ voice: 'high' })).rejects.toThrow('settings service and a profile entry')
  expect(update).not.toHaveBeenCalled()
})
