/**
 * One reading at a time. A reply's segments are requested one by one, each only when little of the received audio is
 * still unplayed, so stopping early leaves the later segments unsynthesized. The audition of a voice plays through the
 * same output and replaces a reading in progress, as a reading replaces it.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AudioFrame, ReadingPlan, ReadingTarget, SampleRequest, SegmentRequest } from '@deepseek-ai/dsh-read-aloud/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SynthesisFailureCode } from '@deepseek-ai/dsh-text-to-speech/types'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'

/** Why a reading ended without finishing: no readable text, a classified synthesis failure, or any other failure. */
export type ReadingNotice = 'no-text' | 'failed' | SynthesisFailureCode

/** One audition and the rate of the audio it returns; no plan precedes it to report the rate. */
export interface SampleTarget extends SampleRequest {
  /** Samples per second of the audition's PCM. */
  readonly sampleRate: number
}

/** What the action row, the notice, and the voice preference show. */
export interface ReaderState {
  /** The reading in progress: `loading` while no received audio is left to play, `playing` otherwise. */
  readonly reading: (ReadingTarget & { readonly phase: 'loading' | 'playing' }) | null
  /** The latest unseen notice; `seq` distinguishes two notices of one kind. */
  readonly notice: (ReadingTarget & { readonly seq: number; readonly kind: ReadingNotice }) | null
  /** The audition in progress, with the phases of a reading. */
  readonly sample: { readonly voice: string; readonly phase: 'loading' | 'playing' } | null
  /** The latest unseen audition failure; `seq` distinguishes two of one kind. */
  readonly sampleNotice: { readonly seq: number; readonly kind: ReadingNotice } | null
}

/** Gapless playback of PCM chunks in arrival order. */
export interface PcmPlayer {
  /**
   * Queue samples behind the audio already queued.
   * @param pcm - whole 16-bit little-endian mono samples.
   * @param sampleRate - samples per second.
   */
  enqueue(pcm: Uint8Array, sampleRate: number): void
  /** @returns seconds of queued audio not yet played. */
  bufferedSeconds(): number
  /** Silence the queue and release the audio device. */
  close(): void
}

/** Host calls and the audio output a reader drives. */
export interface ReaderPorts {
  plan(target: ReadingTarget, signal: AbortSignal): Promise<ReadingPlan>
  synthesize(request: SegmentRequest, signal: AbortSignal): AsyncIterable<AudioFrame>
  sample(request: SampleRequest, signal: AbortSignal): AsyncIterable<AudioFrame>
  /** Called while the click that starts a reading or an audition is being handled, so the browser lets the output start. */
  createPlayer(): PcmPlayer
}

/** What a run plays: one message of a Session, or the audition of one voice. */
type Subject =
  | { readonly kind: 'message'; readonly target: ReadingTarget }
  | { readonly kind: 'sample'; readonly voice: string }

interface Run {
  readonly subject: Subject
  readonly abort: AbortController
  readonly player: PcmPlayer
  /** Wakes when the queued audio should have run out. */
  drain?: ReturnType<typeof setTimeout>
  /** Set once nothing more will be queued, so running out of audio is the end and not a wait. */
  closing?: true
}

interface Kept {
  readonly target: ReadingTarget
  readonly plan: ReadingPlan
  readonly next: number
}

/** Synthesis failure classes that may pass, after which the reading continues from the failed segment. */
const PASSING: ReadonlySet<SynthesisFailureCode> = new Set<SynthesisFailureCode>([
  'rate-limited', 'service-unavailable', 'timeout', 'service-error',
])
/** Slack added to a wait for queued audio, in milliseconds, so the wake lands after the audio clock passed the mark. */
const SLACK_MS = 20

const same = (a: ReadingTarget, b: ReadingTarget): boolean => a.sessionId === b.sessionId && a.messageId === b.messageId

/**
 * Classify a failed plan, segment, or audition. A failure outside the Remote face is a lost connection and an
 * unclassified synthesis failure is unknown, so both may pass; a refused message, range, or voice stays refused for
 * the same plan.
 */
