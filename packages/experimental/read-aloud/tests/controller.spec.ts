/** Availability, planning, and segment synthesis through the read-aloud Remote methods. */
import { Context } from '@deepseek-ai/cordis'
import type { MessageId } from '@deepseek-ai/dsh-llm/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import TextToSpeech, { SpeechSynthesisError } from '@deepseek-ai/dsh-text-to-speech'
import type { SynthesisAvailability, SynthesisProvider, SynthesisProviderId } from '@deepseek-ai/dsh-text-to-speech/types'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it } from 'vitest'
import ReadAloudController from '../src/index.ts'
import type { ReadAloudStatus } from '../src/types.ts'
import { logHandle, prompt, reply } from './log-double.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => root.fiber.dispose())) })

const providerId = 'tone' as SynthesisProviderId
const never = new AbortController().signal
const stored = 'stored' as SessionId, live = 'live' as SessionId
const first = 'm-first' as MessageId
/** Two sentences of 3.5 s each: with a 3 s target they are two segments, and the line break between them is in neither. */
const MARKDOWN = '**第一句**话在这里说完整了十五个字。\n\n```sh\nskip me\n```\n\n第二句话也在这里说完整了十五个字。'
const SEGMENTS = [{ start: 0, end: 16 }, { start: 17, end: 34 }]

interface Options {
  readonly provider?: Partial<SynthesisProvider>
  readonly registered?: boolean
}

function fixture(options: Options = {}) {
  const ctx = new Context(); roots.push(ctx)
  const tts = new TextToSpeech(ctx, { defaultProvider: providerId })
  const spoken: string[] = []
  const provider: SynthesisProvider = {
    info: { id: providerId, name: 'Tone', location: 'host-local', audio: { encoding: 'pcm-s16le', sampleRate: 1000 }, maxCharacters: 1000 },
    async* synthesize(input) {
      spoken.push(input.text)
      // 1000 bytes in uneven chunks: at 1000 samples per second a frame is 400 bytes.
      const audio = Uint8Array.from({ length: 1000 }, (_unused, index) => index % 251)
      yield audio.subarray(0, 333)
      yield audio.subarray(333)
    },
    ...options.provider,
  }
  if (options.registered !== false) tts.register(provider)
  const events = [prompt(0), reply(1, first, MARKDOWN), prompt(2), reply(3, 'm-code', '```ts\nconst a = 1\n```')]
  const opened: ReturnType<typeof logHandle>[] = []
  const flushed: string[] = []
  ctx.provide('sessions', {
    get: (id: SessionId) => id === live ? { id, seq: events.length } : undefined,
    flush: async (session: { id: string }) => { flushed.push(session.id); return true },
  } as never)
  ctx.provide('sessionPersistence', {
    stat: async (id: SessionId) => id === stored ? { eventCount: events.length } : undefined,
    open: async () => { const log = logHandle(events); opened.push(log); return log.handle },
  } as never)
  const api = new ReadAloudController(ctx, { segmentSeconds: 3, dispatchBelowSeconds: 2 })
  return { api, tts, spoken, opened, flushed }
}

async function frames(audio: AsyncIterable<{ pcm: string }>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = []
  for await (const frame of audio) out.push(new Uint8Array(Buffer.from(frame.pcm, 'base64')))
  return out
}

it('follows availability as one state and reports each change once', async () => {
  let availability: SynthesisAvailability = { phase: 'unavailable', reason: 'sign-in-required' }
  const listeners = new Set<() => void>()
  const change = (next: SynthesisAvailability): void => { availability = next; for (const listener of listeners) listener() }
  const { api, tts } = fixture({ registered: false })
  const stop = new AbortController()
  const seen: ReadAloudStatus['state'][] = []
  const following = (async () => { for await (const status of api.follow(stop.signal)) seen.push(status.state) })()
  await expect.poll(() => seen).toEqual(['unavailable'])
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  tts.register({
    info: { id: providerId, name: 'Tone', location: 'cloud', audio: { encoding: 'pcm-s16le', sampleRate: 1000 }, maxCharacters: 10 },
    availability: { snapshot: () => availability, subscribe },
    async* synthesize() { /* Availability only. */ },
  })
  await expect.poll(() => seen).toEqual(['unavailable', 'sign-in-required'])
  change({ phase: 'unavailable', reason: 'sign-in-required' })
  change({ phase: 'ready' })
  await expect.poll(() => seen).toEqual(['unavailable', 'sign-in-required', 'ready'])
  change({ phase: 'failed', message: 'settings' })
  await expect.poll(() => seen).toEqual(['unavailable', 'sign-in-required', 'ready', 'unavailable'])
  // A second failure is a new snapshot with the same state, which is not reported again.
  change({ phase: 'failed', message: 'still failing' })
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  change({ phase: 'ready' })
  await expect.poll(() => seen).toEqual(['unavailable', 'sign-in-required', 'ready', 'unavailable', 'ready'])
  stop.abort()
  await following
})

it('plans a stored reply from its readable text and closes the log it read', async () => {
  const { api, opened, flushed } = fixture()
  expect(await api.plan({ sessionId: stored, messageId: first }, never))
    .toEqual({ seq: 1, segments: SEGMENTS, dispatchBelowMs: 2000, sampleRate: 1000 })
  expect(flushed).toEqual([])
  expect(opened.map(log => log.state.closed)).toEqual([true])
  expect(await api.plan({ sessionId: stored, messageId: 'm-code' as MessageId }, never)).toMatchObject({ seq: 3, segments: [] })
})

