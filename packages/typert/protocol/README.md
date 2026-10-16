---
description: "The shared Typert Remote protocol: decorators, wire descriptors, codecs, and provider contracts used by business packages, generated artifacts, the Host Gateway, and the Client API."
kind: "package-library"
---

# @deepseek-ai/dsh-typert-protocol

English | [中文](README.zh.md)

## Summary

With `dsh-typert-protocol`, business packages can expose Host methods to Remote clients: mark a method with `@Remote` (or `@RemoteScope` for scoped receivers), bind the service to a wire namespace, and associate Host objects and scoped Contexts with wire identities through the merge-extensible protocol maps. Generated artifacts, the Host Gateway, and the Client API consume the same invocation descriptors, codecs, and provider contracts. Invocation-owned values transfer cleanup to Gateway without adding a reference count. The package registers no Cordis service and runs no TypeScript analysis.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

This package is for business-package and assembly maintainers who expose Host capabilities to Remote clients. It is a declarations library: mark methods, bind services, and let the generated pipeline and the Gateway do the rest.

### Exposing a Host method

A business package marks a public instance method with `@Remote` (or `@RemoteScope(key)` when the receiver comes from a scoped Context), and the owning service either extends `TypertRemoteService` or declares a `typertRemote` binding through `bindTypertRemote()`:

```text
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export class GoalService extends TypertRemoteService {
  @Remote
  async create(agentId: string, objective: string): Promise<GoalResult> {
    ...
  }
}
```

Generation turns the method into a wire endpoint under the service's namespace; Clients call it as a typed method through `ctx.remote` (see the [API Gateway reference](../../../docs/api-gateway.md)). A method opts into cooperative cancellation by declaring `signal: AbortSignal` as its final parameter — the signal is injected, never a JSON parameter or lookup field.

A unary method can return `Uint8Array` directly or within nested objects, arrays, tuples, optional fields, unions, and recursive types. Generation supplies optional result codec `encode()` and `decode()` functions: encoding visits only subtrees whose types can contain bytes, while decoding validates reconstructed values; Client declarations use `Uint8Array<ArrayBuffer>` at every byte position while retaining other field types. Pure JSON results pass through without Host byte detection or Client parsing. Parameters, events, and stream items remain JSON-only; runtime object cycles are unsupported.

A stream method (`@Remote({ mode: 'stream' })`) returns `Iterable`, `AsyncIterable`, or `RemoteStream<Out, In>`. `In` declares the items the Client may send back on the same logical stream; the method reads them through `this.ctx.invocation.uplink<In>()`, and the descriptor carries their codec. `RemoteInvocation` also names the receiving `service`, the calling `peer` (the `PeerScope` its carrier names), and the carrier `signal`; `ctx.invocation` is `undefined` on a Context no Remote call derived: the first `bindTypertRemote()` binding in a tree, which every `TypertRemoteService` constructor makes, registers that accessor on the root. Cordis's cross-copy `Context.is()` recognizes a source Context passed to a built Service, so mixed source/built compositions retain this accessor and invocation-local principals. A generated Client stream method returns `RemoteStreamHandle<Out, In>`: the handle with `send`, `end`, and `dispose` beside the downlink iteration. Uplink items are validated one by one at the Host because they arrive from the browser; downlink items are values the Host method produced and pass through.

