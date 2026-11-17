/** Test-owned Remote face: `$on` subscriptions with an explicit test event driver, and reconnecting streams. */
import type { Context } from '@deepseek-ai/cordis'
import { RemoteStream, type RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import type { ConnectionGeneration, ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

// Value re-export for spec-side failure construction: the api-remotes facade
// cannot carry it — its src top-level imports owner /remote lib artifacts, so a
// value import from a spec would load the unbuilt assembly chain.
export { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Remote service test double for the forwarded-event path. Feature specs need
 * `ctx.remote.$on` to exist (their plugins inject `remote`) and need forwarded
 * Host events to reach those subscribers, but not the wire — so this double
 * implements subscription plus an explicit `emit` driver available only on the
 * concrete test object. A spec that also calls one namespace scripts it through
 * the constructor rather than reaching the real Client Remote service.
 * `$stream` wraps a scripted stream method in the production `RemoteStream`
 * over one Host generation that never changes.
 *
 * `$mount` rejects: a spec that needs a real generated contribution installed —
 * codecs, descriptors, and the wire — has outgrown this double and needs the
 * real Client Remote service.
 *
 * One deliberate asymmetry with production: a throwing listener propagates out
 * of the emit instead of being contained and logged, so a spec cannot lean on
 * this double for the containment guarantee `$on` documents — assert that
 * against the real service.
 */
export class TestRemote {
  private readonly subscriptions = new Map<string, Set<(...args: never[]) => void>>()
  /** One always-available Host generation; the double never loses or replaces its carrier. */
  private readonly connection: Pick<ConnectionHandle, 'generation'> = {
    generation: createSnapshotStore<ConnectionGeneration | undefined>({ id: 1, host: { home: '/home/fixture' } }),
  }

  /**
   * Fixed Host facts mirrored from the production `ctx.remote.$host`. Plain
   * mutable field: a spec assigns it to script a non-loopback or homed Host.
   */
  $host: { home: string | undefined; isLoopback: boolean } = { home: undefined, isLoopback: true }

  /**
   * Register the double as `ctx.remote`, plus one service per scripted
   * namespace so a plugin injecting `remote.<name>` also unparks.
   * @param ctx - the spec's root Context.
   * @param namespaces - scripted namespace faces reached as `ctx.remote.<name>`.
   */
  constructor(private readonly ctx: Context, namespaces: Readonly<Record<string, object>> = {}) {
    this.validateNamespaces(namespaces)
    ctx.provide('remote', this)
    this.installNamespaces(namespaces)
  }

  /**
   * Add scripted namespace faces to this Remote service.
   * @param namespaces - scripted namespace faces reached as `ctx.remote.<name>`.
   */
  provideNamespaces(namespaces: Readonly<Record<string, object>>): void {
    this.validateNamespaces(namespaces)
    this.installNamespaces(namespaces)
  }

  private validateNamespaces(namespaces: Readonly<Record<string, object>>): void {
    for (const name of Object.keys(namespaces)) {
      // A namespace named after one of the double's own members would replace
      // it, and `$mount`'s rejection is the contract a spec relies on.
      if (name in this) {
        throw new TypeError(`TestRemote: scripted namespace "${name}" would shadow the double's own member`)
      }
    }
  }

  private installNamespaces(namespaces: Readonly<Record<string, object>>): void {
    Object.assign(this, namespaces)
    for (const [name, face] of Object.entries(namespaces)) this.ctx.provide(`remote.${name}`, face)
  }

  /**
   * Deliver one forwarded host event to its subscribers, standing in for the
   * carrier that owns the frame sink.
   * @param event - forwarded host event name.
   * @param args - the Host argument list, verbatim.
   */
  emit(event: string, args: readonly unknown[]): void {
    const listeners = this.subscriptions.get(event)
    if (listeners === undefined) return
    for (const listener of [...listeners]) listener(...args as never[])
  }

  /**
   * Subscribe to one forwarded host event.
   * @param event - forwarded host event name.
   * @param listener - receives the Host argument list verbatim.
   * @returns disposer removing this subscription.
   */
  $on(event: string, listener: (...args: never[]) => void): () => void {
    const listeners = this.subscriptions.get(event) ?? new Set()
    this.subscriptions.set(event, listeners)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  /**
   * Open one production `RemoteStream` over the double's always-available Host generation, so a plugin's stream
   * lifecycle runs against a scripted namespace method.
   * @param options - domain stream opener, end classification, and diagnostics.
   * @returns the single-consumer reconnecting stream.
   */
  $stream<Item>(options: RemoteStreamOptions<Item>): RemoteStream<Item> {
    return new RemoteStream(this.connection, options)
  }

  /**
   * Generated-namespace mount, unsupported by this double.
   * @returns never; always rejects.
   */
  $mount(): Promise<() => Promise<void>> {
    return Promise.reject(new Error('TestRemote: $mount needs the real Client Remote service'))
  }
}
