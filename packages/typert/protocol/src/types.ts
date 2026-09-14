/**
 * Compiler-independent Typert protocol shared by business packages, generated
 * Remote artifacts, the Host Gateway, and Client API implementations.
 * @module @deepseek-ai/dsh-typert-protocol/types
 */

import type { Context, Events } from '@deepseek-ai/cordis'

declare const LOOKUP_HOST: unique symbol
declare const LOOKUP_WIRE: unique symbol
declare const CONTEXT_WIRE: unique symbol

/** Type-level association between a Host object and its wire identity. */
export interface TypertLookup<Host, Wire> {
  readonly [LOOKUP_HOST]: Host
  readonly [LOOKUP_WIRE]: Wire
}

/** Extract the Host object associated with one lookup declaration. */
export type TypertLookupHost<Lookup> = Lookup extends TypertLookup<infer Host, infer _Wire> ? Host : never

/** Extract the wire identity associated with one lookup declaration. */
export type TypertLookupWire<Lookup> = Lookup extends TypertLookup<infer _Host, infer Wire> ? Wire : never

/** Type-level association between a scoped Context kind and its wire identity. */
export interface TypertContext<Wire> {
  readonly [CONTEXT_WIRE]: Wire
}

/** Extract the wire identity associated with one scoped Context declaration. */
export type TypertContextWire<ContextType> = ContextType extends TypertContext<infer Wire> ? Wire : never

/** Merge-extensible Host object lookup declarations. */
export interface TypertLookupMap {}

/** Merge-extensible scoped Context declarations. */
export interface TypertContextMap {}

/** Merge-extensible direct Remote method signatures generated for consumers. */
export interface TypertRemoteMap {}

/**
 * Merge-extensible Remote failure vocabulary: this package declares the
 * universal carrier codes once; the Gateway merges its infrastructure codes
 * and every owner merges its domain codes next to the throwing code.
 */
export interface RemoteErrorDetailsMap {
  /** Owner-side business validation refused the request; `issues` carries codec output when one produced it. */
  'gateway/bad-request': { readonly issues?: readonly object[] }
  /** The call was cancelled by the carrier signal or the backend. */
  'gateway/cancelled': {}
  /** Carrier, dispatch, or unclassified Host failure. */
  'gateway/internal': {}
}

/** Every declared Remote failure code. */
export type RemoteErrorCode = keyof RemoteErrorDetailsMap

/**
 * One Remote call's failure: the code-discriminated union of RemoteError
 * instances, so a `code` branch narrows `details` with no cast.
 */
export type RemoteFailure = {
  [Code in RemoteErrorCode]: import('./remote-error.ts').RemoteError<Code>
}[RemoteErrorCode]

/**
 * What every generated Remote method resolves to. The Remote face itself folds
 * carrier failures into the error branch, so no consumer wraps a call to
 * recover one; only assembly faults (arity, an unmounted method, a missing
 * Context adapter) still reject.
 * @template T - the Host method's business result.
 */
export type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RemoteFailure }

/** Merge-extensible scoped Remote method signatures generated for consumers. */
export interface TypertRemoteScopeMap {}

type TypertEventParameters<Event extends keyof Events> =
  Events[Event] extends (...args: infer Args) => unknown ? Args : never

type TypertEventResult<Event extends keyof Events> =
  Events[Event] extends (...args: never[]) => infer Result ? Result : never

type TypertProjectedContextKey = Extract<keyof TypertLookupMap, keyof TypertContextMap>

type TypertProjectedContextSubject = {
  [Key in TypertProjectedContextKey]: TypertLookupHost<TypertLookupMap[Key]>
}[TypertProjectedContextKey]

type TypertAgentScopedRequest<Request> = Request extends object
  ? 'agent' extends keyof Request
    ? Exclude<Request['agent'], undefined> extends TypertProjectedContextSubject ? Request : never
    : never
  : never

type TypertWaterfallEvent<Event extends keyof Events> =
  unknown extends ThisParameterType<Events[Event]>
    ? never
    : TypertEventParameters<Event> extends [infer Request, infer Next]
      ? Next extends () => TypertEventResult<Event>
        ? TypertEventResult<Event> extends Promise<unknown>
          ? TypertAgentScopedRequest<Request> extends never ? never : Event
          : never
        : never
      : never

