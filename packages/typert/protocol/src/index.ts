/**
 * Remote decorators and explicit Gateway bindings backed by versioned
 * descriptors carried on decorated class prototypes. Strict reflection
 * remains a Typert compiler responsibility.
 * @module @deepseek-ai/dsh-typert-protocol
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  RemoteWireArgs,
  TypertContextMap,
  TypertResourceReader,
  TypertResourceReaders,
} from './types.ts'

export { RemoteError, remoteErrorOf } from './remote-error.ts'
export { TYPERT_OWNED_VALUE, isTypertOwnedValue, typertOwnedValue } from './owned-value.ts'
export type { TypertOwnedValue } from './owned-value.ts'
export { isRemoteJsonValue, isRemoteUplinkItem } from './json-value.ts'
export { createTypertRemoteInfo, isTypertRemoteMethod } from './remote-info.ts'
export { principalOf } from './principal.ts'
export type { RemoteAccessResource, RemoteAccessResourceKind, RemoteAccessResourceOf } from './remote-access.ts'

const TYPERT_REMOTE_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/**
 * Test one generated Remote name against the Connection endpoint grammar.
 * @param value - namespace, method, lookup, or Context segment.
 * @returns whether the value can cross the shared RPC carrier unchanged.
 */
export function isTypertRemoteSegment(value: string): boolean {
  return value !== '.' && value !== '..' && TYPERT_REMOTE_SEGMENT_PATTERN.test(value)
}

export type {
  InvocationDescriptor,
  InvocationParameterDescriptor,
  InvocationSourceLocation,
  PeerId,
  PeerScope,
  Principal,
  PrincipalMap,
  RemoteDecoded,
  RemoteErrorCode,
  RemoteErrorDetailsMap,
  RemoteFailure,
  RemoteInvocation,
  RemoteResult,
  RemoteStream,
  RemoteStreamHandle,
  RemoteUplinkWindow,
  RemoteWireArgs,
  RemoteWireValue,
  TypertClientEventListener,
  TypertClientRemote,
  TypertClientContextAdapter,
  TypertCodec,
  TypertContext,
  TypertContextMap,
  TypertContextRegistry,
  TypertContextWire,
  TypertDisposer,
  TypertForwardableEvent,
  TypertForwardableEventEntry,
  TypertHostContextAdapter,
  TypertHostContextResolver,
  TypertResource,
  TypertResourceDeclaration,
  TypertResourceEntry,
  TypertResourceId,
  TypertResourceKind,
  TypertResourceMap,
  TypertResourceReader,
  TypertResourceReaders,
  TypertResourceRegistry,
  TypertResourceResolveInput,
  TypertLocalRegistry,
  TypertLookup,
  TypertLookupDefinition,
  TypertLookupHost,
  TypertLookupMap,
  TypertLookupProvider,
  TypertLookupResolver,
  TypertLookupRegistry,
  TypertLookupWire,
  TypertRemoteScopeApi,
  TypertRemoteScopeMap,
  TypertRemoteScopeNamespace,
  TypertRemoteContribution,
  TypertRemoteInfo,
  TypertRemoteInputOptions,
  TypertRemoteMethod,
  TypertRemoteValue,
  TypertRemoteCodecSpec,
  TypertRemoteParameterSpec,
  TypertRemoteMethodSpec,
  TypertRemoteSpec,
  TypertRemoteEvent,
  TypertRemoteEventSelection,
  TypertRemoteMap,
  TypertRemoteNamespace,
  TypertRemoteNamespaceMap,
  TypertRemoteRegistry,
  TypertRegistryChange,
  TypertRegistryListener,
  TypertSchema,
  TypertRegistryContract,
} from './types.ts'

/** Options for an explicit Service-to-Gateway binding. */
export interface TypertGatewayBindingOptions {
  /** Wire namespace; defaults to the Cordis service key. */
  readonly namespace?: string
}

/** Visible declaration that one Service participates in Typert Gateway export. */
export interface TypertGatewayBinding<Service extends object = object> {
  readonly service: Service
  readonly serviceKey: string
  readonly namespace: string
}

/** Invocation mode recorded by a Remote method decorator. */
export type RemoteInvocationMarker =
  | { readonly kind: 'direct' }
  | { readonly kind: 'context'; readonly context: string }

/** One decorator marker discovered for a live Service instance. */
export interface RemoteMethodMarker {
  /** Public instance method carrying the implementation. */
  readonly method: string
  /** Endpoint method when it differs from the implementation member. */
  readonly exportName?: string
  /** Stream methods yield many independently validated result items. */
  readonly mode?: 'stream'
  readonly invocation: RemoteInvocationMarker
  /**
   * Declared `resources` readers keyed by resource kind. Callers spread the
   * method's wire arguments into each one and validate its result.
   */
  readonly resources?: Readonly<Record<string, TypertResourceReader>>
}

