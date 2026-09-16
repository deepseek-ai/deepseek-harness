# Agent Note: Typert Gateway Targeted Method Calls

Status: implemented

English | [中文](2026-08-02-typert-remote-method-calls.zh.md)

## Problem

The Host API Proxy handled direct method calls, stateful interactions, and Session event streams in one package. These concerns have different lifecycles, routing semantics, and client programming interfaces. Continuing to export all business operations through one package would couple business Services, transport protocols, state machines, and client types.

This decision covers only targeted method calls in which one request produces one result. Stateful interactions such as Permission and Approval, as well as Session event streams, remain separate designs.

The contract for a direct method call belongs to the business Service that implements it. Business developers declare only which methods are remotely callable, without also maintaining a central API interface, routing table, parameter conversion table, client stub, and Zod schema.

The Host and Browser Client use separate TypeScript Programs because each side augments the Cordis `Context` type differently. A Remote projection must not import the complete Host declarations into a consumer or depend on Browser-specific types. If the TUI later reuses this programming interface, it must likewise see only methods marked Remote. TUI integration is outside the current scope, but the implementation boundary must preserve this isomorphic reuse.

## Decision

A business Service extends `TypertRemoteService` and declares callable methods with `@Remote` or `@RemoteScope()`. A Service that already has another base class may instead expose the same binding through `bindTypertRemote()`. Typert generates the Host-local reflection artifact and a platform-independent Remote consumer projection from the Host Program. The Client Program continues to generate its own local reflection artifact independently.

The Remote consumer projection contains `.d.ts`, `.d.ts.map`, and `.js` files. The `.d.ts` exposes only methods marked with a Remote decorator and refers to the business package's single public type symbols. The `.d.ts.map` navigates consumer API methods back to their Host business method implementations. The `.js` carries endpoint, parameter, Context, and Zod information for the same contract. At the assembly layer, the Browser Client mounts the required Remote JS contributions onto the Client Remote Service. The projection and Remote abstraction remain platform-independent so that a future TUI can reuse them.

`@deepseek-ai/dsh-api-gateway`, located at `packages/api/gateway`, provides two symmetric faces: its default entry provides Host `ctx.typertGateway`, while its `/client` entry provides consumer-side `ctx.remote`. Each side consumes a locally generated `InvocationDescriptor` from the same model; descriptors are not sent over the wire. The Remote data protocol runs over Connection's shared `/api` RPC channel. The business calling interface does not change when Connection migrates from HTTP to WebSocket.

`@deepseek-ai/dsh-api-remotes`, located at `packages/api/remotes`, is the BFF layer above the Gateway. Its Host entry registers the application's forwarded Cordis event source and the Host facts carried by generation readiness; its `/client` entry selects the generated Remote contributions exposed by the application. The Client entry consumes the shared `TypertClientRemote` contract through Cordis rather than importing the concrete Gateway implementation.

## Components and Cordis services

| Component | Cordis service | Responsibility |
|---|---|---|
| `@deepseek-ai/dsh-typert-protocol` | Declares only the minimal `ctx.typert` protocol | `TypertRemoteService`, decorators, binding fallback, descriptors, lookup/Context, and the Remote map; no dependency on the compiler, Zod, Connection, or Browser |
| Typert registry | `ctx.typert` | Separately stores reflection for the current environment, imported Remote contributions, lookup providers, and Context providers |
| Typert generator/loader | No new business service | Generates three kinds of `lib` artifacts from the Host/Client Programs and registers the current environment's artifacts with `ctx.typert` |
| API Gateway's Host face | `ctx.typertGateway` | Associates Host definitions with live Services, decodes parameters, resolves receivers, and invokes methods |
| Connection | `ctx.connection` | Exclusively owns the HTTP Server/future WebSocket, the shared `/api` route, RPC envelope, rpcId, serialization, trust, error transport, Typert interception, and owner-registered exact Fetch routes on the same channel |
| API Gateway's Client face | `ctx.remote`, `ctx.remote.<namespace>` | Mounts Remote contributions, materializes each namespace as a traced `remote.<namespace>` child Service, and delegates canonical calls to `ctx.connection.rpc` |
| API Remotes | No new service | Owns Host Agent/Session lookup policy and serves as the only Client business facade, selecting and mounting `/remote` contributions while exposing the selected API declarations |
| Agent/Session owning packages | Existing domain services | Provide both static interface merges and runtime lookup/Context providers |
| Business packages such as Goal | Existing business Services | Declare only bindings, Remote methods, and canonical DTOs, and export the generated `/remote` subpath |

The Host Gateway does not depend on concrete implementations of `ctx.agents`, `ctx.sessions`, `ctx.goals`, or `ctx.webServer`. The Client Remote does not understand the physical carrier, and Connection does not understand Goal, Agent, lookup, `InvocationDescriptor`, or Remote namespaces.

## Business declarations

Ordinary direct calls use `@Remote`. When an existing method's parameters and result are already the intended Remote contract, decorate that method directly without renaming it. Add a `remoteExport*` adapter only when the wire contract needs a distinct request or result shape, and use the decorator argument to declare its short API name. A method explicitly declares every required business object in a top-level parameter position:

```text
export class GoalService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'goals')
  }

  create(agent: Agent, request: CreateGoalRequest): GoalView {
    // Existing business method remains unchanged.
  }

  @Remote('create')
  remoteExportCreate(agent: Agent, request: CreateGoalRequest): CreateGoalResult {
    const view = this.create(agent, request)
    return { ref: { id: view.id, revision: view.revision } }
  }
}
```

`goals` is the explicit Cordis service key passed to `super()` and is the default wire namespace. Pass a `namespace` option as the third argument only when the protocol namespace genuinely needs to differ from the service key.

