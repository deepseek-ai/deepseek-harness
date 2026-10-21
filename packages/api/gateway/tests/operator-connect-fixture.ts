/** Loader-mounted Remote methods and interactions for authenticated transport tests. */
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { TypertRemoteEventDispatch, TypertRemoteEventOutcome } from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-typert-registry'

interface CallObservation {
  readonly peer: PeerScope
  readonly signal: AbortSignal
  finished: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    operatorConnectFixture: OperatorConnectFixture
  }
}

/** Test producer; credentials, admission, dispatch and disposal use the real plugins. */
export default class OperatorConnectFixture extends TypertRemoteService {
  static inject = ['typert', 'typertGateway', 'connection']
  readonly calls = new Map<string, CallObservation>()
  readonly effects = new Set<string>()
  readonly holds = new Map<string, () => void>()
  readonly streamCleanup = Promise.withResolvers<undefined>()
  delayStreamCleanup = false
  private readonly dispatches: TypertRemoteEventDispatch[] = []
  private wake: (() => void) | undefined

  constructor(ctx: Context) {
    super(ctx, 'operatorConnectFixture', { namespace: 'fixture' })
    ctx.effect(() => ctx.typertGateway.registerRemoteEvents(signal => this.events(signal), { home: '/home/fixture' }))
  }

  /** Record the authenticated caller and its scope. */
  @Remote
  identity(label: string, signal: AbortSignal): object {
    const call = this.observe(label, signal)
    call.finished = true
    return { peerId: call.peer.id, interactions: call.peer.interactions }
  }

  /** Hold an independently cancellable HTTP request until the test completes it. */
  @Remote
  async hold(label: string, signal: AbortSignal): Promise<string> {
    const call = this.observe(label, signal)
    const finish = Promise.withResolvers<undefined>()
    const complete = (): void => { finish.resolve(undefined) }
    this.holds.set(label, complete)
    signal.addEventListener('abort', complete, { once: true })
    try {
      if (!signal.aborted) await finish.promise
      return signal.aborted ? 'cancelled' : 'completed'
    } finally {
      signal.removeEventListener('abort', complete)
      this.holds.delete(label)
      call.finished = true
    }
  }

  /** Keep a stream open, optionally delaying its iterator cleanup after carrier loss. */
  @Remote({ mode: 'stream' })
  async *follow(label: string, signal: AbortSignal): AsyncIterable<string> {
    const call = this.observe(label, signal)
    try {
      yield `${label}:ready`
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    } finally {
      if (this.delayStreamCleanup) await this.streamCleanup.promise
      call.finished = true
    }
  }

  /**
   * Enqueue an interaction without introducing Agent or model dependencies.
   * @param label - prompt observed by the answering Client.
   * @returns producer settlement, left pending while no Client answers.
   */
  pending(label: string): Promise<TypertRemoteEventOutcome> {
    const settled = Promise.withResolvers<TypertRemoteEventOutcome>()
    void settled.promise.catch(() => {})
    const subject = { ctx: this.ctx }
    this.dispatches.push({
      event: 'fixture/approval', request: { agent: subject, prompt: label },
      context: { value: this.ctx, subject, agentId: `agent-${label}` },
      resolve: settled.resolve, reject: settled.reject,
    })
    this.wake?.()
    this.wake = undefined
    return settled.promise
  }

  private observe(label: string, signal: AbortSignal): CallObservation {
    const invocation = this.ctx.invocation
    if (invocation === undefined) throw new Error('fixture method ran outside Gateway invocation')
    const call: CallObservation = { peer: invocation.peer, signal, finished: false }
    this.calls.set(label, call)
    invocation.peer.ctx.effect(() => {
      this.effects.add(label)
      return () => { this.effects.delete(label) }
    })
    return call
  }

  private async *events(signal: AbortSignal): AsyncIterable<TypertRemoteEventDispatch> {
    const wake = (): void => { this.wake?.(); this.wake = undefined }
    signal.addEventListener('abort', wake, { once: true })
    try {
      while (!signal.aborted) {
        const next = this.dispatches.shift()
        if (next !== undefined) yield next
        else await new Promise<void>((resolve) => { this.wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', wake)
    }
  }
}