type TypertForwardingMode<Event extends keyof Events> =
  unknown extends ThisParameterType<Events[Event]>
    ? TypertEventResult<Event> extends void ? 'emit' : never
    : TypertWaterfallEvent<Event> extends never ? never : 'waterfall'

/**
 * Cordis event names the Remote Event carrier can preserve without a second
 * signature declaration: unscoped `void` notifications and scoped async
 * waterfalls whose final parameter is their same-result `next()` callback.
 */
export type TypertForwardableEvent = {
  [Event in keyof Events]: TypertForwardingMode<Event> extends never ? never : Event
}[keyof Events]

/** Event and dispatch mode accepted by the Remote Event source. */
export type TypertForwardableEventEntry = {
  [Event in keyof Events]: TypertForwardingMode<Event> extends infer Mode
    ? Mode extends 'emit' | 'waterfall'
      ? { readonly event: Event; readonly mode: Mode }
      : never
    : never
}[keyof Events]

/** Merge-extensible forwarding selection declared once by the Host assembly. */
export interface TypertRemoteEventSelection {}

/** Legal `$on` keys selected from the carrier-compatible Cordis event declarations. */
export type TypertRemoteEvent = Extract<TypertForwardableEvent, keyof TypertRemoteEventSelection>

type TypertClientAgent<Value> =
  Exclude<Value, undefined> extends TypertProjectedContextSubject
    ? Context | Extract<Value, undefined>
    : Value

type TypertClientEventRequest<Request> = Request extends object
  ? { [Key in keyof Request]: Key extends 'agent' ? TypertClientAgent<Request[Key]> : Request[Key] }
  : never

type TypertScopedClientEventListener<Event extends TypertRemoteEvent> =
  Events[Event] extends (request: infer Request, next: infer Next) => infer Result
    ? (
      this: Context,
      request: TypertClientEventRequest<Request>,
      next: Next,
    ) => Result
    : never

/**
 * Listener derived from one selected Cordis event declaration. Scoped Host
 * subjects become the resolved Client `Context`; one-way notifications retain
 * their declaration unchanged.
 * @template Event - selected Remote Event name.
 */
export type TypertClientEventListener<Event extends TypertRemoteEvent> =
  unknown extends ThisParameterType<Events[Event]>
    ? Events[Event]
    : TypertScopedClientEventListener<Event>

/**
 * Resolve one direct Remote namespace from the generated flat endpoint map.
 * @template Namespace - wire namespace before the endpoint slash.
 */
export type TypertRemoteNamespace<Namespace extends string> = {
  [Endpoint in keyof TypertRemoteMap as Endpoint extends `${Namespace}/${infer Method}`
    ? Method
    : never]: TypertRemoteMap[Endpoint]
}

/**
 * Resolve one scoped Remote namespace across every generated Context kind.
 * The calling Cordis Context supplies the concrete identity at runtime.
 * @template Namespace - wire namespace between the Context prefix and method.
 */
export type TypertRemoteScopeNamespace<
  Namespace extends string,
  ContextKey extends string = string,
> = {
  [Endpoint in keyof TypertRemoteScopeMap as Endpoint extends `${ContextKey}:${Namespace}/${infer Method}`
    ? Method
    : never]: TypertRemoteScopeMap[Endpoint]
}

type TypertRemoteScopeNamespaceKey<
  ContextKey extends string,
  Endpoint = keyof TypertRemoteScopeMap,
> = Endpoint extends `${ContextKey}:${infer Namespace}/${string}` ? Namespace : never

/** Generated scoped Remote namespaces available to one Context kind. */
export type TypertRemoteScopeApi<ContextKey extends string> = {
  [Namespace in TypertRemoteScopeNamespaceKey<ContextKey>]:
  TypertRemoteScopeNamespace<Namespace, ContextKey>
}

/** Merge-extensible direct namespace surface generated for Client Remote services. */
export interface TypertRemoteNamespaceMap {}

/** Awaitable disposer returned by Cordis-owned Typert registrations. */
export type TypertDisposer = () => Promise<void>

type StringKeyOf<Value> = Extract<keyof Value, string>

/** Minimal runtime-schema capability carried by strict generated codecs. */
export interface TypertSchema<Output = unknown> {
  /**
   * Parse and validate one boundary value.
   * @param value - untrusted boundary value.
   * @returns the validated value.
   */
  parse(value: unknown): Output
}