Use `@RemoteScope()` when the Service receiver must be resolved within an isolated kind of Context. Scope identity does not enter the business method's parameters:

```text
export class ScopedGoalService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'goals')
  }

  @RemoteScope('agent', 'create')
  remoteExportCreate(request: CreateGoalRequest): Promise<CreateGoalResult> {
    // Runs against the goals service resolved from the Agent Context.
  }
}
```

An endpoint selects exactly one invocation mode. A flow that needs an explicit `Agent` parameter uses `@Remote`. A flow that first switches to an Agent Context and then resolves a scoped receiver uses `@RemoteScope('agent')`. Typert does not infer either mode from the method body or from a missing parameter.

Business packages depend only on the lightweight `@deepseek-ai/dsh-typert-protocol`. It provides `TypertRemoteService` and declaration protocols for decorators, the binding fallback, lookup, Remote Scope, and descriptors, without depending on the TypeScript compiler, Zod, HTTP, or the Client runtime.

A method that cooperatively supports cancellation declares `signal: AbortSignal` as its final Host parameter. This reserved parameter is not a business value, lookup, or JSON field. The generated consumer method exposes it as a final optional parameter so ordinary calls remain unchanged while callers that own cancellation can pass a signal.

## Decorators and the explicit Gateway facet

A decorator only states that a method participates in the Remote contract. It performs no runtime type reflection and injects no hidden symbol into a Service constructor. The arguments to `@Remote('create')` and `@RemoteScope('agent', 'create')` are external method names; the decorated member may be the business method itself or an adapter such as `remoteExportCreate`. The member name becomes the external method name only when no alias is provided. Inheriting `TypertRemoteService` is the normal explicit declaration that a Service has joined the Gateway; its public readonly `typertGateway` field keeps the binding visible on the runtime instance.

In SRC mode, the decorator records the method name and invocation mode in a versioned descriptor on the Service prototype. The descriptor uses a stable string property name, so `remoteMethods()` can read markers produced by another installed copy of `dsh-typert-protocol`; it writes nothing to the Service instance, constructor, or method function.

In LIB mode, the Typert compiler performs strict method discovery, type resolution, and descriptor generation. It accepts a literal service key in `TypertRemoteService`'s direct `super()` call or the explicit binding fallback; generation neither rewrites business source nor injects hidden registration metadata.

## Lookup and Remote Scope registration

The Gateway has no built-in branches for Agent, Session, or other business objects. Each object-owning package provides both a static declaration and a runtime provider:

```text
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    agent: TypertLookup<Agent, SessionId>
  }
}

ctx.typert.lookups.register('agent', {
  parameter: 'agent',
  wire: 'agentId',
  resolve: sessionId => resolveAgent(sessionId),
})
```

The static declaration tells Typert that `Agent` corresponds to `SessionId` on the wire. The runtime provider resolves an `agentId` in a request to the currently live `Agent` object. If either side is missing, the LIB build or the earliest resolvable runtime registration fails immediately.

Lookup objects such as Agent and Session may each occupy only one top-level parameter position. An ordinary JSON request may be passed as another complete parameter, but this design does not support `request.agent`, object destructuring, arrays of objects, nested lookups, or searching arbitrary complex structures for IDs.

Remote Scope uses a separate merge-extensible map and Context provider. The Agent package registers an `agent` provider that locates the Agent Context from its wire identity and resolves the Service key named by the descriptor from that Context. The Gateway does not know the internal structure of an Agent Context.

The Client also registers an `agent` Context binder. The binder only retrieves a `SessionId` from the Context in which a call occurs; it neither enumerates Scopes nor copies methods into each one. A Cordis Service tracker automatically rebinds a scoped namespace to the current Agent Context.

## InvocationDescriptor

Typert, the permissive SRC parser, Host Gateway, and Client Remote exchange one canonical description:

```text
InvocationDescriptor {
  id: '@deepseek-ai/dsh-goal#goals/create'
  service: 'goals'
  namespace: 'goals'
  method: 'create'
  implementation: 'remoteExportCreate'
  invocation: direct | { context: 'agent', wire: 'agentId' }
  scope?: { context: 'agent', wire: 'agentId' }
  parameters: [
    { name, wire, source: json | lookup, lookup?, codec }
  ]
  cancellation?: { parameter: 'signal' }
  result: codec
  sourceLocation
}
```

`method` is the external short name used by the endpoint and Client Remote; `implementation` is the actual member name on the Host receiver. `implementation` may be omitted when the two names match. A `direct` descriptor retains the original Service instance as the receiver. A Context descriptor first uses the corresponding Context provider to find the scoped Context, then resolves the receiver by the descriptor's service key.

The strict generator writes `scope` only when a direct method has exactly one lookup parameter, a `TypertContextMap` declaration with the same name exists, and both use the same wire type symbol. `scope.wire` must identify that lookup parameter. It declares that a consumer may fill this parameter from the Context in which the call occurs, without changing the Host receiver or endpoint. No scoped projection is generated when there are multiple lookups, no Context declaration, or mismatched wire types; a type mismatch is a build error.

Parameter order comes from the method signature. HTTP fields come from parameter names or lookup declarations. A cancellation descriptor reserves only the final `signal` position and keeps it outside named `args`; Connection or a direct Gateway caller supplies the actual signal. The Gateway does not infer optional fields, Context types, lookup types, or missing arguments from request contents, and it does not synthesize business defaults.

