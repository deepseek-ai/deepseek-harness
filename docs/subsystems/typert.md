# Typert remote calls

English | [中文](typert.zh.md)

Types shared by generated Remote artifacts, the Host Gateway, and consumer API assemblies. The [Typert Gateway Agent Note](../../.agents/notes/implemented/architecture/2026-08-02-typert-remote-method-calls.md) owns the architecture and transport decisions; this page records the literal public contracts from [`dsh-typert-protocol`](../../packages/typert/protocol/src/types.ts) and [`dsh-api-gateway`](../../packages/api/gateway/src/types.ts).

## Lookup and Context declarations

Business-object packages extend two empty maps through declaration merging. A lookup associates one Host object type with its wire identity; a Context declaration associates one scoped Context kind with its wire identity. Generated descriptors name these keys, while runtime providers supply the live resolution behavior.

```ts type-equiv
/** Merge-extensible Host object lookup declarations. */
interface TypertLookupMap {}
```

```ts type-equiv
/** Merge-extensible scoped Context declarations. */
interface TypertContextMap {}
```

The registry retains a lookup's wire declaration after its resolver unloads. SRC discovery therefore continues to classify the parameter as a lookup and fails unavailable instead of accepting the wire value as an ordinary business object.

```ts type-equiv
/** Stable wire declaration retained after a lookup provider unloads. */
interface TypertLookupDefinition {
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
```

## Invocation descriptors

An `InvocationDescriptor` is local reflection, not a wire message. Host and consumer builds generate corresponding descriptors; the request sends only the endpoint and named `args`. Strict codecs carry generated schema factories, while SRC codecs enforce JSON-safe inputs without structural type recovery. Unary result codecs can supply `encode()` for byte-containing subtrees and `decode()` for recursive native-byte validation; Client declarations narrow every `Uint8Array` to `ArrayBuffer` backing. Pure JSON results need neither byte detection nor Client decoding. Cancellation is an out-of-band carrier signal injected after business parameters and never enters `args`.

`createTypertRemoteInfo` returns a lazy class instance implementing `TypertRemoteInfo`, which extends the mountable `TypertRemoteContribution`. Its `methods` index aliases the direct objects in `descriptors`: each `TypertRemoteMethod` adds named `input(options?)` and `invoke`, retains documentation on the method and its parameters, and uses `result` as its only output codec. Unary `mode` is absent; stream `mode` is `'stream'`. Context-only receivers remain in descriptors and scoped declarations. Registry queries return base descriptors; `isTypertRemoteMethod` narrows generated direct capabilities without recovering endpoint-specific generics.

