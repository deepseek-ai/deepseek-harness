/** One reconnecting window hold, shared by all occurrences of a terminal. */
import type { ClientRemote, RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TerminalRetentionFrame, WebTerminalId } from '../types.ts'
import type { TerminalRemote } from './model.ts'

/** A stream acknowledgement gates output attachment for each physical connection. */
export class TerminalWindowHold {
  private readonly stream: RemoteStream<TerminalRetentionFrame>
  private readonly waiters = new Set<{ resolve: () => void; reject: (error: unknown) => void }>()
  private generation: AbortSignal | undefined
  private failure: Error | undefined

  /**
   * @param gateway - reconnecting stream owner.
   * @param remote - typed terminal namespace.
   * @param sessionId - saved layout's Session, without Agent activation.
   * @param id - existing Host terminal.
   */
  constructor(gateway: Pick<ClientRemote, '$stream'>, remote: TerminalRemote, sessionId: SessionId, id: WebTerminalId) {
    this.stream = gateway.$stream<TerminalRetentionFrame>({
      name: 'Browser terminal window hold',
      open: signal => remote.retain(sessionId, id, signal),
      ended: () => new RemoteError('terminal/unavailable', 'Terminal hold ended', {}),
    })
    void this.consume()
  }

  /** Whether a terminal-domain failure ended this hold, allowing an explicit retry. */
  get failed(): boolean { return this.failure !== undefined }

  /**
   * Wait for an acknowledged current physical hold before following its screen.
   * @param signal - output request or view lifetime.
   * @returns after acknowledgement, or rejects on cancellation/unavailability.
   */
  async ready(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.failure !== undefined) throw this.failure
    if (this.generation !== undefined && !this.generation.aborted) return
    const waiting = Promise.withResolvers<void>()
    const abort = (): void => { waiting.reject(signal.reason) }
    this.waiters.add(waiting)
    signal.addEventListener('abort', abort, { once: true })
    try { await waiting.promise }
    finally { this.waiters.delete(waiting); signal.removeEventListener('abort', abort) }
  }

  /**
   * Release this window's stream and all acknowledgement waiters.
   * @returns after the stream consumer closes.
   */
  dispose(): Promise<void> {
    this.reject(new Error('Terminal window hold released'))
    return this.stream.dispose()
  }

  private async consume(): Promise<void> {
    try {
      for await (const item of this.stream) {
        item.accept()
        this.generation = item.signal
        for (const waiter of this.waiters) waiter.resolve()
        this.waiters.clear()
      }
    } catch (error) { this.reject(error) }
  }

  private reject(error: unknown): void {
    this.failure = error instanceof Error ? error : new Error('Terminal window hold failed', { cause: error })
    this.generation = undefined
    for (const waiter of this.waiters) waiter.reject(error)
    this.waiters.clear()
  }
}