A LIB codec contains a success-cached Zod schema factory and a canonical `typeSymbol` consisting of "package + public subpath + export name." The Host Gateway invokes parameter and identity factories when it first decodes strict input. The Client contribution retains the same codec metadata for strict input checks at mount but does not materialize invocation schemas; [Host-only Remote input validation](../simplification/2026-09-15-host-only-remote-input-validation.md) owns this placement. An SRC codec is marked only as `src-json`.

Descriptors exist only in the local registry on each side. The wire carries only the `/api` channel, endpoint, and `{ args }` payload. The Client uses its descriptor to map positional arguments and Context identity into named fields. The Host uses its descriptor to validate those fields, resolve the receiver, and invoke the method.

## Typert runtime registry

```text
ctx.typert.local     Host or Client reflection for this process
ctx.typert.remotes   peer Remote contributions explicitly mounted by a consumer
ctx.typert.lookups   providers and composition policy from wire IDs to Host objects
ctx.typert.contexts  Host Context resolvers and Client Context binders
```

Every registration returns a disposer owned by the caller's Cordis fiber. Client contribution mounting registers the descriptor set and concrete methods as one owned operation. The Host Gateway caches only the set of SRC-owned endpoint names and discards it whenever the Cordis Service set changes; it retains no descriptor, Service, or provider. Invocation resolves all live objects from current state, so removing a strict definition, Service, or provider makes the corresponding call unavailable without leaving a stale live object.

The lookup registry retains the stable wire declaration after its live resolver unloads. SRC parsing continues to classify the parameter as a lookup, while invocation fails with `gateway/lookup-unavailable`; it never reclassifies the incoming ID as an ordinary JSON business object. Re-registering the same key with different parameter, wire, or canonical type symbols fails for the lifetime of that Typert Service.

Business-object and scoped-Context packages own stable declarations and default resolvers through `lookups.register()` and `contexts.registerHost()`; Host composition supplies effect-scoped asynchronous policies through `lookups.configure()` and `contexts.configureHost()`. Configuration may precede provider registration, but does not by itself make an identity available without a live provider; unloading the configuration restores the provider's default resolver. The Session Controller's `ApiSessionAgentController` configures one shared resolver for the `agent` and `session` lookups and the `agent` Host Context: live Agents are reused, ordinary cold sessions are resumed automatically, concurrent resumes are deduplicated by Session ID, and the subagent ownership fence returns `session/agent-busy`. The `session` lookup returns the resolved Agent's Session, while the `agent` Host Context returns its Context, so all three projections share one resume lifecycle.

The registry's Host root entry has the complete `TypertRegistryContract` interface merge. The registry implementation shared by Host and Client lives in a separate module without environment declarations. The registry's `/client` entry imports only that shared implementation and does not pass through the Host root entry, so it cannot bring Host Cordis declarations into the Client Program.

## Canonical types, symbols, and Zod

Remote Client DTS does not copy business DTOs or redeclare structurally identical shadow types. It imports original symbols only from public, type-only subpaths that do not carry Host Cordis merges:

```text
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CreateGoalRequest, CreateGoalResult } from '@deepseek-ai/dsh-goal/types'
```

Consequently, `SessionId`, the Agent wire ID, the request, and the result all refer to the same TypeScript declaration in the Host and Browser Client. A future TUI can reuse them without a second set of types. Go to Definition, renames, and Find References for a DTO return to the one source location for the business type instead of stopping at a copy in a generated file.

Remote methods themselves use declaration-map navigation. Typert anchors `InvocationModel.location` to the decorated Host method-name token and emits a source-map segment on the corresponding property of the namespace interface. For an adapter-backed endpoint, after the TypeScript editor resolves `ctx.remote.models.list` to its generated declaration, `typert.remote-client.d.ts.map` takes it to the Host Service's `remoteExportList` entry point. That entry point explicitly calls the existing, unrenamed `list()` method; the map does not misidentify the decorator, class, or full signature as the method definition.

Typert generates a wire Zod codec for the same symbol key. The Host Gateway uses parameter and identity codecs to validate input. Client Remote trusts its generated TypeScript arguments and successful Host results instead of executing invocation codecs. If a complex type cannot produce a strict codec, the LIB build fails instead of degrading to `unknown` or unchecked JSON.

Named business types referenced by Remote methods must be exported from public, type-only subpaths. If the only reachable entry also imports Host Services, Cordis `Context` merges, or Host-only implementations, the build fails and requires the business package to provide a safe type entry. Primitives, literals, and simple compositions explicitly supported by Typert need no additional names.

A lookup parameter does not expose the `Agent` class to consumers. The Remote projection refers to the canonical ID type in the lookup declaration, such as `SessionId`, while the Host continues to resolve objects through the canonical `Agent` class symbol.

## Three artifact kinds and two TypeScript Programs

The Host and Client still use only two independent TypeScript Programs, but Typert generates three semantically distinct kinds of artifacts:

```text
Host Program
├─ typert.host.js / typert.host.d.ts
│  Host 自身的 Service、Event、Object、schema 和 inbound Gateway 信息
└─ typert.remote-client.js / typert.remote-client.d.ts / typert.remote-client.d.ts.map
   Host Remote 对任意消费环境的 wire 投影

Client Program
└─ typert.client.js / typert.client.d.ts
   Client 自身的 Service、Event、Object 和 schema 信息
```

`remote-client` is the Host Program's second emitter, not a third Program or the Client's local face. It contains no Host Cordis merge, Service class, Context class, or implementation code, and it does not enter the Host-local reflection registry.

The Host lib build performs strict Host analysis and emits both the Host-local and Remote consumer artifacts. The Client lib then consumes the Remote DTS. The complete order is:

