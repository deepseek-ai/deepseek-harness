/**
 * Compiler-independent Typert protocol shared by business packages, generated
 * Remote artifacts, the Host Gateway, and Client API implementations.
 * @module @deepseek-ai/dsh-typert-protocol/types
 */

import type { Context, Events } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ZodType } from 'zod'
import type { TypertOwnedValue } from './owned-value.ts'

declare const LOOKUP_HOST: unique symbol
declare const LOOKUP_WIRE: unique symbol
declare const CONTEXT_WIRE: unique symbol
declare const RESOURCE_ID: unique symbol

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

/** Type-level association between a resource kind and its identity type. */
export interface TypertResource<Id> {
  readonly [RESOURCE_ID]: Id
}

/** Extract the identity type associated with one resource declaration. */
export type TypertResourceId<Resource> = Resource extends TypertResource<infer Id> ? Id : never

/**
 * Merge-extensible resource kinds whose identities a Remote call or forwarded
 * event may carry. The package that owns an identity type declares its kind;
 * the value is that kind's identity type, a string type such as a branded id.
 * `global` names the built-in identity-less resource and is never a kind here.
 */
export interface TypertResourceMap {}

/** One declared resource kind. */
export type TypertResourceKind = Extract<keyof TypertResourceMap, string>

/**
 * Per-kind resource readers called with one argument tuple spread
 * positionally: plain reads returning one identity, several, or `undefined`
 * for none.
 * @template Args - the argument tuple the readers receive as parameters.
 */
export type TypertResourceReaders<Args extends readonly unknown[]> = {
  readonly [Kind in TypertResourceKind]?: (...args: Args) =>
    | TypertResourceId<TypertResourceMap[Kind]>
    | readonly TypertResourceId<TypertResourceMap[Kind]>[]
    | undefined
}

/**
 * Type-erased resource reader as runtime carriers store it; callers spread
 * the argument tuple into it and validate its result. Declared through a
 * method so a reader typed by its own parameters is assignable without a cast.
 */
export type TypertResourceReader = { read(...args: readonly unknown[]): unknown }['read']

type TypertLookupEntry = TypertLookupMap[keyof TypertLookupMap]
type TypertWireForHost<Value, Entry> = Entry extends unknown
  ? Value extends TypertLookupHost<Entry> ? TypertLookupWire<Entry> : never
  : never

/** A method parameter as it arrives on the wire: a lookup's Host object becomes its wire identity. */
export type RemoteWireValue<Value> = Value extends TypertLookupHost<TypertLookupEntry>
  ? TypertWireForHost<Value, TypertLookupEntry>
  : Value

/** A method's positional parameters as the wire carries them. */
export type RemoteWireArgs<Args extends unknown[]> = { [Index in keyof Args]: RemoteWireValue<Args[Index]> }

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

declare const STREAM_UPLINK: unique symbol

/**
 * One Remote stream as a Host method returns it: the items it yields to the
 * Client, iterated as a plain `AsyncIterable<Out>`. `In` is the type of the
 * items the Client may send back on the same logical stream, read through
 * `RemoteInvocation.uplink()`; it is carried only as a type-level marker. The
 * default `never` declares a method that reads none, and its descriptor
 * carries no uplink codec. A generated Client stream method returns the same
 * stream as a `RemoteStreamHandle<Out, In>`.
 * @template Out - item type the Host method yields.
 * @template In - item type the Client may send; `never` when the method reads none.
 */
export type RemoteStream<Out, In = never> = AsyncIterable<Out> & { readonly [STREAM_UPLINK]?: In }

/**
 * One open Remote stream as the Client holds it: the downlink items as an
 * `AsyncIterable`, plus the uplink and cancellation of the same logical
 * stream. A generated Client stream method returns it, and calling that
 * method opens the stream: a holder that neither iterates nor disposes the
 * handle keeps the Host stream alive. A handle stands for one generation:
 * when the carrier is lost, iteration fails with the carrier error and the
 * handle is finished.
 * @template Out - item type the Host method yields.
 * @template In - item type the Client may send; `never` when the method reads none.
 */
