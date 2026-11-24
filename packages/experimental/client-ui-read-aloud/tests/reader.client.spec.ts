/** Pacing, stop, failure, and continuation of one reading, and the audition of a voice, driven by a fake audio clock. */
import type { MessageId } from '@deepseek-ai/dsh-api-remotes/client'
import type { AudioFrame, ReadingPlan, ReadingTarget, SampleRequest, SegmentRequest } from '@deepseek-ai/dsh-read-aloud/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Reader, type PcmPlayer, type ReaderState, type SampleTarget } from '../src/client/reader.ts'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

const target: ReadingTarget = { sessionId: 's1' as SessionId, messageId: 'm1' as MessageId }
const other: ReadingTarget = { sessionId: 's2' as SessionId, messageId: 'm2' as MessageId }
const PLAN: ReadingPlan = {
  seq: 7, segments: [{ start: 0, end: 10 }, { start: 10, end: 20 }, { start: 20, end: 30 }], dispatchBelowMs: 1000, sampleRate: 100,
  voice: 'low',
}
const IDLE: ReaderState = { reading: null, notice: null, sample: null, sampleNotice: null }
const HIGH: SampleTarget = { voice: 'high', language: 'zh', sampleRate: 100 }
/** One second of audio at 100 samples per second. */
const SECOND: AudioFrame = { pcm: Buffer.alloc(200).toString('base64') }
const settle = async (ms = 0): Promise<void> => { await vi.advanceTimersByTimeAsync(ms) }

/** A failure as the Remote face throws it. */
function remoteFailure(code: string, details: object): Error {
  return Object.assign(new Error(code), { isDSHRemoteError: true, code, details })
}

/** One synthesis stream the test feeds by hand; a `deaf` one keeps delivering after its request was cancelled. */
function channel<Request>(request: Request, signal: AbortSignal, deaf: boolean) {
  const queue: (IteratorResult<AudioFrame> | Error)[] = []
  let wake = (): void => {}
  const put = (item: IteratorResult<AudioFrame> | Error): void => { queue.push(item); wake() }
  if (!deaf) signal.addEventListener('abort', () => { put(new Error('aborted')) })
  return {
    request, signal,
    push: (...frames: AudioFrame[]): void => { for (const value of frames) put({ done: false, value }) },
    end: (): void => { put({ done: true, value: undefined }) },
    fail: (error: Error): void => { put(error) },
    frames: {
      [Symbol.asyncIterator]: () => ({
        async next(): Promise<IteratorResult<AudioFrame>> {
          if (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve })
          const item = queue.shift()!
          if (item instanceof Error) throw item
          return item
        },
      }),
    },
  }
}

function fixture(plan: ReadingPlan | Error = PLAN, deaf = false) {
  const channels: ReturnType<typeof channel<SegmentRequest>>[] = []
  const samples: ReturnType<typeof channel<SampleRequest>>[] = []
  const players: { end: number; frames: number; closed: boolean }[] = []
  const planned: ReadingTarget[] = []
  const createPlayer = (): PcmPlayer => {
    const audio = { end: 0, frames: 0, closed: false }
    players.push(audio)
    return {
      enqueue(pcm, sampleRate) {
        audio.end = Math.max(audio.end, Date.now()) + pcm.byteLength / 2 / sampleRate * 1000
        audio.frames++
      },
      bufferedSeconds: () => Math.max(0, audio.end - Date.now()) / 1000,
      close() { audio.closed = true },
    }
  }
  const reader = new Reader({
    plan: async (requested) => {
      planned.push(requested)
      if (plan instanceof Error) throw plan
      return plan
    },
    synthesize: (request, signal) => {
      const next = channel(request, signal, deaf)
      channels.push(next)
      return next.frames
    },
    sample: (request, signal) => {
      const next = channel(request, signal, deaf)
      samples.push(next)
      return next.frames
    },
    createPlayer,
  })
  return { reader, channels, samples, players, planned, state: () => reader.state.getSnapshot() }
}