```text
Host lib build
→ 生成 typert.host.{js,d.ts}
→ 生成各业务包 lib/typert.remote-client.{js,d.ts,d.ts.map}
→ 完成 Client lib 和 typert.client 产物
→ Vite 构建 Web
```

The existing top-level `build` still runs `build:lib` before `build:web`, but `build:lib` must complete the Host and Remote artifacts before starting Client TypeScript compilation. A clean build must not depend on stale `.d.ts` files from an earlier build.

Compiler-backed repository gates that resolve the consumer surface have the same prerequisite even when their primary inputs are source files. The public `typecheck`, `lint`, and `doc-typecheck` commands run the Host contract pass first. The gate scheduler may use their `*:contracts-ready` variants only after an explicit Typert-contract or complete-build dependency, so parallel lanes neither read missing declarations nor run concurrent generators against the same outputs.

## The `/remote` package entry

Every business package that provides Remote methods exports a generated `/remote` subpath:

```text
"./remote": {
  "types": "./lib/typert.remote-client.d.ts",
  "default": "./lib/typert.remote-client.js"
}
```

Consumer code selects a capability through the business package itself:

```text
import goalsRemote from '@deepseek-ai/dsh-goal/remote'
```

This import brings the `.d.ts` map augmentation into the current TypeScript project while supplying the JS descriptor for the same contract as a value to the runtime. A business package that is not imported does not extend the current project's Remote API types.

The business package's published files must include `lib/typert.remote-client.d.ts.map`. The generated DTS refers to its adjacent map with `//# sourceMappingURL=typert.remote-client.d.ts.map`; the map source points from `lib` to the business source by a relative path such as `../src/index.ts`. The `/remote` export does not list the map separately; the package `files` field publishes it. That target is a development-time path: a workspace consumer resolves it through the package link, so the published payload keeps excluding `src` and a published map simply resolves nothing.

Code that needs only static types may use `import type {} from '@deepseek-ai/dsh-goal/remote'`. This import is erased at runtime, loads no JS, and cannot trigger runtime registration. An environment that makes real calls must pass the contribution from a normal value import to the Client Remote Service.

Workspace resolution for `/remote` must explicitly target generated `lib` artifacts and must not let a general package-to-`src` paths rule redirect it to Host source. Ordinary business imports may continue resolving to SRC or LIB according to each environment's existing rules.

## Strict consumer API types

Remote DTS extends the flat endpoint map, direct namespace interface, namespace map, and scoped map without augmenting the global Cordis `Context`:

```text
interface TypertRemoteNamespace$676f616c73 {
  create: (
    agentId: SessionId,
    request: CreateGoalRequest,
    signal?: AbortSignal,
  ) => Promise<RemoteResult<CreateGoalResult>>
}

interface TypertRemoteMap {
  'goals/create': (
    agentId: SessionId,
    request: CreateGoalRequest,
    signal?: AbortSignal,
  ) => Promise<RemoteResult<CreateGoalResult>>
}

interface TypertRemoteNamespaceMap {
  goals: TypertRemoteNamespace$676f616c73
}

interface TypertRemoteScopeMap {
  'agent:goals/create': (
    request: CreateGoalRequest,
    signal?: AbortSignal,
  ) => Promise<RemoteResult<CreateGoalResult>>
}
```

`TypertRemoteMap` preserves canonical endpoint signatures for protocol typing and reflection. The root Remote type reads `TypertRemoteNamespaceMap` directly instead of deriving methods indirectly through a key-remapped mapped type; the TypeScript Language Service cannot reliably navigate such indirect properties through a declaration map. A namespace interface name encodes the namespace's UTF-8 bytes as hexadecimal, so `goals` deterministically becomes `TypertRemoteNamespace$676f616c73`. Different packages generate the same interface name for the same namespace and use module augmentation to merge their methods, while `TypertRemoteNamespaceMap.goals` always refers to that one type.

Typert projects `TypertRemoteScopeMap` onto a dedicated Scope type according to its Context key. The final programming interface remains:

```text
ctx.remote.goals.create(agentId, request)
agentCtx.remote.goals.create(request)
```

The Agent Scope supplies its own `SessionId` automatically. A `@Remote` method with an `agent` lookup can therefore generate both root and scoped consumer signatures. A `@RemoteScope('agent')` method also omits a separate Scope identity, but generates only the scoped signature. The root `Context` exposes direct namespaces through `ctx.remote`, while `AgentContext.remote` intersects that direct surface with the scoped surface. A future TUI must preserve the same distinction.

Every generated method resolves to `Promise<RemoteResult<T>>`: a call reports its outcome in the result's `ok` branch instead of rejecting, and only an assembly fault (arity, an unmounted method, a missing Context adapter) still throws. A consumer branches on `result.ok`, and reads `result.error.code` when it must distinguish failures; the failure vocabulary itself is [one Remote failure class plus a merged code table](2026-08-28-ctx-remote-failure-vocabulary.md).

`TypertClientRemote` remains platform-independent, and the Browser Client exposes it as `ctx.remote`. If a future TUI reuses this type, it must likewise access it through a dedicated Remote object and Agent Scope rather than treating the Host `Context` as a broader Service collection. Public Service methods without Remote markers do not enter the Remote maps. Beside the generated namespaces, the Gateway's client face adds `$mount`, `$on`, `$stream`, and `$host` — the last exposing the connection's fixed Host facts (`home`, `isLoopback`) as plain reads, so a consumer never injects the carrier to learn them.

## Client Typert and the API Gateway Client face

Typert in a consumer environment maintains both local information and Remote information imported from other environments, but stores them in separate registries:

```text
Typert.local    当前环境自己的反射模型
Typert.remotes  已导入的 Remote contribution
```