`@Remote` options contain only `name`, `mode`, and the `resources` readers described below; input policy belongs to the consumer, not a method annotation. `method.input(options?: TypertRemoteInputOptions)` returns a cached `TypertRemoteValue<Input>`, with `strict?: boolean` as its only option. `method.input()` and `{ strict: false }` retain ordinary Remote handling: declared objects accept and strip unknown fields. `{ strict: true }` rejects undeclared fields recursively, while explicit JSON values and dictionary keys stay open and dictionary values retain their declared validation. Both named-argument envelopes reject extra arguments. Select one view (`const input = method.input({ strict: true })`) for matching `input.create().parse(raw)` and `input.jsonSchema`; this does not change Host dispatch. The [generator](<../generator/README.md#ordinary-remote-metadata>) owns publication and the paired codecs.

Ordinary `./remote` artifacts export `TYPERT_REMOTE` as a `TypertRemoteInfo`, extending the mountable `TypertRemoteContribution`. Its typed `methods[endpoint]` entries are the same direct descriptor objects found in `descriptors`, with derived `input(options?)` and `invoke(remote, input, signal?)`. Parameter documentation lives in `parameters[].description`; `result` is the single result codec, parser, and optional projection. Unary descriptors omit `mode`; streams use `'stream'`. Context-only receivers remain in `descriptors` and scoped declarations, not `methods`.

`createTypertRemoteInfo(spec, z)` from the published pure `@deepseek-ai/dsh-typert-protocol/remote-info` entry returns a class instance, not a constructor. Construction retains only the static spec and the caller-supplied Zod runtime; the first `descriptors` or `methods` read builds and caches their shared index. Each input-policy view, its parser, and its optional JSON Schema projection are independently lazy and cached; `method.input().create()` requests the ordinary parser. The raw spec requires Zod factories, while consumer-facing `TypertSchema<T>` promises only `parse(value: unknown): T`. JSON Schema comes from generator projections, not runtime `z.toJSONSchema()`. The leaf has no runtime imports; generated artifacts supply Zod. Metadata and schema access never invokes the network; the root also re-exports the factory but imports Cordis.

The invoker takes a caller-owned, mounted, unscoped Client Remote and resolves its namespace method at call time. It preserves the namespace receiver, optional positional holes, and signal, forwarding the same `Promise<RemoteResult<DecodedOutput>>` or complete `RemoteStreamHandle<Output, Uplink>` without an async wrapper. `DecodedOutput` defaults to the authored output; generation supplies `RemoteDecoded<Output>` only for byte-bearing unary methods, avoiding recursive remapping of ordinary JSON results; `result.create().parse()` retains the authored output type and does not normalize shared byte buffers. Documentation and parsing remain available when either input variant or the result lacks JSON Schema support; each variant's `jsonSchemaError` explains its absent projection. Registry readers use `isTypertRemoteMethod(descriptor)` from the same pure entry to narrow a base descriptor to these direct capabilities.

### Identifying the caller and admitting non-owner callers

`PeerScope.principal` is the caller identity that in-process Host code fixes when it creates the Peer; no wire field can set it, and `PeerScope.signal` aborts when the Peer scope ends. `PrincipalMap` is merge-extensible: each driver declares one JSON entry with a unique literal `kind` and no credential, because a principal can be persisted in a Session log; the built-in entry is `owner: { kind: 'owner' }`. A Remote method that records its caller on durable output calls `principalOf(this.ctx.invocation)`, which returns the principal of a non-owner caller and `undefined` for the owner and outside a Remote call, and writes the field only when it is defined.

Every Remote method is under access control: [`dsh-api-remote-access`](../../api/remote-access/README.md) decides whether a non-owner caller may reach it on the resources the call touches. `TypertResourceMap` is merge-extensible beside `TypertLookupMap`: the package that owns an identity type declares its resource kind as `TypertResource<Id>` (`dsh-session` declares `session: TypertResource<SessionId>`, `dsh-workspace` declares `workspace: TypertResource<WorkspaceId>`). A `RemoteAccessResource` is either the built-in identity-less `{ kind: 'global' }` or one declared kind with its identity; resources are independent, so access to `global` implies nothing about any session. At runtime the domain that owns a kind registers its default wire field through `typert.resources.register(kind, { field })`, which rejects `global`; a lookup provider and a Host Context adapter name the kind their wire identity carries through `resource`, so a method with an Agent lookup parameter or an Agent-scoped receiver carries a `session` resource without options. The `resources` option of `@Remote` and `@RemoteScope` maps a kind to a reader that receives the method's wire arguments as its own parameters; their types are inferred from the decorated method, with lookup parameters mapped to their wire types, so `@Remote({ name: 'page', resources: { session: request => request.address.sessionId } })` reads a field the defaults cannot. A call whose readers and defaults name no resource touches `global`; they must name every resource the method accesses, because access control never checks one they omit. A forwarded `emit` entry of `TypertForwardableEventEntry` declares `resources` readers typed by its own event's parameters, and an entry without them touches `global`. Resource resolution belongs to the [API Gateway](../../api/gateway/README.md); decisions and refusal reasons belong to [`dsh-api-remote-access`](../../api/remote-access/README.md).

### Associating Host objects and Contexts with wire identities

Complex Host objects cannot cross the wire directly. A business package declares the association through the merge-extensible `TypertLookupMap` and `TypertContextMap`. A Host Context adapter owns the stable wire declaration and resolves wire identities to live Contexts. A Client Context adapter maps in both directions because scoped calls originate from a Client Context and forwarded Host events resolve their explicit wire identity there. Host composition may override its synchronous or asynchronous resolver. A resolver that refuses on policy grounds throws `RemoteError` with its own code, which reaches the caller unchanged.

Client Context resolution is synchronous. `typertOwnedValue(value, release)` transfers a non-throwing, idempotent cleanup to the invocation owner; Gateway calls it after handler and reply settlement. A borrowed Context requires no cleanup wrapper. The shared `TYPERT_OWNED_VALUE` symbol and `isTypertOwnedValue` recognizer work across independently bundled providers and Gateway; the wrapper itself does not retain a resource.

### Reporting and reading a Remote failure

One class carries every Remote failure: `RemoteError`, holding a stable `<domain>/<reason>` code and the details typed for that code. This package declares the universal carrier codes (`gateway/bad-request`, `gateway/cancelled`, `gateway/internal`) and owns `RemoteErrorDetailsMap`, the merge-extensible table every other package extends beside its own throwing code:

```text
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'goal/not-found': { readonly goalId: string }
  }
}
throw new RemoteError('goal/not-found', `goal "${id}" does not exist`, { goalId: id })
```

An owner throws at the failure point; no package writes an error-class family or an exit-mapping function. A caller discriminates by `code` — never by `instanceof` — and a `code` branch narrows `details` with no cast, because `RemoteFailure` is the code-discriminated union of `RemoteError` instances. Infrastructure that must recognize a failure carried across a module or realm copy of the class calls `remoteErrorOf(value)`, which reads a structural marker instead of the prototype chain.

### Receiving forwarded Host events on the Client

The Host assembly extends `TypertRemoteEventSelection` with the Cordis events it forwards to consumers, which narrows the `ctx.remote.$on` key set. `TypertForwardableEvent` accepts unscoped `void` notifications and scoped async waterfalls whose final `next()` callback returns the event's result type. `TypertClientEventListener` derives the Client listener from that same `Events` member while preserving signals, optional and readonly fields, arrays, callbacks, and result types. `TypertClientRemote` exposes only `$mount()` and `$on()`; event transport remains private to Gateway.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the declarations stay compiler-independent and where each contract is enforced; the programming model is covered in [Use this package](#use-this-package).

### Design concept

The package keeps strict reflection in the compiler: decorator initializers retain minimal markers in a versioned descriptor on the Service prototype. The descriptor uses a stable string property name, so another installed copy of the protocol package can read the same markers. Full parameter, result, lookup, and schema reflection is the Typert build pipeline's job, delivered through `InvocationDescriptor`.

### Remote markers

`@Remote` and `@RemoteScope` schedule an initializer that appends the method name, an optional export name, the invocation mode, and the frozen `resources` readers to the prototype descriptor; `remoteMethods(service)` validates its version and returns a detached declaration-order snapshot that the Gateway's source-mode fallback reads. Markers require public, non-static instance methods with string names, and conflicting markers on one method are rejected.

Readers are validated when the decorator is created and frozen into one record per decorator application; the Gateway reads them from `remoteMethods(service)` by implementation member name, so another installed copy of the protocol package reads the same record.

### Protocol maps and descriptors

The merge-extensible protocol maps keep static associations in the type system, while runtime providers register resolution with `ctx.typert`; the map names and shapes live in [`src/types.ts`](src/types.ts). `InvocationDescriptor` is the shared runtime form consumed by the registry, the Gateway, and the Client Remote, covering direct and Context receivers, JSON and lookup parameters, scope projections, the uplink codec, cancellation, result codecs, and documentation. Generated `TypertRemoteMethod` objects extend this descriptor directly.

`RemoteInvocation.uplinkWindow` optionally describes the carrier's complete-frame inbox capacity and the UTF-8 envelope cost added to compact JSON items. Its absence means the carrier has no encoded-frame inbox limit; consumers still own their local buffering and acknowledgement policy.

### Wire identity grammar

Every namespace, method, lookup, and Context segment must satisfy `isTypertRemoteSegment()`, so generated names cross the shared RPC carrier unchanged. Strict codecs carry generated schema factories; `src-json` codecs identify the weaker source-launch path.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Decorators, Gateway bindings, `remoteMethods`, segment validation |
| [`src/principal.ts`](src/principal.ts) | `principalOf`, the caller principal a Remote-call producer records |
| [`src/remote-access.ts`](src/remote-access.ts) | `RemoteAccessResource`, `RemoteAccessResourceKind`, and `RemoteAccessResourceOf` over `TypertResourceMap` |
| [`src/json-value.ts`](src/json-value.ts) | `isRemoteJsonValue` and `isRemoteUplinkItem`, the lossless JSON checks every carrier shares |
| [`src/remote-error.ts`](src/remote-error.ts) | `RemoteError` and the structural `remoteErrorOf` recognizer |
| [`src/remote-info.ts`](src/remote-info.ts) | Pure lazy info factory and direct-method type guard |
| [`src/types.ts`](src/types.ts) | Protocol maps, `RemoteErrorDetailsMap`, `RemoteResult`, `RemoteStream`, `RemoteStreamHandle`, `PrincipalMap`, `Principal`, `PeerScope`, `RemoteInvocation`, `InvocationDescriptor`, codecs, provider contracts, registry interfaces, `TypertClientRemote` |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the declarations to the runtime and the call path.

- [API Gateway reference](../../../docs/api-gateway.md) — how the declarations become running Host-to-Client calls.
- [Typert subsystem reference](../../../docs/subsystems/typert.md) — the literal public contracts recorded from protocol and Gateway types.
- [Typert registry](../registry/README.md) — where descriptors and providers are stored at runtime.
- [Typert generator](../generator/README.md) — what generates the consumer-side declarations and descriptors.
- [Remote-call Agent Note](../../../.agents/notes/implemented/architecture/2026-08-02-typert-remote-method-calls.md) — the architecture and transport decisions behind Remote calls.

-----

<a id="model-experience"></a>
## Model Experience

None, as compiler-independent Remote protocol declarations register nothing model-facing.

#### KV Cache effect

No direct effect; the declared contracts reach a request only when an assembly places them in one.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the declarations can represent; they are current package constraints, not a task backlog.

- **Decorator markers are minimal** — markers contain the method name, optional export alias, stream mode, resource readers, and direct or Context receiver selection; parameter, result, lookup, schema, and documentation metadata require the Typert build pipeline.
- **Remote signatures are restricted** — decorators accept only public, non-static instance methods with string names, and source-mode execution cannot represent overloaded, destructured, defaulted, or rest-parameter signatures.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
