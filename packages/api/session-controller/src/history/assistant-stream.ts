/** Assistant stream baselines and per-connection subscriptions. */

import type { Context } from '@deepseek-ai/cordis'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { SessionAssistantStreamAccumulator } from '../assistant-stream.ts'
import type { SessionAssistantStreamBaseline, SessionAssistantStreamFrame } from '../types.ts'
import { ListenerBuffer } from './listener.ts'

/** One accumulator per live Session, shared by every subscription bound to it. */
export class SessionAssistantStreamsListener {
  private readonly streams = new Map<SessionId, SessionAssistantStreamAccumulator>()

  /** @param ctx - service context owning the accumulator listeners. */
  constructor(private readonly ctx: Context) {
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      let stream = this.streams.get(agent.session.id)
      if (stream === undefined) {
        stream = new SessionAssistantStreamAccumulator()
        this.streams.set(agent.session.id, stream)
      }
      stream.accept(frame, agent.session.seq === 0 ? -1 : SessionSeq(agent.session.seq - 1))
    }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => { this.streams.delete(agent.session.id) }, { global: true })
    ctx.effect(() => () => { this.streams.clear() }, 'session-controller.assistant-streams')
  }

  /**
   * Bind one connection to a Session assistant stream.
   * @param sessionId - Session to subscribe.
   * @param signal - cancellation owned by the caller.
   * @param queue - caller-owned raw notification buffer.
   * @returns a listener the caller disposes.
   */
  bind(sessionId: SessionId, signal: AbortSignal,
    queue: Pick<ListenerBuffer<AssistantEntry>, 'createInput' | 'capture'>): AssistantStreamListener {
    return new AssistantStreamListener(this.ctx, sessionId, signal, () => {
      return this.streams.get(sessionId)?.snapshot() ?? { revision: 0 }
    }, queue)
  }
}

type AssistantEntry = { type: 'assistant-stream'; frame: SessionAssistantStreamFrame }

/** An assistant notification and its connection-local arrival position. */
interface AssistantItem {
  readonly type: 'assistant-stream'
  readonly session: Session
  readonly frame: SessionAssistantStreamFrame
  readonly ordinal: number
}

/** Writes assistant notifications into the connection's shared queue. */
class AssistantStreamListener implements Disposable {
  private readonly disposes: (() => void)[] = []
  private ordinal = 0
  private cut = 0

  constructor(
    ctx: Context,
    sessionId: SessionId,
    signal: AbortSignal,
    private _snapshot: () => SessionAssistantStreamBaseline,
    output: Pick<ListenerBuffer<AssistantEntry>, 'createInput' | 'capture'>) {
    signal.throwIfAborted()
    const input = output.createInput<AssistantItem>(item => this.transform(item))
    try {
      this.disposes.push(ctx.on('agent/assistant-stream', ({ agent, frame }) => {
        if (agent.session.id !== sessionId) return
        output.capture(() => {
          const wire: SessionAssistantStreamFrame = frame.type === 'start'
            ? { ...frame, startedAfterSeq: agent.session.seq === 0 ? -1 : SessionSeq(agent.session.seq - 1) }
            : frame.type === 'chunk' ? { ...frame, chunk: frame.chunk as JsonValue } : frame
          input.append({ type: 'assistant-stream', session: agent.session, frame: wire, ordinal: ++this.ordinal })
        })
      }, { global: true }))
    } catch (error: unknown) {
      this[Symbol.dispose]()
      throw error
    }
  }

  /** @returns the baseline and local arrival cut captured synchronously together. */
  snapshot(): { baseline: SessionAssistantStreamBaseline; ordinal: number } {
    return { baseline: this._snapshot(), ordinal: this.ordinal }
  }

  /** @param ordinal - local snapshot cut set before queue consumption. */
  setOrdinalCut(ordinal: number): void {
    this.cut = ordinal
  }

  private *transform(item: AssistantItem): Iterable<AssistantEntry> {
    if (this.disposes.length === 0 || item.ordinal <= this.cut) return
    yield { type: 'assistant-stream', frame: item.frame }
  }

  [Symbol.dispose](): void {
    for (const dispose of this.disposes.splice(0).reverse()) dispose()
  }
}
