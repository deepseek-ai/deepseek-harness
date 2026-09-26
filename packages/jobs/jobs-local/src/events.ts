/**
 * Event routing for the local registry: subscriptions file by filter, and
 * every commit dispatches once to each matching listener with containment.
 * @module @deepseek-ai/dsh-jobs-local/events
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AnonymousEntries, ScopedLayers, scopeOf } from '@deepseek-ai/dsh-scope'
import type { ScopeLayer } from '@deepseek-ai/dsh-scope'
import type { JobEvent, JobEventFilter, JobEventListener } from '@deepseek-ai/dsh-jobs'

/** One registered listener and the filter it declared. */
interface Subscription {
  filter: JobEventFilter
  listener: JobEventListener
}

/**
 * One scope's contributions: the job controllers attached from it and the
 * `{ owners: 'scope' }` subscriptions registered there. Both tables are
 * anonymous because a contribution is identified by its own disposer, never
 * by a name a second registrant could shadow.
 */
export class JobLayer implements ScopeLayer {
  /** Tokens of the job controllers attached from this scope. */
  readonly controllers = new AnonymousEntries<symbol>()
  /** The `{ owners: 'scope' }` subscriptions registered from this scope. */
  readonly scoped = new AnonymousEntries<Subscription>()

  isEmpty(): boolean {
    return this.controllers.isEmpty() && this.scoped.isEmpty()
  }
}

/**
 * Routes events to subscriptions. `{ owner }` and `{ owners: 'all' }`
 * subscriptions are evaluated against every event regardless of where they
 * were registered; `{ owners: 'scope' }` subscriptions file into the
 * registering context's scope layer and receive the owners composed under it
 * — the global layer, reached from an unscoped context, receives every owner.
 */
export class JobEventHub {
  private readonly unscoped = new Set<Subscription>()

  /**
   * @param layers - the scope-layer table shared with the controller handshake.
   * @param warn - sink for a listener's contained failure.
   */
  constructor(
    private readonly layers: ScopedLayers<JobLayer>,
    private readonly warn: (message: string) => void,
  ) {}

  /**
   * Register one listener as an effect of `ctx`.
   * @param ctx - the subscribing context; owns the effect and, for `'scope'`, names the scope.
   * @param filter - which owners' events to deliver.
   * @param listener - receives each matching event.
   * @returns disposer that unregisters the listener.
   */
  subscribe(ctx: Context, filter: JobEventFilter, listener: JobEventListener): () => void {
    const subscription: Subscription = { filter, listener }
    if ('owners' in filter && filter.owners === 'scope') {
      return this.layers.effect(ctx, layer => layer.scoped.append(subscription), { label: 'jobs.events.subscribe()' })
    }
    const dispose = ctx.effect(() => {
      this.unscoped.add(subscription)
      return () => { this.unscoped.delete(subscription) }
    }, 'jobs.events.subscribe()')
    // oxlint-disable-next-line typescript/no-misused-promises -- exact synchronous disposer preserves Cordis effect identity
    return dispose
  }

  /**
   * Deliver one event to every matching subscription, containing each
   * listener so an observer cannot break the commit already made.
   * @param event - the event to deliver.
   * @param owner - the job's exact owner, or undefined for unowned work.
   */
  emit(event: JobEvent, owner: Agent | undefined): void {
    const ownerId = owner?.id
    for (const subscription of this.unscoped) {
      const { filter } = subscription
      if ('owner' in filter && ownerId !== undefined && ownerId !== filter.owner) continue
      this.deliver(subscription, event)
    }
    for (const subscription of this.layers.global.scoped.values()) this.deliver(subscription, event)
    const scope = owner === undefined ? undefined : scopeOf(owner.ctx)
    for (const layer of this.layers.chainLayers(scope)) {
      for (const subscription of layer.scoped.values()) this.deliver(subscription, event)
    }
  }

  private deliver(subscription: Subscription, event: JobEvent): void {
    try {
      subscription.listener(event)
    } catch (error: unknown) {
      this.warn(`jobs: event listener threw on ${event.type}: ${String(error)}`)
    }
  }
}