it('requests each segment only when a second or less of received audio is unplayed, and ends after the last one plays out', async () => {
  const b = fixture()
  b.reader.toggle(target)
  expect(b.state()).toEqual({ ...IDLE, reading: { ...target, phase: 'loading' }, notice: null })
  expect(b.players).toHaveLength(1)
  await settle()
  expect(b.channels.map(open => open.request)).toEqual([{ ...target, seq: 7, voice: 'low', start: 0, end: 10 }])
  b.channels[0]!.push(SECOND, SECOND, SECOND)
  b.channels[0]!.end()
  await settle()
  expect(b.state().reading?.phase).toBe('playing')
  await settle(1900)
  expect(b.channels).toHaveLength(1)
  await settle(200)
  expect(b.channels.map(open => open.request.start)).toEqual([0, 10])
  b.channels[1]!.push(SECOND, SECOND)
  b.channels[1]!.end()
  await settle(2000)
  expect(b.channels.map(open => open.request.start)).toEqual([0, 10, 20])
  b.channels[2]!.push(SECOND)
  b.channels[2]!.end()
  await settle(1500)
  expect(b.state().reading?.phase).toBe('playing')
  await settle(600)
  expect(b.state()).toEqual({ ...IDLE, reading: null, notice: null })
  expect(b.players[0]).toMatchObject({ frames: 6, closed: true })
  expect(b.planned).toEqual([target])
})

it('stops on a second click, ends the request, and ignores audio that arrives afterwards', async () => {
  const b = fixture()
  b.reader.toggle(target)
  await settle()
  b.channels[0]!.push(SECOND, SECOND, SECOND)
  b.channels[0]!.end()
  await settle(100)
  b.reader.toggle(target)
  expect(b.state().reading).toBeNull()
  expect(b.players[0]!.closed).toBe(true)
  await settle(10_000)
  expect(b.channels).toHaveLength(1)
  const late = fixture(PLAN, true)
  late.reader.toggle(target)
  await settle()
  late.reader.toggle(target)
  expect(late.channels[0]!.signal.aborted).toBe(true)
  late.channels[0]!.push(SECOND)
  await settle()
  expect(late.players[0]!.frames).toBe(0)
})

it('stops while the last audio plays out without reporting anything', async () => {
  const b = fixture({ ...PLAN, segments: [{ start: 0, end: 10 }] })
  b.reader.toggle(target)
  await settle()
  b.channels[0]!.push(SECOND, SECOND)
  b.channels[0]!.end()
  await settle(500)
  b.reader.toggle(target)
  await settle(5000)
  expect(b.state()).toEqual({ ...IDLE, reading: null, notice: null })
})

it('replaces the reading in progress when another message is started', async () => {
  const b = fixture()
  b.reader.toggle(target)
  await settle()
  b.reader.toggle(other)
  expect(b.state().reading).toEqual({ ...other, phase: 'loading' })
  expect(b.players.map(audio => audio.closed)).toEqual([true, false])
  await settle()
  expect(b.channels[0]!.signal.aborted).toBe(true)
  expect(b.channels[1]!.request).toMatchObject(other)
})

it('shows the loading state again when playback catches up with a slow segment', async () => {
  const b = fixture()
  b.reader.toggle(target)
  await settle()
  b.channels[0]!.push(SECOND)
  b.channels[0]!.end()
  await settle()
  expect(b.channels).toHaveLength(2)
  await settle(1100)
  expect(b.state().reading?.phase).toBe('loading')
  b.channels[1]!.push(SECOND)
  await settle()
  expect(b.state().reading?.phase).toBe('playing')
})

it('keeps the playing state while the audio clock lags behind the wall clock', async () => {
  const b = fixture()
  b.reader.toggle(target)
  await settle()
  b.channels[0]!.push(SECOND)
  await settle()
  // The output device was suspended for a second: the queued audio now ends a second later.
  b.players[0]!.end += 1000
  await settle(1100)
  expect(b.state().reading?.phase).toBe('playing')
  await settle(1100)
  expect(b.state().reading?.phase).toBe('loading')
})

it('reports a reply without readable text and opens no synthesis request', async () => {
  const b = fixture({ ...PLAN, segments: [] })
  b.reader.toggle(target)
  await settle()
  expect(b.state()).toEqual({ ...IDLE, reading: null, notice: { ...target, seq: 1, kind: 'no-text' } })
  expect(b.channels).toHaveLength(0)
  expect(b.players[0]!.closed).toBe(true)
})

it('plays the received audio out after a passing failure and continues at the failed segment on the next click', async () => {
  const b = fixture()
  b.reader.toggle(target)
  await settle()
  b.channels[0]!.push(SECOND, SECOND)
  b.channels[0]!.end()
  await settle(1100)
  b.channels[1]!.fail(remoteFailure('readAloud/synthesis-failed', { reason: 'HTTP 429', code: 'rate-limited' }))
  await settle()
  expect(b.state().reading?.phase).toBe('playing')
  await settle(1000)
  expect(b.state()).toEqual({ ...IDLE, reading: null, notice: { ...target, seq: 1, kind: 'rate-limited' } })
  b.reader.toggle(target)
  expect(b.state()).toEqual({ ...IDLE, reading: { ...target, phase: 'loading' }, notice: null })
  await settle()
  expect(b.planned).toHaveLength(1)
  expect(b.channels[2]!.request.start).toBe(10)
})

