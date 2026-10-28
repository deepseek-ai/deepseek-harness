---
description: "The runtime Typert registry: stores generated package reflection, lazy Zod schema factories, and Remote invocation descriptors, and resolves them for consumers."
kind: "package-reference"
---

# @deepseek-ai/dsh-typert-registry

English | [中文](README.zh.md)

## Summary

`dsh-typert-registry` makes generated Typert artifacts queryable at runtime: each package's reflection, lazy Zod schema factories, and Remote invocation descriptors live under stable keys. A schema is materialized and cached when a consumer first requests it. Registrations are atomic and fiber-scoped: a contribution lands whole or not at all and is withdrawn automatically when the registering component unloads. The same service hosts the lookup and scoped-Context provider registries that Remote calls resolve through. It performs no TypeScript analysis and generates no schemas; the generator and the loader handle those.

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

Mount the registry in any Host or Client composition that stores or consumes generated Typert artifacts; it provides `ctx.typert`. There is no configuration. Node resolves `/client` to the standalone ESM `lib/client.node.js` bundle for programmatic Cordis composition; browsers use the `lib/client.browser.js` loader factory through the logical `/plugins/.../client.js` URL. Both bundles use the same registry implementation, separate from the Host package root.

### Minimal setup

Load the registry plugin; the Client face is installed the same way by the Client runtime's own metadata, and both faces run the same implementation:

```yaml
- name: '@deepseek-ai/dsh-typert-registry'
```

### Querying schemas and reflection

Consumers read schemas with `get(key)`, `resolve(key)`, or `list(filter?)` and package reflection with `getPackage(name, face?)` or `listPackages(filter?)`. The first schema read materializes one process-realm instance; later reads reuse it. `resolve()` distinguishes a malformed key, an absent package, and a registered package that contributes no schema under that name, each with its own error. `toJSONSchema(key)` projects the materialized Zod schema to JSON Schema without caching the projection.

Invocation information is available through existing `ctx.typert.local.get/list` and `ctx.typert.remotes.get/list` queries. They return the registered descriptor objects, including generated direct methods with `input(options?)`, `result`, and `invoke`; there is no separate metadata store or RPC API. Consumers select `method.input({ strict: true })` for matching strict parsing and JSON Schema without changing registration or Host dispatch. Use `isTypertRemoteMethod(descriptor)` from `@deepseek-ai/dsh-typert-protocol/remote-info` to narrow the base descriptor. This guard exposes inputs as `object` and outputs as `unknown`, not endpoint-dependent generics. The [ordinary generated `TYPERT_REMOTE.methods` index](<../generator/README.md#ordinary-remote-metadata>) supplies precise per-method static types and aliases those same descriptors within its artifact instance.

### Registering a contribution

Generated artifacts register through the [loader](../loader/README.md) in Loader compositions; any other owner calls `ctx.typert.register(contribution)` directly and receives the exact disposer that withdraws it. Duplicate package-face identities, schema keys, invocation ids, or endpoints reject the whole batch before anything is committed.

Harness offline integrations register an ordinary `TYPERT_REMOTE` contribution with `ctx.typert.remotes.register(contribution)` in their profile Context. `$mount(contribution)` already performs that registration, so registering and mounting the same contribution in the same registry duplicates it and fails. Keep offline metadata ownership separate from the live connection-and-mount Context. Independent offline consumers may instead read `TYPERT_REMOTE.methods` without any Registry. Registry state belongs to its Context and process, is not shared across processes, and neither registration nor querying opens a connection.

### Lookup and Context providers

Remote calls resolve Host objects and scoped Contexts through `ctx.typert.lookups` and `ctx.typert.contexts`. `registerHost()` installs the Host wire declaration and its wire-to-Context resolver, while `configureHost()` replaces only that resolver. `registerClient()` installs the bidirectional Client adapter for the same merge-declared kind. Host-to-Client event sources carry their domain identity explicitly instead of projecting it back from a Context.

`ctx.typert.resources` holds the default identity extraction of each resource kind declared in `TypertResourceMap`. The domain that owns a kind registers either `{ field }` or `{ resolve }`, never both, as a Cordis effect of the calling fiber; a second registration of one kind throws, and so does `global`, the built-in identity-less resource kind. A resolver is called once, as a plain function without a receiver, so it reads only its `{ args, parameters }` input; a declaration with neither member throws at registration. `get(kind)` reads one declaration, and `entries()` lists each `kind` with its field or resolver declaration in registration order. A lookup provider and a Host Context adapter may name the resource kind of their wire identity through `resource`, and a configured resolver keeps it. The Gateway reads all three when it resolves the resources of a non-owner call.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the registry stores and owns contributions; the consumer API is covered in [Use this package](#use-this-package).

### Design concept

The registry is built on one principle: a contribution is one atomic, fiber-owned commit. `register()` validates the package-face identity, schemas, and invocation descriptors first, then commits everything under a single Cordis effect whose disposer withdraws exactly that contribution. Duplicate identities fail at the owning operation boundary before any state changes.

### Sub-registries

- `ctx.typert.local` — current-environment invocation definitions, including `hasSeen()` history for source-mode fallback.
- `ctx.typert.remotes` — consumer-selected contributions mounted in the calling fiber.
- `ctx.typert.lookups` — lookup providers plus composition-owned resolver overrides per key.
- `ctx.typert.contexts` — Host Context providers and Client Context binders per scoped key.
- `ctx.typert.resources` — the default field or resolver per resource kind.

Each sub-registry publishes `TypertRegistryChange` events to subscribed listeners; a throwing listener is logged and does not stop later listeners.

### Identity and validation

Keys are stable: `<package>#<face>` for reflection, `<package>#<name>` for schemas, and `<namespace>/<method>` for endpoints. Validation rejects names containing `#`, wire names outside the RPC segment grammar, duplicate keys, and lookup definitions whose wire declaration changes during the registry lifetime; schema entries and strict codecs must carry a factory.

### Source map

| File | Role |
|---|---|
| [`src/service.ts`](src/service.ts) | `TypertRegistry` service, stores, validation, effect wiring |
| [`src/types.ts`](src/types.ts) | Contribution, record, and filter types |
| [`src/client/index.ts`](src/client/index.ts) | Client face installing the same registry |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the registry to what feeds it and what consumes it.

- [Typert loader](../loader/README.md) — automatic registration of generated host artifacts.
- [Typert generator](../generator/README.md) — what produces the contributions the registry stores.
- [Typert protocol](../protocol/README.md) — the descriptors, codecs, and provider contracts the registry serves.
- [Typert subsystem reference](../../../docs/subsystems/typert.md) — the literal `ctx.typert` contract.
- [API Gateway reference](../../../docs/api-gateway.md) — the main consumer of invocation descriptors and providers.

-----

<a id="model-experience"></a>
## Model Experience

None, as this runtime type registry's consumers (cordis_inspect, wire faces, gates) own any model-visible projection of registry contents.

#### KV Cache effect

No direct effect; a consumer that places reflection or schemas in a request owns the resulting prefix change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the registry stores and rejects; they are current package constraints, not a task backlog.

- **No graph merging** — the registry stores generated reflection per face but does not merge host and client graphs or resolve TypeScript references; those are analyzer and emitter concerns.
- **Schema keys omit the face** — host and client run in separate contexts, so registering same-named schemas from both faces into one context is rejected as a duplicate.
- **JSON Schema projection is uncached** — `toJSONSchema()` returns a fresh document per call; consumers that project repeatedly own caching.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
