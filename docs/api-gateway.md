# API Gateway

English | [中文](api-gateway.zh.md)

This is the current-state reference for the Typert API Gateway. It describes how business services declare unary Remote methods, how the build generates Host and Client contracts, and how calls reuse the Connection RPC and `/api` route. Session events, incremental data, and other streaming protocols are outside this document's scope; they may use the same Connection but do not use Remote method descriptors.

## Programming model

Business services use `@Remote` or `@RemoteScope` to select the methods exposed to the Client. Unmarked methods do not enter the generated Client types or runtime contributions and cannot be called through `ctx.remote`.

`@Remote` denotes calling a Cordis service registered on the root Host Context. Complex Host objects cannot cross the wire directly; the business package must declare their association with a wire identity through `TypertLookupMap` and register a default resolution provider with `ctx.typert.lookups` at runtime. For example, an `Agent` parameter named `agent` in the Host signature produces an `agentId` wire field, and the Gateway resolves that id to a Host object before invoking the business method. Host composition can use `ctx.typert.lookups.configure()` to override the resolution policy for a lookup key without changing the parameter name, wire field, or canonical type symbol owned by the business package.

`@RemoteScope(key)` first resolves an identity to a scoped Context through `ctx.typert.contexts`, then obtains the service from that Context and invokes the method. It applies when the method itself depends on scoped composition and does not need to receive objects such as `Agent` explicitly.

Services normally extend `TypertRemoteService` so the constructor explicitly binds the Cordis service key and default Remote namespace. A service that already has another base class can instead declare `readonly typertRemote = bindTypertRemote(this, serviceKey)`; both forms leave an inspectable public binding and do not depend on the compiler injecting a symbol into the constructor.

```ts
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TypertRemoteService, Remote, RemoteScope } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'

export interface CreateGoalRequest {
  objective: string
}

export interface CreateGoalResult {
  accepted: boolean
}

export class GoalService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'goals')
  }

  @Remote('create')
  createForClient(
    agent: Agent,
    request: CreateGoalRequest,
    signal: AbortSignal,
  ): CreateGoalResult {
    signal.throwIfAborted()
    return this.create(agent, request)
  }

  @RemoteScope('agent', 'current')
  currentForClient(): CreateGoalResult {
    return { accepted: true }
  }

  private create(_agent: Agent, request: CreateGoalRequest): CreateGoalResult {
    return { accepted: request.objective.length > 0 }
  }
}
```

Remote methods may return a value synchronously or return a Promise. For cooperative cancellation, the final parameter in the Host signature must be `signal: AbortSignal` using the global type; it is recorded in the descriptor instead of entering `args`, while the generated Client method accepts an optional final `AbortSignal`.

The Client uses concrete functions on ordinary objects, not a JavaScript Proxy. Direct and scoped calls appear under `ctx.remote.<namespace>` and `agentCtx.remote.<namespace>`. Each namespace is a traced Cordis child Service registered as `remote.<namespace>`; the Client assembly mounts contributions through `ctx.remote.$mount()`, and the namespace unloads after its last method is withdrawn. Dependency declarations belong to the actual caller: only a business package that reads `ctx.remote.<namespace>` or `agentCtx.remote.<namespace>` declares both `remote` and `remote.<namespace>` in its own `inject`; assemblies that only mount contributions and higher-level runtimes that do not call that namespace do not declare the namespace dependency on the business package's behalf. When an `@Remote` method has exactly one lookup parameter and a same-named `TypertContextMap` uses the same wire identity, the generated scoped signature omits that identity parameter. `@RemoteScope` generates only the scoped invocation interface.

```ts ignore-check
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AgentContext } from '@deepseek-ai/dsh-api-session-controller/client'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'

export const inject = ['remote', 'remote.goals']

declare const ctx: Context
declare const agentCtx: AgentContext
declare const agentId: SessionId

await ctx.remote.goals.create(agentId, { objective: 'ship it' })
await agentCtx.remote.goals.create({ objective: 'ship it' })
```

Client applications assemble only `@deepseek-ai/dsh-api-remotes`. That package imports the `/remote` subpaths of selected business packages as runtime values, mounts their contributions through `ctx.remote.$mount()`, and re-exports the declaration merges from the same files. Adding a Host Remote package is an explicit choice by the Client composition owner; business components do not need to load the Typert Gateway or the business package's Remote JS separately.

The `api-remotes` assembly and the `ctx.remote` contract are React-independent; the Host methods visible to any Client assembly are limited to the Remote methods selected at generation time.

## Component responsibilities

