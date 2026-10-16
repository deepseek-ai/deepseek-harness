# Agent Note: Peer principals and method-level Remote access control

Status: implemented

English | [中文](2026-10-12-peer-principal-and-remote-access.zh.md)

## Problem

A Remote method on the Host could not tell whom one call spoke for, and could not restrict callable methods by caller. The [`PeerScope`](../../../../packages/typert/protocol/src/types.ts) contract stated "Who the Peer is and what it may do are not recorded here"; [Connection](../../../../packages/client/connection/src/rpc-host.ts) had a single operator Peer, `admit()` returned it for every authenticated request, and the `/api` route and the interceptor's Fetch handler used it unconditionally instead of the admission result; [Gateway](../../../../packages/api/gateway/src/index.ts) silently fell back to `operatorPeer()` when a caller named no Peer.

The first non-owner caller is a liveshare viewer. Viewer requests reach the owner's liveshare Host plugin through the Relay, and the plugin dispatched them in the owner's process as the operator, so the owner's Session treated a viewer's prompt as the owner's own input. PR #3854 pushed liveshare semantics into session-controller for this: the request body carries `origin`, every prompt writes a required `prompt/origin` event correlated by requestId, the controller folds origins, `serializeAdmission` extends to every prompt, and a new `api-session/external-admission` hook appears; liveshare maintains its own `READ_ENDPOINTS` allowlist and trims list/follow results; the frontend `clientWritePolicy` lives in ui-conversation, with three ways of reading it across five packages and seven places that hide UI by whether a callback was injected.

One general mechanism is needed:

- In-process Host code assigns the caller identity; no wire field can set or override it.
- Every call path names its Peer explicitly; there is no implicit fallback.
- Method-level permission is computed and enforced in one place on the Host; the frontend reads the same result to show or hide entries and follows rule changes automatically.
- A prompt records its caller with the user message, so a later check can tell who initiated each turn.

## Decision

### Scope

| Part | Content |
|---|---|
| Peer identity | `PeerScope.principal` and `PeerScope.signal`; one Peer implementation `Peer` (renamed from `OperatorPeer`) with an options constructor; removal of the operator concept and every implicit Peer fallback; `connection.browserPeer`, `connection.createPeer()`, and `fetch(request, peer)`; a disposed Peer is always refused with `gateway/peer-disposed`; the `user-rpc` source records `principal?` |
| Method-level access control | `resources` readers on `@Remote`, `TypertResourceMap` resource kinds, and the `typert.resources` registry (typert-protocol, typert-registry); Gateway resolution of calls and forwarded events to resources; new package `@deepseek-ai/dsh-api-remote-access` (Host and Client faces): RBAC decisions over roles, bindings, and policies through `decide(request)`, list filtering through `allows()`, the first snapshot in the index and the access snapshot stream, and access hooks |
| Documentation | One code-review rule and terminology |

### Two layers: principal and peer

| Layer | Concept | Example | Cardinality |
|---|---|---|---|
| Authorization | principal: the caller identity that permission decisions read | `share-viewer{shareId, actor}` proven by a share token; the local user `{ kind: 'owner' }` | one principal has N peers |
| Connection | peer: the lifetime scope of one connection | a browser connection, one connection of a liveshare viewer | one peer per connection |

| Concern | Layer |
|---|---|
| Method-level decisions, access hooks, access snapshots | principal |
| Recording `source.principal` | principal |
| Subscriptions, streams, connection-lifetime registrations (`peer.ctx`) | peer |
| Revocation | both: after revocation the policy gives that principal no binding, so its calls are all refused; the creator disposes every peer under it |

The creator owns the principal→peers table; liveshare, for example, keeps one object per share grant that records every peer opened under it.

### Peer model

There is one Peer concept and one implementation; the operator concept is removed.

```text
// @deepseek-ai/dsh-typert-protocol
export interface PeerScope {
  readonly id: PeerId
  /** Connection-lifetime registrations; disposed with the Peer. */
  readonly ctx: Context
  /** Caller identity fixed at creation by in-process Host code; no wire field can set it. */
  readonly principal: Principal
  /** Aborted once the Peer is disposed; Remote streams that speak for the Peer end with it. */
  readonly signal: AbortSignal
  /** Forwarded human-interaction participation; independent of authorization. */
  readonly interactions: 'answer' | 'none'
  dispose(): Promise<void>
}

// @deepseek-ai/dsh-client-connection
export class Peer implements PeerScope {
  constructor(owner: Context, options: { readonly principal: Principal; readonly interactions?: 'answer' | 'none' })
}

interface HostConnectionHandle {
  /** The Peer every authenticated browser connection shares; principal { kind: 'owner' }. */
  readonly browserPeer: PeerScope
  /** Network admission: the admitted Peer or the refusal status. */
  admit(request: ConnectionTrustRequest): PeerAdmission
  /** In-process only; disposed with the Context that read `ctx.connection`, or earlier by dispose(). */
  createPeer(options: { readonly principal: Principal; readonly interactions?: 'answer' | 'none' }): PeerScope
}

interface ConnectionFetchHandler {
  fetch(request: Request, peer: PeerScope): Promise<Response>
}
bridge(req, res, apiHandler, peer, maxRequestBodyBytes?)

// @deepseek-ai/dsh-api-gateway
interface InvokeRemoteRequest { …; readonly peer: PeerScope }                 // was `peer?`
wireStream.open(endpoint, payload, uplink, peer: PeerScope, signal)          // was `PeerScope | undefined`
```