/**
 * Explicit endpoint and resource choices for one Remote Scope method.
 * @template WireArgs - the decorated method's positional parameters as the
 *   wire carries them; the default `never` admits readers of any tuple.
 */
export interface RemoteScopeOptions<WireArgs extends readonly unknown[] = never> {
  /** Exported endpoint method; omission retains the implementation member name. */
  readonly name?: string
  /**
   * Per-kind readers of the resources one call touches. Each receives the
   * method's arguments as its own parameters, JSON arguments as their Typert
   * codecs validated them, a lookup parameter as its wire identity and a
   * cancellation parameter as the call's signal, so it performs plain reads
   * only, and returns one identity, several, or `undefined` for none. A
   * throw, an empty list, or an identity other than a non-empty string
   * refuses the call. For a kind without a reader, the Gateway reads the
   * identity of a scoped Context whose Host adapter declares that `resource`
   * and of lookup parameters declaring it, else the registered default of
   * `typert.resources`: a `resolve` function receiving the validated named
   * wire values and their ordered parameters, or a `field` naming a top-level
   * argument or, failing that, a field of the first object argument. A
   * throwing resolver, an array result, or a field holding an array refuses
   * the call. A call that carries no identity touches `global`. The readers
   * and these defaults together must name every resource the method accesses:
   * access control never checks a resource they omit.
   */
  readonly resources?: TypertResourceReaders<WireArgs>
}

/**
 * Explicit endpoint, stream, and resource choices for one direct Remote method.
 * @template WireArgs - the decorated method's positional parameters as the
 *   wire carries them; the default `never` admits readers of any tuple.
 */
export interface RemoteMethodOptions<WireArgs extends readonly unknown[] = never> extends RemoteScopeOptions<WireArgs> {
  /** `stream`: deliver each Iterable item over the shared logical-stream carrier. */
  readonly mode?: 'stream'
}

/** A decorator whose `resources` readers were checked against the decorated method's parameters. */
type RemoteTypedMethodDecorator<This extends object, Args extends unknown[], Result> = (
  method: (this: This, ...args: Args) => Result,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
) => void

type RemoteMethodDecorator = <This extends object, Args extends unknown[], Result>(
  method: (this: This, ...args: Args) => Result,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
) => void

interface RemoteInitializerContext<This extends object> {
  readonly private: boolean
  readonly static: boolean
  readonly name: string | symbol
  addInitializer(initializer: (this: This) => void): void
}

interface StoredRemoteMethodMarker {
  readonly exportName?: string
  readonly mode?: 'stream'
  readonly invocation: RemoteInvocationMarker
  readonly resources?: Readonly<Record<string, TypertResourceReader>>
}

/** Marker fields selected by decorator arguments. */
interface RemoteMarkerOptions {
  readonly mode?: 'stream'
  readonly exportName?: string
  readonly resources?: Readonly<Record<string, TypertResourceReader>>
}

interface StoredRemoteMethod extends StoredRemoteMethodMarker {
  readonly method: string
}

interface RemoteMethodDescriptorV1 {
  readonly version: 1
  readonly methods: readonly StoredRemoteMethod[]
}

const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/**
 * Bind one visible Service field to a Cordis key and Remote namespace. A
 * service that owns a Cordis Context also gives its tree `ctx.invocation`,
 * `undefined` outside a Remote call, so no `TypertRemoteService` is needed for
 * a Host composition to read it.
 * @param service - owning Service instance, normally `this`.
 * @param serviceKey - exact Cordis service key.
 * @param options - optional wire namespace.
 * @returns a frozen, inspectable binding with no compiler-injected metadata.
 */
export function bindTypertRemote<Service extends object>(
  service: Service,
  serviceKey: string,
  options: TypertGatewayBindingOptions = {},
): TypertGatewayBinding<Service> {
  validateName('service key', serviceKey)
  const namespace = options.namespace ?? serviceKey
  validateName('namespace', namespace)
  const ctx: unknown = Reflect.get(service, 'ctx')
  if (Context.is(ctx)) provideInvocationAccessor(ctx)
  return Object.freeze({ service, serviceKey, namespace })
}

/** Cordis Service base that exposes its registered name through Typert Gateway. */
export abstract class TypertRemoteService<out T = never> extends Service<T> {
  /** Visible binding consumed by the Gateway's source-mode discovery. */
  readonly typertRemote: TypertGatewayBinding<this>

  /**
   * Register the Service and bind the same key to Typert Gateway.
   * @param ctx - owning Cordis Context.
   * @param serviceKey - exact Cordis service key and default wire namespace.
   * @param options - optional wire namespace.
   */
  protected constructor(ctx: Context, serviceKey: string, options: TypertGatewayBindingOptions = {}) {
    super(ctx, serviceKey)
    this.typertRemote = bindTypertRemote(this, this.name, options)
  }
}