it('does not offer continuation after a failure that will not pass or before a plan exists', async () => {
  const rejected = fixture()
  rejected.reader.toggle(target)
  await settle()
  rejected.channels[0]!.fail(remoteFailure('readAloud/synthesis-failed', { reason: 'HTTP 400', code: 'text-rejected' }))
  await settle()
  expect(rejected.state()).toEqual({ ...IDLE, reading: null, notice: { ...target, seq: 1, kind: 'text-rejected' } })
  rejected.reader.toggle(target)
  await settle()
  expect(rejected.planned).toHaveLength(2)
  const unplanned = fixture(new Error('offline'))
  unplanned.reader.toggle(target)
  await settle()
  expect(unplanned.state()).toEqual({ ...IDLE, reading: null, notice: { ...target, seq: 1, kind: 'failed' } })
  unplanned.reader.toggle(target)
  await settle()
  expect(unplanned.planned).toHaveLength(2)
  const unclassified = fixture()
  unclassified.reader.toggle(target)
  await settle()
  unclassified.channels[0]!.fail(remoteFailure('readAloud/synthesis-failed', { reason: 'socket closed' }))
  await settle()
  expect(unclassified.state()).toMatchObject({ notice: { kind: 'failed' } })
  unclassified.reader.toggle(target)
  await settle()
  expect(unclassified.planned).toHaveLength(1)
  // The Host refuses a range that is no longer a segment; the next click plans the message again.
  unclassified.channels[1]!.fail(remoteFailure('readAloud/stale-plan', { reason: 'range-mismatch' }))
  await settle()
  expect(unclassified.state()).toMatchObject({ notice: { seq: 2, kind: 'failed' } })
  unclassified.reader.toggle(target)
  await settle()
  expect(unclassified.planned).toHaveLength(2)
  expect(unclassified.channels[2]!.request.start).toBe(0)
})

it('forgets an interrupted reading when another message is read', async () => {
  const b = fixture()
  b.reader.toggle(target)
  await settle()
  b.channels[0]!.fail(new Error('socket closed'))
  await settle()
  expect(b.state().notice).toMatchObject({ ...target, kind: 'failed' })
  b.reader.toggle(other)
  await settle()
  b.reader.toggle(other)
  expect(b.state()).toEqual({ ...IDLE, reading: null, notice: null })
  b.reader.toggle(target)
  await settle()
  expect(b.planned).toEqual([target, other, target])
})

it('drops the reading, the interrupted reading, and the notice of a Session the user left', async () => {
  const b = fixture()
  b.reader.toggle(target)
  await settle()
  b.reader.leave(other.sessionId)
  expect(b.state().reading).toMatchObject(target)
  b.reader.leave(target.sessionId)
  expect(b.state()).toEqual({ ...IDLE, reading: null, notice: null })
  expect(b.players[0]!.closed).toBe(true)
  b.reader.toggle(target)
  await settle()
  b.channels[1]!.fail(new Error('socket closed'))
  await settle()
  expect(b.state()).toMatchObject({ notice: { ...target, kind: 'failed' } })
  b.reader.toggle(other)
  await settle()
  b.channels[2]!.fail(new Error('socket closed'))
  await settle()
  b.reader.leave(target.sessionId)
  expect(b.state()).toMatchObject({ notice: other })
  b.reader.leave(other.sessionId)
  expect(b.state()).toEqual({ ...IDLE, reading: null, notice: null })
  b.reader.toggle(other)
  await settle()
  expect(b.planned).toHaveLength(4)
})

it('retires only the notice that was shown and releases everything on disposal', async () => {
  const b = fixture({ ...PLAN, segments: [] })
  b.reader.toggle(target)
  await settle()
  b.reader.dismissNotice(9)
  expect(b.state().notice?.seq).toBe(1)
  b.reader.dismissNotice(1)
  expect(b.state().notice).toBeNull()
  const busy = fixture()
  busy.reader.toggle(target)
  await settle()
  busy.channels[0]!.fail(new Error('socket closed'))
  await settle()
  busy.reader.toggle(other)
  busy.reader.dispose()
  expect(busy.state().reading).toBeNull()
  expect(busy.players.every(audio => audio.closed)).toBe(true)
  busy.reader.dispose()
})