`TypertSchema` guarantees parsing, not arbitrary Zod operations, although the raw factory spec requires Zod factories. Missing documentation or an unsupported optional JSON Schema projection does not invalidate an ordinary method. The info index and each input-policy view, parser, and derived projection are independently lazy and cached; no metadata or schema access invokes the network. The [protocol reference](<../../packages/typert/protocol/README.md>) defines these APIs, and the [generator reference](<../../packages/typert/generator/README.md#ordinary-remote-metadata>) defines their separate Host `./typert`, consumer `./remote`, and Client `./client/typert` artifacts.

`TypertRemoteSpec` holds a package and endpoint-keyed `TypertRemoteMethodSpec` values. Each ordered `TypertRemoteParameterSpec` contains normal `codec` and `strictCodec` factories from the same checker-resolved type model; the runtime derives identities, wire-name defaults, and named-call views. `TypertRemoteInputOptions` has only `strict?: boolean`; `method.input(options?)` selects a cached `TypertRemoteValue<T>` with matching parsing and optional documentation/projection, without changing Host dispatch or `result`. `RemoteDecoded<T>` describes carrier-reconstructed unary results without narrowing arbitrary parser outputs.

```ts type-equiv
/** Codec attached to one invocation parameter or result. */
type TypertCodec<Value = unknown> =
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
```

```ts type-equiv
/** One ordered business parameter in a Remote invocation. */
interface InvocationParameterDescriptor {
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
```

```ts type-equiv
/** Carrier-independent description of one exported method invocation. */
interface InvocationDescriptor {
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
```

The Host alias `RemoteStream<Out, In>` names both directions of one stream, and the receiving method reads its call context as `this.ctx.invocation`:

```ts type-equiv
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
type RemoteStream<Out, In = never> = AsyncIterable<Out> & { readonly [STREAM_UPLINK]?: In }
```

```ts type-equiv
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
interface RemoteStreamHandle<Out, In> extends AsyncIterable<Out> {
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
```

```ts type-equiv
/**
 * Merge-extensible caller identities. Each driver declares its own entry.
 * Every entry is a JSON value with a unique literal `kind`, carries no
 * credential, and is safe to persist in a Session log.
 */
interface PrincipalMap {
  /** The local user who owns this Host. */
  owner: { readonly kind: 'owner' }
}
```

```ts type-equiv
/** One caller identity; the authorization layer reads only this. */
type Principal = PrincipalMap[keyof PrincipalMap]
```

```ts type-equiv
/**
 * One Peer's session on this Host. Its creator owns it: `ctx` is the Cordis
 * scope that owns connection-lifetime registrations and is disposed with the
 * Peer, and `principal` is the caller identity fixed when the Peer was created.
 */
interface PeerScope {
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
```

```ts type-equiv
/** Carrier capacity for buffered uplink frames of one logical stream. */
interface RemoteUplinkWindow {
  /** Maximum complete encoded frame bytes waiting for the Host consumer. */
  readonly maxBytes: number
  /** UTF-8 envelope bytes added to a compact JSON item with a present value field. */
  readonly frameOverheadBytes: number
}
```

```ts type-equiv
/**
 * The context of one Remote call, reachable inside the receiving method as
 * `this.ctx.invocation`. The Gateway derives the receiver from a Context that
 * carries it, so no parameter is injected and nothing crosses the wire.
 */
interface RemoteInvocation {
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
```

## Remote access resources

Every Remote method is under the access control of [`dsh-api-remote-access`](../../packages/api/remote-access/README.md): a non-owner call is allowed only when the policy for its principal kind binds, on every resource the call touches, a role that lists the endpoint action. The package that owns an identity type merge-declares its resource kind in `TypertResourceMap`; `global`, the built-in identity-less resource, is never a kind there. The Gateway reads a kind's identities from the `resources` readers of `@Remote({ resources })` or `@RemoteScope(key, { resources })`, else from a lookup parameter or scoped Context that declares the kind as its `resource`, else from the default field or resolver registered in `typert.resources`; a call that names no resource touches `global`. The [Peer principals Agent Note](../../.agents/notes/implemented/architecture/2026-10-12-peer-principal-and-remote-access.md) owns the decision.

```ts type-equiv
/**
 * Merge-extensible resource kinds whose identities a Remote call or forwarded
 * event may carry. The package that owns an identity type declares its kind;
 * the value is that kind's identity type, a string type such as a branded id.
 * `global` names the built-in identity-less resource and is never a kind here.
 */
interface TypertResourceMap {}
```

```ts type-equiv
/** One resource kind: the built-in `global` kind or a declared kind. */
type RemoteAccessResourceKind = 'global' | TypertResourceKind
```

```ts type-equiv
/**
 * One resource a call or forwarded event touches: `global`, or one identity
 * of a declared kind. Identities are wire values, read before any lookup
 * resolves or validates them.
 */
type RemoteAccessResource =
  | { readonly kind: 'global' }
  | {
    [Kind in TypertResourceKind]: { readonly kind: Kind; readonly id: TypertResourceId<TypertResourceMap[Kind]> }
  }[TypertResourceKind]
```

```ts type-equiv
/**
 * Explicit endpoint and resource choices for one Remote Scope method.
 * @template WireArgs - the decorated method's positional parameters as the
 *   wire carries them; the default `never` admits readers of any tuple.
 */
interface RemoteScopeOptions<WireArgs extends readonly unknown[] = never> {
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
```

```ts type-equiv
/**
 * Explicit endpoint, stream, and resource choices for one direct Remote method.
 * @template WireArgs - the decorated method's positional parameters as the
 *   wire carries them; the default `never` admits readers of any tuple.
 */
interface RemoteMethodOptions<WireArgs extends readonly unknown[] = never> extends RemoteScopeOptions<WireArgs> {
  /** `stream`: deliver each Iterable item over the shared logical-stream carrier. */
  readonly mode?: 'stream'
}
```

## Typert registry

`ctx.typert` separates current-environment descriptors, explicitly selected Remote contributions, lookup providers, scoped Context providers, and the default fields or resolvers of resource kinds. A lookup provider owns the stable wire declaration and default resolver; Host composition can configure an effect-scoped synchronous or asynchronous resolver for the same key, and unloading that configuration restores the default policy. Registrations are Cordis-owned effects and return awaitable disposers.

```ts type-equiv
/** Minimal Typert runtime consumed through dependency inversion. */
interface TypertRegistryContract {
  readonly local: TypertLocalRegistry
  readonly remotes: TypertRemoteRegistry
  readonly lookups: TypertLookupRegistry
  readonly contexts: TypertContextRegistry
  readonly resources: TypertResourceRegistry
}
```

Generated consumer declarations merge direct namespaces into the map inherited by `TypertClientRemote`.

```ts type-equiv
/** Merge-extensible direct namespace surface generated for Client Remote services. */
interface TypertRemoteNamespaceMap {}
```

## Host Gateway

Connection decodes its carrier envelope before calling `ctx.typertGateway`. The request carries exact named wire fields, the carrier's cancellation signal, and the Peer the call speaks for separately; every carrier and in-process caller names that Peer, and the Gateway refuses a disposed one with `gateway/peer-disposed`. For a non-owner call the Gateway resolves its resources and asks `ctx.remoteAccess.decide()` after argument validation and before any lookup or Context resolution; infrastructure and boundary failures ride `TypertGatewayError`, whose `gateway/*` codes are ordinary `RemoteError` codes, so the RPC adapter passes every structurally identified `RemoteError` through with its code and details intact and folds only unrecognized exceptions into `gateway/internal`.

```ts type-equiv
/** One Remote method request after a carrier has decoded its envelope. */
interface InvokeRemoteRequest {
  /** Remote namespace selected by the generated descriptor. */
  readonly namespace: string
  /** Exported Service method name. */
  readonly method: string
  /** Named wire values; fields must exactly match the descriptor. */
  readonly args: Readonly<Record<string, unknown>>
  /**
   * Client uplink items of this logical stream, delivered to the method through
   * `invocation.uplink()`; absent means an immediately ended iterable.
   */
  readonly uplink?: AsyncIterable<unknown>
  /** Carrier-provided frame capacity; absent for carriers without an encoded-frame inbox limit. */
  readonly uplinkWindow?: RemoteUplinkWindow | undefined
  /** Peer the call speaks for; every carrier and in-process caller names it explicitly. */
  readonly peer: PeerScope
  /** Carrier or direct-caller cancellation injected only into cancellation-aware methods. */
  readonly signal?: AbortSignal
}
```

```ts type-equiv
/** Stable infrastructure and boundary failures emitted before or after business execution. */
type TypertGatewayErrorCode =
  | 'gateway/ambiguous-endpoint'
  | 'gateway/arguments-invalid'
  | 'gateway/binding-invalid'
  | 'gateway/context-failed'
  | 'gateway/context-not-found'
  | 'gateway/context-unavailable'
  | 'gateway/definition-unavailable'
  | 'gateway/input-invalid'
  | 'gateway/interactions-forbidden'
  | 'gateway/invocation-unavailable'
  | 'gateway/lookup-failed'
  | 'gateway/lookup-not-found'
  | 'gateway/lookup-unavailable'
  | 'gateway/method-unavailable'
  | 'gateway/peer-disposed'
  | 'gateway/protocol'
  | 'gateway/provider-mismatch'
  | 'gateway/result-invalid'
  | 'gateway/service-unavailable'
  | 'gateway/signature-invalid'
  | 'gateway/uplink-overflow'
```

```ts type-equiv
/** Host dispatcher consumed by Connection adapters. */
interface TypertGateway {
  /** Carrier adapter shared by WebSocket and in-process transports. */
  readonly wireStream: TypertGatewayWireStream
  /**
   * Check for an active owner Client event stream, the only kind that can answer forwarded waterfalls.
   * @returns whether an owner stream is open and has not been cancelled.
   */
  hasLiveClient(): boolean
  /**
   * Register the application-selected forwarded-event source.
   * @param source - stream factory installed by the Remote assembly.
   * @param host - stable Host facts included in each Client generation's opening frame.
   * @returns disposer removing this exact source and cancelling its active streams.
   */
  registerRemoteEvents(
    source: TypertRemoteEventSource,
    host: RemoteEventHostInfo,
  ): () => Promise<void>
  /**
   * Invoke one live Remote method without assuming a carrier or response envelope.
   * @param request - decoded endpoint and named wire arguments.
   * @returns the business result without output decoding.
   * @throws {@link TypertGatewayError} for dispatch, provider, or boundary failures; lookup-policy and business errors retain identity.
   */
  invoke(request: InvokeRemoteRequest): Promise<unknown>
  /**
   * Open one live stream Remote method without assuming a physical carrier.
   * @param request - decoded endpoint, named wire arguments, and the Client uplink when the carrier has one.
   * @returns a cancellation-aware iterable over the business results.
   */
  stream(request: InvokeRemoteRequest): Promise<AsyncIterable<unknown>>
}
```

## Consumer Remote

`ctx.remote` exposes only namespaces contributed by imported `/remote` artifacts. `$mount()` installs generated descriptors and concrete methods as one fiber-owned operation. Each namespace is a traced `remote.<namespace>` Cordis child Service whose lifetime spans its mounted methods; no JavaScript Proxy or Host business Service type enters the consumer.

Metadata ownership is separate from connection ownership; the [registry reference](<../../packages/typert/registry/README.md>) covers offline registration and mount lifetimes.

```ts type-equiv
/** Client Remote capability implemented by the Gateway and consumed by Remote assemblies. */
interface TypertClientRemote extends TypertRemoteNamespaceMap {
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
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxremoteaccess--remoteaccessservice"></a>

### `ctx.remoteAccess` — `RemoteAccessService`

Registry of access policies, the Gateway's access decisions, list filtering, and the per-Peer access snapshot. Every composition that mounts the Gateway mounts this service too.

```ts cordis-catalog
/**
 * Register the policy of one non-owner principal kind in the caller's
 * fiber; open snapshots are recomputed on registration and removal.
 * @param kind - the principal kind the policy serves; never `owner`.
 * @param policy - business-owned bindings and refusal reasons for principals of `kind`.
 * @returns disposer removing this policy.
 * @throws Error when `kind` already has a policy.
 */
registerPolicy<K extends Exclude<keyof PrincipalMap, 'owner'>>(kind: K, policy: RemoteAccessPolicy<PrincipalMap[K]>): () => void

/**
 * Report that the bindings or condition answers for `principal` may have
 * changed. Business packages call this on every grant, revocation, mode
 * change, and expiry; open snapshots re-push, and the next failure of each
 * policy is logged again.
 * @param principal - affected principal; omitted for every principal.
 */
invalidate(principal?: Principal): void

/**
 * Gateway-only: decide one request whose resources the Gateway resolved.
 * The owner is allowed, and so is `remoteAccess/follow`: every Peer reads
 * its own snapshot. Otherwise the action is allowed only when, on every
 * listed resource, some binding of the principal's policy names that
 * resource, has a role listing the action, and has no condition or a
 * condition that allows. `bindings()` is called once per decision.
 * @param request - the caller or recipient, the action, the resources it
 *   touches, and a call's arguments.
 * @returns `allow`; or `deny` with `no-allow` when the principal kind has
 *   no policy, the first refusing condition's reason on the first resource
 *   no binding allows, else `explain()`'s reason, else `no-allow`;
 *   `policy-failed` when `bindings()`, a condition, or `explain()` throws,
 *   logged once per policy until the next `invalidate()`. The Gateway
 *   throws `remote-access/denied` for a denied call and drops a denied event.
 */
decide(request: RemoteAccessRequest<Principal>): RemoteAccessDecision

/**
 * Filter items inside a Remote method. The invocation is read from the
 * Context that accessed this service, so call it as
 * `this.ctx.remoteAccess.allows(resource)` from the Remote method. Each
 * check reads the policy's bindings again, so a long-running stream sees
 * binding changes from the next check on.
 * @param resource - resource of one result item.
 * @returns true for the owner and outside a Remote call; otherwise whether
 *   the invocation's endpoint action is allowed on `resource` without call
 *   arguments, false when the policy is absent or fails.
 */
allows(resource: RemoteAccessResource): boolean

/**
 * The baseline a page opens with before its snapshot stream connects; every
 * index the webServer renders carries it under
 * {@link REMOTE_ACCESS_SNAPSHOT_KEY} for the Peer the page speaks for.
 * @param principal - the page's caller identity.
 * @returns the owner baseline for the owner; otherwise the principal's current grants.
 */
snapshotFor(principal: Principal): RemoteAccessBaseline

/**
 * Stream the calling Peer's access snapshot: one baseline, then `upsert`
 * and `remove` frames after each `invalidate()` and each policy
 * registration or removal that changes a grant. The owner receives only
 * `{ owner: true }`. The generation ends when `signal` aborts or this
 * service unloads, so a reloaded service starts every reader from a fresh
 * baseline.
 * @param signal - generation cancellation.
 * @returns the access frames of one generation.
 */
@Remote({ mode: 'stream' }) async *follow(signal: AbortSignal): AsyncIterable<RemoteAccessFrame>
```

Source: [`packages/api/remote-access/src/index.ts`](../../packages/api/remote-access/src/index.ts)

<a id="ctxtypert--typertregistry"></a>

### `ctx.typert` — `TypertRegistry`

Registry of generated schemas, package reflection, invocations, and Remote dependency providers.

```ts cordis-catalog
/**
 * Register one generated contribution atomically for the calling fiber.
 * Duplicate package-face identities, schemas, invocation ids, or endpoints
 * reject the whole batch.
 * @param contribution - generated schemas, reflection, and Host invocations.
 * @returns the exact effect disposer that removes this contribution.
 */
register(contribution: TypertContribution): TypertDisposer

/**
 * Look up one schema by `<package>#<name>`.
 * @param key - global schema key.
 * @returns a record containing the cached schema, or `undefined` when absent.
 */
get(key: string): TypertSchemaRecord | undefined

/**
 * Resolve one required schema.
 * @param key - global schema key.
 * @returns a record containing the cached schema.
 * @throws when the key is malformed, the package face is absent, or the schema is not contributed.
 */
resolve(key: string): TypertSchemaRecord

/**
 * Enumerate live schemas in registration order.
 * @param filter - optional package and face restriction.
 * @returns matching records containing the cached schemas.
 */
list(filter: TypertSchemaFilter = {}): TypertSchemaRecord[]

/**
 * Look up generated reflection for one package face.
 * @param packageName - exact npm package name.
 * @param face - face to query; defaults to the host runtime.
 * @returns the live package record, or `undefined` when absent.
 */
getPackage(packageName: string, face: TypertFace = 'host'): TypertPackageRecord | undefined

/**
 * Enumerate generated package reflection in registration order.
 * @param filter - optional package and face restriction.
 * @returns matching package records.
 */
listPackages(filter: TypertPackageFilter = {}): TypertPackageRecord[]

/**
 * Project a live Zod schema to JSON Schema without caching the result.
 * @param key - global schema key.
 * @param params - Zod projection parameters.
 * @returns a fresh JSON Schema document.
 */
toJSONSchema(key: string, params?: z.core.ToJSONSchemaParams): z.core.JSONSchema.BaseSchema
```

Source: [`packages/typert/registry/src/service.ts`](../../packages/typert/registry/src/service.ts)

<a id="ctxtypertgateway--typertgatewayservice"></a>

### `ctx.typertGateway` — `TypertGatewayService`

Resolve strict generated definitions or conservative SRC markers against current Cordis Services and Typert providers.

```ts cordis-catalog
/**
 * Check for an active owner Client event stream, the only kind that can answer forwarded waterfalls.
 * @returns whether an owner stream is open and has not been cancelled.
 */
hasLiveClient(): boolean

/**
 * Register the sole application-selected forwarded-event source.
 * @param source - stream factory installed by the Remote assembly.
 * @param host - stable Host facts included in each Client generation's opening frame.
 * @returns disposer removing this source and cancelling its active streams.
 */
registerRemoteEvents( source: TypertRemoteEventSource, host: RemoteEventHostInfo, ): () => Promise<void>

/**
 * Invoke one live Remote method through strict generated reflection or SRC markers.
 * @param request - decoded endpoint and exact named wire arguments.
 * @returns the business result without output decoding.
 * @throws {@link TypertGatewayError} for dispatch, provider, or boundary failures; lookup-policy and business errors retain identity.
 */
async invoke(request: InvokeRemoteRequest): Promise<unknown>

/**
 * Open one live stream Remote method without assuming a physical carrier.
 * @param request - decoded endpoint, named wire arguments, and the Client uplink when the carrier has one.
 * @returns a cancellation-aware iterable over the business results.
 */
async stream(request: InvokeRemoteRequest): Promise<AsyncIterable<unknown>>
```

Source: [`packages/api/gateway/src/index.ts`](../../packages/api/gateway/src/index.ts)
<!-- END GENERATED cordis-surface -->