| Location | Package or entry | Responsibility |
|---|---|---|
| Shared | `@deepseek-ai/dsh-typert-protocol` | Declares decorators, Gateway bindings, merge-extensible protocol maps, invocation descriptors, and provider types; starts no TypeScript analysis and registers no Cordis services |
| Build | `@deepseek-ai/dsh-typert-generator` | Strictly analyzes Remote signatures, the type graph, lookups, Contexts, and source locations from the Host `ts.Program`, then generates Host and Host-for-Client artifacts |
| Host | `@deepseek-ai/dsh-typert-registry` and Loader | Places generated Host descriptors, schemas, and business-package registrations in `ctx.typert`, and holds lookup and Context providers |
| Host | `@deepseek-ai/dsh-api-session-controller` | Owns the application Agent/Session identity policy and configures the corresponding Typert lookups |
| Host | `@deepseek-ai/dsh-api-gateway` | Provides `ctx.typertGateway`, claims Remote endpoints, validates request values, resolves objects or Contexts, and invokes live Cordis services |
| Client | `@deepseek-ai/dsh-api-gateway/client` | Provides `ctx.remote` and `remote.<namespace>` child Services, mounts generated descriptors as concrete methods, and initiates and cancels calls through the Connection |
| Client | `@deepseek-ai/dsh-api-remotes/client` | Explicitly selects and mounts the `/remote` contributions allowed by the application and brings the corresponding declaration merges into business code |
| Both | `@deepseek-ai/dsh-client-connection` | Provides the RPC carrier, request correlation, trust boundary, cancellation, response envelope, and the `/api` HTTP bridge |

The API Gateway package owns the Host dispatcher and Client Remote endpoint as peer entries, but the two builds never enter the same `ts.Program`. The Host entry does not import the Client Cordis `Context` merge, and the Client entry does not import the Host Gateway service.

## Strict generation pipeline

The root build runs `build:lib:host`, `build:lib:client`, and `build:web` in order. The Host lib phase first runs `tsc -b tsconfig.host.json`, then `tsdown --env.DSH_BUILD_FACE host`; the normal Host Project Reference graph compiles the Typert generator, which runs during this tsdown pass with the Host aggregate as its only `ts.Program` seed. The Client lib phase then runs `tsc -b tsconfig.client.json` and `tsdown --env.DSH_BUILD_FACE client`, consuming the newly generated Remote Client declarations and runtime contributions without starting Typert again.

Both tsdown passes receive the complete workspace and bundle only JavaScript emitted to `lib/types` by the corresponding tsc phase. The root config does not scan Client artifacts, classify package names, or pass a maintained filter to tsdown; package-local configs return entries for the current phase based on `DSH_BUILD_FACE`. An ordinary Client plugin produces both its Node loader entry and browser bundle during the Client phase.

`api/remotes`, `api/gateway`, `api/session-controller`, and `api/workspace-controller` (plus `client/connection`) split TypeScript faces. `api/remotes`' Client project depends on `/remote` declarations generated for business packages during Host tsdown; root aggregates and direct consumers must reference each split package's `tsconfig.host.json` or `tsconfig.client.json` respectively. `api-remotes`' `clientBundle(..., { hostPhase: true })` produces its Host entry during Host tsdown and leaves only the browser entry for Client tsdown. The Agent/Session lookup policy lives in `@deepseek-ai/dsh-api-session-controller`, not in `api-remotes`.

Each contributing business package writes generated files to its own `lib/` directory, not to its source directory:

| File | Consumer | Contents |
|---|---|---|
| `typert.host.js` | Host Loader | Runtime reflection for the Host face, strict invocation descriptors, and schema registration values |
| `typert.host.d.ts` | Host type system | Generated declarations for the Host face |
| `typert.remote-client.js` | `api-remotes` | A mountable `TypertRemoteContribution` containing strict descriptors and runtime codecs |
| `typert.remote-client.d.ts` | Client type system | Declaration merges for `TypertRemoteNamespaceMap` and `TypertRemoteScopeMap`, plus Client-safe type references |
| `typert.remote-client.d.ts.map` | Editor | Maps generated method properties back to Remote method declarations in the Host package |

Business packages expose the Host Loader entry through `./typert` and the Host-for-Client entry through `./remote`. The generator also validates these package exports and published-file lists; it generates artifacts only for explicit contribution packages that provide the corresponding entry.

Parameter names in Remote Client declarations come from wire fields, while parameter and return types reference Client-safe types exported by the original business package. The declaration map resolves the generated property behind `ctx.remote.goals.create` back to the Host source method marked with `@Remote`, so editors that support declaration maps can navigate from a Client call to the real implementation instead of stopping at the generated `.d.ts`.

Strict analysis requires a Remote to be a public, non-static instance method with a concrete implementation. The method cannot be generic; parameters must be required, named simple identifiers and cannot use destructuring, default values, rest parameters, or optional parameters. Typert generates strict schemas for ordinary JSON-representable types; complex objects such as workspace classes must have a unique `TypertLookupMap` declaration. Lookup and Context packages are responsible for both static declaration merges and runtime provider registration; if either side is missing, the build fails or the first call that needs the provider fails.

## Runtime invocation

Remote calls use the Connection's `/api` route. The Client Remote calls `connection.rpc.call('/api', '<namespace>/<method>', { args }, signal)`; the HTTP carrier maps this to `POST /api/<namespace>/<method>`, with a payload containing only a named `args` object.