/** Codec attached to one invocation parameter or result. */
export type TypertCodec =
  | {
    readonly mode: 'strict'
    readonly typeSymbol: string
    readonly schema: TypertSchema
  }
  | {
    readonly mode: 'src-json'
  }

/** One ordered business parameter in a Remote invocation. */
export interface InvocationParameterDescriptor {
  /** Source-level parameter name. */
  readonly name: string
  /** Required key in the wire `args` object. */
  readonly wire: string
  /** Whether the value is JSON or requires a registered Host lookup. */
  readonly source: 'json' | 'lookup'
  /** Lookup key when `source` is `lookup`. */
  readonly lookup?: string
  /** Boundary codec for the wire representation. */
  readonly codec: TypertCodec
  /** Missing wire fields decode to `undefined` only for an explicitly declared `T | undefined`. */
  readonly acceptsUndefined?: true
}

/** Source position retained for diagnostics from generated definitions. */
export interface InvocationSourceLocation {
  readonly file: string
  readonly line: number
  readonly column: number
}

/** Carrier-independent description of one exported method invocation. */
export interface InvocationDescriptor {
  /** Globally stable generated identity. */
  readonly id: string
  /** Cordis service key owning the method. */
  readonly service: string
  /** Wire namespace, defaulting to the service key. */
  readonly namespace: string
  /** Public instance method name. */
  readonly method: string
  /** Service member invoked when the exported method name is an alias. */
  readonly implementation?: string
  /** Absent for unary calls; stream calls validate and deliver every yielded item. */
  readonly mode?: 'stream'
  /** Receiver selection mode. */
  readonly invocation:
    | { readonly kind: 'direct' }
    | {
      readonly kind: 'context'
      readonly context: string
      readonly wire: string
      readonly codec: TypertCodec
    }
  /** Optional consuming-Context projection for one direct lookup parameter. */
  readonly scope?: {
    /** Context kind whose Client adapter supplies the identity. */
    readonly context: string
    /** Lookup parameter wire field replaced by the Context identity. */
    readonly wire: string
  }
  /** Ordered business parameters. */
  readonly parameters: readonly InvocationParameterDescriptor[]
  /** Transport cancellation injected after business parameters instead of entering wire args. */
  readonly cancellation?: {
    /** Reserved final Host method parameter. */
    readonly parameter: 'signal'
  }
  /** Codec for the unary result or each yielded stream item. */
  readonly result: TypertCodec
  /** Source declaration used only for diagnostics. */
  readonly sourceLocation?: InvocationSourceLocation
}

/** Generated Host contract selected explicitly by a Client assembly. */
export interface TypertRemoteContribution {
  /** npm package that owns the Remote methods. */
  readonly package: string
  /** Consumer-side invocation descriptors generated from that package. */
  readonly descriptors: readonly InvocationDescriptor[]
}

/** Client Remote capability implemented by the Gateway and consumed by Remote assemblies. */
export interface TypertClientRemote extends TypertRemoteNamespaceMap {
  /**
   * Mount one generated Host-for-Client contribution in the caller's fiber.
   * @param contribution - explicitly selected Remote package artifact.
   * @returns disposer after namespace services and concrete methods are ready.
   */
  $mount(contribution: TypertRemoteContribution): Promise<TypertDisposer>
  /**
   * Subscribe to one forwarded Host event. Notifications run in registration
   * order and isolate failures; scoped waterfalls return, delegate through
   * `next()`, or reject the Host dispatch.
   * @template Event - forwarded event name selected by the Host assembly.
   * @param event - forwarded Host event name, unchanged on the wire.
   * @param listener - receives the Client projection of the Cordis `Events` declaration.
   * @returns disposer owned by the calling fiber.
   */
  $on<Event extends TypertRemoteEvent>(event: Event, listener: TypertClientEventListener<Event>): () => void
}

/**
 * Resolve one validated wire identity, synchronously or asynchronously.
 * @param id - validated wire identity.
 * @returns the Host object, or `undefined` when unavailable.
 */
export type TypertLookupResolver<Host = unknown, Wire = unknown> = (
  id: Wire,
) => Host | undefined | Promise<Host | undefined>