`@deepseek-ai/dsh-api-remotes/client` centrally loads the required Remote contributions:

```text
import goalsRemote from '@deepseek-ai/dsh-goal/remote'
import sessionsRemote from '@deepseek-ai/dsh-session/remote'

await ctx.remote.$mount(goalsRemote)
await ctx.remote.$mount(sessionsRemote)
```

Client business packages depend only on `@deepseek-ai/dsh-api-remotes/client`, not directly on the API Gateway or the runtime entry of each business `/remote`. API Remotes consumes the shared `TypertClientRemote` contract and Cordis `ctx.remote` service, then re-exports declarations so the selected Remote map reaches business compilation. Adding or removing a complete Client capability changes only this assembly point.

`ctx.remote.$mount()` registers a contribution with `Typert.remotes`, installs its namespace Services and concrete methods, and resolves only after they are ready. Its disposer is owned by the Cordis fiber that called the method. Duplicate endpoints, conflicting invocation modes for the same namespace and method, or conflicts between a descriptor and an existing type identity fail immediately.

The Client Remote Service materializes each `@Remote` descriptor as a real function on a `remote.<namespace>` child Service. The function checks positional arity, constructs named `args` in descriptor parameter order without runtime type parsing, and then calls `ctx.connection.rpc.call('/api', endpoint, { args }, signal)`. For a cancellation-aware descriptor, the generated function accepts a final optional signal and combines it with the contribution mount lifetime; unmounting therefore cancels every in-flight carrier call, while a caller can cancel one call independently.

Neither a direct descriptor with `scope` nor a `@RemoteScope` descriptor copies functions into every Agent Scope. The Client Remote Service creates one Cordis child Service per namespace, registered as `remote.<namespace>`, and materializes direct and scoped variants on it. Accessing a method through `agentCtx.remote.goals` captures the current Agent Context before returning the callable handle. The method then asks the corresponding Context binder for identity from that Context. A direct scoped projection substitutes this identity at the lookup position named by `scope.wire`; a Remote Scope descriptor writes the identity into the receiver's separate wire field. Both issue the same kind of `/api` call.

```text
root ctx.remote.goals.create(agentId, request)
  → direct descriptor
  → ctx.connection.rpc.call('/api', 'goals/create', { args })

agentCtx.remote.goals.create(request)
  → remote.goals accessor 捕获 agent Context
  → agent binder 从 caller Context 取得 agentId
  → 用 agentId 补入同一 direct descriptor 的 lookup 参数
  → ctx.connection.rpc.call('/api', 'goals/create', { args })
```

The root `Context` merges only the direct `TypertClientRemote` surface. `AgentContext` replaces that property with the intersection of `TypertClientRemote` and `TypertRemoteScopeApi<'agent'>`, so scoped-only methods remain unavailable from root code. If a caller bypasses the type system and dynamically calls a scoped-only method from Root, the binder reports an explicit error. If the Client already has a Cordis service named `remote.<namespace>`, or two contributions claim the same namespace and method incompatibly, mounting fails instead of overwriting the existing service.

Generated Remote JS contains only descriptors, symbol keys, and codecs; it does not bundle Host Service implementations. The Client Remote Service creates real functions from that data, so the runtime does not depend on a JavaScript Proxy. A Proxy remains an implementation option but is not a source of types or reflection.

## Cross-environment isomorphism constraints

Remote API is a consumer capability, not a synonym for Browser API. The shipped runtime implements Browser Client contribution mounting, Connection RPC calls, and Agent Scope association.

Remote DTS, Remote JS, `TypertClientRemote`, `InvocationDescriptor`, the Remote RPC data protocol, and Context binders must not depend on the DOM, Browser module loaders, or HTTP. Through Connection, the Browser Client encodes descriptor-materialized methods as `/api` RPC calls.

A future TUI can join the same call abstraction without changing business decorators, Remote maps, or the shape of API calls. The TUI-visible API must still be generated exclusively from `@Remote` and `@RemoteScope`; sharing a process with the Host must not allow it to bypass Remote restrictions and expose Service methods directly.

TUI runtime mounting, carriers, Agent Scope association, and SRC startup wiring remain deferred outside this decision.

The Web already depends on build artifacts such as `lib/client.js`, so it requires a complete `build:lib` before startup. After the Host Remote contract changes, developers rebuild the lib and then start or restart the Web. Incremental watching of the Remote contract is not implemented.

## SRC and LIB operating modes

SRC supports local source startup. The versioned prototype descriptors created by `@Remote` and `@RemoteScope()` provide method names and invocation modes. At runtime, the system reads ordered parameter names from the JavaScript function signature and combines them with registered lookup/Context providers to produce a permissive descriptor.

For example, `@Remote('create') remoteExportCreate(agent, request, signal)` resolves to the external method `create`, implementation member `remoteExportCreate`, two top-level business parameters, and one cancellation injection point. Lookup registration rewrites `agent` to the wire field `agentId`, `request` is passed as a same-named JSON parameter, and the final `signal` stays outside the payload. SRC does not start a `ts.Program`, use a preload or loader hook, generate or rewrite source, or inspect the internal structure of an ordinary JSON object.

A signature that SRC cannot resolve unambiguously fails on the first invocation that resolves its descriptor; Service mounting records only the decorator marker and does not inspect the JavaScript signature. SRC does not guess at object destructuring, ambiguity caused by default parameters, rest parameters, nested lookups, or complex types.

LIB supports CI, releases, and the prerequisite Web build. Typert scans the complete Host project and checks Remote decorators, explicit bindings, service keys, endpoint conflicts, lookup/Context declarations, public-symbol reachability, JSON codecs, result codecs, and that a reserved final `signal` parameter has the global `AbortSignal` type, then generates strict descriptors.