The Connection performs the unified trust check for `/api` before the HTTP bridge, then dispatches inside the shared FetchHandler. The Typert Gateway claims only two-segment endpoints that have a strict descriptor or active SRC marker; feature-owned exact Fetch routes handle non-JSON responses, and other requests return 404. The Connection owns transport, RPC ids, response envelopes, and request cancellation, while the Gateway owns only the Remote data protocol and business dispatch. Replacing the Connection carrier does not require changes to Remote descriptors or the Client programming interface.

For every call, the Gateway resolves the descriptor and live service from the current registries instead of caching business objects. It requires the fields in `args` to match the descriptor exactly, validates wire values with codecs, resolves objects or receivers through registered lookup or Context providers, invokes the service method targeted by the binding, and validates the return value. A missing provider, unknown identity, binding mismatch, missing or extra argument, schema failure, or missing method fails before entering or after leaving business code.

The lookup provider's `register()` supplies both the stable declaration and the default resolver; `configure()` supplies a resolver owned by Host composition that may execute asynchronously and is scoped to an effect lifetime. Configuration may precede provider mounting; without a provider, invocation still fails with `gateway/lookup-unavailable`, and unloading the configuration restores the provider's default policy. The Session Controller owns the standard resolver semantics for `agent` and `session`: it reuses a live Agent, automatically resumes ordinary cold sessions, deduplicates concurrent resumes, and rejects identities owned by subagent routing; the `session` lookup returns that Agent's Session. A resume failure and an ownership fence raise a `RemoteError` carrying their own code, `session/not-found` or `session/agent-busy`, which the Gateway encodes onto the wire unchanged; only an unclassified throw folds into `gateway/internal`.

Unloading a Client contribution removes its descriptors and concrete methods together, aborts its in-flight calls, and makes stale method handles retained by external code reject further calls. A strict endpoint withdrawn on the Host also does not degrade to SRC inference, preventing a hot unload from silently weakening validation.

## SRC development fallback

When the Host starts from source through `node --import tsx/esm`, it does not execute the Typert compiler plugin. Standard decorator initializers still record the method name and invocation mode in a versioned descriptor on the Service prototype, while `TypertRemoteService` or `bindTypertRemote()` supplies the explicit service binding; the Gateway can therefore construct a weaker temporary descriptor without starting a `ts.Program`. The descriptor's stable string property name lets `remoteMethods()` read markers written by another installed copy of the protocol package.

The SRC fallback parses simple parameter names from the live function. When a parameter name matches the `parameter` of a registered lookup, such as `agent` or `session`, it uses the lookup's `agentId` or `sessionId` wire field and resolves the object on the Host; other parameters are checked only for cycle-free, JSON-safe data with no special prototype. `@RemoteScope` directly uses the wire field of a registered Host Context provider. SRC does not read TypeScript types, generate Zod schemas, infer optional parameters, or support destructuring, default values, rest parameters, or duplicate parameter names.

SRC solves only dispatch for a Host process running from source. The Client does not discover decorators from the running Host, and the Client Remote refuses to mount SRC descriptors that lack strict codecs; its types, codecs, and Remote registration values always come from the most recently generated `lib/typert.remote-client.*` artifacts.

## Development mode

Web development prepares current Host, Client, and Web artifacts with `pnpm run build`, then runs the source Host and the Client plugin watcher in separate terminals:

```sh
pnpm dsh web
pnpm run dev:web
```

`dsh` starts the Host source through tsx, so the Host can use the SRC fallback; `dev:web` watches only Client plugins with a `dsh.client` declaration and rewrites their `lib/client.js`. It does not analyze Host decorators or generate Remote Client DTS.

Changing only a Remote method's implementation body without changing its contract does not require regenerating the Typert files. After adding or removing a decorator or changing an export name, namespace, parameter, return value, lookup, Context, or cancellation signature, rerun the ordered lib build so the Host generates the strict contract before the Client compiles and bundles the new contribution:

```sh
pnpm run build:lib
```

The running Client watcher consumes these generated files when it rebundles. If `pnpm run build:lib:host` has already refreshed the Host contract, `pnpm run build:lib:client` can complete the Client side; a clean worktree cannot skip the Host phase. Recompiling only the frontend source cannot infer new types from Host decorators. `pnpm run typecheck` runs the Host lib phase before Client tsc, and CI and release builds use the same order.

## Boundaries

Remote handles only unary method calls with one request and one result. Session event streams, pagination, incremental reduce, projection, and entity substreams require a separate data protocol and registration model; even when they reuse the Connection, they must not masquerade as Remote methods or enter invocation descriptors.

The API layers are organized as `remotes → gateway → connection → webserver`. The BFF and Typert RPC layers live under `packages/api`; Connection and WebServer live at `packages/client/connection` and `packages/host/webserver`. A feature that needs a streamed or browser-native response registers an exact Connection Fetch route instead of defining a Remote method.

Lookup policy is configured per key, so all `agent` or `session` parameters share the cold-resume behavior. Accepting live objects only would require an explicit per-parameter or per-endpoint policy, which does not exist; the business method must not guess whether the object came from restoration.