/** Runtime provider for one declared Host object lookup. */
export interface TypertLookupProvider<Host = unknown, Wire = unknown> {
  /** Source parameter name recognized by the SRC weak parser. */
  readonly parameter: string
  /** Wire field replacing the Host object parameter. */
  readonly wire: string
  /** Canonical Host type symbol used by strict generation. */
  readonly hostTypeSymbol: string
  /** Canonical wire type symbol used by strict generation. */
  readonly wireTypeSymbol: string
  /**
   * Resolve a wire identity through the provider's default policy.
   * @param id - validated wire identity.
   * @returns the object, `undefined` when unavailable, or either asynchronously.
   */
  resolve(id: Wire): Host | undefined | Promise<Host | undefined>
}

/** Stable wire declaration retained after a lookup provider unloads. */
export interface TypertLookupDefinition {
  /** Merge-declared lookup key. */
  readonly key: string
  /** Source parameter name recognized by the SRC weak parser. */
  readonly parameter: string
  /** Wire field replacing the Host object parameter. */
  readonly wire: string
  /** Canonical Host type symbol used by strict generation. */
  readonly hostTypeSymbol: string
  /** Canonical wire type symbol used by strict generation. */
  readonly wireTypeSymbol: string
}

/** Host wire-to-Context resolver plus the declaration used by strict Remote methods. */
export interface TypertHostContextAdapter<Wire = unknown> {
  /** Wire field carrying the Context identity. */
  readonly wire: string
  /** Canonical wire type symbol used by strict generation. */
  readonly wireTypeSymbol: string
  /**
   * Resolve a validated wire identity to a live Host Context.
   * @param id - validated wire identity.
   * @returns the Context, or `undefined` when it is unavailable.
   */
  resolve(id: Wire): Context | undefined | Promise<Context | undefined>
}

/** Composition-owned resolver replacing one Host Context adapter's default lookup policy. */
export type TypertHostContextResolver<Wire = unknown> = (
  id: Wire,
) => Context | undefined | Promise<Context | undefined>

/** Client-side bidirectional Context adapter. */
export interface TypertClientContextAdapter<Wire = unknown> {
  /**
   * Read the identity represented by a live Client Context.
   * @param ctx - Client Context inspected by a scoped Remote caller.
   * @returns the wire identity, or `undefined` for another Context kind.
   */
  identity(ctx: Context): Wire | undefined
  /**
   * Resolve a wire identity from the Client's currently materialized Contexts.
   * @param id - validated wire identity.
   * @returns the Client Context, or `undefined` when unavailable.
   */
  resolve(id: Wire): Context | undefined
}

/** Notification emitted after a Typert runtime registry changes. */
export interface TypertRegistryChange {
  readonly kind: 'local' | 'remote' | 'lookup' | 'host-context' | 'client-context'
  readonly key: string
}

/** Listener for one Typert runtime registry. */
export type TypertRegistryListener = (change: TypertRegistryChange) => void

/** Current-environment invocation definitions. */
export interface TypertLocalRegistry {
  /**
   * Look up one invocation by `<namespace>/<method>`.
   * @param endpoint - canonical endpoint.
   * @returns the live descriptor, or `undefined` when absent.
   */
  get(endpoint: string): InvocationDescriptor | undefined
  /**
   * Report whether a strict definition has existed during this Typert Service lifetime.
   * @param endpoint - canonical endpoint.
   * @returns `true` after the endpoint has been registered at least once, even if withdrawn.
   */
  hasSeen(endpoint: string): boolean
  /** @returns a registration-order snapshot of local descriptors. */
  list(): readonly InvocationDescriptor[]
  /**
   * Observe later local-definition changes.
   * @param listener - synchronous contained observer.
   * @returns disposer for this subscription.
   */
  subscribe(listener: TypertRegistryListener): TypertDisposer
}

/** Consumer-selected Remote contribution registry. */
export interface TypertRemoteRegistry {
  /**
   * Register one generated contribution for the calling Cordis fiber.
   * @param contribution - generated Remote descriptors.
   * @returns disposer withdrawing the exact contribution.
   */
  register(contribution: TypertRemoteContribution): TypertDisposer
  /**
   * Look up one Remote descriptor by endpoint.
   * @param endpoint - canonical endpoint.
   * @returns the descriptor, or `undefined` when unmounted.
   */
  get(endpoint: string): InvocationDescriptor | undefined
  /** @returns a registration-order snapshot of Remote descriptors. */
  list(): readonly InvocationDescriptor[]
  /**
   * Observe later Remote contribution changes.
   * @param listener - synchronous contained observer.
   * @returns disposer for this subscription.
   */
  subscribe(listener: TypertRegistryListener): TypertDisposer
}

