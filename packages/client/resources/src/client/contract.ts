/**
 * The resource model's published face.
 *
 * A resource is one address, and a resource address is a
 * `dsh-resource://<type>/…` URL: the host names the protocol. The protocol's
 * owning client package registers one {@link ResourceProvider} that turns an
 * address into a frame stream, and any slot component reads that stream through
 * {@link UseResource}. A protocol that needs a scope (a session, a workspace)
 * encodes it in the path, as `dsh-resource://file/session/<sessionId>/<absolute
 * path>` does; the model itself knows only addresses. Addresses under any other
 * scheme (`sidebar://guide`) are navigation addresses and name no resource.
 * `ResourceProtocolMap` (declared
 * in ui-slots) is the declaration-merged roster of protocol to value type, so a
 * consumer names the protocol as a type argument and receives the owner's value
 * type without importing the owner's runtime.
 */
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ResourceProtocolMap } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {
    /** Live value of one address, resolved through the provider registered for its protocol. */
    useResource: UseResource
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Resource model: protocol providers, pins, and per-address live sources. */
    resources: Resources
  }
}

/** Every protocol some client package has declared. */
export type ResourceProtocol = Extract<keyof ResourceProtocolMap, string>

/**
 * Where one resource stands. `none`: no provider is registered for the
 * address's protocol, or the address is not a resource address. `loading`: a provider is open and has not yielded yet.
 * `live`: `value` is the latest `ok` frame's value. `failed`: the latest frame
 * reported a failure.
 */
export type ResourceStatus = 'none' | 'loading' | 'live' | 'failed'

/** One address's current state, as `useResource` returns it. */
export interface ResourceSnapshot<Value> {
  readonly status: ResourceStatus
  /** The latest `ok` frame's value; kept through a later failure frame, absent before the first. */
  readonly value: Value | undefined
  /** The latest frame's failure; present only while `status` is `failed`. */
  readonly failure: RemoteFailure | undefined
}

/**
 * Global standard hook: the current state of one address, typed by the
 * protocol named as the type argument. Present on every slot component's
 * props, whatever its scope.
 */
export type UseResource = <P extends ResourceProtocol>(
  address: string,
) => ResourceSnapshot<ResourceProtocolMap[P]>

/** What a provider's `open` receives beside the address. */
export interface ResourceOpenContext {
  /** Aborted when the last subscriber or pin releases the resource; the stream must end. */
  readonly signal: AbortSignal
}

/** One protocol's provider, registered through `ctx.resources.register`. */
export interface ResourceProvider<P extends ResourceProtocol> {
  /** The URL scheme this provider serves. */
  readonly protocol: P
  /**
   * Open one frame stream for an address. The first frame is the current
   * content and every later frame one change. An `ok` frame replaces the value;
   * a failure frame marks the resource `failed` with its error and keeps the
   * last value. Ending the stream keeps the last state. A failure is always a
   * frame: a throw inside the stream is a programming error and is not caught.
   * @param address - the full address, a `dsh-resource://<type>/…` URL.
   * @param ctx - the stream's abort signal.
   * @returns the frame stream; it must stop once `ctx.signal` aborts.
   */
  open(address: string, ctx: ResourceOpenContext): AsyncIterable<RemoteResult<ResourceProtocolMap[P]>>
}

/**
 * The `ctx.resources` service. One resource is one address; it stays open
 * while at least one `source` subscriber or one pin holds it, and the
 * provider's stream is aborted and the state discarded when the last holder
 * releases.
 */
export interface Resources {
  /**
   * Register the provider for one protocol for the caller's lifetime.
   * @param provider - the protocol's provider.
   * @returns idempotent disposer, held inside the caller's own `ctx.effect`.
   * @throws when the protocol already has a provider.
   */
  register<P extends ResourceProtocol>(provider: ResourceProvider<P>): () => void
  /**
   * Hold one resource open without subscribing to it.
   * @param address - the full address, a `dsh-resource://<type>/…` URL.
   * @param signal - aborting it releases the pin; an already-aborted signal pins nothing.
   */
  pin(address: string, signal: AbortSignal): void
  /**
   * The live source of one resource. Reference-stable for one address while
   * the resource is held; the first subscriber or pin opens the provider's
   * stream, and a subscriber arriving later reads the latest value at once.
   * @param address - the full address, a `dsh-resource://<type>/…` URL.
   * @returns the observable state; `getSnapshot` reads without holding the resource.
   */
  source(address: string): ObservableSnapshot<ResourceSnapshot<unknown>>
}
