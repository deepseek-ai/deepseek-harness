/** Desktop renderer analytics sender; browser applications have no collection capability. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
export type {} from '@deepseek-ai/dsh-client-product-analytics/remote'
import type { ProductEvent, ProductEventMap } from '../events.ts'
export type { ProductEvent, ProductEventMap, TrackProductEvent } from '../events.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    productAnalytics: DesktopAnalytics
  }
}

class DesktopAnalytics extends Service {
  private collecting = false
  // RPC dispatch stays in the provider context when Cordis traces a consumer call.
  private readonly submit: (event: ProductEvent) => Promise<void>

  constructor(ctx: Context) {
    super(ctx, 'productAnalytics')
    this.submit = async (event) => {
      try { await ctx.remote.productAnalytics.report(event) } catch (_error) {
        // Missing or disconnected Remote services must not interrupt the interaction.
      }
    }
    if (!('dshDesktop' in globalThis)) return
    const stream = ctx.remote.$stream<boolean>({
      name: 'product analytics policy', open: signal => ctx.remote.productAnalytics.watchPolicy(signal),
      ended: () => new Error('product analytics policy stream ended'),
      carrierFailed: () => { this.collecting = false },
    })
    ctx.effect(() => () => { this.collecting = false; return stream.dispose() })
    void (async () => {
      for await (const frame of stream) { this.collecting = frame.value; frame.accept() }
    })().catch(() => { this.collecting = false })
  }

  /** Whether the synchronized Host configuration currently permits collection. */
  get enabled(): boolean {
    return this.collecting
  }

  /**
   * Send an event without retaining it for reconnect or later enablement.
   * @param name - event name.
   * @param attributes - approved business fields.
   * @param timestamp - occurrence time; defaults to the current time.
   */
  track<K extends keyof ProductEventMap>(name: K, attributes: ProductEventMap[K], timestamp = Date.now()): void {
    if (!this.enabled) return
    const event = { eventName: name, attributes, timestamp } as ProductEvent
    void this.submit(event)
  }
}

/** Analytics consumes authenticated RPC and its reconnecting policy stream. */
export const inject = ['remote', 'remote.productAnalytics']

/** @param ctx - browser application context. */
export function apply(ctx: Context): void { ctx.plugin(DesktopAnalytics) }