function failureOf(error: unknown): { kind: ReadingNotice; passing: boolean } {
  const failure = remoteErrorOf(error)
  if (failure === undefined) return { kind: 'failed', passing: true }
  if (failure.code !== 'readAloud/synthesis-failed') return { kind: 'failed', passing: false }
  const code = failure.details.code
  return code === undefined ? { kind: 'failed', passing: true } : { kind: code, passing: PASSING.has(code) }
}

function samples(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Reading state and its pacing loop, shared by every action row and the voice preference of one Client plugin. */
export class Reader {
  /** Observable state; every change is published as one new snapshot. */
  readonly state: SnapshotStore<ReaderState> = createSnapshotStore<ReaderState>({
    reading: null, notice: null, sample: null, sampleNotice: null,
  })

  private current: Run | undefined
  private kept: Kept | undefined
  private notices = 0

  /** @param ports - Host calls and audio output. */
  constructor(private readonly ports: ReaderPorts) {}

  /**
   * Stop the reading of this message, or start reading it and stop any other reading or audition. A message whose
   * reading a passing failure interrupted continues at the failed segment.
   * @param target - Session and message of the clicked action.
   */
  toggle(target: ReadingTarget): void {
    const active = this.current?.subject
    this.stop()
    if (active?.kind === 'message' && same(active.target, target)) return
    const kept = this.kept !== undefined && same(this.kept.target, target) ? this.kept : undefined
    this.kept = undefined
    const run = this.begin({ kind: 'message', target })
    this.state.set({ ...this.state.getSnapshot(), reading: { ...target, phase: 'loading' }, notice: null })
    void this.read(run, target, kept)
  }

  /**
   * Stop the audition of this voice, or start it and stop any reading or other audition.
   * @param sample - voice to hear, the language of the sentence, and the audio rate.
   */
  toggleSample(sample: SampleTarget): void {
    const active = this.current?.subject
    this.stop()
    if (active?.kind === 'sample' && active.voice === sample.voice) return
    const run = this.begin({ kind: 'sample', voice: sample.voice })
    this.state.set({ ...this.state.getSnapshot(), sample: { voice: sample.voice, phase: 'loading' }, sampleNotice: null })
    void this.audition(run, sample)
  }

  /** Stop the audition in progress; a reading continues. */
  stopSample(): void {
    if (this.current?.subject.kind === 'sample') this.stop()
  }

  /**
   * Drop everything that belongs to a Session the user left: its reading, its interrupted reading, and its notice.
   * @param sessionId - Session no longer on screen.
   */
  leave(sessionId: SessionId): void {
    const active = this.current?.subject
    if (active?.kind === 'message' && active.target.sessionId === sessionId) this.stop()
    if (this.kept?.target.sessionId === sessionId) this.kept = undefined
    const state = this.state.getSnapshot()
    if (state.notice?.sessionId === sessionId) this.state.set({ ...state, notice: null })
  }

  /**
   * Retire a notice once it was shown.
   * @param seq - sequence of the shown notice; a newer notice stays.
   */
  dismissNotice(seq: number): void {
    const state = this.state.getSnapshot()
    if (state.notice?.seq === seq) this.state.set({ ...state, notice: null })
  }

  /**
   * Retire an audition failure once it was shown.
   * @param seq - sequence of the shown failure; a newer one stays.
   */
  dismissSampleNotice(seq: number): void {
    const state = this.state.getSnapshot()
    if (state.sampleNotice?.seq === seq) this.state.set({ ...state, sampleNotice: null })
  }

  /** Stop the reading or audition in progress and forget an interrupted reading. */
  dispose(): void {
    this.stop()
    this.kept = undefined
  }

  private begin(subject: Subject): Run {
    const run: Run = { subject, abort: new AbortController(), player: this.ports.createPlayer() }
    this.current = run
    return run
  }

  private stop(): void {
    const run = this.current
    if (run === undefined) return
    this.release(run)
    this.state.set({ ...this.state.getSnapshot(), reading: null, sample: null })
  }

  /** End the run's requests, timers, and audio; pending steps of its loop then find another current run. */
  private release(run: Run): void {
    this.current = undefined
    run.abort.abort()
    clearTimeout(run.drain)
    run.player.close()
  }

  private finish(run: Run, kind?: ReadingNotice): void {
    this.release(run)
    const state = this.state.getSnapshot()
    const seq = (): number => ++this.notices
    if (run.subject.kind === 'message') {
      this.state.set({ ...state, reading: null, notice: kind === undefined ? null : { ...run.subject.target, seq: seq(), kind } })
    } else {
      this.state.set({ ...state, sample: null, sampleNotice: kind === undefined ? null : { seq: seq(), kind } })
    }
  }

  private async read(run: Run, target: ReadingTarget, kept: Kept | undefined): Promise<void> {
    let plan = kept?.plan
    let next = kept?.next ?? 0
    let failure: ReadingNotice | undefined
    try {
      plan ??= await this.ports.plan(target, run.abort.signal)
      if (plan.segments.length === 0) failure = 'no-text'
      for (const segment of plan.segments.slice(next)) {
        await this.playedDownTo(run, plan.dispatchBelowMs)
        if (run !== this.current) return
        const request: SegmentRequest = { ...target, seq: plan.seq, voice: plan.voice, ...segment }
        if (!await this.receive(run, this.ports.synthesize(request, run.abort.signal), plan.sampleRate)) return
        // Counted only once the segment was received in full, so a failure leaves `next` at the failed segment.
        next++
      }
    } catch (error) {
      if (run !== this.current) return
      const { kind, passing } = failureOf(error)
      failure = kind
      if (plan !== undefined && passing) this.kept = { target, plan, next }
    }
    await this.end(run, failure)
  }

  private async audition(run: Run, sample: SampleTarget): Promise<void> {
    let failure: ReadingNotice | undefined
    try {
      const frames = this.ports.sample({ voice: sample.voice, language: sample.language }, run.abort.signal)
      if (!await this.receive(run, frames, sample.sampleRate)) return
    } catch (error) {
      if (run !== this.current) return
      failure = failureOf(error).kind
    }
    await this.end(run, failure)
  }

  /** Queue one stream's audio. @returns false once the run stopped while the stream was still arriving. */
  private async receive(run: Run, frames: AsyncIterable<AudioFrame>, sampleRate: number): Promise<boolean> {
    for await (const frame of frames) {
      if (run !== this.current) return false
      run.player.enqueue(samples(frame.pcm), sampleRate)
      this.audible(run)
    }
    return true
  }

  /** Audio already received plays to its end before the run ends, also after a failure. */
  private async end(run: Run, failure: ReadingNotice | undefined): Promise<void> {
    run.closing = true
    await this.playedDownTo(run, 0)
    if (run === this.current) this.finish(run, failure)
  }

  /** Wait until at most `ms` of queued audio is unplayed, or until the run stops. */
  private async playedDownTo(run: Run, ms: number): Promise<void> {
    for (;;) {
      const excess = run.player.bufferedSeconds() * 1000 - ms
      if (run !== this.current || excess <= 0) return
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer)
          run.abort.signal.removeEventListener('abort', wake)
          resolve()
        }
        const timer = setTimeout(wake, excess + SLACK_MS)
        run.abort.signal.addEventListener('abort', wake, { once: true })
      })
    }
  }

  /** Audio was queued: the run is audible until the queue runs out while more audio is still expected. */
  private audible(run: Run): void {
    this.phase(run, 'playing')
    clearTimeout(run.drain)
    const check = (): void => {
      if (run !== this.current || run.closing === true) return
      const left = run.player.bufferedSeconds() * 1000
      if (left <= 0) this.phase(run, 'loading')
      else run.drain = setTimeout(check, left + SLACK_MS)
    }
    run.drain = setTimeout(check, run.player.bufferedSeconds() * 1000 + SLACK_MS)
  }

  private phase(run: Run, phase: 'loading' | 'playing'): void {
    const state = this.state.getSnapshot()
    if (run.subject.kind === 'message') {
      if (state.reading?.phase !== phase) this.state.set({ ...state, reading: { ...run.subject.target, phase } })
    } else if (state.sample?.phase !== phase) {
      this.state.set({ ...state, sample: { voice: run.subject.voice, phase } })
    }
  }
}