| Rule | Detail |
|---|---|
| Every path names its Peer | Network paths take it from `admit()`; in-process paths receive it from the caller. Gateway deletes `operatorPeer()` and `request.peer ?? …` and never creates a Peer |
| Browser connections share `browserPeer` | Every browser connection shares one Peer, and every use site names `connection.browserPeer` explicitly; there is no fallback variable. The in-page Host (webworker-runtime) also passes `browserPeer` explicitly |
| In-process Host automation | Code that calls Remote methods creates its own Peer with `createPeer({ principal })`. No production caller exists yet, so no fixed Host Peer is pre-provisioned |
| Multiple Peers | Each `createPeer()` returns an independent Peer; liveshare is to create one per viewer connection (wired on the #3854 side) |
| Interaction participation | `Peer(owner, { principal, interactions? })` and `createPeer()` default omitted `interactions` to `answer`. `none` refuses `$events` and `$events/result` for every principal, even owner; this is independent of method-level RBAC. Answering owner Peers receive waterfalls, and non-owner Peers receive only RBAC-authorized broadcasts and cannot answer |
| Exact Fetch routes | Exact routes such as file-upload, present-open, media-references, session-log-export, and inspector bypass the Gateway; the shared Fetch handler answers 403 to every non-owner Peer |

### Identity types

```text
// @deepseek-ai/dsh-typert-protocol

/**
 * Merge-extensible caller identities. Each driver declares its own entry.
 * Every entry is a JSON value with a unique literal `kind`, carries no
 * credential, and is safe to persist in a Session log.
 */
export interface PrincipalMap {
  owner: { readonly kind: 'owner' }
}
export type Principal = PrincipalMap[keyof PrincipalMap]

/**
 * @param invocation - `ctx.invocation`; `undefined` outside a Remote call.
 * @returns the caller's principal when it is not the owner; `undefined` for the
 *   owner and for trusted in-process code outside a Remote call.
 */
export function principalOf(invocation: RemoteInvocation | undefined): Principal | undefined
```

The single read point is `this.ctx.invocation.peer.principal`; an owner test is written inline as `principal.kind === 'owner'`, and an unknown kind is never the owner. External drivers extend `PrincipalMap` by declaration merging in their own package; liveshare's `share-viewer{ shareId, actor }` is declared on the #3854 side, and liveshare itself is unchanged here.

### Peer lifetime and revocation

| Event | Behavior |
|---|---|
| Gateway dispatch | The first step checks `peer.signal.aborted` and refuses a disposed Peer with `gateway/peer-disposed`, on HTTP, WebSocket, and in-process paths alike; wire paths check before they read the payload, so a malformed payload from a disposed Peer gets the same code |
| Streams when a Peer is disposed | The signal a Remote stream method observes joins `peer.signal`, and so does the `$events` stream lifetime; a WebSocket still closes with 1001 |
| Unary calls when a Peer is disposed | A unary call already running is not cancelled; later calls are refused |
| Revocation | After a business package revokes a grant, its policy gives that principal no binding, and the business package calls `invalidate(principal)`; the creator disposes every peer in its principal→peers table |

### Method-level access control

Resource types and the `resources` readers of `@Remote` live in `@deepseek-ai/dsh-typert-protocol`; resource kinds live in typert beside lookups and Contexts: `TypertResourceMap` declares the kinds, `typert.resources` holds each kind's default wire field, and lookups and Host Context adapters declare the resource kind their wire identity names. The Gateway resolves one call or forwarded event to the resources it touches. Decisions, list filtering, and the access snapshot live in the new package `@deepseek-ai/dsh-api-remote-access` (`packages/api/remote-access`), which reads no argument field. The Gateway and domain packages depend on remote-access only for types and inject `remoteAccess`; their only value dependency is `dsh-typert-protocol`, so `package-dependency-policy` gains no remote-access entry. Business packages define and register roles, bindings, and policies; liveshare is the first user. Apart from the built-in `global`, no resource-kind name appears in remote-access or the Gateway, which follows the [`packages/api` carries generic orchestration only](../../../../docs/defensive-patterns/remote-and-api.md) review rule.

#### Correspondence with RBAC

| This design | RBAC / IAM term | Meaning |
|---|---|---|
| principal | Subject / Principal | The caller identity, one entry of `PrincipalMap` |
| Peer | Session (RBAC session) | One connection of a principal; one principal has N Peers |
| owner | Superuser | Skips every check |
| action | Action / Permission | A Remote endpoint `ns/method`, or a forwarded event `event:<name>`; the Gateway still calls it an endpoint internally |
| resource | Resource / Object | `{ kind: 'global' }`, or `{ kind, id }` of a declared resource kind |
| role | Role | An action set over one resource kind; a plain value of the business package |
| binding | RoleBinding (role assignment) | The principal holds a role on a resource, optionally with a condition |
| condition | Condition (IAM Conditions) | Attached to a binding; allows by the request's action, resource, and arguments, or refuses with a reason |
| policy | Allow policy | The bindings and optional `explain` a business package gives for one non-owner principal kind |
| explain | Denial explanation | Names a refusal reason when no binding allows; never changes the decision |
| Gateway | PEP (Policy Enforcement Point) | Resolves resources and enforces the decision |
| remote-access | PDP (Policy Decision Point) | Computes decisions, list filtering, and access snapshots |

| Rule | Content |
|---|---|
| Default deny | A non-owner is allowed only when the role of some binding explicitly lists the action; an action no role lists, a resource without a binding, and a principal kind without a policy are all refused. Every Remote method is under access control; there is no separate accessibility marker |
| No inheritance between resources | `global` is not a parent of other resources: a grant on `global` implies no grant on any Session or Workspace, and a grant on a Workspace implies no grant on its Sessions |
| A `global` grant is an explicit global grant | A call that resolves to no resource touches `global`. Putting an action in a `global` role lets that principal call it without resource restriction, which is a high-risk grant; once the method is allowed, it can still decide each item inside with `allows(resource)` |

#### Resources and resource readers (`@deepseek-ai/dsh-typert-protocol`, `@deepseek-ai/dsh-typert-registry`)

```text
/** Merge-extensible resource kinds: the key is the kind, the value declares its identity type. */
export interface TypertResourceMap {}
//   @deepseek-ai/dsh-session/types:   session: TypertResource<SessionId>
//   @deepseek-ai/dsh-workspace/types: workspace: TypertResource<WorkspaceId>

// Runtime registries in typert
ctx.typert.resources.register(kind, { field }): TypertDisposer
ctx.typert.lookups.register(key, { parameter, wire, resource?, … })   // resource: the kind its wire id names
ctx.typert.contexts.registerHost(key, { wire, resource?, … })         // a TypertHostContextAdapter

export interface TypertHostContextAdapter<Wire = unknown> {
  readonly wire: string
  readonly wireTypeSymbol: string
  /** Resource kind the wire identity names; access checks read the identity from args before resolve(). */
  readonly resource?: TypertResourceKind
  resolve(id: Wire): Context | undefined | Promise<Context | undefined>
}

export type RemoteAccessResourceKind = 'global' | TypertResourceKind
export type RemoteAccessResource =
  | { readonly kind: 'global' }
  | { readonly kind: K; readonly id: TypertResourceId<TypertResourceMap[K]> }   // for each declared kind K
export type RemoteAccessResourceOf<K extends RemoteAccessResourceKind> = Extract<RemoteAccessResource, { readonly kind: K }>

/** Per-kind readers, called with the method's positional wire arguments. */
export type TypertResourceReaders<WireArgs extends readonly unknown[]> = {
  readonly [K in TypertResourceKind]?: (...args: WireArgs) => Id | readonly Id[] | undefined   // Id = TypertResourceId<TypertResourceMap[K]>
}

export interface RemoteMethodOptions<WireArgs extends unknown[]> {
  readonly name?: string
  readonly mode?: 'stream'
  readonly resources?: TypertResourceReaders<WireArgs>
}

export function Remote<This extends object, Args extends unknown[], Result>(
  option: string | RemoteMethodOptions<NoInfer<RemoteWireArgs<Args>>>,
): (method: (this: This, ...args: Args) => Result,
     context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>) => void

export interface RemoteScopeOptions<WireArgs extends unknown[]> {
  readonly name?: string
  readonly resources?: TypertResourceReaders<WireArgs>
}

export function RemoteScope<This extends object, Args extends unknown[], Result>(
  key: Extract<keyof TypertContextMap, string>,
  option?: string | RemoteScopeOptions<NoInfer<RemoteWireArgs<Args>>>,
): (method: (this: This, ...args: Args) => Result,
     context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>) => void
```

| Rule | Content |
|---|---|
| Syntax | `@Remote({ name: 'page', resources: { session: (request) => request.address.kind === 'session' ? request.address.sessionId : request.address.childSessionId } })`; a Context method writes `@RemoteScope('agent')` and gets its Session resource from the Agent Context's `resource: 'session'`, and writes `@RemoteScope('agent', { resources: { workspace: (request) => request.workspaceId } })` when it needs another resource. Most methods write no `resources` and get their resources from automatic resolution |
| Resource kinds | The lower-level packages that declare the identity types merge the resource kinds: `session: TypertResource<SessionId>` in `@deepseek-ai/dsh-session/types` and `workspace: TypertResource<WorkspaceId>` in `@deepseek-ai/dsh-workspace/types`. session-controller references the commands package, so a merge in session-controller would make commands reference session-controller and form a project-reference cycle. remote-access builds in `global`, which has no id and stays out of `TypertResourceMap`; typert reserves the name, and `typert.resources.register('global', …)` throws |
| Default fields and declarations | The domain that owns a kind registers its default wire field when its controller is constructed: the `SessionController` constructor calls `typert.resources.register('session', { field: 'sessionId' })` and the `WorkspaceController` constructor registers `workspace` → `workspaceId`; registering a kind twice throws. The Agent, Session, and `workspaceFileScope` lookups declare `resource: 'session'`, and the agent package's Agent Context declares `resource: 'session'` |
| Resolution precedence | Each resource kind takes, in order: ① that kind's reader in the method's `resources`; ② every lookup parameter that declares that kind as its `resource` contributes its wire identity, and an omitted optional lookup parameter contributes none; when the Context of a Context method declares that kind as its `resource`, the Context's wire identity contributes too; ③ that kind's default field: a top-level named argument of that name when one exists, otherwise that field of the first object argument. A default field names one identity, so an array there is an invalid value |
| Argument values | Resource resolution and the `args` of `decide()` read the named arguments validated against their Typert-compiled types: each JSON argument is decoded once by its codec, which drops object fields its type does not declare, and dispatch reuses that value, so a caller cannot change the resources with an undeclared field; lookup parameters and the Context identity keep their wire identities, and no lookup or Agent is resolved at that point |
| Resolution result | The resources of every kind together are the resources the call touches; with none, the call touches `[global]`; when resources resolve, only those are used and `global` is not added |
| Readers | Called with the method's positional arguments: the named arguments mapped by the descriptor back to the method's parameter order (the validated value in a JSON position, the wire identity in a lookup position, and the call's signal in the cancellation position); return one id, an id array (every one must be allowed), or `undefined` (no resource of that kind) |
| Invalid values | A reader that throws or returns an empty array, or a read value (including a Context's wire identity) that is not a non-empty string, makes the resources invalid: the Gateway refuses the call with `remote-access/denied` (reason `resource-invalid`) without asking `decide()` |
| Completeness | `resources` and automatic resolution must cover every resource the method touches. A call that resolves no resource falls to `global`, which only a `global` role can allow, so it is refused by default; when only some resources resolve, the rest go unchecked and a principal granted on the resolved resources can reach them, which the method author must prevent |
| Type inference | The parameter types of `@Remote` and `@RemoteScope` readers are inferred from the decorated method: the factory parameter uses `NoInfer`, so `Args` is inferred only from the returned decorator; lookup parameters map to wire types through `TypertLookupMap` (for a method whose first parameter is `agent: Agent`, the reader's first parameter is `SessionId`). A missing property, more parameters than the method has, and a `global` key fail compilation |
| Storage | `resources` readers live on the class prototype with the other `@Remote` / `@RemoteScope` metadata, are recorded on instance construction, and are safe across duplicate installations; they do not enter Typert artifacts |
| Context methods | `@RemoteScope(key, option?)` matches `@Remote`: a string is the export name and an object is `{ name?, resources? }`. A Context's wire identity takes part in resolution like a lookup parameter that declares a `resource`, with the same precedence, and a `resources` reader for that kind overrides it; the Gateway reads that identity directly from args before `resolveReceiverContext`, so no Agent is activated. A Context that declares no `resource` contributes no resource from its identity, and the method resolves by the ordinary rules |

#### Endpoint resources

The table lists the endpoints #3854 viewers use and where their resources come from. Only `session/page` and `session/follow` need explicit `resources`; the rest rely on a lookup's `resource` or the default field:

| Endpoint | Resource | Resolution source | Filtering inside the method |
|---|---|---|---|
| `workspace/follow` | `global` | no resource | yes: Workspaces and Sessions |
| `session/control` | `global` | no resource | yes: Sessions |
| `session/list` | `global` (`_request` has no `sessionId`) | no resource | yes: Session rows |
| `session/modelCatalog` | `global` | no resource | no |
| `session/canOpenWorkspacePath` | `global` | no resource | no |
| `llm/listConfigurableProviders` | `global` | no resource | no |
| `llm/listProviders` | `global` | no resource | no |
| `commands/list` | session: `args.agentId` (the Agent lookup's wire field) | Agent lookup `resource: 'session'` | no |
| `goals/get` | session: `args.agentId` | Agent lookup `resource: 'session'` | no |
| `session/attachment` | session: `args.request.sessionId` | default field | no |
| `skills/list` | session: `args.request.sessionId` | default field | no |
| `session/fork` | session: `args.request.sessionId` | default field | no |
| `session/prompt` | session: `args.request.sessionId` | default field | no |
| `session/cancel` | session: `args.request.sessionId` | default field | no |
| `session/projections` | session: `args.request.sessionId` | default field | no |
| `session/page` | session: `args.request.address.sessionId` for a Session address; `args.request.address.childSessionId` for a subagent address | `resources` | no |
| `session/follow` | same as above | `resources` | no |
| `remoteAccess/follow` | `global` | no resource; remote-access allows it for every principal | no |

A subagent address reads the child transcript, so its resource is the child Session. A Client rereads the projections of known Sessions after a reconnect, including the parent of a subagent Session; a reader without a grant on that parent has its projection read refused. Whether a grant on a parent Session covers its subagent children is the policy's decision, that is, whether it gives a binding for the child Session; the generic layer derives no parent resource.

Methods that need no non-owner access declare nothing, and a method no role lists is refused. The request fields of subagent `prompt` are `parentSessionId` / `childSessionId`, so automatic resolution finds no Session and resolves it to `global`; it must therefore stay out of every `global` role. `session/search` filters its hits per Session inside the method. `subagents/list` is not a Remote endpoint (`SubagentRuntime.list()` carries no `@Remote`).

#### Roles, bindings, and policies (`@deepseek-ai/dsh-api-remote-access`)

```text
/** Remote endpoint `ns/method`, or `event:<name>` for one forwarded event; endpoint segments never contain `:`. */
export type RemoteAccessAction = RemoteAccessEndpoint | `event:${string}`

/** A named action set over one resource kind; a plain value owned by the business package. */
export interface RemoteAccessRole<K extends RemoteAccessResourceKind> {
  readonly name: string
  readonly resource: K
  readonly actions: readonly RemoteAccessAction[]
}

/** Answer of decide() and of a condition. */
export type RemoteAccessDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }

/** Refines one binding for one action on its resource; `args` only for a concrete call. */
export type RemoteAccessCondition<K extends RemoteAccessResourceKind> = (request: {
  readonly action: RemoteAccessAction
  readonly resource: RemoteAccessResourceOf<K>
  readonly args?: Readonly<Record<string, unknown>>
}) => RemoteAccessDecision

/** One role on one resource of the role's kind; the resource type follows from the role. */
export type RemoteAccessBinding = {
  [K in RemoteAccessResourceKind]: {
    readonly role: RemoteAccessRole<K>
    readonly resource: RemoteAccessResourceOf<K>
    readonly condition?: RemoteAccessCondition<K>
  }
}[RemoteAccessResourceKind]

/** One access question; the Gateway passes only valid resources, [global] when none. */
export interface RemoteAccessRequest<P extends Principal> {
  readonly principal: P
  readonly action: RemoteAccessAction
  /** Allow only when the action is allowed on every listed resource. */
  readonly resources: readonly RemoteAccessResource[]
  /** Named arguments of a concrete call, validated against their Typert-compiled types with lookup parameters as wire identities; absent for events, snapshots, and list filtering. */
  readonly args?: Readonly<Record<string, unknown>>
}

/** Business rules for one non-owner principal kind; synchronous over in-memory state. */
export interface RemoteAccessPolicy<P extends Principal> {
  bindings(principal: P): readonly RemoteAccessBinding[]
  /** Reason for a request no binding allows; never changes the decision. */
  explain?(request: RemoteAccessRequest<P>): string | undefined
}

/** details of `remote-access/denied` */
export interface RemoteAccessDeniedDetails {
  readonly action: string
  readonly reason: string
}

class RemoteAccessService {            // ctx.remoteAccess; Remote namespace remoteAccess
  registerPolicy<K extends Exclude<keyof PrincipalMap, 'owner'>>(kind: K, policy: RemoteAccessPolicy<PrincipalMap[K]>): () => void
  invalidate(principal?: Principal): void
  decide(request: RemoteAccessRequest<Principal>): RemoteAccessDecision   // Gateway-only
  allows(resource: RemoteAccessResource): boolean              // reads the accessing ctx's invocation
  snapshotFor(principal: Principal): RemoteAccessBaseline      // a page's opening baseline
  follow(signal): AsyncIterable<RemoteAccessFrame>             // remoteAccess/follow
}
```

| Rule | Content |
|---|---|
| Owner | The Gateway does not resolve resources or call `decide()` for the owner, and reads no policy |
| Registration | `registerPolicy(kind, policy)` returns a disposer, and a business package calls it inside `ctx.effect()`. Each non-owner principal kind has at most one policy, and a second registration for the same kind throws; `bindings()` and `explain()` receive principals typed by the kind |
| Built-in allow | `remoteAccess/follow` is allowed for every principal, so every Peer can read its own snapshot |
| Decision | A principal kind without a policy is refused with `no-allow`. Otherwise `bindings(principal)` is read, and a linear scan finds for each requested resource one binding whose resource is equal (the same `kind` and, for a non-`global` resource, the same `id`), whose role's `actions` contains the action, and that has no condition or whose condition allows; the request is allowed only when every resource has one (AND). A condition runs only for a binding whose resource is equal and whose role contains the action |
| Refusal reason | The first resource not allowed decides the reason, in this precedence: when matching bindings exist on that resource but all their conditions refuse, the first condition's reason; otherwise the return value of `explain(request)`; without `explain`, or when it returns `undefined`, `no-allow`. `explain` runs only after the decision is already a refusal and never changes it |
| Failure isolation | When `bindings()`, a condition, or `explain()` throws, the decision is refused with `policy-failed`; in a snapshot computation, a throwing `bindings()` leaves that principal no grant and a throwing condition excludes that action. A faulty rule therefore never breaks the shared `$events` source, a snapshot stream, or page rendering; after each `invalidate()` or policy change, the first failure of each policy is logged once |
| Synchronous | `bindings()`, conditions, and `explain()` return synchronously from state the business package preloads in memory, so list filtering can decide per item and snapshots can be computed |
| Evaluation timing | Each `decide()`, each `allows()`, and each snapshot computation calls `bindings()` once, with no caching; time-dependent state (such as expiry) applies immediately, and a long stream (such as `workspace/follow` or `session/control`) reflects added or removed bindings at its next per-item decision; snapshots are recomputed only after `invalidate()`, so a business package also calls `invalidate()` when a time event such as expiry happens |
| Notification | When a business state change (grant, revocation, mode switch) alters a binding or a condition's answer, the business package must call `invalidate(principal?)`; snapshots are recomputed only after `invalidate()` and policy registration or removal |
| `remote-access/denied` | Only a call refusal becomes an error, with details `{ action, reason }`, where reason is the reason a condition or `explain` gave, `no-allow`, `policy-failed`, or the `resource-invalid` the Gateway gives for invalid resources; a refused event is simply not pushed |
| Required service | The Gateway declares `static inject = ['typert', 'remoteAccess']`; a composition that mounts the Gateway mounts remote-access, which [`bundle/base`](../../../../packages/bundle/base/cordis.patch.yml) assembles right after `typert-gateway`; the plugin manager protects it like the Gateway, so it cannot be disabled from the Plugins page |

#### Example: share viewer

The `share-viewer` principal that liveshare declares shows that the derivation from business state to bindings stays in the business package; `shares` in the example stands for the share state the business package holds in memory:

```text
const globalReader    = { name: 'share:global-reader',    resource: 'global',    actions: ['session/list', 'session/control', 'workspace/follow', 'session/modelCatalog', 'llm/listProviders', 'commands/list'] }
const sessionReader   = { name: 'share:session-reader',   resource: 'session',   actions: ['session/page', 'session/follow', 'session/list', 'session/control', 'workspace/follow', 'commands/list', 'event:api-session/status', 'event:api-session/added'] }
const workspaceReader = { name: 'share:workspace-reader', resource: 'workspace', actions: ['workspace/follow'] }
const forker          = { name: 'share:forker',           resource: 'session',   actions: ['session/fork'] }
const writer          = { name: 'share:writer',           resource: 'session',   actions: ['session/prompt', 'session/cancel'] }

ctx.effect(() => ctx.remoteAccess.registerPolicy('share-viewer', {
  bindings(viewer) {
    const share = shares.serving(viewer)              // undefined once stopped, expired, or no longer admitted
    if (share === undefined) return []
    const source = { kind: 'session', id: share.sessionId }
    return [
      { role: globalReader, resource: { kind: 'global' } },
      { role: sessionReader, resource: source },
      ...(share.allowsFork ? [{ role: forker, resource: source }] : []),
      ...(share.mode === 'write' ? [{ role: writer, resource: source, condition: sourceWrite(share) }] : []),
      ...shares.forksOf(viewer).flatMap(child => [
        { role: sessionReader, resource: { kind: 'session', id: child.id } },
        ...(child.revoked ? [] : [{ role: writer, resource: { kind: 'session', id: child.id }, condition: childPrompt(child) }]),
      ]),
      ...shares.workspacesShowing(viewer).map(id => ({ role: workspaceReader, resource: { kind: 'workspace', id } })),
    ]
  },
  explain({ principal, action }) {
    return shares.refusal(principal)                  // 'share-expired', 'share-stopped', …
      ?? (action === 'session/prompt' ? 'share-not-writable' : undefined)
  },
}))

// Without args (snapshots, list filtering) a condition answers for the action alone.
const sourceWrite = share => () => share.confined ? allow : deny('source-write-unavailable')
const childPrompt = child => ({ action, args }) =>
  action === 'session/prompt' && args !== undefined && !child.allowsPrompt() ? deny('fork-prompt-refused') : allow
```

| Owned by | Content |
|---|---|
| Business package | The action lists of roles; the derivation from share state to bindings (stop, expiry, admission, mode, the viewer's own forks, revocation, Workspaces containing visible Sessions); per-request conditions; refusal reasons for the viewer page |
| Generic layer | Resource resolution, AND across resources, role and action matching, condition calls, reason precedence, list filtering, snapshot computation, and failure isolation |

That viewer's snapshot contains grants on `global`, the source Session, each of its own forks, and each visible Workspace; `session/list` appears in both a `global` role and a session role, see [List and aggregate methods](#list-and-aggregate-methods).

#### Host access-check order

Every call path (HTTP `/api`, WebSocket streams, in-process `fetch(request, peer)` / `invoke` / `stream` / `wireStream.open`) passes through one Gateway sequence:

| Step | Action | Failure |
|---|---|---|
| 1 | Admission yields the Peer: network paths from Connection `admit()` (`browserPeer`), in-process paths from the caller. The Gateway checks `peer.signal` before it reads the wire payload | Failed network admission answers HTTP 401 / 403 without entering the Gateway; a disposed Peer: `gateway/peer-disposed` |
| 2 | Resolve the endpoint and validate the argument field set (`resolveDescriptor`, `assertExactArguments`), then validate the JSON arguments against their Typert-compiled types, decoding each once | `gateway/invocation-unavailable`, `gateway/ambiguous-endpoint`, `gateway/definition-unavailable`; extra or missing fields: `gateway/arguments-invalid`; a JSON argument failing validation: `gateway/input-invalid` (for owners and non-owners alike, before the access check) |
| 3 | Owner pass-through: for `principal.kind === 'owner'` go straight to step 5 | — |
| 4 | Non-owner: the Gateway resolves resources from the arguments validated in step 2 (`resources` readers, then lookup parameters and the `resource` a Context declares, then default fields; lookup and Context identities are wire identities, and neither a lookup nor the Context is resolved), then asks `remoteAccess.decide({ principal, action: endpoint, resources, args })` with the validated arguments as `args`; invalid resources are refused with `resource-invalid` without asking `decide()`; a `deny` decision becomes the thrown error | `remote-access/denied` with details `{ action, reason }` |
| 5 | Dispatch: `resolveReceiverContext` (which can activate an Agent), lookup resolution (JSON arguments reuse the step 2 values), and the method call | Existing codes unchanged, such as `gateway/lookup-not-found`, `gateway/context-not-found`, `gateway/input-invalid`, `gateway/service-unavailable`, `gateway/method-unavailable`, and business errors |

The access check (steps 3–4) precedes lookup and Context resolution, so a refused call activates no Session and causes no other side effect. The only new Gateway error code is `gateway/peer-disposed`; remote-access declares the refusal code `remote-access/denied`.

Gateway-owned endpoints: a non-owner may subscribe to `$events` but never receives waterfall frames it could answer; `$events/result` from a non-owner is refused with the existing `gateway/invocation-unavailable`; both run the step-1 check.

#### Forwarded events

An `emit` entry of `API_REMOTE_FORWARDED_EVENTS` may declare `resources`: readers keyed by resource kind and typed by that event's own parameters through `TypertForwardableEventEntry`, for example `{ event: 'api-session/added', mode: 'emit', resources: { session: (summary) => summary.sessionId } }`. API Remotes attaches the readers to each forwarded frame; for every non-owner `$events` stream the Gateway resolves the resources once per frame and pushes the frame only when `remoteAccess.decide({ principal, action: 'event:<name>', resources })` allows it.

| Rule | Content |
|---|---|
| Declared events | `api-session/activity`, `api-session/added`, `api-session/error`, `api-session/removed`, and `api-session/status` declare their Session |
| Undeclared resources | An event without `resources`, or with an empty `resources: {}`, touches `global` and reaches a non-owner only when a `global` role lists `event:<name>` |
| Missing resource | An event carries every resource it declares, so a reader returning `undefined` makes the event's resources invalid, and the Gateway delivers it to no non-owner without asking `decide()`; a call missing a resource touches `global` instead |
| Whole or nothing | An allowed event arrives with its payload unchanged; no payload is trimmed or projected per Peer |
| One resource per event | A notification carries at most one resource; collection changes travel on follow streams (`session/follow`, `session/control`, `workspace/follow`), whose methods decide each item inline through `allows()` |
| Waterfalls | Non-owners never receive waterfall frames, and no policy decides them |
| Non-owner stream facts | A non-owner `$events` stream opens with the same `host` as an owner stream, including `home`; `hasLiveClient()` counts only owner streams, the ones that can answer waterfalls |

<a id="list-and-aggregate-methods"></a>
#### List and aggregate methods

Calls of list, paging, and aggregate methods resolve to `global` and are allowed by a `global` role; inside, the method calls `this.ctx.remoteAccess.allows(resource)` for every item to decide whether the current call's action is granted on that resource (without args). A list action therefore appears both in a `global` role (allowing the call) and in resource roles (allowing each item): `session/list` must be granted on `global` to be called, and each Session row also requires `session/list` granted on that Session. `allows()` reads the invocation on the Context that accessed the service; it is always true for the owner and for in-process code outside a Remote call, which are not filtered.

| Method | Filtered items |
|---|---|
| `session/list` | Session rows (`session` resource) |
| `session/search` | search hits (`session` resource) |
| `session/control` | baseline projections and projection increments (`session` resource) |
| `workspace/follow` | Workspaces in the baseline, `upsert` frames, and `order` ids (`workspace` resource), the Sessions inside Workspaces, and the archived / pinned Session sets (`session` resource). The stream tracks the Workspaces it delivered; when one is no longer allowed at its next change or in a new order, it sends a `replace` increment with the complete filtered state instead of a `remove`, because the Client never resurrects a removed id, and the Workspace reappears through an ordinary `upsert` once access returns. A `remove` frame reports a deletion and reaches only a caller that received that Workspace |

#### Access snapshot stream

```text
// Remote: remoteAccess/follow (stream; every Peer may read its own snapshot)
type RemoteAccessFrame =
  | { readonly type: 'baseline'; readonly owner: true }
  | { readonly type: 'baseline'; readonly owner: false; readonly grants: readonly RemoteAccessGrant[] }
  | { readonly type: 'upsert'; readonly grant: RemoteAccessGrant }
  | { readonly type: 'remove'; readonly resource: RemoteAccessResource }

interface RemoteAccessGrant {
  readonly resource: RemoteAccessResource    // global, or one declared-kind resource
  readonly actions: readonly string[]        // endpoint actions allowed on this resource without args, sorted
}

/** Window global carrying a page's opening baseline. */
export const REMOTE_ACCESS_SNAPSHOT_KEY = '__DSH_REMOTE_ACCESS__'
```

| Behavior | Detail |
|---|---|
| First snapshot | `snapshotFor(principal)` computes a page's opening baseline. remote-access adds the global `REMOTE_ACCESS_SNAPSHOT_KEY`, set to the owner baseline `{ type: 'baseline', owner: true }`, to every index the webServer renders, through `webserver/index-inject`. A business package that renders a non-owner page (such as liveshare on the owner Host) places an assignment of that global to `snapshotFor(principal)` after every index injection row; the later assignment wins, and the Client reads the global when it mounts |
| Subscription | Each Peer subscribes to one access snapshot stream, whose baseline replaces the injected one |
| Computation | All bindings of the policy for the principal's kind are merged by equal resource; each resource's `actions` are the endpoint actions of those bindings' roles that the same decision as a call allows (one resource, without args, conditions called without args); only a resource with at least one allowed endpoint action gets a grant. Decisions and snapshots share one source: for the same principal, action, and resource (without arguments), the snapshot answer equals `decide()` |
| Endpoint actions only | `event:<name>` actions do not enter the snapshot; the frontend decides entry visibility from endpoint actions only |
| Increments | `invalidate()` or a policy registration or removal recomputes and pushes `upsert` / `remove`, and a resource whose allowed set becomes empty pushes `remove`; unchanged resources push nothing |
| Lifetime | A generation ends when its signal aborts or when the remote-access service unloads, so a reloaded service answers every reader from a fresh baseline; the Client treats the end as a carrier loss and reconnects |
| Owner | Receives only `{ owner: true }`, so every frontend answer is true |
| Wire type | `actions` is `readonly string[]`: Typert cannot generate a codec for template-literal types |

Access hooks judge only by action and resource and never look at call arguments; at call time a condition may also read args for a finer decision, and the Host result prevails.

#### Client face

The Client uses framework standard-hook injection and no React context. Components receive hooks only through props and import no remote-access value.

```text
// @deepseek-ai/dsh-api-remote-access/client
interface ClientRemoteAccess {            // Client service ctx.remoteAccess
  source(kind: TypertResourceKind, id: string, action: string): HostObservable<boolean>
}
GlobalStandardProps.useRemoteAccess: (action: RemoteEndpoint) => boolean                  // remote-access; the global resource

// @deepseek-ai/dsh-client-ui-session (injects remoteAccess)
GlobalStandardProps.useSessionAccess: (sessionId: SessionId, action: RemoteEndpoint) => boolean
SessionStandardProps.useAccess: (action: RemoteEndpoint) => boolean
SessionMaybeStandardProps.useAccess: (action: RemoteEndpoint) => boolean | undefined

// @deepseek-ai/dsh-client-ui-workspace (injects remoteAccess)
GlobalStandardProps.useWorkspaceAccess: (workspaceId: WorkspaceId, action: RemoteEndpoint) => boolean

// RemoteEndpoint = Extract<keyof TypertRemoteMap, string>
```

| Concern | Decision |
|---|---|
| Snapshot and mount | The remote-access Client plugin starts from the baseline the index injected (read synchronously at startup and validated), follows the snapshot stream, applies each baseline in one pass, provides the Client service `ctx.remoteAccess.source(kind, id, action)` (an identity-stable boolean source), and injects `useRemoteAccess` on the `global` resource. The entry module imports the generated `/remote` contribution and hands it with the injected baseline to `mountAccess(ctx, contribution, initial)`, which mounts it through `ctx.remote.$mount` (unit specs pass a fake contribution), following experimental client-ui-cot-translation, voice-input, and claude-code-mods; a central mount in api/remotes would form the project-reference cycle ui-session → api/remotes → remote-access → ui-session |
| Session resource | ui-session gives the bound Session's answer through `uiSession.provide({ keyedHooks: ['access'], resolve })`; the framework binds the Session as it does for `useProjection`. `useSessionAccess` is injected through `provideRoot` |
| Workspace resource | ui-workspace injects `useWorkspaceAccess` through `provideRoot` |
| Distinct names | The `global` answer is `useRemoteAccess` and the Session answer is `useAccess`, so neither shadows the other; in a session-maybe scope without a Session, `useAccess` is `undefined`, which callers treat as not allowed, and a `global` decision reads `useRemoteAccess` |
| Two-argument calls | Framework keyed hooks take a standard second argument: `KeyedStandardSource` is `(key, member?) => source`; a string second argument makes the hook read the resolver's `(key, member)` source without a selector, and the resolver returns the same source for the same arguments. Existing `(key, selector?, equal?)` and `(selector, equal?)` calls are unchanged. Curried forms are forbidden |
| Return value | Every answer on a resource is a boolean; action types come from the `ctx.remote` namespaces and methods |
| No fallback | Asking a Session resource about a non-session method (such as `useAccess('session/create')`) reads the decision on that Session resource and never falls back to the `global` answer |
| No snapshot | True for the owner, also after its stream fails terminally; a non-owner page without an injected baseline, or whose stream fails terminally, answers false, and the terminal failure is reported with its error and the advice to reload; a reconnect keeps the last snapshot; a malformed injected baseline fails the mount; the Host still checks every call. Hooks never issue requests |
| Example consumers | The ui-workspace Session row menu's fork entry reads `useSessionAccess(sessionId, 'session/fork')` and is not rendered when it is false; the ui-chat turn tail's branch button reads `useAccess('session/fork')` on the Session resource and is not rendered when it is false. Replacing #3854's `clientWritePolicy` stays with #3854 |
| Tests | `@deepseek-ai/dsh-client-test-runtime` exports `allowAllAccess` props and `allowAllAccessPlugin`; TestClient drops the remote-access row as it drops api-remotes and installs the allow-all service, and SlotTestRuntime installs it before ui-session |

### Security invariants

| Invariant | Basis and enforcement point |
|---|---|
| Only in-process Host code supplies a principal, when it creates a Peer | `PeerScope.principal` is read-only; `createPeer()` has no route |
| No wire field can set or override a principal | Principals never come from args, the envelope, headers, the query, or cookies. Extra top-level args fields fail `assertExactArguments`; the payload must be exactly `{ args }`; [`clientRequestSchema`](../../../../packages/client/connection/src/rpc-schema.ts) drops unknown envelope fields; a same-named field inside a request body is business data |
| Browser network admission yields the owner | Connections that pass [browser token authentication](../../implemented/architecture/2026-08-24-browser-token-authentication.md) receive `browserPeer` |
| No implicit Peer | Neither the Gateway nor Connection supplies a default Peer; required parameters expose a missing Peer at compile time |
| A disposed Peer cannot dispatch | `gateway/peer-disposed` |
| A non-owner cannot call without authorization | A call is allowed only when a binding's role explicitly lists the action and its resource matches; a kind without a policy is refused; the Gateway depends on `remoteAccess` and does not start without it |
| A `global` grant implies no resource grant | Resources do not inherit; `allows()` inside a method decides each item independently |
| An unknown principal kind is not the owner | Only `kind === 'owner'` is the owner |
| Non-owners answer no waterfall | `$events` gives non-owners no waterfall frame, and `$events/result` refuses them |
| A non-owner receives only authorized notifications | Each forwarded frame is decided by `event:<name>` and its resources, and reaches a non-owner only when allowed |

### Recording the message source

The `MessageSourceMap` entry in the [session-controller types](../../../../packages/api/session-controller/src/types.ts) gains an optional field:

```text
'user-rpc': {
  kind: 'user'
  rpcId: SessionRequestId
  clientTimeZone?: string
  /** Non-owner caller that submitted this prompt; absent means the owner. */
  principal?: Principal
}
```

Two producers build a `kind: 'user'` + `rpcId` user-message source inside a Remote call. Both call `principalOf(this.ctx.invocation)` in the Remote method and write `principal` only when it is defined:

| Producer | Location |
|---|---|
| `SessionController.prompt()` builds the source and `SessionCommandController.prompt(request, source)` only delivers it | [`session-controller/src/index.ts`](../../../../packages/api/session-controller/src/index.ts), [`commands.ts`](../../../../packages/api/session-controller/src/commands.ts) |
| subagent `prompt()` (`BrowserPromptSource`); no role lists it, so a non-owner reaches it only through in-process Host code, not through the Gateway | [`subagent/src/index.ts`](../../../../packages/subagent/subagent/src/index.ts) |

Business code does not pass a principal down as a function parameter: the identity is read once from the invocation in the Remote method, and the built source travels down. The Agent inbox has no interception point that could add the field on enqueue (`followup` / `steer` accept built messages, and in-process producers such as the SDK and scheduling run outside Remote calls), so each producer records it, and the code-review rule covers new producers.

| Fact | Detail |
|---|---|
| `kind` is unchanged | Still `'user'`; existing `kind === 'user'` checks are unaffected |
| Owner messages are unchanged | An owner call writes no field, so its source is byte-identical to the source before principals existed; a message without the field (including every older Session) is the owner's |
| Not part of model requests | LLM adapters read only the model source ([`llm-deepseek/src/replay.ts`](../../../../packages/llm/llm-deepseek/src/replay.ts)) |
| Session format | `SESSION_FORMAT_VERSION` is not bumped; per the [persistence type-change cookbook](../../../../docs/cookbook/reviewing-persistence-type-changes.md) the change records an acknowledgement |

Example consumer use, outside this Note's scope: tool guards and pre-step rechecks read `source.principal` of the user messages in a turn and judge by the non-owner caller when any message carries one; a turn mixing owner and viewer messages takes the strictest.

### Code-review rule and documentation

The review rule's home is the "`@Remote` marks capability methods" section of [Remote and API rules](../../../../docs/defensive-patterns/remote-and-api.md): `@Remote({ resources })` and automatic resolution must cover every resource a method touches; aggregate results filter every item through `allows()`; the caller identity is read only from `invocation.peer.principal`, never from arguments; every call path names its Peer explicitly; business code does not pass a principal as a function parameter.

| Document | Content |
|---|---|
| [`docs/subsystems/typert.md`](../../../../docs/subsystems/typert.md), [`docs/api-gateway.md`](../../../../docs/api-gateway.md) | `PeerScope`, `RemoteInvocation`, `InvokeRemoteRequest`, explicit Peers, `resources` on `@Remote`, and the access-check order |
| READMEs of connection, gateway, typert-protocol, typert-registry, api-remotes, remote-access, session-controller, workspace-controller, ui-session, ui-workspace, ui-slots, and client-test-runtime | Peer / `browserPeer` in place of the operator; the remote-access role, binding, and policy contract; access hooks |

### Out of scope and future work

- The API-only `/connect` handshake, API cookies, one Peer per API connection, and WebSocket lifetimes are described in [Peer-scoped connect handshake](2026-10-09-operator-scoped-connect-handshake.md).
- Multiple browser Peers (such as one per tab): every browser connection shares `browserPeer`.
- Interaction participation is attached to each Peer. A non-owner with `interactions: 'answer'` still receives only RBAC-authorized broadcast frames and cannot answer owner waterfalls; per-principal approval handling remains outside this mechanism.
- `agent-preset/selected` and the other forwarded events declare no resources and are decided on `global`; when its viewers need a Session event, #3854 declares that event's resources and lists `event:<name>` in a role.
- Liveshare integration (declaring `share-viewer`, one Peer per viewer connection, defining roles and registering a policy, removing `origin` / `prompt/origin` / `READ_ENDPOINTS`) happens on the #3854 side.
- `session/cancel` ownership checks, the fork `childSessionId`, and `ToolExecutionInput.turn` do not change.
- Precise resource recognition (for example, the Typert generator locating request fields by branded id type and writing them into descriptors): this change uses the `resource` that lookups and Contexts declare, default fields, and `resources` readers, and resource resolution can later be replaced without changing the policy interface.
- Answering 403 to every non-owner on exact Fetch routes is temporary; each route is to declare its own access rule later.
- The resource declaration of subagent `prompt` is open: its request fields are `parentSessionId` / `childSessionId`, so it currently resolves to `global`. The producer records `source.principal` for in-process callers; no role lists it, so non-owners cannot reach it through the Gateway.
- Predefined and aggregate roles: when a second non-owner principal kind appears, domain packages declare the generic roles a method belongs to (such as `session:viewer`) with `@Remote({ roles })`, and each policy binds those roles; roles are currently defined by the business package as explicit action lists.

### Relation to existing Notes

- [Remote duplex stream](../../implemented/architecture/2026-09-19-remote-duplex-stream.md): partially superseded. The replaced parts are "the Peer records no identity or permission", "this Host has exactly one Peer, the operator", "an in-process carrier without a Peer means the operator", and its alternative stating that "the Access mechanism is business semantics"; the rest (the duplex stream, uplink, and `ctx.invocation` binding) stands. Both Notes stay active and cross-linked, and that Note's current facts are updated.
- [Browser token authentication](../../implemented/architecture/2026-08-24-browser-token-authentication.md): unaffected. Its rejection of per-method privilege concerns owner authentication; an authenticated browser is still the owner and is not checked per method.
- [Typert Remote method calls](../../implemented/architecture/2026-08-02-typert-remote-method-calls.md): unaffected; `@Remote` and `@RemoteScope` gain optional `resources` readers (the second argument of `@RemoteScope` may be `{ name?, resources? }`), read only by the Gateway's access check, and change neither endpoint naming, call modes, nor generated artifacts.
- [Producer-owned message sources](../../implemented/architecture/2026-09-09-producer-owned-message-sources.md): unaffected; the producer that builds a source writes `principal`.

## Alternatives considered

**A separate `prompt/origin` event correlated by requestId (the #3854 approach).** Every prompt writes a required event, so even ordinary Sessions become unreadable by older versions; correlation serializes every prompt and maintains an origin fold, and messages outside the fold window lose their initiator.

**Principal and peer as parallel invocation fields.** One caller's identity would have two sources; every admission point would have to produce and pass both, and a path that passes only one would mismatch them.

**Keep "the Peer records no identity".** When business plugins attach identity through `peer.ctx`, every reader must know who attached it and how to read it, and the wire admission path cannot guarantee the attachment happened.

**Keep a default-Peer fallback (`request.peer ?? …`).** An implicit default silently grants owner identity to a call that forgot its Peer; a required parameter turns the omission into a compile error.

**A new source kind.** Every existing `kind === 'user'` check would need review, and one miss makes viewer messages disappear from titles, outlines, queues, or chat rendering.

**Identity in a request-body field.** Any caller able to build a request body could forge or override it.

**React context for frontend resources.** Business components read no React context; the framework binds standard hooks per resource, and components receive them only through props.

**Driver-maintained endpoint allowlists that trim results (the #3854 approach).** The allowlist and the result trimming both live in the driver, the Gateway does not enforce them, and the snapshot and the frontend each derive their own; the generic layer enforces role action lists, and `allows()` inside the method performs list filtering.

**Business packages implement `decide()` / `abstain` providers whose answers are merged.** Each business package hand-writes action × resource branches plus a separate resource list for snapshots, and the two stay consistent only by hand; a policy gives only bindings, decisions and snapshots are computed from the same bindings, and each principal kind has one policy, so no merge rule is needed.

**A separate `@RemoteAccess` marker.** Role action lists already guarantee default deny, so a marker is only a second consent; a method that resolves no resource falls to `global`, and only an explicit global grant allows it. Resource readers describe the method, so they live on `@Remote`.

**Calling resource-less calls `page` or `host`.** `page` describes a frontend location, not a resource; `host` reads easily as the parent of every resource on this Host. `global` means a grant tied to no resource.

**Resource inheritance (GCP style: a grant on `global` or on a Workspace covers lower resources).** List methods allowed by a `global` grant must decide each item, and inheritance would make any `global` grant imply every Session; without inheritance, a binding grants each resource explicitly.

**A role registry and predefined aggregate roles.** The only non-owner principal today is managed by one business package, so roles can be plain values of that package; aggregate roles would let methods a new package declares enter a share viewer's reach automatically, so they wait for a second non-owner principal kind.

**Conditions attached to a role's actions.** A role stays reusable plain data; a refinement by business state belongs to the binding that grants the role to a principal.

**Refusal reasons from conditions only.** Without a binding there is no condition to give a reason, so a viewer page could not tell "share expired" from "share not writable"; `explain` gives a reason only after the decision is already a refusal and never changes it.

**A global resource-resolver registry (domain packages register recognizers by field name).** Field recognition separates from the method, nothing flags a method signature change, and same-named fields in other packages are misread; resource resolution uses a default convention on the method plus per-method `resources`, and a domain package registers only its own kind's default field.

**Dot-path resource declarations (`'request.address.sessionId'`).** Types cannot constrain a path; the parameter types of `resources` readers are inferred from the decorated method, so a typo fails compilation.

**Generator recognition of resource fields by branded id type.** Requires changing Typert artifacts and the descriptor format, and SRC descriptors carry no types; kept as future work.

**A central mount of the remote-access generated contribution in api/remotes.** The remote-access Client depends on ui-session and ui-session depends on api/remotes, so a central mount forms a project-reference cycle; remote-access mounts its own contribution instead.

**Decisions inside the Gateway (a `check()` with rules written in the Gateway).** The Gateway would carry access-control semantics and extra error codes; it resolves resources as it resolves lookups and calls `remoteAccess.decide()` before dispatch, and the rules and refusal code belong to remote-access.

**Asynchronous policy decisions.** List filtering and snapshot computation need synchronous answers; business packages preload asynchronous state into memory.

**On-demand permission queries from the frontend.** Request volume grows with the number of entries and cannot follow rule changes; the Host pushes a snapshot stream and the frontend reads it synchronously.

**An access check after lookup resolution.** A lookup can activate an Agent, so an unauthorized call would cause side effects first.

**Resource fields registered in remote-access (`registerScope`).** The access package would recognize argument fields although lookups already know which wire field names a Session; typert holds resource kinds beside lookups and Contexts, so the Gateway resolves calls and events in one place and remote-access reads no argument field.

**Trimming forwarded event payloads per Peer.** A per-event projection would repeat list filtering inside every notification; an event carries at most one resource and is delivered whole or not at all, while collection changes travel on follow streams that filter inline.

**Answering true until the first snapshot arrives.** A non-owner page would briefly show entries it cannot use; the index carries the first snapshot, so a page without one has no access.

## Consequences

### Verification

| Case | Behavior | Test location |
|---|---|---|
| The wire tries to set a principal (top-level args, a payload sibling, the envelope, inside the request body) | The first two fail argument or payload validation; the rest are dropped or treated as business data; `invocation.peer` remains the admitted Peer | Gateway host spec |
| Every call path names its Peer | `InvokeRemoteRequest.peer`, the `wireStream.open` peer, `fetch(request, peer)`, and the `bridge` peer are required; the Gateway has no fallback; the `/api` route passes `admission.peer` | typecheck, Connection host spec |
| Browser connections and `createPeer()` | `browserPeer` has the owner principal; each `createPeer()` returns an independent Peer released with the Context that read Connection; exact routes answer 403 to non-owners | Connection host spec |
| Disposed Peers | Later unary, stream, and `$events` dispatches fail with `gateway/peer-disposed`, also when the wire payload is malformed; its streams end; a running unary call completes; other Peers are unaffected | Gateway host spec |
| Check order | The owner calls any method normally without reading a policy; a method no role lists refuses non-owners with `remote-access/denied` (`no-allow`); the access check precedes lookups, so a refused call activates no Session | Gateway host spec |
| Policy registration | One policy per non-owner principal kind, and a second registration throws; once the disposer withdraws it, that kind is refused with `no-allow`; it is withdrawn with its fiber | remote-access host spec |
| Decisions | Every resource needs a matching binding (AND); a role without the action, an unequal resource, or a refusing condition does not allow; the refusal reason follows condition > `explain` > `no-allow`; `explain` never changes the decision; conditions receive args for calls but not for snapshots and list filtering; a throwing `bindings()`, condition, or `explain()` refuses with `policy-failed`, each policy is logged once between `invalidate()` calls, and on the event path the owner stream and the shared event source continue; `remoteAccess/follow` is allowed for every principal | remote-access host spec, Gateway host spec |
| Resource resolution | A default field (top-level or first object argument) yields its resource; a lookup parameter that declares that kind as its `resource` yields its wire identity; a Context method gets its Session resource from the Agent Context identity in args without activating the Agent, and may declare other resources through `resources`; a `resources` reader overrides its kind, an array yields several resources, and `undefined` none; with nothing the call is `[global]`; a throw, an empty array, or a value that is not a non-empty string (including a Context identity) is invalid, refused by the Gateway with `resource-invalid` without asking `decide()`; a Context that declares no `resource` resolves by the ordinary rules; resources and `args` read the validated arguments, so an undeclared nested field changes no resource and no condition sees it, and a JSON argument failing validation returns `gateway/input-invalid` before the access check | Gateway host spec (gateway-access) |
| Resource registry | `typert.resources` registers one default field per kind, rejects a second registration and `global`, and withdraws the registration with its fiber; a configured lookup resolver keeps the provider's `resource`; a Host Context adapter keeps its `resource` | typert-registry spec |
| Forwarded events | A non-owner `$events` stream receives an event, whole, only when `event:<name>` is granted on its resources; an event that declares no resources is decided on `global`; an event whose reader returns `undefined` does not reach non-owners, and `decide()` is not asked; the owner receives all | Gateway host spec (gateway-access) |
| First snapshot | `snapshotFor()` returns the owner baseline or the principal's grants; remote-access injects the owner baseline into every rendered index; the Client starts from the injected baseline and rejects a malformed one | remote-access host and client specs |
| Type inference | The parameter types of `resources` readers are inferred from the method; lookup positions have wire types; a missing property, more parameters than the method has, and a `global` key fail compilation; a binding whose resource kind differs from its role's fails compilation | typert-protocol spec, remote-access spec (type tests) |
| List filtering | `session/list`, `session/search`, `session/control`, and `workspace/follow` return non-owners only items for which `allows()` is true; `workspace/follow` sends a `replace` increment when a delivered Workspace loses visibility, and the Workspace reappears once access returns; owner results are unchanged | session-controller / workspace-controller host spec |
| Access snapshots | The allowed set in a snapshot equals the Host decision for the same principal, action, and resource without arguments; it contains endpoint actions only; a resource with no allowed action gets no grant, and one whose allowed set becomes empty is removed; `invalidate()` and policy registration or removal push increments; a wait that a change ends leaves no abort listener behind; unloading the service ends every open snapshot stream; the owner receives only `{ owner: true }` | remote-access host spec |
| Access hooks | `source()`, `useRemoteAccess`, `useAccess`, `useSessionAccess`, and `useWorkspaceAccess` follow the snapshot; `useAccess` on a Session resource reads that Session's answer; the owner answers true; a non-owner without a snapshot or after its snapshot stream fails answers false; hooks issue no requests | remote-access client spec, ui-session / ui-workspace client spec |
| Two-argument keyed hooks | A string second argument reads the `(key, member)` source; existing call forms are unchanged | ui-renderer client spec |
| A non-owner dispatches `session/prompt` | The recorded user message's `source.principal` equals that principal, and a cold restore reads the same value | session-controller host spec |
| An in-process non-owner invocation of subagent `prompt` | The child Session's recorded user message has `source.principal` equal to that principal | subagent host spec |
| Owner messages | The source is byte-identical to the source before this change; existing keyless recorded-session snapshots are unchanged | `pnpm run test:snapshot` needs no re-recording |
| Persistence record | `verify-persistence-changes` passes | doc-sync |

The SDK projections are unaffected: the TypeScript SDK server builds its own `{ kind: 'user' }` messages ([`sdk/server/src/server.ts`](../../../../packages/sdk/server/src/server.ts)) outside the Gateway and does not project the source; the Python SDK does not read the user source.

### Costs and limits

- The change spans protocol, Connection, Gateway, two domain controllers, subagent, a new package, and the frontend, with breaking API renames; it necessarily conflicts with pr-5945 in Connection and the Gateway, handled by the migration list.
- The Gateway depends on `remoteAccess`: a custom composition that mounts the Gateway without remote-access leaves the Gateway waiting.
- Session logs store viewer identities and travel with exported or shared Sessions, so no principal kind may carry a credential.
- Every browser connection shares one Peer, so disposal cannot distinguish tabs until multiple browser Peers exist.
- The default field convention reads by field name: a method that gains a same-named field touches that resource, which review must watch; precise recognition is future work.
- A method that resolves only some resources lets a principal exceed its grant: unresolved resources go unchecked, and the method author ensures `resources` is complete.
- Role actions are strings and are not checked against loaded endpoints: a misspelled or renamed action never matches and shows up as a refusal.
- `api-session/added` carries the whole `SessionSummary`, so a non-owner allowed to receive it also learns the Session's `parentSessionId`.
- A granted Session's cwd and tool paths already contain the owner's absolute paths, so the Gateway does not hide `home` from non-owner `$events` streams separately.
- `workspace/follow` notices a Workspace whose visibility a policy revoked only at that Workspace's next change or the next order change, and then sends the non-owner a `replace` increment; an access change alone sends no frame.

### Migration list for pr-5945

| File | Migration |
|---|---|
| `packages/client/connection/src/peer.ts` | Replaces `operator-peer.ts`; construct `OperatorPeer` as `new Peer(owner, { principal })` |
| `packages/client/connection/src/rpc-host.ts` | `this.operator` becomes `browserPeer` with principal `{ kind: 'owner' }` |
| `packages/client/connection/src/rpc.ts` | `HostConnectionHandle` merges `admitConnection` with `browserPeer` / `createPeer` |
| `packages/api/gateway/src/index.ts` | Replace `peer ?? this.operatorPeer()` where `$events` opens with an explicit Peer; reuse `gateway/peer-disposed` |
| The operator-connect Note, upgrade guide, and subsystem changes | Rewrite operator terms as Peer / `browserPeer`; an API connection's Peer has principal `{ kind: 'owner' }` |