/** Runtime registry for Host object lookup providers. */
export interface TypertLookupRegistry {
  /**
   * Register one provider under its merge-declared key.
   * @param key - lookup key.
   * @param provider - owning package's live resolver.
   * @returns disposer withdrawing the exact provider.
   */
  register<K extends StringKeyOf<TypertLookupMap>>(
    key: K,
    provider: TypertLookupProvider<
      TypertLookupHost<TypertLookupMap[K]>,
      TypertLookupWire<TypertLookupMap[K]>
    >,
  ): TypertDisposer
  /**
   * Replace one provider's default resolution policy while this contribution is active.
   * Configuration may precede provider registration; without a live provider, `get()` remains unavailable.
   * @param key - lookup key whose wire declaration remains provider-owned.
   * @param resolver - composition-owned resolver used by every lookup of this key.
   * @returns disposer restoring the provider's default resolver.
   */
  configure<K extends StringKeyOf<TypertLookupMap>>(
    key: K,
    resolver: TypertLookupResolver<
      TypertLookupHost<TypertLookupMap[K]>,
      TypertLookupWire<TypertLookupMap[K]>
    >,
  ): TypertDisposer
  /**
   * Look up one provider by runtime key.
   * @param key - descriptor lookup key.
   * @returns the live provider, or `undefined` when absent.
   */
  get(key: string): TypertLookupProvider | undefined
  /** @returns lookup declarations observed during this Typert Service lifetime. */
  definitions(): readonly TypertLookupDefinition[]
  /** @returns a snapshot of registered provider keys. */
  keys(): readonly string[]
  /**
   * Observe later lookup changes.
   * @param listener - synchronous contained observer.
   * @returns disposer for this subscription.
   */
  subscribe(listener: TypertRegistryListener): TypertDisposer
}

/** Runtime registry for the Host and Client adapters of each Context kind. */
export interface TypertContextRegistry {
  /**
   * Register a Host Context adapter.
   * @param key - merge-declared Context key.
   * @param adapter - owning package's Host resolver and wire declaration.
   * @returns disposer withdrawing the exact adapter.
   */
  registerHost<K extends StringKeyOf<TypertContextMap>>(
    key: K,
    adapter: TypertHostContextAdapter<TypertContextWire<TypertContextMap[K]>>,
  ): TypertDisposer
  /**
   * Override one Host Context key's resolution policy for the calling fiber.
   * Configuration may precede provider registration and restores the provider's default resolver on disposal.
   * @param key - merge-declared Context key.
   * @param resolver - composition-owned resolver used by every Host Context lookup of this key.
   * @returns disposer restoring the provider's default resolver.
   */
  configureHost<K extends StringKeyOf<TypertContextMap>>(
    key: K,
    resolver: TypertHostContextResolver<TypertContextWire<TypertContextMap[K]>>,
  ): TypertDisposer
  /**
   * Register a Client Context adapter.
   * @param key - merge-declared Context key.
   * @param adapter - owning package's bidirectional Client projection.
   * @returns disposer withdrawing the exact adapter.
   */
  registerClient<K extends StringKeyOf<TypertContextMap>>(
    key: K,
    adapter: TypertClientContextAdapter<TypertContextWire<TypertContextMap[K]>>,
  ): TypertDisposer
  /**
   * Look up a Host Context adapter.
   * @param key - descriptor Context key.
   * @returns the adapter, or `undefined` when absent.
   */
  getHost(key: string): TypertHostContextAdapter | undefined
  /**
   * Look up a Client Context adapter.
   * @param key - descriptor Context key.
   * @returns the adapter, or `undefined` when absent.
   */
  getClient(key: string): TypertClientContextAdapter | undefined
  /**
   * Observe later Context adapter changes.
   * @param listener - synchronous contained observer.
   * @returns disposer for this subscription.
   */
  subscribe(listener: TypertRegistryListener): TypertDisposer
}

/** Minimal Typert runtime consumed through dependency inversion. */
export interface TypertRegistryContract {
  readonly local: TypertLocalRegistry
  readonly remotes: TypertRemoteRegistry
  readonly lookups: TypertLookupRegistry
  readonly contexts: TypertContextRegistry
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    typert: TypertRegistryContract
  }
}