At runtime, LIB only loads definitions from `lib`; it does not start the TypeScript compiler. The subsequent association of Services, lookup, Context resolution, invocation, and response encoding in the Host Gateway does not depend on whether a descriptor came from permissive SRC parsing or strict LIB generation.

CI and releases use LIB. Moving all repository coverage to LIB is separate follow-up work and does not block this direct-method-call implementation.

## Host Gateway resolution

The Host Gateway registers one `/api` interceptor with Connection and does not maintain a second endpoint registry. Its ownership matcher checks the current Typert local registry first, then consults an invalidation-aware set populated by scanning current Cordis Services for `typertGateway` bindings and SRC Remote markers. A Cordis Service change discards the set, so Typert definitions and business Services may arrive in either order without rescanning every Service on each request or letting arbitrary request paths grow the cache.

Invocation resolves the descriptor, receiver, lookup providers, and Context provider again from current state. A current strict descriptor takes precedence over SRC. After a strict endpoint has appeared, `TypertLocalRegistry.hasSeen()` keeps it owned when that descriptor is withdrawn and forbids SRC fallback for the remainder of the registry lifetime; re-registering the strict descriptor restores calls. Removing a Service or provider makes invocation fail explicitly, and the Gateway neither retains invalid objects nor invokes a method with a raw lookup ID.

An ordinary `@Remote` call retains the original Service instance as receiver. After lookups succeed, the Gateway calls the member identified by `implementation ?? method` with parameters in descriptor order, followed by the carrier signal when the descriptor declares cancellation.

A `@RemoteScope('agent')` call first asks the Agent Context provider to resolve the wire identity, then reads the descriptor's service key from that Context and invokes the scoped receiver. The business method receives neither a hidden Context parameter nor an Agent ID.

```text
ctx.typertGateway.invoke({ namespace, method, args, signal })
→ 查找本地 InvocationDescriptor 与 live receiver
→ 按参数 descriptor 读取具名 wire 字段
→ codec 解码普通值或 lookup ID
→ lookup provider 把 ID 解析为活对象
→ direct 使用原 Service；context 先解析 scoped Context 和 Service
→ cancellation descriptor 存在时把 signal 追加到业务参数末尾
→ Reflect.apply(receiver[implementation ?? method], receiver, orderedArgs)
```

`ctx.typertGateway.invoke()` is the carrier-independent Host entry point. It neither creates an rpcId, RPC envelope, nor HTTP response. It returns the business result without runtime output decoding or raises a Gateway error that the Connection RPC adapter maps for transport.

## The shared `/api` call chain

Connection owns one `/api` route on the HTTP Server. The Gateway mounts a synchronous endpoint ownership test and the Remote RPC handler into Connection:

```text
ctx.connection.rpc.intercept(
  '/api',
  endpoint => ownsRemoteEndpoint(endpoint),
  (endpoint, payload, signal) => {
    const { namespace, method } = parseEndpoint(endpoint)
    const { args } = parsePayload(payload)
    return ctx.typertGateway.invoke({ namespace, method, args, signal })
  },
)
```

The Gateway claims an endpoint when the Host registry contains its strict descriptor, remembers a withdrawn strict descriptor, or finds a matching `@Remote` marker on an active SRC Service binding. A claimed endpoint stays in the Gateway after payload decoding, descriptor resolution, or invocation fails; an endpoint that neither an exact Fetch route nor the Gateway claims answers 404.

The Connection Host half passes one composite FetchHandler to the HTTP bridge. After the bridge creates a standard `Request`, that handler matches the pathname against the exact Fetch routes owners registered on the channel, then against the channel's single interceptor — the Gateway — and answers 404 when neither claims it. Every path on the channel reuses the same request/response envelope, rpcId, serialization, trust, and error transport, and a failure carries the shared `{ code, message, details }` data. The current physical mapping is:

```text
POST /api/<namespace>/<method>
```

The Remote payload is a named JSON object, not a positional array, and does not carry an `InvocationDescriptor`. A normal Goal call has this payload slot:

```json
{
  "args": {
    "agentId": "session-1",
    "request": {
      "objective": "finish the migration"
    }
  }
}
```

The complete path is:

```text
ctx.remote.goals.create(sessionId, request, signal?)
→ Client InvocationDescriptor 组装 { args: { agentId, request } }
→ Client 合并 caller signal 与 contribution mount lifetime
→ ctx.connection.rpc.call('/api', 'goals/create', { args }, signal)
→ Connection 创建 rpcId 和既有 client-request envelope
→ 当前 carrier 发送 POST /api/goals/create
→ Connection Host half 执行共享 trust，再由 bridge 创建标准 Request
→ 复合 FetchHandler 判断 endpoint ownership 并选择目标 FetchHandler
→ Typert interceptor 调用 ctx.typertGateway.invoke(..., request.signal)
→ Host InvocationDescriptor 解码、lookup、receiver 解析并把 signal 注入 Reflect.apply
→ Connection 写入既有 RPC result 并回送相同 rpcId
→ Client 直接返回 CreateGoalResult
```

Remote does not define a second-layer `{ ok, value/error }` response on the wire. Successful values and failures use the existing RPC response's `result` directly, and the failure branch carries the shared `{ code, message, details }` data. Owners, resolvers, and the Gateway all raise one class, `RemoteError`, whose code comes from the merged `RemoteErrorDetailsMap`: the Host encodes a structurally identified `RemoteError` onto the wire unchanged — including the Gateway's own `gateway/*` assembly codes and a resolver's `session/not-found` or `session/agent-busy` — and folds only an unclassified throw into `gateway/internal`, keeping its diagnostic in the message. The Client face rebuilds an instance for the `RemoteResult` error branch, so `throw result.error` keeps throw semantics. [The failure-vocabulary Agent Note](2026-08-28-ctx-remote-failure-vocabulary.md) owns the code table, its ownership rules, and why discrimination reads `code` instead of `instanceof`.