/**
 * Make `ctx.invocation` read as `undefined` outside a Remote call instead of the
 * reflect service's "cannot get property" error; a call-derived Context shadows
 * the accessor with its own property. The first Remote Service constructed in a
 * tree registers it on the root, where it outlives any one Service.
 */
function provideInvocationAccessor(ctx: Context): void {
  if (Object.hasOwn(ctx.root.reflect.props, 'invocation')) return
  ctx.root.accessor('invocation', { get: () => undefined })
}

/**
 * Mark one public instance method as a direct Remote invocation.
 * @param _method - decorated method; retained only by the class itself.
 * @param context - standard decorator context used to schedule private marking.
 */
export function Remote<This extends object, Args extends unknown[], Result>(
  _method: (this: This, ...args: Args) => Result,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
): void
/**
 * Mark one public instance method with an endpoint name.
 * @param name - exported endpoint method.
 * @returns a standard method decorator.
 */
export function Remote(name: string): RemoteMethodDecorator
/**
 * Mark one public instance method with endpoint, stream, or resource options.
 * @param options - Remote options; each reader's parameters are inferred from the decorated method.
 * @returns a standard method decorator.
 */
export function Remote<This extends object, Args extends unknown[], Result>(
  options: NoInfer<RemoteMethodOptions<RemoteWireArgs<Args>>>,
): RemoteTypedMethodDecorator<This, Args, Result>
export function Remote<This extends object, Args extends unknown[], Result>(
  methodExportOrOptions: string | RemoteMethodOptions | ((this: This, ...args: Args) => Result),
  context?: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
): void | RemoteMethodDecorator {
  if (typeof methodExportOrOptions === 'string') {
    validateName('Remote export name', methodExportOrOptions)
    return remoteDecorator({ kind: 'direct' }, { exportName: methodExportOrOptions })
  }
  if (typeof methodExportOrOptions === 'object') {
    return remoteDecorator({ kind: 'direct' }, markerOptions(
      methodExportOrOptions,
      REMOTE_OPTION_KEYS,
      'Remote options require name, mode: "stream", or resources',
    ))
  }
  if (context === undefined) throw new TypeError('typert-protocol: Remote decorator context is missing')
  addMarkerInitializer(context, { kind: 'direct' })
}

const REMOTE_OPTION_KEYS: ReadonlySet<string> = new Set(['name', 'mode', 'resources'])
const REMOTE_SCOPE_OPTION_KEYS: ReadonlySet<string> = new Set(['name', 'resources'])

/** Validate one decorator options object against its accepted keys and select the marker fields. */
function markerOptions(options: RemoteMethodOptions, accepted: ReadonlySet<string>, requirement: string): RemoteMarkerOptions {
  const keys = Reflect.ownKeys(options)
  if (keys.length === 0 || keys.some(key => typeof key !== 'string' || !accepted.has(key))
    || (Object.hasOwn(options, 'mode') && options.mode !== 'stream')) {
    throw new TypeError(`typert-protocol: ${requirement}`)
  }
  const { mode, name, resources } = options
  if (name !== undefined) validateName('Remote export name', name)
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(name === undefined ? {} : { exportName: name }),
    ...(resources === undefined ? {} : { resources: resourceReaders(resources) }),
  }
}

/** Freeze declared readers into the marker record; a misdeclared reader fails at decoration. */
function resourceReaders(resources: object): Readonly<Record<string, TypertResourceReader>> {
  const readers: Record<string, TypertResourceReader> = {}
  for (const [kind, reader] of Object.entries(resources as Readonly<Record<string, unknown>>)) {
    if (typeof reader !== 'function') {
      throw new TypeError(`typert-protocol: Remote resource reader "${kind}" must be a function`)
    }
    readers[kind] = reader as TypertResourceReader
  }
  if (Object.keys(readers).length === 0) throw new TypeError('typert-protocol: Remote resources require at least one reader')
  return Object.freeze(readers)
}