it('flushes a live Session before reading and uses its log length', async () => {
  const { api, opened, flushed } = fixture()
  expect(await api.plan({ sessionId: live, messageId: first }, never)).toMatchObject({ seq: 1, segments: SEGMENTS })
  expect(flushed).toEqual([live])
  expect(opened[0]!.reads).toEqual([{ offset: 0, length: 4 }])
})

it('refuses a plan for an unknown Session or message, without a provider, and after cancellation', async () => {
  const { api, opened } = fixture()
  const missing = { code: 'readAloud/message-not-found', details: { reason: 'message-not-found' } }
  await expect(api.plan({ sessionId: 'gone' as SessionId, messageId: first }, never)).rejects.toMatchObject(missing)
  expect(opened).toEqual([])
  await expect(api.plan({ sessionId: stored, messageId: 'gone' as MessageId }, never)).rejects.toMatchObject(missing)
  const cancelled = new AbortController()
  cancelled.abort(new Error('listener left'))
  await expect(api.plan({ sessionId: stored, messageId: first }, cancelled.signal)).rejects.toThrow('listener left')
  await expect(fixture({ registered: false }).api.plan({ sessionId: stored, messageId: first }, never)).rejects.toMatchObject({
    code: 'readAloud/synthesis-failed', details: { code: 'service-unavailable', reason: 'Speech synthesis provider is unavailable: tone' },
  })
})

it('speaks exactly the planned segment and frames the audio in whole samples', async () => {
  const { api, spoken } = fixture()
  const request = { sessionId: stored, messageId: first, seq: 1 }
  const audio = await frames(api.synthesize({ ...request, ...SEGMENTS[1]! }, never))
  expect(spoken).toEqual(['第二句话也在这里说完整了十五个字。'])
  expect(audio.map(frame => frame.byteLength)).toEqual([400, 400, 200])
  expect(new Uint8Array(Buffer.concat(audio))).toEqual(Uint8Array.from({ length: 1000 }, (_unused, index) => index % 251))
  await frames(api.synthesize({ ...request, ...SEGMENTS[0]! }, never))
  expect(spoken[1]).toBe('第一句话在这里说完整了十五个字。')
})

it('refuses a range that is no segment of the message and a position that holds another event', async () => {
  const { api, spoken } = fixture()
  await expect(frames(api.synthesize({ sessionId: stored, messageId: first, seq: 1, start: 0, end: 5 }, never)))
    .rejects.toMatchObject({ code: 'readAloud/stale-plan', details: { reason: 'range-mismatch' } })
  await expect(frames(api.synthesize({ sessionId: stored, messageId: first, seq: 2, ...SEGMENTS[0]! }, never)))
    .rejects.toMatchObject({ code: 'readAloud/message-not-found' })
  const cancelled = new AbortController()
  cancelled.abort(new Error('listener left'))
  await expect(frames(api.synthesize({ sessionId: stored, messageId: first, seq: 1, ...SEGMENTS[0]! }, cancelled.signal)))
    .rejects.toThrow('listener left')
  expect(spoken).toEqual([])
})

it('reports a classified provider failure with its code and any other failure with its reason', async () => {
  const request = { sessionId: stored, messageId: first, seq: 1, ...SEGMENTS[0]! }
  const failing = (error: unknown) => {
    const synthesize = () => ({ [Symbol.asyncIterator]: () => ({ next: async () => { throw error } }) })
    return fixture({ provider: { synthesize } }).api
  }
  await expect(frames(failing(new SpeechSynthesisError('rate-limited', 'HTTP 429: busy')).synthesize(request, never)))
    .rejects.toMatchObject({ code: 'readAloud/synthesis-failed', details: { code: 'rate-limited', reason: 'HTTP 429: busy' } })
  const plain = await frames(failing(new Error('socket closed')).synthesize(request, never)).catch((error: unknown) => error)
  expect(plain).toMatchObject({ code: 'readAloud/synthesis-failed', details: { reason: 'socket closed' } })
  expect(plain).not.toHaveProperty('details.code')
  await expect(frames(failing('boom').synthesize(request, never))).rejects.toMatchObject({ details: { reason: 'boom' } })
})

it('propagates the caller cancellation instead of a synthesis failure', async () => {
  const caller = new AbortController()
  const { api } = fixture({
    provider: {
      async* synthesize(_input, signal) {
        yield new Uint8Array(400)
        await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }) })
        signal.throwIfAborted()
      },
    },
  })
  const stream = api.synthesize({ sessionId: stored, messageId: first, seq: 1, ...SEGMENTS[0]! }, caller.signal)[Symbol.asyncIterator]()
  expect((await stream.next()).done).toBe(false)
  const pending = stream.next()
  caller.abort(new Error('listener left'))
  await expect(pending).rejects.toThrow('listener left')
})

it('names the Session each reading method touches, so access is decided per Session', () => {
  const { api } = fixture()
  const readers = new Map(remoteMethods(api).map(marker => [marker.method, marker.resources]))
  expect(readers.get('follow')).toBeUndefined()
  expect(readers.get('plan')?.['session']?.({ sessionId: stored, messageId: first })).toBe(stored)
  expect(readers.get('synthesize')?.['session']?.({ sessionId: live, messageId: first, seq: 1, start: 0, end: 16 })).toBe(live)
})