The Gateway does not handle per-method permissions, caller identity, idempotency, or long-lived connection state. It only propagates cooperative cancellation from Connection into explicitly cancellation-aware business methods. Every request on the shared channel, Typert endpoint or exact Fetch route alike, passes Connection's browser authentication and trusted-host policy before dispatch; the Gateway adds no second policy. Connection's WebSocket migration remains separate follow-up work.

## Connection and protocol boundaries

The Client Remote Service owns Remote contributions, namespace Service materialization, Scope binding, and the correspondence between positional parameters and descriptors. The Gateway owns Host descriptors, endpoint ownership, lookup, Context, and business invocation. Connection sends `/api`, the endpoint, and `{ args }` as one RPC call to the target and returns the existing RPC result; it does not understand Goal, Agent, lookup, descriptors, or Client Remote types.

The Gateway registers only its ownership matcher and RPC handler with Connection; it does not register an HTTP route. Connection mounts the shared `/api` route into the HTTP Server and gives the bridge one composite FetchHandler; that handler dispatches an exact registered path to its route owner, a claimed endpoint to the Gateway, and anything else to 404. A future Connection transport can preserve this order without changing the Remote payload, business decorators, generated DTS, Remote API types, or Agent Scope programming interface.

## Package boundaries

- `@deepseek-ai/dsh-typert-protocol`: lightweight protocols for decorators, bindings, lookup, Remote Scope, and descriptors.
- Typert generator: analyzes Host/Client Programs, generates local faces and Remote consumer projections, and emits canonical symbol/Zod information.
- Typert runtime: separately stores the current environment's local reflection and imported Remote contributions.
- `@deepseek-ai/dsh-api-gateway`: its default entry associates Host definitions with Services, claims Remote endpoints, validates input, performs lookup, resolves Context receivers, invokes methods, and registers an `/api` interceptor with Connection; its `/client` entry mounts Remote contributions, creates strict Remote namespace Services and methods, and delegates calls to `ctx.connection.rpc`. The entries share the Remote protocol but do not import each other's Cordis interface merges.
- `@deepseek-ai/dsh-api-remotes`: the BFF layer; registers the application's forwarded Cordis event source and the Host home carried by generation readiness, selects Client `/remote` contributions, and exposes the merged Remote types to business packages through the shared `TypertClientRemote` contract.
- Connection: owns the single HTTP Server/future WebSocket carrier, the shared `/api` route and its composite FetchHandler, owner-registered exact Fetch routes, the RPC envelope, rpcId, serialization, trust, and error transport.
- Business-object packages such as Agent/Session: own lookup, Context providers, canonical ID types, and public type-only entries.
- `@deepseek-ai/dsh-api-session-controller`: configures the shared `agent`/`session` lookup and `agent` Host Context resolver, so every Remote endpoint that accepts one of those objects shares one resume and ownership-fence policy.
- Business Service packages: declare bindings, Remote methods, and their request/result types, and export the generated `/remote` subpath.

## Shipped scope and deferred work

The shipped vertical path is `@deepseek-ai/dsh-goal/remote → Browser Client Remote → Connection RPC /api → Host Gateway → GoalService.remoteExportCreate()`. The same direct descriptor with an Agent lookup supports both `ctx.remote.goals.create(agentId, request)` and `agentCtx.remote.goals.create(request)`. Ordinary cold sessions are resumed by the shared lookup resolver, while subagent-owned identities retain the `session/agent-busy` fence; `@RemoteScope('agent')` remains the distinct scoped-receiver mode.

Connection supplies the shared-channel interceptor and current HTTP carrier mapping. WebSocket migration, the TUI runtime and carrier, TUI Agent Scope wiring, Permission/Approval state machines, Session event streams, call authorization, retries, idempotency, and cross-version protocol compatibility remain outside this decision.

The package topology is `api/remotes → api/gateway → client/connection → host/webserver`. Connection and WebServer retain their existing paths in this change; moving them later to `api/connection` and `api/webserver` changes package placement rather than these service boundaries.

## Alternatives considered

**Continue using the central API Proxy package.** This would require business methods, Host routes, and Client interfaces to be declared repeatedly in several locations. It would also keep direct calls, stateful interactions, and event streams tied to the same lifecycle, so this alternative is rejected.

**Perform strict reflection through decorators at runtime.** JavaScript decorators cannot recover erased TypeScript types, public symbol identity, or complete Zod codecs. Injecting a compiler-private symbol into a constructor would also hide the business class's real dependencies, so Typert generates strict information at compile time.

**Use a preload, loader hook, or complete `ts.Program` during SRC startup.** This could reuse LIB analysis but would add requirements to every source startup entry. SRC needs only a usable permissive descriptor, so it uses decorator markers, function parameter names, and explicit providers; strict checks remain in the LIB contract pass.

**Hand-write the Client interface.** A hand-written interface cannot guarantee that it contains only Remote-marked methods and can drift from Host signatures, lookup IDs, and Zod schemas. Client types are therefore projected automatically from the Host Program.

**Use a TypeScript language-service/compiler plugin to make the Client understand decorators directly.** This would require editors, Vite, tsc, tsx, and published consumers to install an additional plugin, making integration too invasive. The design instead generates ordinary `.d.ts` files and standard declaration maps.