it('plays an audition through its own output, shows its phases, and ends once its audio played out', async () => {
  const b = fixture()
  b.reader.toggleSample(HIGH)
  expect(b.state()).toEqual({ ...IDLE, sample: { voice: 'high', phase: 'loading' } })
  expect(b.players).toHaveLength(1)
  await settle()
  expect(b.samples.map(open => open.request)).toEqual([{ voice: 'high', language: 'zh' }])
  b.samples[0]!.push(SECOND, SECOND)
  await settle()
  expect(b.state().sample).toEqual({ voice: 'high', phase: 'playing' })
  // Playback catches up while more audio is still expected.
  await settle(2100)
  expect(b.state().sample).toEqual({ voice: 'high', phase: 'loading' })
  b.samples[0]!.push(SECOND)
  b.samples[0]!.end()
  await settle(900)
  expect(b.state().sample?.phase).toBe('playing')
  await settle(200)
  expect(b.state()).toEqual(IDLE)
  expect(b.players[0]).toMatchObject({ frames: 3, closed: true })
  expect(b.planned).toEqual([])
})

it('stops an audition on a second click of its voice, replaces it for another voice, and ignores what arrives afterwards', async () => {
  const b = fixture(PLAN, true)
  b.reader.toggleSample(HIGH)
  await settle()
  b.reader.toggleSample(HIGH)
  expect(b.state()).toEqual(IDLE)
  expect(b.samples[0]!.signal.aborted).toBe(true)
  expect(b.players[0]!.closed).toBe(true)
  // The cancelled request still delivers audio and then fails: neither is played or reported.
  b.samples[0]!.push(SECOND)
  await settle()
  expect(b.players[0]!.frames).toBe(0)
  b.reader.toggleSample(HIGH)
  await settle()
  b.reader.toggleSample({ ...HIGH, voice: 'low' })
  expect(b.state().sample).toEqual({ voice: 'low', phase: 'loading' })
  expect(b.players.map(audio => audio.closed)).toEqual([true, true, false])
  await settle()
  b.samples[1]!.fail(remoteFailure('readAloud/synthesis-failed', { reason: 'late', code: 'timeout' }))
  await settle()
  expect(b.state().sampleNotice).toBeNull()
  b.reader.stopSample()
  expect(b.state()).toEqual(IDLE)
  b.reader.stopSample()
})

it('lets a reading and an audition replace each other, and keeps an audition when a Session is left', async () => {
  const b = fixture()
  b.reader.toggle(target)
  await settle()
  // Stopping auditions leaves a reading alone.
  b.reader.stopSample()
  expect(b.state().reading).toMatchObject(target)
  b.reader.toggleSample(HIGH)
  expect(b.state()).toEqual({ ...IDLE, sample: { voice: 'high', phase: 'loading' } })
  expect(b.channels[0]!.signal.aborted).toBe(true)
  b.reader.leave(target.sessionId)
  expect(b.state().sample).toEqual({ voice: 'high', phase: 'loading' })
  b.reader.toggle(target)
  expect(b.state()).toEqual({ ...IDLE, reading: { ...target, phase: 'loading' } })
  expect(b.players.map(audio => audio.closed)).toEqual([true, true, false])
})

it('reports an audition failure after the received audio played out and retires it by its sequence', async () => {
  const b = fixture()
  b.reader.toggleSample(HIGH)
  await settle()
  b.samples[0]!.push(SECOND)
  b.samples[0]!.fail(remoteFailure('readAloud/synthesis-failed', { reason: 'HTTP 402', code: 'quota-exceeded' }))
  await settle(900)
  expect(b.state().sample?.phase).toBe('playing')
  await settle(200)
  expect(b.state()).toEqual({ ...IDLE, sampleNotice: { seq: 1, kind: 'quota-exceeded' } })
  b.reader.dismissSampleNotice(9)
  expect(b.state().sampleNotice?.seq).toBe(1)
  b.reader.dismissSampleNotice(1)
  expect(b.state()).toEqual(IDLE)
  // A failure outside the Remote face is reported too, and the next audition clears it.
  b.reader.toggleSample(HIGH)
  await settle()
  b.samples[1]!.fail(new Error('socket closed'))
  await settle()
  expect(b.state().sampleNotice).toEqual({ seq: 2, kind: 'failed' })
  b.reader.toggleSample(HIGH)
  expect(b.state().sampleNotice).toBeNull()
})
