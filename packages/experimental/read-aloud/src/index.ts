/**
 * Authenticated, cancellation-aware Client access to paced read-aloud. The Client asks for one segment of a reply at
 * a time, so text the listener has not reached is never submitted for synthesis.
 * @module @deepseek-ai/dsh-read-aloud
 */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { SpeechSynthesisError } from '@deepseek-ai/dsh-text-to-speech'
import type { SynthesisProviderView, SynthesisSnapshot } from '@deepseek-ai/dsh-text-to-speech/types'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { pcmFrames } from './frames.ts'
import { findReply, replyAt, type StoredReply } from './message.ts'
import { segmentSpeech, type SegmentRule } from './segments.ts'
import { speechText } from './speech-text.ts'
import type {
  AudioFrame, ReadAloudStatus, ReadingPlan, ReadingTarget, SampleRequest, SegmentRequest, VoiceSelection,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Experimental read-aloud Remote controller. */
    readAloud: ReadAloudController
  }
}

/** Pacing of one reading; both values trade cost after an early stop against the number of requests. */
export interface Config {
  /** Estimated spoken length, in seconds, of the text one synthesis request carries. */
  segmentSeconds: number
  /** The Client requests the next segment once this many seconds of received audio, or fewer, remain unplayed. */
  dispatchBelowSeconds: number
}

/** Audio in one frame sent to the Client, in milliseconds. */
const FRAME_MS = 200
/** Bytes per sample of 16-bit mono PCM. */
const SAMPLE_BYTES = 2
/** The sentence `sample` speaks, by language. The Host owns the text, so a Client cannot have other text spoken. */
const SAMPLE_TEXT: ReadonlyMap<string, string> = new Map([
  ['zh', '你好，这是语音朗读的试听。'],
  ['en', 'Hello, this is how read aloud sounds.'],
  ['ja', 'こんにちは、読み上げの試聴です。'],
])
/** Spoken for a language without a sentence of its own. */
const FALLBACK_SAMPLE = 'Hello, this is how read aloud sounds.'

function selected(snapshot: SynthesisSnapshot): SynthesisProviderView | undefined {
  return snapshot.providers.find(provider => provider.id === snapshot.selected)
}

function stateOf(provider: SynthesisProviderView): ReadAloudStatus['state'] {
  if (provider.availability.phase === 'ready') return 'ready'
  return provider.availability.phase === 'unavailable' ? 'sign-in-required' : 'unavailable'
}

function statusOf(snapshot: SynthesisSnapshot): ReadAloudStatus {
  const provider = selected(snapshot)
  return provider === undefined ? { state: 'unavailable' } : {
    state: stateOf(provider),
    synthesis: { voices: provider.voices, voice: provider.voice, sampleRate: provider.audio.sampleRate },
  }
}