function remoteDecorator(
  invocation: RemoteInvocationMarker,
  options: RemoteMarkerOptions = {},
): RemoteMethodDecorator {
  return function <This extends object, Args extends unknown[], Result>(
    _method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void {
    addMarkerInitializer(context, invocation, options)
  }
}

/**
 * Create a decorator for a method resolved from one Remote Scope.
 * @param key - scope key declared through the Context map.
 * @param name - optional Remote export name; defaults to the method name.
 * @returns a standard method decorator that records a versioned prototype descriptor.
 */
export function RemoteScope(key: Extract<keyof TypertContextMap, string>, name?: string): RemoteMethodDecorator
/**
 * Create a decorator for a Remote Scope method with endpoint or resource options.
 * @param key - scope key declared through the Context map.
 * @param options - Remote Scope options; each reader's parameters are inferred from the decorated method.
 * @returns a standard method decorator that records a versioned prototype descriptor.
 */
export function RemoteScope<This extends object, Args extends unknown[], Result>(
  key: Extract<keyof TypertContextMap, string>,
  options: NoInfer<RemoteScopeOptions<RemoteWireArgs<Args>>>,
): RemoteTypedMethodDecorator<This, Args, Result>
export function RemoteScope(
  key: Extract<keyof TypertContextMap, string>,
  option?: string | RemoteScopeOptions,
): RemoteMethodDecorator {
  validateName('Scope key', key)
  const invocation: RemoteInvocationMarker = { kind: 'context', context: key }
  if (option === undefined) return remoteDecorator(invocation)
  if (typeof option === 'string') {
    validateName('Remote export name', option)
    return remoteDecorator(invocation, { exportName: option })
  }
  return remoteDecorator(invocation, markerOptions(
    option,
    REMOTE_SCOPE_OPTION_KEYS,
    'RemoteScope options require name or resources',
  ))
}

/**
 * Read Remote markers attached to a live Service's class prototype.
 * The returned snapshot cannot mutate the stored descriptor.
 * @param service - live Service instance.
 * @returns markers in class declaration order.
 */
export function remoteMethods(service: object): readonly RemoteMethodMarker[] {
  const prototype = Object.getPrototypeOf(service) as object | null
  if (prototype === null) return []
  return (readRemoteMethodDescriptor(prototype)?.methods ?? []).map(marker => ({ ...marker }))
}

function readRemoteMethodDescriptor(prototype: object): RemoteMethodDescriptorV1 | undefined {
  const property = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR)
  if (property === undefined) return undefined
  const descriptor: unknown = property.value
  if (descriptor === null || typeof descriptor !== 'object') {
    throw new TypeError('typert-protocol: Remote method descriptor must be an object')
  }
  const version: unknown = Reflect.get(descriptor, 'version')
  if (version !== 1) {
    throw new TypeError(`typert-protocol: unsupported Remote method descriptor version ${String(version)}`)
  }
  const methods: unknown = Reflect.get(descriptor, 'methods')
  if (!Array.isArray(methods)) {
    throw new TypeError('typert-protocol: Remote method descriptor methods must be an array')
  }
  return descriptor as RemoteMethodDescriptorV1
}

function addMarkerInitializer<This extends object>(
  context: RemoteInitializerContext<This>,
  invocation: RemoteInvocationMarker,
  options: RemoteMarkerOptions = {},
): void {
  if (context.private || context.static || typeof context.name !== 'string') {
    throw new TypeError('typert-protocol: Remote decorators require a public instance method with a string name')
  }
  const method = context.name
  context.addInitializer(function (this: This) {
    const prototype = Object.getPrototypeOf(this) as object | null
    if (prototype === null) {
      throw new TypeError(`typert-protocol: cannot mark Remote method "${method}" on an object without a prototype`)
    }
    mark(prototype, method, invocation, options)
  })
}

function mark(
  prototype: object,
  method: string,
  invocation: RemoteInvocationMarker,
  { mode, exportName, resources }: RemoteMarkerOptions,
): void {
  const descriptor = readRemoteMethodDescriptor(prototype)
  const marker: StoredRemoteMethod = Object.freeze({
    method,
    ...(exportName === undefined || exportName === method ? {} : { exportName }),
    ...(mode === undefined ? {} : { mode }),
    invocation: Object.freeze(invocation),
    ...(resources === undefined ? {} : { resources }),
  })
  const current = descriptor?.methods.find(candidate => candidate.method === method)
  if (current !== undefined) {
    // One decorator application owns one frozen reader record, so identity marks the same declaration.
    if (current.exportName === marker.exportName
      && current.mode === marker.mode
      && current.resources === marker.resources
      && sameInvocation(current.invocation, invocation)) return
    throw new Error(`typert-protocol: Remote method "${method}" has conflicting invocation markers`)
  }
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze([...(descriptor?.methods ?? []), marker]),
    } satisfies RemoteMethodDescriptorV1),
  })
}

function sameInvocation(left: RemoteInvocationMarker, right: RemoteInvocationMarker): boolean {
  if (left.kind === 'direct') return right.kind === 'direct'
  if (right.kind === 'direct') return false
  return left.context === right.context
}

function validateName(subject: string, value: string): void {
  if (!isTypertRemoteSegment(value)) {
    throw new TypeError(`typert-protocol: ${subject} must contain only RPC endpoint segment characters`)
  }
}
