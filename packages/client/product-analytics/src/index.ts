/** Desktop-only analytics RPC and live compaction collection. */
import { type Context, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-host-product-telemetry-otel'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type { ProductEvent } from './events.ts'

/** Application-owned collection policy; no user settings surface. */
export interface Config {
  /** Live application collection policy; ordinary Web does not mount this service. */
  enabled: Volatile<boolean>
  /** Running Desktop release, absent when unavailable. */
  appVersion?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    productAnalytics: ProductAnalytics
  }
}

/** Authenticated event intake; disabled instances do not inspect identity or accept new events. */
export default class ProductAnalytics extends TypertRemoteService {
  static inject = ['deepseekAccount', 'productTelemetry']
  static Config = z.object({ enabled: z.boolean().default(true).volatile(), appVersion: z.string() })
  private active = true
  private readonly listeners = new Set<() => void>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'productAnalytics')
    ctx.effect(() => () => { this.active = false; for (const listener of this.listeners) listener() })
    ctx.on('loader/volatile-update', () => { for (const listener of this.listeners) listener() })
    ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'compaction/start') return
      void this.report({ eventName: 'context_compression', timestamp: Date.now(),
        attributes: { session_id: session.id, trigger_type: event.data.turn === null ? 'manual' : 'auto' } })
    })
  }

  /**
   * Read the collection policy.
   * @returns whether this Host currently accepts Desktop analytics.
   */
  @Remote
  enabled(): boolean { return this.active && this.config.enabled.get() }

  /**
   * Stream the effective policy initially and after live configuration edits.
   * @param signal - subscriber lifetime.
   * @returns current policy values until cancellation or service disposal.
   */
  @Remote({ mode: 'stream' })
  async *watchPolicy(signal: AbortSignal): AsyncIterable<boolean> {
    let update = Promise.withResolvers<void>()
    const changed = (): void => { update.resolve() }
    this.listeners.add(changed)
    signal.addEventListener('abort', changed, { once: true })
    try {
      while (this.active && !signal.aborted) {
        yield this.enabled()
        await update.promise
        update = Promise.withResolvers<void>()
      }
    } finally {
      this.listeners.delete(changed)
      signal.removeEventListener('abort', changed)
    }
  }

  /**
   * Submit selected Desktop fields; missing identity is omitted and never generated.
   * @param event - typed product event without message contents or credentials.
   * @returns after local submission; no delivery or warehouse acknowledgement.
   */
  @Remote
  async report(event: ProductEvent): Promise<void> {
    if (!this.enabled()) return
    try {
      const identity = await this.ctx.deepseekAccount.getDeviceIdentity().catch(() => undefined)
      if (!this.enabled()) return
      this.ctx.productTelemetry.emit({
        ...event, body: event.eventName,
        attributes: {
          ...event.attributes,
          ...identity?.deviceId === undefined ? {} : { device_id: identity.deviceId },
          ...identity?.userId === undefined ? {} : { user_id: identity.userId },
          ...this.config.appVersion === undefined ? {} : { app_version: this.config.appVersion },
          ...identity === undefined ? {} : { os_version: identity.osVersion },
        },
      })
    } catch (error) {
      this.ctx.logger.warn('Product analytics submission failed', error)
    }
  }
}