/** Read-aloud calls never activate, read from, or submit to an Agent, and append no Session event. */
export default class ReadAloudController extends TypertRemoteService {
  static inject = ['textToSpeech', 'typert', 'sessions', 'sessionPersistence']
  static Config: z<Config> = z.object({
    segmentSeconds: z.number().min(5).max(300).default(30),
    dispatchBelowSeconds: z.number().min(1).max(300).default(15),
  })

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'readAloud')
  }

  /**
   * Follow whether a reading can start and which voices exist, so the Client offers the action only while it can and
   * shows the saved voice.
   * @param signal - Client observation lifetime.
   * @returns the current status, then each change of it.
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<ReadAloudStatus> {
    let last: string | undefined
    for await (const snapshot of this.ctx.textToSpeech.follow(signal)) {
      const status = statusOf(snapshot), key = JSON.stringify(status)
      if (key === last) continue
      last = key
      yield status
    }
  }

  /**
   * Save the voice that readings started afterwards use.
   * @param selection - one of the voices `follow()` reports.
   */
  @Remote
  async configure(selection: VoiceSelection): Promise<void> {
    await this.ctx.textToSpeech.configure({ voice: selection.voice })
  }

  /**
   * Locate one finalized assistant message and cut its readable text into segments.
   * @param target - Session and message to read.
   * @param signal - Client cancellation.
   * @returns the message's log position, its segments, the voice, and the pacing and audio facts; no text leaves the Host.
   */
  @Remote({ resources: { session: target => target.sessionId } })
  async plan(target: ReadingTarget, signal: AbortSignal): Promise<ReadingPlan> {
    signal.throwIfAborted()
    const provider = this.provider()
    const reply = await this.reply(target, undefined, signal)
    return {
      seq: reply.seq,
      segments: segmentSpeech(speechText(reply.markdown), this.rule(provider)),
      dispatchBelowMs: this.config.dispatchBelowSeconds * 1000,
      sampleRate: provider.audio.sampleRate,
      voice: provider.voice,
    }
  }

  /**
   * Synthesize one planned segment in the plan's voice. The range must be a segment of the message under the current
   * configuration, so a Client cannot have other text spoken.
   * @param request - message position, one segment of its plan, and the plan's voice.
   * @param signal - Client cancellation; it ends the provider request.
   * @returns frames of whole PCM samples in playback order.
   */
  @Remote({ mode: 'stream', resources: { session: request => request.sessionId } })
  async *synthesize(request: SegmentRequest, signal: AbortSignal): AsyncIterable<AudioFrame> {
    signal.throwIfAborted()
    const provider = this.provider()
    const text = speechText((await this.reply(request, request.seq, signal)).markdown)
    if (!segmentSpeech(text, this.rule(provider)).some(segment => segment.start === request.start && segment.end === request.end)) {
      throw new RemoteError('readAloud/stale-plan', 'The range is not a segment of this message', { reason: 'range-mismatch' })
    }
    if (!provider.voices.includes(request.voice)) {
      throw new RemoteError('readAloud/stale-plan', 'The provider does not offer the voice of this plan', { reason: 'voice-not-offered' })
    }
    yield* this.speak(provider, text.slice(request.start, request.end), request.voice, signal)
  }

  /**
   * Speak the Host's sample sentence in one voice, so a listener can choose between voices.
   * @param request - voice to hear and the language of the sentence.
   * @param signal - Client cancellation; it ends the provider request.
   * @returns frames of whole PCM samples in playback order, at `SynthesisFacts.sampleRate`.
   */
  @Remote({ mode: 'stream' })
  async *sample(request: SampleRequest, signal: AbortSignal): AsyncIterable<AudioFrame> {
    signal.throwIfAborted()
    yield* this.speak(this.provider(), SAMPLE_TEXT.get(request.language) ?? FALLBACK_SAMPLE, request.voice, signal)
  }

  /** One synthesis as frames; every failure but the caller's cancellation is reported as a synthesis failure. */
  private async *speak(provider: SynthesisProviderView, text: string, voice: string, signal: AbortSignal): AsyncIterable<AudioFrame> {
    const frameBytes = Math.round(provider.audio.sampleRate * FRAME_MS / 1000) * SAMPLE_BYTES
    try {
      const spec = this.ctx.textToSpeech.resolve({ text, voice })
      for await (const frame of pcmFrames(this.ctx.textToSpeech.synthesize(spec, signal), frameBytes)) {
        yield { pcm: Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).toString('base64') }
      }
    } catch (error) {
      signal.throwIfAborted()
      throw synthesisFailure(error)
    }
  }

  private rule(provider: SynthesisProviderView): SegmentRule {
    return { targetMs: this.config.segmentSeconds * 1000, maxCharacters: provider.maxCharacters }
  }

  /** The configured provider's facts and current voice; segmentation and audio decoding depend on the facts. */
  private provider(): SynthesisProviderView {
    const snapshot = this.ctx.textToSpeech.snapshot(), provider = selected(snapshot)
    if (provider === undefined) {
      const unavailable = `Speech synthesis provider is unavailable: ${snapshot.selected}`
      throw synthesisFailure(new SpeechSynthesisError('service-unavailable', unavailable))
    }
    return provider
  }

  /**
   * Read the message from storage. A live Session is flushed first, because its newest events may not be stored yet,
   * and reports its own log length; a stored one reports the length its backend has at hand.
   */
  private async reply(target: ReadingTarget, seq: number | undefined, signal: AbortSignal): Promise<StoredReply> {
    const live = this.ctx.sessions.get(target.sessionId)
    const stored = live === undefined ? await this.ctx.sessionPersistence.stat(target.sessionId) : undefined
    let reply: StoredReply | undefined
    if (live !== undefined || stored !== undefined) {
      if (live !== undefined) await this.ctx.sessions.flush(live)
      await using handle = await this.ctx.sessionPersistence.open(target.sessionId, 'read')
      reply = seq === undefined
        ? await findReply(handle, target.messageId, live?.seq ?? stored?.eventCount, signal)
        : await replyAt(handle, target.messageId, seq, signal)
    }
    if (reply === undefined) {
      throw new RemoteError('readAloud/message-not-found', 'The Session holds no such assistant message', { reason: 'message-not-found' })
    }
    return reply
  }
}

function synthesisFailure(error: unknown): RemoteError<'readAloud/synthesis-failed'> {
  const reason = error instanceof Error ? error.message : String(error)
  const details = error instanceof SpeechSynthesisError ? { reason, code: error.code } : { reason }
  return new RemoteError('readAloud/synthesis-failed', reason, details)
}