**Import complete Host DTS into the Client or TUI.** This would pull in Host Services and Cordis interface merges while exposing unmarked methods to consumers. Remote DTS refers only to public, type-only symbols and augments dedicated Remote maps.

**Generate only Remote DTS, without JS.** Types would work, but the runtime could not enumerate endpoints, codecs, and Context modes without a Proxy or another hand-written registry. The same Host projection therefore emits a Remote JS contribution as well.

**Let a top-level `/remote` import register global state implicitly.** The target Cordis Context may not exist when ESM evaluation occurs, and ownership becomes ambiguous across multiple Contexts, HMR, and disposal. A normal value import therefore returns only a contribution, which the environment assembly explicitly mounts through the Client Remote Service.

**Create a separate transport, HTTP route, or `/api2` channel for Remote.** This would duplicate or split Connection's Server ownership, rpcId, serialization, trust, errors, and future WebSocket lifecycle. The shared `/api` interceptor instead keeps one physical route and lets Connection compose it from owner-registered exact Fetch routes and the channel's single interceptor.

## Verification

- Goal Service directly decorates mutation methods whose business signatures already match the Remote contract and keeps `remoteExportCreate(...)` only to adapt `GoalView` into `CreateGoalResult`, without a second route, codec, or Client method list.
- A clean `build:lib` emits Host and consumer Remote artifacts before Client compilation, including the business package's JS, DTS, and declaration map under `/remote`.
- After `clean`, standalone `typecheck`, `lint`, and `doc-typecheck` regenerate the Remote contracts; the pre-push hook uses the same prepared typecheck, and CI source consumers wait for one shared contract pass.
- Importing `@deepseek-ai/dsh-goal/remote` adds the strict `ctx.remote.goals.create(...)` type and declaration navigation to `remoteExportCreate`; omitting that import omits the namespace.
- Mounting the same import's JS contribution supplies endpoint, parameter, result, lookup, Context, and Zod reflection and materializes the call without a handwritten stub.
- Root and Agent-scoped calls cross the real shared `/api` carrier, resolve `agentId` to the live Agent, invoke the original Goal receiver, and return through the existing RPC envelope.
- Agent and Session lookups share a single in-flight cold-session resume; ordinary cold sessions receive restored objects, while both cold and live subagent identities return `session/agent-busy` before business invocation.
- The Remote artifacts and maps contain only marked methods and no Browser dependency, preserving the same consumer boundary for a future TUI.
- Lifecycle tests withdraw and remount descriptors, Services, lookups, Context providers, and Client namespaces; unavailable dependencies fail without stale calls or raw-ID fallback.
- Cancellation tests cover strict generation, SRC final-name recognition, Client signal fusion, Connection-to-Gateway propagation, and Host injection outside wire `args`.
- A request that matches neither an exact Fetch route nor a claimed Remote endpoint answers 404 on the same channel, while a withdrawn route stops being served.

## Consequences

Remote API types depend on generated `lib` declarations. Build and gate orchestration must finish the Host contract pass before compiling or semantically analyzing Host and Client consumers; an incorrect order makes a clean command depend on stale artifacts.

Source navigation requires a Remote package to publish both its declaration map and the `src` file referenced by the map. If package `files` omits either side, types still compile but consumer navigation stops at the generated DTS. The workspace manifest check must therefore treat both as one publication contract.

The permissive SRC descriptor does not validate the internal structure of ordinary JSON. After a Host Remote signature changes, the Web and strict type consumers must rebuild the lib because no incremental contract watcher exists.

Canonical public types require business DTOs to have type-only entries, which may expose packages whose Host types and implementation entries are currently mixed. The build rejects those boundaries instead of copying types to conceal them.

Type imports and runtime contributions have different effects. `import type {}` extends only the static Remote surface. If a real calling environment omits the value contribution, the Client Remote Service must fail with an explicit "Remote not mounted" error.

Generated Host and Client artifacts carry matching Zod factories, but Client Remote does not materialize invocation schemas. Canonical symbol keys, the same generated model, and Host wire validation keep the two sides aligned without comparing schema object identities across realms.

A consumer may import a Remote contract that is not currently mounted on the Host. The types mean "this protocol capability was selected by the consumer," not that a corresponding Service currently exists in the target process; an unavailable endpoint must fail explicitly at runtime.

Connection's general channel API must suit both the current HTTP carrier and a future WebSocket carrier. If the Client Remote or Gateway exposes `fetch`, an HTTP request, or a route handle, WebSocket migration will pierce the Remote layer again. Those physical objects must therefore remain internal to Connection.

Remote endpoints use Connection's `trusted-host` authority. Loopback is accepted by default and LAN callers require an explicit trusted-host configuration, but this layer adds no per-method caller authorization; every trusted host can invoke a mounted Remote endpoint.

`hasSeen()` favors strict-definition safety over SRC availability. While a strict descriptor is withdrawn, such as during HMR, the Gateway continues to claim the endpoint and reports it unavailable instead of falling back to a weak SRC descriptor. Re-registration restores it; only a Typert registry restart forgets the historical strict definition.

Cancellation-aware Remote signatures receive Connection's request `AbortSignal`, so an HTTP disconnect or Client-side abort reaches ongoing business work without entering the JSON protocol. Cancellation remains cooperative: methods without the reserved final parameter continue running, and a method that receives the signal must pass it to its own cancellable operations or observe it directly.

Lookup configuration currently operates at key granularity, so every `agent` or `session` parameter uses the same cold-resume policy. A specific Remote that requires live-only semantics must wait for an explicit per-parameter or per-endpoint policy; the business implementation cannot be left to guess whether the object was just resumed.
