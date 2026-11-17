/** Host `pluginEvents` Remote service: an authenticated baseline-and-increment stream of graph and rebuild changes. */
import type { Context } from '@deepseek-ai/cordis'
import { Deque } from '@deepseek-ai/dsh-deque'
import { principalOf, Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Principal } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-modules'
import type { PluginsEventFrame, PluginsEventIncrement } from './types.ts'

/** Ordered increments of one stream generation; closing wakes the waiting reader. */
class Follower {
  private readonly frames = new Deque<PluginsEventIncrement>()
  private wake: (() => void) | undefined
  closed = false

  /** @param principal - the calling Peer's principal; undefined for the owner. */
  constructor(readonly principal: Principal | undefined) {}

  push(frame: PluginsEventIncrement): void {
    this.frames.pushBack(frame)
    this.wake?.()
  }

  close(): void {
    this.closed = true
    this.wake?.()
  }

  /** @returns the oldest queued increment, if any. */
  take(): PluginsEventIncrement | undefined {
    return this.frames.popFront()
  }

  /** @returns a promise settled by the next push or close. */
  wait(): Promise<void> {
    return new Promise<void>((resolve) => { this.wake = resolve })
  }
}

/**
 * Streams start from the current graph; listeners attach before the baseline is read. Every Peer the Remote access
 * policies admit may follow; each frame carries the graph as that Peer may see it, so only the owner receives configured
 * synced values and every other Peer receives schema defaults.
 */
export class PluginEvents extends TypertRemoteService {
  static inject = ['clientModules']

  private readonly followers = new Set<Follower>()

  /** @param ctx - Host context with the Web client graph. */
  constructor(ctx: Context) {
    super(ctx, 'pluginEvents', { namespace: 'pluginEvents' })
    ctx.effect(() => {
      const offGraph = ctx.clientModules.onGraphChanged(() => { this.publishGraph() })
      const offRebuilt = ctx.clientModules.onRebuilt((id, rev) => { this.publish({ type: 'rebuilt', id, rev }) })
      return () => {
        offGraph()
        offRebuilt()
        for (const follower of this.followers) follower.close()
        this.followers.clear()
      }
    }, 'client-hmr: plugin event followers')
  }

  /**
   * Follow Web client graph and rebuild changes; every generation starts with a complete baseline.
   * @param signal - generation cancellation.
   * @returns the baseline followed by ordered increments; the stream ends when the service unloads.
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<PluginsEventFrame> {
    signal.throwIfAborted()
    const follower = new Follower(principalOf(this.ctx.invocation))
    this.followers.add(follower)
    const abort = (): void => { follower.close() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      yield { type: 'baseline', graph: this.ctx.clientModules.graphFor(follower.principal) }
      // The increments are yielded from this generator itself, with no delegated generator adding a step before each
      // reaches the Gateway's write queue.
      while (!follower.closed) {
        const frame = follower.take()
        if (frame !== undefined) yield frame
        else await follower.wait()
      }
    } finally {
      signal.removeEventListener('abort', abort)
      this.followers.delete(follower)
      follower.close()
    }
  }

  private publish(frame: PluginsEventIncrement): void {
    for (const follower of this.followers) follower.push(frame)
  }

  private publishGraph(): void {
    for (const follower of this.followers) follower.push({ type: 'graph', graph: this.ctx.clientModules.graphFor(follower.principal) })
  }
}

export default PluginEvents