export interface RemoteStreamHandle<Out, In> extends AsyncIterable<Out> {
  /**
   * Send one uplink item. Items sent before the stream has opened are queued
   * and sent once the `open` frame is on the wire. A top-level `undefined`
   * travels as an `item` frame without `value`.
   * @param item - item the Host validates against the method's uplink codec.
   * @throws {Error} when the item is not a lossless JSON value, when `end()`
   * was called, or once the stream has terminated.
   */
  send(item: In): void
  /** Half-close the uplink: the Host's `uplink()` iteration ends. Idempotent; ignored after termination. */
  end(): void
  /**
   * Cancel the logical stream: send `cancel` unless a terminal frame has
   * arrived, and end the downlink iterator quietly. Breaking out of
   * `for await` early does the same.
   */
  dispose(): void
}

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

/**
 * Event and dispatch mode accepted by the Remote Event source. An `emit` entry
 * may declare readers of the resources its payload carries; an
 * entry without `resources` touches the built-in `global` resource. A
 * non-owner Peer receives an `emit` notification only after an access
 * decision and never receives a `waterfall`.
 */
export type TypertForwardableEventEntry = {
  [Event in keyof Events]: TypertForwardingMode<Event> extends infer Mode
    ? Mode extends 'emit'
      ? {
        readonly event: Event
        readonly mode: Mode
        readonly resources?: TypertResourceReaders<TypertEventParameters<Event>>
      }
      : Mode extends 'waterfall'
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

/** Native byte views reconstructed by a Remote carrier have ordinary ArrayBuffer backing. */
export type RemoteDecoded<Value> = Value extends Uint8Array ? Uint8Array<ArrayBuffer>
  : Value extends string | number | boolean | bigint | symbol ? Value
    : Value extends object ? { [Key in keyof Value]: RemoteDecoded<Value[Key]> } : Value

/** Codec attached to one invocation parameter or result. */
export type TypertCodec<Value = unknown> =
  | TypertRemoteValue<Value> & {
    readonly mode: 'strict'
    readonly typeSymbol: string
    /**
     * Decode a unary result whose fields require type-specific handling.
     * @param value - result reconstructed by the RPC carrier.
     * @returns the validated result, retaining native byte views.
     */
    readonly decode?: ((value: unknown) => unknown) | undefined
    /**
     * Project typed binary fields into RPC result attachments.
     * @param value - native unary result.
     * @param writeBytes - records a byte view at its result-relative path and returns its JSON placeholder.
     * @returns JSON metadata with untouched JSON subtrees retained.
     */
    readonly encode?: ((value: unknown, writeBytes: (bytes: Uint8Array, path: readonly (string | number)[]) => null) => unknown) | undefined
  }
  | {
    readonly mode: 'src-json'
  }

/** One ordered business parameter in a Remote invocation. */
export interface InvocationParameterDescriptor {
  /** Source-level parameter name. */
  readonly name: string
  /** Source parameter documentation, independent of JSON Schema support. */
  readonly description?: string
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
  /** Absent for unary calls; stream calls deliver every yielded item as the Host produced it. */
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
  /**
   * Client-to-Host items of the same logical stream, generated from the `In`
   * type argument of the method's `RemoteStream<Out, In>` return type; absent
   * when `In` is `never`. The method reads the items through
   * `RemoteInvocation.uplink()`, so nothing enters the parameter list.
   */
  readonly uplink?: {
    /** Codec validating every uplink item before `uplink()` delivers it. */
    readonly codec: TypertCodec
  }
  /** Transport cancellation injected after business parameters instead of entering wire args. */
  readonly cancellation?: {
    /** Reserved final Host method parameter. */
    readonly parameter: 'signal'
  }
  /** Codec for the unary result or each yielded stream item. */
  readonly result: TypertCodec
  /** Source-owned method documentation; ordinary methods need not have JSDoc. */
  readonly description?: string
  /** Source declaration used only for diagnostics. */
  readonly sourceLocation?: InvocationSourceLocation
}

/**
 * Opaque identity of one Peer: a party admitted to this Host by the connection
 * layer. "Peer" is a connection-layer word; the browser application keeps the
 * word "Client".
 */
export type PeerId = Branded<'PeerId'>

/**
 * Merge-extensible caller identities. Each driver declares its own entry.
 * Every entry is a JSON value with a unique literal `kind`, carries no
 * credential, and is safe to persist in a Session log.
 */
export interface PrincipalMap {
  /** The local user who owns this Host. */
  owner: { readonly kind: 'owner' }
}

/** One caller identity; the authorization layer reads only this. */
export type Principal = PrincipalMap[keyof PrincipalMap]

/**
 * One Peer's session on this Host. Its creator owns it: `ctx` is the Cordis
 * scope that owns connection-lifetime registrations and is disposed with the
 * Peer, and `principal` is the caller identity fixed when the Peer was created.
 */
export interface PeerScope {
  readonly id: PeerId
  /** Connection-lifetime registrations; disposed with the Peer. */
  readonly ctx: Context
  /** Caller identity fixed at creation by in-process Host code; no wire field can set it. */
  readonly principal: Principal
  /** Aborted once the Peer is disposed; Remote streams that speak for the Peer end with it. */
  readonly signal: AbortSignal
  /** Whether the Peer may open a forwarded-event stream; this does not grant business permissions. */
  readonly interactions: 'answer' | 'none'
  /**
   * Tear down every registration made through `ctx`.
   * @returns settles once the scope has quiesced; racing calls share one completion.
   */
  dispose(): Promise<void>
}

/** Carrier capacity for buffered uplink frames of one logical stream. */
export interface RemoteUplinkWindow {
  /** Maximum complete encoded frame bytes waiting for the Host consumer. */
  readonly maxBytes: number
  /** UTF-8 envelope bytes added to a compact JSON item with a present value field. */
  readonly frameOverheadBytes: number
}

/**
 * The context of one Remote call, reachable inside the receiving method as
 * `this.ctx.invocation`. The Gateway derives the receiver from a Context that
 * carries it, so no parameter is injected and nothing crosses the wire.
 */
export interface RemoteInvocation {
  readonly request: {
    readonly namespace: string
    readonly method: string
    readonly args: Readonly<Record<string, unknown>>
  }
  /** Cordis service key of the receiving Service. */
  readonly service: string
  /** Peer the call speaks for; every carrier names it explicitly. */
  readonly peer: PeerScope
  /** Carrier cancellation: Client cancel, socket close, or an uplink failure. */
  readonly signal: AbortSignal
  /** Carrier frame capacity; absent when the carrier imposes no encoded-frame inbox limit. */
  readonly uplinkWindow?: RemoteUplinkWindow | undefined
  /**
   * The Client's uplink items for this call. Available once; a second call
   * throws. With an uplink codec on the descriptor every item is decoded to
   * `In`; without one items arrive as `unknown` after a JSON-safety check.
   * Iteration ends when the Client ends its uplink; when the method finishes
   * its downlink the Gateway calls the iterator's `return()` and unread items
   * are dropped. `In` is the caller's assertion: the runtime decodes by the
   * descriptor and does not cross-check it.
   * @template In - item type the caller reads; the descriptor codec decides what arrives.
   * @returns the single-consumer uplink iterable.
   */
  uplink<In = unknown>(): AsyncIterable<In>
}

/** Generated Host contract selected explicitly by a Client assembly. */
export interface TypertRemoteContribution {
  /** npm package that owns the Remote methods. */
  readonly package: string
  /** Consumer-side invocation descriptors generated from that package. */
  readonly descriptors: readonly InvocationDescriptor[]
}

/** Generated parser and optional lossless tool-schema projection of one Remote value. */
export interface TypertRemoteValue<Value = unknown> {
  /** Materialize the generated parser without loading the owning Service. */
  readonly create: () => TypertSchema<Value>
  /** Source-owned value documentation, independent of tool projection support. */
  readonly description?: string | undefined
  /** Present when the value is representable in the tool-schema subset without losing constraints; may be derived lazily. */
  readonly jsonSchema?: Readonly<Record<string, unknown>> | undefined
  /** Projection failure for consumers that require JSON Schema; parsing remains available. */
  readonly jsonSchemaError?: string | undefined
}

/** Consumer-owned input validation; never changes Host dispatch or the business method declaration. */
export interface TypertRemoteInputOptions {
  /** Reject undeclared fields in input objects; explicit dictionaries and JSON values remain open. */
  readonly strict?: boolean
}

/** A direct descriptor; DecodedOutput differs from its parser output only for carrier-reconstructed unary bytes. */
export type TypertRemoteMethod<Input extends object, Output, Mode extends 'unary' | 'stream' = 'unary', Uplink = never, DecodedOutput = Output> =
  Omit<InvocationDescriptor, 'mode' | 'invocation' | 'result'>
  & (Mode extends 'stream' ? { readonly mode: 'stream' } : { readonly mode?: never }) & {
    /** Named invocation selects a direct Service method, not a Context receiver. */
    readonly invocation: { readonly kind: 'direct' }
    /**
     * Select matching named-input parsing and tool-schema projection without changing dispatch.
     * @param options - consumer-owned strictness; omission preserves ordinary Remote object handling.
     * @returns the cached view for this policy; its parser and projection remain lazy.
     */
    input(options?: TypertRemoteInputOptions): TypertRemoteValue<Input>
    /** The descriptor's result or stream-item parser; parsing alone does not normalize native byte backing. */
    readonly result: Extract<TypertCodec<Output>, { readonly mode: 'strict' }>
    /**
     * Invoke the mounted namespace method with named wire arguments.
     * @param remote - caller-owned, unscoped Client Remote service; its mount owns availability.
     * @param input - decoded named wire arguments.
     * @param signal - caller-owned invocation lifetime.
     * @returns the carrier-decoded unary result or complete stream handle, including uplink and disposal.
     */
    invoke(remote: TypertClientRemote, input: Input, signal?: AbortSignal): Mode extends 'stream'
      ? RemoteStreamHandle<Output, Uplink>
      : Promise<RemoteResult<DecodedOutput>>
  }

/** Ordinary contribution whose method index references its direct invocation descriptors. */
export interface TypertRemoteInfo<Methods extends Readonly<Record<string,
  TypertRemoteMethod<object, unknown> | TypertRemoteMethod<object, unknown, 'stream', unknown>
>> = Readonly<Record<string, TypertRemoteMethod<object, unknown> | TypertRemoteMethod<object, unknown, 'stream', unknown>>>>
  extends TypertRemoteContribution {
  /** Exact generated keys and types; Context-only receivers are available only through descriptors. */
  readonly methods: Methods
}

/** Generated Zod factory and optional tool projection for one invocation value. */
export interface TypertRemoteCodecSpec extends Omit<Extract<TypertCodec, { readonly mode: 'strict' }>, 'create'> {
  /** Materialize the generated Zod schema only when a parser is requested. */
  readonly create: () => ZodType
}

/** One ordered parameter; omitted wire names resolve to the source parameter name. */
export interface TypertRemoteParameterSpec extends Omit<InvocationParameterDescriptor, 'wire' | 'codec'> {
  /** Explicit wire alias, notably for a Host lookup identity. */
  readonly wire?: string
  /** Ordinary Remote parser and projection for this parameter. */
  readonly codec: TypertRemoteCodecSpec
  /** Consumer-selected counterpart rejecting undeclared fields in explicit input objects. */
  readonly strictCodec: TypertRemoteCodecSpec
}

/** Static method facts; endpoint identity and named-call helpers are derived by the runtime factory. */
export interface TypertRemoteMethodSpec extends Omit<InvocationDescriptor, 'id' | 'namespace' | 'method' | 'parameters' | 'result'> {
  /** Ordered Host parameters, including their wire representations. */
  readonly parameters: readonly TypertRemoteParameterSpec[]
  /** Successful unary result or stream item, with optional native-byte handling. */
  readonly result: TypertRemoteCodecSpec
}

/** Compiler-produced method definitions, independent of services, registration, and transport. */
export interface TypertRemoteSpec {
  /** Package owning these methods. */
  readonly package: string
  /** Public endpoints; each method's invocation facts occur only once. */
  readonly methods: Readonly<Record<`${string}/${string}`, TypertRemoteMethodSpec>>
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

/** Resource kinds whose identity type is a wire identity; every kind for a type-erased provider. */
type TypertResourceKindFor<Wire> = unknown extends Wire
  ? TypertResourceKind
  : { [Kind in TypertResourceKind]: [Wire] extends [TypertResourceId<TypertResourceMap[Kind]>] ? Kind : never }[TypertResourceKind]

/** Runtime provider for one declared Host object lookup. */
export interface TypertLookupProvider<Host = unknown, Wire = unknown> {
  /** Source parameter name recognized by the SRC weak parser. */
  readonly parameter: string
  /** Wire field replacing the Host object parameter. */
  readonly wire: string
  /** Resource kind the wire identity names; a parameter of this lookup carries that resource. */
  readonly resource?: TypertResourceKindFor<Wire>
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
  /** Resource kind the wire identity names; a call scoped to this Context carries that resource. */
  readonly resource?: TypertResourceKindFor<Wire>
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
   * Resolve a validated identity synchronously for one Client invocation.
   * @param id - validated wire identity.
   * @returns a borrowed or invocation-owned Client Context, or undefined when unavailable.
   */
  resolve(id: Wire): Context | TypertOwnedValue<Context> | undefined
}

/** Notification emitted after a Typert runtime registry changes. */
export interface TypertRegistryChange {
  readonly kind: 'local' | 'remote' | 'lookup' | 'host-context' | 'client-context' | 'resource'
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
   * Look up a Host Context adapter; a configured resolver keeps the adapter's declaration and `resource`.
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

/** Validated wire values and their ordered business parameters for resource extraction. */
export interface TypertResourceResolveInput {
  /** Wire field to its validated value, including lookup and Context identities as wire values. */
  readonly args: Readonly<Record<string, unknown>>
  /** Declared parameters in call order, so a resolver can match a name or an aliased wire field. */
  readonly parameters: readonly Pick<InvocationParameterDescriptor, 'name' | 'wire'>[]
}

/** Default identity extraction for one resource kind; exactly one of `field` and `resolve` is declared. */
export type TypertResourceDeclaration =
  | {
    readonly field: string
    readonly resolve?: never
  }
  | {
    readonly field?: never
    /**
     * Called once before lookups resolve. It takes no receiver, so it reads only its
     * input. Returns one identity, or undefined when absent; throws or returns an
     * array to reject the call.
     */
    resolve(this: void, input: TypertResourceResolveInput): string | undefined
  }

/** One registered resource kind with its default identity extraction. */
export type TypertResourceEntry = TypertResourceDeclaration & {
  /** Resource kind contributed by its owning domain. */
  readonly kind: string
}

/** Runtime registry of resource kinds' default identity extraction. */
export interface TypertResourceRegistry {
  /**
   * Register one kind's default identity extraction for the calling fiber. Only the
   * domain that owns the kind registers it.
   * @param kind - merge-declared resource kind.
   * @param declaration - either a default wire field or a resolver, never both.
   * @returns disposer withdrawing the exact registration.
   * @throws Error when the kind is already registered or is `global`, the built-in resource kind.
   */
  register(kind: TypertResourceKind, declaration: TypertResourceDeclaration): TypertDisposer
  /**
   * Look up one kind's declaration.
   * @param kind - resource kind.
   * @returns the live declaration, or `undefined` when unregistered.
   */
  get(kind: string): TypertResourceDeclaration | undefined
  /** @returns a registration-order snapshot of registered kinds with their extraction declarations. */
  entries(): readonly TypertResourceEntry[]
  /**
   * Observe later resource-kind changes.
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
  readonly resources: TypertResourceRegistry
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    typert: TypertRegistryContract
    /**
     * The Remote call this Context was derived for, or `undefined` on a
     * Context no Remote call derived. A Service method reads it as
     * `this.ctx.invocation`.
     */
    readonly invocation: RemoteInvocation | undefined
  }
}
